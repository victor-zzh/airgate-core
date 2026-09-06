package server

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/DouDOU-start/airgate-core/ent"
	"github.com/DouDOU-start/airgate-core/ent/apikey"
	entmember "github.com/DouDOU-start/airgate-core/ent/member"
	"github.com/DouDOU-start/airgate-core/internal/auth"
	"github.com/DouDOU-start/airgate-core/internal/billing"
)

// OneAPI / NewAPI 余额查询兼容端点
//
// 背景：下游中转与路由器（OneAPI、NewAPI 及其衍生实现）沿用 OpenAI 早期的
// billing 端点探测额度，且必须成对读取：
//
//	GET {baseUrl}/v1/dashboard/billing/subscription   -> 总额度
//	GET {baseUrl}/v1/dashboard/billing/usage          -> 已用额度（单位：美分）
//	remaining = subscription.hard_limit_usd - usage.total_usage / 100
//
// 我方原有的 GET /v1/usage（见 cc_compat.go）是 cc-switch 口径、字段名不同，
// 下游认不出来，于是持续打这两个路径吃 404——2026-09-07 排查用户 81 时，
// 单日 589 笔 404 全部来自 /v1/dashboard/billing/subscription。
//
// 口径与 OneAPI 一致（controller/billing.go）：soft / hard / system_hard 三个
// 上限同值，都是「可用 + 本 Key 已用」；已用取本 Key 的 used_quota，与
// /v1/usage 的 quota.used 同源，这样上面那条减法正好还原真实可用余额。
//
// 余额判定刻意与 cc_compat.go 保持同一套口径（API Key 额度 → 用户余额 →
// 团队成员本期额度三层取小），改动其中一处时另一处要跟着走。同样不复用
// middleware.APIKeyAuth：额度耗尽时它返回 402，而额度耗尽恰恰是下游最需要
// 读到的状态；它还要求 Key 绑定分组，而查余额不必走计费链路。

// oneAPIKeyState 说明兼容端点解析 API Key 的结果。
type oneAPIKeyState int

const (
	oneAPIKeyOK             oneAPIKeyState = iota
	oneAPIKeyMissing                       // 缺 Authorization 头，或不是 sk- 前缀
	oneAPIKeyInvalid                       // 查不到该 Key，或 Key 非 active
	oneAPIKeyNoOwner                       // Key 存在但取不到所属用户
	oneAPIKeyExpired                       // Key 已过期
	oneAPIKeyMemberDisabled                // 团队成员已停用
)

// oneAPISubscriptionResponse 对齐 OpenAI 早期 billing_subscription 结构。
// 只保留下游实际读取的字段，不伪造 plan / payment 等我方无对应概念的信息。
type oneAPISubscriptionResponse struct {
	Object             string  `json:"object"`
	HasPaymentMethod   bool    `json:"has_payment_method"`
	SoftLimitUSD       float64 `json:"soft_limit_usd"`
	HardLimitUSD       float64 `json:"hard_limit_usd"`
	SystemHardLimitUSD float64 `json:"system_hard_limit_usd"`
	AccessUntil        int64   `json:"access_until"`
}

// oneAPIUsageResponse 对齐 OpenAI 早期 billing usage 结构。
// TotalUsage 单位是美分，这是该端点的历史口径，不是笔误。
type oneAPIUsageResponse struct {
	Object     string  `json:"object"`
	TotalUsage float64 `json:"total_usage"`
}

// handleOneAPIBillingSubscription 响应 GET /v1/dashboard/billing/subscription。
func (s *Server) handleOneAPIBillingSubscription(c *gin.Context) {
	ak, available, state := s.resolveOneAPIBillingKey(c)
	if !oneAPIKeyReportable(state) {
		writeOneAPIAuthError(c, state)
		return
	}

	// 总额度 = 可用 + 本 Key 已用，保证下游那条减法还原出 available。
	// 过期 / 成员停用时 available 为 0，下游算出 0 余额而不是认证失败，
	// 不会把整个渠道判死。
	total := available + ak.UsedQuota
	c.JSON(http.StatusOK, oneAPISubscriptionResponse{
		Object:             "billing_subscription",
		HasPaymentMethod:   true,
		SoftLimitUSD:       total,
		HardLimitUSD:       total,
		SystemHardLimitUSD: total,
	})
}

// handleOneAPIBillingUsage 响应 GET /v1/dashboard/billing/usage。
// 忽略 start_date / end_date：我方按 Key 累计已用额度记账，没有等价的按日切片
// 口径，回累计值比回一个区间内不完整的数字更不容易误导下游。
func (s *Server) handleOneAPIBillingUsage(c *gin.Context) {
	ak, _, state := s.resolveOneAPIBillingKey(c)
	if !oneAPIKeyReportable(state) {
		writeOneAPIAuthError(c, state)
		return
	}

	c.JSON(http.StatusOK, oneAPIUsageResponse{
		Object:     "list",
		TotalUsage: ak.UsedQuota * 100,
	})
}

// oneAPIKeyReportable 说明该状态下 ak 可用且应当如实回报额度，
// 而不是回鉴权失败。
func oneAPIKeyReportable(state oneAPIKeyState) bool {
	switch state {
	case oneAPIKeyOK, oneAPIKeyExpired, oneAPIKeyMemberDisabled:
		return true
	default:
		return false
	}
}

// resolveOneAPIBillingKey 解析 Authorization: Bearer sk-xxx，返回 API Key 与
// 其真实可用余额。available 在 Key 过期或成员停用时为 0；ak 在 missing /
// invalid 两种状态下为 nil。
func (s *Server) resolveOneAPIBillingKey(c *gin.Context) (ak *ent.APIKey, available float64, state oneAPIKeyState) {
	key := extractCCBearerKey(c)
	if key == "" || !strings.HasPrefix(key, "sk-") {
		return nil, 0, oneAPIKeyMissing
	}

	ak, err := s.db.APIKey.Query().
		Where(
			apikey.KeyHash(auth.HashAPIKey(key)),
			apikey.StatusEQ(apikey.StatusActive),
		).
		WithUser().
		WithMember().
		Only(c.Request.Context())
	if err != nil {
		return nil, 0, oneAPIKeyInvalid
	}

	if ak.ExpiresAt != nil && ak.ExpiresAt.Before(time.Now()) {
		return ak, 0, oneAPIKeyExpired
	}

	u, err := ak.Edges.UserOrErr()
	if err != nil {
		return ak, 0, oneAPIKeyNoOwner
	}

	available, _ = ccCompatAvailableBalance(u.Balance, ak.QuotaUsd, ak.UsedQuota)
	if m := ak.Edges.Member; m != nil {
		if m.Status != entmember.StatusActive {
			return ak, 0, oneAPIKeyMemberDisabled
		}
		used, _ := memberPeriodUsed(m, time.Now())
		available = billing.CapByMemberQuota(available, m.QuotaUsd, used)
	}
	return ak, available, oneAPIKeyOK
}

// writeOneAPIAuthError 按 OpenAI 错误信封回鉴权失败，下游路由器按此解析。
func writeOneAPIAuthError(c *gin.Context, state oneAPIKeyState) {
	message := "invalid api key"
	if state == oneAPIKeyMissing {
		message = "missing or invalid api key"
	}
	c.JSON(http.StatusUnauthorized, gin.H{
		"error": gin.H{
			"message": message,
			"type":    "invalid_request_error",
			"code":    "invalid_api_key",
		},
	})
}
