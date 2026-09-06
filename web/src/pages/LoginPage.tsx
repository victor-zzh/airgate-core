import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card, Checkbox, FieldError, Form, Input, Label, Link as HeroLink, Tabs, TextField as HeroTextField } from '@heroui/react';
import { useAuth } from '../app/providers/AuthProvider';
import { useSiteSettings } from '../app/providers/SiteSettingsProvider';
import { authApi } from '../shared/api/auth';
import { usersApi } from '../shared/api/users';
import { referralApi } from '../shared/api/referral';
import { queryKeys } from '../shared/queryKeys';
import { useTheme } from '../app/providers/ThemeProvider';
import { getOriginSite } from '../shared/originSite';
import { clearInviteCode, getInviteCode, getInviteCodeFromURL } from '../shared/inviteCode';
import { LanguageSwitcher } from '../shared/components/LanguageSwitcher';
import {
  ApiError,
  beginAuthenticationAttempt,
  clearTokenIfSessionCurrent,
  getSessionIdentity,
  isSessionIdentityCurrent,
  setToken,
  type SessionIdentity,
} from '../shared/api/client';
import { consumeAuthReturnTo } from '../shared/authReturnTo';
import { SiteBrand } from '../shared/components/SiteBrand';
import { LoginHero } from './login/LoginHero';
import { useCurrentBrand } from '../shared/brand';
import { markNewRegistration } from '../shared/onboarding/storage';
import { Mail, Lock, User, ArrowRight, Sun, Moon, ShieldCheck, Layers, Gauge, BarChart3, BadgeCheck } from 'lucide-react';

/* ==================== 第三方登录 ==================== */

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M23.52 12.27c0-.85-.08-1.66-.22-2.45H12v4.63h6.46a5.53 5.53 0 0 1-2.4 3.63v3h3.88c2.27-2.09 3.58-5.17 3.58-8.81z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3.01c-1.07.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.72-4.95H1.27v3.11A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.28 14.28a7.22 7.22 0 0 1 0-4.56V6.61H1.27a12 12 0 0 0 0 10.78l4.01-3.11z" />
      <path fill="#EA4335" d="M12 4.77c1.76 0 3.35.61 4.6 1.8l3.44-3.44A11.53 11.53 0 0 0 12 0 12 12 0 0 0 1.27 6.61l4.01 3.11C6.22 6.88 8.87 4.77 12 4.77z" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55 0-.27-.01-1.17-.02-2.12-3.2.7-3.87-1.36-3.87-1.36-.52-1.33-1.28-1.68-1.28-1.68-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.19 1.76 1.19 1.03 1.75 2.69 1.25 3.34.95.1-.74.4-1.25.72-1.53-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11.05 11.05 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.35.77 1.05.77 2.12 0 1.53-.01 2.76-.01 3.14 0 .3.2.67.8.55A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
    </svg>
  );
}

/* ==================== 左侧动态背景 ==================== */

