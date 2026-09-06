import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SiteBrand } from '../../shared/components/SiteBrand';

type HeroTab = 'claude' | 'codex' | 'curl';

const HERO_TABS: Array<{ id: HeroTab; label: string }> = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'curl', label: 'cURL' },
];

const SAMPLE_KEY = 'sk-hb-xxxxxxxxxxxxxxxxxxxxxxxx';

interface LoginHeroProps {
  /** 接入地址,与「使用配置」弹窗同源:站点配置优先,否则用当前 origin */
  baseUrl: string;
  className?: string;
}

/**
 * 登录页左半:官网首屏 quickstart 终端面板的镜像(只在 HopBase 品牌渲染,恒为暖炭深色)。
 * 纯展示:三个 tab 只切换示例片段,不发请求、不读用户数据。
 */
export function LoginHero({ baseUrl, className = '' }: LoginHeroProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<HeroTab>('claude');
  const host = baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const prompt = t('auth.hero_prompt');
  const routeNote = t('auth.hero_route_note');
  const usage = t('auth.hero_usage');
  const logged = t('auth.hero_logged');

  const output = (model: string) => (
    <div className="ag-login-term-out">
      <span className="k">route</span><b>{model}</b> → <i>primary</i> <span className="dim">({routeNote})</span>
      {'\n'}
      <span className="k">usage</span><b>{usage}</b> · <i>{logged}</i>
    </div>
  );

  const body = tab === 'claude'
    ? (
      <>
        <span className="cm"># {t('auth.hero_comment')}</span>{'\n'}
        <span className="pr">$</span> <span className="kw">export</span> ANTHROPIC_BASE_URL=<span className="st">&quot;{baseUrl}&quot;</span>{'\n'}
        <span className="pr">$</span> <span className="kw">export</span> ANTHROPIC_API_KEY=<span className="st">&quot;{SAMPLE_KEY}&quot;</span>{'\n\n'}
        <span className="pr">$</span> <span className="kw">claude</span> <span className="st">&quot;{prompt}&quot;</span>
        {output('claude-sonnet-5')}
        <span className="pr">$</span> <span aria-hidden="true" className="ag-login-cursor" />
      </>
    )
    : tab === 'codex'
      ? (
        <>
          <span className="pr">$</span> <span className="kw">export</span> OPENAI_BASE_URL=<span className="st">&quot;{baseUrl}/v1&quot;</span>{'\n'}
          <span className="pr">$</span> <span className="kw">export</span> OPENAI_API_KEY=<span className="st">&quot;{SAMPLE_KEY}&quot;</span>{'\n\n'}
          <span className="pr">$</span> <span className="kw">codex</span> <span className="st">&quot;{prompt}&quot;</span>
          {output('gpt-5.6')}
          <span className="pr">$</span> <span aria-hidden="true" className="ag-login-cursor" />
        </>
      )
      : (
        <>
          <span className="pr">$</span> <span className="kw">curl</span> <span className="st">{baseUrl}/v1/chat/completions</span> \{'\n'}
          {'    '}-H <span className="st">&quot;Authorization: Bearer {SAMPLE_KEY}&quot;</span> \{'\n'}
          {'    '}-H <span className="st">&quot;Content-Type: application/json&quot;</span> \{'\n'}
          {'    '}-d <span className="st">{`'{"model":"gpt-5.6","messages":[{"role":"user","content":"${prompt}"}]}'`}</span>
          <div className="ag-login-term-out">
            <span className="k">200</span><b>{'{"usage":{"prompt_tokens":1248,"completion_tokens":386}}'}</b> · <i>{logged}</i>
          </div>
          <span className="pr">$</span> <span aria-hidden="true" className="ag-login-cursor" />
        </>
      );

  return (
    <div className={`ag-login-hero ${className}`.trim()}>
      <div className="ag-login-hero-brand">
        <SiteBrand iconSize={26} />
      </div>
      <div className="ag-login-hero-copy">
        <div className="ag-login-hero-kicker">Enterprise · AI gateway · {host}</div>
        <h2 className="ag-login-hero-title">{t('auth.hero_title')}</h2>
        <p className="ag-login-hero-desc">{t('auth.hero_desc')}</p>
      </div>
      <div className="ag-login-term">
        <div className="ag-login-term-hd">
          <span className="ag-login-term-title">hopbase — <b>quickstart</b></span>
          <div aria-label="quickstart" className="ag-login-term-tabs" role="tablist">
            {HERO_TABS.map((item) => (
              <button
                aria-selected={tab === item.id}
                key={item.id}
                role="tab"
                type="button"
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <pre className="ag-login-term-bd">{body}</pre>
      </div>
    </div>
  );
}
