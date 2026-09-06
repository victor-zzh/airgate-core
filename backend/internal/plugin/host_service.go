package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/DouDOU-start/airgate-core/ent"
	"github.com/DouDOU-start/airgate-core/ent/account"
	"github.com/DouDOU-start/airgate-core/ent/group"
	"github.com/DouDOU-start/airgate-core/ent/setting"
	entusagelog "github.com/DouDOU-start/airgate-core/ent/usagelog"
	"github.com/DouDOU-start/airgate-core/ent/user"
	appreferral "github.com/DouDOU-start/airgate-core/internal/app/referral"
	appusage "github.com/DouDOU-start/airgate-core/internal/app/usage"
	appuser "github.com/DouDOU-start/airgate-core/internal/app/user"
	"github.com/DouDOU-start/airgate-core/internal/auth"
	"github.com/DouDOU-start/airgate-core/internal/billing"
	"github.com/DouDOU-start/airgate-core/internal/routing"
	"github.com/DouDOU-start/airgate-core/internal/scheduler"
	pb "github.com/DouDOU-start/airgate-sdk/protocol/proto"
	sdk "github.com/DouDOU-start/airgate-sdk/sdkgo"
)

// HostService 是 Core 暴露给插件的反向 gRPC 能力的"底层实现"。
//
// 它本身不做插件 capability 校验。真正面向插件的实现是 pluginHostHandle，
// 它在 Invoke / InvokeStream 入口按 method 做 capability 校验，再委托给本结构。
//
// 设计原则（详见 ADR-0001）：
//   - 提供通用平台原语层——新增插件应只组合已有 RPC，无需扩 proto；
//   - ProbeForward 与普通 Forward 严格隔离：跳过 usage_log 写入、跳过余额扣款，
//     但仍然 ReportResult 让账号状态机受益；
//   - Forward 走完整管线（调度 → 网关 → 计费 → 记录），用于操练场等面向用户的插件；
//   - 不要求插件持有 admin_api_key——broker 子进程隧道天然互信，但仍然要做
//     capability 级权限隔离。
type HostService struct {
	db          *ent.Client
	manager     *Manager
	scheduler   *scheduler.Scheduler
	concurrency *scheduler.ConcurrencyManager
	calculator  *billing.Calculator
	recorder    *billing.Recorder
	users       *appuser.Service
	referral    *appreferral.Service
}

// NewHostService 构造 HostService 工厂。
// 由 server 在创建 Manager + scheduler 之后立即创建并 SetHostService 注入到 Manager。
//
// HostService 自身不实现 pb.CoreInvokeServiceServer——用 NewPluginHandle 给每个插件
// 派生一个 pluginHostHandle 才是真正的 server 实例。
func NewHostService(
	db *ent.Client,
	mgr *Manager,
	sched *scheduler.Scheduler,
	concurrency *scheduler.ConcurrencyManager,
	calculator *billing.Calculator,
	recorder *billing.Recorder,
	users *appuser.Service,
	referral *appreferral.Service,
) *HostService {
	return &HostService{
		db:          db,
		manager:     mgr,
		scheduler:   sched,
		concurrency: concurrency,
		calculator:  calculator,
		recorder:    recorder,
		// users.update_balance 复用 app/user 的业务逻辑（流水落库 + 幂等键），
		// 不在 host 层手写余额 SQL；实例由 server 注入（plugin 包不能 import store，会成环）
		users: users,
		// users.notify_topup 的处理方：分销返利等「充值入账后动作」在 app/referral 闭环
		referral: referral,
	}
}

// NewPluginHandle 为指定插件派生一个 host handle。
//
// 调用流程：
//  1. Manager 在 spawn 插件之前调本方法创建一个 handle，初始 capability = nil（拒绝所有）
//  2. 把 handle 作为 CoreInvokeImpl 注入 GatewayGRPCPlugin / ExtensionGRPCPlugin / MiddlewareGRPCPlugin
//  3. spawn 完成 → Info() 拿到 capability 列表 → 调 handle.SetCapabilities(...)
//  4. 之后插件调任何 RPC 都会按当前 capability set 过滤
//
// 这个时序窗口意味着：插件的 Init() 阶段**不应该**调 host RPC（capability 还没绑），
// 只能在 Start() 之后用。这是有意为之——Init 应该是同步的、不依赖 core 反向通道。
func (h *HostService) NewPluginHandle(pluginName string) *pluginHostHandle {
	return &pluginHostHandle{base: h, pluginName: pluginName}
}

// ============================================================================
// pluginHostHandle —— 实际暴露给插件的 server，做 capability 校验后委托到 base
// ============================================================================

// pluginHostHandle 是一个 per-plugin 的 CoreInvokeServiceServer。
//
// 持有一个不可变的 base + 一个可变的 capability set（atomic 保护）。每个 RPC 入口先
// requireMethod 再委托。capability set 的写入是 spawn 后由 manager 完成的，写入之后
// 在该插件生命周期内通常不再变（OnConfigUpdate 重新走 Init 时会重新创建 handle）。
type pluginHostHandle struct {
	pb.UnimplementedCoreInvokeServiceServer

	base       *HostService
	pluginName string

	// caps 指针指向一个 map[sdk.Capability]bool。nil = capability 尚未绑定，所有 RPC 都拒绝。
	// 用 atomic.Pointer 是为了让 SetCapabilities 与 RPC 处理并发安全，无需 mutex。
	caps atomic.Pointer[map[sdk.Capability]bool]
}

// SetCapabilities 由 Manager 在 spawn 完成、Info() 拿到 capability 列表后调用。
//
// 空 set（len=0）== 显式声明"什么都不要"，所有 RPC 都被拒。
func (h *pluginHostHandle) SetCapabilities(caps map[sdk.Capability]bool) {
	cloned := make(map[sdk.Capability]bool, len(caps))
	for k, v := range caps {
		cloned[k] = v
	}
	h.caps.Store(&cloned)
}

func (h *pluginHostHandle) requireMethod(method string) error {
	caps := h.caps.Load()
	if caps == nil {
		slog.Warn("host_service_capability_unbound",
			sdk.LogFieldPluginID, h.pluginName, "method", method)
		return status.Errorf(codes.PermissionDenied,
			"plugin %q capabilities are not bound", h.pluginName)
	}
	if (*caps)[sdk.CapabilityHostInvoke] || (*caps)[sdk.CapabilityForHostMethod(method)] {
		return nil
	}
	slog.Warn("host_service_method_denied",
		sdk.LogFieldPluginID, h.pluginName, "method", method)
	return status.Errorf(codes.PermissionDenied,
		"plugin %q lacks host invoke capability for method %q", h.pluginName, method)
}

func (h *pluginHostHandle) Invoke(ctx context.Context, req *pb.HostInvokeRequest) (*pb.HostInvokeResponse, error) {
	if req == nil || req.Method == "" {
		return nil, status.Error(codes.InvalidArgument, "method 不能为空")
	}
	if err := h.requireMethod(req.Method); err != nil {
		return nil, err
	}
	payload, err := h.base.invoke(ctx, h.pluginName, req.Method, req.Payload, req.IdempotencyKey, req.Metadata)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, status.Errorf(codes.Internal, "encode response payload: %v", err)
	}
	return &pb.HostInvokeResponse{
		Status:   "ok",
		Payload:  encoded,
		Metadata: map[string]string{"method": req.Method},
	}, nil
}

func (h *pluginHostHandle) InvokeStream(stream pb.CoreInvokeService_InvokeStreamServer) error {
	first, err := stream.Recv()
	if err != nil {
		return err
	}
	if first.Method == "" {
		return status.Error(codes.InvalidArgument, "stream 首帧 method 不能为空")
	}
	if err := h.requireMethod(first.Method); err != nil {
		return err
	}
	return h.base.invokeStream(stream.Context(), h.pluginName, first, stream)
}

const (
	hostMethodSchedulerSelectAccount = "scheduler.select_account"
	hostMethodSchedulerReportResult  = "scheduler.report_account_result"
	hostMethodProbeForward           = "probe.forward"
	hostMethodGroupsList             = "groups.list"
	hostMethodGatewayForward         = "gateway.forward"
	hostMethodPlatformsList          = "platforms.list"
	hostMethodModelsList             = "models.list"
	hostMethodModelsCatalog          = "models.catalog"
	hostMethodModelsRefresh          = "models.refresh"
	hostMethodUsersGet               = "users.get"
	hostMethodBillingBudget          = "billing.budget"
	hostMethodUsersUpdateBalance     = "users.update_balance"
	hostMethodUsageRecord            = "usage.record"
	hostMethodUsersNotifyTopup       = "users.notify_topup"
	hostMethodAssetsStore            = "assets.store"
	hostMethodAssetsStoreURL         = "assets.store_url"
	hostMethodAssetsGetURL           = "assets.get_url"
	hostMethodAssetsGetBytes         = "assets.get_bytes"
	hostMethodAssetsDelete           = "assets.delete"
	hostMethodRelaySignURL           = "relay.sign_url"
	hostMethodTasksCreate            = "tasks.create"
	hostMethodTasksUpdate            = "tasks.update"
	hostMethodTasksGet               = "tasks.get"
	hostMethodTasksList              = "tasks.list"
	hostMethodTasksDelete            = "tasks.delete"
)

func (h *HostService) invoke(
	ctx context.Context,
	pluginID, method string,
	payload []byte,
	idempotencyKey string,
	metadata map[string]string,
) (map[string]interface{}, error) {
	_ = metadata
	switch method {
	case hostMethodSchedulerSelectAccount:
		var req hostSelectAccountRequest
		if err := decodeHostPayload(payload, &req); err != nil {
			return nil, err
		}
		return h.selectAccount(ctx, req)
	case hostMethodSchedulerReportResult:
		var req hostReportAccountResultRequest
		if err := decodeHostPayload(payload, &req); err != nil {
			return nil, err
		}
		return h.reportAccountResult(ctx, req)
	case hostMethodProbeForward:
		var req hostProbeForwardRequest
		if err := decodeHostPayload(payload, &req); err != nil {
			return nil, err
		}
		return h.probeForward(ctx, req)
	case hostMethodGroupsList:
		var req hostListGroupsRequest
		if err := decodeHostPayload(payload, &req); err != nil {
			return nil, err
		}
		return h.listGroups(ctx, req)
	case hostMethodGatewayForward:
		var req hostForwardRequest
		if err := decodeHostPayload(payload, &req); err != nil {
			return nil, err
		}
		return h.forward(ctx, req)
	case hostMethodPlatformsList:
		return h.listPlatforms(ctx)
	case hostMethodModelsList:
		var req hostListModelsRequest
		if err := decodeHostPayload(payload, &req); err != nil {
			return nil, err
		}
		return h.listModels(ctx, req)
	case hostMethodModelsCatalog:
		var req hostModelsCatalogRequest
		if err := decodeHostPayload(payload, &req); err != nil {
			return nil, err
		}
		return h.getModelsCatalog(ctx, req)
	case hostMethodModelsRefresh:
		var req hostModelsRefreshRequest
		if err := decodeHostPayload(payload, &req); err != nil {
			return nil, err
		}
		return h.refreshModels(pluginID, req)
	case hostMethodUsersGet:
		var req hostGetUserInfoRequest
		if err := decodeHostPayload(payload, &req); err != nil {
			return nil, err
		}
		return h.getUserInfo(ctx, req)
	case hostMethodBillingBudget:
		var req hostBillingBudgetRequest
		if err := decodeHostPayload(payload, &req); err != nil {
			return nil, err
		}
		return h.billingBudget(ctx, req)
	case hostMethodUsersUpdateBalance:
		var req hostUpdateBalanceRequest
		if err := decodeHostPayload(payload, &req); err != nil {
			return nil, err
		}
		if idempotencyKey != "" && req.IdempotencyKey == "" {
			req.IdempotencyKey = idempotencyKey
		}
		return h.updateUserBalance(ctx, pluginID, req)
	case hostMethodUsageRecord:
		var req hostRecordUsageRequest
		if err := decodeHostPayload(payload, &req); err != nil {
			return nil, err
		}
		if idempotencyKey != "" && req.IdempotencyKey == "" {
			req.IdempotencyKey = idempotencyKey
		}
		return h.recordUsage(ctx, pluginID, req)
	case hostMethodUsersNotifyTopup:
		var req hostNotifyTopupRequest
		if err := decodeHostPayload(payload, &req); err != nil {
			return nil, err
		}
		return h.notifyTopup(ctx, pluginID, req)
	case hostMethodAssetsStore:
		var req hostStoreAssetRequest
		if err := decodeHostPayload(payload, &req); err != nil {
			return nil, err
		}
		return h.storeAsset(ctx, req)
	case hostMethodAssetsStoreURL:
		var req hostStoreAssetFromURLRequest
		if err := decodeHostPayload(payload, &req); err != nil {
			return nil, err
		}
		return h.storeAssetFromURL(ctx, req)
	case hostMethodAssetsGetURL:
		var req hostGetAssetURLRequest
		if err := decodeHostPayload(payload, &req); err != nil {
			return nil, err
		}
		return h.getAssetURL(ctx, req)
	case hostMethodAssetsGetBytes:
		var req hostGetAssetBytesRequest
		if err := decodeHostPayload(payload, &req); err != nil {
			return nil, err
		}
		return h.getAssetBytes(ctx, req)
	case hostMethodAssetsDelete:
		var req hostDeleteAssetRequest
		if err := decodeHostPayload(payload, &req); err != nil {
			return nil, err
		}
		return h.deleteAsset(ctx, req)
	case hostMethodRelaySignURL:
		var req hostRelaySignURLRequest
		if err := decodeHostPayload(payload, &req); err != nil {
			return nil, err
		}
		return h.signRelayURL(pluginID, req)
	case hostMethodTasksCreate:
		var req hostCreateTaskRequest
		if err := decodeHostPayload(payload, &req); err != nil {
			return nil, err
		}
		if idempotencyKey != "" && req.IdempotencyKey == "" {
			req.IdempotencyKey = idempotencyKey
		}
		return h.createTask(ctx, pluginID, req)
	case hostMethodTasksUpdate:
		var req hostUpdateTaskRequest
		if err := decodeHostPayload(payload, &req); err != nil {
			return nil, err
		}
		return h.updateTask(ctx, pluginID, req)
	case hostMethodTasksGet:
		var req hostGetTaskRequest
		if err := decodeHostPayload(payload, &req); err != nil {
			return nil, err
		}
		return h.getTask(ctx, pluginID, req)
	case hostMethodTasksList:
		var req hostListTasksRequest
		if err := decodeHostPayload(payload, &req); err != nil {
			return nil, err
		}
		return h.listTasks(ctx, pluginID, req)
	case hostMethodTasksDelete:
		var req hostDeleteTaskRequest
		if err := decodeHostPayload(payload, &req); err != nil {
			return nil, err
		}
		return h.deleteTask(ctx, pluginID, req)
	default:
		return nil, status.Errorf(codes.Unimplemented, "unknown host method: %s", method)
	}
}

func (h *HostService) invokeStream(
	ctx context.Context,
	pluginID string,
	first *pb.HostStreamFrame,
	stream pb.CoreInvokeService_InvokeStreamServer,
) error {
	_ = pluginID
	switch first.Method {
	case hostMethodGatewayForward:
		var req hostForwardRequest
		if err := decodeHostPayload(first.Payload, &req); err != nil {
			return err
		}
		req.Stream = true
		return h.forwardStream(ctx, req, stream)
	default:
		return status.Errorf(codes.Unimplemented, "unknown host stream method: %s", first.Method)
	}
}

func decodeHostPayload(payload []byte, out interface{}) error {
	if len(payload) == 0 {
		return nil
	}
	if err := json.Unmarshal(payload, out); err != nil {
		return status.Errorf(codes.InvalidArgument, "invalid payload JSON: %v", err)
	}
	return nil
}

type hostSelectAccountRequest struct {
	GroupID           int64   `json:"group_id"`
	Model             string  `json:"model"`
	SessionID         string  `json:"session_id"`
	ExcludeAccountIDs []int64 `json:"exclude_account_ids"`
}

type hostReportAccountResultRequest struct {
	AccountID int64  `json:"account_id"`
	Success   bool   `json:"success"`
	ErrorMsg  string `json:"error_msg"`
}

type hostProbeForwardRequest struct {
	GroupID int64  `json:"group_id"`
	Model   string `json:"model"`
}

