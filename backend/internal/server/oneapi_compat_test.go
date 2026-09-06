package server

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/DouDOU-start/airgate-core/ent"
	"github.com/DouDOU-start/airgate-core/ent/apikey"
	entmember "github.com/DouDOU-start/airgate-core/ent/member"
	"github.com/DouDOU-start/airgate-core/internal/auth"
)

// 下游按 remaining = hard_limit_usd - total_usage/100 算余额，
// 所以每个用例都断言这条减法的结果等于我方口径的真实可用余额。
func TestOneAPIBillingSubscriptionAndUsageAgreeOnRemaining(t *testing.T) {
	db := openCCCompatTestDB(t)
	ctx := context.Background()

	cases := []struct {
		name          string
		userBalance   float64
		quotaUSD      float64
		usedQuota     float64
		wantHardLimit float64
		wantUsageCent float64
		wantRemaining float64
	}{
		{
			name:          "不限额 Key 用用户余额",
			userBalance:   12.34,
			quotaUSD:      0,
			usedQuota:     4.5,
			wantHardLimit: 16.84,
			wantUsageCent: 450,
			wantRemaining: 12.34,
		},
		{
			name:          "Key 额度更小时以 Key 剩余为准",
			userBalance:   50,
			quotaUSD:      10,
			usedQuota:     3,
			wantHardLimit: 10,
			wantUsageCent: 300,
			wantRemaining: 7,
		},
		{
			// 2026-09-03 起 AvailableBalance 刻意不与主账号余额取 min，
			// 免得把 reseller / 企业主的余额露给下游 Key 持有者。
			name:          "Key 有上限时只报 Key 剩余，不泄露主账号余额",
			userBalance:   5,
			quotaUSD:      100,
			usedQuota:     10,
			wantHardLimit: 100,
			wantUsageCent: 1000,
			wantRemaining: 90,
		},
		{
			name:          "Key 额度已用尽",
			userBalance:   50,
			quotaUSD:      10,
			usedQuota:     10,
			wantHardLimit: 10,
			wantUsageCent: 1000,
			wantRemaining: 0,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			key := createCCCompatTestKey(t, ctx, db, tc.userBalance, tc.quotaUSD, tc.usedQuota)
			requireOneAPIBillingPair(t, db, key, tc.wantHardLimit, tc.wantUsageCent, tc.wantRemaining)
		})
	}
}

// 团队成员 Key 必须再按成员本期额度压一层，否则下游会读到比真实可用更大的额度。
// 口径与 cc_compat.go 的 /v1/usage 一致。
func TestOneAPIBillingHonorsMemberQuota(t *testing.T) {
	db := openCCCompatTestDB(t)
	ctx := context.Background()

	t.Run("成员本期剩余压住 Key 剩余", func(t *testing.T) {
		key := createCCCompatTestKey(t, ctx, db, 100, 10, 3) // Key 剩 7
		attachOneAPITestMember(t, ctx, db, key, func(mc *ent.MemberCreate) {
			mc.SetQuotaUsd(20).SetUsedQuota(16) // 成员剩 4
		})
		requireOneAPIBillingPair(t, db, key, 4+3, 300, 4)
	})

	t.Run("成员停用则额度归零", func(t *testing.T) {
		key := createCCCompatTestKey(t, ctx, db, 100, 0, 8)
		attachOneAPITestMember(t, ctx, db, key, func(mc *ent.MemberCreate) {
			mc.SetStatus(entmember.StatusDisabled)
		})
		// available=0，总额度只剩已用部分，下游算出 0 而不是负数。
		requireOneAPIBillingPair(t, db, key, 8, 800, 0)
	})
}

// Key 过期时回 200 且可用额度归零：下游读到「没额度」而不是「认证失败」，
// 不会把整个渠道判死。
func TestOneAPIBillingExpiredKeyReportsZeroRemaining(t *testing.T) {
	db := openCCCompatTestDB(t)
	ctx := context.Background()
	key := createOneAPIExpiredTestKey(t, ctx, db, 42, 6)

	requireOneAPIBillingPair(t, db, key, 6, 600, 0)
}

