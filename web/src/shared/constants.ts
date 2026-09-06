/** 默认分页大小 */
export const DEFAULT_PAGE_SIZE = 20;

/** 分页大小选项 */
export const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

/** 全量拉取参数（用于下拉选择等场景） */
export const FETCH_ALL_PARAMS = { page: 1, page_size: 100 } as const;

/** 使用记录 Token 指标色，表格与趋势图共用 */
export const USAGE_TOKEN_COLORS = {
  input: 'var(--chart-token-input)',
  output: 'var(--chart-token-output)',
  cacheCreation: 'var(--chart-token-cache-creation)',
  cacheRead: 'var(--ag-muted)',
  cacheRatio: 'var(--chart-token-cache-ratio)',
  cacheCumulativeRatio: 'var(--success)',
} as const;

/** 饼图调色板:取自 CSS 变量 --chart-1..10(默认低饱和十色;HopBase 品牌换成墨/橙/灰绿/信息蓝序列) */
export const PIE_CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
  'var(--chart-7)',
  'var(--chart-8)',
  'var(--chart-9)',
  'var(--chart-10)',
] as const;

/** 头像颜色池（引用 SDK 装饰色） */
export { decorativePalette as AVATAR_COLORS } from '@doudou-start/airgate-theme';
