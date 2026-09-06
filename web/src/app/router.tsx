import {
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { Suspense, useEffect } from 'react';
import type { ElementType, ReactNode } from 'react';
import { useAuth } from './providers/AuthProvider';
import { OnboardingRoot } from './onboarding/OnboardingRoot';
import { ErrorBoundary } from './providers/ErrorBoundary';
import { getToken, getTokenRole } from '../shared/api/client';
import { getInviteCodeFromURL } from '../shared/inviteCode';
import { ChatPageLoading, FullPageLoading, PageLoading } from '../shared/components/PageLoading';
import { checkAdmin, checkBlogAuthor, checkEnterpriseOwner, withSetupCheck } from './routeGuards';
import {
  AccountEventsPage,
  AccountsPage,
  ADMIN_IDLE_PRELOADS,
  DashboardPage,
  InvitePage,
  TeamPage,
  DocsPage,
  LegalTermsPage,
  GroupsPage,
  GenerationTasksPage,
  lazyWithPreload,
  LoginPage,
  ModelPlazaPage,
  NotificationsPage,
  PluginPage,
  PluginsPage,
  RelayDetectionPage,
  PricingPage,
  preloadRoutePage,
  PrivacyPolicyPage,
  ProfilePage,
  ProxiesPage,
  EntryCodesPage,
  ReferralPage,
  BlogListPage,
  BlogEditorPage,
  SettingsPage,
  SetupPage,
  SubscriptionsPage,
  UsagePage,
  UserKeysPage,
  UserOverviewPage,
  USER_IDLE_PRELOADS,
  UsersPage,
  UserUsagePage,
} from './routePreloads';

function requestIdle(work: () => void) {
  const runtime = globalThis as typeof globalThis & {
    cancelIdleCallback?: (id: number) => void;
    requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  };

  if (runtime.requestIdleCallback) {
    const id = runtime.requestIdleCallback(work, { timeout: 2500 });
    return () => runtime.cancelIdleCallback?.(id);
  }

  const id = globalThis.setTimeout(work, 500);
  return () => globalThis.clearTimeout(id);
}

// 任意受保护入口都可能由推广链接打开。重定向登录页时保留当前地址明确携带的邀请参数；
// 不从 localStorage 回填，避免一次历史邀请污染之后的普通登录。
function redirectToLogin() {
  const inviteCode = getInviteCodeFromURL();
  return redirect({ to: '/login', search: inviteCode ? { inv: inviteCode } : {} });
}

const AppShell = lazyWithPreload<{ children: ReactNode }>(() =>
  import('./layout/AppShell').then((m) => ({ default: m.AppShell })),
);

function RoutePreloader() {
  const { user, isAPIKeySession } = useAuth();
  const hasUser = Boolean(user);
  const userRole = user?.role;

  useEffect(() => {
    if (!hasUser) return;

    const pages = isAPIKeySession
      ? [UserUsagePage]
      : userRole === 'admin'
        ? ADMIN_IDLE_PRELOADS
        : USER_IDLE_PRELOADS;
    let index = 0;
    let cancelIdle = () => {};
    let cancelled = false;

    const preloadNext = () => {
      if (cancelled || index >= pages.length) return;
      const page = pages[index++];
      if (!page) return;
      void preloadRoutePage(page).finally(() => {
        if (!cancelled) cancelIdle = requestIdle(preloadNext);
      });
    };

    cancelIdle = requestIdle(preloadNext);
    return () => {
      cancelled = true;
      cancelIdle();
    };
  }, [hasUser, isAPIKeySession, userRole]);

  return null;
}

// 根路由
const rootRoute = createRootRoute({
  component: () => (
    <ErrorBoundary>
      <OnboardingRoot>
        <Outlet />
      </OnboardingRoot>
    </ErrorBoundary>
  ),
});

// 安装向导（无需认证，懒加载）
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/setup',
  beforeLoad: () => withSetupCheck((needs) => {
    if (!needs) throw redirect({ to: '/login' });
  }),
  component: () => (
    <Suspense fallback={<FullPageLoading />}>
      <SetupPage />
    </Suspense>
  ),
});

