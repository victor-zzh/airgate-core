import { describe, expect, it } from 'vitest';
import { defaultThemeForBrand, provisionalBrand, resolveBrand } from './brand';

describe('resolveBrand', () => {
  it('无来源站即 HopBase', () => {
    expect(resolveBrand({ siteId: '', siteName: 'HopBase' })).toBe('hopbase');
    expect(resolveBrand({})).toBe('hopbase');
  });

  it('ink 来源站或站名 Essevin 归 essevin', () => {
    expect(resolveBrand({ siteId: 'ink', siteName: 'HopBase' })).toBe('essevin');
    expect(resolveBrand({ siteId: '', siteName: 'Essevin' })).toBe('essevin');
    expect(resolveBrand({ siteId: '', siteName: 'essevin' })).toBe('essevin');
  });

  it('kite 按 site_id 或品牌文案识别', () => {
    expect(resolveBrand({ siteId: 'kite' })).toBe('kite');
    expect(resolveBrand({ siteId: '', siteName: 'Kite AI', brandLabel: 'Kite' })).toBe('kite');
    expect(resolveBrand({ siteId: '', logo: '/sites/kite/logo.svg' })).toBe('kite');
  });

  it('其它来源站按 site_id 原样作为品牌', () => {
    expect(resolveBrand({ siteId: 'open-late', siteName: 'HopBase' })).toBe('open-late');
  });
});

describe('provisionalBrand', () => {
  it('记住的品牌优先', () => {
    expect(provisionalBrand('api.hop-base.com', 'essevin')).toBe('essevin');
  });

  it('hop-base.com 域与本地开发按 HopBase', () => {
    expect(provisionalBrand('api.hop-base.com', null)).toBe('hopbase');
    expect(provisionalBrand('HOP-BASE.COM', null)).toBe('hopbase');
    expect(provisionalBrand('localhost', null)).toBe('hopbase');
  });

  it('未知域名不猜', () => {
    expect(provisionalBrand('console.essevin.example', null)).toBeNull();
  });
});

describe('defaultThemeForBrand', () => {
  it('HopBase 默认浅色,其余沿用深色', () => {
    expect(defaultThemeForBrand('hopbase')).toBe('light');
    expect(defaultThemeForBrand('essevin')).toBe('dark');
    expect(defaultThemeForBrand(null)).toBe('dark');
  });
});
