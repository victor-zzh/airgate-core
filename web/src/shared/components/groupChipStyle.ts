import type { CSSProperties } from 'react';

// 分组徽记:走主题的强调色(HopBase 为橙,其它品牌回落主色),浅底 + 同色 30% 描边 + 墨色字,
// 不再是与主题无关的蓝色。
export const GROUP_CHIP_STYLE: CSSProperties = {
  background: 'var(--ag-primary-subtle)',
  boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--ag-accent, var(--ag-primary)) 30%, transparent)',
  color: 'var(--ag-text)',
};
