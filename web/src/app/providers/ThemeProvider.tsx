import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { injectThemeStyle, setTheme, type ThemeName } from '@doudou-start/airgate-theme';
import { defaultThemeForBrand, getCurrentBrand } from '../../shared/brand';

interface ThemeContextValue {
  theme: ThemeName;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

// SDK 自带的读取函数把「没存过」也当成 dark;这里区分开:用户存过就尊重,
// 没存过按品牌给默认(HopBase 与官网衔接用浅色,其余品牌沿用深色)。
function readStoredTheme(): ThemeName | null {
  try {
    const stored = localStorage.getItem('ag-theme');
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    return null;
  }
}

export function initialTheme(): ThemeName {
  return readStoredTheme() ?? defaultThemeForBrand(getCurrentBrand());
}

function syncHeroUIThemeClass(theme: ThemeName) {
  document.documentElement.classList.toggle('light', theme === 'light');
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeName>(initialTheme);

  // 初始化：注入 AirGate CSS 变量。
  useEffect(() => {
    injectThemeStyle();
  }, []);

  // 主题变化时同步 AirGate data-theme 与 HeroUI light/dark class。
  useEffect(() => {
    setTheme(theme);
    syncHeroUIThemeClass(theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setThemeState((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);
  const value = useMemo(() => ({ theme, toggleTheme }), [theme, toggleTheme]);

  return (
    <ThemeContext value={value}>
      {children}
    </ThemeContext>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme 必须在 ThemeProvider 内使用');
  return ctx;
}
