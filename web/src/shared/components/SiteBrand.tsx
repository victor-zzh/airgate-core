import { useTranslation } from 'react-i18next';
import { defaultLogoUrl, useSiteSettings } from '../../app/providers/SiteSettingsProvider';

interface SiteBrandProps {
  className?: string;
  iconOnly?: boolean;
  iconSize?: number;
}

/**
 * Console brand lockup. Essevin mirrors the ToC site's droplet + bilingual
 * wordmark; other tenants retain their configured mark and label.
 */
export function SiteBrand({ className = '', iconOnly = false, iconSize = 30 }: SiteBrandProps) {
  const site = useSiteSettings();
  const { i18n } = useTranslation();
  const siteName = site.site_name.trim();
  // 品牌判定集中在 SiteSettingsProvider(shared/brand.ts),这里只消费结果
  const isEssevin = site.brand === 'essevin';
  const isKite = site.brand === 'kite';
  const language = i18n.resolvedLanguage || i18n.language || '';
  const isChinese = language.startsWith('zh');
  const localName = language === 'zh-CN' || language === 'zh' ? '萃灵' : '萃靈';
  const label = isEssevin
    ? `${isChinese ? `${localName} ` : ''}Essevin`
    : site.site_brand_label || siteName || 'HopBase';
  const logoScale = iconSize / 30;
  const localFontSize = 21.6 * logoScale;
  const englishFontSize = (isChinese ? 16.8 : 20.8) * logoScale;

  return (
    <span
      aria-label={label}
      className={`inline-flex min-w-0 items-center ${className}`}
      role="img"
      style={{ gap: iconOnly ? 0 : 10 }}
    >
      {isEssevin ? (
        <svg
          aria-hidden="true"
          className="shrink-0"
          fill="none"
          height={iconSize}
          viewBox="0 0 32 32"
          width={iconSize}
        >
          <path
            d="M16 5C16 5 9.5 12.6 9.5 18.2C9.5 21.9 12.4 24.9 16 24.9C19.6 24.9 22.5 21.9 22.5 18.2C22.5 12.6 16 5 16 5Z"
            fill="#ECE1DA"
            stroke="#B5836F"
            strokeWidth="1.4"
          />
          <circle cx="16" cy="18.3" fill="#B5836F" r="2.5" />
          <path d="M16 15.6V21" stroke="#FBFAF6" strokeLinecap="round" strokeWidth="1" />
        </svg>
      ) : (
        <span
          aria-hidden="true"
          className={`inline-flex shrink-0 items-center justify-center overflow-hidden ${isKite ? 'bg-[#f3f7f3]' : ''}`}
          style={{
            borderRadius: isKite ? 4 : 0,
            height: iconSize,
            padding: isKite ? Math.max(2, Math.round(iconSize * 0.075)) : 0,
            width: iconSize,
          }}
        >
          <img
            alt=""
            className="h-full w-full object-contain"
            src={site.site_logo || defaultLogoUrl}
          />
        </span>
      )}
      {!iconOnly && isEssevin && (
        <span className="inline-flex min-w-0 items-baseline" style={{ gap: 8, whiteSpace: 'nowrap' }}>
          {isChinese && (
            <span
              style={{
                color: 'currentColor',
                fontFamily: '"Newsreader", "Noto Serif TC", "Source Serif 4", Georgia, "Songti TC", "Songti SC", serif',
                fontSize: localFontSize,
                fontWeight: 500,
                lineHeight: 1,
              }}
            >
              {localName}
            </span>
          )}
          <span
            style={{
              color: '#B5836F',
              fontFamily: '"Newsreader", "Source Serif 4", Georgia, serif',
              fontSize: englishFontSize,
              fontWeight: 500,
              lineHeight: 1,
            }}
          >
            Essevin
          </span>
        </span>
      )}
      {!iconOnly && !isEssevin && (
        <span className="truncate text-base font-semibold text-current">{label}</span>
      )}
    </span>
  );
}
