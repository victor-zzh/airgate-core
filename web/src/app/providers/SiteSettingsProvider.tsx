import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { settingsApi } from '../../shared/api/settings';
import { queryKeys } from '../../shared/queryKeys';
import { getOriginSite, subscribeOriginSite } from '../../shared/originSite';
import { applyBrand, resolveBrand, type BrandId } from '../../shared/brand';
import { mergeLegacyNotification, parseNotificationHistory, type SiteNotification } from '../../shared/notifications';
import defaultLogoUrl from '../../assets/logo.svg';

export { defaultLogoUrl };

// 多落地页品牌覆盖：设置项 sites_branding 是
// siteId → { name, logo, doc_url } 的 JSON。
// 用户从某个 ToC 落地页跳来（?site= 已入 localStorage）时，站名与 logo 按来源站覆盖，
// 文档链接也在此处按来源站覆盖。登录页/AppShell/首页都消费同一份
// SiteSettings，因此在此处合并一次即全局生效。
interface SiteBranding {
  name?: string;
  logo?: string;
  doc_url?: string;
  brand_label?: string;
  blog_chrome?: {
    brand_label?: string;
  };
}

function parseSitesBranding(raw: string | undefined): Record<string, SiteBranding> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, SiteBranding>;
    }
  } catch {
    // 配置非法 JSON 时静默回退默认品牌，不影响控制台使用
  }
  return {};
}

// 博客可投放站点选项：设置项 blog_sites 是 [{key,label}] 的 JSON 数组;
// 供后台编辑器「发布站点」多选。配置非法/为空时回退空数组(编辑器隐藏该选择器)。
export interface BlogSiteOption {
  key: string;
  label: string;
}

function parseBlogSites(raw: string | undefined): BlogSiteOption[] {
  if (!raw || !raw.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((o): o is BlogSiteOption => !!o && typeof o === 'object' && typeof (o as BlogSiteOption).key === 'string')
        .map((o) => ({ key: o.key, label: o.label || o.key }));
    }
  } catch {
    // 非法 JSON 静默回退
  }
  return [];
}

interface SiteSettings {
  site_id: string;
  site_name: string;
  site_brand_label: string;
  /** 解析出的品牌;站点设置未返回或站名认不出时为 null(此时沿用首屏判定) */
  brand: BrandId | null;
  site_subtitle: string;
  site_logo: string;
  api_base_url: string;
  frontend_url: string;
  contact_info: string;
  doc_url: string;
  home_content: string;
  registration_enabled: boolean;
  email_verify_enabled: boolean;
  oauth_google_enabled: boolean;
  oauth_github_enabled: boolean;
  // 分销邀请开关（控制台据此显示「我的邀请」入口）
  referral_enabled: boolean;
  // 整站通知与历史（管理员在独立通知栏目配置，公开设置接口下发）
  announcement_enabled: boolean;
  announcement_id: string;
  announcement_title: string;
  announcement_level: string;
  announcement_content: string;
  notifications: SiteNotification[];
  // 博客可投放站点选项(后台编辑器「发布站点」多选);空=未配置多站,编辑器隐藏该选择器
  blog_sites: BlogSiteOption[];
  settings_loaded: boolean;
}

const defaults: SiteSettings = {
  site_id: '',
  site_name: 'HopBase',
  site_brand_label: 'HopBase',
  brand: null,
  site_subtitle: 'Control Panel',
  site_logo: '',
  api_base_url: '',
  frontend_url: '',
  contact_info: '',
  doc_url: '',
  home_content: '',
  registration_enabled: true,
  email_verify_enabled: false,
  oauth_google_enabled: false,
  oauth_github_enabled: false,
  referral_enabled: false,
  announcement_enabled: false,
  announcement_id: '',
  announcement_title: '',
  announcement_level: 'info',
  announcement_content: '',
  notifications: [],
  blog_sites: [],
  settings_loaded: false,
};

const SiteSettingsContext = createContext<SiteSettings>(defaults);

export function SiteSettingsProvider({ children }: { children: ReactNode }) {
  const { data, isPending } = useQuery({
    queryKey: queryKeys.siteSettings(),
    queryFn: () => settingsApi.getPublic(),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  // 来源站可能在登录后由 adoptOriginSite（注册归因兜底）补写，订阅其变化重算品牌
  const originSite = useSyncExternalStore(subscribeOriginSite, getOriginSite);

  const value: SiteSettings = useMemo(() => {
    const branding = parseSitesBranding(data?.sites_branding)[originSite];
    return {
    ...defaults,
    ...data,
    // 来源站品牌覆盖：来源站在 sites_branding 有配置时优先生效
    site_id: originSite,
    // 品牌只按「站点设置 + 是否配置了该来源站」判定,?ref= 之类未配置的来源站不算品牌
    brand: data === undefined ? null : resolveBrand({ siteId: originSite, siteName: data.site_name, hasSiteBranding: !!branding }),
    site_name: branding?.name || data?.site_name || defaults.site_name,
    site_brand_label: branding?.brand_label || branding?.blog_chrome?.brand_label || branding?.name || data?.site_name || defaults.site_brand_label,
    site_logo: branding?.logo || data?.site_logo || defaults.site_logo,
    doc_url: branding?.doc_url || data?.doc_url || defaults.doc_url,
    // Boolean 字段从字符串转换
    registration_enabled: data?.registration_enabled !== 'false',
    email_verify_enabled: data?.email_verify_enabled === 'true',
    oauth_google_enabled: data?.oauth_google_enabled === 'true',
    oauth_github_enabled: data?.oauth_github_enabled === 'true',
    referral_enabled: data?.referral_enabled === 'true',
    announcement_enabled: data?.announcement_enabled === 'true',
    announcement_id: data?.announcement_id || '',
    announcement_title: data?.announcement_title || '',
    announcement_level: data?.announcement_level || 'info',
    announcement_content: data?.announcement_content || '',
    notifications: mergeLegacyNotification(
      parseNotificationHistory(data?.announcement_history_json),
      {
        title: data?.announcement_title,
        content: data?.announcement_content,
        level: data?.announcement_level,
      },
    ),
    blog_sites: parseBlogSites(data?.blog_sites),
    settings_loaded: !isPending,
    };
  }, [data, isPending, originSite]);

  // Apply tenant branding before route-specific shells mount, including the login page.
  useEffect(() => {
    const logoHref = value.site_logo || defaultLogoUrl;
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = logoHref;
    document.title = value.site_name || defaults.site_name;
  }, [value.site_logo, value.site_name]);

  // 站点设置返回后把解析出的品牌写到 <html data-brand>:皮肤(styles/brand-hopbase.css)
  // 只对 hopbase 生效,ToC 品牌不受影响。请求失败或站名认不出时 brand 为 null,
  // 保持首屏的域名判定不动,绝不回落成 HopBase。
  useEffect(() => {
    if (value.brand) applyBrand(value.brand);
  }, [value.brand]);

  return (
    <SiteSettingsContext.Provider value={value}>
      {children}
    </SiteSettingsContext.Provider>
  );
}

export function useSiteSettings(): SiteSettings {
  return useContext(SiteSettingsContext);
}