// 登录页左侧装饰面板的动态背景：柔光极光缓慢漂移 + 粒子节点连线（网关/网络意象）。
// 纯 canvas 自绘、无外部素材；prefers-reduced-motion 时只绘静态首帧。
function LoginAmbientCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let width = 0;
    let height = 0;
    let raf = 0;

    type AmbientNode = { x: number; y: number; vx: number; vy: number; r: number };
    let nodes: AmbientNode[] = [];
    const LINK_DIST = 130;

    const seedNodes = () => {
      // 节点密度随面板面积走，钳在 28–56 之间避免小屏过密/大屏过疏
      const count = Math.round(Math.min(56, Math.max(28, (width * height) / 26000)));
      nodes = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.16,
        vy: (Math.random() - 0.5) * 0.16,
        r: 0.8 + Math.random() * 1.4,
      }));
    };

    const drawFrame = (t: number) => {
      ctx.clearRect(0, 0, width, height);
      // 三团大半径柔光沿各自轨道缓慢漂移，叠出"极光"层
      const base = Math.max(width, height);
      const blobs = [
        { cx: width * 0.28 + Math.cos(t * 0.00012) * width * 0.1, cy: height * 0.3 + Math.sin(t * 0.00009) * height * 0.1, r: base * 0.42, a: 0.075 },
        { cx: width * 0.72 + Math.cos(t * 0.00008 + 2) * width * 0.12, cy: height * 0.72 + Math.sin(t * 0.00011 + 1) * height * 0.1, r: base * 0.38, a: 0.05 },
        { cx: width * 0.55 + Math.cos(t * 0.0001 + 4) * width * 0.14, cy: height * 0.16 + Math.sin(t * 0.00013 + 3) * height * 0.08, r: base * 0.3, a: 0.045 },
      ];
      for (const b of blobs) {
        const g = ctx.createRadialGradient(b.cx, b.cy, 0, b.cx, b.cy, b.r);
        g.addColorStop(0, `rgba(255,255,255,${b.a})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, width, height);
      }
      // 粒子连线
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        if (!a) continue;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          if (!b) continue;
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          if (dist < LINK_DIST) {
            ctx.strokeStyle = `rgba(255,255,255,${((1 - dist / LINK_DIST) * 0.14).toFixed(3)})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
      for (const n of nodes) {
        ctx.fillStyle = 'rgba(255,255,255,0.35)';
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seedNodes();
      if (reducedMotion) drawFrame(0);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    if (!reducedMotion) {
      const loop = (t: number) => {
        for (const n of nodes) {
          n.x += n.vx;
          n.y += n.vy;
          if (n.x < -8) n.x = width + 8;
          else if (n.x > width + 8) n.x = -8;
          if (n.y < -8) n.y = height + 8;
          else if (n.y > height + 8) n.y = -8;
        }
        drawFrame(t);
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />;
}

// OAuth 登录按钮区：受协议勾选约束，未勾选时提示与表单一致的错误
function OAuthButtons({
  acceptedAgreement,
  onAgreementMissing,
  onAuthenticationStart,
}: {
  acceptedAgreement: boolean;
  onAgreementMissing: () => void;
  onAuthenticationStart: () => void;
}) {
  const { t } = useTranslation();
  const site = useSiteSettings();
  const providers = [
    site.oauth_google_enabled ? { id: 'google', label: t('auth.oauth_google', { defaultValue: 'Continue with Google' }), icon: <GoogleIcon /> } : null,
    site.oauth_github_enabled ? { id: 'github', label: t('auth.oauth_github', { defaultValue: 'Continue with GitHub' }), icon: <GitHubIcon /> } : null,
  ].filter(Boolean) as Array<{ id: string; label: string; icon: React.ReactNode }>;

  if (!providers.length) return null;

  return (
    <div className="w-full">
      <div className="my-5 flex items-center gap-3">
        <span className="h-px flex-1 bg-glass-border" />
        <span className="text-[11px] text-text-tertiary">{t('auth.oauth_divider', { defaultValue: 'or' })}</span>
        <span className="h-px flex-1 bg-glass-border" />
      </div>
      <div className="space-y-2.5">
        {providers.map((provider) => (
          <Button
            key={provider.id}
            type="button"
            variant="secondary"
            className="w-full h-10 justify-center gap-2"
            onPress={() => {
              if (!acceptedAgreement) {
                onAgreementMissing();
                return;
              }
              onAuthenticationStart();
              // 注册归因（来源站/邀请码）经 query 交给后端签进 OAuth state 往返穿透，
              // 否则第三方授权跳转会丢归因（OAuth 注册用户查不到来源）。
              const attribution = new URLSearchParams();
              const site = getOriginSite();
              const invite = getInviteCode();
              if (site) attribution.set('source_site', site);
              if (invite) attribution.set('invite_code', invite);
              // 回跳源：回调固定落 api_base_url 域，控制台与 api 不同域时（ToC）据此跳回本域，
              // 否则登录态落回调域、回到本域显示未登录。后端按白名单校验后才采用。
              attribution.set('return_origin', window.location.origin);
              const query = attribution.toString();
              window.location.href = `/api/v1/auth/oauth/${provider.id}/authorize${query ? `?${query}` : ''}`;
            }}
          >
            {provider.icon}
            {provider.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

type TabKey = 'login' | 'register';
type AuthenticationAttempt = {
  controller: AbortController;
  identity: SessionIdentity;
};
type AuthenticationFormProps = {
  startAuthenticationAttempt: () => AuthenticationAttempt;
  cancelAuthenticationAttempt: (attempt: AuthenticationAttempt) => void;
};
type LoginFormProps = AuthenticationFormProps & {
  cancelActiveAuthenticationAttempt: () => void;
};

function useAuthenticationAttemptOwner(
  cancelAuthenticationAttempt: (attempt: AuthenticationAttempt) => void,
) {
  const attemptRef = useRef<AuthenticationAttempt | null>(null);

  // Layout cleanup advances the epoch during the unmount commit, before a
  // settings-driven form replacement can accept the removed form's response.
  useLayoutEffect(() => () => {
    const attempt = attemptRef.current;
    attemptRef.current = null;
    if (attempt) cancelAuthenticationAttempt(attempt);
  }, [cancelAuthenticationAttempt]);

  return attemptRef;
}

// 后端错误文案是简体中文硬编码;登录/注册是匿名用户第一触点(ToC 多落地页繁体/英文受众),
// 已知消息按界面语言本地化,未命中映射的消息原样展示(后端新增错误时自然回退)。
const SERVER_MESSAGE_KEYS: Record<string, string> = {
  '邮箱或密码错误': 'auth.be_invalid_credentials',
  '账户已禁用': 'auth.be_user_disabled',
  '邮箱已注册': 'auth.be_email_exists',
  '注册功能已关闭': 'auth.be_registration_disabled',
  '请输入验证码': 'auth.be_verify_code_required',
  '验证码无效或已过期': 'auth.be_verify_code_invalid',
  '请求参数格式不正确，请检查输入': 'auth.be_bad_request',
  '发送邮件失败': 'auth.be_send_mail_failed',
  '邮件服务未配置': 'auth.be_mailer_not_configured',
};

function localizeServerMessage(t: (key: string) => string, message: string): string {
  const key = SERVER_MESSAGE_KEYS[message];
  return key ? t(key) : message;
}

function AgreementCheckbox({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (selected: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <Checkbox className="items-start" isSelected={checked} onChange={onChange}>
      <Checkbox.Control>
        <Checkbox.Indicator />
      </Checkbox.Control>
      <Checkbox.Content>
        <span className="text-xs leading-relaxed text-text-secondary">
          {t('auth.agreement_prefix')}
          <HeroLink
            href="/legal/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="mx-1 text-primary hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            {t('auth.terms_link')}
          </HeroLink>
          {t('auth.agreement_middle')}
          <HeroLink
            href="/legal/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="mx-1 text-primary hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            {t('auth.privacy_link')}
          </HeroLink>
        </span>
      </Checkbox.Content>
    </Checkbox>
  );
}

/* ==================== 登录表单 ==================== */

function LoginForm({
  startAuthenticationAttempt,
  cancelAuthenticationAttempt,
  cancelActiveAuthenticationAttempt,
}: LoginFormProps) {
  const navigate = useNavigate();
  const { login } = useAuth();
  const { t } = useTranslation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [acceptedAgreement, setAcceptedAgreement] = useState(false);
  const [error, setError] = useState('');
  const authenticationAttemptRef = useAuthenticationAttemptOwner(cancelAuthenticationAttempt);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!acceptedAgreement) { setError(t('auth.agreement_required')); return; }
    setLoading(true);
    setError('');
    const attempt = startAuthenticationAttempt();
    authenticationAttemptRef.current = attempt;

    try {
      const resp = await authApi.login({ email, password }, attempt.controller.signal);
      if (attempt.controller.signal.aborted || !isSessionIdentityCurrent(attempt.identity)) return;
      login(resp.token, resp.user);
      const returnTo = consumeAuthReturnTo();
      if (returnTo) window.location.assign(returnTo);
      else navigate({ to: '/' });
    } catch (err) {
      if (attempt.controller.signal.aborted || !isSessionIdentityCurrent(attempt.identity)) return;
      if (err instanceof ApiError) {
        setError(localizeServerMessage(t, err.message));
      } else {
        setError(t('auth.login_failed'));
      }
    } finally {
      if (!attempt.controller.signal.aborted && isSessionIdentityCurrent(attempt.identity)) {
        setLoading(false);
      }
    }
  };

  return (
    <Form onSubmit={handleSubmit} className="space-y-4">
      <HeroTextField fullWidth isRequired>
        <Label>{t('auth.email')}</Label>
        <div className="relative">
          <Mail className="pointer-events-none absolute left-3 top-1/2 z-10 w-4 h-4 -translate-y-1/2 text-text-tertiary" />
          <Input
            className="pl-9"
            name="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t('auth.email_placeholder')}
            autoComplete="username"
            autoFocus
            required
          />
        </div>
      </HeroTextField>
      <HeroTextField fullWidth isRequired>
        <Label>{t('auth.password')}</Label>
        <div className="relative">
          <Lock className="pointer-events-none absolute left-3 top-1/2 z-10 w-4 h-4 -translate-y-1/2 text-text-tertiary" />
          <Input
            className="pl-9"
            name="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('auth.password_placeholder')}
            autoComplete="current-password"
            required
          />
        </div>
      </HeroTextField>
      {error && (
        <Alert status="danger">
          <Alert.Content>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      <AgreementCheckbox
        checked={acceptedAgreement}
        onChange={(selected) => {
          setAcceptedAgreement(selected);
          if (selected && error === t('auth.agreement_required')) setError('');
        }}
      />
      <Button type="submit" isDisabled={loading || !acceptedAgreement} className="w-full h-11" variant="primary" aria-busy={loading}>
        <ArrowRight className="w-4 h-4" />
        {t('common.login')}
      </Button>
      <OAuthButtons
        acceptedAgreement={acceptedAgreement}
        onAgreementMissing={() => setError(t('auth.agreement_required'))}
        onAuthenticationStart={cancelActiveAuthenticationAttempt}
      />
    </Form>
  );
}

/* ==================== 注册表单 ==================== */

function RegisterForm({
  startAuthenticationAttempt,
  cancelAuthenticationAttempt,
}: AuthenticationFormProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { login } = useAuth();
  const site = useSiteSettings();
  const settingsReady = site.settings_loaded;
  const needVerify = site.email_verify_enabled;

  const [step, setStep] = useState<1 | 2>(1);
  const [email, setEmail] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [verifiedEmail, setVerifiedEmail] = useState('');
  const [verifiedCode, setVerifiedCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [acceptedAgreement, setAcceptedAgreement] = useState(false);
  const [error, setError] = useState('');
  const authenticationAttemptRef = useAuthenticationAttemptOwner(cancelAuthenticationAttempt);

  const passwordMismatch = confirmPassword !== '' && password !== confirmPassword;

  const resetVerifiedEmail = () => {
    setVerifiedEmail('');
    setVerifiedCode('');
  };

  const returnToEmailStep = useCallback(() => {
    const attempt = authenticationAttemptRef.current;
    authenticationAttemptRef.current = null;
    if (attempt) cancelAuthenticationAttempt(attempt);
    setLoading(false);
    setStep(1);
  }, [authenticationAttemptRef, cancelAuthenticationAttempt]);

  // 倒计时
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = window.setInterval(() => {
      setCountdown((c) => (c <= 1 ? 0 : c - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [countdown]);

  useLayoutEffect(() => {
    if (settingsReady && needVerify && step === 2 && (!verifiedEmail || !verifiedCode)) {
      returnToEmailStep();
    }
  }, [needVerify, returnToEmailStep, settingsReady, step, verifiedCode, verifiedEmail]);

  // 发送验证码
  const handleSendCode = async () => {
    const normalizedEmail = email.trim();
    if (!normalizedEmail) { setError(t('auth.email_required')); return; }
    setSendingCode(true);
    setError('');
    resetVerifiedEmail();
    try {
      await authApi.sendVerifyCode(normalizedEmail);
      setEmail(normalizedEmail);
      setVerifyCode('');
      setCodeSent(true);
      setCountdown(60);
    } catch (err) {
      setError(err instanceof ApiError ? localizeServerMessage(t, err.message) : t('auth.send_code_failed'));
    } finally {
      setSendingCode(false);
    }
  };

  // 第一步：验证邮箱 → 进入第二步
  const handleStep1 = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settingsReady) return;

    const normalizedEmail = email.trim();
    const normalizedCode = verifyCode.trim();
    if (!normalizedEmail) { setError(t('auth.email_required')); return; }
    if (!acceptedAgreement) { setError(t('auth.agreement_required')); return; }

    if (!needVerify) {
      setEmail(normalizedEmail);
      setStep(2);
      return;
    }
    if (!normalizedCode) { setError(t('auth.code_required')); return; }
    setLoading(true);
    setError('');
    try {
      await authApi.verifyCode(normalizedEmail, normalizedCode);
      setEmail(normalizedEmail);
      setVerifyCode(normalizedCode);
      setVerifiedEmail(normalizedEmail);
      setVerifiedCode(normalizedCode);
      setStep(2);
    } catch (err) {
      resetVerifiedEmail();
      setError(err instanceof ApiError ? localizeServerMessage(t, err.message) : t('auth.register_failed'));
    } finally {
      setLoading(false);
    }
  };

  // 第二步：提交注册
  const handleStep2 = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) { setError(t('auth.password_mismatch')); return; }
    if (password.length < 8) { setError(t('auth.password_too_short')); return; }

    const registrationEmail = needVerify ? verifiedEmail : email.trim();
    if (needVerify && (!verifiedEmail || !verifiedCode || email.trim() !== verifiedEmail)) {
      returnToEmailStep();
      setError(t('auth.email_verification_required'));
      return;
    }

    setLoading(true);
    setError('');
    const attempt = startAuthenticationAttempt();
    authenticationAttemptRef.current = attempt;
    try {
      // 注册接口与登录同构返回 token+user，直接入会话免去二次登录
      const resp = await authApi.register({
        email: registrationEmail,
        password,
        username: username || undefined,
        verify_code: needVerify ? verifiedCode : undefined,
        source_site: getOriginSite() || undefined,
        invite_code: getInviteCode() || undefined,
      }, attempt.controller.signal);
      if (attempt.controller.signal.aborted || !isSessionIdentityCurrent(attempt.identity)) return;
      markNewRegistration(resp.user.id);
      login(resp.token, resp.user);
      const returnTo = consumeAuthReturnTo();
      if (returnTo) window.location.assign(returnTo);
      else navigate({ to: '/' });
    } catch (err) {
      if (attempt.controller.signal.aborted || !isSessionIdentityCurrent(attempt.identity)) return;
      if (err instanceof ApiError) {
        // 验证码错误则回到第一步(判断用后端原文,展示用本地化文案)
        if (err.message.includes('验证码')) {
          returnToEmailStep();
          setVerifyCode('');
          resetVerifiedEmail();
        }
        setError(localizeServerMessage(t, err.message));
      } else {
        setError(t('auth.register_failed'));
      }
    } finally {
      if (!attempt.controller.signal.aborted && isSessionIdentityCurrent(attempt.identity)) {
        setLoading(false);
      }
    }
  };

  // 第一步：输入邮箱（+ 验证码）
  if (step === 1) {
    return (
      <Form onSubmit={handleStep1} className="space-y-4">
        <HeroTextField fullWidth isRequired>
          <Label>{t('auth.email')}</Label>
          <div className="relative">
            <Mail className="pointer-events-none absolute left-3 top-1/2 z-10 w-4 h-4 -translate-y-1/2 text-text-tertiary" />
            <Input
              className="pl-9"
              name="email"
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setError('');
                setCodeSent(false);
                setCountdown(0);
                resetVerifiedEmail();
              }}
              placeholder={t('auth.email_placeholder')}
              autoComplete="email"
              autoFocus
              required
            />
          </div>
        </HeroTextField>
        {needVerify && (
          <div className="flex items-end gap-2">
            <HeroTextField fullWidth isRequired>
              <Label>{t('auth.verify_code')}</Label>
              <div className="relative">
                <ShieldCheck className="pointer-events-none absolute left-3 top-1/2 z-10 w-4 h-4 -translate-y-1/2 text-text-tertiary" />
                <Input
                  className="pl-9"
                  name="verify_code"
                  value={verifyCode}
                  onChange={(e) => {
                    setVerifyCode(e.target.value);
                    setError('');
                    resetVerifiedEmail();
                  }}
                  placeholder={t('auth.verify_code_placeholder')}
                  maxLength={6}
                  required
                />
              </div>
            </HeroTextField>
            <Button
              type="button"
              variant="secondary"
              onPress={handleSendCode}
              isDisabled={sendingCode || countdown > 0 || !email.trim() || !settingsReady}
              className="shrink-0 h-[42px]"
              aria-busy={sendingCode}
            >
              {countdown > 0 ? `${countdown}s` : codeSent ? t('auth.resend_code') : t('auth.send_code')}
            </Button>
          </div>
        )}
        <AgreementCheckbox
          checked={acceptedAgreement}
          onChange={(selected) => {
            setAcceptedAgreement(selected);
            if (selected && error === t('auth.agreement_required')) setError('');
          }}
        />
        {error && (
          <Alert status="danger">
            <Alert.Content>
              <Alert.Description>{error}</Alert.Description>
            </Alert.Content>
          </Alert>
        )}
        <Button type="submit" isDisabled={loading || !settingsReady || !acceptedAgreement} className="w-full h-11" variant="primary" aria-busy={loading}>
          <ArrowRight className="w-4 h-4" />
          {t('auth.next_step')}
        </Button>
      </Form>
    );
  }

  // 第二步：填写密码等信息
  return (
    <Form onSubmit={handleStep2} className="space-y-4">
      {/* 已验证的邮箱（只读展示） */}
      <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-[10px] border border-glass-border bg-surface text-sm text-text-secondary">
        <Mail className="w-4 h-4 text-text-tertiary shrink-0" />
        <span className="truncate">{needVerify ? verifiedEmail : email}</span>
        <Button
          className="ml-auto shrink-0"
          size="sm"
          variant="ghost"
          onPress={returnToEmailStep}
        >
          {t('auth.change_email')}
        </Button>
      </div>
      <HeroTextField fullWidth>
        <Label>{t('auth.username')}</Label>
        <div className="relative">
          <User className="pointer-events-none absolute left-3 top-1/2 z-10 w-4 h-4 -translate-y-1/2 text-text-tertiary" />
          <Input
            className="pl-9"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t('auth.username_placeholder')}
            autoFocus
          />
        </div>
      </HeroTextField>
      <HeroTextField fullWidth isRequired>
        <Label>{t('auth.password')}</Label>
        <div className="relative">
          <Lock className="pointer-events-none absolute left-3 top-1/2 z-10 w-4 h-4 -translate-y-1/2 text-text-tertiary" />
          <Input
            className="pl-9"
            name="new-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('auth.password_hint')}
            autoComplete="new-password"
            required
          />
        </div>
      </HeroTextField>
      <HeroTextField fullWidth isInvalid={passwordMismatch} isRequired>
        <Label>{t('auth.confirm_password')}</Label>
        <div className="relative">
          <Lock className="pointer-events-none absolute left-3 top-1/2 z-10 w-4 h-4 -translate-y-1/2 text-text-tertiary" />
          <Input
            className="pl-9"
            name="confirm-new-password"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder={t('auth.confirm_placeholder')}
            autoComplete="new-password"
            aria-invalid={passwordMismatch || undefined}
            required
          />
        </div>
        {passwordMismatch ? <FieldError>{t('auth.password_mismatch')}</FieldError> : null}
      </HeroTextField>
      {error && (
        <Alert status="danger">
          <Alert.Content>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      <Button type="submit" isDisabled={loading} className="w-full h-11" variant="primary" aria-busy={loading}>
        {t('common.register')}
      </Button>
    </Form>
  );
}

/* ==================== 登录页主组件 ==================== */

export default function LoginPage() {
  const { t } = useTranslation();
  const { theme, toggleTheme } = useTheme();
  const { login } = useAuth();
  const navigate = useNavigate();
  const site = useSiteSettings();
  const brand = useCurrentBrand();
  // HopBase 品牌:左半镜像官网首屏的 quickstart 终端面板;ToC 等其它品牌沿用各自的装饰面板
  const hopbaseHero = brand === 'hopbase';
  const heroBaseUrl = site.api_base_url || window.location.origin;
  const [activeTab, setActiveTab] = useState<TabKey>('login');
  const [oauthError, setOauthError] = useState('');
  const [oauthLoading, setOauthLoading] = useState(false);
  const authenticationAttemptRef = useRef<AuthenticationAttempt | null>(null);

  const startAuthenticationAttempt = useCallback((token: string | null): AuthenticationAttempt => {
    const previous = authenticationAttemptRef.current;
    let identity: SessionIdentity;
    if (token === null) {
      identity = beginAuthenticationAttempt();
    } else {
      setToken(token);
      identity = getSessionIdentity();
    }
    const attempt = { controller: new AbortController(), identity };
    authenticationAttemptRef.current = attempt;
    previous?.controller.abort();
    return attempt;
  }, []);

  const startFormAuthenticationAttempt = useCallback(() => {
    const attempt = startAuthenticationAttempt(null);
    setOauthLoading(false);
    setOauthError('');
    return attempt;
  }, [startAuthenticationAttempt]);

  const cancelAuthenticationAttempt = useCallback((attempt: AuthenticationAttempt) => {
    if (authenticationAttemptRef.current !== attempt) return;
    authenticationAttemptRef.current = null;
    if (isSessionIdentityCurrent(attempt.identity)) beginAuthenticationAttempt();
    attempt.controller.abort();
  }, []);

  const cancelActiveAuthenticationAttempt = useCallback(() => {
    const active = authenticationAttemptRef.current;
    if (active) cancelAuthenticationAttempt(active);
    setOauthLoading(false);
    setOauthError('');
  }, [cancelAuthenticationAttempt]);

  // 展示身份只认「本次登录页地址明确携带的 ?inv=」，不能用 localStorage 中的历史归因，
  // 否则访客日后直接打开普通 /login 也会误见上次推广人的认证条。
  const [inviteCode] = useState(getInviteCodeFromURL);
  // 挂载时保存回调数据。React StrictMode 会重放 effect，而首轮 effect 已从地址栏移除 hash。
  const [oauthCallback] = useState(() => {
    const tokenMatch = /(?:^|[#&])oauth_token=([^&]+)/.exec(window.location.hash);
    const token = (() => {
      if (!tokenMatch?.[1]) return '';
      try {
        return decodeURIComponent(tokenMatch[1]);
      } catch {
        return '';
      }
    })();
    return {
      token,
      isNewUser: /(?:^|[#&])oauth_new_user=1(?:&|$)/.test(window.location.hash),
    };
  });
  const [isOAuthReturn] = useState(() => !!oauthCallback.token
    || new URLSearchParams(window.location.search).has('oauth_error'));

  // 普通登录页代表一次无邀请的新入口：清掉未消费的旧归因，避免它不显示却仍被注册请求静默使用。
  // OAuth 回跳失败时保留，方便用户在同一次邀请注册流程里重试。
  useEffect(() => {
    if (!inviteCode && !isOAuthReturn) clearInviteCode();
  }, [inviteCode, isOAuthReturn]);

  const { data: resolvedInvite } = useQuery({
    queryKey: queryKeys.referralResolve(inviteCode),
    queryFn: () => referralApi.resolve(inviteCode),
    enabled: !!inviteCode,
    staleTime: 5 * 60 * 1000,
  });
  const officialInvite = resolvedInvite?.exists && resolvedInvite.tier === 'official' ? resolvedInvite : null;

  useLayoutEffect(() => () => {
    const active = authenticationAttemptRef.current;
    if (active) cancelAuthenticationAttempt(active);
  }, [cancelAuthenticationAttempt]);

  // 第三方登录回调：JWT 经 URL fragment 带回（不进服务端日志），换取用户信息后入会话；
  // 失败信息经 oauth_error 查询参数带回。两者读取后都立即从地址栏清除。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const callbackError = params.get('oauth_error');
    if (callbackError) {
      setOauthError(callbackError);
      params.delete('oauth_error');
      const query = params.toString();
      window.history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : ''));
    }

    const { token, isNewUser } = oauthCallback;
    if (!token) return;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);

    const attempt = startAuthenticationAttempt(token);
    setOauthLoading(true);
    void usersApi.me(attempt.controller.signal)
      .then((userData) => {
        if (attempt.controller.signal.aborted || !isSessionIdentityCurrent(attempt.identity)) return;
        if (authenticationAttemptRef.current === attempt) authenticationAttemptRef.current = null;
        if (isNewUser) markNewRegistration(userData.id);
        login(token, userData);
        const returnTo = consumeAuthReturnTo();
        if (returnTo) window.location.assign(returnTo);
        else void navigate({ to: '/' });
      })
      .catch(() => {
        if (attempt.controller.signal.aborted || !clearTokenIfSessionCurrent(attempt.identity)) return;
        if (authenticationAttemptRef.current === attempt) authenticationAttemptRef.current = null;
        setOauthError(t('auth.oauth_failed', { defaultValue: 'Third-party sign-in failed, please retry' }));
        setOauthLoading(false);
      });
    // 仅在挂载时消费一次回调参数
  }, []);

  return (
    <div className="min-h-screen flex relative overflow-hidden bg-bg-deep text-text">
      {/* ===== 左侧面板（桌面端）:HopBase 品牌为终端面板,其它品牌为装饰面板 ===== */}
      {hopbaseHero ? (
        <LoginHero baseUrl={heroBaseUrl} className="hidden lg:flex lg:w-[45%] xl:w-[50%]" />
      ) : (
      <div
        className="hidden lg:flex lg:w-[45%] xl:w-[50%] relative items-center justify-center overflow-hidden"
        style={{
          background: theme === 'dark'
            ? 'radial-gradient(circle at 25% 35%, oklch(29% 0.018 250), transparent 32%), linear-gradient(135deg, oklch(18% 0.012 250), oklch(12% 0.006 250))'
            : 'radial-gradient(circle at 25% 35%, oklch(34% 0.025 250), transparent 34%), linear-gradient(135deg, oklch(25% 0.018 250), oklch(16% 0.01 250))',
          color: 'oklch(96% 0.004 250)',
        }}
      >
        {/* 动态背景：极光柔光漂移 + 粒子节点连线 */}
        <LoginAmbientCanvas />
        {/* 细网格纹理：填补大面积纯色的空洞感 */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              'linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)',
            backgroundSize: '44px 44px',
            maskImage: 'radial-gradient(ellipse 90% 80% at 35% 40%, black 30%, transparent 75%)',
            WebkitMaskImage: 'radial-gradient(ellipse 90% 80% at 35% 40%, black 30%, transparent 75%)',
          }}
        />
        {/* 柔光（面板恒为深色，用固定色，不随主题的黑白 primary 反转） */}
        <div
          className="pointer-events-none absolute -left-24 -top-24 h-96 w-96 rounded-full blur-3xl"
          style={{ background: 'rgba(255,255,255,0.07)' }}
        />
        <div
          className="pointer-events-none absolute -bottom-32 right-6 h-80 w-80 rounded-full blur-3xl"
          style={{ background: theme === 'dark' ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.06)' }}
        />
        {/* 内容 */}
        <div className="relative z-10 px-12 max-w-md">
          <div className="mb-10 flex items-center text-white">
            <SiteBrand iconSize={30} />
          </div>
          <h2 className="text-[34px] font-bold leading-snug tracking-tight mb-4">
            {t('auth.welcome_title')}
          </h2>
          <p className="text-sm leading-relaxed opacity-65 max-w-sm">
            {t('auth.welcome_desc')}
          </p>
          {/* 特性列表：图标 + 标题 + 一行说明 */}
          <div className="mt-11 space-y-5">
            {[
              { icon: Layers, title: t('auth.feature_1'), desc: t('auth.feature_1_desc', { defaultValue: 'Unified access to OpenAI, Claude, Gemini and more' }) },
              { icon: Gauge, title: t('auth.feature_2'), desc: t('auth.feature_2_desc', { defaultValue: 'Smart multi-account scheduling with auto failover' }) },
              { icon: BarChart3, title: t('auth.feature_3'), desc: t('auth.feature_3_desc', { defaultValue: 'Real-time token-level usage and cost' }) },
            ].map(({ icon: Icon, title, desc }) => (
              <div key={title} className="flex items-start gap-3.5">
                <span
                  className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border"
                  style={{
                    background: 'rgba(255,255,255,0.09)',
                    borderColor: 'rgba(255,255,255,0.14)',
                  }}
                >
                  <Icon className="h-4 w-4" style={{ color: 'rgba(255,255,255,0.92)' }} />
                </span>
                <span>
                  <span className="block text-[13.5px] font-semibold leading-tight">{title}</span>
                  <span className="mt-1 block text-xs leading-relaxed opacity-55">{desc}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
      )}

      {/* ===== 右侧表单区 ===== */}
      <div className="ag-login-form-side flex-1 flex items-center justify-center p-6 sm:p-8 bg-bg-deep relative overflow-hidden">
        {/* 表单区背景：卡片上方一团极淡的柔光，避免整面死黑/死白 */}
        <div
          className="pointer-events-none absolute left-1/2 top-[12%] h-[420px] w-[560px] -translate-x-1/2 rounded-full blur-3xl"
          style={{ background: theme === 'dark' ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.028)' }}
        />
        {/* 语言切换(地球图标,游客可选,注册后延续)+ 主题切换 */}
        <div className="absolute top-4 right-4 z-10 flex items-center gap-1">
          <LanguageSwitcher />
          <Button
            aria-label={theme === 'dark' ? 'Light mode' : 'Dark mode'}
            isIconOnly
            size="sm"
            variant="ghost"
            onPress={toggleTheme}
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </Button>
        </div>
        <div className="relative w-full max-w-[420px]">
          {/* 移动端 Logo */}
          <div className="mb-8 flex justify-center text-text lg:hidden">
            <SiteBrand iconSize={30} />
          </div>

          {/* 官方推广认证条:仅当邀请码解析为官方推广官时显示,给访客一个信任背书 */}
          {officialInvite ? (
            <div
              className="mb-5 flex items-center gap-3 rounded-[var(--radius)] border px-4 py-3"
              style={{
                borderColor: 'rgba(202,138,4,0.4)',
                background: 'linear-gradient(100deg, rgba(202,138,4,0.16), rgba(202,138,4,0.05) 60%, transparent)',
              }}
            >
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
                style={{ background: 'rgba(202,138,4,0.18)', color: '#b8860b' }}
              >
                <BadgeCheck className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="text-[13px] font-semibold text-text">
                  {officialInvite.badge_text || t('referral.official_badge')}
                </div>
                <div className="truncate text-xs text-text-tertiary">
                  {officialInvite.display_name
                    ? t('referral.official_invite_by', { name: officialInvite.display_name })
                    : t('referral.official_invite_hint')}
                </div>
              </div>
            </div>
          ) : null}

          {/* Tab 切换 */}
          <Tabs
            className="ag-page-tabs ag-login-tabs mb-6 w-full"
            selectedKey={activeTab}
            onSelectionChange={(key) => {
              const nextTab = key as TabKey;
              if (nextTab !== activeTab) cancelActiveAuthenticationAttempt();
              setActiveTab(nextTab);
            }}
          >
            <Tabs.List className="w-full">
              <Tabs.Tab id="login"><Tabs.Indicator />{t('common.login')}</Tabs.Tab>
              {site.registration_enabled ? (
                <Tabs.Tab id="register"><Tabs.Indicator />{t('common.register')}</Tabs.Tab>
              ) : null}
            </Tabs.List>
          </Tabs>

          {/* 表单 */}
          <Card
            className="border border-glass-border shadow-xl backdrop-blur-sm"
            style={{ boxShadow: '0 20px 50px -18px rgba(0,0,0,0.35), 0 0 0 1px color-mix(in oklab, var(--ag-primary) 5%, transparent)' }}
          >
            <Card.Content className="p-6 sm:p-7">
            {oauthError && (
              <Alert status="danger" className="mb-5">
                <Alert.Content>
                  <Alert.Description>{oauthError}</Alert.Description>
                </Alert.Content>
              </Alert>
            )}
            {oauthLoading && (
              <Alert status="accent" className="mb-5">
                <Alert.Content>
                  <Alert.Description>{t('auth.oauth_signing_in', { defaultValue: 'Completing sign-in…' })}</Alert.Description>
                </Alert.Content>
              </Alert>
            )}

            {activeTab === 'register' && site.registration_enabled ? (
              <RegisterForm
                startAuthenticationAttempt={startFormAuthenticationAttempt}
                cancelAuthenticationAttempt={cancelAuthenticationAttempt}
              />
            ) : (
              <LoginForm
                startAuthenticationAttempt={startFormAuthenticationAttempt}
                cancelAuthenticationAttempt={cancelAuthenticationAttempt}
                cancelActiveAuthenticationAttempt={cancelActiveAuthenticationAttempt}
              />
            )}
            </Card.Content>
          </Card>

          {/* 底部 */}
          <div className="mt-6 flex flex-col items-center gap-2">
            <p className="text-center text-[10px] text-text-tertiary font-mono uppercase">
              Powered by {site.site_name || 'HopBase'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
