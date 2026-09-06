// 品牌判定:同一套控制台服务 HopBase(ToB)与 Essevin / kite 等 ToC 品牌。
// 视觉皮肤(styles/brand-hopbase.css)只对 <html data-brand="hopbase"> 生效,
// 因此这里集中决定「当前是哪个品牌」,并把结果写到 <html> 与 localStorage:
//   · 首屏(站点设置尚未返回)按域名给临时值,域名不能判定时用上次记住的;
//   · 站点设置返回后按 site_id / site_name / sites_branding 复算,以设置为准;
//   · 复算不出(站名不认识)就保持首屏的判定,绝不"回落成 HopBase"。

export type BrandId = 'hopbase' | 'essevin' | 'kite' | (string & {});

const STORAGE_KEY = 'ag_brand';
const BRAND_ATTR = 'data-brand';
const HOPBASE_ROOT = 'hop-base.com';
// 与 originSite.ts 的站点 ID 规则一致:字母数字开头,可含 - _,最长 64。
const BRAND_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** 主题默认值按品牌给:HopBase 与官网衔接用浅色,其余品牌沿用 SDK 的深色。 */
export function defaultThemeForBrand(brand: BrandId | null | undefined): 'light' | 'dark' {
  return brand === 'hopbase' ? 'light' : 'dark';
}

/** host 是否等于 root 或其子域(拒绝 nothop-base.com 这类后缀碰瓷)。 */
export function isHostUnder(hostname: string, root: string): boolean {
  const host = hostname.toLowerCase();
  return host === root || host.endsWith(`.${root}`);
}

export interface ResolveBrandInput {
  /** 来源站 ID(?site= / 注册归因),可能是任意字符串 */
  siteId?: string;
  /** 站点设置里的站名 */
  siteName?: string;
  /** 来源站在 sites_branding 里有配置——只有这种来源站才算一个品牌 */
  hasSiteBranding?: boolean;
}

/**
 * 按站点设置解析品牌。返回 null 表示"认不出",调用方应保持当前判定不动。
 * ink / 站名 Essevin → essevin;kite → kite;有 sites_branding 配置的来源站按 site_id;
 * 站名是 HopBase(或空)→ hopbase。不认识的站名不猜。
 */
export function resolveBrand(input: ResolveBrandInput): BrandId | null {
  const siteId = (input.siteId ?? '').trim().toLowerCase();
  const siteName = (input.siteName ?? '').trim().toLowerCase();
  if (siteId === 'ink' || siteName === 'essevin') return 'essevin';
  if (siteId === 'kite' || siteName === 'kite') return 'kite';
  if (siteId && input.hasSiteBranding && BRAND_PATTERN.test(siteId)) return siteId;
  if (siteName === '' || siteName === 'hopbase' || siteName === 'hop-base') return 'hopbase';
  return null;
}

/** 首屏临时品牌:域名能判定就以域名为准(hop-base.com 及子域、本地开发 = HopBase),否则用记住的。 */
export function provisionalBrand(hostname: string, stored: string | null): BrandId | null {
  const host = hostname.toLowerCase();
  if (isHostUnder(host, HOPBASE_ROOT) || host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
    return 'hopbase';
  }
  if (stored && BRAND_PATTERN.test(stored)) return stored.toLowerCase();
  return null;
}

export function getStoredBrand(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function getCurrentBrand(): BrandId | null {
  if (typeof document === 'undefined') return null;
  return document.documentElement.getAttribute(BRAND_ATTR);
}

// 品牌变化订阅:ThemeProvider 据此在没有用户主题偏好时重算默认主题。
const listeners = new Set<(brand: BrandId | null) => void>();

export function subscribeBrand(listener: (brand: BrandId | null) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** 写 <html data-brand> 并记住;传 null 表示未知,清掉属性但不动记忆。 */
export function applyBrand(brand: BrandId | null): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const previous = root.getAttribute(BRAND_ATTR);
  if (!brand) {
    root.removeAttribute(BRAND_ATTR);
  } else {
    if (previous !== brand) root.setAttribute(BRAND_ATTR, brand);
    try {
      window.localStorage.setItem(STORAGE_KEY, brand);
    } catch {
      // localStorage 不可用(隐私模式等)时只影响下次首屏,静默
    }
  }
  if (previous !== (brand ?? null)) listeners.forEach((listener) => listener(brand));
}

/** 启动时在 React 渲染前调用一次,给首屏一个品牌。 */
export function applyProvisionalBrand(): void {
  if (typeof window === 'undefined') return;
  applyBrand(provisionalBrand(window.location.hostname, getStoredBrand()));
}
