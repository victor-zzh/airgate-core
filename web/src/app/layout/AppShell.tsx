import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, useMatchRoute, useRouterState } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useIsFetching, useQuery } from '@tanstack/react-query';
import { Button, Dropdown, Link as HeroLink, Tooltip } from '@heroui/react';
import { useAuth } from '../providers/AuthProvider';
import { getTokenRole } from '../../shared/api/client';
import { pluginsApi } from '../../shared/api/plugins';
import { queryKeys } from '../../shared/queryKeys';
import { useTheme } from '../providers/ThemeProvider';
import { useSiteSettings } from '../providers/SiteSettingsProvider';
import { LanguageSwitcher } from '../../shared/components/LanguageSwitcher';
import { effectiveDocUrl } from '../../shared/utils/docUrl';
import { useIsMobile } from '../../shared/hooks/useMediaQuery';
import { usePersistentBoolean } from '../../shared/hooks/usePersistentBoolean';
import { TopLoadingLine } from '../../shared/components/PageLoading';
import { AnnouncementBanner } from '../../shared/components/AnnouncementBanner';
import { NotificationCenter } from '../../shared/components/NotificationCenter';
import { SiteBrand } from '../../shared/components/SiteBrand';
import { useOnboardingReplay } from '../onboarding/OnboardingRoot';
import {
  LayoutDashboard,
  Users,
  IdCard,
  FolderTree,
  KeyRound,
  CreditCard,
  Globe,
  ChartNoAxesCombined,
  ReceiptText,
  Puzzle,
  Settings,
  UserRoundCog,
  LogOut,
  Sun,
  Moon,
  Menu,
  ShieldCheck,
  BookOpen,
  MessageCircle,
  Gift,
  HelpCircle,
  Megaphone,
  FileText,
  Radar,
  TriangleAlert,
  ChevronLeft,
  ChevronRight,
  Boxes,
  Clapperboard,
  Route,
  Bell,
  Tags,
  Link2,
  UsersRound,
  ChevronsUpDown,
  Palette,
  MessageSquare,
  Wallet,
  History,
  Receipt,
  Activity,
  Image as ImageIcon,
  Video,
  Store,
  LayoutGrid,
} from 'lucide-react';

/**
 * 插件页图标:插件在 metadata 里声明 icon 名(palette / wallet / message-square …),
 * 这里映射到 lucide 组件;认不出的才回落拼图,不再让所有插件页长得一样。
 */
const PLUGIN_ICONS: Record<string, ReactNode> = {
  palette: <Palette className="h-5 w-5" />,
  'message-square': <MessageSquare className="h-5 w-5" />,
  wallet: <Wallet className="h-5 w-5" />,
  history: <History className="h-5 w-5" />,
  receipt: <Receipt className="h-5 w-5" />,
  settings: <Settings className="h-5 w-5" />,
  gift: <Gift className="h-5 w-5" />,
  activity: <Activity className="h-5 w-5" />,
  image: <ImageIcon className="h-5 w-5" />,
  video: <Video className="h-5 w-5" />,
  store: <Store className="h-5 w-5" />,
  grid: <LayoutGrid className="h-5 w-5" />,
  bell: <Bell className="h-5 w-5" />,
  users: <Users className="h-5 w-5" />,
  key: <KeyRound className="h-5 w-5" />,
  chart: <ChartNoAxesCombined className="h-5 w-5" />,
};

function pluginPageIcon(name: string | undefined): ReactNode {
  const key = (name ?? '').trim().toLowerCase();
  return PLUGIN_ICONS[key] ?? <Puzzle className="h-5 w-5" />;
}

interface AppShellProps {
  children: ReactNode;
}

interface MenuItem {
  path: string;
  labelKey: string;
  icon: ReactNode;
  sectionKey?: string;
}

