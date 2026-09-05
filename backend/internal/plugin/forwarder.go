package plugin

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/DouDOU-start/airgate-core/ent"
	appusage "github.com/DouDOU-start/airgate-core/internal/app/usage"
	"github.com/DouDOU-start/airgate-core/internal/auth"
	"github.com/DouDOU-start/airgate-core/internal/billing"
	"github.com/DouDOU-start/airgate-core/internal/routing"
	"github.com/DouDOU-start/airgate-core/internal/scheduler"
	"github.com/DouDOU-start/airgate-core/internal/server/middleware"
	sdk "github.com/DouDOU-start/airgate-sdk/sdkgo"
)

// 访问日志富化键的本地别名，避免在大量 c.Set 处重复写出包名。
const (
	ginCtxKeyModel     = middleware.CtxKeyAccessModel
	ginCtxKeyPlatform  = middleware.CtxKeyAccessPlatform
	ginCtxKeyAccountID = middleware.CtxKeyAccessAccountID
	ginCtxKeyAttempts  = middleware.CtxKeyAccessAttempts
	ginCtxKeyStatus    = middleware.CtxKeyAccessStatusOverride
)

// Forwarder 请求转发器：认证 → 余额预检 → 调度 → 并发闸门 → 转发 → 判决 → 计费 → 记录。
type Forwarder struct {
	db          *ent.Client
	manager     *Manager
	scheduler   *scheduler.Scheduler
	concurrency *scheduler.ConcurrencyManager
	calculator  *billing.Calculator
	recorder    *billing.Recorder
}

// NewForwarder 创建转发器。
func NewForwarder(
	db *ent.Client,
	manager *Manager,
	sched *scheduler.Scheduler,
	concurrency *scheduler.ConcurrencyManager,
	calculator *billing.Calculator,
	recorder *billing.Recorder,
) *Forwarder {
	return &Forwarder{
		db:          db,
		manager:     manager,
		scheduler:   sched,
		concurrency: concurrency,
		calculator:  calculator,
		recorder:    recorder,
	}
}

// resolveModelFamily 从插件目录优先获取家族键，未命中时回退到硬编码规则。
func (f *Forwarder) resolveModelFamily(platform, model string) string {
	if f.manager != nil {
		if family := f.manager.ModelFamily(model); family != "" {
			return family
		}
	}
	return scheduler.ModelFamily(platform, model)
}

// maxFailoverAttempts 最大 failover 次数（账号级失败后切换新账号上游调用的上限）。
const maxFailoverAttempts = 3

// 同账号重试：分组里已没有其它候选（单供给，或备用也都被排除）时，若上一次失败是
// 网络抖动类瞬时故障（连接被重置 / EOF / 秒回 5xx），原地在同一账号再试一次，
// 而不是把错误吐给客户端。延迟给上游一个极短的恢复窗口；上游给了 Retry-After 则照用但封顶。
const (
	sameAccountRetryDelay    = 800 * time.Millisecond
	sameAccountRetryMaxDelay = 3 * time.Second
)

// queueWaitTimeout 所有账号 slot 都被占满时，请求最多排队等多久再放弃。
// 1 分钟对号池小 / 并发高的场景能把毛刺吸收掉；超过这个时长意味着号池真的不够用。
const queueWaitTimeout = 60 * time.Second

// queuePollInterval slot 未释放时的初始轮询间隔；连续排队会指数退避到上限。
const queuePollInterval = 200 * time.Millisecond

const queueMaxPollInterval = 2 * time.Second

// 499 是 nginx 风格的 Client Closed Request，仅用于本地日志和状态归类。
const statusClientClosedRequest = 499

// allRoutesFailedDefaultRetryAfter 客户端最终因真实上游限流被拒时，若没有任何上游 RetryAfter 可参考，
// 与 scheduler 首次无提示限流的默认冷却保持一致，避免客户端在账号仍冷却时过早重试。
const allRoutesFailedDefaultRetryAfter = 60 * time.Second