// 旧公共首页路由：HopBase 使用独立落地页，API 侧不再展示内置 /home。
const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/home',
  beforeLoad: () => withSetupCheck((needs) => {
    if (needs) throw redirect({ to: '/setup' });
    if (getToken()) throw redirect({ to: '/' });
    throw redirectToLogin();
  }),
  component: () => null,
});

// 注意：/status 不再注册客户端路由，整个公开状态页交给 airgate-health 插件维护。
// 后端 GET /status 直接反代到插件的 handlePublicIndex，前端用普通 href 跳转。
// 这样避免 core 与插件出现两份重复的状态页实现。

// 内置默认文档页 —— 当管理员未在 系统设置 → 站点品牌 → 文档链接 中填写外部 URL 时，
// 所有"文档"按钮 fallback 到这里。公开可访问，独立布局（不挂 AppShell）。
const docsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/docs',
  component: () => (
    <Suspense fallback={<FullPageLoading />}>
      <DocsPage />
    </Suspense>
  ),
});

const legalTermsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/legal/terms',
  component: () => (
    <Suspense fallback={<FullPageLoading />}>
      <LegalTermsPage />
    </Suspense>
  ),
});

const userAgreementLegacyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/user-agreement',
  beforeLoad: () => {
    throw redirect({ to: '/legal/terms' });
  },
  component: () => null,
});

const privacyPolicyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/legal/privacy',
  component: () => (
    <Suspense fallback={<FullPageLoading />}>
      <PrivacyPolicyPage />
    </Suspense>
  ),
});

const privacyPolicyLegacyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/privacy-policy',
  beforeLoad: () => {
    throw redirect({ to: '/legal/privacy' });
  },
  component: () => null,
});

// 登录页（无需认证，懒加载）。
// 已持有会话时直接回控制台首页：落地页 CTA 固定指向 /login，已登录用户点进来
// 不该再看一次登录表单（token 过期时首页请求会走全局 401 清 token 送回这里，不会循环）。
// OAuth 回调两种携带（hash 的 oauth_token / query 的 oauth_error）仍留在本页交给 LoginPage 处理。
const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (search: Record<string, unknown>): { inv?: string } => ({
    inv: typeof search.inv === 'string' ? search.inv : undefined,
  }),
  beforeLoad: () => withSetupCheck((needs) => {
    if (needs) throw redirect({ to: '/setup' });
    const isOAuthCallback = window.location.hash.includes('oauth_token=')
      || new URLSearchParams(window.location.search).has('oauth_error');
    if (!isOAuthCallback && getToken()) throw redirect({ to: '/' });
  }),
  component: () => (
    <Suspense fallback={<FullPageLoading />}>
      <LoginPage />
    </Suspense>
  ),
});

// 认证布局（需要登录）
const authLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: 'auth',
  beforeLoad: () => withSetupCheck((needs) => {
    if (needs) throw redirect({ to: '/setup' });
    if (!getToken()) {
      throw redirectToLogin();
    }
  }),
  component: () => (
    <Suspense fallback={<FullPageLoading />}>
      <AppShell>
        <RoutePreloader />
        <Outlet />
      </AppShell>
    </Suspense>
  ),
});

function HomePage() {
  const { user, loading, isAPIKeySession } = useAuth();
  if (loading) return <PageLoading />;
  if (!user) return null;

  const isAdmin = !isAPIKeySession && (getTokenRole() === 'admin' || user.role === 'admin');
  const Page = isAPIKeySession ? UserUsagePage : isAdmin ? DashboardPage : UserOverviewPage;
  return (
    <Suspense fallback={<PageLoading />}>
      <Page />
    </Suspense>
  );
}
const dashboardRoute = createRoute({ getParentRoute: () => authLayout, path: '/', component: HomePage });

// 管理员布局（需要 admin 角色）
const adminLayout = createRoute({
  getParentRoute: () => authLayout,
  id: 'admin',
  beforeLoad: () => checkAdmin(),
  component: Outlet,
});