type hostForwardRequest struct {
	UserID    int64                  `json:"user_id"`
	GroupID   int64                  `json:"group_id"`
	APIKeyID  int64                  `json:"api_key_id,omitempty"`
	RequestID string                 `json:"request_id,omitempty"`
	TraceID   string                 `json:"trace_id,omitempty"`
	Model     string                 `json:"model"`
	Method    string                 `json:"method"`
	Path      string                 `json:"path"`
	Headers   map[string]interface{} `json:"headers"`
	Body      interface{}            `json:"body"`
	Stream    bool                   `json:"stream"`

	// AccountID >0 时钉选指定上游账号：跳过调度与 failover，直接用该账号转发。
	// 供异步任务型平台（提交任务后必须回到同一账号查询/取产物）使用；
	// 要求同时显式传 group_id（计费倍率归属必须确定），且账号须属于该分组。
	// 仅非流式 forward 支持；判决/计费/账号状态机管线与普通转发一致。
	AccountID int64 `json:"account_id,omitempty"`

	// TaskID >0 时把本次提交与一行 tasks 关联：过闸后 core 把换算好的用户价写进
	// tasks.estimated_cost——那一行就是「在途预留」，下一次提交据此累加。
	TaskID int64 `json:"task_id,omitempty"`

	// EstimatedOfficialCost 是插件按自身价目表算出的**官方基准价 USD（倍率前）**。
	// >0 且为新提交（AccountID==0）时触发预算门禁：倍率换算与判定都在 core 做，
	// 插件不掌握用户的分组倍率，算不出用户价。
	EstimatedOfficialCost float64 `json:"estimated_official_cost,omitempty"`

	// 以下由 core 在入口解析（resolveHostForwardIdentity），不接受插件传入：
	// 调用方 user_id 若是团队成员账号，UserID 已被改写为企业主（付费身份），
	// memberID 记成员归属，memberAllowedGroups 为成员分组白名单（空=不限），
	// member 留着算本期剩余额度。
	// submitterID 是**改写前**的原始调用账号：任务行的 user_id 记的是提交人本人，
	// 在途预留必须按它统计，按企业主查一条都查不到。
	memberID            int
	memberAllowedGroups []int64
	member              *ent.Member
	submitterID         int
}

// resolveHostForwardIdentity 把成员账号发起的 Host 转发映射到付费身份：
// 余额 / 分组资格 / 计价 / usage_logs.user 全部按企业主，member_id 记该成员；
// 成员停用拒绝，成员本期额度用尽按余额不足处理。非成员账号原样返回。
func (h *HostService) resolveHostForwardIdentity(ctx context.Context, req *hostForwardRequest) error {
	identity, err := auth.ResolveTeamIdentity(ctx, h.db, int(req.UserID))
	if err != nil {
		if cerr := hostContextError(err); cerr != nil {
			return cerr
		}
		slog.Error("host_forward_team_identity_failed", sdk.LogFieldUserID, req.UserID, sdk.LogFieldError, err)
		return hostForwardGenericError()
	}
	if !identity.IsMember() {
		return nil
	}
	gate, err := auth.EvaluateMemberGate(ctx, h.db, identity.Member, time.Now())
	if err != nil {
		return status.Error(codes.PermissionDenied, err.Error())
	}
	if gate.Exhausted() {
		return hostForwardInsufficientQuotaError()
	}
	if req.GroupID > 0 && !identity.AllowsGroup(int(req.GroupID)) {
		slog.Warn("host_forward_member_group_forbidden",
			sdk.LogFieldUserID, req.UserID, "member_id", identity.Member.ID, sdk.LogFieldGroupID, req.GroupID)
		return status.Error(codes.PermissionDenied, auth.ErrMemberGroupForbidden.Error())
	}
	req.memberID = identity.Member.ID
	req.memberAllowedGroups = identity.Member.AllowedGroupIds
	req.member = identity.Member
	req.UserID = int64(identity.Owner.ID)
	return nil
}

// filterCandidatesByMemberGroups 成员分组白名单非空时只保留其中的候选分组。
func filterCandidatesByMemberGroups(candidates []routing.Candidate, allowed []int64) []routing.Candidate {
	if len(allowed) == 0 {
		return candidates
	}
	out := make([]routing.Candidate, 0, len(candidates))
	for _, c := range candidates {
		if auth.MemberAllowsGroup(allowed, c.GroupID) {
			out = append(out, c)
		}
	}
	return out
}

// hostRelaySignURLRequest relay.sign_url 的入参。
type hostRelaySignURLRequest struct {
	Ref        string `json:"ref"`
	TTLSeconds int64  `json:"ttl_seconds"`
	Filename   string `json:"filename"`
}

type hostListModelsRequest struct {
	Platform string `json:"platform"`
}

type hostModelsCatalogRequest struct {
	Platform string `json:"platform"`
}

type hostGetUserInfoRequest struct {
	UserID int64 `json:"user_id"`
}

type hostStoreAssetRequest struct {
	UserID        int64  `json:"user_id"`
	Purpose       string `json:"purpose"` // core 枚举：chat/upload/generated/task-input/temp
	ContentType   string `json:"content_type"`
	FileExtension string `json:"file_extension"`
	Data          []byte `json:"data"`
}

type hostStoreAssetFromURLRequest struct {
	UserID    int64  `json:"user_id"`
	Purpose   string `json:"purpose"` // core 枚举：chat/upload/generated/task-input/temp
	SourceURL string `json:"source_url"`
}

type hostGetAssetURLRequest struct {
	ObjectKey string `json:"object_key"`
}

type hostGetAssetBytesRequest struct {
	ObjectKey string `json:"object_key"`
}

type hostDeleteAssetRequest struct {
	ObjectKey string `json:"object_key"`
}

type hostCreateTaskRequest struct {
	PluginID       string                 `json:"plugin_id"`
	TaskType       string                 `json:"task_type"`
	UserID         int64                  `json:"user_id"`
	Input          map[string]interface{} `json:"input"`
	Attributes     map[string]interface{} `json:"attributes"`
	Execution      map[string]interface{} `json:"execution"`
	Priority       int                    `json:"priority"`
	MaxAttempts    int                    `json:"max_attempts"`
	PublicTaskID   string                 `json:"public_task_id"`
	IdempotencyKey string                 `json:"idempotency_key"`
}

type hostUpdateTaskRequest struct {
	TaskID       int64                  `json:"task_id"`
	Status       string                 `json:"status"`
	Progress     *int                   `json:"progress"`
	Stage        *string                `json:"stage"`
	Output       map[string]interface{} `json:"output"`
	Attributes   map[string]interface{} `json:"attributes"`
	Execution    map[string]interface{} `json:"execution"`
	ErrorType    string                 `json:"error_type"`
	ErrorCode    string                 `json:"error_code"`
	ErrorMessage string                 `json:"error_message"`
	UsageID      *int                   `json:"usage_id"`
	// EstimatedCost 允许插件在拿到更准的信息后（如上游回了实际时长/分辨率）改写预估。
	// 非终态任务的这个值就是在途预留，改小 = 释放，改大 = 多占。
	EstimatedCost *float64 `json:"estimated_cost"`
}

type hostGetTaskRequest struct {
	PluginID string `json:"plugin_id"`
	// PluginIDs 非空时按 IN 过滤（与 PluginID 二选一，PluginIDs 优先），形状与
	// hostListTasksRequest 一致。供聚合型插件（studio 同时消费六个执行插件的任务）
	// 一次命中，而不是逐插件试探——试探的每一次未命中都会在 core 与 SDK 两侧
	// 落 ERROR 日志（2026-09-04 生产实测单日 1.7 万条），淹没真实错误。
	PluginIDs    []string `json:"plugin_ids"`
	TaskID       int64    `json:"task_id"`
	PublicTaskID string   `json:"public_task_id"`
	UserID       int64    `json:"user_id"`
}

type hostListTasksRequest struct {
	PluginID string `json:"plugin_id"`
	// PluginIDs 非空时按 IN 过滤（与 PluginID 二选一，PluginIDs 优先）。
	// 供聚合型插件（如 studio 同时消费 gateway-openai/gateway-gemini 的任务）
	// 在保持分页正确的前提下限定可见范围，避免捞到其他插件的任务。
	PluginIDs []string `json:"plugin_ids"`
	UserID    int64    `json:"user_id"`
	TaskType  string   `json:"task_type"`
	Status    string   `json:"status"`
	Limit     int      `json:"limit"`
	Offset    int      `json:"offset"`
}

type hostDeleteTaskRequest struct {
	PluginID string `json:"plugin_id"`
	TaskID   int64  `json:"task_id"`
	UserID   int64  `json:"user_id"`
}

// selectAccount 调度选号：走和真实用户请求完全相同的路径。
func (h *HostService) selectAccount(ctx context.Context, req hostSelectAccountRequest) (map[string]interface{}, error) {
	if req.GroupID <= 0 {
		return nil, status.Error(codes.InvalidArgument, "group_id 必须 > 0")
	}
	g, err := h.db.Group.Get(ctx, int(req.GroupID))
	if err != nil {
		if cerr := hostContextError(err); cerr != nil {
			return nil, cerr
		}
		if ent.IsNotFound(err) {
			return nil, status.Error(codes.NotFound, "分组不存在")
		}
		return nil, status.Error(codes.Internal, err.Error())
	}

	model := req.Model
	if model == "" {
		model = pickRoutableModel(h.manager.GetModels(g.Platform), g.ModelRouting)
	}

	excludeIDs := make([]int, 0, len(req.ExcludeAccountIDs))
	for _, id := range req.ExcludeAccountIDs {
		excludeIDs = append(excludeIDs, int(id))
	}

	acc, err := h.scheduler.SelectAccount(ctx, g.Platform, model, 0, int(req.GroupID), req.SessionID, excludeIDs...)
	if err != nil {
		if cerr := hostContextError(err); cerr != nil {
			return nil, cerr
		}
		// scheduler 自身的"无可用账户"是业务可预期错误，用 NotFound 让插件区分
		if errors.Is(err, scheduler.ErrNoAvailableAccount) {
			return nil, status.Error(codes.NotFound, err.Error())
		}
		return nil, status.Error(codes.Internal, err.Error())
	}
	return map[string]interface{}{
		"account_id":   int64(acc.ID),
		"account_name": acc.Name,
		"platform":     acc.Platform,
	}, nil
}

// probeForward 黑盒探测：自动调度 + 直接执行 + 反馈状态机。
// 内部 worker，由 pluginHostHandle.ProbeForward 在 capability 校验后调用。
//
// 与普通 forwarder 的区别：
//   - 不写 usage_log（recorder 完全不参与）
//   - 不扣用户余额
//   - 不消耗用户配额
//   - 不走 RPM/并发/window-cost 限流（探测请求不应被限流挡掉，否则失去意义）
//   - 仍然 scheduler.ReportResult，让真实流量和探测共同驱动账号状态机
//
// 失败语义：所有错误都不通过 gRPC error 返回，而是写入 response.error_kind/msg。
// 调用方（探测插件）需要把 error_kind 持久化到自己的 group_health_probes 表。
func (h *HostService) probeForward(ctx context.Context, req hostProbeForwardRequest) (map[string]interface{}, error) {
	start := time.Now()
	resp := map[string]interface{}{}

	if req.GroupID <= 0 {
		return errProbeResp("invalid_arg", "group_id 必须 > 0", start), nil
	}

	g, err := h.db.Group.Get(ctx, int(req.GroupID))
	if err != nil {
		if cerr := hostContextError(err); cerr != nil {
			return nil, cerr
		}
		if ent.IsNotFound(err) {
			return errProbeResp("group_not_found", err.Error(), start), nil
		}
		return errProbeResp("internal", err.Error(), start), nil
	}
	resp["platform"] = g.Platform

	model := req.Model
	probeImage := false
	if model == "" {
		if models := h.manager.GetModels(g.Platform); len(models) > 0 {
			model, probeImage = pickProbeModelForRouting(models, g.ModelRouting)
		}
	}
	if model == "" {
		return errProbeResp("no_model", fmt.Sprintf("platform %s 没有可用 model", g.Platform), start), nil
	}
	resp["model"] = model
	if probeImage {
		resp["probe_kind"] = "image"
	} else {
		resp["probe_kind"] = "chat"
	}

	// 调度选号。probe token 只用于本次真实上游探测，避免 half-open 被只读遍历抢占。
	probeToken := uuid.NewString()
	selectionCtx := scheduler.WithFamilyProbeToken(ctx, probeToken)
	acc, err := h.scheduler.SelectAccount(selectionCtx, g.Platform, model, 0, int(req.GroupID), "")
	if err != nil {
		if cerr := hostContextError(err); cerr != nil {
			return nil, cerr
		}
		return errProbeResp("no_account", err.Error(), start), nil
	}
	resp["account_id"] = int64(acc.ID)

	// 加载完整账号 + proxy
	accFull, err := h.db.Account.Query().
		Where(account.IDEQ(acc.ID)).
		WithProxy().
		Only(ctx)
	if err != nil {
		h.releaseHostFamilyProbe(acc.ID, acc.Platform, model, probeToken)
		if cerr := hostContextError(err); cerr != nil {
			return nil, cerr
		}
		return errProbeResp("internal", "加载账号失败: "+err.Error(), start), nil
	}

	inst := h.manager.GetPluginByPlatform(g.Platform)
	if inst == nil || inst.Gateway == nil {
		h.releaseHostFamilyProbe(acc.ID, acc.Platform, model, probeToken)
		return errProbeResp("plugin_missing", "platform "+g.Platform+" 没有可用插件", start), nil
	}

	// 构造最小探测请求。chat：固定 prompt "hi"，max_tokens=5，成本近乎为零。
	// image：最小 1K 单图（生图模型没有更便宜的探法；调用方按成本节流频率）。
	var body []byte
	headers := http.Header{
		"Content-Type":       {"application/json"},
		"X-Airgate-Internal": {"probe"},
	}
	probeTimeout := 30 * time.Second
	if probeImage {
		body, _ = json.Marshal(map[string]any{
			"model":  model,
			"prompt": "a single small red dot, plain white background",
			"n":      1,
			"size":   "1024x1024",
		})
		headers.Set("X-Forwarded-Path", "/v1/images/generations")
		// 生图普遍 10~40s，30s 会把健康的组误判成超时。
		probeTimeout = 90 * time.Second
	} else {
		body, _ = json.Marshal(map[string]any{
			"model":      model,
			"messages":   []map[string]string{{"role": "user", "content": "hi"}},
			"stream":     false,
			"max_tokens": 5,
		})
	}

	fwdReq := &sdk.ForwardRequest{
		Account: &sdk.Account{
			ID:          int64(accFull.ID),
			Name:        accFull.Name,
			Platform:    accFull.Platform,
			Type:        accFull.Type,
			Credentials: cloneStringMapHost(accFull.Credentials),
			ProxyURL:    proxyURLFromAccount(accFull),
		},
		Body:    body,
		Headers: headers,
		Model:   model,
		Stream:  false,
	}

	// 调用插件并限时（探测不应卡住调度循环）
	fwdCtx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()

	gate, err := h.scheduler.ClaimAccountGate(fwdCtx, acc.ID, acc.Platform, model, probeToken)
	if err != nil {
		h.releaseHostFamilyProbe(acc.ID, acc.Platform, model, probeToken)
		if cerr := hostContextError(err); cerr != nil {
			return nil, cerr
		}
		return errProbeResp("internal", "账号准入检查失败: "+err.Error(), start), nil
	}
	if !gate.Allowed() {
		h.releaseHostFamilyProbe(acc.ID, acc.Platform, model, probeToken)
		return errProbeResp("no_account", "账号当前不可用: "+string(gate.Reason), start), nil
	}
	stopProbeLease := func() {}
	if gate.ProbeClaimed {
		stopProbeLease = h.scheduler.MaintainFamilyProbe(fwdCtx, acc.ID, acc.Platform, model, probeToken)
	}
	outcome, fwdErr := inst.Gateway.Forward(fwdCtx, fwdReq)
	stopProbeLease()
	h.persistHostUpdatedCredentials(acc.ID, outcome.UpdatedCredentials)
	latency := time.Since(start)
	resp["latency_ms"] = latency.Milliseconds()
	resp["status_code"] = int64(outcome.Upstream.StatusCode)

	if cerr := hostForwardContextError(fwdCtx, fwdErr); cerr != nil {
		h.releaseHostFamilyProbe(acc.ID, acc.Platform, model, probeToken)
		return nil, cerr
	}

	// 插件自身故障（进程异常等）—— 不经过状态机，仅记录。
	if fwdErr != nil {
		h.releaseHostFamilyProbe(acc.ID, acc.Platform, model, probeToken)
		resp["success"] = false
		resp["error_kind"] = "plugin_error"
		resp["error_msg"] = truncateProbeErr(fwdErr.Error())
		return resp, nil
	}

	// 探测成功时通知状态机，让降级账号有机会恢复；探测失败时不触发降级，
	// 避免探测模型不可用（如上游缺通道）误伤整个账号的可调度性。
	// 失败信号由 health 插件自行记录到 group_health_probes，不经过账号状态机。
	if outcome.Kind.IsSuccess() {
		if !h.applyHostOutcome(fwdCtx, acc.ID, accFull, model, outcome, latency, probeToken, nil, false) {
			return nil, hostForwardContextError(fwdCtx, nil)
		}
	} else {
		h.releaseHostFamilyProbe(acc.ID, acc.Platform, model, probeToken)
	}

	switch outcome.Kind {
	case sdk.OutcomeSuccess:
		resp["success"] = true
	case sdk.OutcomeAccountRateLimited:
		resp["success"] = false
		resp["error_kind"] = "rate_limited"
		resp["error_msg"] = truncateProbeErr(outcome.Reason)
	case sdk.OutcomeAccountDead:
		resp["success"] = false
		resp["error_kind"] = "account_error"
		resp["error_msg"] = truncateProbeErr(outcome.Reason)
	case sdk.OutcomeUpstreamTransient, sdk.OutcomeStreamAborted:
		resp["success"] = false
		resp["error_kind"] = "upstream_5xx"
		resp["error_msg"] = truncateProbeErr(outcome.Reason)
	case sdk.OutcomeClientError:
		resp["success"] = false
		resp["error_kind"] = "client_error"
		resp["error_msg"] = truncateProbeErr(outcome.Reason)
	default:
		resp["success"] = false
		resp["error_kind"] = "unknown"
		resp["error_msg"] = truncateProbeErr(outcome.Reason)
	}
	return resp, nil
}