// Forward 入口。失败时自动 failover 到其它账号，最多 maxFailoverAttempts 次。
//
// Middleware：OnForwardBegin 只在首次 attempt 调用（避免 failover 污染审计计数），
// OnForwardEnd 在最终一次 attempt（成功或放弃）触发，LIFO 降序。Begin DENY 会拒绝请求。
func (f *Forwarder) Forward(c *gin.Context) {
	state, ok := f.parseRequest(c)
	if !ok {
		return
	}
	// 出网闸门：响应头按白名单裁剪、我方头恒为准。必须装在 ttftWriter 之前——
	// ttftWriter 要留在最外层，streamHeartbeatOnlyWritten 等处对 c.Writer 做类型断言。
	installEgressWriter(c, f.manager.ResponseHeadersAllow(state.plugin.Name))
	// TTFT 埋点：包装 writer 记录首字节写出客户端的时刻（recordUsage 汇总 ttft_breakdown）
	installTTFTWriter(c)
	// 对外错误格式跟随目标插件/路由声明（Metadata["error_format"]），
	// 此后本请求所有 protocolError 按该格式写出；未声明回退 OpenAI 兼容格式
	setRequestErrorFormat(c, f.manager.ErrorFormat(state.plugin.Name, state.requestPath))
	if !f.checkBalance(c, state) {
		return
	}

	// 请求级 logger：继承 middleware 注入的 request_id / user_id / group_id 等字段，
	// 再叠加 model / platform 让所有 forward 阶段日志自带上下文。
	logger := sdk.LoggerFromContext(c.Request.Context()).With(
		sdk.LogFieldModel, state.model,
		sdk.LogFieldPlatform, state.plugin.Name,
	)
	// http_request 中间件最终会输出一行总览，model/platform 写回 gin ctx 让那一行带上。
	c.Set(ginCtxKeyModel, state.model)
	c.Set(ginCtxKeyPlatform, state.plugin.Name)

	logger.Debug("forward_request_start",
		"stream", state.stream,
		"input_tokens_est", len(state.body),
		"scheduling_models", state.schedulingModelCandidates(),
	)

	// 只读元信息快车道：插件本地合成响应，跳过整条账号 / 闸门 / failover 链路。
	if f.isMetadataOnlyPath(state.requestPath) {
		f.forwardMetadataOnly(c, state)
		return
	}

	// 模型-分组预校验：请求模型明确不在该分组可服务范围时快速返回清晰 404，
	// 不打上游、不占并发闸门（fail-open 边界见 precheckModelServed）。
	if reason, ok := f.precheckModelServed(state); !ok {
		logger.Warn("forward_model_not_served_by_group",
			sdk.LogFieldUserID, state.keyInfo.UserID,
			sdk.LogFieldGroupID, state.keyInfo.GroupID,
			"scheduling_models", state.schedulingModelCandidates(),
		)
		protocolError(c, http.StatusNotFound, "invalid_request_error", "model_not_found", reason)
		f.recordFailureUsage(c, state, usageFailure{
			code:    appusage.ErrorCodeModelNotFound,
			status:  http.StatusNotFound,
			message: reason,
		})
		return
	}

	releaseClientQuota := f.acquireClientQuota(c, state)
	if releaseClientQuota == nil {
		return // 429 已写
	}
	defer releaseClientQuota()

	requirements := routing.Requirements{
		NeedsImage: requestNeedsImageCached(f.manager, state),
	}
	routes := routesForAPIKey(state, requirements)
	if len(routes) == 0 {
		logger.Warn("forward_no_eligible_route",
			sdk.LogFieldUserID, state.keyInfo.UserID,
		)
		if errResp, ok := apiKeyGroupRequirementError(state.keyInfo, requirements); ok {
			protocolError(c, errResp.status, errResp.errType, errResp.code, errResp.message)
			f.recordFailureUsage(c, state, usageFailure{
				code:    appusage.ErrorCodeCapabilityDenied,
				status:  errResp.status,
				message: errResp.message,
			})
			return
		}
		protocolError(c, http.StatusServiceUnavailable, "server_error", "no_available_route", "请求暂时无法完成，请稍后重试")
		f.recordFailureUsage(c, state, usageFailure{
			code:    appusage.ErrorCodeNoAvailableRoute,
			status:  http.StatusServiceUnavailable,
			message: "当前分组没有可用于本次请求的上游账号",
		})
		return
	}

	hardExclude := make([]int, 0, maxFailoverAttempts*len(routes))
	var mwBag map[string]string
	beginCalled := false
	ctx := c.Request.Context()
	startedAt := state.startedAt
	totalAttempts := 0

	failureSummary := allRoutesFailureSummary{}
	// 4xx 判决也参与 failover：记住最后一次可透传的 ClientError 尝试，
	// 所有账号穷尽后按原样回放给客户端，而不是脱敏的「全部上游失败」——
	// 真实的客户端错误信息（参数非法、context 超长等）必须完整到达客户端。
	var lastClientError *clientErrorReplay

	for _, route := range routes {
		state.selectedRoute = route
		state.keyInfo = keyInfoForRoute(state.keyInfo, route)

		softExclude := make([]int, 0, maxFailoverAttempts)
		attempt := 0
		queueDeadline := time.Now().Add(queueWaitTimeout)
		queuePollDelay := queuePollInterval
		waitingForLocalCapacity := false
		// 同账号重试每条路由只给一次；lastSoftFailure 记住最近一次"账号无辜"的失败，
		// 供穷尽后判断值不值得原地再试。
		sameAccountRetried := false
		var lastSoftFailure *forwardExecution
		lastSoftFailureAccount := 0

		for attempt < maxFailoverAttempts {
			if status := canceledRequestStatus(ctx.Err()); status != 0 {
				f.recordCanceledRequest(c, state, status, false)
				logger.Debug("forward_request_canceled",
					"status_code", status,
					"attempts", totalAttempts,
				)
				return
			}

			exclude := make([]int, 0, len(hardExclude)+len(softExclude))
			exclude = append(exclude, hardExclude...)
			exclude = append(exclude, softExclude...)

			if err := f.pickAccount(c, state, exclude...); err != nil {
				if status := canceledRequestStatus(ctx.Err()); status != 0 {
					f.recordCanceledRequest(c, state, status, false)
					logger.Debug("forward_request_canceled",
						"status_code", status,
						"attempts", totalAttempts,
					)
					return
				}
				failureSummary.recordPickAccountErrorAfterExclusions(err, len(exclude) > 0)
				localSoftExcluded := waitingForLocalCapacity && len(softExclude) > 0
				if shouldWaitForLocalCapacity(err, localSoftExcluded) && time.Now().Before(queueDeadline) {
					softExclude = softExclude[:0]
					wait := queuePollDelay
					if remaining := time.Until(queueDeadline); remaining < wait {
						wait = remaining
					}
					if wait > 0 {
						timer := time.NewTimer(wait)
						select {
						case <-ctx.Done():
							if !timer.Stop() {
								select {
								case <-timer.C:
								default:
								}
							}
							if status := canceledRequestStatus(ctx.Err()); status != 0 {
								f.recordCanceledRequest(c, state, status, false)
								logger.Debug("forward_request_canceled",
									"status_code", status,
									"attempts", totalAttempts,
								)
								return
							}
							return
						case <-timer.C:
						}
					}
					if queuePollDelay < queueMaxPollInterval {
						queuePollDelay *= 2
						if queuePollDelay > queueMaxPollInterval {
							queuePollDelay = queueMaxPollInterval
						}
					}
					continue
				}
				if !sameAccountRetried && lastSoftFailure != nil && isUnclassifiedSelectionExhaustion(err) && sameAccountRetryable(*lastSoftFailure) {
					sameAccountRetried = true
					softExclude = removeAccountID(softExclude, lastSoftFailureAccount)
					delay := sameAccountRetryDelayFor(lastSoftFailure.outcome.RetryAfter)
					logger.Warn("forward_same_account_retry",
						sdk.LogFieldAccountID, lastSoftFailureAccount,
						"kind", lastSoftFailure.outcome.Kind,
						sdk.LogFieldReason, judgmentReason(*lastSoftFailure),
						"delay_ms", delay.Milliseconds(),
						"attempt", attempt,
					)
					if !waitBeforeRetry(ctx, delay) {
						if status := canceledRequestStatus(ctx.Err()); status != 0 {
							f.recordCanceledRequest(c, state, status, false)
							logger.Debug("forward_request_canceled",
								"status_code", status,
								"attempts", totalAttempts,
							)
						}
						return
					}
					continue
				}
				attrs := []any{sdk.LogFieldError, err}
				if models := state.schedulingModelCandidates(); len(models) > 0 {
					attrs = append(attrs, "scheduling_models", models)
				}
				if len(hardExclude) > 0 {
					attrs = append(attrs, "hard_excluded", hardExclude)
				}
				if len(softExclude) > 0 {
					attrs = append(attrs, "soft_excluded", softExclude)
				}
				logger.Warn("forward_pick_account_failed", attrs...)
				break
			}
			queuePollDelay = queuePollInterval

			accountID := state.account.ID
			// logger 已经从 auth middleware 继承了 group_id，这里只补 account_id 避免重复字段。
			attemptLogger := logger.With(sdk.LogFieldAccountID, accountID)
			releaseAccountSlot, ok := f.acquireAccountSlot(c, state)
			if !ok {
				failureSummary.recordLocalCapacityFailure()
				waitingForLocalCapacity = true
				softExclude = append(softExclude, accountID)
				continue
			}
			waitingForLocalCapacity = false

			gate, gateErr := f.scheduler.ClaimAccountGate(
				ctx,
				accountID,
				state.account.Platform,
				state.modelForScheduling(),
				state.requestID,
			)
			if gateErr != nil || !gate.Allowed() {
				releaseAccountSlot()
				f.scheduler.DecrementRPM(context.Background(), accountID)
				f.releaseFamilyProbe(state)
				if gateErr != nil {
					failureSummary.recordPickAccountError(gateErr)
				} else {
					failureSummary.recordAccountGateDecision(gate)
				}
				hardExclude = append(hardExclude, accountID)
				attemptLogger.Warn("forward_account_gate_rejected",
					"reason", gate.Reason,
					sdk.LogFieldError, gateErr,
				)
				continue
			}

			if !beginCalled {
				allowed, bag := f.runForwardBeginChain(c, state)
				beginCalled = true
				if !allowed {
					f.scheduler.DecrementRPM(ctx, accountID)
					f.releaseFamilyProbe(state)
					releaseAccountSlot()
					return
				}
				mwBag = bag
			}

			stopProbeLease := func() {}
			if gate.ProbeClaimed {
				stopProbeLease = f.scheduler.MaintainFamilyProbe(
					ctx,
					accountID,
					state.account.Platform,
					state.modelForScheduling(),
					state.requestID,
				)
			}
			state.attemptNo = totalAttempts + 1
			execution := f.callPlugin(c, state)
			stopProbeLease()
			attempt++
			totalAttempts++
			slotReleased := false
			endCalled := false
			releaseSlot := func() {
				if slotReleased {
					return
				}
				slotReleased = true
				releaseAccountSlot()
			}
			finishCanceled := func(status int) {
				if !hasForwardResult(execution) {
					releaseSlot()
					f.scheduler.DecrementRPM(context.Background(), accountID)
					f.releaseFamilyProbe(state)
					c.Set(ginCtxKeyAccountID, accountID)
					c.Set(ginCtxKeyAttempts, totalAttempts)
					f.recordCanceledRequest(c, state, status, true)
				} else {
					if !endCalled {
						endCalled = true
						f.runForwardEndChain(c, state, neutralizeCanceledExecution(execution), mwBag)
					}
					f.writeCanceledResult(c, state, execution, status)
					releaseSlot()
					c.Set(ginCtxKeyAccountID, accountID)
					c.Set(ginCtxKeyAttempts, totalAttempts)
				}
				logger.Debug("forward_request_canceled",
					"status_code", status,
					"attempts", totalAttempts,
				)
			}

			requestCanceled := forwardCancellationStatus(ctx, execution.err)
			if requestCanceled != 0 {
				finishCanceled(requestCanceled)
				return
			}

			if f.canFailover(c, state, execution) {
				failureSummary.recordExecution(execution)
				attrs := []any{
					"attempt", attempt,
					"kind", execution.outcome.Kind,
					sdk.LogFieldDurationMs, execution.duration.Milliseconds(),
					sdk.LogFieldReason, judgmentReason(execution),
				}
				if s := execution.outcome.Upstream.StatusCode; s > 0 {
					attrs = append(attrs, "upstream_status", s)
				}
				if execution.err != nil {
					attrs = append(attrs, sdk.LogFieldError, execution.err)
				}
				attemptLogger.Warn("forward_attempt_failed", attrs...)
				releaseSlot()
				if !f.applyOutcome(ctx, state, execution) {
					finishCanceled(canceledRequestStatus(ctx.Err()))
					return
				}

				if execution.outcome.Kind == sdk.OutcomeClientError {
					lastClientError = &clientErrorReplay{
						execution: execution,
						account:   state.account,
						keyInfo:   state.keyInfo,
						route:     state.selectedRoute,
					}
				}

				if execution.outcome.Kind.IsAccountFault() {
					hardExclude = append(hardExclude, accountID)
				} else {
					softExclude = append(softExclude, accountID)
					failed := execution
					lastSoftFailure = &failed
					lastSoftFailureAccount = accountID
				}
				continue
			}

			if requestCanceled := canceledRequestStatus(ctx.Err()); requestCanceled != 0 {
				finishCanceled(requestCanceled)
				return
			}
			endCalled = true
			f.runForwardEndChain(c, state, execution, mwBag)
			if requestCanceled := canceledRequestStatus(ctx.Err()); requestCanceled != 0 {
				finishCanceled(requestCanceled)
				return
			}
			f.writeResult(c, state, execution)
			releaseSlot()
			// 总览写回 gin ctx，由 http_request 中间件统一输出，避免双行重复。
			c.Set(ginCtxKeyAccountID, accountID)
			c.Set(ginCtxKeyAttempts, totalAttempts)
			// 仅在发生过 failover 时单独打 Info；正常一次成功只留 Debug，避免噪声。
			if totalAttempts > 1 {
				attemptLogger.Info("forward_request_completed_after_retry",
					sdk.LogFieldStatus, execution.outcome.Upstream.StatusCode,
					sdk.LogFieldDurationMs, time.Since(startedAt).Milliseconds(),
					"attempts", totalAttempts,
				)
			} else {
				attemptLogger.Debug("forward_request_completed",
					sdk.LogFieldStatus, execution.outcome.Upstream.StatusCode,
					sdk.LogFieldDurationMs, time.Since(startedAt).Milliseconds(),
				)
			}
			return
		}

		logger.Debug("forward_route_failover_exhausted",
			"attempts", attempt,
			"scheduling_models", state.schedulingModelCandidates(),
		)
	}

	if lastClientError != nil {
		// 所有候选账号都试过、至少一次上游给出了可透传的 4xx：对客户端而言
		// 这是一次客户端错误，回放最后一次原始响应（含 body）。恢复该次尝试
		// 的账号/分组归属，让计费与日志落在真正产生这份响应的链路上。
		state.selectedRoute = lastClientError.route
		state.keyInfo = lastClientError.keyInfo
		state.account = lastClientError.account
		f.runForwardEndChain(c, state, lastClientError.execution, mwBag)
		f.writeClientErrorResult(c, state, lastClientError.execution)
		c.Set(ginCtxKeyAccountID, lastClientError.account.ID)
		c.Set(ginCtxKeyAttempts, totalAttempts)
		logger.Info("forward_client_error_replayed_after_failover",
			"attempts", totalAttempts,
			"upstream_status", lastClientError.execution.outcome.Upstream.StatusCode,
			sdk.LogFieldAccountID, lastClientError.account.ID,
			sdk.LogFieldDurationMs, time.Since(startedAt).Milliseconds(),
		)
		return
	}

	failAttrs := []any{
		sdk.LogFieldDurationMs, time.Since(startedAt).Milliseconds(),
		"attempts", totalAttempts,
		"scheduling_models", state.schedulingModelCandidates(),
	}
	if len(hardExclude) > 0 {
		failAttrs = append(failAttrs, "tried_accounts", hardExclude)
	}
	if failureSummary.rateLimitedSeen {
		failAttrs = append(failAttrs, "rate_limited_retry_after_ms", failureSummary.rateLimitedRetryAfter.Milliseconds())
	}
	logger.Error("forward_request_failed", failAttrs...)

	writeAllRoutesFailed(c, failureSummary)

	// 全部候选账号都失败：这是用户最需要在使用日志里看到的一类失败（上游全挂、
	// 账号欠费被封、全量限流）。落库用与客户端响应一致的 code/status，避免两套口径。
	failResp := selectAllRoutesFailureResponse(failureSummary)
	f.recordFailureUsage(c, state, usageFailure{
		code:    failResp.code,
		status:  failResp.status,
		message: allRoutesFailureLogMessage(failResp.message, totalAttempts),
	})
}

