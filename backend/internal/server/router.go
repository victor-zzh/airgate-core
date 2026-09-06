package server

import (
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/DouDOU-start/airgate-core/internal/plugin"
	"github.com/DouDOU-start/airgate-core/internal/server/blogssr"
	"github.com/DouDOU-start/airgate-core/internal/server/middleware"
	"github.com/DouDOU-start/airgate-core/internal/setup"
	webfs "github.com/DouDOU-start/airgate-core/internal/web"
)

// defaultStatusPluginName 公开状态页反代目标插件的默认值；
// 可经 config `plugins.status_plugin` 覆盖，core 不绑定具体插件实现。
const defaultStatusPluginName = "airgate-health"

// 注册/发码的每 IP 限额。注册是低频动作（正常用户一生一次），额度留给
// "一家人或一间办公室共用出口 IP" 这类真实场景够用，对脚本批量注册则是硬墙。
const (
	registerPerHourPerIP = 5.0
	registerBurstPerIP   = 5
)

// registerRoutes 注册所有 API 路由
func (s *Server) registerRoutes() {
	r := s.engine
	handlers := s.handlers

	// 全局中间件：CORS → Recovery → RequestLogger → I18n → 业务
	r.Use(middleware.CORS(middleware.CORSConfig{
		// 控制台/管理面（/api/**）默认不设置 AllowOrigins，仅同源可访问。
		// 如需跨域请配置具体来源，例如：AllowOrigins: []string{"https://example.com"}
		//
		// 其余路径为公开数据面（/v1/messages 等网关端点，经 NoRoute 分发无法
		// 单独注册 OPTIONS）：任意来源可跨域，供浏览器端 SDK / 网页工具直连。
		AdminPathPrefix: "/api",
	}))
	r.Use(middleware.Recovery())
	r.Use(middleware.RequestLogger())
	r.Use(middleware.I18n())

	// 健康检查（无需认证，供 docker / k8s healthcheck 使用）
	r.GET("/healthz", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok"})
	})

	// 签名媒体中继（无需认证，token 自带 HMAC 签名与时效；见 plugin/relay.go）
	relayHandler := func(c *gin.Context) {
		rs := s.pluginMgr.RelayService()
		if rs == nil {
			c.JSON(503, gin.H{"error": gin.H{"message": "relay 服务未启用", "type": "relay_error"}})
			return
		}
		rs.ServeHTTP(c.Writer, c.Request, c.Param("token"))
	}
	r.GET(plugin.RelayPublicPrefix+"/:token", relayHandler)
	r.HEAD(plugin.RelayPublicPrefix+"/:token", relayHandler)

	// 安装向导路由（无需认证）
	setup.RegisterRoutes(r)

	// API v1 路由组
	v1 := r.Group("/api/v1")

	// === 公共路由（无需认证） ===
	v1.GET("/settings/public", handlers.Settings.GetPublicSettings)
	// 公开模型定价：官网价格页数据源（模型目录 price.* + 覆盖层合并，仅公开字段）
	v1.GET("/models/pricing", handlers.Plugin.PublicModelPricing)
	// 公开邀请码解析：注册页/落地页据此渲染访客侧「官方推广」认证条（不暴露隐私）
	v1.GET("/referral/resolve", handlers.Referral.Resolve)

	// === 认证路由（无需 JWT） ===
	//
	// 基于客户端 IP 的速率限制（10 req/min），防止暴力破解和验证码滥用。
	// 替代原来依赖 CtxKeyUserID 的用户级限流（登录前无 user_id，实际空转已移除）。
	authGroup := v1.Group("/auth")
	ipRL := middleware.NewIPRateLimit(10)
	s.ipRateLimiter = ipRL.Limiter
	authGroup.Use(ipRL.Handler)
	{
		authGroup.POST("/login", handlers.Auth.Login)
		authGroup.POST("/login-apikey", handlers.Auth.LoginByAPIKey)
		// 注册与验证码发送额外挂一层按小时计的严格限流。
		// /auth 组的 10 次/分钟拦不住批量注册：2026-08 的攻击用 12~15 秒一个的节奏
		// （约 4 次/分钟）合法绕过，两天在两个实例上刷出 1.4 万个账号。
		regRL := middleware.NewIPRateLimitPerHour(registerPerHourPerIP, registerBurstPerIP)
		s.registerRateLimiter = regRL.Limiter
		authGroup.POST("/register", regRL.Handler, handlers.Auth.Register)
		authGroup.POST("/send-verify-code", regRL.Handler, handlers.Auth.SendVerifyCode)
		authGroup.POST("/verify-code", handlers.Auth.VerifyCode)
		// 第三方登录（Google / GitHub）：浏览器导航端点，走重定向
		authGroup.GET("/oauth/:provider/authorize", handlers.Auth.OAuthAuthorize)
		authGroup.GET("/oauth/:provider/callback", handlers.Auth.OAuthCallback)
	}

	// Token 刷新（独立于 JWT 中间件，允许过期 token 刷新）
	v1.POST("/auth/refresh", handlers.Auth.RefreshToken)

	// === 用户路由（需要 JWT 认证） ===
	userGroup := v1.Group("")
	userGroup.Use(middleware.JWTUserAuth(s.jwtMgr, s.db))
	{
		// 模型广场同时支持普通账号和受限 API Key 登录；API Key 报价由 handler
		// 按 JWT 中的 api_key_id 限定到当前 Key 的分组和模型。
		userGroup.GET("/models/pricing/me", middleware.RequireRoles("admin", "user", "api_key"), handlers.ModelPricing.MyModelPricing)

		accountGroup := userGroup.Group("")
		accountGroup.Use(middleware.RequireRoles("admin", "user"))

		// 用户资料
		userGroup.GET("/users/me", handlers.User.GetMe)
		accountGroup.PUT("/users/me", handlers.User.UpdateProfile)
		accountGroup.POST("/users/me/password", handlers.User.ChangePassword)
		accountGroup.PUT("/users/me/balance-alert", handlers.User.UpdateBalanceAlert)
		accountGroup.GET("/users/me/balance-history", handlers.User.GetMyBalanceHistory)

		// 团队成员（企业子账号）：主账号侧增删改、分配额度、重置本期。
		// 企业客户专属能力,须管理员授予 is_enterprise_owner(管理员天然可用)。
		memberGroup := accountGroup.Group("")
		memberGroup.Use(middleware.RequireEnterpriseOwner(s.db))
		memberGroup.GET("/members", handlers.Member.ListMembers)
		memberGroup.POST("/members", handlers.Member.CreateMember)
		memberGroup.PUT("/members/:id", handlers.Member.UpdateMember)
		memberGroup.DELETE("/members/:id", handlers.Member.DeleteMember)
		memberGroup.POST("/members/:id/reset-period", handlers.Member.ResetMemberPeriod)

		// API Key 管理
		accountGroup.GET("/api-keys", handlers.APIKey.ListKeys)
		accountGroup.POST("/api-keys", handlers.APIKey.CreateKey)
		accountGroup.PUT("/api-keys/:id", handlers.APIKey.UpdateKey)
		accountGroup.DELETE("/api-keys/:id", handlers.APIKey.DeleteKey)
		accountGroup.GET("/api-keys/:id/reveal", handlers.APIKey.RevealKey)

		// 一键接入（Claude Code）：签发一次性接入令牌 + 轮询接入状态
		accountGroup.POST("/oneclick/setup-token", handlers.OneClick.IssueSetupToken)
		accountGroup.GET("/oneclick/setup-token/:token", handlers.OneClick.SetupTokenStatus)

		// 分销邀请：我的邀请码/概览 + 返利流水
		accountGroup.GET("/referral/me", handlers.Referral.MyReferral)
		accountGroup.GET("/referral/commissions", handlers.Referral.MyCommissions)
		// 已发布文章清单（「分享文章」软入口:拼 <blog>/blog/<slug>?inv=<我的码> 分发)。
		// 官方推广官专属能力,路由级加 official 校验,与前端 InvitePage isOfficial gate 一致。
		accountGroup.GET("/blog/articles", middleware.RequireOfficialPromoter(s.db), handlers.Blog.ListPublishedArticles)

		// 分组
		accountGroup.GET("/groups", handlers.Group.ListAvailableGroups)

		// 订阅
		accountGroup.GET("/subscriptions", handlers.Subscription.UserSubscriptions)
		accountGroup.GET("/subscriptions/active", handlers.Subscription.ActiveSubscriptions)
		accountGroup.GET("/subscriptions/progress", handlers.Subscription.SubscriptionProgress)

		// 使用记录
		userGroup.GET("/usage", handlers.Usage.UserUsage)
		userGroup.GET("/usage/stats", handlers.Usage.UserUsageStats)
		userGroup.GET("/usage/trend", handlers.Usage.UserUsageTrend)
		userGroup.GET("/usage/export", handlers.Usage.UserUsageExport)

		// 插件菜单（精简元信息：仅返回 name + frontend_pages，普通账号会话可访问，
		// 用于前端 AppShell 渲染插件提供的页面菜单项）
		accountGroup.GET("/plugins/menu", handlers.Plugin.ListPluginMenu)
	}

	// === 博客后台（允许 admin 或被授予 can_author_blog 的营销/运营用户） ===
	blogAuthorGroup := v1.Group("/admin")
	blogAuthorGroup.Use(middleware.JWTAuth(s.jwtMgr, s.db), middleware.RequireBlogAuthor(s.db))
	{
		blogAuthorGroup.GET("/blog/posts", handlers.Blog.ListBlogPosts)
		blogAuthorGroup.POST("/blog/posts", handlers.Blog.CreateBlogPost)
		blogAuthorGroup.GET("/blog/posts/:id", handlers.Blog.GetBlogPost)
		blogAuthorGroup.PUT("/blog/posts/:id", handlers.Blog.UpdateBlogPost)
		blogAuthorGroup.DELETE("/blog/posts/:id", handlers.Blog.DeleteBlogPost)
		// 正文/封面图片上传（TipTap）：走 AssetStorage，需 *ent.Client 故为 Server 方法
		blogAuthorGroup.POST("/blog/upload", s.handleBlogImageUpload)
	}

	// === 管理员路由（需要管理员 JWT + AdminOnly，支持 admin- 管理员 API Key） ===
	adminGroup := v1.Group("/admin")
	adminGroup.Use(middleware.JWTAuth(s.jwtMgr, s.db), middleware.AdminOnly())
	{
		// 用户管理
		adminGroup.GET("/users", handlers.User.ListUsers)
		adminGroup.POST("/users", handlers.User.CreateUser)
		adminGroup.PUT("/users/:id", handlers.User.UpdateUser)
		adminGroup.DELETE("/users/:id", handlers.User.DeleteUser)
		adminGroup.PATCH("/users/:id/toggle", handlers.User.ToggleUserStatus)
		adminGroup.POST("/users/:id/balance", handlers.User.AdjustBalance)
		adminGroup.GET("/users/:id/balance-history", handlers.User.GetUserBalanceHistory)
		adminGroup.GET("/users/:id/api-keys", handlers.User.AdminListUserKeys)

		// 分销管理（营销）：推广官汇总/全量流水/回冲/用户级比例覆盖
		adminGroup.GET("/referral/summary", handlers.Referral.AdminSummary)
		adminGroup.GET("/referral/commissions", handlers.Referral.AdminCommissions)
		adminGroup.POST("/referral/commissions/:id/reverse", handlers.Referral.ReverseCommission)
		adminGroup.PUT("/referral/users/:id/rate", handlers.Referral.SetUserReferralRate)
		adminGroup.PUT("/referral/users/:id/promoter", handlers.Referral.SetPromoter)

		// 账号管理
		adminGroup.GET("/accounts", handlers.Account.ListAccounts)
		adminGroup.GET("/accounts/usage", handlers.Account.GetAccountUsage)
		adminGroup.GET("/accounts/export", handlers.Account.ExportAccounts)
		adminGroup.POST("/accounts/import", handlers.Account.ImportAccounts)
		adminGroup.POST("/accounts/bulk-update", handlers.Account.BulkUpdateAccounts)
		adminGroup.POST("/accounts/bulk-delete", handlers.Account.BulkDeleteAccounts)
		adminGroup.POST("/accounts/bulk-clear-family-cooldowns", handlers.Account.BulkClearFamilyCooldowns)
		adminGroup.POST("/accounts/bulk-refresh-quota", handlers.Account.BulkRefreshQuota)
		adminGroup.POST("/accounts", handlers.Account.CreateAccount)
		adminGroup.PUT("/accounts/:id", handlers.Account.UpdateAccount)
		adminGroup.DELETE("/accounts/:id", handlers.Account.DeleteAccount)
		adminGroup.POST("/accounts/:id/test", handlers.Account.TestAccount)
		adminGroup.PATCH("/accounts/:id/toggle", handlers.Account.ToggleScheduling)
		adminGroup.DELETE("/accounts/:id/family-cooldowns", handlers.Account.ClearFamilyCooldowns)
		adminGroup.GET("/accounts/:id/models", handlers.Account.GetAccountModels)
		adminGroup.GET("/accounts/:id/usage", handlers.Account.GetSingleAccountUsage)
		adminGroup.GET("/accounts/credentials-schema/:platform", handlers.Account.GetCredentialsSchema)
		adminGroup.POST("/accounts/:id/refresh-quota", handlers.Account.RefreshQuota)
		adminGroup.GET("/accounts/:id/stats", handlers.Account.GetAccountStats)

		// 账号异常事件（异常监控页）
		adminGroup.GET("/account-events", handlers.AccountEvent.ListAccountEvents)

		// 生成任务监控（仅管理员，只读）
		adminGroup.GET("/generation-tasks", handlers.GenerationTask.ListGenerationTasks)
		adminGroup.GET("/generation-tasks/summary", handlers.GenerationTask.GenerationTaskSummary)

		// 博客后台路由已上移至 blogAuthorGroup(允许 admin 或 can_author_blog)

		// 分组管理
		// 价格总览：分组标准价 × 成本 × 专属客户价，一张表看全「谁按什么价」
		adminGroup.GET("/pricing/overview", handlers.Pricing.Overview)
		adminGroup.GET("/groups", handlers.Group.ListGroups)
		adminGroup.POST("/groups", handlers.Group.CreateGroup)
		adminGroup.GET("/groups/:id", handlers.Group.GetGroup)
		adminGroup.PUT("/groups/:id", handlers.Group.UpdateGroup)
		adminGroup.DELETE("/groups/:id", handlers.Group.DeleteGroup)

		// 分组专属倍率管理（reverse 视角：某个分组下哪些用户有专属倍率）
		adminGroup.GET("/groups/:id/rate-overrides", handlers.User.ListGroupRateOverrides)
		adminGroup.PUT("/groups/:id/rate-overrides/:userId", handlers.User.SetGroupRateOverride)
		adminGroup.DELETE("/groups/:id/rate-overrides/:userId", handlers.User.DeleteGroupRateOverride)

		// API 密钥管理（管理员）
		adminGroup.GET("/api-keys", handlers.APIKey.AdminListKeys)
		adminGroup.PUT("/api-keys/:id", handlers.APIKey.AdminUpdateKey)

		// 订阅管理
		adminGroup.GET("/subscriptions", handlers.Subscription.AdminListSubscriptions)
		adminGroup.POST("/subscriptions/assign", handlers.Subscription.AdminAssign)
		adminGroup.POST("/subscriptions/bulk-assign", handlers.Subscription.AdminBulkAssign)
		adminGroup.PUT("/subscriptions/:id/adjust", handlers.Subscription.AdminAdjust)

		// 代理池管理
		adminGroup.GET("/proxies", handlers.Proxy.ListProxies)
		adminGroup.POST("/proxies", handlers.Proxy.CreateProxy)
		adminGroup.PUT("/proxies/:id", handlers.Proxy.UpdateProxy)
		adminGroup.DELETE("/proxies/:id", handlers.Proxy.DeleteProxy)

		// 客户入口码(香港直连入口 direct.hop-base.com/c/<码>/ 区分客户;仅管理员)
		adminGroup.GET("/entry-codes", handlers.EntryCode.ListEntryCodes)
		adminGroup.POST("/entry-codes", handlers.EntryCode.CreateEntryCode)
		adminGroup.PUT("/entry-codes/:code", handlers.EntryCode.UpdateEntryCode)
		adminGroup.DELETE("/entry-codes/:code", handlers.EntryCode.DeleteEntryCode)
		adminGroup.POST("/proxies/:id/test", handlers.Proxy.TestProxy)

		// 使用记录（管理员）
		adminGroup.GET("/usage", handlers.Usage.AdminUsage)
		adminGroup.GET("/usage/stats", handlers.Usage.AdminUsageStats)
		adminGroup.GET("/usage/trend", handlers.Usage.AdminUsageTrend)

		// 插件管理
		adminGroup.GET("/plugins", handlers.Plugin.ListPlugins)
		// 各网关平台当前生效的内置模型目录（模型目录编辑器种子数据）
		adminGroup.GET("/models/builtin", handlers.Plugin.BuiltinModelCatalog)
		adminGroup.GET("/plugins/:name/config", handlers.Plugin.GetPluginConfig)
		adminGroup.PUT("/plugins/:name/config", handlers.Plugin.UpdatePluginConfig)
		adminGroup.POST("/plugins/upload", handlers.Plugin.UploadPlugin)
		adminGroup.POST("/plugins/install-github", handlers.Plugin.InstallFromGithub)
		adminGroup.POST("/plugins/:name/uninstall", handlers.Plugin.UninstallPlugin)
		adminGroup.POST("/plugins/:name/reload", handlers.Plugin.ReloadPlugin)
		adminGroup.Any("/plugins/:name/rpc/*action", handlers.Plugin.ProxyRequest)

		// 插件市场
		adminGroup.GET("/marketplace/plugins", handlers.Plugin.ListMarketplace)
		adminGroup.POST("/marketplace/refresh", handlers.Plugin.RefreshMarketplace)

		// 系统设置
		adminGroup.GET("/settings", handlers.Settings.GetSettings)
		adminGroup.PUT("/settings", handlers.Settings.UpdateSettings)
		adminGroup.POST("/settings/test-smtp", handlers.Settings.TestSMTP)
		adminGroup.POST("/settings/upload", handlers.Settings.UploadFile)

		// 管理员 API Key
		adminGroup.GET("/settings/admin-api-key", handlers.Settings.GetAdminAPIKey)
		adminGroup.POST("/settings/admin-api-key", handlers.Settings.GenerateAdminAPIKey)
		adminGroup.DELETE("/settings/admin-api-key", handlers.Settings.DeleteAdminAPIKey)

		// 仪表盘（管理员）
		adminGroup.GET("/dashboard/stats", handlers.Dashboard.Stats)
		adminGroup.GET("/dashboard/trend", handlers.Dashboard.Trend)

		// core 版本信息（仅管理员可见，避免对外暴露版本指纹）
		adminGroup.GET("/version", handlers.Version.GetVersion)

		// 中继检测（管理员）
		adminGroup.POST("/relay-detections", handlers.RelayDetection.Create)
		adminGroup.GET("/relay-detections", handlers.RelayDetection.List)
		adminGroup.GET("/relay-detections/:id", handlers.RelayDetection.Get)
		adminGroup.POST("/relay-detections/:id/cancel", handlers.RelayDetection.Cancel)
		adminGroup.POST("/relay-detections/:id/retest", handlers.RelayDetection.Retest)

		// 系统更新（仅管理员；run 接口在 systemd 模式下生效，Docker 模式只返回升级指令）
		adminGroup.GET("/upgrade/info", handlers.Upgrade.GetInfo)
		adminGroup.GET("/upgrade/status", handlers.Upgrade.GetStatus)
		adminGroup.POST("/upgrade/run", handlers.Upgrade.Run)
	}

	// === Extension 插件 API 路由（JWT 认证 + 管理员权限，支持 admin- 管理员 API Key） ===
	extGroup := r.Group("/api/v1/ext")
	extGroup.Use(middleware.JWTAuth(s.jwtMgr, s.db), middleware.AdminOnly())
	{
		extGroup.Any("/:pluginName/*path", s.extensionProxy.Handle)
	}

	// === Extension 插件用户级 API 路由（仅 JWT，普通用户可访问） ===
	// 用于支付插件等面向用户的扩展，让普通用户能调用插件接口（创建充值订单、查询自己订单等）。
	// 插件需自行根据 X-Airgate-User-ID 头识别用户，并校验数据归属。
	extUserGroup := r.Group("/api/v1/ext-user")
	extUserGroup.Use(middleware.JWTAuth(s.jwtMgr), middleware.RequireRoles("admin", "user"))
	{
		extUserGroup.Any("/:pluginName/*path", s.extensionProxy.Handle)
	}

	// === 支付回调路由（无需认证，由插件自行验签） ===
	// 第三方支付平台异步通知（epay/支付宝/微信等）通过此路径转发到对应插件。
	r.Any("/api/v1/payment-callback/:pluginName/*path", s.extensionProxy.Handle)

	// === 公开状态页路由 ===
	// 设计：core 完全不维护一份状态页前端，所有 /status* 请求一律反代到
	// 状态页插件（config `plugins.status_plugin`，默认 airgate-health），由插件内部
	// standalone 打包的 status.html + status-XXX.js 渲染。这样状态页的 UI / 数据 /
	// 粒度都由健康监控插件单点维护，避免 core 与插件出现两份重复实现（之前 core
	// 自己有个 React StatusPage 组件并维护 90 天日级方格图，与 health 插件的
	// standalone 页严重重复，移除）。
	//
	// 反代规则：
	//   - GET /status            → 插件看到 /        → handlePublicIndex 返回 status.html
	//   - GET /status/*path      → 插件看到 /<path> → API + 静态资源
	statusPluginName := s.cfg.Plugins.StatusPlugin
	if statusPluginName == "" {
		statusPluginName = defaultStatusPluginName
	}
	statusProxy := s.extensionProxy.HandleNamed(statusPluginName, "public")

	// 加载嵌入的前端 SPA：所有静态资源通过 //go:embed 打进二进制
	distFS, err := webfs.FS()
	if err != nil {
		slog.Error("加载嵌入前端失败", "error", err)
		os.Exit(1)
	}
	indexHTML, _ := webfs.IndexHTML()
	assetsFS, err := fs.Sub(distFS, "assets")
	if err != nil {
		slog.Error("嵌入前端缺少 assets 子目录", "error", err)
		os.Exit(1)
	}

	// /status 与 /status/*path 都走 statusProxy 反代到状态页插件
	r.GET("/status", statusProxy)
	r.GET("/status/*path", statusProxy)

	// === cc-switch 通用模板兼容端点（使用 sk-xxx API Key 自鉴权） ===
	// AirGate 安装脚本和 cc-switch 通用脚本可使用 /v1/usage 做 Key 校验和
	// 余额查询。该路径由 Core 直接处理，返回真实可用余额。
	// 必须注册在 NoRoute 之前，否则会被插件动态路由吃掉。
	// 实现见 cc_compat.go。
	r.GET("/v1/usage", s.handleCCCompatUserBalance)

	// === OneAPI / NewAPI 余额查询兼容端点（同样 sk-xxx API Key 自鉴权） ===
	// 下游中转与路由器沿用 OpenAI 早期的 billing 端点探测额度，且必须成对读取：
	// remaining = subscription.hard_limit_usd - usage.total_usage/100。
	// 我方 /v1/usage 是 cc-switch 口径、字段名不同，下游认不出来，只能持续吃 404。
	// 裸路径（不带 /v1）一并注册：部分实现直接按 baseUrl 拼 /dashboard/...。
	// 同样必须注册在 NoRoute 之前，否则会被插件动态路由吃掉。实现见 oneapi_compat.go。
	for _, prefix := range []string{"/v1", ""} {
		r.GET(prefix+"/dashboard/billing/subscription", s.handleOneAPIBillingSubscription)
		r.GET(prefix+"/dashboard/billing/usage", s.handleOneAPIBillingUsage)
	}

	// === MCP 管理面（Streamable HTTP，无状态，sk-xxx API Key 自鉴权） ===
	// 只读工具：余额 / Key 配额 / 可用模型与实付价 / 用量统计。
	// 必须注册在 NoRoute 之前，否则会被插件动态路由吃掉。实现见 handler/mcp_handler_routes.go。
	r.POST("/mcp", handlers.MCP.Handle)
	r.GET("/mcp", handlers.MCP.HandleMethodNotAllowed)
	r.DELETE("/mcp", handlers.MCP.HandleMethodNotAllowed)

	// === OpenClaw 一键接入（公共路由，无需认证） ===
	// 设计：install.sh 通过 `curl | bash` 分发，因此必须公开；models/info
	// 也无需鉴权，内容均为管理员已标记为 "可公开" 的元信息。
	// 注意：这些路由必须在 NoRoute 之前注册，否则带 Bearer 的请求会被 NoRoute
	// 的 API Key 转发逻辑吃掉。
	openclawGroup := r.Group("/openclaw")
	{
		openclawGroup.GET("/install.sh", handlers.OpenClaw.HandleInstallScript)
		openclawGroup.GET("/install.ps1", handlers.OpenClaw.HandleInstallScriptPowerShell)
		openclawGroup.GET("/models", handlers.OpenClaw.HandleModels)
		openclawGroup.GET("/models.txt", handlers.OpenClaw.HandleModelsText)
		openclawGroup.POST("/render-config", handlers.OpenClaw.HandleRenderConfig)
		openclawGroup.GET("/info", handlers.OpenClaw.HandleInfo)
	}

	// === Claude Code 一键接入（公共路由，无需认证） ===
	// setup.sh/.ps1 通过 `curl | bash` / `irm | iex` 分发，必须公开；
	// exchange/verify 由脚本携带一次性 setup token 调用，令牌本身即凭证。
	// 同 openclaw：必须注册在 NoRoute 之前，否则会被 API Key 转发逻辑吃掉。
	oneclickGroup := r.Group("/oneclick")
	{
		oneclickGroup.GET("/setup.sh", handlers.OneClick.HandleSetupScript)
		oneclickGroup.GET("/setup.ps1", handlers.OneClick.HandleSetupScriptPowerShell)
		oneclickGroup.GET("/setup-codex.sh", handlers.OneClick.HandleSetupCodexScript)
		oneclickGroup.GET("/setup-codex.ps1", handlers.OneClick.HandleSetupCodexScriptPowerShell)
		oneclickGroup.POST("/exchange", handlers.OneClick.HandleExchange)
		oneclickGroup.POST("/verify", handlers.OneClick.HandleVerify)
	}

	// === 公开博客(SSR，无需认证） ===
	// 落地页(hop-base.com/blog、essevin.com/blog 经反代)展示的文章页:一实例渲染
	// 自己 DB 的已发布文章,品牌随实例(site 设置)天然区分。必须在 NoRoute 之前注册,
	// 否则会被 SPA / API Key 转发逻辑吃掉。
	blogRenderer := blogssr.NewRenderer(handlers.BlogService, handlers.SettingsService)
	r.GET("/blog", blogRenderer.RenderList)
	// 控制台同源的只读会话桥；须在 :slug 之前注册，避免被识别成文章 slug。
	r.GET("/blog/session-bridge", blogRenderer.RenderSessionBridge)
	// sitemap 须在 :slug 之前注册;gin v1.10 静态路径优先于同层 param,不会被当作 slug。
	r.GET("/blog/sitemap.xml", blogRenderer.RenderSitemap)
	r.GET("/blog/:slug", blogRenderer.RenderDetail)

	// 上传文件静态服务（这部分仍然在磁盘上，因为是用户上传的运行时数据）
	//
	// ⚠️ 安全说明：此路径公开可访问，无需认证。上传的文件（如头像、聊天图片）可能
	// 被嵌入外部链接中分享，因此保持公开。文件名使用 UUID 生成，不可枚举。
	// 如未来需要访问控制，应替换为带鉴权的路由组。
	r.Static("/uploads", "data/uploads")
	r.GET("/assets-runtime/*path", s.handleRuntimeAsset)

	// 插件前端静态资源（/plugins/{pluginName}/assets/*）
	//
	// 与 r.Static 不同：这是一个 dev-aware handler，对每个请求按以下顺序查找：
	//   1. 如果该插件是 dev 模式 → 从 <plugin_src>/web/dist/ 读 vite watch 实时产物
	//   2. fallback 到 data/plugins/<id>/assets/ —— 生产模式或 vite 还没构建好
	//
	// 这样所有插件的 vite watch 都可以统一输出到自己的 web/dist，不需要再让
	// vite watch --outDir 写到 core 的 plugin assets dir。
	pluginDir := s.cfg.Plugins.Dir
	if pluginDir == "" {
		pluginDir = "data/plugins"
	}
	r.GET("/plugins/:name/assets/*path", servePluginAsset(s.pluginMgr, pluginDir))

	// 静态文件服务（前端 SPA）
	r.StaticFS("/assets", http.FS(assetsFS))

	// NoRoute: 携带 API Key 的请求转发到插件系统，其余返回前端 index.html
	// 支持 Authorization: Bearer 和 x-api-key 两种认证方式（兼容 Anthropic 标准格式）
	apiKeyAuth := middleware.APIKeyAuth(s.db)
	r.NoRoute(func(c *gin.Context) {
		if middleware.HasAPIKey(c) {
			apiKeyAuth(c)
			if c.IsAborted() {
				return
			}
			c.Params = append(c.Params, gin.Param{Key: "path", Value: c.Request.URL.Path})
			s.dynamicRouter.Handle(c)
			return
		}
		// 无凭证请求打到网关 API 命名空间时，同样交给 apiKeyAuth 返回标准
		// 401 JSON（missing_api_key），不能落进 SPA 兜底——agent/SDK 探测端点
		// 收到 200+HTML 会误判协议（llms.txt 把 /v1/models 声明为发现入口）。
		if s.isGatewayAPIPath(c.Request.URL.Path) {
			apiKeyAuth(c)
			return
		}
		c.Data(http.StatusOK, "text/html; charset=utf-8", indexHTML)
	})
}