// hostListGroupsRequest groups.list 的可选过滤参数。
// 空 payload（旧调用方）等价于"列出全部分组"，保持向后兼容。
type hostListGroupsRequest struct {
	// PublicOnly=true 时按状态页可见性过滤：仅返回 status_visible=true 的分组；
	// 若同时传 UserID>0，追加该用户在 user_allowed_groups 里被授权的专属分组。
	// 可见性/授权判断留在 core——插件不应自行查 core 表实现这类过滤。
	PublicOnly bool  `json:"public_only"`
	UserID     int64 `json:"user_id"`
	// EligibleOnly=true 时按转发资格过滤（需同时传 UserID>0 与 Platform）：
	// 复用 routing.ListEligibleGroups 的语义（专属分组授权、image_enabled 等
	// 能力门禁），返回项附带该用户的 effective_rate，按最便宜优先排序——
	// 与 gateway.forward 未显式指定 group_id 时的自动选组顺序一致。
	// 供插件向终端用户展示"本次调用可选哪些分组"。
	EligibleOnly bool   `json:"eligible_only"`
	Platform     string `json:"platform"`
	NeedsImage   bool   `json:"needs_image"`
	Model        string `json:"model"`
}

// listGroups 列出分组（默认全部；支持状态页可见性 / 用户转发资格过滤）。
func (h *HostService) listGroups(ctx context.Context, req hostListGroupsRequest) (map[string]interface{}, error) {
	slog.Debug("host_service_list_groups", "module", "host",
		"public_only", req.PublicOnly, "user_id", req.UserID,
		"eligible_only", req.EligibleOnly, sdk.LogFieldPlatform, req.Platform)
	if req.EligibleOnly {
		return h.listEligibleGroups(ctx, req)
	}
	q := h.db.Group.Query()
	// 成员账号：可见性/授权/报价口径都按企业主；白名单非空时只露出其中的分组。
	var memberAllowed []int64
	if req.UserID > 0 {
		billingUserID, allowed, err := h.resolveHostBillingUser(ctx, int(req.UserID))
		if err != nil {
			return nil, err
		}
		req.UserID = int64(billingUserID)
		memberAllowed = allowed
	}
	if req.PublicOnly {
		// Public group discovery must follow the same lifecycle rule as the
		// user-facing /groups endpoint: delisted groups remain visible to
		// administrators through the unfiltered path, but never to users.
		q = q.Where(group.DelistedEQ(false))
		if req.UserID > 0 {
			q = q.Where(group.Or(
				group.StatusVisible(true),
				group.HasAllowedUsersWith(user.ID(int(req.UserID))),
			))
		} else {
			q = q.Where(group.StatusVisible(true))
		}
	}
	if len(memberAllowed) > 0 {
		ids := make([]int, 0, len(memberAllowed))
		for _, id := range memberAllowed {
			ids = append(ids, int(id))
		}
		q = q.Where(group.IDIn(ids...))
	}
	groups, err := q.All(ctx)
	if err != nil {
		if cerr := hostContextError(err); cerr != nil {
			return nil, cerr
		}
		return nil, status.Error(codes.Internal, err.Error())
	}
	// 报价客户（pricing_mode=quote）：插件 UI 也不得看到标准牌价——倍率字段
	// 改写为该用户的有效倍率，与 /models/pricing/me 的裁剪口径一致。
	// 用户不存在按非报价处理（兼容旧调用方传任意 user_id）；其余查询错误向上抛，
	// 避免出错时把标准牌价漏出去。
	var quoteUser *ent.User
	if req.UserID > 0 {
		qu, err := h.db.User.Query().Where(user.IDEQ(int(req.UserID))).Only(ctx)
		switch {
		case err == nil:
			if qu.PricingMode == user.PricingModeQuote {
				quoteUser = qu
			}
		case ent.IsNotFound(err):
			// 保持旧行为：无效 user_id 不影响列表本身
		default:
			if cerr := hostContextError(err); cerr != nil {
				return nil, cerr
			}
			return nil, status.Error(codes.Internal, err.Error())
		}
	}
	items := make([]map[string]interface{}, 0, len(groups))
	for _, g := range groups {
		rateMultiplier := g.RateMultiplier
		if quoteUser != nil {
			rateMultiplier = billing.ResolveBillingRateForGroup(quoteUser.GroupRates, g.ID, g.RateMultiplier)
		}
		item := map[string]interface{}{
			"id":              int64(g.ID),
			"name":            g.Name,
			"name_i18n":       g.NameI18n,
			"platform":        g.Platform,
			"is_exclusive":    g.IsExclusive,
			"rate_multiplier": rateMultiplier,
			"note":            g.Note,
			"note_i18n":       g.NoteI18n,
			"status_visible":  g.StatusVisible,
		}
		if prices := resolvedFixedImagePrices(nil, g.PluginSettings); prices != nil {
			item["fixed_image_prices"] = prices
		}
		items = append(items, item)
	}
	return map[string]interface{}{"groups": items}, nil
}

// listEligibleGroups 按转发资格列出某用户在某平台下可用的分组（groups.list 的
// eligible_only 分支）。资格判定与排序完全复用 routing.ListEligibleGroups，
// 保证展示给用户的候选与自动选组行为一致。
func (h *HostService) listEligibleGroups(ctx context.Context, req hostListGroupsRequest) (map[string]interface{}, error) {
	if req.UserID <= 0 {
		return nil, status.Error(codes.InvalidArgument, "eligible_only 需要 user_id > 0")
	}
	platform := strings.TrimSpace(req.Platform)
	if platform == "" {
		return nil, status.Error(codes.InvalidArgument, "eligible_only 需要 platform")
	}
	// 成员账号：资格与倍率按企业主判定，再按成员分组白名单收敛——与 gateway.forward 一致。
	billingUserID, memberAllowed, err := h.resolveHostBillingUser(ctx, int(req.UserID))
	if err != nil {
		return nil, err
	}
	u, err := h.db.User.Query().Where(user.IDEQ(billingUserID)).Only(ctx)
	if err != nil {
		if cerr := hostContextError(err); cerr != nil {
			return nil, cerr
		}
		if ent.IsNotFound(err) {
			return nil, status.Error(codes.NotFound, "用户不存在")
		}
		return nil, status.Error(codes.Internal, err.Error())
	}
	candidates, err := routing.ListEligibleGroups(ctx, h.db, billingUserID, platform,
		u.GroupRates, u.GroupPluginSettings, routing.Requirements{NeedsImage: req.NeedsImage})
	if err != nil {
		if cerr := hostContextError(err); cerr != nil {
			return nil, cerr
		}
		return nil, status.Error(codes.Internal, err.Error())
	}
	candidates = filterCandidatesByMemberGroups(candidates, memberAllowed)
	ids := make([]int, 0, len(candidates))
	for _, c := range candidates {
		ids = append(ids, c.GroupID)
	}
	byID := make(map[int]*ent.Group, len(ids))
	if len(ids) > 0 {
		groups, err := h.db.Group.Query().Where(group.IDIn(ids...)).All(ctx)
		if err != nil {
			if cerr := hostContextError(err); cerr != nil {
				return nil, cerr
			}
			return nil, status.Error(codes.Internal, err.Error())
		}
		for _, g := range groups {
			byID[g.ID] = g
		}
	}
	items := make([]map[string]interface{}, 0, len(candidates))
	for _, c := range candidates {
		g, ok := byID[c.GroupID]
		if !ok {
			continue
		}
		if strings.TrimSpace(req.Model) != "" && !h.groupHasSchedulableAccountForModel(ctx, c, req.Model, req.NeedsImage) {
			continue
		}
		// 报价客户：标准牌价改写为有效倍率，响应里不存在「标准 vs 专属」差值
		//（与 /models/pricing/me 的裁剪口径一致），插件 UI 无从渲染牌价对比。
		rateMultiplier := g.RateMultiplier
		if u.PricingMode == user.PricingModeQuote {
			rateMultiplier = c.EffectiveRate
		}
		item := map[string]interface{}{
			"id":              int64(g.ID),
			"name":            g.Name,
			"name_i18n":       g.NameI18n,
			"platform":        g.Platform,
			"is_exclusive":    g.IsExclusive,
			"rate_multiplier": rateMultiplier,
			"effective_rate":  c.EffectiveRate,
			"note":            g.Note,
			"note_i18n":       g.NoteI18n,
			"status_visible":  g.StatusVisible,
		}
		if prices := resolvedFixedImagePrices(u.GroupPluginSettings[int64(g.ID)], g.PluginSettings); prices != nil {
			item["fixed_image_prices"] = prices
		}
		items = append(items, item)
	}
	return map[string]interface{}{"groups": items}, nil
}

// resolvedFixedImagePrices 暴露给插件的固定图价白名单投影。计费解析器负责
// 用户覆盖优先级和无效值过滤；绝不透传 group/user plugin_settings。
func resolvedFixedImagePrices(userSettings, groupSettings map[string]map[string]string) map[string]interface{} {
	prices := make(map[string]interface{}, 4)
	for _, tier := range []string{"1k", "2k", "4k"} {
		if price, _, ok := billing.ResolveImageTierPrice(tier, userSettings, groupSettings); ok {
			prices[tier] = price
		}
	}
	if len(prices) == 0 {
		return nil
	}
	// 固定图价沿用站内余额计价口径（人民币）；ToC 美元视图由展示端按站点汇率换算。
	prices["currency"] = "CNY"
	return prices
}

func (h *HostService) groupHasSchedulableAccountForModel(ctx context.Context, c routing.Candidate, model string, needsImage bool) bool {
	if h == nil || h.scheduler == nil {
		return true
	}
	req := scheduler.AccountRequirements{Workload: scheduler.WorkloadChat}
	if needsImage {
		req = scheduler.AccountRequirements{
			Workload: scheduler.WorkloadImage,
			ImageProtocols: []scheduler.ImageProtocol{
				scheduler.ImageProtocolImagesAPI,
				scheduler.ImageProtocolResponsesTool,
			},
		}
	}
	_, err := h.scheduler.SelectAccountWithRequirements(ctx, c.Platform, model, 0, c.GroupID, "", req)
	return err == nil
}

// reportAccountResult 把账号调用结果反馈给 scheduler。
// 内部 worker，由 pluginHostHandle.ReportAccountResult 委托。
//
// success=true 直接走 Apply(OutcomeSuccess)；success=false 按"上游抖动"上报
// （由状态机的滚动窗口计数决定是否升级为 disabled），避免探测插件单次失败
// 就把账号标死。
func (h *HostService) reportAccountResult(ctx context.Context, req hostReportAccountResultRequest) (map[string]interface{}, error) {
	if req.AccountID <= 0 {
		return nil, status.Error(codes.InvalidArgument, "account_id 必须 > 0")
	}
	kind := sdk.OutcomeUpstreamTransient
	if req.Success {
		kind = sdk.OutcomeSuccess
	}
	h.scheduler.Apply(ctx, int(req.AccountID), scheduler.Judgment{
		Kind:   kind,
		Reason: req.ErrorMsg,
	})
	return map[string]interface{}{"ok": true}, nil
}

// forward 非流式业务转发：调度 → 网关 → 计费 → 记录。
// 与 probeForward 的区别：走完整计费管线，不跳过 usage_log / 余额扣款。
// 账号级故障自动 failover，直到当前路由的候选账号耗尽。
func (h *HostService) forward(ctx context.Context, req hostForwardRequest) (map[string]interface{}, error) {
	if req.UserID <= 0 {
		return nil, status.Error(codes.InvalidArgument, "user_id 必须 > 0")
	}
	// 身份解析会把成员账号的 UserID 改写成企业主，原始提交账号先留一份：
	// 在途预留按任务行的 user_id（= 提交人本人）统计。
	req.submitterID = int(req.UserID)
	if err := h.resolveHostForwardIdentity(ctx, &req); err != nil {
		return nil, err
	}
	// 只读元信息路径（如视频价格预估 /v1/video/estimate）不打上游、不计费、不占预留，
	// 对余额与预算门禁一律放行——与转发管线 Forwarder.checkBalance 的口径一致。
	// 否则余额已经见底的用户连"这条要花多少钱"都问不出来，恰恰是最需要提示的人拿不到提示。
	metadataOnly := h.isHostMetadataOnlyPath(req.Path)
	if !metadataOnly {
		if err := h.checkHostForwardBalanceOrReplay(ctx, req); err != nil {
			return nil, err
		}
	}

	if req.AccountID > 0 {
		return h.forwardPinned(ctx, req)
	}

	routes, userEmail, err := h.hostForwardRoutes(ctx, req)
	if err != nil {
		return nil, err
	}
	// 预算预留门禁：只拦带预估的提交（是否带预估由插件决定，钉选路径同样会过一遍
	// 同一个门禁，见 forwardPinned）。元信息路径不带预估，天然 no-op。倍率取首候选
	// ——真正落账的多半就是它，failover 到后面的分组只会更贵/更便宜一档，不值得为了
	// 精确到分而把选号提前到这里。
	if err := h.checkSubmissionBudget(ctx, &req, routes[0].EffectiveRate); err != nil {
		return nil, err
	}
	fwdCtx, cancel := context.WithTimeout(ctx, hostForwardTimeout(h.manager, req))
	defer cancel()

	hardExclude := make([]int, 0, len(routes))
	var lastUpstream sdk.UpstreamResponse
	hasLastUpstream := false
	// 回放上游 4xx 体时要按「当时那个账号」剥供应商标识，账号在循环外已不可见，随快照一起捕获。
	var lastUpstreamScrubber *identityScrubber
	// 与 Forwarder 一致：4xx 判决也换号重试；穷尽后优先回放最后一次客户端错误
	// 响应（而不是中途某次 5xx 的响应体），真实错误信息必须完整到达调用方。
	var lastClientUpstream sdk.UpstreamResponse
	hasLastClientUpstream := false
	var lastClientUpstreamScrubber *identityScrubber
	failureSummary := allRoutesFailureSummary{}
	for _, route := range routes {
		model := h.resolveHostModel(route.Platform, req.Model)
		if model == "" {
			slog.Warn("host_forward_no_model",
				sdk.LogFieldPlatform, route.Platform, sdk.LogFieldGroupID, route.GroupID)
			continue
		}
		inst := h.manager.GetPluginByPlatform(route.Platform)
		if inst == nil || inst.Gateway == nil {
			slog.Warn("host_forward_no_plugin",
				sdk.LogFieldPlatform, route.Platform, sdk.LogFieldGroupID, route.GroupID)
			continue
		}

		softExclude := make([]int, 0, 8)
		attempt := 0
		queueDeadline := time.Now().Add(hostForwardCapacityWaitTimeout)
		queuePollDelay := hostForwardCapacityPollInterval
		waitingForLocalCapacity := false
		for {
			exclude := make([]int, 0, len(hardExclude)+len(softExclude))
			exclude = append(exclude, hardExclude...)
			exclude = append(exclude, softExclude...)
			probeToken := uuid.NewString()
			selectionCtx := scheduler.WithFamilyProbeToken(fwdCtx, probeToken)
			acc, err := h.scheduler.SelectAccountWithRequirements(selectionCtx, route.Platform, model, 0, route.GroupID, "", hostAccountRequirements(h.manager, req), exclude...)
			if err != nil {
				if cerr := hostContextError(err); cerr != nil {
					return nil, cerr
				}
				failureSummary.recordPickAccountErrorAfterExclusions(err, len(exclude) > 0)
				localSoftExcluded := waitingForLocalCapacity && len(softExclude) > 0
				if shouldWaitForLocalCapacity(err, localSoftExcluded) {
					softExclude = softExclude[:0]
					if waitForHostCapacity(ctx, queueDeadline, &queuePollDelay) {
						continue
					}
					if cerr := hostContextError(ctx.Err()); cerr != nil {
						return nil, cerr
					}
				}
				slog.Warn("host_forward_pick_account_failed",
					sdk.LogFieldPlatform, route.Platform,
					sdk.LogFieldModel, model,
					sdk.LogFieldGroupID, route.GroupID,
					"effective_rate", route.EffectiveRate,
					sdk.LogFieldError, err,
				)
				break
			}

			accFull, err := h.db.Account.Query().Where(account.IDEQ(acc.ID)).WithProxy().Only(ctx)
			if err != nil {
				h.releaseHostFamilyProbe(acc.ID, acc.Platform, model, probeToken)
				if cerr := hostContextError(err); cerr != nil {
					return nil, cerr
				}
				slog.Error("host_forward_account_load_failed",
					sdk.LogFieldAccountID, acc.ID, sdk.LogFieldError, err)
				return nil, hostForwardGenericError()
			}

			releaseAccountSlot, ok := h.acquireHostAccountSlot(ctx, accFull)
			if !ok {
				h.releaseHostFamilyProbe(acc.ID, acc.Platform, model, probeToken)
				failureSummary.recordLocalCapacityFailure()
				waitingForLocalCapacity = true
				softExclude = append(softExclude, acc.ID)
				continue
			}
			waitingForLocalCapacity = false
			queuePollDelay = hostForwardCapacityPollInterval
			gate, gateErr := h.scheduler.ClaimAccountGate(fwdCtx, acc.ID, acc.Platform, model, probeToken)
			if gateErr != nil || !gate.Allowed() {
				releaseAccountSlot()
				h.scheduler.DecrementRPM(context.Background(), acc.ID)
				h.releaseHostFamilyProbe(acc.ID, acc.Platform, model, probeToken)
				if gateErr != nil {
					failureSummary.recordPickAccountError(gateErr)
				} else {
					failureSummary.recordAccountGateDecision(gate)
				}
				hardExclude = append(hardExclude, acc.ID)
				slog.Warn("host_forward_account_gate_rejected",
					sdk.LogFieldAccountID, acc.ID,
					"reason", gate.Reason,
					sdk.LogFieldError, gateErr,
				)
				continue
			}

			headers := hostForwardHeaders(req, route)
			applyAccountCapabilityHeaders(headers, accFull)
			fwdReq := &sdk.ForwardRequest{
				Account: hostSDKAccount(accFull),
				Body:    hostForwardBody(req.Body),
				Headers: headers,
				Model:   model,
				Stream:  false,
			}

			start := time.Now()
			stopProbeLease := func() {}
			if gate.ProbeClaimed {
				stopProbeLease = h.scheduler.MaintainFamilyProbe(fwdCtx, acc.ID, acc.Platform, model, probeToken)
			}
			outcome, fwdErr := inst.Gateway.Forward(fwdCtx, fwdReq)
			stopProbeLease()
			h.persistHostUpdatedCredentials(acc.ID, outcome.UpdatedCredentials)
			attempt++
			duration := time.Since(start)
			releaseAccountSlot()
			if !h.applyHostOutcome(fwdCtx, acc.ID, accFull, model, outcome, duration, probeToken, fwdErr, true) {
				h.recordCanceledHostForwardUsage(req, route, acc.ID, route.Platform, model, accFull, userEmail, outcome, duration, hostCanceledRequestStatus(fwdCtx, fwdErr))
				return nil, hostForwardContextError(fwdCtx, fwdErr)
			}
			if returnableUpstream(outcome.Upstream) {
				lastUpstream = outcome.Upstream
				hasLastUpstream = true
				lastUpstreamScrubber = newIdentityScrubber(accFull, model)
			}
			if cerr := hostForwardContextError(fwdCtx, fwdErr); cerr != nil {
				return nil, cerr
			}

			replayableClient := outcome.Kind == sdk.OutcomeClientError && replayableClientError(outcome)
			if fwdErr != nil || outcome.Kind.ShouldFailover() || replayableClient {
				if replayableClient && returnableUpstream(outcome.Upstream) {
					lastClientUpstream = outcome.Upstream
					hasLastClientUpstream = true
					lastClientUpstreamScrubber = newIdentityScrubber(accFull, model)
				}
				failureSummary.recordExecution(forwardExecution{outcome: outcome, err: fwdErr, duration: duration})
				slog.Warn("host_forward_attempt_failed",
					sdk.LogFieldGroupID, route.GroupID,
					"effective_rate", route.EffectiveRate,
					sdk.LogFieldAccountID, acc.ID,
					"attempt", attempt,
					"kind", outcome.Kind,
					sdk.LogFieldReason, outcome.Reason,
					sdk.LogFieldError, fwdErr,
				)
				hardExclude = append(hardExclude, acc.ID)
				continue
			}

			if outcome.Kind == sdk.OutcomeClientError {
				slog.Warn("host_forward_client_error",
					sdk.LogFieldGroupID, route.GroupID,
					sdk.LogFieldAccountID, acc.ID,
					sdk.LogFieldStatus, outcome.Upstream.StatusCode,
					sdk.LogFieldReason, outcome.Reason,
				)
				scrubber := newIdentityScrubber(accFull, model)
				if returnableUpstream(outcome.Upstream) {
					return hostForwardPayload(outcome, scrubber), nil
				}
				return nil, hostForwardClientError(outcome, scrubber)
			}
			if outcome.Kind != sdk.OutcomeSuccess {
				slog.Warn("host_forward_outcome_failed",
					sdk.LogFieldGroupID, route.GroupID,
					sdk.LogFieldAccountID, acc.ID,
					"kind", outcome.Kind,
					sdk.LogFieldReason, outcome.Reason,
				)
				if returnableUpstream(outcome.Upstream) {
					return hostForwardPayload(outcome, newIdentityScrubber(accFull, model)), nil
				}
				break
			}

			resp := hostForwardPayload(outcome, nil)

			if outcome.Usage != nil {
				if usageID, err := h.recordHostForwardUsage(ctx, req, route, acc.ID, route.Platform, model, accFull, userEmail, outcome, duration); err != nil {
					slog.Error("host_forward_record_usage_failed",
						sdk.LogFieldUserID, req.UserID,
						sdk.LogFieldAccountID, acc.ID,
						sdk.LogFieldError, err,
					)
				} else if usageID > 0 {
					resp["usage_id"] = usageID
				}
				resp["usage"] = outcome.Usage
			}

			return resp, nil
		}
	}

	if hasLastClientUpstream {
		lastUpstream, hasLastUpstream = lastClientUpstream, true
		lastUpstreamScrubber = lastClientUpstreamScrubber
	}
	return hostAllRoutesFailurePayload(failureSummary, lastUpstream, hasLastUpstream, lastUpstreamScrubber), nil
}