// allRoutesFailureLogMessage 给「全部上游失败」的日志补上尝试次数，便于区分
// 「一次就失败」与「换了 3 个账号仍失败」。
func allRoutesFailureLogMessage(message string, attempts int) string {
	if attempts <= 0 {
		return message + "（未取到可用账号）"
	}
	return message + "（已尝试 " + strconv.Itoa(attempts) + " 次上游调用）"
}

func canceledRequestStatus(err error) int {
	switch {
	case err == nil:
		return 0
	case errors.Is(err, context.Canceled):
		return statusClientClosedRequest
	case errors.Is(err, context.DeadlineExceeded):
		return http.StatusGatewayTimeout
	default:
		return 0
	}
}

// forwardCancellationStatus closes the small race between a gateway returning
// a context error and that cancellation becoming visible through ctx.Err(). A
// wrapped Canceled always identifies a client-side cancellation. DeadlineExceeded
// is only request-owned when the request context is canceled or its own deadline
// has elapsed; an independent upstream timeout must remain eligible for failover.
func forwardCancellationStatus(ctx context.Context, forwardErr error) int {
	if ctx != nil {
		if status := canceledRequestStatus(ctx.Err()); status != 0 {
			return status
		}
	}
	forwardCode := status.Code(forwardErr)
	if errors.Is(forwardErr, context.Canceled) || forwardCode == codes.Canceled {
		return statusClientClosedRequest
	}
	if (!errors.Is(forwardErr, context.DeadlineExceeded) && forwardCode != codes.DeadlineExceeded) || ctx == nil {
		return 0
	}
	if deadline, ok := ctx.Deadline(); ok && !time.Now().Before(deadline) {
		return http.StatusGatewayTimeout
	}
	return 0
}