// isGatewayAPIPath 判断路径是否属于模型网关的对外 API 命名空间。
// /v1、/v1beta 两个协议前缀静态兜底，其余（裸 /messages、/chat/completions、
// bailian 的 /api/v1/services、/api/v1/tasks 等）从插件管理器的路由注册表推导，
// 插件新增前缀自动生效。裸 /models 被显式排除：它同时是控制台 SPA 的模型广场页
// 路由，浏览器直开/刷新不带凭证，必须继续落 SPA；带 key 的 API 客户端不受影响
// （走 HasAPIKey 分支）。console 自身的 /api/v1 具名路由注册在 gin 路由表里，
// 不会落到 NoRoute。
func (s *Server) isGatewayAPIPath(p string) bool {
	if p == "/models" {
		return false
	}
	if strings.HasPrefix(p, "/v1/") || strings.HasPrefix(p, "/v1beta/") {
		return true
	}
	return s.pluginMgr != nil && s.pluginMgr.MatchesRoutePath(p)
}

// servePluginAsset 处理 /plugins/<name>/assets/* 请求。
//
// 双模式：
//   - dev 模式：从 <plugin_src>/web/dist/<rel> 读 vite watch 实时构建产物。
//     这样 openai/epay/health 都可以让 vite watch 输出到自己的 web/dist，
//     core 透明地从那里读，不再需要让 vite watch --outDir 写到 core 内部目录。
//   - production 模式：fallback 到 data/plugins/<name>/assets/<rel>，
//     由 core 启动时通过 GetWebAssets() 把插件 binary embed 的 webdist 提取出来。
//
// 路径穿越防御：clean 后检查不允许 ".."。
func (s *Server) handleRuntimeAsset(c *gin.Context) {
	rel := strings.TrimPrefix(path.Clean("/"+c.Param("path")), "/")
	if rel == "" || rel == "." || strings.HasPrefix(rel, "../") || strings.Contains(rel, "/../") {
		c.Status(http.StatusBadRequest)
		return
	}
	storage, err := plugin.NewAssetStorage(c.Request.Context(), s.db)
	if err != nil {
		slog.Warn("runtime_asset_storage_init_failed", "error", err)
		c.Status(http.StatusInternalServerError)
		return
	}
	localPath, err := storage.LocalPath(rel)
	if err != nil {
		c.Status(http.StatusBadRequest)
		return
	}
	c.Header("Cache-Control", "public, max-age=31536000, immutable")

	if width := resolveThumbWidth(c.Query("w")); width > 0 && thumbnailableExt(rel) {
		cachePath := thumbCachePath(localPath, width)
		if data, err := os.ReadFile(cachePath); err == nil {
			c.Data(http.StatusOK, "image/jpeg", data)
			return
		}
		data, contentType, err := storage.GetBytes(c.Request.Context(), rel)
		if err != nil {
			c.Status(http.StatusNotFound)
			return
		}
		thumb, thumbErr := generateThumbnailFromBytes(data, cachePath, width)
		if thumbErr == nil {
			c.Data(http.StatusOK, "image/jpeg", thumb)
			return
		}
		if contentType == "" || contentType == "application/octet-stream" {
			contentType = contentTypeFromExt(rel)
		}
		c.Data(http.StatusOK, contentType, data)
		return
	}

	data, contentType, err := storage.GetBytes(c.Request.Context(), rel)
	if err != nil {
		c.Status(http.StatusNotFound)
		return
	}
	if contentType == "" || contentType == "application/octet-stream" {
		contentType = contentTypeFromExt(rel)
	}
	c.Data(http.StatusOK, contentType, data)
}