const adminMenuItems: MenuItem[] = [
  { path: '/', labelKey: 'nav.dashboard', icon: <LayoutDashboard className="h-5 w-5" />, sectionKey: 'nav.overview' },
  { path: '/models', labelKey: 'nav.model_plaza', icon: <Boxes className="h-5 w-5" /> },
  { path: '/admin/users', labelKey: 'nav.users', icon: <Users className="h-5 w-5" />, sectionKey: 'nav.management' },
  { path: '/admin/accounts', labelKey: 'nav.accounts', icon: <IdCard className="h-5 w-5" /> },
  { path: '/admin/groups', labelKey: 'nav.groups', icon: <FolderTree className="h-5 w-5" /> },
  { path: '/admin/pricing', labelKey: 'nav.pricing', icon: <Tags className="h-5 w-5" /> },
  { path: '/admin/subscriptions', labelKey: 'nav.subscriptions', icon: <CreditCard className="h-5 w-5" /> },
  { path: '/admin/proxies', labelKey: 'nav.proxies', icon: <Globe className="h-5 w-5" /> },
  { path: '/admin/usage', labelKey: 'nav.usage', icon: <ChartNoAxesCombined className="h-5 w-5" /> },
  { path: '/admin/relay-detection', labelKey: 'nav.relay_detection', icon: <Radar className="h-5 w-5" /> },
  { path: '/admin/generation-tasks', labelKey: 'nav.generation_tasks', icon: <Clapperboard className="h-5 w-5" />, sectionKey: 'nav.monitoring' },
  { path: '/admin/account-events', labelKey: 'nav.account_events', icon: <TriangleAlert className="h-5 w-5" /> },
  // 营销分组：分销返利是首个成员，后续营销玩法（阶梯比例/活动）都挂这里
  { path: '/admin/referral', labelKey: 'nav.referral_admin', icon: <Megaphone className="h-5 w-5" />, sectionKey: 'nav.marketing' },
  { path: '/admin/blog', labelKey: 'nav.blog', icon: <FileText className="h-5 w-5" /> },
  { path: '/admin/plugins', labelKey: 'nav.plugins', icon: <Puzzle className="h-5 w-5" />, sectionKey: 'nav.system' },
  { path: '/admin/notifications', labelKey: 'nav.notifications', icon: <Bell className="h-5 w-5" /> },
  { path: '/admin/entry-codes', labelKey: 'nav.entry_codes', icon: <Link2 className="h-5 w-5" /> },
  { path: '/admin/settings', labelKey: 'nav.settings', icon: <Settings className="h-5 w-5" /> },
];

const userMenuItems: MenuItem[] = [
  { path: '/', labelKey: 'nav.my_overview', icon: <LayoutDashboard className="h-5 w-5" />, sectionKey: 'nav.personal' },
  { path: '/models', labelKey: 'nav.model_plaza', icon: <Boxes className="h-5 w-5" /> },
  { path: '/profile', labelKey: 'nav.profile', icon: <UserRoundCog className="h-5 w-5" /> },
  { path: '/keys', labelKey: 'nav.my_keys', icon: <KeyRound className="h-5 w-5" /> },
  { path: '/usage', labelKey: 'nav.my_usage', icon: <ReceiptText className="h-5 w-5" /> },
];

// 「团队成员」是企业客户专属能力：管理员天然可见，普通用户须被管理员授予 is_enterprise_owner。
// 位置保持在「我的密钥」之后、「使用记录」之前，与授予前后的菜单次序一致。
const teamMenuItem: MenuItem = { path: '/team', labelKey: 'nav.my_team', icon: <UsersRound className="h-5 w-5" /> };

// 「我的邀请」仅在分销开关（公开设置 referral_enabled）打开时挂进个人菜单。
const inviteMenuItem: MenuItem = { path: '/invite', labelKey: 'nav.my_invite', icon: <Gift className="h-5 w-5" /> };

// 「博客」:管理员天然可见(在 adminMenuItems 内);被授予 can_author_blog 的普通用户
// 也在个人菜单下挂出该入口(单独成营销分组)。
const blogAuthorMenuItem: MenuItem = { path: '/admin/blog', labelKey: 'nav.blog', icon: <FileText className="h-5 w-5" />, sectionKey: 'nav.marketing' };

// API Key 登录只能看使用记录
const apiKeyMenuItems: MenuItem[] = [
  { path: '/usage', labelKey: 'nav.my_usage', icon: <ReceiptText className="h-5 w-5" />, sectionKey: 'nav.personal' },
  { path: '/models', labelKey: 'nav.model_plaza', icon: <Boxes className="h-5 w-5" /> },
];

const SIDEBAR_COLLAPSED_STORAGE_KEY = 'airgate:sidebar:collapsed';

/**
 * 拉取插件菜单：所有登录用户均可调用 /plugins/menu，再按 page.audience 过滤显示。
 *   audience = "admin"（或空，向后兼容）— 仅管理员可见，挂在「插件」分组
 *   audience = "user"                    — 仅普通用户可见（管理员不显示），挂在「个人中心」分组
 *   audience = "all"                     — 所有登录用户可见，按当前角色挂分组
 */