// forwardPinned 钉选账号转发：异步任务型平台（提交任务后必须回到同一账号查询/取产物）
// 的后续请求走这里。与 forward 的差异：不调度、不 failover，账号由调用方指定；
// 分组归属与平台一致性显式校验（group_id / account_id 可能间接来自终端用户输入）。
// 判决仍进账号状态机，Usage 仍走完整计费管线。
func (h *HostService) forwardPinned(ctx context.Context, req hostForwardRequest) (map[string]interface{}, error) {
	if req.GroupID <= 0 {
		return nil, status.Error(codes.InvalidArgument, "钉选账号转发必须显式指定 group_id")
	}
	routes, userEmail, err := h.hostForwardRoutes(ctx, req)
	if err != nil {
		return nil, err
	}
	route := routes[0]
	// 钉选路径同样要过预算门禁：视频插件的**首次提交本身就是钉选转发**
	// （参考图素材绑在选中账号上，必须钉住），只有它带 estimated_official_cost；
	// 后续的进度轮询/结算不带，checkSubmissionBudget 会直接 no-op 放行——
	// 这正是 2026-09-04「已提交任务被余额门禁卡死」那条教训要保住的边界。
	if err := h.checkSubmissionBudget(ctx, &req, route.EffectiveRate); err != nil {
		return nil, err
	}
	inst := h.manager.GetPluginByPlatform(route.Platform)
	if inst == nil || inst.Gateway == nil {
		slog.Warn("host_forward_pinned_no_plugin",
			sdk.LogFieldPlatform, route.Platform, sdk.LogFieldGroupID, route.GroupID)
		return nil, hostForwardGenericError()
	}
	model := h.resolveHostModel(route.Platform, req.Model)

	accFull, err := h.db.Account.Query().
		Where(
			account.IDEQ(int(req.AccountID)),
			account.PlatformEQ(route.Platform),
			account.HasGroupsWith(group.IDEQ(route.GroupID)),
		).
		WithProxy().
		Only(ctx)
	if err != nil {
		if cerr := hostContextError(err); cerr != nil {
			return nil, cerr
		}
		if ent.IsNotFound(err) {
			slog.Warn("host_forward_pinned_account_mismatch",
				sdk.LogFieldAccountID, req.AccountID,
				sdk.LogFieldGroupID, route.GroupID,
				sdk.LogFieldPlatform, route.Platform,
			)
			return nil, status.Error(codes.NotFound, "指定账号不存在或不属于该分组")
		}
		slog.Error("host_forward_pinned_account_load_failed",
			sdk.LogFieldAccountID, req.AccountID, sdk.LogFieldError, err)
		return nil, hostForwardGenericError()
	}

	fwdCtx, cancel := context.WithTimeout(ctx, hostForwardTimeout(h.manager, req))
	defer cancel()

	releaseAccountSlot, ok := h.waitForHostAccountSlot(fwdCtx, accFull)
	if !ok {
		if cerr := hostContextError(fwdCtx.Err()); cerr != nil {
			return nil, cerr
		}
		slog.Warn("host_forward_pinned_capacity_unavailable",
			sdk.LogFieldAccountID, accFull.ID,
			sdk.LogFieldGroupID, route.GroupID,
		)
		return nil, hostForwardGenericError()
	}
	probeToken := uuid.NewString()
	gate, err := h.scheduler.ClaimAccountGate(fwdCtx, accFull.ID, accFull.Platform, model, probeToken)
	if err != nil {
		releaseAccountSlot()
		h.scheduler.DecrementRPM(context.Background(), accFull.ID)
		h.releaseHostFamilyProbe(accFull.ID, accFull.Platform, model, probeToken)
		if cerr := hostContextError(err); cerr != nil {
			return nil, cerr
		}
		slog.Error("host_forward_pinned_gate_failed",
			sdk.LogFieldAccountID, accFull.ID, sdk.LogFieldError, err)
		return nil, hostForwardGenericError()
	}
	if !gate.Allowed() {
		releaseAccountSlot()
		h.scheduler.DecrementRPM(context.Background(), accFull.ID)
		return hostAccountGatePayload(gate), nil
	}
	claimedProbeToken := ""
	stopProbeLease := func() {}
	if gate.ProbeClaimed {
		claimedProbeToken = probeToken
		stopProbeLease = h.scheduler.MaintainFamilyProbe(fwdCtx, accFull.ID, accFull.Platform, model, claimedProbeToken)
	}

	headers := hostForwardHeaders(req, route)
	applyAccountCapabilityHeaders(headers, accFull)
	fwdReq := &sdk.ForwardRequest{
		Account: hostSDKAccount(accFull),
		Body:    hostForwardBody(req.Body),
		Headers: headers,
		Model:   model,
		Stream:  false,
	}

	start := time.Now()
	outcome, fwdErr := inst.Gateway.Forward(fwdCtx, fwdReq)
	stopProbeLease()
	h.persistHostUpdatedCredentials(accFull.ID, outcome.UpdatedCredentials)
	duration := time.Since(start)
	releaseAccountSlot()
	if !h.applyHostOutcome(fwdCtx, accFull.ID, accFull, model, outcome, duration, claimedProbeToken, fwdErr, true) {
		h.recordCanceledHostForwardUsage(req, route, accFull.ID, route.Platform, model, accFull, userEmail, outcome, duration, hostCanceledRequestStatus(fwdCtx, fwdErr))
		return nil, hostForwardContextError(fwdCtx, fwdErr)
	}
	if fwdErr != nil {
		payload, terminalErr := hostPinnedGatewayError(outcome, fwdErr, newIdentityScrubber(accFull, model))
		if terminalErr != nil {
			slog.Warn("host_forward_pinned_failed",
				sdk.LogFieldAccountID, accFull.ID, sdk.LogFieldError, fwdErr)
		}
		return payload, terminalErr
	}
	if outcome.Kind != sdk.OutcomeSuccess && !returnableUpstream(outcome.Upstream) {
		slog.Warn("host_forward_pinned_outcome_failed",
			sdk.LogFieldAccountID, accFull.ID,
			"kind", outcome.Kind,
			sdk.LogFieldReason, outcome.Reason,
		)
		return nil, hostForwardGenericError()
	}

	resp := hostForwardPayload(outcome, newIdentityScrubber(accFull, model))
	if outcome.Kind == sdk.OutcomeSuccess && outcome.Usage != nil {
		if usageID, err := h.recordHostForwardUsage(ctx, req, route, accFull.ID, route.Platform, model, accFull, userEmail, outcome, duration); err != nil {
			slog.Error("host_forward_pinned_record_usage_failed",
				sdk.LogFieldUserID, req.UserID,
				sdk.LogFieldAccountID, accFull.ID,
				sdk.LogFieldError, err,
			)
		} else if usageID > 0 {
			resp["usage_id"] = usageID
		}
		resp["usage"] = outcome.Usage
	}
	return resp, nil
}

// signRelayURL 为调用插件签发媒体中继路径（host method relay.sign_url）。
// 插件名直接取调用方身份，插件无法冒签其他插件的中继地址。
func (h *HostService) signRelayURL(pluginID string, req hostRelaySignURLRequest) (map[string]interface{}, error) {
	rs := h.manager.RelayService()
	if rs == nil {
		return nil, status.Error(codes.FailedPrecondition, "relay 服务未启用")
	}
	if strings.TrimSpace(req.Ref) == "" {
		return nil, status.Error(codes.InvalidArgument, "ref 不能为空")
	}
	path, expiresAt, err := rs.SignPath(pluginID, req.Ref, req.Filename, time.Duration(req.TTLSeconds)*time.Second)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	return map[string]interface{}{"path": path, "expires_at": expiresAt}, nil
}

// forwardStream 流式业务转发。
// 账号级故障自动 failover：通过 failoverStreamWriter 延迟提交，
// 成功（< 400）时立即切换到真流式，失败时缓冲数据后丢弃重试。
func (h *HostService) forwardStream(ctx context.Context, req hostForwardRequest, stream pb.CoreInvokeService_InvokeStreamServer) error {
	if req.UserID <= 0 {
		return status.Error(codes.InvalidArgument, "user_id 必须 > 0")
	}
	if err := h.resolveHostForwardIdentity(ctx, &req); err != nil {
		return err
	}
	if err := h.checkHostForwardBalance(ctx, req.UserID); err != nil {
		return err
	}

	routes, userEmail, err := h.hostForwardRoutes(ctx, req)
	if err != nil {
		return err
	}
	fwdCtx, cancel := context.WithTimeout(ctx, 300*time.Second)
	defer cancel()

	sw := &hostStreamWriter{stream: stream}
	hardExclude := make([]int, 0, len(routes))
	failureSummary := allRoutesFailureSummary{}
	// 与 Forwarder 一致：4xx 判决也换号重试，穷尽后回放最后一次客户端错误。
	var lastClientError *sdk.ForwardOutcome
	var lastClientErrorScrubber *identityScrubber

	for _, route := range routes {
		model := h.resolveHostModel(route.Platform, req.Model)
		if model == "" {
			slog.Warn("host_forward_stream_no_model",
				sdk.LogFieldPlatform, route.Platform, sdk.LogFieldGroupID, route.GroupID)
			continue
		}
		inst := h.manager.GetPluginByPlatform(route.Platform)
		if inst == nil || inst.Gateway == nil {
			slog.Warn("host_forward_stream_no_plugin",
				sdk.LogFieldPlatform, route.Platform, sdk.LogFieldGroupID, route.GroupID)
			continue
		}

		softExclude := make([]int, 0, 8)
		attempt := 0
		queueDeadline := time.Now().Add(hostForwardCapacityWaitTimeout)
		queuePollDelay := hostForwardCapacityPollInterval
		waitingForLocalCapacity := false
		for {
			exclude := make([]int, 0, len(hardExclude)+len(softExclude))
			exclude = append(exclude, hardExclude...)
			exclude = append(exclude, softExclude...)
			probeToken := uuid.NewString()
			selectionCtx := scheduler.WithFamilyProbeToken(fwdCtx, probeToken)
			acc, err := h.scheduler.SelectAccountWithRequirements(selectionCtx, route.Platform, model, 0, route.GroupID, "", hostAccountRequirements(h.manager, req), exclude...)
			if err != nil {
				if cerr := hostContextError(err); cerr != nil {
					return cerr
				}
				failureSummary.recordPickAccountErrorAfterExclusions(err, len(exclude) > 0)
				localSoftExcluded := waitingForLocalCapacity && len(softExclude) > 0
				if shouldWaitForLocalCapacity(err, localSoftExcluded) {
					softExclude = softExclude[:0]
					if waitForHostCapacity(fwdCtx, queueDeadline, &queuePollDelay) {
						continue
					}
					if cerr := hostContextError(fwdCtx.Err()); cerr != nil {
						return cerr
					}
				}
				slog.Warn("host_forward_stream_pick_account_failed",
					sdk.LogFieldPlatform, route.Platform,
					sdk.LogFieldModel, model,
					sdk.LogFieldGroupID, route.GroupID,
					"effective_rate", route.EffectiveRate,
					sdk.LogFieldError, err,
				)
				break
			}

			accFull, err := h.db.Account.Query().Where(account.IDEQ(acc.ID)).WithProxy().Only(ctx)
			if err != nil {
				h.releaseHostFamilyProbe(acc.ID, acc.Platform, model, probeToken)
				if cerr := hostContextError(err); cerr != nil {
					return cerr
				}
				slog.Error("host_forward_stream_account_load_failed",
					sdk.LogFieldAccountID, acc.ID, sdk.LogFieldError, err)
				return hostForwardGenericError()
			}

			releaseAccountSlot, ok := h.acquireHostAccountSlot(fwdCtx, accFull)
			if !ok {
				h.releaseHostFamilyProbe(acc.ID, acc.Platform, model, probeToken)
				failureSummary.recordLocalCapacityFailure()
				waitingForLocalCapacity = true
				softExclude = append(softExclude, acc.ID)
				continue
			}
			waitingForLocalCapacity = false
			queuePollDelay = hostForwardCapacityPollInterval
			gate, gateErr := h.scheduler.ClaimAccountGate(fwdCtx, acc.ID, acc.Platform, model, probeToken)
			if gateErr != nil || !gate.Allowed() {
				releaseAccountSlot()
				h.scheduler.DecrementRPM(context.Background(), acc.ID)
				h.releaseHostFamilyProbe(acc.ID, acc.Platform, model, probeToken)
				if gateErr != nil {
					failureSummary.recordPickAccountError(gateErr)
				} else {
					failureSummary.recordAccountGateDecision(gate)
				}
				hardExclude = append(hardExclude, acc.ID)
				slog.Warn("host_forward_stream_account_gate_rejected",
					sdk.LogFieldAccountID, acc.ID,
					"reason", gate.Reason,
					sdk.LogFieldError, gateErr,
				)
				continue
			}

			fw := &failoverStreamWriter{target: sw}
			headers := hostForwardHeaders(req, route)
			applyAccountCapabilityHeaders(headers, accFull)
			fwdReq := &sdk.ForwardRequest{
				Account: hostSDKAccount(accFull),
				Body:    hostForwardBody(req.Body),
				Headers: headers,
				Model:   model,
				Stream:  true,
				Writer:  fw,
			}

			start := time.Now()
			stopProbeLease := func() {}
			if gate.ProbeClaimed {
				stopProbeLease = h.scheduler.MaintainFamilyProbe(fwdCtx, acc.ID, acc.Platform, model, probeToken)
			}
			outcome, fwdErr := inst.Gateway.Forward(fwdCtx, fwdReq)
			stopProbeLease()
			h.persistHostUpdatedCredentials(acc.ID, outcome.UpdatedCredentials)
			attempt++
			duration := time.Since(start)
			releaseAccountSlot()
			if !h.applyHostOutcome(fwdCtx, acc.ID, accFull, model, outcome, duration, probeToken, fwdErr, true) {
				h.recordCanceledHostForwardUsage(req, route, acc.ID, route.Platform, model, accFull, userEmail, outcome, duration, hostCanceledRequestStatus(fwdCtx, fwdErr))
				return hostForwardContextError(fwdCtx, fwdErr)
			}

			replayableClient := outcome.Kind == sdk.OutcomeClientError && replayableClientError(outcome)
			canRetry := !fw.committed && (fwdErr != nil || outcome.Kind.ShouldFailover() || replayableClient)
			if canRetry {
				if replayableClient {
					snapshot := outcome
					lastClientError = &snapshot
					lastClientErrorScrubber = newIdentityScrubber(accFull, model)
				}
				failureSummary.recordExecution(forwardExecution{outcome: outcome, err: fwdErr, duration: duration})
				slog.Warn("host_forward_stream_attempt_failed",
					sdk.LogFieldGroupID, route.GroupID,
					"effective_rate", route.EffectiveRate,
					sdk.LogFieldAccountID, acc.ID,
					"attempt", attempt,
					"kind", outcome.Kind,
					sdk.LogFieldReason, outcome.Reason,
					sdk.LogFieldError, fwdErr,
				)
				hardExclude = append(hardExclude, acc.ID)
				continue
			}

			if outcome.Kind == sdk.OutcomeClientError {
				slog.Warn("host_forward_stream_client_error",
					sdk.LogFieldGroupID, route.GroupID,
					sdk.LogFieldAccountID, acc.ID,
					sdk.LogFieldStatus, outcome.Upstream.StatusCode,
					sdk.LogFieldReason, outcome.Reason,
				)
				return hostForwardClientError(outcome, newIdentityScrubber(accFull, model))
			}

			if !fw.committed {
				fw.flush()
			}

			if outcome.Kind != sdk.OutcomeSuccess && fwdErr == nil {
				slog.Warn("host_forward_stream_committed_failure",
					sdk.LogFieldGroupID, route.GroupID,
					"effective_rate", route.EffectiveRate,
					sdk.LogFieldAccountID, acc.ID,
					"kind", outcome.Kind,
					sdk.LogFieldStatus, outcome.Upstream.StatusCode,
					sdk.LogFieldReason, outcome.Reason,
					"stream_committed", fw.committed,
				)
			}

			if fwdErr != nil {
				slog.Warn("host_forward_stream_plugin_error",
					sdk.LogFieldGroupID, route.GroupID,
					sdk.LogFieldAccountID, acc.ID,
					sdk.LogFieldError, fwdErr,
				)
				return hostForwardGenericError()
			}

			var usage *sdk.Usage
			if outcome.Usage != nil {
				if _, err := h.recordHostForwardUsage(ctx, req, route, acc.ID, route.Platform, model, accFull, userEmail, outcome, duration); err != nil {
					slog.Error("host_forward_stream_record_usage_failed",
						sdk.LogFieldUserID, req.UserID,
						sdk.LogFieldAccountID, acc.ID,
						sdk.LogFieldError, err,
					)
				}
				usage = outcome.Usage
			}

			return stream.Send(&pb.HostStreamFrame{
				Event:  "done",
				Status: "ok",
				Payload: mustHostPayload(map[string]interface{}{
					"usage": usage,
				}),
				Done: true,
			})
		}
	}

	if lastClientError != nil {
		return hostForwardClientError(*lastClientError, lastClientErrorScrubber)
	}
	return sendHostStreamFailure(stream, failureSummary)
}

