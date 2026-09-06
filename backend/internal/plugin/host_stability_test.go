package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	entsql "entgo.io/ent/dialect/sql"
	"entgo.io/ent/dialect/sql/schema"
	"github.com/alicebob/miniredis/v2"
	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	_ "github.com/mattn/go-sqlite3"
	"github.com/redis/go-redis/v9"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/proto"

	"github.com/DouDOU-start/airgate-core/ent"
	entaccount "github.com/DouDOU-start/airgate-core/ent/account"
	"github.com/DouDOU-start/airgate-core/ent/enttest"
	appusage "github.com/DouDOU-start/airgate-core/internal/app/usage"
	"github.com/DouDOU-start/airgate-core/internal/billing"
	"github.com/DouDOU-start/airgate-core/internal/routing"
	"github.com/DouDOU-start/airgate-core/internal/scheduler"
	pb "github.com/DouDOU-start/airgate-sdk/protocol/proto"
	sdk "github.com/DouDOU-start/airgate-sdk/sdkgo"
)

const hostStabilityModel = "quota-test-model"

type hostStabilityFixture struct {
	ctx         context.Context
	db          *ent.Client
	redisServer *miniredis.Miniredis
	rdb         *redis.Client
	user        *ent.User
	group       *ent.Group
	accounts    []*ent.Account
	gateway     *hostQuotaTestGateway
	scheduler   *scheduler.Scheduler
	concurrency *scheduler.ConcurrencyManager
	host        *HostService
}

func newHostStabilityFixture(t *testing.T, accountCount int, forward func(int32, *sdk.ForwardRequest) (sdk.ForwardOutcome, error)) *hostStabilityFixture {
	t.Helper()
	ctx := context.Background()
	drv, err := entsql.Open("sqlite3", "file:host_stability_"+uuid.NewString()+"?mode=memory&cache=shared&_fk=1")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	drv.DB().SetMaxOpenConns(1)
	db := enttest.NewClient(
		t,
		enttest.WithOptions(ent.Driver(drv)),
		enttest.WithMigrateOptions(schema.WithGlobalUniqueID(false)),
	)
	t.Cleanup(func() { _ = db.Close() })

	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })

	user := db.User.Create().
		SetEmail("host-stability-" + uuid.NewString() + "@example.com").
		SetPasswordHash("hash").
		SetBalance(100).
		SaveX(ctx)
	group := db.Group.Create().
		SetName("host-stability").
		SetPlatform("quota-test").
		SaveX(ctx)
	accounts := make([]*ent.Account, 0, accountCount)
	routeIDs := make([]int64, 0, accountCount)
	for i := 0; i < accountCount; i++ {
		acc := db.Account.Create().
			SetName("host-stability-" + uuid.NewString()).
			SetPlatform("quota-test").
			SetCredentials(map[string]string{"access_token": "original", "tenant": "keep"}).
			SetMaxConcurrency(2).
			SetExtra(map[string]interface{}{"max_rpm": 10}).
			AddGroups(group).
			SaveX(ctx)
		accounts = append(accounts, acc)
		routeIDs = append(routeIDs, int64(acc.ID))
	}
	db.Group.UpdateOneID(group.ID).
		SetModelRouting(map[string][]int64{hostStabilityModel: routeIDs}).
		ExecX(ctx)

	gateway := &hostQuotaTestGateway{forward: forward}
	client := newHostQuotaGatewayClient(t, gateway)
	manager := &Manager{instances: map[string]*PluginInstance{
		"gateway-quota-test": {
			Name:     "gateway-quota-test",
			Platform: "quota-test",
			Gateway:  client,
		},
	}}
	sched := scheduler.NewScheduler(db, rdb)
	concurrency := scheduler.NewConcurrencyManager(rdb)
	host := &HostService{
		db:          db,
		manager:     manager,
		scheduler:   sched,
		concurrency: concurrency,
	}
	return &hostStabilityFixture{
		ctx:         ctx,
		db:          db,
		redisServer: mr,
		rdb:         rdb,
		user:        user,
		group:       group,
		accounts:    accounts,
		gateway:     gateway,
		scheduler:   sched,
		concurrency: concurrency,
		host:        host,
	}
}