function pluginPagePath(pluginName: string, pagePath: string) {
  if (pluginName === 'airgate-playground' && pagePath === '/playground') return '/chat';
  if (pluginName === 'airgate-studio' && pagePath === '/studio') return '/studio';
  return `/plugins/${pluginName}${pagePath}`;
}

function usePluginMenuItems(isAdmin: boolean, isAPIKeySession: boolean): {
  adminItems: MenuItem[];
  userItems: MenuItem[];
} {
  const { data } = useQuery({
    queryKey: queryKeys.pluginsMenu(),
    queryFn: () => pluginsApi.menu(),
    enabled: !isAPIKeySession,
    staleTime: 60_000,
  });

  return useMemo(() => {
    if (!data?.list) return { adminItems: [], userItems: [] };

    const adminItems: MenuItem[] = [];
    const userItems: MenuItem[] = [];
    let firstAdmin = true;
    let firstUser = true;

    for (const p of data.list) {
      if (!p.frontend_pages?.length) continue;
      for (const page of p.frontend_pages) {
        const audience = page.audience || 'admin';
        const showInUser =
          audience === 'user' || (audience === 'all' && !isAdmin);
        const showInAdmin =
          isAdmin && (audience === 'admin' || audience === 'all');

        const item: MenuItem = {
          path: pluginPagePath(p.name, page.path),
          labelKey: page.title,
          icon: pluginPageIcon(page.icon),
        };

        if (showInAdmin) {
          adminItems.push({
            ...item,
            ...(firstAdmin ? { sectionKey: 'nav.plugins' } : {}),
          });
          firstAdmin = false;
        }
        if (showInUser) {
          userItems.push({
            ...item,
            ...(firstUser ? { sectionKey: 'nav.personal' } : {}),
          });
          firstUser = false;
        }
      }
    }
    return { adminItems, userItems };
  }, [data?.list, isAdmin]);
}