const (
	// 长任务走直连入口时不受 Cloudflare 代理超时限制；为官方模型和大上下文请求
	// 保留足够的单次转发时间，仍由客户端取消或上游自身超时提前结束。
	defaultHostForwardTimeout          = 30 * time.Minute
	imageHostForwardTimeout            = 300 * time.Second
	hostForwardCapacityWaitTimeout     = 60 * time.Second
	hostForwardCapacityPollInterval    = 200 * time.Millisecond
	hostForwardCapacityMaxPollInterval = 2 * time.Second
)

// acquireHostAccountSlot mirrors the account-level gate used by the public
// Forwarder. RPM is reserved before the concurrency slot; a failed slot acquire
// rolls RPM back because no upstream request was made.
func (h *HostService) acquireHostAccountSlot(ctx context.Context, acc *ent.Account) (func(), bool) {
	if h == nil || h.scheduler == nil || acc == nil {
		return nil, false
	}

	maxRPM := scheduler.ExtraInt(acc.Extra, "max_rpm")
	if !h.scheduler.TryIncrementRPM(ctx, acc.ID, maxRPM) {
		slog.Info("host_forward_account_rpm_full",
			sdk.LogFieldAccountID, acc.ID,
			"max_rpm", maxRPM,
		)
		return nil, false
	}

	requestID := uuid.NewString()
	maxConcurrency := acc.MaxConcurrency
	if maxConcurrency <= 0 {
		maxConcurrency = scheduler.DefaultAccountMaxConcurrency
	}
	slotTTL := time.Duration(scheduler.ExtraInt(acc.Extra, "slot_ttl_seconds")) * time.Second
	if h.concurrency != nil {
		if err := h.concurrency.AcquireSlot(ctx, acc.ID, requestID, maxConcurrency, slotTTL); err != nil {
			h.scheduler.DecrementRPM(finalizeRequestContext(ctx), acc.ID)
			slog.Info("host_forward_account_concurrency_full",
				sdk.LogFieldAccountID, acc.ID,
				"max_concurrency", maxConcurrency,
			)
			return nil, false
		}
	}

	return func() {
		if h.concurrency != nil {
			h.concurrency.ReleaseSlot(context.Background(), acc.ID, requestID)
		}
	}, true
}

func (h *HostService) waitForHostAccountSlot(ctx context.Context, acc *ent.Account) (func(), bool) {
	deadline := time.Now().Add(hostForwardCapacityWaitTimeout)
	pollDelay := hostForwardCapacityPollInterval
	for {
		if release, ok := h.acquireHostAccountSlot(ctx, acc); ok {
			return release, true
		}
		if !waitForHostCapacity(ctx, deadline, &pollDelay) {
			return nil, false
		}
	}
}

func hostAllRoutesFailurePayload(summary allRoutesFailureSummary, lastUpstream sdk.UpstreamResponse, hasLastUpstream bool, lastUpstreamScrubber *identityScrubber) map[string]interface{} {
	if !summary.allViableRoutesRateLimited() && hasLastUpstream && lastUpstream.StatusCode != http.StatusTooManyRequests {
		return hostForwardPayload(sdk.ForwardOutcome{Upstream: lastUpstream}, lastUpstreamScrubber)
	}
	response := selectAllRoutesFailureResponse(summary)
	// 我方生成的失败文案，不含上游原文，无需清洗。
	return hostForwardPayload(hostStructuredFailureOutcome(response.status, response.code, response.message, response.retryAfter), nil)
}

func hostAccountGatePayload(decision scheduler.AccountGateDecision) map[string]interface{} {
	statusCode := http.StatusServiceUnavailable
	code := appusage.ErrorCodeNoAvailableAccount
	message := "指定上游账号暂不可用，请稍后重试"
	if decision.Reason == scheduler.AccountGateRateLimited {
		statusCode = http.StatusTooManyRequests
		code = appusage.ErrorCodeAllRoutesRateLimited
		message = "指定上游账号当前被限流，请稍后重试"
	}
	retryAfter := time.Until(decision.RetryAt)
	if retryAfter < 0 {
		retryAfter = 0
	}
	return hostForwardPayload(hostStructuredFailureOutcome(statusCode, code, message, retryAfter), nil)
}

func hostPinnedGatewayError(outcome sdk.ForwardOutcome, forwardErr error, scrubber *identityScrubber) (map[string]interface{}, error) {
	if forwardErr == nil {
		return nil, nil
	}
	if returnableUpstream(outcome.Upstream) {
		return hostForwardPayload(outcome, scrubber), nil
	}
	return nil, hostForwardGenericError()
}

func hostStructuredFailureOutcome(statusCode int, code, message string, retryAfter time.Duration) sdk.ForwardOutcome {
	headers := make(http.Header)
	headers.Set("Content-Type", "application/json; charset=utf-8")
	if retryAfter > 0 {
		seconds := int64((retryAfter + time.Second - 1) / time.Second)
		if seconds < 1 {
			seconds = 1
		}
		headers.Set("Retry-After", strconv.FormatInt(seconds, 10))
		headers.Set("Retry-After-Ms", strconv.FormatInt(retryAfter.Milliseconds(), 10))
	}
	body, _ := json.Marshal(map[string]interface{}{
		"error": map[string]interface{}{
			"message": message,
			"type":    hostFailureType(statusCode),
			"code":    code,
		},
	})
	return sdk.ForwardOutcome{Upstream: sdk.UpstreamResponse{
		StatusCode: statusCode,
		Headers:    headers,
		Body:       body,
	}}
}

func hostFailureType(statusCode int) string {
	if statusCode == http.StatusTooManyRequests {
		return "rate_limit_error"
	}
	return "server_error"
}

func sendHostStreamFailure(stream pb.CoreInvokeService_InvokeStreamServer, summary allRoutesFailureSummary) error {
	response := selectAllRoutesFailureResponse(summary)
	outcome := hostStructuredFailureOutcome(response.status, response.code, response.message, response.retryAfter)
	if err := stream.Send(&pb.HostStreamFrame{
		Event:  "headers",
		Status: "ok",
		Payload: mustHostPayload(map[string]interface{}{
			"status_code": outcome.Upstream.StatusCode,
			"headers":     httpHeadersToProtoHost(outcome.Upstream.Headers),
		}),
	}); err != nil {
		return err
	}
	if len(outcome.Upstream.Body) > 0 {
		if err := stream.Send(&pb.HostStreamFrame{
			Event: "chunk",
			Payload: mustHostPayload(map[string]interface{}{
				"data": string(outcome.Upstream.Body),
			}),
		}); err != nil {
			return err
		}
	}
	return stream.Send(&pb.HostStreamFrame{
		Event:  "done",
		Status: "ok",
		Payload: mustHostPayload(map[string]interface{}{
			"usage": nil,
		}),
		Done: true,
	})
}

func waitForHostCapacity(ctx context.Context, deadline time.Time, pollDelay *time.Duration) bool {
	if pollDelay == nil || !time.Now().Before(deadline) {
		return false
	}
	wait := *pollDelay
	if wait <= 0 {
		wait = hostForwardCapacityPollInterval
	}
	if remaining := time.Until(deadline); remaining < wait {
		wait = remaining
	}
	if wait <= 0 {
		return false
	}

	timer := time.NewTimer(wait)
	select {
	case <-ctx.Done():
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		return false
	case <-timer.C:
	}

	next := wait * 2
	if next > hostForwardCapacityMaxPollInterval {
		next = hostForwardCapacityMaxPollInterval
	}
	*pollDelay = next
	return true
}

func hostForwardTimeout(mgr *Manager, req hostForwardRequest) time.Duration {
	if requestHasImageWorkload(mgr, req.Path, req.Model, hostForwardBody(req.Body)) {
		return imageHostForwardTimeout
	}
	return defaultHostForwardTimeout
}

// failoverStreamWriter 包装 hostStreamWriter，支持 failover 重试。
// 成功响应（StatusCode < 400）立即提交到真正的 gRPC stream，实现真流式；
// 错误响应缓冲数据，允许调用方丢弃后重试下一个账号。
type failoverStreamWriter struct {
	target interface {
		http.ResponseWriter
		Flush()
	}
	committed bool
	bufStatus int
	bufHdr    http.Header
	bufData   [][]byte
}

func (w *failoverStreamWriter) Header() http.Header {
	if w.committed {
		return w.target.Header()
	}
	if w.bufHdr == nil {
		w.bufHdr = make(http.Header)
	}
	return w.bufHdr
}

func (w *failoverStreamWriter) WriteHeader(statusCode int) {
	if w.committed {
		w.target.WriteHeader(statusCode)
		return
	}
	w.bufStatus = statusCode
	if statusCode > 0 && statusCode < 400 {
		w.flush()
	}
}

func (w *failoverStreamWriter) Write(data []byte) (int, error) {
	if w.committed {
		return w.target.Write(data)
	}
	if isSSECommentOnly(data) {
		for k, values := range w.bufHdr {
			w.target.Header()[k] = append([]string(nil), values...)
		}
		return w.target.Write(data)
	}
	buf := make([]byte, len(data))
	copy(buf, data)
	w.bufData = append(w.bufData, buf)
	return len(data), nil
}

func (w *failoverStreamWriter) Flush() {
	if w.committed {
		w.target.Flush()
	}
}

func (w *failoverStreamWriter) flush() {
	if w.committed {
		return
	}
	w.committed = true
	for k, v := range w.bufHdr {
		w.target.Header()[k] = v
	}
	if w.bufStatus > 0 {
		w.target.WriteHeader(w.bufStatus)
	}
	for _, d := range w.bufData {
		if _, err := w.target.Write(d); err != nil {
			return
		}
	}
	w.bufData = nil
}

// hostStreamWriter 适配 http.ResponseWriter，将流式数据转为 gRPC stream chunks。
type hostStreamWriter struct {
	stream     pb.CoreInvokeService_InvokeStreamServer
	headerSent bool
	header     http.Header
	statusCode int
}

func (w *hostStreamWriter) Header() http.Header {
	if w.header == nil {
		w.header = make(http.Header)
	}
	return w.header
}

func (w *hostStreamWriter) WriteHeader(statusCode int) {
	if w.headerSent {
		return
	}
	w.statusCode = statusCode
	w.headerSent = true
	_ = w.stream.Send(&pb.HostStreamFrame{
		Event:  "headers",
		Status: "ok",
		Payload: mustHostPayload(map[string]interface{}{
			"status_code": statusCode,
			"headers":     httpHeadersToProtoHost(w.header),
		}),
	})
}

func (w *hostStreamWriter) Write(data []byte) (int, error) {
	if !w.headerSent {
		w.WriteHeader(http.StatusOK)
	}
	if len(data) == 0 {
		return 0, nil
	}
	chunk := make([]byte, len(data))
	copy(chunk, data)
	if err := w.stream.Send(&pb.HostStreamFrame{
		Event: "chunk",
		Payload: mustHostPayload(map[string]interface{}{
			"data": string(chunk),
		}),
	}); err != nil {
		return 0, err
	}
	return len(data), nil
}

func (w *hostStreamWriter) Flush() {}

// recordHostForwardUsage 为 Host gateway.forward 调用发起的请求记录 usage_log 并扣费。
// 与 forwarder.recordUsage 的区别：调用方只传 APIKeyID 快照，不要求 Key 在异步结算时仍存在。
func (h *HostService) recordHostForwardUsage(
	ctx context.Context,
	req hostForwardRequest,
	route routing.Candidate,
	accountID int,
	platform, model string,
	accFull *ent.Account,
	userEmail string,
	outcome sdk.ForwardOutcome,
	duration time.Duration,
) (int, error) {
	return h.recordHostForwardUsageWithFailure(ctx, req, route, accountID, platform, model, accFull, userEmail, outcome, duration, nil)
}