func markCanceledRequest(c *gin.Context, status int) {
	if c == nil || status == 0 {
		return
	}
	c.Set(ginCtxKeyStatus, status)
	if c.Writer.Written() {
		return
	}
	c.Status(status)
}

func finalizeRequestContext(ctx context.Context) context.Context {
	if canceledRequestStatus(ctx.Err()) != 0 {
		return context.Background()
	}
	return ctx
}

func hasForwardResult(execution forwardExecution) bool {
	if execution.outcome.Kind != sdk.OutcomeUnknown {
		return true
	}
	if execution.outcome.Upstream.StatusCode > 0 || len(execution.outcome.Upstream.Body) > 0 || len(execution.outcome.Upstream.Headers) > 0 {
		return true
	}
	return execution.outcome.Usage != nil || len(execution.outcome.UpdatedCredentials) > 0
}

// neutralizeCanceledExecution prevents a client-side cancellation from changing
// account health when the plugin happens to return a failure at the same time.
// The original execution is retained separately for usage and credential
// persistence. This copy is only sent to middleware, so every canceled attempt
// is represented as account-neutral regardless of a racing upstream result.
func neutralizeCanceledExecution(execution forwardExecution) forwardExecution {
	execution.err = nil
	execution.outcome.Kind = sdk.OutcomeStreamAborted
	if execution.outcome.Reason == "" {
		execution.outcome.Reason = "客户端已取消请求"
	}
	return execution
}

