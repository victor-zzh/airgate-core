import type { CSSProperties } from 'react';

interface HopLoaderProps {
  /** sm 用于按钮 / 行内,lg 用于面板与整块占位 */
  size?: 'sm' | 'lg';
  /** 可选的状态文字,永远建议配一句(如"创建中") */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * HopBase 的 loading:三枚小方块在一条发丝线上依次跳起(hop = 品牌名)。
 * 用它替代转圈;闪烁光标只留给流式输出的文字。
 * 样式在 styles/brand-hopbase-shell.css(.ag-hop*),非 HopBase 品牌下回落到 --accent 色。
 */
export function HopLoader({ size = 'sm', label, className = '', style }: HopLoaderProps) {
  return (
    <span
      aria-label={label ?? 'Loading'}
      aria-live="polite"
      className={`ag-hop-wrap ${className}`.trim()}
      role="status"
      style={style}
    >
      <span aria-hidden="true" className={`ag-hop${size === 'lg' ? ' ag-hop--lg' : ''}`}>
        <i />
        <i />
        <i />
      </span>
      {label ? <span className="ag-hop-label">{label}</span> : null}
    </span>
  );
}