func servePluginAsset(mgr *plugin.Manager, baseDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		name := c.Param("name")
		rel := strings.TrimPrefix(c.Param("path"), "/")

		// 路径穿越防御
		clean := filepath.Clean("/" + rel)
		if strings.Contains(clean, "..") {
			c.Status(http.StatusBadRequest)
			return
		}
		rel = strings.TrimPrefix(clean, "/")

		// 优先尝试 dev 路径
		if devDir, ok := mgr.DevWebDistPath(name); ok {
			full := filepath.Join(devDir, rel)
			if data, err := os.ReadFile(full); err == nil {
				c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
				c.Data(http.StatusOK, contentTypeFromExt(rel), data)
				return
			}
		}

		// fallback 到 production 路径
		full := filepath.Join(baseDir, name, "assets", rel)
		data, err := os.ReadFile(full)
		if err != nil {
			// 插件可选 CSS：若 index.css 不存在，返回空 CSS 而非 404。
			// 否则浏览器会在 network 面板打印 404，污染开发者控制台。
			if rel == "index.css" {
				c.Data(http.StatusOK, "text/css; charset=utf-8", nil)
				return
			}
			c.Status(http.StatusNotFound)
			return
		}
		// 插件前端产物是固定文件名（index.js/css，无内容 hash），部署更新后文件名不变。
		// no-cache 要求每次 revalidate，但只有配上内容 ETag 才能真正 revalidate：
		// 无验证器时部分浏览器/代理会退化成直接返回缓存旧版，导致插件前端更新不生效。
		// 前端加载器另叠加 ?v=<build> query busting 穿透顽固代理（见 web/plugin-loader.ts）。
		serveAssetWithETag(c, contentTypeFromExt(rel), data)
	}
}

