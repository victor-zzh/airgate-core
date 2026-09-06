import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Chip, ComboBox, EmptyState, Input, Label, ListBox, Select, useOverlayState } from '@heroui/react';
import { Search } from 'lucide-react';
import { referralApi, type ReferralPromoterResp } from '../../shared/api/referral';
import { settingsApi } from '../../shared/api/settings';
import { usersApi } from '../../shared/api/users';
import { queryKeys } from '../../shared/queryKeys';
import { usePagination } from '../../shared/hooks/usePagination';
import { useDebouncedValue } from '../../shared/hooks/useDebouncedValue';
import { DEFAULT_PAGE_SIZE } from '../../shared/constants';
import { getTotalPages } from '../../shared/utils/pagination';
import { CommonModal } from '../../shared/components/CommonModal';
import { CommonTable } from '../../shared/components/CommonTable';
import { TableLoadingRow } from '../../shared/components/TableLoadingRow';
import { TablePaginationFooter } from '../../shared/components/TablePaginationFooter';
import { NativeSwitch } from '../../shared/components/NativeSwitch';
import { useToast } from '../../shared/ui';
import type { UserResp } from '../../shared/types';

// settings referral 分组的四个 key（value 全为字符串；比例存 0~1 小数，UI 用百分比展示）
const KEY_ENABLED = 'referral_enabled';
const KEY_DEFAULT_RATE = 'referral_default_rate';
const KEY_FIRST_BONUS_RATE = 'referral_first_bonus_rate';
const KEY_LINK_BASE_URL = 'referral_link_base_url';

function formatTime(date: string): string {
  return new Date(date).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** 比例小数 → 百分比输入串（0.1 → "10"）；空/非法 → ''。 */
function rateToPercent(raw: string | undefined): string {
  const v = Number(raw);
  if (!raw || Number.isNaN(v)) return '';
  return String(Math.round(v * 10000) / 100);
}

/** 百分比输入串 → 比例小数串（"10" → "0.1"）；非法返回 null。 */
function percentToRate(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === '') return '0';
  const v = Number(trimmed);
  if (Number.isNaN(v) || v < 0 || v > 100) return null;
  return String(Math.round(v * 100) / 10000);
}