// 博客后台布局（管理员 或 被授予 can_author_blog 的用户）
const blogAuthorLayout = createRoute({
  getParentRoute: () => authLayout,
  id: 'blog-author',
  beforeLoad: () => checkBlogAuthor(),
  component: Outlet,
});

function renderPage(Page: ElementType) {
  return () => (
    <Suspense fallback={<PageLoading />}>
      <Page />
    </Suspense>
  );
}

const adminUsersRoute = createRoute({ getParentRoute: () => adminLayout, path: '/admin/users', component: renderPage(UsersPage) });
// 账号页支持从分组页"异常"数下钻：?group_id=X&state=error 预置筛选。
const adminAccountsRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin/accounts',
  component: renderPage(AccountsPage),
  validateSearch: (search: Record<string, unknown>): { group_id?: number; state?: string } => ({
    group_id: typeof search.group_id === 'number' ? search.group_id : undefined,
    state: typeof search.state === 'string' ? search.state : undefined,
  }),
});
const adminGroupsRoute = createRoute({ getParentRoute: () => adminLayout, path: '/admin/groups', component: renderPage(GroupsPage) });
const adminGenerationTasksRoute = createRoute({ getParentRoute: () => adminLayout, path: '/admin/generation-tasks', component: renderPage(GenerationTasksPage) });
// 异常监控页：分组页"异常"数下钻会带 ?group_id=X 预置分组筛选。
const adminAccountEventsRoute = createRoute({
  getParentRoute: () => adminLayout,
  path: '/admin/account-events',
  component: renderPage(AccountEventsPage),
  validateSearch: (search: Record<string, unknown>): { group_id?: number } => ({
    group_id: typeof search.group_id === 'number' ? search.group_id : undefined,
  }),
});
const adminSubscriptionsRoute = createRoute({ getParentRoute: () => adminLayout, path: '/admin/subscriptions', component: renderPage(SubscriptionsPage) });
const adminProxiesRoute = createRoute({ getParentRoute: () => adminLayout, path: '/admin/proxies', component: renderPage(ProxiesPage) });
const adminEntryCodesRoute = createRoute({ getParentRoute: () => adminLayout, path: '/admin/entry-codes', component: renderPage(EntryCodesPage) });
const adminUsageRoute = createRoute({ getParentRoute: () => adminLayout, path: '/admin/usage', component: renderPage(UsagePage) });
const adminRelayDetectionRoute = createRoute({ getParentRoute: () => adminLayout, path: '/admin/relay-detection', component: renderPage(RelayDetectionPage) });
const adminPricingRoute = createRoute({ getParentRoute: () => adminLayout, path: '/admin/pricing', component: renderPage(PricingPage) });
const adminPluginsRoute = createRoute({ getParentRoute: () => adminLayout, path: '/admin/plugins', component: renderPage(PluginsPage) });
const adminNotificationsRoute = createRoute({ getParentRoute: () => adminLayout, path: '/admin/notifications', component: renderPage(NotificationsPage) });
const adminSettingsRoute = createRoute({ getParentRoute: () => adminLayout, path: '/admin/settings', component: renderPage(SettingsPage) });
const adminReferralRoute = createRoute({ getParentRoute: () => adminLayout, path: '/admin/referral', component: renderPage(ReferralPage) });
const adminBlogRoute = createRoute({ getParentRoute: () => blogAuthorLayout, path: '/admin/blog', component: renderPage(BlogListPage) });
const adminBlogEditRoute = createRoute({
  getParentRoute: () => blogAuthorLayout,
  path: '/admin/blog/edit',
  component: renderPage(BlogEditorPage),
  validateSearch: (search: Record<string, unknown>): { id?: number } => ({
    id: typeof search.id === 'number' ? search.id : undefined,
  }),
});

