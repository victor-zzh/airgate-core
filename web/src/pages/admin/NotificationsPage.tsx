import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Chip, Input, Label, Spinner, TextArea } from '@heroui/react';
import { AlertCircle, AlertTriangle, BellRing, Clock3, Loader2, Megaphone, Save, Send } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { settingsApi } from '../../shared/api/settings';
import { queryKeys } from '../../shared/queryKeys';
import type { SettingItem } from '../../shared/types';
import { NativeSwitch } from '../../shared/components/NativeSwitch';
import { useToast } from '../../shared/ui';
import {
  mergeLegacyNotification,
  NOTIFICATION_HISTORY_LIMIT,
  parseNotificationHistory,
  serializeNotificationHistory,
  type NotificationLevel,
  type SiteNotification,
} from '../../shared/notifications';

const LANDING_ANNOUNCEMENT_LANGS = [
  { code: 'zh', label: '中文' },
  { code: 'zh-HK', label: '繁體中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'es', label: 'Español' },
] as const;

const LEVEL_ICONS = {
  info: Megaphone,
  warning: AlertTriangle,
  danger: AlertCircle,
} as const;

const LEVEL_TONES = {
  info: 'accent',
  warning: 'warning',
  danger: 'danger',
} as const;

interface LandingAnnouncement {
  enabled?: boolean;
  href?: string;
  text?: Record<string, string>;
  link?: Record<string, string>;
}

interface PublishPayload {
  notice: SiteNotification;
  history: SiteNotification[];
  showPopup: boolean;
}

function createNotificationId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `notice-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseLandingAnnouncement(raw: string | undefined): LandingAnnouncement {
  if (!raw?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function SettingsSection({ title, description, children }: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="ag-settings-section">
      <div className="ag-settings-section-heading">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-text">{title}</h2>
          {description && <p className="mt-1 text-xs leading-5 text-text-tertiary">{description}</p>}
        </div>
      </div>
      <div className="ag-settings-section-body">{children}</div>
    </section>
  );
}

function Field({ label, hint, children }: {
  label: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm font-medium text-text">{label}</Label>
      {children}
      {hint && <p className="text-xs leading-5 text-text-tertiary">{hint}</p>}
    </div>
  );
}

export default function NotificationsPage() {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const [draftTitle, setDraftTitle] = useState('');
  const [draftContent, setDraftContent] = useState('');
  const [draftLevel, setDraftLevel] = useState<NotificationLevel>('info');
  const [showPopup, setShowPopup] = useState(true);
  const [formError, setFormError] = useState('');
  const [landingDirty, setLandingDirty] = useState(false);

  const { data: settings = [], isLoading } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: () => settingsApi.list(),
  });

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const setting of settings) next[setting.key] = setting.value;
    setValues(next);
    setLandingDirty(false);
  }, [settings]);

  const storedHistory = useMemo(
    () => parseNotificationHistory(values.announcement_history_json),
    [values.announcement_history_json],
  );
  const history = useMemo(() => mergeLegacyNotification(storedHistory, {
    title: values.announcement_title,
    content: values.announcement_content,
    level: values.announcement_level,
  }), [storedHistory, values.announcement_content, values.announcement_level, values.announcement_title]);
  const landingAnnouncement = useMemo(
    () => parseLandingAnnouncement(values.landing_announcement_json),
    [values.landing_announcement_json],
  );

  const refreshSettings = () => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.settings() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.siteSettings() });
  };

  const publishMutation = useMutation({
    mutationFn: (payload: PublishPayload) => settingsApi.update({
      settings: [
        { key: 'announcement_enabled', value: String(payload.showPopup), group: 'site' },
        { key: 'announcement_id', value: payload.notice.id, group: 'site' },
        { key: 'announcement_title', value: payload.notice.title, group: 'site' },
        { key: 'announcement_level', value: payload.notice.level, group: 'site' },
        { key: 'announcement_content', value: payload.notice.content, group: 'site' },
        { key: 'announcement_history_json', value: serializeNotificationHistory(payload.history), group: 'site' },
      ],
    }),
    onSuccess: (_, payload) => {
      setValues((current) => ({
        ...current,
        announcement_enabled: String(payload.showPopup),
        announcement_id: payload.notice.id,
        announcement_title: payload.notice.title,
        announcement_level: payload.notice.level,
        announcement_content: payload.notice.content,
        announcement_history_json: serializeNotificationHistory(payload.history),
      }));
      setDraftTitle('');
      setDraftContent('');
      setFormError('');
      toast('success', t('notifications.publish_success'));
      refreshSettings();
    },
    onError: (error: Error) => toast('error', error.message),
  });

  const disablePopupMutation = useMutation({
    mutationFn: () => settingsApi.update({
      settings: [{ key: 'announcement_enabled', value: 'false', group: 'site' }],
    }),
    onSuccess: () => {
      setValues((current) => ({ ...current, announcement_enabled: 'false' }));
      toast('success', t('notifications.disable_success'));
      refreshSettings();
    },
    onError: (error: Error) => toast('error', error.message),
  });

  const landingMutation = useMutation({
    mutationFn: (item: SettingItem) => settingsApi.update({ settings: [item] }),
    onSuccess: () => {
      setLandingDirty(false);
      toast('success', t('settings.save_success'));
      refreshSettings();
    },
    onError: (error: Error) => toast('error', error.message),
  });

  const publish = (event: FormEvent) => {
    event.preventDefault();
    const content = draftContent.trim();
    if (!content) {
      setFormError(t('notifications.content_required'));
      return;
    }

    const notice: SiteNotification = {
      id: createNotificationId(),
      title: draftTitle.trim(),
      content,
      level: draftLevel,
      published_at: new Date().toISOString(),
    };
    publishMutation.mutate({
      notice,
      history: [notice, ...history].slice(0, NOTIFICATION_HISTORY_LIMIT),
      showPopup,
    });
  };

  const patchLandingAnnouncement = (patch: Partial<LandingAnnouncement>) => {
    setValues((current) => ({
      ...current,
      landing_announcement_json: JSON.stringify({ ...landingAnnouncement, ...patch }),
    }));
    setLandingDirty(true);
  };

  const setLandingLanguage = (field: 'text' | 'link', language: string, value: string) => {
    const next = { ...(landingAnnouncement[field] ?? {}) };
    if (value) next[language] = value;
    else delete next[language];
    patchLandingAnnouncement({ [field]: next });
  };

  const saveLandingAnnouncement = () => {
    landingMutation.mutate({
      key: 'landing_announcement_json',
      value: values.landing_announcement_json ?? '',
      group: 'site',
    });
  };

  const locale = i18n.resolvedLanguage || i18n.language || 'zh';
  const currentPopupActive = values.announcement_enabled === 'true' && Boolean(values.announcement_content?.trim());

  if (isLoading) {
    return <div className="flex h-64 items-center justify-center"><Spinner /></div>;
  }

  return (
    <div className="ag-page">
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]">
        <Card>
          <Card.Header>
            <Card.Title>{t('notifications.publish_title')}</Card.Title>
            <Card.Description>{t('notifications.publish_description')}</Card.Description>
          </Card.Header>
          <Card.Content>
            <form className="space-y-5" onSubmit={publish}>
              <Field label={t('notifications.field_title')} hint={t('notifications.field_title_hint')}>
                <Input
                  className="w-full"
                  maxLength={120}
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  placeholder={t('notifications.field_title_placeholder')}
                />
              </Field>

              <Field label={t('notifications.field_content')}>
                <TextArea
                  aria-label={t('notifications.field_content')}
                  className="min-h-32 w-full text-sm leading-6"
                  maxLength={4000}
                  value={draftContent}
                  onChange={(event) => {
                    setDraftContent(event.target.value);
                    if (formError) setFormError('');
                  }}
                  placeholder={t('notifications.field_content_placeholder')}
                />
                {formError && <p className="text-xs text-danger">{formError}</p>}
              </Field>

              <Field label={t('notifications.level')}>
                <div className="grid max-w-lg grid-cols-3 gap-2">
                  {(['info', 'warning', 'danger'] as const).map((level) => {
                    const Icon = LEVEL_ICONS[level];
                    return (
                      <Button
                        key={level}
                        aria-pressed={draftLevel === level}
                        className="ag-level-option"
                        data-selected={draftLevel === level}
                        fullWidth
                        size="sm"
                        type="button"
                        variant="ghost"
                        onPress={() => setDraftLevel(level)}
                      >
                        <Icon className="h-4 w-4" />
                        {t(`settings.announcement_level_${level}`)}
                      </Button>
                    );
                  })}
                </div>
              </Field>

              <NativeSwitch
                isSelected={showPopup}
                label={(
                  <span>
                    <span className="block text-sm font-medium text-text">{t('notifications.show_popup')}</span>
                    <span className="block text-xs leading-5 text-text-tertiary">{t('notifications.show_popup_hint')}</span>
                  </span>
                )}
                onChange={setShowPopup}
              />

              <div className="flex justify-end border-t border-border pt-4">
                <Button isDisabled={publishMutation.isPending} type="submit" variant="primary">
                  {publishMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  {t('notifications.publish')}
                </Button>
              </div>
            </form>
          </Card.Content>
        </Card>

        <Card>
          <Card.Header>
            <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
              <div className="min-w-0">
                <Card.Title>{t('notifications.history_title')}</Card.Title>
                <Card.Description>{t('notifications.history_description', { count: history.length })}</Card.Description>
              </div>
              <Chip color={currentPopupActive ? 'success' : 'default'} size="sm" variant="soft">
                {t(currentPopupActive ? 'notifications.popup_active' : 'notifications.popup_inactive')}
              </Chip>
            </div>
          </Card.Header>
          <Card.Content className="p-0">
            {currentPopupActive && (
              <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-text">{t('notifications.current_popup')}</p>
                  <p className="mt-0.5 truncate text-xs text-text-tertiary">{values.announcement_content}</p>
                </div>
                <Button
                  className="shrink-0"
                  isDisabled={disablePopupMutation.isPending}
                  size="sm"
                  variant="ghost"
                  onPress={() => disablePopupMutation.mutate()}
                >
                  {disablePopupMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t('notifications.disable_popup')}
                </Button>
              </div>
            )}

            <div className="ag-notice-history max-h-[560px] overflow-y-auto">
              {history.length === 0 ? (
                <div className="flex min-h-56 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
                  <BellRing className="h-8 w-8 text-text-tertiary" />
                  <div>
                    <p className="text-sm font-medium text-text">{t('notifications.history_empty')}</p>
                    <p className="mt-1 text-xs leading-5 text-text-tertiary">{t('notifications.history_empty_hint')}</p>
                  </div>
                </div>
              ) : history.map((notice) => {
                const Icon = LEVEL_ICONS[notice.level];
                const date = new Date(notice.published_at);
                const time = Number.isNaN(date.getTime())
                  ? t('notifications.time_unknown')
                  : new Intl.DateTimeFormat(locale, {
                    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                  }).format(date);
                return (
                  <article key={notice.id} className="flex items-start gap-3 border-b border-border px-4 py-4 last:border-b-0">
                    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius)] bg-bg">
                      <Icon className="h-4 w-4 text-text-secondary" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="break-words text-sm font-semibold text-text">
                          {notice.title || t('notifications.default_title')}
                        </h3>
                        <Chip color={LEVEL_TONES[notice.level]} size="sm" variant="soft">
                          {t(`settings.announcement_level_${notice.level}`)}
                        </Chip>
                      </div>
                      <p className="mt-1.5 whitespace-pre-wrap break-words text-xs leading-5 text-text-secondary">{notice.content}</p>
                      <p className="mt-2 flex items-center gap-1.5 text-[10px] text-text-tertiary">
                        <Clock3 className="h-3 w-3" />
                        {time}
                      </p>
                    </div>
                  </article>
                );
              })}
            </div>
          </Card.Content>
        </Card>

        <Card className="xl:col-span-2">
          <Card.Header>
            <Card.Title>{t('settings.landing_announcement_title')}</Card.Title>
            <Card.Description>{t('settings.landing_announcement_desc')}</Card.Description>
          </Card.Header>
          <Card.Content>
            <div className="ag-settings-section-stack">
              <SettingsSection title={t('settings.landing_announcement_title')}>
                <div className="space-y-5">
                  <NativeSwitch
                    isSelected={landingAnnouncement.enabled !== false}
                    label={<span className="text-sm font-medium text-text">{t('settings.landing_announcement_enabled')}</span>}
                    onChange={(enabled) => patchLandingAnnouncement({ enabled })}
                  />
                  <Field
                    label={t('settings.landing_announcement_href')}
                    hint={t('settings.landing_announcement_href_hint')}
                  >
                    <Input
                      className="max-w-xl"
                      value={landingAnnouncement.href ?? ''}
                      onChange={(event) => patchLandingAnnouncement({ href: event.target.value })}
                      placeholder="#pricing"
                    />
                  </Field>
                  {LANDING_ANNOUNCEMENT_LANGS.map(({ code, label }) => (
                    <div key={code} className="grid grid-cols-1 gap-4 md:grid-cols-2">
                      <Field label={`${t('settings.landing_announcement_text')} · ${label}`}>
                        <Input
                          value={landingAnnouncement.text?.[code] ?? ''}
                          onChange={(event) => setLandingLanguage('text', code, event.target.value)}
                        />
                      </Field>
                      <Field label={`${t('settings.landing_announcement_link')} · ${label}`}>
                        <Input
                          value={landingAnnouncement.link?.[code] ?? ''}
                          onChange={(event) => setLandingLanguage('link', code, event.target.value)}
                        />
                      </Field>
                    </div>
                  ))}
                  <p className="text-xs leading-5 text-text-tertiary">{t('settings.landing_announcement_hint')}</p>
                  <div className="flex justify-end border-t border-border pt-4">
                    <Button
                      isDisabled={!landingDirty || landingMutation.isPending}
                      variant="primary"
                      onPress={saveLandingAnnouncement}
                    >
                      {landingMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                      {t('common.save')}
                    </Button>
                  </div>
                </div>
              </SettingsSection>
            </div>
          </Card.Content>
        </Card>
      </div>
    </div>
  );
}
