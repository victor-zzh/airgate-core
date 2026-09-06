import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { injectThemeStyle, setTheme, type ThemeName } from '@doudou-start/airgate-theme';
import { defaultThemeForBrand, getCurrentBrand, subscribeBrand } from '../../shared/brand';

interface ThemeContextValue {
  theme: ThemeName;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

// SDK 的 setTheme 每次都把当前主题写进 'ag-theme',分不清「用户选的」和「系统给的默认」;
// 历史上所有打开过控制台的浏览器都因此被写成 dark。这里另记一个"用户点过切换"的标记,
// 只有点过的才算偏好;没点过的按品牌给默认(HopBase 与官网衔接用浅色,其余品牌沿用深色),
// 并在站点设置解析出品牌后重算一次。
const THEME_CHOICE_KEY = 'ag-theme-choice';

function readStoredTheme(): ThemeName | null {
  try {
    const stored = localStorage.getItem('ag-theme');
    return stored === 'light' || stored === 'dark' ? stored : null;
  } catch {
    return null;
  }
}

function userChoseTheme(): boolean {
  try {
    return localStorage.getItem(THEME_CHOICE_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberThemeChoice(): void {
  try {
    localStorage.setItem(THEME_CHOICE_KEY, '1');
  } catch {
    // localStorage 不可用时,切换仍在本次会话内生效
  }
}

export function initialTheme(): ThemeName {
  if (userChoseTheme()) return readStoredTheme() ?? defaultThemeForBrand(getCurrentBrand());
  return defaultThemeForBrand(getCurrentBrand());
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

  // 品牌在站点设置返回后可能变化;没有用户偏好时跟着品牌重算默认主题。
  useEffect(() => subscribeBrand((brand) => {
    if (userChoseTheme()) return;
    setThemeState(defaultThemeForBrand(brand));
  }), []);

  const toggleTheme = useCallback(() => {
    rememberThemeChoice();
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