func (f *hostStabilityFixture) request(accountID int64) hostForwardRequest {
	return hostForwardRequest{
		UserID:    int64(f.user.ID),
		GroupID:   int64(f.group.ID),
		AccountID: accountID,
		Model:     hostStabilityModel,
		Method:    http.MethodPost,
		Path:      "/v1/chat/completions",
		Headers: map[string]interface{}{
			"X-Airgate-Platform": []string{"quota-test"},
		},
		Body: []byte(`{"model":"quota-test-model"}`),
	}
}

func (f *hostStabilityFixture) markCooldown(accountID int, retryAfter time.Duration) {
	f.scheduler.Apply(f.ctx, accountID, scheduler.Judgment{
		Kind:       sdk.OutcomeAccountRateLimited,
		RetryAfter: retryAfter,
		Reason:     "test cooldown",
		Family:     scheduler.ModelFamily("quota-test", hostStabilityModel),
	})
}

func TestHostForwardAllCooldownReturns429WithoutGatewayCall(t *testing.T) {
	fixture := newHostStabilityFixture(t, 2, nil)
	for _, acc := range fixture.accounts {
		fixture.markCooldown(acc.ID, 5*time.Second)
	}

	start := time.Now()
	payload, err := fixture.host.forward(fixture.ctx, fixture.request(0))
	if err != nil {
		t.Fatalf("forward all cooldown: %v", err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("all-cooldown forward took %v, want immediate response", elapsed)
	}
	if got := payload["status_code"]; got != http.StatusTooManyRequests {
		t.Fatalf("status_code = %v, want %d", got, http.StatusTooManyRequests)
	}
	if got := hostPayloadErrorCode(t, payload); got != appusage.ErrorCodeAllRoutesRateLimited {
		t.Fatalf("error code = %q, want %q", got, appusage.ErrorCodeAllRoutesRateLimited)
	}
	if retryAfter := hostPayloadHeaderValues(t, payload, "Retry-After"); len(retryAfter) != 1 || retryAfter[0] == "" {
		t.Fatalf("Retry-After = %v, want one value", retryAfter)
	}
	if calls := fixture.gateway.calls.Load(); calls != 0 {
		t.Fatalf("gateway calls = %d, want 0", calls)
	}
}

func TestHostForwardStreamAllCooldownSendsStructured429Frames(t *testing.T) {
	fixture := newHostStabilityFixture(t, 1, nil)
	fixture.markCooldown(fixture.accounts[0].ID, 5*time.Second)
	stream := &recordingHostStream{ctx: fixture.ctx}
	req := fixture.request(0)
	req.Stream = true

	start := time.Now()
	if err := fixture.host.forwardStream(fixture.ctx, req, stream); err != nil {
		t.Fatalf("forwardStream all cooldown: %v", err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("all-cooldown stream took %v, want immediate response", elapsed)
	}
	if calls := fixture.gateway.calls.Load(); calls != 0 {
		t.Fatalf("gateway calls = %d, want 0", calls)
	}
	if len(stream.frames) != 3 {
		t.Fatalf("stream frames = %d, want headers/chunk/done", len(stream.frames))
	}
	if stream.frames[0].Event != "headers" {
		t.Fatalf("first frame event = %q, want headers", stream.frames[0].Event)
	}
	var headersPayload struct {
		StatusCode int `json:"status_code"`
	}
	if err := json.Unmarshal(stream.frames[0].Payload, &headersPayload); err != nil {
		t.Fatalf("decode headers frame: %v", err)
	}
	if headersPayload.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("stream status = %d, want %d", headersPayload.StatusCode, http.StatusTooManyRequests)
	}
	if stream.frames[1].Event != "chunk" || !json.Valid(stream.frames[1].Payload) {
		t.Fatalf("second frame = %+v, want JSON chunk", stream.frames[1])
	}
	var chunkPayload struct {
		Data string `json:"data"`
	}
	if err := json.Unmarshal(stream.frames[1].Payload, &chunkPayload); err != nil {
		t.Fatalf("decode chunk frame: %v", err)
	}
	if !json.Valid([]byte(chunkPayload.Data)) {
		t.Fatalf("chunk data = %q, want structured JSON error", chunkPayload.Data)
	}
	if stream.frames[2].Event != "done" || !stream.frames[2].Done {
		t.Fatalf("final frame = %+v, want done", stream.frames[2])
	}
}

func TestHostForwardCooldownMixedWithDisabledReturns503Immediately(t *testing.T) {
	fixture := newHostStabilityFixture(t, 2, nil)
	fixture.markCooldown(fixture.accounts[0].ID, 5*time.Second)
	fixture.db.Account.UpdateOneID(fixture.accounts[1].ID).
		SetState(entaccount.StateDisabled).
		ExecX(fixture.ctx)

	start := time.Now()
	payload, err := fixture.host.forward(fixture.ctx, fixture.request(0))
	if err != nil {
		t.Fatalf("forward mixed cooldown/disabled: %v", err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("mixed cooldown/disabled forward took %v, want immediate response", elapsed)
	}
	if got := payload["status_code"]; got != http.StatusServiceUnavailable {
		t.Fatalf("status_code = %v, want %d", got, http.StatusServiceUnavailable)
	}
	if got := hostPayloadErrorCode(t, payload); got != appusage.ErrorCodeNoAvailableAccount {
		t.Fatalf("error code = %q, want %q", got, appusage.ErrorCodeNoAvailableAccount)
	}
	if calls := fixture.gateway.calls.Load(); calls != 0 {
		t.Fatalf("gateway calls = %d, want 0", calls)
	}
}

func TestHostForwardUpstreamTimeoutFailsOverToNextAccount(t *testing.T) {
	var firstAccountID, secondAccountID int64
	fixture := newHostStabilityFixture(t, 2, func(call int32, req *sdk.ForwardRequest) (sdk.ForwardOutcome, error) {
		if call == 1 {
			firstAccountID = req.Account.ID
			return sdk.ForwardOutcome{}, context.DeadlineExceeded
		}
		secondAccountID = req.Account.ID
		return hostQuotaSuccessOutcome(), nil
	})

	payload, err := fixture.host.forward(fixture.ctx, fixture.request(0))
	if err != nil {
		t.Fatalf("forward after upstream timeout: %v", err)
	}
	if got := payload["status_code"]; got != http.StatusOK {
		t.Fatalf("status_code = %v, want %d", got, http.StatusOK)
	}
	if calls := fixture.gateway.calls.Load(); calls != 2 {
		t.Fatalf("gateway calls = %d, want 2", calls)
	}
	if firstAccountID == 0 || secondAccountID == 0 || firstAccountID == secondAccountID {
		t.Fatalf("failover accounts = %d then %d, want two different accounts", firstAccountID, secondAccountID)
	}

	totalRPM := 0
	for _, acc := range fixture.accounts {
		if got := fixture.concurrency.GetCurrentCount(fixture.ctx, acc.ID); got != 0 {
			t.Fatalf("account %d concurrency slots = %d, want 0", acc.ID, got)
		}
		totalRPM += hostRPMCount(t, fixture.ctx, fixture.rdb, acc.ID)
	}
	if totalRPM != 1 {
		t.Fatalf("RPM after timeout failover = %d, want only the successful request counted", totalRPM)
	}
}

func TestHostForwardExhaustsAllCandidatesBeyondLegacyLimit(t *testing.T) {
	fixture := newHostStabilityFixture(t, 4, func(call int32, _ *sdk.ForwardRequest) (sdk.ForwardOutcome, error) {
		if call <= 3 {
			return sdk.ForwardOutcome{}, context.DeadlineExceeded
		}
		return hostQuotaSuccessOutcome(), nil
	})

	payload, err := fixture.host.forward(fixture.ctx, fixture.request(0))
	if err != nil {
		t.Fatalf("forward after exhausting candidates: %v", err)
	}
	if got := payload["status_code"]; got != http.StatusOK {
		t.Fatalf("status_code = %v, want %d", got, http.StatusOK)
	}
	if calls := fixture.gateway.calls.Load(); calls != 4 {
		t.Fatalf("gateway calls = %d, want 4", calls)
	}
}

func TestHostForwardStreamUpstreamTimeoutFailsOverBeforeCommit(t *testing.T) {
	fixture := newHostStabilityFixture(t, 2, func(call int32, _ *sdk.ForwardRequest) (sdk.ForwardOutcome, error) {
		if call == 1 {
			return sdk.ForwardOutcome{}, context.DeadlineExceeded
		}
		return hostQuotaSuccessOutcome(), nil
	})
	stream := &recordingHostStream{ctx: fixture.ctx}
	req := fixture.request(0)
	req.Stream = true

	if err := fixture.host.forwardStream(fixture.ctx, req, stream); err != nil {
		t.Fatalf("forwardStream after upstream timeout: %v", err)
	}
	if calls := fixture.gateway.calls.Load(); calls != 2 {
		t.Fatalf("gateway calls = %d, want 2", calls)
	}
	if len(stream.frames) != 1 || stream.frames[0].Event != "done" || !stream.frames[0].Done {
		t.Fatalf("stream frames = %+v, want one successful done frame", stream.frames)
	}
}

func TestHostSecondGateKeepsSelectedProbeOwnership(t *testing.T) {
	fixture := newHostStabilityFixture(t, 1, nil)
	acc := fixture.accounts[0]
	fixture.markCooldown(acc.ID, time.Second)
	fixture.redisServer.FastForward(2 * time.Second)

	const probeToken = "selected-half-open-owner"
	selectionCtx := scheduler.WithFamilyProbeToken(fixture.ctx, probeToken)
	selected, err := fixture.scheduler.SelectAccount(selectionCtx, acc.Platform, hostStabilityModel, 0, fixture.group.ID, "")
	if err != nil || selected == nil || selected.ID != acc.ID {
		t.Fatalf("half-open selection = %v, err=%v; want account %d", selected, err, acc.ID)
	}
	decision, err := fixture.scheduler.ClaimAccountGate(selectionCtx, acc.ID, acc.Platform, hostStabilityModel, probeToken)
	if err != nil {
		t.Fatalf("second account gate: %v", err)
	}
	if !decision.Allowed() || !decision.ProbeClaimed {
		t.Fatalf("second gate decision = %+v, want allowed probe owner", decision)
	}
	fixture.scheduler.ReleaseFamilyProbe(fixture.ctx, acc.ID, acc.Platform, hostStabilityModel, probeToken)
}

func TestHostForwardPinnedGateRejectsWithoutGatewayAndRollsBackRPM(t *testing.T) {
	tests := []struct {
		name       string
		prepare    func(*hostStabilityFixture)
		wantStatus int
		wantCode   string
	}{
		{
			name: "cooldown",
			prepare: func(f *hostStabilityFixture) {
				f.markCooldown(f.accounts[0].ID, 5*time.Second)
			},
			wantStatus: http.StatusTooManyRequests,
			wantCode:   appusage.ErrorCodeAllRoutesRateLimited,
		},
		{
			name: "disabled",
			prepare: func(f *hostStabilityFixture) {
				f.db.Account.UpdateOneID(f.accounts[0].ID).SetState(entaccount.StateDisabled).ExecX(f.ctx)
			},
			wantStatus: http.StatusServiceUnavailable,
			wantCode:   appusage.ErrorCodeNoAvailableAccount,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			fixture := newHostStabilityFixture(t, 1, nil)
			tt.prepare(fixture)

			payload, err := fixture.host.forward(fixture.ctx, fixture.request(int64(fixture.accounts[0].ID)))
			if err != nil {
				t.Fatalf("pinned forward: %v", err)
			}
			if got := payload["status_code"]; got != tt.wantStatus {
				t.Fatalf("status_code = %v, want %d", got, tt.wantStatus)
			}
			if got := hostPayloadErrorCode(t, payload); got != tt.wantCode {
				t.Fatalf("error code = %q, want %q", got, tt.wantCode)
			}
			if calls := fixture.gateway.calls.Load(); calls != 0 {
				t.Fatalf("gateway calls = %d, want 0", calls)
			}
			if got := hostRPMCount(t, fixture.ctx, fixture.rdb, fixture.accounts[0].ID); got != 0 {
				t.Fatalf("RPM after rejected pinned gate = %d, want 0", got)
			}
			if got := fixture.concurrency.GetCurrentCount(fixture.ctx, fixture.accounts[0].ID); got != 0 {
				t.Fatalf("concurrency after rejected pinned gate = %d, want 0", got)
			}
		})
	}
}

func TestHostPinnedGatewayErrorPreservesStatusHeadersAndEmptyBody(t *testing.T) {
	t.Parallel()

	for _, statusCode := range []int{http.StatusTooManyRequests, http.StatusServiceUnavailable} {
		statusCode := statusCode
		t.Run(http.StatusText(statusCode), func(t *testing.T) {
			t.Parallel()
			outcome := sdk.ForwardOutcome{
				Kind: sdk.OutcomeUnknown,
				Upstream: sdk.UpstreamResponse{
					StatusCode: statusCode,
					Headers:    http.Header{"Retry-After": []string{"3"}},
				},
			}
			payload, err := hostPinnedGatewayError(outcome, errors.New("gateway transport error"), nil)
			if err != nil {
				t.Fatalf("hostPinnedGatewayError: %v", err)
			}
			if got := payload["status_code"]; got != statusCode {
				t.Fatalf("status_code = %v, want %d", got, statusCode)
			}
			if got := payload["body"]; got != "" {
				t.Fatalf("body = %v, want empty", got)
			}
			if got := hostPayloadHeaderValues(t, payload, "Retry-After"); len(got) != 1 || got[0] != "3" {
				t.Fatalf("Retry-After = %v, want [3]", got)
			}
		})
	}
}

func TestProbeForwardFailureReleasesHalfOpenToken(t *testing.T) {
	fixture := newHostStabilityFixture(t, 1, func(_ int32, _ *sdk.ForwardRequest) (sdk.ForwardOutcome, error) {
		return sdk.ForwardOutcome{
			Kind:               sdk.OutcomeUpstreamTransient,
			Reason:             "probe failed",
			Upstream:           sdk.UpstreamResponse{StatusCode: http.StatusServiceUnavailable},
			UpdatedCredentials: map[string]string{"access_token": "refreshed"},
		}, nil
	})
	acc := fixture.accounts[0]
	fixture.markCooldown(acc.ID, time.Second)
	fixture.redisServer.FastForward(2 * time.Second)

	resp, err := fixture.host.probeForward(fixture.ctx, hostProbeForwardRequest{
		GroupID: int64(fixture.group.ID),
		Model:   hostStabilityModel,
	})
	if err != nil {
		t.Fatalf("probeForward: %v", err)
	}
	if success, _ := resp["success"].(bool); success {
		t.Fatalf("probe response = %#v, want failure", resp)
	}
	if calls := fixture.gateway.calls.Load(); calls != 1 {
		t.Fatalf("gateway calls = %d, want 1", calls)
	}
	credentials := waitForHostCredentials(t, fixture, acc.ID, func(values map[string]string) bool {
		return values["access_token"] == "refreshed"
	})
	if credentials["tenant"] != "keep" {
		t.Fatalf("merged credentials = %#v, want tenant retained", credentials)
	}

	decision, err := fixture.scheduler.ClaimAccountGate(fixture.ctx, acc.ID, acc.Platform, hostStabilityModel, "next-probe")
	if err != nil {
		t.Fatalf("claim next probe: %v", err)
	}
	if !decision.Allowed() || !decision.ProbeClaimed {
		t.Fatalf("next probe decision = %+v, want allowed claimed probe", decision)
	}
	fixture.scheduler.ReleaseFamilyProbe(fixture.ctx, acc.ID, acc.Platform, hostStabilityModel, "next-probe")
}

func TestCanceledHostOutcomeRollsBackRPMAndKeepsAccountActive(t *testing.T) {
	fixture := newHostStabilityFixture(t, 1, nil)
	acc := fixture.accounts[0]
	if !fixture.scheduler.TryIncrementRPM(fixture.ctx, acc.ID, 10) {
		t.Fatal("reserve RPM")
	}
	canceledCtx, cancel := context.WithCancel(context.Background())
	cancel()

	applied := fixture.host.applyHostOutcome(
		canceledCtx,
		acc.ID,
		acc,
		hostStabilityModel,
		sdk.ForwardOutcome{Kind: sdk.OutcomeAccountDead, Reason: "racing account failure"},
		time.Millisecond,
		"canceled-host-probe",
		context.Canceled,
		true,
	)
	if applied {
		t.Fatal("canceled outcome applied to account")
	}
	if got := hostRPMCount(t, fixture.ctx, fixture.rdb, acc.ID); got != 0 {
		t.Fatalf("RPM after canceled host outcome = %d, want 0", got)
	}
	fresh := fixture.db.Account.GetX(fixture.ctx, acc.ID)
	if fresh.State != entaccount.StateActive {
		t.Fatalf("account state = %s, want active", fresh.State)
	}
}

func TestCanceledHostUsageKeepsChargeAndRecords499(t *testing.T) {
	fixture := newHostStabilityFixture(t, 1, nil)
	fixture.host.calculator = billing.NewCalculator()
	fixture.host.recorder = billing.NewRecorder(fixture.db, 0)
	acc := fixture.accounts[0]
	req := fixture.request(0)
	req.RequestID = uuid.NewString()
	outcome := sdk.ForwardOutcome{
		Kind: sdk.OutcomeSuccess,
		Usage: &sdk.Usage{
			Model:       hostStabilityModel,
			AccountCost: 0.02,
			Currency:    "USD",
		},
	}

	fixture.host.recordCanceledHostForwardUsage(
		req,
		routing.Candidate{GroupID: fixture.group.ID, Platform: "quota-test", EffectiveRate: 1},
		acc.ID,
		acc.Platform,
		hostStabilityModel,
		acc,
		fixture.user.Email,
		outcome,
		time.Second,
		statusClientClosedRequest,
	)

	logs := fixture.db.UsageLog.Query().AllX(fixture.ctx)
	if len(logs) != 1 {
		t.Fatalf("usage log count = %d, want 1", len(logs))
	}
	log := logs[0]
	if log.Status != appusage.StatusSuccess {
		t.Fatalf("usage status = %q, want charged success record", log.Status)
	}
	if log.ErrorCode != appusage.ErrorCodeClientCanceled || log.ErrorStatus != statusClientClosedRequest {
		t.Fatalf("cancellation metadata = (%q, %d), want (%q, %d)", log.ErrorCode, log.ErrorStatus, appusage.ErrorCodeClientCanceled, statusClientClosedRequest)
	}
	if log.ActualCost <= 0 {
		t.Fatalf("actual cost = %v, want charged usage retained", log.ActualCost)
	}
}

func TestCanceledPublicResultRollsBackRPMAndKeepsAccountActive(t *testing.T) {
	fixture := newHostStabilityFixture(t, 1, nil)
	acc := fixture.accounts[0]
	if !fixture.scheduler.TryIncrementRPM(fixture.ctx, acc.ID, 10) {
		t.Fatal("reserve RPM")
	}
	f := &Forwarder{scheduler: fixture.scheduler}
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	canceledCtx, cancel := context.WithCancel(context.Background())
	cancel()
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil).WithContext(canceledCtx)

	f.writeResult(c, &forwardState{
		account:           acc,
		requestedPlatform: acc.Platform,
		model:             hostStabilityModel,
		schedulingModel:   hostStabilityModel,
		requestID:         "canceled-public-probe",
		requestPath:       "/v1/chat/completions",
	}, forwardExecution{
		outcome: sdk.ForwardOutcome{Kind: sdk.OutcomeAccountDead, Reason: "racing account failure"},
	})

	if got := hostRPMCount(t, fixture.ctx, fixture.rdb, acc.ID); got != 0 {
		t.Fatalf("RPM after canceled public result = %d, want 0", got)
	}
	if got := requestLogStatusForTest(c); got != statusClientClosedRequest {
		t.Fatalf("status override = %d, want %d", got, statusClientClosedRequest)
	}
	fresh := fixture.db.Account.GetX(fixture.ctx, acc.ID)
	if fresh.State != entaccount.StateActive {
		t.Fatalf("account state = %s, want active", fresh.State)
	}
}