func (h *HostService) recordHostForwardUsageWithFailure(
	ctx context.Context,
	req hostForwardRequest,
	route routing.Candidate,
	accountID int,
	platform, model string,
	accFull *ent.Account,
	userEmail string,
	outcome sdk.ForwardOutcome,
	duration time.Duration,
	failureOverride *usageFailure,
) (int, error) {
	usage := outcome.Usage
	if usage == nil {
		return 0, nil
	}
	req.RequestID = strings.TrimSpace(req.RequestID)
	usageValues := usageSnapshotFromSDK(usage)

	actualModel := usage.Model
	if actualModel == "" {
		actualModel = model
	}
	calcInput := billing.CalculateInput{
		InputCost:         usageValues.InputCost,
		ImageInputCost:    usageValues.ImageInputCost,
		OutputCost:        usageValues.OutputCost,
		CachedInputCost:   usageValues.CachedInputCost,
		CacheCreationCost: usageValues.CacheCreationCost,
		ImageCost:         usageValues.ImageCost,
		BillingRate:       route.EffectiveRate,
		AccountRate:       billing.ResolveAccountRateForModel(accFull.Extra, actualModel, accFull.RateMultiplier),
	}
	var imageFixedPriceApplied bool
	var imageFixedPriceReplacesTotal bool
	if applied, replacesTotal := applyImageBillingOverride(&calcInput, usage, route.UserPluginSettings, route.GroupPluginSettings); applied {
		imageFixedPriceApplied = true
		imageFixedPriceReplacesTotal = replacesTotal
	}
	calc := h.calculator.Calculate(calcInput)
	applyHostForwardBilling(usage, calc)
	applyHostForwardTrace(usage, req.TraceID)

	if usageID, found, err := h.existingHostForwardUsageID(ctx, req, platform, actualModel); err != nil {
		return 0, err
	} else if found {
		return usageID, nil
	}

	var failure usageFailure
	if failureOverride != nil {
		failure = *failureOverride
	}
	record := billing.UsageRecord{
		UserID:                       int(req.UserID),
		UserEmail:                    userEmail,
		MemberID:                     req.memberID,
		APIKeyID:                     int(req.APIKeyID),
		AccountID:                    accountID,
		GroupID:                      route.GroupID,
		Platform:                     platform,
		Model:                        actualModel,
		InputTokens:                  usageValues.InputTokens,
		OutputTokens:                 usageValues.OutputTokens,
		CachedInputTokens:            usageValues.CachedInputTokens,
		CacheCreationTokens:          usageValues.CacheCreationTokens,
		CacheCreation5mTokens:        usageValues.CacheCreation5mTokens,
		CacheCreation1hTokens:        usageValues.CacheCreation1hTokens,
		ReasoningOutputTokens:        usageValues.ReasoningOutputTokens,
		RequestID:                    req.RequestID,
		InputPrice:                   usageValues.InputPrice,
		OutputPrice:                  usageValues.OutputPrice,
		CachedInputPrice:             usageValues.CachedInputPrice,
		CacheCreationPrice:           usageValues.CacheCreationPrice,
		CacheCreation1hPrice:         usageValues.CacheCreation1hPrice,
		InputCost:                    calc.InputCost,
		OutputCost:                   calc.OutputCost,
		CachedInputCost:              calc.CachedInputCost,
		CacheCreationCost:            calc.CacheCreationCost,
		ImageCost:                    calc.ImageCost,
		ImageFixedPriceApplied:       imageFixedPriceApplied,
		ImageFixedPriceReplacesTotal: imageFixedPriceReplacesTotal,
		TotalCost:                    calc.TotalCost,
		ActualCost:                   calc.ActualCost,
		BilledCost:                   calc.BilledCost,
		AccountCost:                  calc.AccountCost,
		RateMultiplier:               calc.RateMultiplier,
		AccountRateMultiplier:        calc.AccountRateMultiplier,
		ServiceTier:                  usageValues.ServiceTier,
		ImageSize:                    usageValues.ImageSize,
		Endpoint:                     req.Path,
		ReasoningEffort:              resolveReasoningEffort(hostForwardReasoningEffort(req), usage),
		Stream:                       req.Stream,
		DurationMs:                   duration.Milliseconds(),
		FirstTokenMs:                 usageValues.FirstTokenMs,
		UsageAttributes:              usage.Attributes,
		UsageMetrics:                 usage.Metrics,
		UsageCostDetails:             usage.CostDetails,
		UsageMetadata:                usage.Metadata,
		ErrorCode:                    failure.code,
		ErrorStatus:                  failure.status,
		ErrorMessage:                 sanitizeFailureMessage(failure.message),
	}
	if h.recorder == nil {
		return 0, nil
	}
	usageID, err := h.recorder.RecordSync(ctx, record)
	if err != nil {
		// A concurrent retry can win the unique request_id insert after our first
		// lookup. Resolve that race to the committed row instead of reporting a
		// zero usage ID and leaving an async task stranded.
		if existingID, found, lookupErr := h.existingHostForwardUsageID(ctx, req, platform, actualModel); lookupErr != nil {
			return 0, lookupErr
		} else if found {
			return existingID, nil
		}
		return 0, err
	}
	h.scheduler.AddWindowCost(ctx, accountID, calc.AccountCost)
	return usageID, nil
}

func (h *HostService) existingHostForwardUsageID(
	ctx context.Context,
	req hostForwardRequest,
	platform, model string,
) (int, bool, error) {
	requestID := strings.TrimSpace(req.RequestID)
	if requestID == "" {
		return 0, false, nil
	}
	row, err := h.db.UsageLog.Query().
		Where(entusagelog.RequestIDEQ(requestID)).
		WithAccount().
		WithGroup().
		Only(ctx)
	if ent.IsNotFound(err) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("查询 gateway.forward 幂等 usage 失败: %w", err)
	}
	accountMismatch := req.AccountID > 0 && (row.Edges.Account == nil || row.Edges.Account.ID != int(req.AccountID))
	groupMismatch := req.GroupID > 0 && (row.Edges.Group == nil || row.Edges.Group.ID != int(req.GroupID))
	if row.UserIDSnapshot != int(req.UserID) || accountMismatch || groupMismatch || row.Platform != platform || row.Model != model || row.Endpoint != req.Path || row.Status != billing.UsageStatusSuccess {
		return 0, false, status.Errorf(codes.FailedPrecondition, "request_id %q 已用于其他计费上下文", requestID)
	}
	return row.ID, true, nil
}

// applyHostForwardBilling 将 Core 最终采用的用户计费口径回填给调用插件。
// gateway 插件只负责上报基础成本；用户/分组倍率由 Core 决定，因此 Host
// 调用方不能直接沿用插件原始 usage，否则展示费用可能与余额实际扣减不一致。
func applyHostForwardBilling(usage *sdk.Usage, calc billing.CalculateResult) {
	if usage == nil {
		return
	}
	usage.UserCost = calc.ActualCost
	usage.BillingMultiplier = calc.RateMultiplier
}

func applyHostForwardTrace(usage *sdk.Usage, traceID string) {
	traceID = strings.TrimSpace(traceID)
	if usage == nil || traceID == "" {
		return
	}
	if len(traceID) > 128 {
		traceID = traceID[:128]
	}
	if usage.Metadata == nil {
		usage.Metadata = make(map[string]string)
	}
	usage.Metadata["trace_id"] = traceID
}

// listPlatforms 列出已加载的网关平台。
func (h *HostService) listPlatforms(_ context.Context) (map[string]interface{}, error) {
	metas := h.manager.GetAllPluginMeta()
	seen := make(map[string]struct{}, len(metas))
	platforms := make([]map[string]interface{}, 0, len(metas))
	for _, m := range metas {
		if m.Type != "gateway" || m.Platform == "" {
			continue
		}
		if _, ok := seen[m.Platform]; ok {
			continue
		}
		seen[m.Platform] = struct{}{}
		platforms = append(platforms, map[string]interface{}{
			"name":         m.Platform,
			"display_name": m.DisplayName,
		})
	}
	return map[string]interface{}{"platforms": platforms}, nil
}

// listModels 列出指定平台的模型列表。
func (h *HostService) listModels(_ context.Context, req hostListModelsRequest) (map[string]interface{}, error) {
	if req.Platform == "" {
		return nil, status.Error(codes.InvalidArgument, "platform 不能为空")
	}
	models := h.manager.GetModels(req.Platform)
	items := make([]map[string]interface{}, 0, len(models))
	for _, m := range models {
		items = append(items, map[string]interface{}{
			"id":                m.ID,
			"name":              m.Name,
			"context_window":    int64(m.ContextWindow),
			"max_output_tokens": int64(m.MaxOutputTokens),
			"capabilities":      m.Capabilities,
			"metadata":          m.Metadata,
		})
	}
	return map[string]interface{}{"models": items}, nil
}

// hostModelsRefreshRequest models.refresh 请求体：插件推送其当前生效的完整模型清单。
type hostModelsRefreshRequest struct {
	Models []hostModelsRefreshEntry `json:"models"`
}

type hostModelsRefreshEntry struct {
	ID              string            `json:"id"`
	Name            string            `json:"name"`
	ContextWindow   int64             `json:"context_window"`
	MaxOutputTokens int64             `json:"max_output_tokens"`
	Capabilities    []string          `json:"capabilities"`
	Metadata        map[string]string `json:"metadata"`
}

// modelsRefreshMaxEntries 单次推送的模型数上限,防异常插件把缓存撑爆。
const modelsRefreshMaxEntries = 512

// refreshModels 接收网关插件推送的最新模型清单，整体替换该平台的模型缓存快照。
//
// 平台取自调用方插件身份（不由 payload 指定），插件只能刷新自己平台的清单。
// 插件启动时 core 冻结的快照不含覆盖层后来新增的模型（如后台上新模型），
// 此方法是插件侧覆盖层生效后向 core 同步目录的通道，见 Manager.UpdateModelCache。
func (h *HostService) refreshModels(pluginID string, req hostModelsRefreshRequest) (map[string]interface{}, error) {
	inst := h.manager.GetInstance(pluginID)
	if inst == nil || inst.Platform == "" {
		return nil, status.Errorf(codes.FailedPrecondition, "插件 %q 不是已加载的网关插件", pluginID)
	}
	if len(req.Models) == 0 {
		return nil, status.Error(codes.InvalidArgument, "models 不能为空")
	}
	if len(req.Models) > modelsRefreshMaxEntries {
		return nil, status.Errorf(codes.InvalidArgument, "models 数量超过上限 %d", modelsRefreshMaxEntries)
	}
	models := make([]sdk.ModelInfo, 0, len(req.Models))
	for _, e := range req.Models {
		id := strings.TrimSpace(e.ID)
		if id == "" {
			continue
		}
		models = append(models, sdk.ModelInfo{
			ID:              id,
			Name:            e.Name,
			ContextWindow:   int(e.ContextWindow),
			MaxOutputTokens: int(e.MaxOutputTokens),
			Capabilities:    e.Capabilities,
			Metadata:        e.Metadata,
		})
	}
	if len(models) == 0 {
		return nil, status.Error(codes.InvalidArgument, "models 不能全为空条目")
	}
	h.manager.UpdateModelCache(inst.Platform, models)
	slog.Info("models_cache_refreshed",
		sdk.LogFieldPluginID, pluginID,
		"platform", inst.Platform,
		"count", len(models),
	)
	return map[string]interface{}{"updated": len(models)}, nil
}

// modelCatalogSettingKey 模型目录覆盖层的 settings key 约定：models.catalog.<platform>。
// core 后台编辑 UI（写入）与本 host method（读取）+ 各网关插件（消费）三方共用此约定。
func modelCatalogSettingKey(platform string) string {
	return "models.catalog." + platform
}

// getModelsCatalog 返回某平台的「模型目录覆盖层」原始 JSON 字符串（存于 settings 的
// models.catalog.<platform>）。core 仅做哑存储透传，不解析各平台各异的价格 schema——
// 由调用方插件自行解析、并与其硬编码默认目录合并。未配置时返回空字符串，插件据此纯用硬编码默认。
func (h *HostService) getModelsCatalog(ctx context.Context, req hostModelsCatalogRequest) (map[string]interface{}, error) {
	if req.Platform == "" {
		return nil, status.Error(codes.InvalidArgument, "platform 不能为空")
	}
	row, err := h.db.Setting.Query().Where(setting.KeyEQ(modelCatalogSettingKey(req.Platform))).Only(ctx)
	if ent.IsNotFound(err) {
		return map[string]interface{}{"catalog_json": ""}, nil
	}
	if err != nil {
		return nil, status.Errorf(codes.Internal, "查询模型目录配置失败: %v", err)
	}
	return map[string]interface{}{"catalog_json": row.Value}, nil
}

// getUserInfo 获取用户基本信息。
func (h *HostService) getUserInfo(ctx context.Context, req hostGetUserInfoRequest) (map[string]interface{}, error) {
	if req.UserID <= 0 {
		return nil, status.Error(codes.InvalidArgument, "user_id 必须 > 0")
	}
	u, err := h.db.User.Get(ctx, int(req.UserID))
	if err != nil {
		if ent.IsNotFound(err) {
			return nil, status.Error(codes.NotFound, "用户不存在")
		}
		return nil, status.Error(codes.Internal, err.Error())
	}
	// 成员账号的余额展示口径：有额度的成员看本期剩余额度（企业主余额对他无意义也不该暴露）；
	// 不限额的老模型成员消耗直接落企业主，才看企业主余额。身份字段仍是成员本人。
	balance := u.Balance
	if identity, err := auth.ResolveTeamIdentity(ctx, h.db, u.ID); err == nil && identity.IsMember() {
		if remaining, limited := auth.MemberRemainingQuota(identity.Member, time.Now()); limited {
			balance = remaining
		} else {
			balance = identity.Owner.Balance
		}
	}
	return map[string]interface{}{
		"user_id":  int64(u.ID),
		"username": u.Username,
		"email":    u.Email,
		"role":     string(u.Role),
		"balance":  balance,
		"status":   string(u.Status),
	}, nil
}

// resolveHostBillingUser 返回"按谁付钱"的用户 id 与成员分组白名单：成员账号取企业主，
// 否则取本人（白名单为空）。
func (h *HostService) resolveHostBillingUser(ctx context.Context, userID int) (int, []int64, error) {
	identity, err := auth.ResolveTeamIdentity(ctx, h.db, userID)
	if err != nil {
		if cerr := hostContextError(err); cerr != nil {
			return 0, nil, cerr
		}
		return 0, nil, status.Error(codes.Internal, err.Error())
	}
	if !identity.IsMember() {
		return userID, nil, nil
	}
	return identity.Owner.ID, identity.Member.AllowedGroupIds, nil
}

// hostUpdateBalanceRequest users.update_balance 请求体。
type hostUpdateBalanceRequest struct {
	UserID int64   `json:"user_id"`
	Action string  `json:"action"` // add / subtract（set 不对插件开放）
	Amount float64 `json:"amount"`
	Remark string  `json:"remark"`
	// IdempotencyKey 必填。同一键的变更只入账一次（balance_logs 唯一索引保证），
	// 支付回调等场景重试不会重复加扣款。建议格式 "<plugin>:<业务单号>"。
	IdempotencyKey string `json:"idempotency_key"`
}

// updateUserBalance 调整用户余额并写 balance_logs 流水。
// 复用 app/user.Service.AdjustBalance——余额规则、流水、幂等均在 service 层闭环，
// 插件不应也无需直写 core 的 users / balance_logs 表。
func (h *HostService) updateUserBalance(ctx context.Context, pluginID string, req hostUpdateBalanceRequest) (map[string]interface{}, error) {
	if req.UserID <= 0 {
		return nil, status.Error(codes.InvalidArgument, "user_id 必须 > 0")
	}
	if req.Action != "add" && req.Action != "subtract" {
		return nil, status.Errorf(codes.InvalidArgument, "action 仅支持 add/subtract，收到 %q", req.Action)
	}
	if req.Amount <= 0 {
		return nil, status.Error(codes.InvalidArgument, "amount 必须 > 0")
	}
	if req.IdempotencyKey == "" {
		return nil, status.Error(codes.InvalidArgument, "idempotency_key 必填（防止重试导致重复入账）")
	}
	slog.Info("host_service_update_balance",
		"module", "host",
		sdk.LogFieldPluginID, pluginID,
		sdk.LogFieldUserID, req.UserID,
		"action", req.Action,
		"amount", req.Amount,
		"idempotency_key", req.IdempotencyKey,
	)
	u, err := h.users.AdjustBalance(ctx, int(req.UserID), appuser.BalanceChange{
		Action:         req.Action,
		Amount:         req.Amount,
		Remark:         req.Remark,
		IdempotencyKey: req.IdempotencyKey,
	})
	if err != nil {
		switch {
		case errors.Is(err, appuser.ErrUserNotFound):
			return nil, status.Error(codes.NotFound, "用户不存在")
		case errors.Is(err, appuser.ErrInsufficientBalance):
			return nil, status.Error(codes.FailedPrecondition, "余额不足")
		default:
			if cerr := hostContextError(err); cerr != nil {
				return nil, cerr
			}
			return nil, status.Error(codes.Internal, err.Error())
		}
	}
	return map[string]interface{}{
		"user_id": int64(u.ID),
		"balance": u.Balance,
	}, nil
}

// hostRecordUsageRequest is the narrow, explicit contract for product-side
// usage such as document rendering. It does not accept token counts or model
// prices; callers provide a fixed, already-authorized charge and descriptive
// custom metrics. This keeps rendering costs separate from gateway token math.
type hostRecordUsageRequest struct {
	UserID         int64             `json:"user_id"`
	Platform       string            `json:"platform"`
	Model          string            `json:"model"`
	Format         string            `json:"format"`
	Quantity       float64           `json:"quantity"`
	AccountCost    float64           `json:"account_cost"`
	UserCost       float64           `json:"user_cost"`
	Currency       string            `json:"currency"`
	AssetID        string            `json:"asset_id"`
	TraceID        string            `json:"trace_id"`
	IdempotencyKey string            `json:"idempotency_key"`
	Metadata       map[string]string `json:"metadata"`
}

