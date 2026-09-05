// 品牌判定:同一套控制台服务 HopBase(ToB)与 Essevin / kite 等 ToC 品牌。
// 视觉皮肤(styles/brand-hopbase.css)只对 <html data-brand="hopbase"> 生效,
// 因此这里集中决定「当前是哪个品牌」,并把结果写到 <html> 与 localStorage:
//   · 首屏(站点设置尚未返回)用上次记住的品牌,或按域名给临时值,避免闪一下中性灰;
//   · 站点设置返回后按 site_id / site_name 复算,以设置为准。

export type BrandId = 'hopbase' | 'essevin' | 'kite' | (string & {});

const STORAGE_KEY = 'ag_brand';
const BRAND_ATTR = 'data-brand';

/** 主题默认值按品牌给:HopBase 与官网衔接用浅色,其余品牌沿用 SDK 的深色。 */
export function defaultThemeForBrand(brand: BrandId | null | undefined): 'light' | 'dark' {
  return brand === 'hopbase' ? 'light' : 'dark';
}

/**
 * 按站点设置解析品牌。规则与 SiteBrand 组件一致:
 * ink / Essevin → essevin;kite → kite;其余来源站按 site_id;没有来源站即 HopBase。
 */
export function resolveBrand(input: { siteId?: string; siteName?: string; brandLabel?: string; logo?: string }): BrandId {
  const siteId = (input.siteId ?? '').trim().toLowerCase();
  const siteName = (input.siteName ?? '').trim();
  const haystack = `${siteName} ${input.brandLabel ?? ''} ${input.logo ?? ''}`;
  if (siteId === 'ink' || siteName.toLowerCase() === 'essevin') return 'essevin';
  if (siteId === 'kite' || /kite/i.test(haystack)) return 'kite';
  if (siteId) return siteId;
  return 'hopbase';
}

/** 首屏临时品牌:上次记住的优先;否则 hop-base.com 域与本地开发按 HopBase,其它未知。 */
export function provisionalBrand(hostname: string, stored: string | null): BrandId | null {
  if (stored) return stored;
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('hop-base.com')) return 'hopbase';
  return null;
}

export function getStoredBrand(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function getCurrentBrand(): string | null {
  if (typeof document === 'undefined') return null;
  return document.documentElement.getAttribute(BRAND_ATTR);
}

/** 写 <html data-brand> 并记住;传 null 表示未知,清掉属性但不动记忆。 */
export function applyBrand(brand: BrandId | null): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (!brand) {
    root.removeAttribute(BRAND_ATTR);
    return;
  }
  if (root.getAttribute(BRAND_ATTR) !== brand) root.setAttribute(BRAND_ATTR, brand);
  try {
    window.localStorage.setItem(STORAGE_KEY, brand);
  } catch {
    // localStorage 不可用(隐私模式等)时只影响下次首屏是否闪灰,静默
  }
}

/** 启动时在 React 渲染前调用一次,给首屏一个品牌。 */
export function applyProvisionalBrand(): void {
  if (typeof window === 'undefined') return;
  applyBrand(provisionalBrand(window.location.hostname, getStoredBrand()));
}