func hostPayloadErrorCode(t *testing.T, payload map[string]interface{}) string {
	t.Helper()
	body, ok := payload["body"].(string)
	if !ok {
		t.Fatalf("payload body = %T, want string", payload["body"])
	}
	var decoded struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &decoded); err != nil {
		t.Fatalf("decode payload body %q: %v", body, err)
	}
	return decoded.Error.Code
}

func hostPayloadHeaderValues(t *testing.T, payload map[string]interface{}, name string) []string {
	t.Helper()
	headers, ok := payload["headers"].(map[string]interface{})
	if !ok {
		t.Fatalf("payload headers = %T, want map", payload["headers"])
	}
	values, ok := headers[name].([]string)
	if !ok {
		t.Fatalf("header %s = %T, want []string", name, headers[name])
	}
	return values
}

func requestLogStatusForTest(c *gin.Context) int {
	value, ok := c.Get(ginCtxKeyStatus)
	if !ok {
		return 0
	}
	status, _ := value.(int)
	return status
}

func waitForHostCredentials(t *testing.T, fixture *hostStabilityFixture, accountID int, ready func(map[string]string) bool) map[string]string {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		credentials := fixture.db.Account.GetX(fixture.ctx, accountID).Credentials
		if ready(credentials) {
			return credentials
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("credentials did not update before deadline: %#v", credentials)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

type recordingHostStream struct {
	ctx    context.Context
	frames []*pb.HostStreamFrame
}

func (s *recordingHostStream) Send(frame *pb.HostStreamFrame) error {
	s.frames = append(s.frames, proto.Clone(frame).(*pb.HostStreamFrame))
	return nil
}

func (s *recordingHostStream) Recv() (*pb.HostStreamFrame, error) { return nil, io.EOF }

func (s *recordingHostStream) SetHeader(metadata.MD) error  { return nil }
func (s *recordingHostStream) SendHeader(metadata.MD) error { return nil }
func (s *recordingHostStream) SetTrailer(metadata.MD)       {}
func (s *recordingHostStream) Context() context.Context     { return s.ctx }
func (s *recordingHostStream) SendMsg(interface{}) error    { return nil }
func (s *recordingHostStream) RecvMsg(interface{}) error    { return nil }