export function AppShell({ children }: AppShellProps) {
  const { user, logout } = useAuth();
  const { openGuide } = useOnboardingReplay();
  const { t } = useTranslation();
  const { theme, toggleTheme } = useTheme();
  const site = useSiteSettings();
  const [collapsed, setCollapsed] = usePersistentBoolean(SIDEBAR_COLLAPSED_STORAGE_KEY, false);
  // 全出血插件页(AI Chat / 创作工作坊)进入时侧栏自动收成图标栏,让插件自己的会话 / 项目栏成为
  // 唯一展开的左栏;图标栏顶部按钮可临时展开,换路由即恢复;不改用户的持久折叠偏好。
  const [railExpanded, setRailExpanded] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const isMobile = useIsMobile();
  const matchRoute = useMatchRoute();
  const routerPath = useRouterState({ select: (s) => s.location.pathname });
  const routerStatus = useRouterState({ select: (s) => s.status });
  const blockingFetches = useIsFetching({
    predicate: (query) => (
      query.state.fetchStatus === 'fetching'
      && (query.meta as { globalLoading?: boolean } | undefined)?.globalLoading !== false
    ),
  });
  const topLoadingActive = routerStatus === 'pending' || blockingFetches > 0;

  // Close mobile drawer on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [routerPath]);

  // Prevent body scroll when mobile drawer is open
  useEffect(() => {
    if (mobileOpen) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [mobileOpen]);

  const isAPIKeySession = user?.role === 'api_key' || !!(user?.api_key_id && user.api_key_id > 0);
  const isAdmin = !isAPIKeySession && (getTokenRole() === 'admin' || user?.role === 'admin');

  const { adminItems: pluginAdminItems, userItems: pluginUserItems } = usePluginMenuItems(isAdmin, isAPIKeySession);
  // 团队成员账号：正常用户菜单，但不挂「团队成员」（不是企业主）与「我的邀请」（消耗记在企业主名下，不做分销主体）
  const isTeamMember = !isAPIKeySession && (user?.member_id ?? 0) > 0;
  const sections = useMemo(() => {
    const isEnterpriseOwner = !isAPIKeySession && !isTeamMember && (isAdmin || !!user?.is_enterprise_owner);
    const userItemsWithTeam = isEnterpriseOwner
      ? [...userMenuItems.slice(0, -1), teamMenuItem, ...userMenuItems.slice(-1)]
      : userMenuItems;
    const userItemsWithInvite = site.referral_enabled && !isTeamMember ? [...userItemsWithTeam, inviteMenuItem] : userItemsWithTeam;
    const adminUserItems = userItemsWithInvite
      .filter((item) => item.path !== '/')
      .map((item, i) => (i === 0 ? { ...item, sectionKey: 'nav.personal' } : item));
    // 不论 admin 还是普通用户视图，pluginUserItems 都会紧跟一个已有的「个人中心」section
    // （admin 视图：adminUserItems；普通用户视图：userMenuItems），所以必须剥掉首项的
    // sectionKey 避免 sections 数组里出现两个同名 section header → 渲染成两个「我的账户」。
    const pluginUserItemsMerged = pluginUserItems.map((item, i) =>
      i === 0 ? { path: item.path, labelKey: item.labelKey, icon: item.icon } : item,
    );
    // 非管理员但被授予 can_author_blog 的用户,在个人菜单后挂出「博客」入口。
    const canBlog = !isAPIKeySession && !!user?.can_author_blog;
    const menuItems = isAPIKeySession
      ? apiKeyMenuItems
      : isAdmin
        ? [...adminMenuItems, ...pluginAdminItems, ...adminUserItems, ...pluginUserItemsMerged]
        : [...userItemsWithInvite, ...(canBlog ? [blogAuthorMenuItem] : []), ...pluginUserItemsMerged];

    const nextSections: Array<{ titleKey?: string; items: MenuItem[] }> = [];
    let currentSection: { titleKey?: string; items: MenuItem[] } | null = null;

    menuItems.forEach((item) => {
      if (item.sectionKey) {
        currentSection = { titleKey: item.sectionKey, items: [item] };
        nextSections.push(currentSection);
      } else if (currentSection) {
        currentSection.items.push(item);
      } else {
        currentSection = { items: [item] };
        nextSections.push(currentSection);
      }
    });

    return nextSections;
  }, [isAPIKeySession, isTeamMember, isAdmin, user?.can_author_blog, user?.is_enterprise_owner, pluginAdminItems, pluginUserItems, site.referral_enabled]);

  // 团队成员的密钥会话优先显示成员名，其次才是密钥名
  const displayName = user?.member_name || user?.api_key_name || user?.username || user?.email?.split('@')[0] || site.site_name || 'HopBase';
  const accountInitial = (user?.username || user?.email || 'U').charAt(0).toUpperCase();
  // 普通会话显示邮箱;团队成员的密钥会话显示「团队成员」;非成员的密钥会话不露任何身份
  const accountSubline = isAdmin
    ? t('nav.admin')
    : (isAPIKeySession ? (user?.member_name ? t('auth.apikey_member_badge') : '') : (user?.email ?? ''));
  const accountMenuItems = [
    ...(!isAPIKeySession ? [{ id: 'guide', label: t('onboarding.sidebar_label'), icon: <Route className="h-3.5 w-3.5" /> }] : []),
    { id: 'docs', label: t('nav.docs'), icon: <BookOpen className="h-3.5 w-3.5" /> },
    { id: 'logout', label: t('common.logout'), icon: <LogOut className="h-3.5 w-3.5" /> },
  ];
  // 标题行:页面名独占一行,取自当前导航项;自带标题或全出血的页面(AI Chat / 工作坊 / 模型广场 / 生成监控 / 价格 / 插件页 / 博客编辑器)不重复渲染
  const pageTitle = useMemo(() => {
    if (/^\/(chat|studio|plugins|models|admin\/generation-tasks|admin\/pricing|admin\/blog\/edit)(\/|$)/.test(routerPath)) return null;
    const items = sections.flatMap((section) => section.items);
    const exact = items.find((item) => item.path === routerPath);
    const nested = items
      .filter((item) => item.path !== '/' && routerPath.startsWith(`${item.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
    const item = exact ?? nested;
    return item ? t(item.labelKey) : null;
  }, [routerPath, sections, t]);
  const notificationIdentity = isAPIKeySession
    ? `api-key:${user?.api_key_id ?? 'session'}`
    : `user:${user?.id ?? 'session'}`;
  useEffect(() => {
    document.title = site.site_name || 'HopBase';
  }, [site.site_name]);

  // On mobile, sidebar is always expanded inside the drawer
  const railRoute = /^\/(chat|studio)(\/|$)/.test(routerPath);
  useEffect(() => {
    setRailExpanded(false);
  }, [routerPath]);
  const sidebarCollapsed = isMobile ? false : (railRoute ? !railExpanded : collapsed);
  const expandSidebar = () => (railRoute ? setRailExpanded(true) : setCollapsed(false));
  const collapseSidebar = () => (railRoute ? setRailExpanded(false) : setCollapsed(true));

  const sidebarContent = (
    <>
      <div className="ag-sidebar-brand flex h-12 items-center px-4">
        <div className={`flex min-w-0 ${sidebarCollapsed ? 'w-full justify-center' : 'w-full items-center gap-3'}`}>
          <SiteBrand
            className={sidebarCollapsed ? 'text-text' : 'min-w-0 flex-1 text-text'}
            iconOnly={sidebarCollapsed}
            iconSize={30}
          />
          {!isMobile && !sidebarCollapsed && (
            <Button
              aria-label={t('nav.collapse_sidebar', 'Collapse sidebar')}
              className="ag-sidebar-collapse-button shrink-0"
              isIconOnly
              size="sm"
              variant="ghost"
              onPress={collapseSidebar}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {!isMobile && sidebarCollapsed && (
        <div className="mb-1 flex justify-center">
          <Button
            aria-label={t('nav.expand_sidebar', 'Expand sidebar')}
            className="ag-sidebar-collapse-button"
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={expandSidebar}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}

      <nav className={`ag-sidebar-nav flex-1 overflow-y-auto pb-4 space-y-5 ${sidebarCollapsed ? 'px-0' : 'px-3'}`}>
        {sections.map((section, si) => (
          <div key={si}>
            {section.titleKey && !sidebarCollapsed && (
              <p className="ag-sidebar-section-label px-2.5 pb-2 text-[10px] font-medium uppercase text-text-tertiary">
                {t(section.titleKey)}
              </p>
            )}
            {sidebarCollapsed && si > 0 && (
              <div className="mx-3 mb-2.5 h-px bg-border" />
            )}
            <div className="space-y-1">
              {section.items.map((item) => {
                const isCurrentActive = item.path === '/'
                  ? !!matchRoute({ to: '/' })
                  : !!matchRoute({ to: item.path, fuzzy: true });
                const isPendingActive = item.path === '/'
                  ? !!matchRoute({ to: '/', pending: true })
                  : !!matchRoute({ to: item.path, fuzzy: true, pending: true });
                const active = routerStatus === 'pending' ? isPendingActive : isCurrentActive;
                const label = t(item.labelKey, { defaultValue: item.labelKey });

                const link = (
                  <Link
                    key={item.path}
                    to={item.path}
                    preload={false}
                    data-active={active ? 'true' : undefined}
                    className={`ag-sidebar-nav-item group relative flex items-center transition-colors duration-150 ${sidebarCollapsed ? 'mx-auto h-10 w-10 justify-center p-0' : 'px-2 py-1.5'}`}
                    // 鼠标点导航不夺焦点:否则弹层关闭把焦点还回来时,全局 :focus-visible 会给活动项套一圈橙框
                    // (与左侧橙线成了两套选中样式);键盘 Tab 仍能聚焦并显示焦点环。
                    onMouseDown={(event) => event.preventDefault()}
                  >
                    <span className="flex shrink-0 items-center justify-center">{item.icon}</span>
                    {!sidebarCollapsed && (
                      <span className="ag-sidebar-nav-item-label truncate">{label}</span>
                    )}
                  </Link>
                );

                return sidebarCollapsed ? (
                  <Tooltip key={item.path}>
                    <Tooltip.Trigger className="block w-full">{link}</Tooltip.Trigger>
                    <Tooltip.Content>{label}</Tooltip.Content>
                  </Tooltip>
                ) : link;
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="ag-sidebar-footer border-t border-border-subtle p-2">
        <Dropdown>
          <Dropdown.Trigger
            aria-label={displayName}
            className={`ag-account-row ${sidebarCollapsed ? 'ag-account-row--mini' : ''}`}
          >
            <span aria-hidden="true" className="ag-account-avatar">
              {isAdmin ? <ShieldCheck className="h-3.5 w-3.5" /> : accountInitial}
            </span>
            {!sidebarCollapsed && (
              <span className="ag-account-copy">
                <span className="ag-account-name">{displayName}</span>
                <span className="ag-account-sub">{accountSubline}</span>
              </span>
            )}
            {!sidebarCollapsed && <ChevronsUpDown aria-hidden="true" className="ag-account-caret h-3.5 w-3.5" />}
          </Dropdown.Trigger>
          <Dropdown.Popover placement={sidebarCollapsed ? 'right bottom' : 'top start'}>
            <Dropdown.Menu
              aria-label={t('common.more')}
              onAction={(key) => {
                if (key === 'guide') {
                  openGuide();
                  setMobileOpen(false);
                } else if (key === 'docs') {
                  window.location.href = effectiveDocUrl(site.doc_url).href;
                } else if (key === 'logout') {
                  logout();
                }
              }}
            >
              {accountMenuItems.map((item) => (
                <Dropdown.Item className={item.id === 'logout' ? 'text-danger' : undefined} id={item.id} key={item.id} textValue={item.label}>
                  <span className="flex items-center gap-2">
                    {item.icon}
                    {item.label}
                  </span>
                </Dropdown.Item>
              ))}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </div>
    </>
  );

  return (
    <div className="fixed inset-0 flex overflow-hidden bg-bg text-text">
      <TopLoadingLine active={topLoadingActive} />

      {/* Mobile backdrop */}
      {isMobile && mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      {isMobile ? (
        <aside
          className="fixed inset-y-0 left-0 z-50 flex flex-col bg-surface border-r border-border transition-transform duration-150 ease-out"
          style={{ width: 'var(--ag-sidebar-width)', transform: mobileOpen ? 'translateX(0)' : 'translateX(-100%)' }}
        >
          {sidebarContent}
        </aside>
      ) : (
        <aside
          className="relative flex flex-col border-r border-border bg-surface transition-[width] duration-150 ease-out"
          style={{ width: sidebarCollapsed ? 'var(--ag-sidebar-collapsed)' : 'var(--ag-sidebar-width)' }}
        >
          {sidebarContent}
        </aside>
      )}

      {/* Main content */}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="ag-topbar pointer-events-auto absolute inset-x-0 top-0 z-20 flex h-12 items-center justify-between gap-3 px-4 md:px-5">
          <div className="flex shrink-0 items-center gap-3">
            {isMobile && (
              <Button
                aria-label={t('nav.open_menu', 'Open menu')}
                isIconOnly
                size="sm"
                variant="ghost"
                onPress={() => {
                  setMobileOpen(true);
                }}
              >
                <Menu className="h-5 w-5" />
              </Button>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {/* Contact */}
            {site.contact_info && (
              <div className="hidden items-center gap-2 text-text-tertiary lg:flex">
                <MessageCircle className="h-5 w-5 shrink-0" />
                <span className="text-sm">{site.contact_info}</span>
              </div>
            )}
            {/* Language selector(共享组件,地球图标) */}
            <LanguageSwitcher />
            {/* Theme toggle */}
            <Button
              aria-label={theme === 'dark' ? t('legal.theme_to_light') : t('legal.theme_to_dark')}
              className="h-10 w-10"
              isIconOnly
              size="sm"
              variant="ghost"
              onPress={toggleTheme}
            >
              {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </Button>
            {/* Docs：未配置外部链接时回退到内置 /docs */}
            {(() => {
              const docs = effectiveDocUrl(site.doc_url);
              return (
                <HeroLink
                  href={docs.href}
                  {...(docs.isExternal ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                  aria-label={t('nav.docs')}
                  className="hidden h-10 w-10 items-center justify-center rounded-[var(--radius)] text-text-secondary transition-colors hover:text-text sm:flex"
                >
                  <BookOpen className="h-5 w-5" />
                </HeroLink>
              );
            })()}
            {/* 帮助与引导:从侧栏底部挪到顶栏,与文档并列 */}
            {!isAPIKeySession && (
              <Button
                data-onboarding-replay="true"
                aria-label={t('onboarding.sidebar_label')}
                className="hidden h-10 w-10 sm:flex"
                isIconOnly
                size="sm"
                variant="ghost"
                onPress={openGuide}
              >
                <HelpCircle className="h-5 w-5" />
              </Button>
            )}
            <NotificationCenter key={notificationIdentity} identity={notificationIdentity} />

          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-auto bg-bg pt-12 ag-main">
          <div className="ag-main-content mx-auto w-full max-w-[1920px] p-4 md:p-6 2xl:p-8">
            <AnnouncementBanner className="mb-4" />
            {pageTitle ? <h1 className="ag-page-title">{pageTitle}</h1> : null}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