const accountPageBeforeLoad = () => {
  if (getTokenRole() === 'api_key') throw redirect({ to: '/' });
};
const profileRoute = createRoute({ getParentRoute: () => authLayout, path: '/profile', beforeLoad: accountPageBeforeLoad, component: renderPage(ProfilePage) });
const inviteRoute = createRoute({ getParentRoute: () => authLayout, path: '/invite', beforeLoad: accountPageBeforeLoad, component: renderPage(InvitePage) });
const userKeysRoute = createRoute({ getParentRoute: () => authLayout, path: '/keys', beforeLoad: accountPageBeforeLoad, component: renderPage(UserKeysPage) });
const teamRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/team',
  beforeLoad: () => {
    accountPageBeforeLoad();
    return checkEnterpriseOwner();
  },
  component: renderPage(TeamPage),
});
const userUsageRoute = createRoute({ getParentRoute: () => authLayout, path: '/usage', component: renderPage(UserUsagePage) });
const modelPlazaRoute = createRoute({ getParentRoute: () => authLayout, path: '/models', component: renderPage(ModelPlazaPage) });

// /chat: AI 对话页(airgate-playground 插件)。挂在控制台壳层下:顶栏与账户区由 AppShell 提供,
// 侧栏在该路由自动收成 56px 图标栏,插件自己的会话栏成为唯一展开的左栏;页面本身 data-full-bleed。
// 仍要求登录 + 安装完成；走 PluginShell 通用插件顶栏。
const chatBeforeLoad = () => withSetupCheck((needs) => {
  if (needs) throw redirect({ to: '/setup' });
  if (!getToken()) throw redirectToLogin();
  if (getTokenRole() === 'api_key') throw redirect({ to: '/' });
});
const chatRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/chat',
  beforeLoad: chatBeforeLoad,
  component: () => (
    <Suspense fallback={<ChatPageLoading />}>
      <PluginPage pluginNameOverride="airgate-playground" subPathOverride="/chat" />
    </Suspense>
  ),
});
// /studio: 创作工作坊(airgate-studio 插件)。同 /chat 挂在控制台壳层下并收成图标栏;
// 插件当前仍是 position:fixed 的全屏布局,会盖在壳层之上,待插件改成 in-flow + data-full-bleed 后即嵌入壳层。
const studioRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/studio',
  beforeLoad: chatBeforeLoad,
  component: () => (
    <Suspense fallback={<ChatPageLoading />}>
      <PluginPage pluginNameOverride="airgate-studio" subPathOverride="/studio" />
    </Suspense>
  ),
});

// 旧路径 /plugins/playground 重定向到 /chat，避免历史书签 / 链接失效。
const playgroundLegacyRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/plugins/playground',
  beforeLoad: () => {
    throw redirect({ to: '/chat' });
  },
  component: () => null,
});

// 插件页面路由（catch-all）
const pluginRoute = createRoute({
  getParentRoute: () => authLayout,
  path: '/plugins/$pluginName/$',
  beforeLoad: () => {
    if (getTokenRole() === 'api_key') throw redirect({ to: '/' });
  },
  component: () => (
    <Suspense fallback={<PageLoading />}>
      <PluginPage />
    </Suspense>
  ),
});

// 路由树
const routeTree = rootRoute.addChildren([
  setupRoute,
  homeRoute,
  loginRoute,
  docsRoute,
  legalTermsRoute,
  userAgreementLegacyRoute,
  privacyPolicyRoute,
  privacyPolicyLegacyRoute,
  playgroundLegacyRoute,
  authLayout.addChildren([
    dashboardRoute,
    adminLayout.addChildren([
      adminUsersRoute,
      adminAccountsRoute,
      adminGroupsRoute,
      adminGenerationTasksRoute,
      adminAccountEventsRoute,
      adminSubscriptionsRoute,
      adminProxiesRoute,
      adminEntryCodesRoute,
      adminUsageRoute,
      adminRelayDetectionRoute,
      adminPricingRoute,
      adminPluginsRoute,
      adminNotificationsRoute,
      adminSettingsRoute,
      adminReferralRoute,
    ]),
    blogAuthorLayout.addChildren([
      adminBlogRoute,
      adminBlogEditRoute,
    ]),
    profileRoute,
    inviteRoute,
    userKeysRoute,
    teamRoute,
    userUsageRoute,
    modelPlazaRoute,
    chatRoute,
    studioRoute,
    pluginRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  defaultPreloadStaleTime: 0,
});
