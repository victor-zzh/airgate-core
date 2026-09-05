package plugin

import (
	"bytes"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/DouDOU-start/airgate-core/internal/auth"
	"github.com/DouDOU-start/airgate-core/internal/billing"
	"github.com/DouDOU-start/airgate-core/internal/server/middleware"
	sdk "github.com/DouDOU-start/airgate-sdk/sdkgo"
)

// 单供给分组（组内只有一个可调度账号）：主力网络抖动类瞬时失败后应原地再试一次，
// 超时 / 限流 / 客户端错误不重试。走完整 Forward 入口，仅注入上游判决。
func TestSameAccountRetryOnSoleAccount(t *testing.T) {
	tests := []struct {
		name       string
		first      sdk.ForwardOutcome
		firstErr   error
		secondOK   bool
		stream     bool
		wantCalls  int
		wantStatus int
	}{
		{name: "connection reset retried and recovers", first: transientInjected(502, "上游连接被重置: read: connection reset by peer"), secondOK: true, wantCalls: 2, wantStatus: 200},
		{name: "stream connection reset before output retried", first: transientInjected(502, "读取上游 SSE 失败: unexpected EOF"), secondOK: true, stream: true, wantCalls: 2, wantStatus: 200},
		{name: "plugin transport error retried", firstErr: fmt.Errorf("rpc error: code = Unavailable desc = transport is closing"), secondOK: true, wantCalls: 2, wantStatus: 200},
		{name: "retry-after is honoured but capped", first: withRetryAfter(transientInjected(503, "Our servers are currently overloaded"), 30), secondOK: true, wantCalls: 2, wantStatus: 200},
		{name: "retry exhausted still returns upstream failure", first: transientInjected(502, "connection reset"), wantCalls: 2, wantStatus: 502},
		{name: "upstream 504 is retried once on the same account", first: transientInjected(504, "HTTP 504: gateway timeout"), secondOK: true, wantCalls: 2, wantStatus: 200},
		{name: "upstream 504 twice still returns 504", first: transientInjected(504, "HTTP 504: gateway timeout"), wantCalls: 2, wantStatus: 504},
		{name: "plugin watchdog timeout is retried once", first: transientInjected(502, "上游首字节或流停滞超时（插件守卫断开）: context canceled"), secondOK: true, wantCalls: 2, wantStatus: 200},
		{name: "rate limit is not retried", first: injected(sdk.OutcomeAccountRateLimited, 429, "rate limited"), secondOK: true, wantCalls: 1, wantStatus: 429},
		{name: "client error is replayed not retried", first: injected(sdk.OutcomeClientError, 400, "invalid messages"), secondOK: true, wantCalls: 1, wantStatus: 400},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fx := newHostStabilityFixture(t, 1, nil)
			sole := fx.accounts[0]
			fx.db.Group.UpdateOneID(fx.group.ID).SetModelRouting(map[string][]int64{hostStabilityModel: {int64(sole.ID)}}).ExecX(fx.ctx)
			mgr := fx.host.manager
			mgr.routeCache = map[string][]sdk.RouteDefinition{"gateway-quota-test": {{Method: "POST", Path: "/v1/chat/completions"}}}
			mgr.modelCache = map[string][]sdk.ModelInfo{"gateway-quota-test": {{ID: hostStabilityModel}}}
			key := fx.db.APIKey.Create().SetName("sole").SetKeyHash("sole-" + tc.name).SetUserID(fx.user.ID).SetGroupID(fx.group.ID).SaveX(fx.ctx)
			recorder := billing.NewRecorder(fx.db, 0)
			recorder.Start()
			t.Cleanup(recorder.Stop)
			forwarder := NewForwarder(fx.db, mgr, fx.scheduler, fx.concurrency, billing.NewCalculator(), recorder)

			var mu sync.Mutex
			calls := 0
			fx.gateway.forward = func(_ int32, req *sdk.ForwardRequest) (sdk.ForwardOutcome, error) {
				mu.Lock()
				calls++
				n := calls
				mu.Unlock()
				if n == 1 || !tc.secondOK {
					if tc.firstErr != nil {
						return sdk.ForwardOutcome{}, tc.firstErr
					}
					return tc.first, nil
				}
				out := hostQuotaSuccessOutcome()
				out.Usage = &sdk.Usage{Model: hostStabilityModel, Currency: "USD", AccountCost: 0.01}
				if req.Stream {
					req.Writer.Header().Set("Content-Type", "text/event-stream")
					if _, err := req.Writer.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\ndata: [DONE]\n\n")); err != nil {
						return sdk.ForwardOutcome{}, err
					}
					out.Upstream.Body = nil
				}
				return out, nil
			}

			body := []byte(fmt.Sprintf(`{"model":%q,"stream":%t,"messages":[{"role":"user","content":"test"}]}`, hostStabilityModel, tc.stream))
			rr := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(rr)
			c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewReader(body)).WithContext(fx.ctx)
			c.Request.Header.Set("Content-Type", "application/json")
			c.Set(middleware.CtxKeyKeyInfo, &auth.APIKeyInfo{KeyID: key.ID, UserID: fx.user.ID, UserEmail: fx.user.Email, GroupID: fx.group.ID, GroupPlatform: "quota-test", UserBalance: 100, GroupRateMultiplier: 2, SellRate: 4, GroupModelRouting: map[string][]int64{hostStabilityModel: {int64(sole.ID)}}})
			forwarder.Forward(c)
			recorder.Stop()

			mu.Lock()
			got := calls
			mu.Unlock()
			if got != tc.wantCalls {
				t.Fatalf("upstream calls = %d, want %d; status=%d body=%s", got, tc.wantCalls, rr.Code, rr.Body.String())
			}
			if rr.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d; body=%s", rr.Code, tc.wantStatus, rr.Body.String())
			}
			if leaked := fx.concurrency.GetCurrentCount(fx.ctx, sole.ID); leaked != 0 {
				t.Fatalf("account %d leaked %d slots", sole.ID, leaked)
			}
			if logs := fx.db.UsageLog.Query().AllX(fx.ctx); len(logs) != 1 {
				t.Fatalf("usage records = %d, want exactly one", len(logs))
			}
		})
	}
}