export default function ReferralPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // ===== 配置卡片 =====
  const { data: settings } = useQuery({
    queryKey: queryKeys.settings(),
    queryFn: () => settingsApi.list(),
  });
  const [enabled, setEnabled] = useState(false);
  const [defaultRate, setDefaultRate] = useState('');
  const [firstBonusRate, setFirstBonusRate] = useState('');
  const [linkBaseUrl, setLinkBaseUrl] = useState('');
  const [configSeeded, setConfigSeeded] = useState(false);

  useEffect(() => {
    if (!settings || configSeeded) return;
    const referral = new Map(settings.filter((s) => s.group === 'referral').map((s) => [s.key, s.value]));
    setEnabled(referral.get(KEY_ENABLED) === 'true');
    setDefaultRate(rateToPercent(referral.get(KEY_DEFAULT_RATE)));
    setFirstBonusRate(rateToPercent(referral.get(KEY_FIRST_BONUS_RATE)));
    setLinkBaseUrl(referral.get(KEY_LINK_BASE_URL) ?? '');
    setConfigSeeded(true);
  }, [settings, configSeeded]);

  const saveConfig = useMutation({
    mutationFn: () => {
      const rate = percentToRate(defaultRate);
      const bonus = percentToRate(firstBonusRate);
      if (rate == null || bonus == null) {
        return Promise.reject(new Error(t('referral_admin.rate_invalid')));
      }
      return settingsApi.update({
        settings: [
          { key: KEY_ENABLED, value: String(enabled), group: 'referral' },
          { key: KEY_DEFAULT_RATE, value: rate, group: 'referral' },
          { key: KEY_FIRST_BONUS_RATE, value: bonus, group: 'referral' },
          { key: KEY_LINK_BASE_URL, value: linkBaseUrl.trim(), group: 'referral' },
        ],
      });
    },
    onSuccess: () => {
      toast('success', t('referral_admin.config_saved'));
      queryClient.invalidateQueries({ queryKey: queryKeys.settings() });
      queryClient.invalidateQueries({ queryKey: queryKeys.siteSettings() });
    },
    onError: (err: Error) => toast('error', err.message || t('referral_admin.config_save_failed')),
  });

  // ===== 推广官汇总 =====
  const { data: promoters, isLoading: summaryLoading } = useQuery({
    queryKey: queryKeys.referralSummary(),
    queryFn: () => referralApi.summary(),
  });

  // 设置比例弹窗（rateTarget 为 null 时按邮箱搜索选择用户）
  const rateModal = useOverlayState();
  const [rateTarget, setRateTarget] = useState<ReferralPromoterResp | null>(null);
  const [rateEmailQuery, setRateEmailQuery] = useState('');
  const [ratePickedUser, setRatePickedUser] = useState<UserResp | null>(null);
  const [rateInput, setRateInput] = useState('');
  const debouncedRateEmailQuery = useDebouncedValue(rateEmailQuery.trim(), 250);

  const openRateModal = (target: ReferralPromoterResp | null) => {
    setRateTarget(target);
    setRateEmailQuery('');
    setRatePickedUser(null);
    setRateInput(target?.referral_rate != null ? rateToPercent(String(target.referral_rate)) : '');
    rateModal.open();
  };

  const { data: rateUserSearch } = useQuery({
    queryKey: queryKeys.users('referral-rate-search', debouncedRateEmailQuery),
    queryFn: () => usersApi.list({
      page: 1,
      page_size: 20,
      keyword: debouncedRateEmailQuery || undefined,
    }),
    enabled: rateModal.isOpen && !rateTarget && !ratePickedUser,
  });

  const rateSearchResults = useMemo(() => rateUserSearch?.list ?? [], [rateUserSearch?.list]);
  const rateSearchOptions = useMemo(() => {
    const options = rateSearchResults.map((user) => ({
      id: String(user.id),
      label: user.email,
      description: user.username,
      textValue: `${user.email} ${user.username ?? ''}`,
    }));
    if (ratePickedUser && !options.some((option) => option.id === String(ratePickedUser.id))) {
      return [
        {
          id: String(ratePickedUser.id),
          label: ratePickedUser.email,
          description: ratePickedUser.username,
          textValue: `${ratePickedUser.email} ${ratePickedUser.username ?? ''}`,
        },
        ...options,
      ];
    }
    return options;
  }, [ratePickedUser, rateSearchResults]);

  const setRateMutation = useMutation({
    mutationFn: ({ userId, rate }: { userId: number; rate: number | null }) =>
      referralApi.setUserRate(userId, rate),
    onSuccess: () => {
      toast('success', t('referral_admin.rate_saved'));
      queryClient.invalidateQueries({ queryKey: queryKeys.referralSummary() });
      rateModal.close();
    },
    onError: (err: Error) => toast('error', err.message || t('referral_admin.rate_save_failed')),
  });

  const rateUserId = rateTarget ? rateTarget.user_id : ratePickedUser?.id ?? null;

  const submitRate = (clear: boolean) => {
    if (rateUserId == null) {
      toast('error', t('referral_admin.user_id_invalid'));
      return;
    }
    if (clear) {
      setRateMutation.mutate({ userId: rateUserId, rate: null });
      return;
    }
    const rate = percentToRate(rateInput);
    if (rate == null) {
      toast('error', t('referral_admin.rate_invalid'));
      return;
    }
    setRateMutation.mutate({ userId: rateUserId, rate: Number(rate) });
  };

  // ===== 官方推广官身份弹窗（仅样式差异：层级 + 品牌 vanity 码 + 署名，不动返佣）=====
  const promoterModal = useOverlayState();
  const [promoterTarget, setPromoterTarget] = useState<ReferralPromoterResp | null>(null);
  const [promoterEmailQuery, setPromoterEmailQuery] = useState('');
  const [promoterPickedUser, setPromoterPickedUser] = useState<UserResp | null>(null);
  const [promoterOfficial, setPromoterOfficial] = useState(false);
  const [promoterCode, setPromoterCode] = useState('');
  const [promoterName, setPromoterName] = useState('');
  const debouncedPromoterEmailQuery = useDebouncedValue(promoterEmailQuery.trim(), 250);

  const openPromoterModal = (target: ReferralPromoterResp | null) => {
    setPromoterTarget(target);
    setPromoterEmailQuery('');
    setPromoterPickedUser(null);
    setPromoterOfficial(target?.tier === 'official');
    setPromoterCode(target?.invite_code ?? '');
    setPromoterName(target?.display_name ?? '');
    promoterModal.open();
  };

  const { data: promoterUserSearch } = useQuery({
    queryKey: queryKeys.users('referral-promoter-search', debouncedPromoterEmailQuery),
    queryFn: () => usersApi.list({
      page: 1,
      page_size: 20,
      keyword: debouncedPromoterEmailQuery || undefined,
    }),
    enabled: promoterModal.isOpen && !promoterTarget && !promoterPickedUser,
  });

  const promoterSearchResults = useMemo(() => promoterUserSearch?.list ?? [], [promoterUserSearch?.list]);
  const promoterSearchOptions = useMemo(() => {
    const options = promoterSearchResults.map((user) => ({
      id: String(user.id),
      label: user.email,
      description: user.username,
      textValue: `${user.email} ${user.username ?? ''}`,
    }));
    if (promoterPickedUser && !options.some((option) => option.id === String(promoterPickedUser.id))) {
      return [
        {
          id: String(promoterPickedUser.id),
          label: promoterPickedUser.email,
          description: promoterPickedUser.username,
          textValue: `${promoterPickedUser.email} ${promoterPickedUser.username ?? ''}`,
        },
        ...options,
      ];
    }
    return options;
  }, [promoterPickedUser, promoterSearchResults]);

  const setPromoterMutation = useMutation({
    mutationFn: ({ userId, official, code, name }: { userId: number; official: boolean; code: string; name: string }) =>
      referralApi.setPromoter(userId, {
        official,
        invite_code: code || undefined,
        display_name: name,
      }),
    onSuccess: () => {
      toast('success', t('referral_admin.promoter_saved'));
      queryClient.invalidateQueries({ queryKey: queryKeys.referralSummary() });
      promoterModal.close();
    },
    onError: (err: Error) => toast('error', err.message || t('referral_admin.promoter_save_failed')),
  });

  const promoterUserId = promoterTarget ? promoterTarget.user_id : promoterPickedUser?.id ?? null;

  const submitPromoter = () => {
    if (promoterUserId == null) {
      toast('error', t('referral_admin.user_id_invalid'));
      return;
    }
    const code = promoterCode.trim();
    if (code && !/^[a-z0-9]{4,16}$/i.test(code)) {
      toast('error', t('referral_admin.promoter_code_invalid'));
      return;
    }
    setPromoterMutation.mutate({
      userId: promoterUserId,
      official: promoterOfficial,
      code,
      name: promoterName.trim(),
    });
  };

  // ===== 返利流水 =====
  const { page, setPage, pageSize, setPageSize } = usePagination(DEFAULT_PAGE_SIZE, 'admin.referral');
  const [kindFilter, setKindFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const { data: commissions, isLoading: listLoading } = useQuery({
    queryKey: queryKeys.referralCommissions(page, pageSize, kindFilter, statusFilter),
    queryFn: () => referralApi.commissions({
      page,
      page_size: pageSize,
      kind: kindFilter || undefined,
      status: statusFilter || undefined,
    }),
    meta: { globalLoading: false },
    placeholderData: keepPreviousData,
  });

  // 回冲确认弹窗
  const reverseModal = useOverlayState();
  const [reverseTarget, setReverseTarget] = useState<{ id: number; amount: number; email: string } | null>(null);
  const reverseMutation = useMutation({
    mutationFn: (id: number) => referralApi.reverse(id),
    onSuccess: () => {
      toast('success', t('referral_admin.reverse_done'));
      queryClient.invalidateQueries({ queryKey: queryKeys.referralCommissions() });
      queryClient.invalidateQueries({ queryKey: queryKeys.referralSummary() });
      reverseModal.close();
    },
    onError: (err: Error) => toast('error', err.message || t('referral_admin.reverse_failed')),
  });

  const rows = commissions?.list ?? [];
  const total = commissions?.total ?? 0;
  const totalPages = getTotalPages(total, pageSize);

  const kindOptions = useMemo(() => [
    { id: '', label: t('referral_admin.all_kinds') },
    { id: 'rebate', label: t('referral_admin.kind_rebate') },
    { id: 'first_bonus', label: t('referral_admin.kind_first_bonus') },
  ], [t]);
  const statusOptions = useMemo(() => [
    { id: '', label: t('referral_admin.all_statuses') },
    { id: 'settled', label: t('referral.status_settled') },
    { id: 'reversed', label: t('referral.status_reversed') },
  ], [t]);

  return (
    <div className="space-y-6">
      {/* 配置卡片：全部数值后台可调 */}
      <div className="rounded-[var(--radius)] border border-border bg-surface p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <div className="text-base font-semibold" style={{ color: 'var(--ag-text)' }}>
              {t('referral_admin.config_title')}
            </div>
            <p className="mt-0.5 text-sm" style={{ color: 'var(--ag-text-secondary)' }}>
              {t('referral_admin.config_desc')}
            </p>
          </div>
          <Button variant="primary" onPress={() => saveConfig.mutate()} isPending={saveConfig.isPending}>
            {t('common.save')}
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="flex items-center">
            <NativeSwitch
              isSelected={enabled}
              label={<span className="text-sm font-medium text-text">{t('referral_admin.enabled')}</span>}
              onChange={(v) => setEnabled(Boolean(v))}
            />
          </div>
          <div>
            <Label className="mb-1.5 block text-xs" style={{ color: 'var(--ag-text-tertiary)' }}>
              {t('referral_admin.default_rate')}
            </Label>
            <div className="flex items-center gap-2">
              <Input value={defaultRate} onChange={(e) => setDefaultRate(e.target.value)} placeholder="10" />
              <span className="text-sm" style={{ color: 'var(--ag-text-tertiary)' }}>%</span>
            </div>
          </div>
          <div>
            <Label className="mb-1.5 block text-xs" style={{ color: 'var(--ag-text-tertiary)' }}>
              {t('referral_admin.first_bonus_rate')}
            </Label>
            <div className="flex items-center gap-2">
              <Input value={firstBonusRate} onChange={(e) => setFirstBonusRate(e.target.value)} placeholder="5" />
              <span className="text-sm" style={{ color: 'var(--ag-text-tertiary)' }}>%</span>
            </div>
          </div>
          <div>
            <Label className="mb-1.5 block text-xs" style={{ color: 'var(--ag-text-tertiary)' }}>
              {t('referral_admin.link_base_url')}
            </Label>
            <Input
              value={linkBaseUrl}
              onChange={(e) => setLinkBaseUrl(e.target.value)}
              placeholder={t('referral_admin.link_base_url_placeholder')}
            />
          </div>
        </div>
      </div>

      {/* 推广官汇总：线下结算对账依据 */}
      <div>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="text-base font-semibold" style={{ color: 'var(--ag-text)' }}>
            {t('referral_admin.summary_title')}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onPress={() => openPromoterModal(null)}>
              {t('referral_admin.set_promoter')}
            </Button>
            <Button size="sm" variant="secondary" onPress={() => openRateModal(null)}>
              {t('referral_admin.set_rate')}
            </Button>
          </div>
        </div>
        <CommonTable ariaLabel={t('referral_admin.summary_title')} minWidth={860}>
          <CommonTable.Header>
            <CommonTable.Column id="promoter">{t('referral_admin.col_promoter')}</CommonTable.Column>
            <CommonTable.Column id="rate" style={{ width: 110 }}>{t('referral_admin.col_rate_override')}</CommonTable.Column>
            <CommonTable.Column id="invitees" style={{ width: 96 }}>{t('referral.invitee_count')}</CommonTable.Column>
            <CommonTable.Column id="rebate" style={{ width: 130 }}>{t('referral.total_rebate')}</CommonTable.Column>
            <CommonTable.Column id="reversed" style={{ width: 110 }}>{t('referral.total_reversed')}</CommonTable.Column>
            <CommonTable.Column id="bonus" style={{ width: 130 }}>{t('referral_admin.col_first_bonus_total')}</CommonTable.Column>
            <CommonTable.Column id="actions" style={{ width: 150 }}>{t('common.actions')}</CommonTable.Column>
          </CommonTable.Header>
          <CommonTable.Body>
            {summaryLoading ? (
              <TableLoadingRow colSpan={7} />
            ) : !promoters || promoters.length === 0 ? (
              <CommonTable.Row id="empty">
                <CommonTable.Cell colSpan={7}>
                  <EmptyState>
                    <div className="text-sm text-default-500">{t('referral_admin.summary_empty')}</div>
                  </EmptyState>
                </CommonTable.Cell>
              </CommonTable.Row>
            ) : (
              promoters.map((row) => (
                <CommonTable.Row id={String(row.user_id)} key={row.user_id}>
                  <CommonTable.Cell>
                    <div className="flex min-w-0 flex-col">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="ag-cell-2line font-medium" style={{ color: 'var(--ag-text)' }}>{row.email}</span>
                        {row.tier === 'official' ? (
                          <span
                            className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                            style={{ background: 'rgba(202,138,4,0.16)', color: '#b8860b' }}
                          >
                            {t('referral_admin.official_tag')}
                          </span>
                        ) : null}
                      </div>
                      <span className="truncate text-[11px]" style={{ color: 'var(--ag-text-tertiary)' }}>
                        #{row.user_id}{row.username ? ` · ${row.username}` : ''}
                        {row.invite_code ? ` · ${row.invite_code}` : ''}
                      </span>
                    </div>
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    {row.referral_rate != null ? (
                      <span className="font-mono tabular-nums">{rateToPercent(String(row.referral_rate))}%</span>
                    ) : (
                      <span style={{ color: 'var(--ag-text-tertiary)' }}>{t('referral_admin.rate_default')}</span>
                    )}
                  </CommonTable.Cell>
                  <CommonTable.Cell><span className="font-mono tabular-nums">{row.invitee_count}</span></CommonTable.Cell>
                  <CommonTable.Cell>
                    <span className="font-mono tabular-nums font-medium">${row.total_rebate.toFixed(4)}</span>
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    <span className="font-mono tabular-nums">${row.total_reversed.toFixed(4)}</span>
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    <span className="font-mono tabular-nums">${row.first_bonus_total.toFixed(4)}</span>
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    <div className="flex gap-0.5">
                      <Button size="sm" variant="ghost" onPress={() => openRateModal(row)}>
                        {t('referral_admin.set_rate')}
                      </Button>
                      <Button size="sm" variant="ghost" onPress={() => openPromoterModal(row)}>
                        {t('referral_admin.official_short')}
                      </Button>
                    </div>
                  </CommonTable.Cell>
                </CommonTable.Row>
              ))
            )}
          </CommonTable.Body>
        </CommonTable>
      </div>

      {/* 返利流水 */}
      <div>
        <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-base font-semibold" style={{ color: 'var(--ag-text)' }}>
            {t('referral_admin.commissions_title')}
          </div>
          <div className="flex gap-2">
            {[
              { key: 'kind', value: kindFilter, options: kindOptions, setValue: setKindFilter },
              { key: 'status', value: statusFilter, options: statusOptions, setValue: setStatusFilter },
            ].map((filter) => (
              <div key={filter.key} className="w-40">
                <Select
                  aria-label={filter.key}
                  fullWidth
                  selectedKey={filter.value}
                  onSelectionChange={(key) => {
                    filter.setValue(key == null ? '' : String(key));
                    setPage(1);
                  }}
                >
                  <Select.Trigger>
                    <Select.Value>
                      {filter.options.find((item) => item.id === filter.value)?.label ?? filter.options[0]?.label}
                    </Select.Value>
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox items={filter.options}>
                      {(item) => (
                        <ListBox.Item id={item.id} textValue={item.label}>
                          {item.label}
                        </ListBox.Item>
                      )}
                    </ListBox>
                  </Select.Popover>
                </Select>
              </div>
            ))}
          </div>
        </div>
        <CommonTable
          ariaLabel={t('referral_admin.commissions_title')}
          footer={(
            <TablePaginationFooter
              page={page}
              pageSize={pageSize}
              setPage={setPage}
              setPageSize={setPageSize}
              total={total}
              totalPages={totalPages}
            />
          )}
          minWidth={1080}
        >
          <CommonTable.Header>
            <CommonTable.Column id="time" style={{ width: 148 }}>{t('referral.col_time')}</CommonTable.Column>
            <CommonTable.Column id="kind" style={{ width: 100 }}>{t('referral_admin.col_kind')}</CommonTable.Column>
            <CommonTable.Column id="inviter">{t('referral_admin.col_inviter')}</CommonTable.Column>
            <CommonTable.Column id="invitee">{t('referral_admin.col_invitee')}</CommonTable.Column>
            <CommonTable.Column id="order" style={{ width: 170 }}>{t('referral_admin.col_order')}</CommonTable.Column>
            <CommonTable.Column id="paid" style={{ width: 100 }}>{t('referral.col_paid')}</CommonTable.Column>
            <CommonTable.Column id="rate" style={{ width: 80 }}>{t('referral.col_rate')}</CommonTable.Column>
            <CommonTable.Column id="amount" style={{ width: 110 }}>{t('referral.col_amount')}</CommonTable.Column>
            <CommonTable.Column id="status" style={{ width: 90 }}>{t('referral.col_status')}</CommonTable.Column>
            <CommonTable.Column id="actions" style={{ width: 90 }}>{t('common.actions')}</CommonTable.Column>
          </CommonTable.Header>
          <CommonTable.Body>
            {listLoading ? (
              <TableLoadingRow colSpan={10} />
            ) : rows.length === 0 ? (
              <CommonTable.Row id="empty">
                <CommonTable.Cell colSpan={10}>
                  <EmptyState>
                    <div className="text-sm text-default-500">{t('referral.empty')}</div>
                  </EmptyState>
                </CommonTable.Cell>
              </CommonTable.Row>
            ) : (
              rows.map((row) => (
                <CommonTable.Row id={String(row.id)} key={row.id}>
                  <CommonTable.Cell>
                    <span className="font-mono tabular-nums whitespace-nowrap">{formatTime(row.created_at)}</span>
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    <Chip color={row.kind === 'rebate' ? 'accent' : 'default'} size="sm" variant="soft">
                      {row.kind === 'rebate' ? t('referral_admin.kind_rebate') : t('referral_admin.kind_first_bonus')}
                    </Chip>
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    <span className="truncate" title={row.inviter_email}>{row.inviter_email}</span>
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    <span className="truncate" title={row.invitee_email}>{row.invitee_email}</span>
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    <span className="truncate font-mono text-xs" title={row.out_trade_no}>{row.out_trade_no}</span>
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    <span className="font-mono tabular-nums">${row.paid_amount.toFixed(2)}</span>
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    <span className="font-mono tabular-nums">{(row.rate * 100).toFixed(1)}%</span>
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    <span className="font-mono tabular-nums font-medium">${row.amount.toFixed(4)}</span>
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    <Chip color={row.status === 'settled' ? 'success' : 'default'} size="sm" variant="soft">
                      {row.status === 'settled' ? t('referral.status_settled') : t('referral.status_reversed')}
                    </Chip>
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    {row.status === 'settled' ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-danger"
                        onPress={() => {
                          setReverseTarget({
                            id: row.id,
                            amount: row.amount,
                            email: row.kind === 'rebate' ? row.inviter_email : row.invitee_email,
                          });
                          reverseModal.open();
                        }}
                      >
                        {t('referral_admin.reverse')}
                      </Button>
                    ) : (
                      <span style={{ color: 'var(--ag-text-tertiary)' }}>-</span>
                    )}
                  </CommonTable.Cell>
                </CommonTable.Row>
              ))
            )}
          </CommonTable.Body>
        </CommonTable>
      </div>

      {/* 设置比例弹窗 */}
      <CommonModal
        state={rateModal}
        size="sm"
        title={t('referral_admin.set_rate')}
        footer={(
          <div className="flex w-full items-center justify-between gap-2">
            <Button
              size="sm"
              variant="ghost"
              onPress={() => submitRate(true)}
              isPending={setRateMutation.isPending}
              isDisabled={rateUserId == null}
            >
              {t('referral_admin.clear_override')}
            </Button>
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" onPress={() => rateModal.close()}>{t('common.cancel')}</Button>
              <Button
                size="sm"
                variant="primary"
                onPress={() => submitRate(false)}
                isPending={setRateMutation.isPending}
                isDisabled={rateUserId == null}
              >
                {t('common.save')}
              </Button>
            </div>
          </div>
        )}
      >
        <div className="space-y-4">
          {rateTarget ? (
            <div className="text-sm" style={{ color: 'var(--ag-text-secondary)' }}>{rateTarget.email}</div>
          ) : (
            <ComboBox
              aria-label={t('users.search_placeholder')}
              allowsEmptyCollection
              fullWidth
              inputValue={rateEmailQuery}
              items={rateSearchOptions}
              menuTrigger="focus"
              selectedKey={ratePickedUser ? String(ratePickedUser.id) : null}
              onInputChange={(value) => {
                setRateEmailQuery(value);
                if (ratePickedUser && value !== ratePickedUser.email) {
                  setRatePickedUser(null);
                }
              }}
              onSelectionChange={(key) => {
                const value = key == null ? '' : String(key);
                if (!value) {
                  setRatePickedUser(null);
                  setRateEmailQuery('');
                  return;
                }
                const user = rateSearchResults.find((item) => String(item.id) === value)
                  ?? (ratePickedUser && String(ratePickedUser.id) === value ? ratePickedUser : null);
                setRatePickedUser(user ?? null);
                setRateEmailQuery(user?.email ?? '');
              }}
            >
              <ComboBox.InputGroup className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
                <Input className="pl-9 pr-10" placeholder={t('users.search_placeholder') ?? ''} />
                <ComboBox.Trigger
                  className="ag-combobox-preview-trigger absolute right-1 top-1/2 z-10 h-7 w-7 min-w-0 -translate-y-1/2 p-0 text-text-tertiary hover:text-text"
                />
              </ComboBox.InputGroup>
              <ComboBox.Popover>
                <ListBox
                  items={rateSearchOptions}
                  renderEmptyState={() => (
                    <div className="px-3 py-6 text-center text-xs text-text-tertiary">
                      {debouncedRateEmailQuery ? t('common.no_data') : t('users.search_placeholder')}
                    </div>
                  )}
                >
                  {(item) => (
                    <ListBox.Item id={item.id} textValue={item.textValue}>
                      <div className="min-w-0">
                        <div className="truncate text-sm text-text">{item.label}</div>
                        {item.description ? (
                          <div className="truncate text-xs text-text-tertiary">{item.description}</div>
                        ) : null}
                      </div>
                    </ListBox.Item>
                  )}
                </ListBox>
              </ComboBox.Popover>
            </ComboBox>
          )}
          <div>
            <Label className="mb-1.5 block text-xs" style={{ color: 'var(--ag-text-tertiary)' }}>
              {t('referral_admin.rate_override_label')}
            </Label>
            <div className="flex items-center gap-2">
              <Input value={rateInput} onChange={(e) => setRateInput(e.target.value)} placeholder="10" />
              <span className="text-sm" style={{ color: 'var(--ag-text-tertiary)' }}>%</span>
            </div>
            <p className="mt-1 text-[11px]" style={{ color: 'var(--ag-text-tertiary)' }}>
              {t('referral_admin.rate_override_hint')}
            </p>
          </div>
        </div>
      </CommonModal>

      {/* 官方推广官弹窗 */}
      <CommonModal
        state={promoterModal}
        size="sm"
        title={t('referral_admin.set_promoter')}
        footer={(
          <div className="flex w-full justify-end gap-2">
            <Button size="sm" variant="secondary" onPress={() => promoterModal.close()}>{t('common.cancel')}</Button>
            <Button
              size="sm"
              variant="primary"
              onPress={submitPromoter}
              isPending={setPromoterMutation.isPending}
              isDisabled={promoterUserId == null}
            >
              {t('common.save')}
            </Button>
          </div>
        )}
      >
        <div className="space-y-4">
          {promoterTarget ? (
            <div className="text-sm" style={{ color: 'var(--ag-text-secondary)' }}>{promoterTarget.email}</div>
          ) : (
            <ComboBox
              aria-label={t('users.search_placeholder')}
              allowsEmptyCollection
              fullWidth
              inputValue={promoterEmailQuery}
              items={promoterSearchOptions}
              menuTrigger="focus"
              selectedKey={promoterPickedUser ? String(promoterPickedUser.id) : null}
              onInputChange={(value) => {
                setPromoterEmailQuery(value);
                if (promoterPickedUser && value !== promoterPickedUser.email) {
                  setPromoterPickedUser(null);
                }
              }}
              onSelectionChange={(key) => {
                const value = key == null ? '' : String(key);
                if (!value) {
                  setPromoterPickedUser(null);
                  setPromoterEmailQuery('');
                  return;
                }
                const user = promoterSearchResults.find((item) => String(item.id) === value)
                  ?? (promoterPickedUser && String(promoterPickedUser.id) === value ? promoterPickedUser : null);
                setPromoterPickedUser(user ?? null);
                setPromoterEmailQuery(user?.email ?? '');
              }}
            >
              <ComboBox.InputGroup className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
                <Input className="pl-9 pr-10" placeholder={t('users.search_placeholder') ?? ''} />
                <ComboBox.Trigger
                  className="ag-combobox-preview-trigger absolute right-1 top-1/2 z-10 h-7 w-7 min-w-0 -translate-y-1/2 p-0 text-text-tertiary hover:text-text"
                />
              </ComboBox.InputGroup>
              <ComboBox.Popover>
                <ListBox
                  items={promoterSearchOptions}
                  renderEmptyState={() => (
                    <div className="px-3 py-6 text-center text-xs text-text-tertiary">
                      {debouncedPromoterEmailQuery ? t('common.no_data') : t('users.search_placeholder')}
                    </div>
                  )}
                >
                  {(item) => (
                    <ListBox.Item id={item.id} textValue={item.textValue}>
                      <div className="min-w-0">
                        <div className="truncate text-sm text-text">{item.label}</div>
                        {item.description ? (
                          <div className="truncate text-xs text-text-tertiary">{item.description}</div>
                        ) : null}
                      </div>
                    </ListBox.Item>
                  )}
                </ListBox>
              </ComboBox.Popover>
            </ComboBox>
          )}
          <div className="flex items-center">
            <NativeSwitch
              isSelected={promoterOfficial}
              label={<span className="text-sm font-medium text-text">{t('referral_admin.promoter_official')}</span>}
              onChange={(v) => setPromoterOfficial(Boolean(v))}
            />
          </div>
          <p className="text-[11px]" style={{ color: 'var(--ag-text-tertiary)' }}>
            {t('referral_admin.promoter_hint')}
          </p>
          <div>
            <Label className="mb-1.5 block text-xs" style={{ color: 'var(--ag-text-tertiary)' }}>
              {t('referral_admin.promoter_code_label')}
            </Label>
            <Input
              value={promoterCode}
              onChange={(e) => setPromoterCode(e.target.value)}
              placeholder={t('referral_admin.promoter_code_placeholder')}
            />
            <p className="mt-1 text-[11px]" style={{ color: 'var(--ag-text-tertiary)' }}>
              {t('referral_admin.promoter_code_hint')}
            </p>
          </div>
          <div>
            <Label className="mb-1.5 block text-xs" style={{ color: 'var(--ag-text-tertiary)' }}>
              {t('referral_admin.promoter_name_label')}
            </Label>
            <Input
              value={promoterName}
              onChange={(e) => setPromoterName(e.target.value)}
              placeholder={t('referral_admin.promoter_name_placeholder')}
            />
            <p className="mt-1 text-[11px]" style={{ color: 'var(--ag-text-tertiary)' }}>
              {t('referral_admin.promoter_name_hint')}
            </p>
          </div>
        </div>
      </CommonModal>

      {/* 回冲确认弹窗 */}
      <CommonModal
        state={reverseModal}
        size="sm"
        title={t('referral_admin.reverse')}
        footer={(
          <div className="flex w-full justify-end gap-2">
            <Button size="sm" variant="secondary" onPress={() => reverseModal.close()}>{t('common.cancel')}</Button>
            <Button
              size="sm"
              variant="danger"
              onPress={() => reverseTarget && reverseMutation.mutate(reverseTarget.id)}
              isPending={reverseMutation.isPending}
            >
              {t('referral_admin.reverse_confirm')}
            </Button>
          </div>
        )}
      >
        <div className="space-y-2">
          <p className="text-sm" style={{ color: 'var(--ag-text-secondary)' }}>
            {t('referral_admin.reverse_hint', {
              amount: reverseTarget ? `$${reverseTarget.amount.toFixed(4)}` : '',
              email: reverseTarget?.email ?? '',
            })}
          </p>
        </div>
      </CommonModal>
    </div>
  );
}