func (h *HostService) recordUsage(ctx context.Context, pluginID string, req hostRecordUsageRequest) (map[string]interface{}, error) {
	if req.UserID <= 0 {
		return nil, status.Error(codes.InvalidArgument, "user_id 必须 > 0")
	}
	if strings.TrimSpace(req.Platform) == "" {
		req.Platform = pluginID
	}
	if strings.TrimSpace(req.Model) == "" {
		req.Model = "document-render"
	}
	if strings.TrimSpace(req.Format) == "" || len(req.Format) > 16 || strings.ContainsAny(req.Format, " /\\\t\r\n") {
		return nil, status.Error(codes.InvalidArgument, "format 无效")
	}
	if req.Quantity <= 0 || math.IsNaN(req.Quantity) || math.IsInf(req.Quantity, 0) || req.Quantity > 10000 {
		return nil, status.Error(codes.InvalidArgument, "quantity 必须在 0-10000 之间")
	}
	if req.AccountCost < 0 || math.IsNaN(req.AccountCost) || math.IsInf(req.AccountCost, 0) || req.UserCost < 0 || math.IsNaN(req.UserCost) || math.IsInf(req.UserCost, 0) {
		return nil, status.Error(codes.InvalidArgument, "费用必须为有限非负数")
	}
	if req.IdempotencyKey == "" {
		return nil, status.Error(codes.InvalidArgument, "idempotency_key 必填")
	}
	if len(req.IdempotencyKey) > 240 {
		return nil, status.Error(codes.InvalidArgument, "idempotency_key 过长")
	}
	if _, err := h.db.User.Get(ctx, int(req.UserID)); err != nil {
		if ent.IsNotFound(err) {
			return nil, status.Error(codes.NotFound, "用户不存在")
		}
		return nil, status.Error(codes.Internal, err.Error())
	}

	metadata := make(map[string]string, len(req.Metadata)+5)
	for key, value := range req.Metadata {
		if strings.TrimSpace(key) == "" || len(key) > 64 || len(value) > 500 {
			continue
		}
		metadata[key] = value
	}
	metadata["source"] = pluginID
	metadata["format"] = req.Format
	if req.AssetID != "" {
		metadata["asset_id"] = req.AssetID
	}
	if req.TraceID != "" {
		metadata["trace_id"] = req.TraceID
	}
	metric := sdk.UsageMetric{
		Key:         "document_render",
		Label:       "Document render",
		Kind:        "custom",
		Unit:        "file",
		Value:       req.Quantity,
		AccountCost: req.AccountCost,
		Currency:    req.Currency,
		Metadata:    metadata,
	}
	detail := sdk.UsageCostDetail{
		Key:               "document_render",
		Label:             "Document render fee",
		AccountCost:       req.AccountCost,
		UserCost:          req.UserCost,
		BillingMultiplier: 1,
		Currency:          req.Currency,
		Metadata:          metadata,
	}
	record := billing.UsageRecord{
		RequestID:             req.IdempotencyKey,
		UserID:                int(req.UserID),
		Platform:              req.Platform,
		Model:                 req.Model,
		TotalCost:             req.AccountCost,
		ActualCost:            req.UserCost,
		BilledCost:            req.UserCost,
		AccountCost:           req.AccountCost,
		RateMultiplier:        1,
		AccountRateMultiplier: 1,
		Endpoint:              "usage.record",
		UsageMetrics:          []sdk.UsageMetric{metric},
		UsageCostDetails:      []sdk.UsageCostDetail{detail},
		UsageMetadata:         metadata,
	}
	usageID, err := h.recorder.RecordSyncCharge(ctx, record)
	if err != nil {
		if errors.Is(err, billing.ErrInsufficientBalance) {
			return nil, status.Error(codes.FailedPrecondition, "余额不足，无法收取文件渲染费用")
		}
		if ent.IsConstraintError(err) {
			row, queryErr := h.db.UsageLog.Query().Where(entusagelog.RequestIDEQ(req.IdempotencyKey)).Only(ctx)
			if queryErr == nil && row.UserIDSnapshot == int(req.UserID) {
				return map[string]interface{}{"usage_id": row.ID, "usage": customUsagePayloadFromLog(row)}, nil
			}
		}
		return nil, status.Error(codes.Internal, err.Error())
	}
	return map[string]interface{}{"usage_id": usageID, "usage": customUsagePayload(record)}, nil
}

func customUsagePayloadFromLog(row *ent.UsageLog) map[string]interface{} {
	if row == nil {
		return map[string]interface{}{}
	}
	return map[string]interface{}{
		"model":              "",
		"account_cost":       row.AccountCost,
		"user_cost":          row.ActualCost,
		"billing_multiplier": 1,
		"currency":           "",
		"metrics":            row.UsageMetrics,
		"cost_details":       row.UsageCostDetails,
		"metadata":           row.UsageMetadata,
	}
}

func customUsagePayload(record billing.UsageRecord) map[string]interface{} {
	return map[string]interface{}{
		// Product usage is merged into a model request's aggregate usage. Leave
		// model empty so the chat model name remains the user-visible model.
		"model":              "",
		"account_cost":       record.AccountCost,
		"user_cost":          record.ActualCost,
		"billing_multiplier": 1,
		"currency":           "",
		"metrics":            record.UsageMetrics,
		"cost_details":       record.UsageCostDetails,
		"metadata":           record.UsageMetadata,
	}
}

// hostNotifyTopupRequest users.notify_topup 请求体。
type hostNotifyTopupRequest struct {
	UserID     int64  `json:"user_id"`
	OutTradeNo string `json:"out_trade_no"`
	// PaidAmount 实付金额（返利计算基数）；BonusAmount 套餐赠送，仅记录。
	PaidAmount  float64 `json:"paid_amount"`
	BonusAmount float64 `json:"bonus_amount"`
	// FirstTopup 调用插件视角：是否该用户首笔支付成功。
	FirstTopup bool `json:"first_topup"`
}

// notifyTopup 通用「一笔充值已入账」平台事件（当前动作：分销返利/首充加赠）。
//
// 失败语义与调用方（支付插件）的回调重试对齐：业务上不适用（功能关闭/无邀请人）
// 返回 ok；只有基础设施错误才返回 error——调用方应在订单标记完成前调用本方法，
// 失败让支付平台重试回调，配合幂等键保证不重不漏。
func (h *HostService) notifyTopup(ctx context.Context, pluginID string, req hostNotifyTopupRequest) (map[string]interface{}, error) {
	if req.UserID <= 0 {
		return nil, status.Error(codes.InvalidArgument, "user_id 必须 > 0")
	}
	if req.OutTradeNo == "" {
		return nil, status.Error(codes.InvalidArgument, "out_trade_no 必填")
	}
	if req.PaidAmount <= 0 {
		return nil, status.Error(codes.InvalidArgument, "paid_amount 必须 > 0")
	}
	slog.Info("host_service_notify_topup",
		"module", "host",
		sdk.LogFieldPluginID, pluginID,
		sdk.LogFieldUserID, req.UserID,
		"out_trade_no", req.OutTradeNo,
		"paid_amount", req.PaidAmount,
		"first_topup", req.FirstTopup,
	)
	if h.referral == nil {
		return map[string]interface{}{"handled": false}, nil
	}
	if err := h.referral.HandleTopup(ctx, appreferral.TopupEvent{
		UserID:      int(req.UserID),
		OutTradeNo:  req.OutTradeNo,
		PaidAmount:  req.PaidAmount,
		BonusAmount: req.BonusAmount,
		FirstTopup:  req.FirstTopup,
	}); err != nil {
		if cerr := hostContextError(err); cerr != nil {
			return nil, cerr
		}
		return nil, status.Error(codes.Internal, err.Error())
	}
	return map[string]interface{}{"handled": true}, nil
}

func (h *HostService) storeAsset(ctx context.Context, req hostStoreAssetRequest) (map[string]interface{}, error) {
	if req.UserID <= 0 {
		return nil, status.Error(codes.InvalidArgument, "user_id 必须 > 0")
	}
	if len(req.Data) == 0 {
		return nil, status.Error(codes.InvalidArgument, "asset data is required")
	}
	purpose, ok := parseAssetPurpose(req.Purpose)
	if !ok {
		return nil, status.Errorf(codes.InvalidArgument, "invalid purpose %q (allowed: chat/upload/generated/task-input/temp)", req.Purpose)
	}
	storage, err := NewAssetStorage(ctx, h.db)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	asset, err := storage.Store(ctx, req.UserID, purpose, req.ContentType, req.FileExtension, req.Data)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	return map[string]interface{}{
		"asset_id":     asset.ID,
		"object_key":   asset.ObjectKey,
		"public_url":   asset.PublicURL,
		"size_bytes":   asset.SizeBytes,
		"content_type": asset.ContentType,
	}, nil
}

func (h *HostService) storeAssetFromURL(ctx context.Context, req hostStoreAssetFromURLRequest) (map[string]interface{}, error) {
	if req.UserID <= 0 {
		return nil, status.Error(codes.InvalidArgument, "user_id 必须 > 0")
	}
	if req.SourceURL == "" {
		return nil, status.Error(codes.InvalidArgument, "source_url is required")
	}
	purpose, ok := parseAssetPurpose(req.Purpose)
	if !ok {
		return nil, status.Errorf(codes.InvalidArgument, "invalid purpose %q (allowed: chat/upload/generated/task-input/temp)", req.Purpose)
	}
	storage, err := NewAssetStorage(ctx, h.db)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	asset, err := storage.StoreFromURL(ctx, req.UserID, purpose, req.SourceURL)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	return map[string]interface{}{
		"asset_id":     asset.ID,
		"object_key":   asset.ObjectKey,
		"public_url":   asset.PublicURL,
		"size_bytes":   asset.SizeBytes,
		"content_type": asset.ContentType,
	}, nil
}

func (h *HostService) getAssetURL(ctx context.Context, req hostGetAssetURLRequest) (map[string]interface{}, error) {
	storage, err := NewAssetStorage(ctx, h.db)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	publicURL, err := storage.PublicURL(ctx, req.ObjectKey)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	return map[string]interface{}{"public_url": publicURL}, nil
}

func (h *HostService) getAssetBytes(ctx context.Context, req hostGetAssetBytesRequest) (map[string]interface{}, error) {
	storage, err := NewAssetStorage(ctx, h.db)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	data, contentType, err := storage.GetBytes(ctx, req.ObjectKey)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	return map[string]interface{}{"data": data, "content_type": contentType}, nil
}

func (h *HostService) deleteAsset(ctx context.Context, req hostDeleteAssetRequest) (map[string]interface{}, error) {
	if req.ObjectKey == "" {
		return nil, status.Error(codes.InvalidArgument, "object_key 不能为空")
	}
	storage, err := NewAssetStorage(ctx, h.db)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	if err := storage.Delete(ctx, req.ObjectKey); err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	return map[string]interface{}{"deleted": true}, nil
}

// protoHeadersToHTTPHost / httpHeadersToProtoHost 是 host_service.go 内部的 header 转换。
// 与 grpc/gateway_server.go 的同名函数等价，但跨包引用会引入循环依赖。
func (h *HostService) hostForwardRoutes(ctx context.Context, req hostForwardRequest) ([]routing.Candidate, string, error) {
	if req.GroupID > 0 {
		u, err := h.db.User.Query().Where(user.IDEQ(int(req.UserID))).Only(ctx)
		if err != nil {
			if cerr := hostContextError(err); cerr != nil {
				return nil, "", cerr
			}
			slog.Error("host_forward_user_lookup_failed",
				sdk.LogFieldUserID, req.UserID, sdk.LogFieldError, err)
			return nil, "", hostForwardGenericError()
		}
		g, err := h.db.Group.Get(ctx, int(req.GroupID))
		if err != nil {
			if cerr := hostContextError(err); cerr != nil {
				return nil, "", cerr
			}
			if ent.IsNotFound(err) {
				return nil, "", status.Error(codes.NotFound, "分组不存在")
			}
			slog.Error("host_forward_group_lookup_failed",
				sdk.LogFieldGroupID, req.GroupID, sdk.LogFieldError, err)
			return nil, "", hostForwardGenericError()
		}
		// 显式指定的分组平台必须与请求声明/推断的平台一致——否则调用方可以
		// 用便宜平台的分组给另一个平台的模型计费（group_id 可能来自终端用户输入）。
		// 请求侧推不出平台时（无 header 也不认识模型）放行，交给后续调度失败兜底。
		if reqPlatform := h.hostForwardRequestPlatform(req); reqPlatform != "" && !strings.EqualFold(reqPlatform, g.Platform) {
			slog.Warn("host_forward_group_platform_mismatch",
				sdk.LogFieldGroupID, req.GroupID,
				"group_platform", g.Platform,
				"request_platform", reqPlatform,
				sdk.LogFieldModel, req.Model,
			)
			return nil, "", hostForwardGenericError()
		}
		if !routing.GroupMatchesRequirements(g, hostForwardRequirements(h.manager, req)) {
			slog.Warn("host_forward_group_requirement_unmet",
				sdk.LogFieldGroupID, req.GroupID,
				sdk.LogFieldModel, req.Model,
				sdk.LogFieldPath, req.Path,
			)
			return nil, "", hostForwardGenericError()
		}
		// 显式指定 group_id 的调用同样要过专属分组授权——group_id 可能来自
		// 终端用户输入（如 studio 的分组选择器），不能默认可信。
		if g.IsExclusive {
			allowed, err := g.QueryAllowedUsers().Where(user.IDEQ(int(req.UserID))).Exist(ctx)
			if err != nil {
				if cerr := hostContextError(err); cerr != nil {
					return nil, "", cerr
				}
				slog.Error("host_forward_exclusive_check_failed",
					sdk.LogFieldGroupID, req.GroupID,
					sdk.LogFieldUserID, req.UserID,
					sdk.LogFieldError, err)
				return nil, "", hostForwardGenericError()
			}
			if !allowed {
				slog.Warn("host_forward_group_not_authorized",
					sdk.LogFieldGroupID, req.GroupID,
					sdk.LogFieldUserID, req.UserID,
				)
				return nil, "", hostForwardGenericError()
			}
		}
		return []routing.Candidate{{
			GroupID:                g.ID,
			Platform:               g.Platform,
			EffectiveRate:          billing.ResolveBillingRateForGroup(u.GroupRates, g.ID, g.RateMultiplier),
			GroupRateMultiplier:    g.RateMultiplier,
			GroupServiceTier:       g.ServiceTier,
			GroupForceInstructions: g.ForceInstructions,
			GroupPluginSettings:    clonePluginSettingsHost(g.PluginSettings),
			UserPluginSettings:     clonePluginSettingsHost(u.GroupPluginSettings[int64(g.ID)]),
			SortWeight:             g.SortWeight,
		}}, u.Email, nil
	}

	platform := h.hostForwardRequestPlatform(req)
	if platform == "" {
		return nil, "", status.Error(codes.InvalidArgument, "platform 不能为空")
	}
	u, err := h.db.User.Query().Where(user.IDEQ(int(req.UserID))).Only(ctx)
	if err != nil {
		if cerr := hostContextError(err); cerr != nil {
			return nil, "", cerr
		}
		slog.Error("host_forward_user_lookup_failed",
			sdk.LogFieldUserID, req.UserID, sdk.LogFieldError, err)
		return nil, "", hostForwardGenericError()
	}
	routes, err := routing.ListEligibleGroups(ctx, h.db, int(req.UserID), platform, u.GroupRates, u.GroupPluginSettings, hostForwardRequirements(h.manager, req))
	if err == nil {
		// 成员分组白名单：自动选组只在企业主授予的分组里挑
		routes = filterCandidatesByMemberGroups(routes, req.memberAllowedGroups)
	}
	if err != nil {
		if cerr := hostContextError(err); cerr != nil {
			return nil, "", cerr
		}
		slog.Error("host_forward_routes_lookup_failed",
			sdk.LogFieldPlatform, platform,
			sdk.LogFieldUserID, req.UserID,
			sdk.LogFieldError, err,
		)
		return nil, "", hostForwardGenericError()
	}
	if len(routes) == 0 {
		slog.Warn("host_forward_no_eligible_route",
			sdk.LogFieldPlatform, platform,
			sdk.LogFieldUserID, req.UserID,
		)
		return nil, "", hostForwardGenericError()
	}
	return routes, u.Email, nil
}

func hostForwardRequirements(mgr *Manager, req hostForwardRequest) routing.Requirements {
	return routing.Requirements{NeedsImage: requestNeedsImage(mgr, req.Path, req.Model, hostForwardBody(req.Body))}
}

// hostForwardRequestPlatform 推断请求声明的平台：优先 X-Airgate-Platform 头，
// 其次按模型名查目录。推不出时返回空串。
func (h *HostService) hostForwardRequestPlatform(req hostForwardRequest) string {
	platform := strings.TrimSpace(protoHeadersToHTTPHost(req.Headers).Get("X-Airgate-Platform"))
	if platform == "" && req.Model != "" && h.manager != nil {
		platform = h.manager.FindPlatformByModel(req.Model)
	}
	return platform
}

func hostAccountRequirements(mgr *Manager, req hostForwardRequest) scheduler.AccountRequirements {
	return accountRequirementsForRequest(mgr, req.Path, req.Model, hostForwardBody(req.Body))
}

func hostForwardReasoningEffort(req hostForwardRequest) string {
	return parseBody(hostForwardBody(req.Body), protoHeadersToHTTPHost(req.Headers).Get("Content-Type")).ReasoningEffort
}

func (h *HostService) resolveHostModel(platform, model string) string {
	if model != "" {
		return model
	}
	models := h.manager.GetModels(platform)
	if len(models) == 0 {
		return ""
	}
	return models[0].ID
}