type allRoutesFailureSummary struct {
	rateLimitedSeen       bool
	rateLimitedRetryAfter time.Duration
	// schedulerRateLimitedSeen covers the case where every routed account was
	// already in a family cooldown and no upstream call was made on this request.
	// It must use the same 429 response contract as an upstream 429.
	schedulerRateLimitedSeen    bool
	localCapacitySeen           bool
	accountUnavailable          bool
	accountDeadSeen             bool
	upstreamTimeoutSeen         bool
	upstreamFailureSeen         bool
	unclassifiedPickFailureSeen bool

	// 结构性选号失败：重试不会恢复，最终响应要用 4xx 让客户端立刻停手。
	groupOfflineSeen   bool
	modelNotServedSeen bool
	// transientPickFailureSeen 记录明确的非限流不可用（并发/RPM/window/session/disabled）。
	// 只要出现过一次，就说明还有路线只是暂时不可用，此时不能降级成 4xx。
	transientPickFailureSeen bool
}

func (s *allRoutesFailureSummary) recordExecution(execution forwardExecution) {
	switch execution.outcome.Kind {
	case sdk.OutcomeAccountRateLimited:
		s.rateLimitedSeen = true
		s.recordRetryAfter(execution.outcome.RetryAfter)
	case sdk.OutcomeAccountDead:
		s.accountDeadSeen = true
	case sdk.OutcomeUpstreamTransient:
		if isTimeoutFailure(execution) {
			s.upstreamTimeoutSeen = true
			return
		}
		s.upstreamFailureSeen = true
	case sdk.OutcomeUnknown:
		if execution.err != nil {
			s.upstreamFailureSeen = true
		}
	}
}

func (s *allRoutesFailureSummary) recordRetryAfter(retryAfter time.Duration) {
	if retryAfter <= 0 {
		return
	}
	if s.rateLimitedRetryAfter == 0 || retryAfter < s.rateLimitedRetryAfter {
		s.rateLimitedRetryAfter = retryAfter
	}
}