func TestOneAPIBillingRejectsBadKey(t *testing.T) {
	db := openCCCompatTestDB(t)

	for _, path := range []string{"/v1/dashboard/billing/subscription", "/v1/dashboard/billing/usage"} {
		t.Run("缺 Key "+path, func(t *testing.T) {
			resp := requestOneAPIBilling(t, db, "", path)
			requireStatus(t, resp, http.StatusUnauthorized)
			body := decodeCCCompatBody(t, resp)
			errObj, ok := body["error"].(map[string]any)
			if !ok {
				t.Fatalf("响应缺少 OpenAI 错误信封: %s", resp.Body.String())
			}
			if errObj["code"] != "invalid_api_key" {
				t.Fatalf("error.code = %v, want invalid_api_key", errObj["code"])
			}
		})
		t.Run("未知 Key "+path, func(t *testing.T) {
			resp := requestOneAPIBilling(t, db, "sk-does-not-exist", path)
			requireStatus(t, resp, http.StatusUnauthorized)
		})
	}
}

// requireOneAPIBillingPair 同时打两个端点，校验字段与下游那条减法。
func requireOneAPIBillingPair(t *testing.T, db *ent.Client, key string, wantHardLimit, wantUsageCent, wantRemaining float64) {
	t.Helper()

	sub := requestOneAPIBilling(t, db, key, "/v1/dashboard/billing/subscription")
	requireStatus(t, sub, http.StatusOK)
	subBody := decodeCCCompatBody(t, sub)
	if subBody["object"] != "billing_subscription" {
		t.Fatalf("object = %v, want billing_subscription", subBody["object"])
	}
	requireFloat(t, subBody["hard_limit_usd"], wantHardLimit)
	requireFloat(t, subBody["soft_limit_usd"], wantHardLimit)
	requireFloat(t, subBody["system_hard_limit_usd"], wantHardLimit)

	usage := requestOneAPIBilling(t, db, key, "/v1/dashboard/billing/usage")
	requireStatus(t, usage, http.StatusOK)
	usageBody := decodeCCCompatBody(t, usage)
	if usageBody["object"] != "list" {
		t.Fatalf("object = %v, want list", usageBody["object"])
	}
	requireFloat(t, usageBody["total_usage"], wantUsageCent)

	hard := subBody["hard_limit_usd"].(float64)
	used := usageBody["total_usage"].(float64) / 100
	requireFloat(t, hard-used, wantRemaining)
}

func requestOneAPIBilling(t *testing.T, db *ent.Client, key, path string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	router := gin.New()
	s := &Server{db: db}
	router.GET("/v1/dashboard/billing/subscription", s.handleOneAPIBillingSubscription)
	router.GET("/v1/dashboard/billing/usage", s.handleOneAPIBillingUsage)

	req := httptest.NewRequest(http.MethodGet, path, nil)
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func attachOneAPITestMember(t *testing.T, ctx context.Context, db *ent.Client, rawKey string, mutate func(*ent.MemberCreate)) {
	t.Helper()
	ak, err := db.APIKey.Query().Where(apikey.KeyHash(auth.HashAPIKey(rawKey))).WithUser().Only(ctx)
	if err != nil {
		t.Fatalf("load key: %v", err)
	}
	mc := db.Member.Create().SetName("成员").SetOwner(ak.Edges.User)
	mutate(mc)
	member, err := mc.Save(ctx)
	if err != nil {
		t.Fatalf("create member: %v", err)
	}
	if err := db.APIKey.UpdateOneID(ak.ID).SetMember(member).Exec(ctx); err != nil {
		t.Fatalf("attach member: %v", err)
	}
}

var oneAPICompatTestUserSeq int64

func createOneAPIExpiredTestKey(t *testing.T, ctx context.Context, db *ent.Client, userBalance, usedQuota float64) string {
	t.Helper()
	seq := atomic.AddInt64(&oneAPICompatTestUserSeq, 1)
	user, err := db.User.Create().
		SetEmail(fmt.Sprintf("oneapi-compat-%d@example.com", seq)).
		SetPasswordHash("hash").
		SetBalance(userBalance).
		Save(ctx)
	if err != nil {
		t.Fatalf("create user: %v", err)
	}
	key, hash, err := auth.GenerateAPIKey()
	if err != nil {
		t.Fatalf("GenerateAPIKey: %v", err)
	}
	if _, err := db.APIKey.Create().
		SetName("oneapi-expired").
		SetKeyHash(hash).
		SetUsedQuota(usedQuota).
		SetExpiresAt(time.Now().Add(-time.Hour)).
		SetUser(user).
		Save(ctx); err != nil {
		t.Fatalf("create api key: %v", err)
	}
	return key
}