// serveAssetWithETag 以内容 hash 作为强 ETag 提供资源，支持 If-None-Match 条件请求
// 返回 304，让固定文件名资源的 revalidate 真正生效（no-cache 无验证器会退化为返回旧版）。
func serveAssetWithETag(c *gin.Context, contentType string, data []byte) {
	sum := sha256.Sum256(data)
	etag := `"` + hex.EncodeToString(sum[:16]) + `"`
	c.Header("Cache-Control", "no-cache, must-revalidate")
	c.Header("ETag", etag)
	if match := c.GetHeader("If-None-Match"); match == etag {
		c.Status(http.StatusNotModified)
		return
	}
	c.Data(http.StatusOK, contentType, data)
}

// contentTypeFromExt 按扩展名返回 Content-Type。覆盖插件资源里常见的几种文件，
// 未知扩展名退回 application/octet-stream。
func contentTypeFromExt(name string) string {
	switch {
	case strings.HasSuffix(name, ".html"):
		return "text/html; charset=utf-8"
	case strings.HasSuffix(name, ".css"):
		return "text/css; charset=utf-8"
	case strings.HasSuffix(name, ".js"), strings.HasSuffix(name, ".mjs"):
		return "application/javascript; charset=utf-8"
	case strings.HasSuffix(name, ".json"):
		return "application/json"
	case strings.HasSuffix(name, ".svg"):
		return "image/svg+xml"
	case strings.HasSuffix(name, ".png"):
		return "image/png"
	case strings.HasSuffix(name, ".jpg"), strings.HasSuffix(name, ".jpeg"):
		return "image/jpeg"
	case strings.HasSuffix(name, ".webp"):
		return "image/webp"
	case strings.HasSuffix(name, ".gif"):
		return "image/gif"
	case strings.HasSuffix(name, ".mp4"):
		return "video/mp4"
	case strings.HasSuffix(name, ".mp3"):
		return "audio/mpeg"
	case strings.HasSuffix(name, ".woff2"):
		return "font/woff2"
	default:
		return "application/octet-stream"
	}
}