// recordPickAccountError 按 scheduler 的错误分类归档选号失败。
// 三类互斥：分组已下线 / 分组不供该模型 / 容量型暂时不可用。
func (s *allRoutesFailureSummary) recordPickAccountError(err error) {
	s.accountUnavailable = true
	if retryAt, ok := scheduler.RateLimitedRetryAt(err); ok {
		s.schedulerRateLimitedSeen = true
		if retryAfter := time.Until(retryAt); retryAfter > 0 && (s.rateLimitedRetryAfter <= 0 || retryAfter < s.rateLimitedRetryAfter) {
			s.rateLimitedRetryAfter = retryAfter
		}
		return
	}
	switch {
	case errors.Is(err, scheduler.ErrGroupOffline):
		s.groupOfflineSeen = true
	case errors.Is(err, scheduler.ErrModelNotServed):
		s.modelNotServedSeen = true
	case errors.Is(err, scheduler.ErrLocalCapacityUnavailable):
		s.localCapacitySeen = true
	case errors.Is(err, scheduler.ErrTransientCandidatesUnavailable),
		errors.Is(err, scheduler.ErrNonRateLimitedCandidatesUnavailable):
		s.transientPickFailureSeen = true
	default:
		s.unclassifiedPickFailureSeen = true
	}
}

func (s *allRoutesFailureSummary) recordPickAccountErrorAfterExclusions(err error, hadExclusions bool) {
	if hadExclusions && isUnclassifiedSelectionExhaustion(err) {
		return
	}
	s.recordPickAccountError(err)
}

func isUnclassifiedSelectionExhaustion(err error) bool {
	if !errors.Is(err, scheduler.ErrNoAvailableAccount) {
		return false
	}
	if _, ok := scheduler.RateLimitedRetryAt(err); ok {
		return false
	}
	return !errors.Is(err, scheduler.ErrGroupOffline) &&
		!errors.Is(err, scheduler.ErrModelNotServed) &&
		!errors.Is(err, scheduler.ErrNonRateLimitedCandidatesUnavailable)
}

func shouldWaitForLocalCapacity(err error, localSoftExcluded bool) bool {
	if errors.Is(err, scheduler.ErrLocalCapacityUnavailable) {
		return true
	}
	return localSoftExcluded && isUnclassifiedSelectionExhaustion(err)
}

func (s *allRoutesFailureSummary) recordAccountGateDecision(decision scheduler.AccountGateDecision) {
	if decision.Allowed() {
		return
	}
	s.accountUnavailable = true
	if decision.Reason == scheduler.AccountGateRateLimited {
		s.schedulerRateLimitedSeen = true
		if retryAfter := time.Until(decision.RetryAt); retryAfter > 0 {
			s.recordRetryAfter(retryAfter)
		}
		return
	}
	s.transientPickFailureSeen = true
}

func (s *allRoutesFailureSummary) recordLocalCapacityFailure() {
	s.localCapacitySeen = true
}

type allRoutesFailureResponse struct {
	status     int
	errType    string
	code       string
	message    string
	retryAfter time.Duration
}

func writeAllRoutesFailed(c *gin.Context, summary allRoutesFailureSummary) {
	response := selectAllRoutesFailureResponse(summary)
	if streamHeartbeatOnlyWritten(c) {
		protocolStreamError(c, response.status, response.errType, response.code, response.message)
		return
	}
	if response.status == http.StatusTooManyRequests {
		protocolRateLimitError(c, response.status, response.code, response.message, response.retryAfter)
		return
	}
	protocolError(c, response.status, response.errType, response.code, response.message)
}

func selectAllRoutesFailureResponse(summary allRoutesFailureSummary) allRoutesFailureResponse {
	if summary.allViableRoutesRateLimited() {
		retryAfter := summary.rateLimitedRetryAfter
		if retryAfter <= 0 {
			retryAfter = allRoutesFailedDefaultRetryAfter
		}
		return allRoutesFailureResponse{
			status:     http.StatusTooManyRequests,
			errType:    "rate_limit_error",
			code:       appusage.ErrorCodeAllRoutesRateLimited,
			message:    "上游账号当前被限流，请稍后重试",
			retryAfter: retryAfter,
		}
	}
	if summary.localCapacitySeen {
		return allRoutesFailureResponse{
			status:  http.StatusServiceUnavailable,
			errType: "server_error",
			code:    appusage.ErrorCodeAllRoutesFailed,
			message: "请求暂时无法完成，请稍后重试",
		}
	}
	if summary.upstreamTimeoutSeen {
		return allRoutesFailureResponse{
			status:  http.StatusGatewayTimeout,
			errType: "server_error",
			code:    appusage.ErrorCodeUpstreamTimeout,
			message: "上游请求超时，请稍后重试",
		}
	}
	if summary.upstreamFailureSeen {
		return allRoutesFailureResponse{
			status:  http.StatusBadGateway,
			errType: "server_error",
			code:    appusage.ErrorCodeUpstreamError,
			message: "上游服务暂不可用，请稍后重试",
		}
	}
	// 结构性失败用 404 收口。必须排在通用 accountUnavailable 分支之前，且只在没有任何
	// "重试可能有救"的信号时才走：上面几个分支说明确实碰到过上游（限流/超时/5xx），
	// transientPickFailureSeen / accountDeadSeen 说明另有路线只是暂时不可用——
	// 那些情况仍旧要给可重试的 5xx，否则会把瞬时故障误判成永久失效。
	//
	// 这里返回 4xx 是刻意的：503 + "请稍后重试" 会让客户端 SDK 按 5xx 规则指数退避重试，
	// 而分组已下线永远不会恢复，用户侧表现就是长时间卡死而非一个明确的报错。
	if !summary.transientPickFailureSeen && !summary.accountDeadSeen {
		if summary.groupOfflineSeen {
			return allRoutesFailureResponse{
				status:  http.StatusNotFound,
				errType: "not_found_error",
				code:    appusage.ErrorCodeGroupOffline,
				message: "当前 API Key 所属分组已下线，无法继续提供服务。请在控制台重新创建 API Key 或改用其它分组。",
			}
		}
		if summary.modelNotServedSeen {
			return allRoutesFailureResponse{
				status:  http.StatusNotFound,
				errType: "not_found_error",
				code:    appusage.ErrorCodeModelNotServed,
				message: "当前 API Key 所属分组未提供所请求的模型，请更换模型或改用其它分组。",
			}
		}
	}
	if summary.accountDeadSeen || summary.accountUnavailable {
		return allRoutesFailureResponse{
			status:  http.StatusServiceUnavailable,
			errType: "server_error",
			code:    appusage.ErrorCodeNoAvailableAccount,
			message: "暂无可用上游账号，请稍后重试",
		}
	}
	return allRoutesFailureResponse{
		status:  http.StatusServiceUnavailable,
		errType: "server_error",
		code:    appusage.ErrorCodeAllRoutesFailed,
		message: "请求暂时无法完成，请稍后重试",
	}
}