func hostForwardHeaders(req hostForwardRequest, route routing.Candidate) http.Header {
	headers := protoHeadersToHTTPHost(req.Headers)
	headers.Del("X-Airgate-Internal")
	headers.Del("X-Airgate-Test-Mode")
	headers.Set("X-Forwarded-Path", req.Path)
	headers.Set("X-Forwarded-Method", req.Method)
	headers.Set("X-Airgate-Internal", "host-forward")
	if req.UserID > 0 {
		headers.Set("X-Airgate-User-ID", strconv.FormatInt(req.UserID, 10))
	}
	if route.GroupID > 0 {
		headers.Set("X-Airgate-Group-ID", strconv.Itoa(route.GroupID))
	}
	if headers.Get("Content-Type") == "" {
		headers.Set("Content-Type", "application/json")
	}
	if route.GroupServiceTier != "" {
		headers.Set("X-Airgate-Service-Tier", route.GroupServiceTier)
	}
	if route.GroupForceInstructions != "" {
		headers.Set("X-Airgate-Force-Instructions", route.GroupForceInstructions)
	}
	for plugin, kv := range route.GroupPluginSettings {
		for k, v := range kv {
			if v == "" || !shouldForwardPluginSetting(plugin, k) {
				continue
			}
			headers.Set("X-Airgate-Plugin-"+canonicalHeaderToken(plugin)+"-"+canonicalHeaderToken(k), v)
		}
	}
	return headers
}

func hostSDKAccount(acc *ent.Account) *sdk.Account {
	return &sdk.Account{
		ID:          int64(acc.ID),
		Name:        acc.Name,
		Platform:    acc.Platform,
		Type:        acc.Type,
		Credentials: cloneStringMapHost(acc.Credentials),
		ProxyURL:    proxyURLFromAccount(acc),
	}
}

func (h *HostService) applyHostOutcome(ctx context.Context, accountID int, accFull *ent.Account, model string, outcome sdk.ForwardOutcome, duration time.Duration, probeToken string, forwardErr error, rpmReserved bool) bool {
	if hostForwardContextError(ctx, forwardErr) != nil {
		if rpmReserved {
			h.scheduler.DecrementRPM(context.Background(), accountID)
		}
		h.releaseHostFamilyProbe(accountID, accFull.Platform, model, probeToken)
		return false
	}
	reason := outcome.Reason
	if outcome.Kind.IsAccountFault() && model != "" {
		reason = "[" + model + "] " + reason
	}
	h.scheduler.Apply(ctx, accountID, scheduler.Judgment{
		Kind:           outcome.Kind,
		RetryAfter:     outcome.RetryAfter,
		Reason:         reason,
		Duration:       duration,
		IsPool:         accFull.UpstreamIsPool,
		UpstreamStatus: outcome.Upstream.StatusCode,
		Family:         h.resolveModelFamily(accFull.Platform, model),
		ProbeToken:     probeToken,
	})
	return true
}

func (h *HostService) releaseHostFamilyProbe(accountID int, platform, model, probeToken string) {
	if h == nil || h.scheduler == nil || accountID <= 0 || probeToken == "" {
		return
	}
	h.scheduler.ReleaseFamilyProbe(context.Background(), accountID, platform, model, probeToken)
}

func (h *HostService) recordCanceledHostForwardUsage(
	req hostForwardRequest,
	route routing.Candidate,
	accountID int,
	platform, model string,
	accFull *ent.Account,
	userEmail string,
	outcome sdk.ForwardOutcome,
	duration time.Duration,
	status int,
) {
	if outcome.Usage == nil || h == nil || h.calculator == nil || h.recorder == nil {
		return
	}
	settleCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	failure := canceledRequestFailure(status)
	if _, err := h.recordHostForwardUsageWithFailure(settleCtx, req, route, accountID, platform, model, accFull, userEmail, outcome, duration, &failure); err != nil {
		slog.Error("host_forward_record_canceled_usage_failed",
			sdk.LogFieldUserID, req.UserID,
			sdk.LogFieldAccountID, accountID,
			sdk.LogFieldError, err,
		)
	}
}

func (h *HostService) persistHostUpdatedCredentials(accountID int, updated map[string]string) {
	if h == nil || h.db == nil || accountID <= 0 || len(updated) == 0 {
		return
	}
	credentials := cloneStringMapHost(updated)
	go h.updateHostAccountCredentials(accountID, credentials)
}

func (h *HostService) updateHostAccountCredentials(accountID int, updated map[string]string) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	acc, err := h.db.Account.Query().Where(account.IDEQ(accountID)).Only(ctx)
	if err != nil {
		slog.Error("host_forward_update_credentials_lookup_failed",
			sdk.LogFieldAccountID, accountID, sdk.LogFieldError, err)
		return
	}
	merged := cloneStringMapHost(acc.Credentials)
	if merged == nil {
		merged = make(map[string]string, len(updated))
	}
	for key, value := range updated {
		merged[key] = value
	}
	if err := h.db.Account.UpdateOneID(accountID).SetCredentials(merged).Exec(ctx); err != nil {
		slog.Error("host_forward_update_credentials_failed",
			sdk.LogFieldAccountID, accountID, sdk.LogFieldError, err)
	}
}

// resolveModelFamily 从插件目录优先获取家族键，未命中时回退到硬编码规则。
func (h *HostService) resolveModelFamily(platform, model string) string {
	if h.manager != nil {
		if family := h.manager.ModelFamily(model); family != "" {
			return family
		}
	}
	return scheduler.ModelFamily(platform, model)
}

// isHostMetadataOnlyPath 复用 Manager 的 metadata_only 路径索引（插件在 RouteDefinition.Metadata
// 里声明），让 Host 转发与 Forwarder 对"只读元信息"的判断保持同一口径。
func (h *HostService) isHostMetadataOnlyPath(path string) bool {
	if h.manager == nil || strings.TrimSpace(path) == "" {
		return false
	}
	return h.manager.IsMetadataOnlyRoute(path)
}

func (h *HostService) checkHostForwardBalance(ctx context.Context, userID int64) error {
	u, err := h.db.User.Query().Where(user.IDEQ(int(userID))).Only(ctx)
	if err != nil {
		if cerr := hostContextError(err); cerr != nil {
			return cerr
		}
		if ent.IsNotFound(err) {
			return status.Error(codes.NotFound, "用户不存在")
		}
		slog.Error("host_forward_balance_check_user_lookup_failed",
			sdk.LogFieldUserID, userID, sdk.LogFieldError, err)
		return hostForwardGenericError()
	}
	if u.Balance <= 0 {
		return hostForwardInsufficientQuotaError()
	}
	return nil
}

// checkHostForwardBalanceOrReplay 余额前置门禁只拦"新提交"。
//
// 钉选账号的转发（AccountID>0）是异步任务提交后的后续动作——查询进度 / 取产物 / 结算——
// 上游成本在提交那一刻已经发生,钱的决定已经做过;这里再按余额拦,只会把已生成的产物
// 卡在门外:2026-09-04 用户 6978 充 $50 连出三条 Seedance 视频后余额转负,第二条视频
// 的结算轮询被本门禁拒了一小时(ResourceExhausted 刷屏),任务最终超时失败——用户没拿到
// 视频、上游成本白付、账也没记。故钉选后续一律放行,结算像 API 转发一样允许扣成负数;
// 余额是否够用由提交时(非钉选路径)的检查负责。
// 已记账的请求重放同样放行(幂等 usage 命中),整段上下文校验防止复用 request_id 绕过配额。
func (h *HostService) checkHostForwardBalanceOrReplay(ctx context.Context, req hostForwardRequest) error {
	requestID := strings.TrimSpace(req.RequestID)
	platform := h.hostForwardRequestPlatform(req)
	if requestID != "" && req.AccountID > 0 && platform != "" && strings.TrimSpace(req.Model) != "" {
		// 幂等/冲突校验照旧：同一 request_id 换了计费上下文必须拒绝,已记账则直接放行。
		req.RequestID = requestID
		if _, found, err := h.existingHostForwardUsageID(ctx, req, platform, req.Model); err != nil {
			return err
		} else if found {
			return nil
		}
	}
	if req.AccountID > 0 {
		return nil
	}
	return h.checkHostForwardBalance(ctx, req.UserID)
}

func hostForwardGenericError() error {
	return status.Error(codes.Unavailable, "请求暂时无法完成，请稍后重试")
}

func hostContextError(err error) error {
	switch {
	case errors.Is(err, context.Canceled):
		return status.Error(codes.Canceled, err.Error())
	case errors.Is(err, context.DeadlineExceeded):
		return status.Error(codes.DeadlineExceeded, err.Error())
	default:
		return nil
	}
}

func hostForwardContextError(ctx context.Context, forwardErr error) error {
	if ctx != nil {
		if cerr := hostContextError(ctx.Err()); cerr != nil {
			return cerr
		}
	}

	// 插件返回取消意味着调用方已经断开；而单次上游超时仍可切换到下一个账号。
	// 当总转发上下文的截止时间真正耗尽时，才把 DeadlineExceeded 视为请求终止。
	forwardCode := status.Code(forwardErr)
	if errors.Is(forwardErr, context.Canceled) || forwardCode == codes.Canceled {
		return status.Error(codes.Canceled, forwardErr.Error())
	}
	if (!errors.Is(forwardErr, context.DeadlineExceeded) && forwardCode != codes.DeadlineExceeded) || ctx == nil {
		return nil
	}
	if deadline, ok := ctx.Deadline(); ok && !time.Now().Before(deadline) {
		return status.Error(codes.DeadlineExceeded, forwardErr.Error())
	}
	return nil
}

func hostCanceledRequestStatus(ctx context.Context, forwardErr error) int {
	if status := canceledRequestStatus(forwardErr); status != 0 {
		return status
	}
	if ctx != nil {
		return canceledRequestStatus(ctx.Err())
	}
	return 0
}

func hostForwardClientError(outcome sdk.ForwardOutcome, scrubber *identityScrubber) error {
	return status.Error(codes.InvalidArgument, sanitizedClientErrorMessage(outcome, scrubber))
}

// hostForwardPayload 回给插件的上游响应。4xx 体会经 identityScrubber 剥供应商标识——
// 插件（工作坊 / AI Chat）通常把这段文案直接展示给用户。
// 成功响应体一律不动：插件要从里面解析任务 ID、素材 URL 等，清洗会把功能改坏。
func hostForwardPayload(outcome sdk.ForwardOutcome, scrubber *identityScrubber) map[string]interface{} {
	body := outcome.Upstream.Body
	headers := outcome.Upstream.Headers
	if scrubber != nil && outcome.Upstream.StatusCode >= http.StatusBadRequest && len(body) > 0 {
		if cleaned, ok := scrubber.scrubErrorBody(body); ok && !bytes.Equal(cleaned, body) {
			body = cleaned
			// body 变了，上游描述原始长度的头就过期了。插件若把这份头原样写出，
			// net/http 会按旧 Content-Length 拒写或截断——正是 2026-08-29 CF 520 的形状。
			headers = headers.Clone()
			headers.Del("Content-Length")
			headers.Del("Transfer-Encoding")
		}
	}
	return map[string]interface{}{
		"status_code": outcome.Upstream.StatusCode,
		"headers":     httpHeadersToProtoHost(headers),
		"body":        string(body),
	}
}

func hostForwardInsufficientQuotaError() error {
	return status.Error(codes.ResourceExhausted, "余额不足")
}

func protoHeadersToHTTPHost(ph map[string]interface{}) http.Header {
	h := make(http.Header, len(ph))
	for k, v := range ph {
		switch values := v.(type) {
		case []string:
			h[k] = append([]string(nil), values...)
		case []interface{}:
			for _, item := range values {
				h.Add(k, fmt.Sprint(item))
			}
		case map[string]interface{}:
			if raw, ok := values["values"]; ok {
				switch vv := raw.(type) {
				case []interface{}:
					for _, item := range vv {
						h.Add(k, fmt.Sprint(item))
					}
				case []string:
					h[k] = append([]string(nil), vv...)
				case string:
					h.Set(k, vv)
				}
			}
		case string:
			h.Set(k, values)
		default:
			if v != nil {
				h.Set(k, fmt.Sprint(v))
			}
		}
	}
	return h
}

func httpHeadersToProtoHost(h http.Header) map[string]interface{} {
	ph := make(map[string]interface{}, len(h))
	for k, v := range h {
		ph[k] = append([]string(nil), v...)
	}
	return ph
}

func hostForwardBody(raw interface{}) []byte {
	switch v := raw.(type) {
	case nil:
		return nil
	case []byte:
		return v
	case string:
		return []byte(v)
	case json.RawMessage:
		return []byte(v)
	default:
		body, _ := json.Marshal(v)
		return body
	}
}

func mustHostPayload(payload map[string]interface{}) []byte {
	data, err := json.Marshal(payload)
	if err != nil {
		return []byte(`{"error":"payload encode failed"}`)
	}
	return data
}

// errProbeResp 构造一个失败的 probe response（不通过 gRPC error 返回，
// 让插件能拿到 latency_ms 和 error_kind 写入自己的 health 表）。
func errProbeResp(kind, msg string, start time.Time) map[string]interface{} {
	return map[string]interface{}{
		"success":    false,
		"error_kind": kind,
		"error_msg":  truncateProbeErr(msg),
		"latency_ms": time.Since(start).Milliseconds(),
	}
}

// pickRoutableModel 从当前分组可见且 scheduler 实际允许的模型中选一个。
// 分组没有 model_routing 时保留历史行为，使用目录第一项；配置了路由时，
// 精确规则和 glob 的展开语义与模型列表收敛、scheduler 完全一致。
func pickRoutableModel(models []sdk.ModelInfo, routing map[string][]int64) string {
	if len(routing) == 0 {
		for _, model := range models {
			if id := strings.TrimSpace(model.ID); id != "" {
				return id
			}
		}
		return ""
	}

	catalogIDs := make([]string, 0, len(models))
	for _, model := range models {
		if id := strings.TrimSpace(model.ID); id != "" {
			catalogIDs = append(catalogIDs, id)
		}
	}
	for _, id := range visibleModelIDsForRouting(routing, catalogIDs) {
		if scheduler.ModelRoutingServes(routing, id) {
			return id
		}
	}
	return ""
}

// pickProbeModelForRouting 从当前分组可路由的模型中选探测模型。
// 优先非图片模型（最小 chat 请求近乎零成本）；纯生图分组退而选生图模型
// （最小 1K 生成请求，isImage=true，探测方按成本节流）——此前直接返回空，
// 生图分组永远 no_model 零监控（2026-08-22 审计盲区，2026-08-29 组18/组23
// 事故均因无监控靠人肉翻库发现）。视频/音频等重媒体模型永不入选。
// 直接使用 ModelInfo.HasCapability 判断，无需经过 Manager 全局查找。
func pickProbeModelForRouting(models []sdk.ModelInfo, routing map[string][]int64) (model string, isImage bool) {
	for _, m := range models {
		if scheduler.ModelRoutingServes(routing, m.ID) && !m.HasCapability(sdk.ModelCapImageGeneration) {
			return m.ID, false
		}
	}
	var imageCandidates []string
	for _, m := range models {
		if !scheduler.ModelRoutingServes(routing, m.ID) || !m.HasCapability(sdk.ModelCapImageGeneration) {
			continue
		}
		if m.HasCapability(sdk.ModelCapVideoGeneration) || m.HasCapability(sdk.ModelCapAudioGeneration) {
			continue
		}
		imageCandidates = append(imageCandidates, m.ID)
	}
	if len(imageCandidates) == 0 {
		return "", false
	}
	// 按名字启发式挑便宜档（lite > flash > 其余第一个）。
	for _, keyword := range []string{"lite", "flash"} {
		for _, id := range imageCandidates {
			if strings.Contains(strings.ToLower(id), keyword) {
				return id, true
			}
		}
	}
	return imageCandidates[0], true
}

// truncateProbeErr 限制 error_msg 长度，避免巨型上游错误体污染探测表。
func truncateProbeErr(s string) string {
	const max = 512
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}

// cloneStringMapHost / proxyURLFromAccount 是 host_service.go 内部独立的小 helper。
// 与 internal/app/account/service.go 里的同名 helper 重复，但跨包引用 service 层
// 会引入循环依赖（service 层依赖 plugin 包），所以这里复制一份。

func cloneStringMapHost(input map[string]string) map[string]string {
	if input == nil {
		return nil
	}
	cloned := make(map[string]string, len(input))
	for k, v := range input {
		cloned[k] = v
	}
	return cloned
}

func clonePluginSettingsHost(input map[string]map[string]string) map[string]map[string]string {
	if len(input) == 0 {
		return nil
	}
	cloned := make(map[string]map[string]string, len(input))
	for plugin, settings := range input {
		if len(settings) == 0 {
			continue
		}
		cloned[plugin] = cloneStringMapHost(settings)
	}
	return cloned
}

// proxyURLFromAccount 从 ent.Account 的 proxy edge 拼装 proxy URL。
// 与 account.buildProxyURL 等价，但接收 ent.Proxy 而非 service.Proxy。
func proxyURLFromAccount(a *ent.Account) string {
	if a == nil || a.Edges.Proxy == nil {
		return ""
	}
	p := a.Edges.Proxy
	if p.Username != "" {
		return fmt.Sprintf("%s://%s:%s@%s:%d", p.Protocol, p.Username, p.Password, p.Address, p.Port)
	}
	return fmt.Sprintf("%s://%s:%d", p.Protocol, p.Address, p.Port)
}