func TestSameAccountRetryable(t *testing.T) {
	cases := []struct {
		name string
		exec forwardExecution
		want bool
	}{
		{"transient 502", forwardExecution{outcome: transientInjected(502, "connection reset")}, true},
		{"stream aborted before output", forwardExecution{outcome: sdk.ForwardOutcome{Kind: sdk.OutcomeStreamAborted, Reason: "unexpected EOF"}}, true},
		{"plugin error unknown kind", forwardExecution{err: fmt.Errorf("transport is closing")}, true},
		{"504", forwardExecution{outcome: transientInjected(504, "gateway timeout")}, true},
		{"watchdog timeout wording", forwardExecution{outcome: transientInjected(502, "上游首字节或流停滞超时（插件守卫断开）")}, true},
		{"english timeout wording", forwardExecution{outcome: transientInjected(502, "i/o timeout")}, true},
		{"rate limited", forwardExecution{outcome: injected(sdk.OutcomeAccountRateLimited, 429, "limit")}, false},
		{"dead", forwardExecution{outcome: injected(sdk.OutcomeAccountDead, 401, "bad key")}, false},
		{"client error", forwardExecution{outcome: injected(sdk.OutcomeClientError, 400, "bad request")}, false},
		{"success", forwardExecution{outcome: sdk.ForwardOutcome{Kind: sdk.OutcomeSuccess}}, false},
	}
	for _, tc := range cases {
		if got := sameAccountRetryable(tc.exec); got != tc.want {
			t.Errorf("%s: sameAccountRetryable = %v, want %v", tc.name, got, tc.want)
		}
	}
	if d := sameAccountRetryDelayFor(0); d != sameAccountRetryDelay {
		t.Fatalf("default delay = %v", d)
	}
	if d := sameAccountRetryDelayFor(sameAccountRetryMaxDelay * 10); d != sameAccountRetryMaxDelay {
		t.Fatalf("capped delay = %v", d)
	}
}

func injected(kind sdk.OutcomeKind, status int, reason string) sdk.ForwardOutcome {
	return sdk.ForwardOutcome{Kind: kind, Reason: reason, Upstream: sdk.UpstreamResponse{StatusCode: status, Body: []byte(`{"error":{"message":"` + reason + `","type":"server_error"}}`)}}
}

func transientInjected(status int, reason string) sdk.ForwardOutcome {
	return injected(sdk.OutcomeUpstreamTransient, status, reason)
}

func withRetryAfter(out sdk.ForwardOutcome, seconds int) sdk.ForwardOutcome {
	out.RetryAfter = time.Duration(seconds) * time.Second
	return out
}