func (s allRoutesFailureSummary) allViableRoutesRateLimited() bool {
	if !s.rateLimitedSeen && !s.schedulerRateLimitedSeen {
		return false
	}
	// Structural route failures (offline / model not served) are not viable and
	// therefore do not dilute a genuine all-cooldown result. Every recoverable
	// non-cooldown signal must keep the final response out of the 429 contract.
	return !s.localCapacitySeen &&
		!s.transientPickFailureSeen &&
		!s.accountDeadSeen &&
		!s.upstreamTimeoutSeen &&
		!s.upstreamFailureSeen &&
		!s.unclassifiedPickFailureSeen
}

func returnableUpstream(up sdk.UpstreamResponse) bool {
	return up.StatusCode > 0
}

func isTimeoutFailure(execution forwardExecution) bool {
	if execution.outcome.Upstream.StatusCode == http.StatusGatewayTimeout {
		return true
	}
	if errors.Is(execution.err, context.DeadlineExceeded) {
		return true
	}
	var timeoutErr interface{ Timeout() bool }
	if errors.As(execution.err, &timeoutErr) && timeoutErr.Timeout() {
		return true
	}
	reason := strings.ToLower(judgmentReason(execution))
	return strings.Contains(reason, "timeout") || strings.Contains(reason, "timed out") || strings.Contains(reason, "deadline exceeded")
}

func routesForAPIKey(state *forwardState, requirements routing.Requirements) []routing.Candidate {
	if state == nil || state.keyInfo == nil {
		return nil
	}
	if !apiKeyGroupMatchesRequirements(state.keyInfo, requirements) {
		return nil
	}
	return []routing.Candidate{keyInfoRoute(state.keyInfo)}
}

// apiKeyGroupMatchesRequirements 使用 routing 包的统一判定逻辑。
func apiKeyGroupMatchesRequirements(keyInfo *auth.APIKeyInfo, requirements routing.Requirements) bool {
	if keyInfo == nil {
		return false
	}
	return routing.GroupSupportsImageRequirement(keyInfo.GroupPlatform, keyInfo.GroupPluginSettings, requirements)
}

type groupRequirementError struct {
	status  int
	errType string
	code    string
	message string
}

// apiKeyGroupRequirementError 基于 routing 包统一判定逻辑返回结构化错误。
func apiKeyGroupRequirementError(keyInfo *auth.APIKeyInfo, requirements routing.Requirements) (groupRequirementError, bool) {
	if keyInfo == nil {
		return groupRequirementError{}, false
	}
	if routing.GroupSupportsImageRequirement(keyInfo.GroupPlatform, keyInfo.GroupPluginSettings, requirements) {
		return groupRequirementError{}, false
	}
	// 当前唯一的不满足场景：图片生成未开启
	if requirements.NeedsImage {
		return groupRequirementError{
			status:  http.StatusForbidden,
			errType: "invalid_request_error",
			code:    "image_generation_disabled",
			message: "当前分组未开启图片生成功能",
		}, true
	}
	return groupRequirementError{}, false
}

func keyInfoRoute(keyInfo *auth.APIKeyInfo) routing.Candidate {
	return routing.Candidate{
		GroupID:                keyInfo.GroupID,
		Platform:               keyInfo.GroupPlatform,
		EffectiveRate:          billing.ResolveBillingRateForGroup(keyInfo.UserGroupRates, keyInfo.GroupID, keyInfo.GroupRateMultiplier),
		GroupRateMultiplier:    keyInfo.GroupRateMultiplier,
		GroupServiceTier:       keyInfo.GroupServiceTier,
		GroupForceInstructions: keyInfo.GroupForceInstructions,
		GroupPluginSettings:    clonePluginSettingsForKey(keyInfo.GroupPluginSettings),
		UserPluginSettings:     clonePluginSettingsForKey(keyInfo.UserGroupPluginSettings[int64(keyInfo.GroupID)]),
	}
}

func clonePluginSettingsForKey(in map[string]map[string]string) map[string]map[string]string {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]map[string]string, len(in))
	for plugin, settings := range in {
		if len(settings) == 0 {
			continue
		}
		out[plugin] = make(map[string]string, len(settings))
		for k, v := range settings {
			out[plugin][k] = v
		}
	}
	return out
}

func keyInfoForRoute(base *auth.APIKeyInfo, route routing.Candidate) *auth.APIKeyInfo {
	info := *base
	info.GroupID = route.GroupID
	info.GroupPlatform = route.Platform
	info.GroupRateMultiplier = route.GroupRateMultiplier
	info.GroupServiceTier = route.GroupServiceTier
	info.GroupForceInstructions = route.GroupForceInstructions
	info.GroupPluginSettings = route.GroupPluginSettings
	if route.UserPluginSettings != nil {
		info.UserGroupPluginSettings = map[int64]map[string]map[string]string{
			int64(route.GroupID): clonePluginSettingsForKey(route.UserPluginSettings),
		}
	}
	return &info
}

// canFailover 是否允许换账号重试。
// 流式业务数据已写入 → 不可；只有协议中立 SSE comment 心跳时仍可；
// err 非 nil（插件自身崩）→ 可；ClientError → 可（见 replayableClientError，
// 穷尽后由 Forward 回放最后一次 4xx 原始响应）；其余由 Kind.ShouldFailover() 决定。
func (f *Forwarder) canFailover(c *gin.Context, state *forwardState, execution forwardExecution) bool {
	if state.stream && streamApplicationResponseCommitted(c) {
		return false
	}
	if execution.err != nil {
		return true
	}
	if execution.outcome.Kind == sdk.OutcomeClientError {
		return replayableClientError(execution.outcome)
	}
	if execution.outcome.Kind == sdk.OutcomeStreamAborted {
		return streamAbortRetryable(c)
	}
	return execution.outcome.Kind.ShouldFailover()
}

// streamAbortRetryable 判定一次「响应流中断」是否值得换账号重试。
//
// StreamAborted 默认不 failover 的理由是「字节已经流给客户端，重试会产生重复内容」，
// 但生产实测这个前提大多不成立：近 30 天 371 次 stream_aborted 里 353 次（95%）
// 在中断时**一个 token 都没吐给客户端**，此前一律直接回 502。
//
// 判据两条，缺一不可：
//  1. 没有任何应用数据写给客户端（心跳/SSE 注释不算）——重试不会重复内容；
//  2. 客户端连接还在——ctx 已取消说明是客户自己走了（近 30 天该类占 ~129 次，
//     错误原文「读取上游 SSE 失败: context canceled」），重试纯烧上游成本。
//
// 剩下的就是上游侧中断，典型如中继先发保活帧把 HTTP 状态定死、真响应到达后无法回写
// （2026-09-01 生产实例：「upstream response arrived after synthetic frame;
// original HTTP status is already committed」），换账号大概率一次即好。
func streamAbortRetryable(c *gin.Context) bool {
	if c == nil || c.Request == nil {
		return false
	}
	if streamApplicationResponseCommitted(c) {
		return false
	}
	return canceledRequestStatus(c.Request.Context().Err()) == 0
}

// replayableClientError 判定一次 4xx 判决是否值得换账号重放。
// 服务稳定性优先：中转常把自身上游的故障包装成 4xx 返回（例：2026-08-21 aijws
// 用 400 + "Upstream request failed" 表达其上游转发失败），且组内各账号支持的
// 模型/参数集合不同，换号确有救活的机会。真正的客户端错误在所有账号上都会 4xx，
// 穷尽后 Forward 回放最后一次原始响应，客户端看到的结果与不重试时一致，
// 代价只是 maxFailoverAttempts 上限内的额外上游调用。
// 唯独 504 网关超时执行结果未知，禁止在其它账号上重放。
func replayableClientError(outcome sdk.ForwardOutcome) bool {
	return outcome.Upstream.StatusCode != http.StatusGatewayTimeout
}

// sameAccountRetryable 判定一次失败是否值得在同一账号上原地再试（仅当已无其它候选）。
// 凡是"账号无过错"的失败都算：连接被重置 / EOF / 5xx / 上游 504 / 首字或停滞守卫断开 /
// 插件自身出错——换不到号时与其把错误吐给客户端，不如再试一次（用户拍板：兜住错误优先，
// 超时类也要重试；代价是客户端等待可能翻倍，客户端自己先放弃时 ctx 结束、重试即刻停止）。
// 只排除原地重试必然复现的两类：账号级过错（限流 / 死信）与客户端错误。
func sameAccountRetryable(execution forwardExecution) bool {
	kind := execution.outcome.Kind
	if kind.IsAccountFault() || kind == sdk.OutcomeClientError || kind == sdk.OutcomeSuccess {
		return false
	}
	return kind == sdk.OutcomeUpstreamTransient || kind == sdk.OutcomeStreamAborted || execution.err != nil
}

func sameAccountRetryDelayFor(retryAfter time.Duration) time.Duration {
	if retryAfter <= 0 {
		return sameAccountRetryDelay
	}
	if retryAfter > sameAccountRetryMaxDelay {
		return sameAccountRetryMaxDelay
	}
	return retryAfter
}

func removeAccountID(ids []int, id int) []int {
	out := make([]int, 0, len(ids))
	for _, v := range ids {
		if v != id {
			out = append(out, v)
		}
	}
	return out
}

// waitBeforeRetry 等待 d 后返回 true；请求上下文先结束则返回 false。
func waitBeforeRetry(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// callPlugin 把请求发给插件。
func (f *Forwarder) callPlugin(c *gin.Context, state *forwardState) forwardExecution {
	state.grpcCallAt = time.Now()
	outcome, err := state.plugin.Gateway.Forward(c.Request.Context(), buildPluginRequest(c, state))
	return forwardExecution{
		outcome:  outcome,
		err:      err,
		duration: time.Since(state.startedAt),
	}
}
