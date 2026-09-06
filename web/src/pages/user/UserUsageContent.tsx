import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearch } from '@tanstack/react-router';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Button, Card, ListBox, Meter, Select } from '@heroui/react';
import { usageApi } from '../../shared/api/usage';
import { apikeysApi } from '../../shared/api/apikeys';
import { membersApi } from '../../shared/api/members';
import { queryKeys } from '../../shared/queryKeys';
import { usePagination } from '../../shared/hooks/usePagination';
import { usePlatforms } from '../../shared/hooks/usePlatforms';
import { useAuth } from '../../app/providers/AuthProvider';
import { useToast } from '../../shared/ui';
import { Clock, Download, Gauge, Percent, Upload, UsersRound } from 'lucide-react';
import type { UsageQuery } from '../../shared/types';
import { useUsageColumns, fmtNum, type UsageColumnConfig, type UsageRow } from '../../shared/columns/usageColumns';
import { getSessionAPIKey } from '../../shared/api/client';
import { CcsImportModal } from './userkeys/CcsImportModal';
import { UsageRecordsTable } from '../../shared/components/UsageRecordsTable';
import { UsageDateRangeFilter } from '../../shared/components/UsageDateRangeFilter';
import { UsageModelFilterInput } from '../../shared/components/UsageModelFilterInput';
import { CostValue } from '../../shared/components/CostValue';
import { AutoRefreshControl } from '../../shared/components/AutoRefreshControl';
import { FETCH_ALL_PARAMS } from '../../shared/constants';
import { USER_AUTO_REFRESH_OPTIONS, usePersistentAutoRefresh } from '../../shared/hooks/usePersistentAutoRefresh';

const USER_USAGE_AUTO_UPDATE_STORAGE_KEY = 'airgate.user.usage.auto_update';


function APIKeyInfoBar() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { toast } = useToast();
  const [ccsOpen, setCcsOpen] = useState(false);
  if (!user) return null;
  // 密钥会话 或 团队成员账号本人登录（后者没有 api_key_id，只展示成员归属与额度）
  const isMemberAccount = !user.api_key_id && (user.member_id ?? 0) > 0;
  if (!user.api_key_id && !isMemberAccount) return null;

  const quota = user.api_key_quota_usd ?? 0;
  const used = user.api_key_used_quota ?? 0;
  const expiresAt = user.api_key_expires_at;
  const pct = quota > 0 ? Math.min((used / quota) * 100, 100) : 0;
  // 团队成员会话：额外展示成员本期额度（成员名下全部 key 共用），与单把 key 的额度并列
  const memberName = user.member_name || '';
  const memberQuota = user.member_quota_usd ?? 0;
  const memberUsed = user.member_used_quota ?? 0;
  const memberPct = memberQuota > 0 ? Math.min((memberUsed / memberQuota) * 100, 100) : 0;
  const memberPeriodEnd = user.member_period_end ? new Date(user.member_period_end).toLocaleDateString() : '';

  // 原文 Key 仅在 API Key 登录当次会话内通过 sessionStorage 暂存；刷新页面后丢失，
  // 此时按钮会提示用户重新登录。
  const sessionKey = getSessionAPIKey();
  const platform = user.api_key_platform || '';
  const canImportCcs = !!sessionKey && !isMemberAccount;

  function handleImportCcs() {
    if (!sessionKey) {
      toast('error', t('user_keys.ccs_session_expired'));
      return;
    }
    setCcsOpen(true);
  }

  // 后端已经把"销售倍率优先、否则分组倍率"折算成单一字段 api_key_rate，
  // 前端拿不到原始来源，避免通过 DevTools 推断 reseller 定价模型。
  const effectiveRate = user.api_key_rate ?? 0;

  // 到期时间格式化
  let expiresLabel = '';
  let expiresWarning = false;
  if (expiresAt) {
    const d = new Date(expiresAt);
    const now = new Date();
    const diffDays = Math.ceil((d.getTime() - now.getTime()) / 86400000);
    expiresLabel = d.toLocaleDateString();
    expiresWarning = diffDays <= 7;
  }

  return (
    <Card className="mb-5">
      <Card.Content className="flex items-center gap-4 px-4 py-3 text-sm flex-wrap">
        {memberName && (
          <div className="flex items-center gap-2">
            <UsersRound className="w-3.5 h-3.5 text-text-tertiary" />
            <span className="text-text-tertiary">{t('auth.apikey_member_badge')}:</span>
            <span className="font-medium text-text">{memberName}</span>
          </div>
        )}
        {memberName && memberQuota > 0 && (
          <div className="flex items-center gap-2">
            <Gauge className="w-3.5 h-3.5 text-text-tertiary" />
            <span className="text-text-tertiary">{t('auth.member_quota')}:</span>
            <span className={memberPct >= 90 ? 'text-danger font-medium' : 'text-text-secondary'}>
              ${memberUsed.toFixed(4)} / ${memberQuota.toFixed(2)}
            </span>
            <Meter
              aria-label={t('auth.member_quota')}
              className="w-20"
              color={memberPct >= 90 ? 'danger' : memberPct >= 70 ? 'warning' : 'accent'}
              maxValue={100}
              minValue={0}
              size="sm"
              value={memberPct}
            >
              <Meter.Track>
                <Meter.Fill />
              </Meter.Track>
            </Meter>
            {memberPeriodEnd ? (
              <span className="text-xs text-text-tertiary">{t('auth.member_period_end')} {memberPeriodEnd}</span>
            ) : null}
          </div>
        )}
        {quota > 0 && (
          <div className="flex items-center gap-2">
            <Gauge className="w-3.5 h-3.5 text-text-tertiary" />
            <span className="text-text-tertiary">{t('auth.apikey_quota')}:</span>
            <span className={pct >= 90 ? 'text-danger font-medium' : 'text-text-secondary'}>
              ${used.toFixed(4)} / ${quota.toFixed(2)}
            </span>
            <Meter
              aria-label={t('auth.apikey_quota')}
              className="w-20"
              color={pct >= 90 ? 'danger' : pct >= 70 ? 'warning' : 'accent'}
              maxValue={100}
              minValue={0}
              size="sm"
              value={pct}
            >
              <Meter.Track>
                <Meter.Fill />
              </Meter.Track>
            </Meter>
          </div>
        )}

        {quota === 0 && (
          <div className="flex items-center gap-2 text-text-tertiary">
            <Gauge className="w-3.5 h-3.5" />
            <span>{t('auth.apikey_quota')}: {t('auth.apikey_unlimited')}</span>
          </div>
        )}

        {expiresAt && (
          <div className="flex items-center gap-2">
            <Clock className="w-3.5 h-3.5 text-text-tertiary" />
            <span className="text-text-tertiary">{t('auth.apikey_expires')}:</span>
            <span className={expiresWarning ? 'text-warning font-medium' : 'text-text-secondary'}>
              {expiresLabel}
            </span>
          </div>
        )}

        {!expiresAt && (
          <div className="flex items-center gap-2 text-text-tertiary">
            <Clock className="w-3.5 h-3.5" />
            <span>{t('auth.apikey_expires')}: {t('auth.apikey_never')}</span>
          </div>
        )}

        {effectiveRate > 0 && (
          <div className="flex items-center gap-2">
            <Percent className="w-3.5 h-3.5 text-text-tertiary" />
            <span className="text-text-tertiary">{t('auth.apikey_rate', 'Rate')}:</span>
            <span className="text-text-secondary font-mono">{effectiveRate.toFixed(2)}x</span>
          </div>
        )}

        {!isMemberAccount ? (
          <Button
            type="button"
            onPress={handleImportCcs}
            isDisabled={!canImportCcs}
            className="ml-auto"
            size="sm"
            variant="outline"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>{t('user_keys.import_ccs')}</span>
          </Button>
        ) : null}

        <CcsImportModal
          open={ccsOpen}
          ccsKeyValue={sessionKey}
          ccsPlatform={platform}
          onClose={() => setCcsOpen(false)}
        />
      </Card.Content>
    </Card>
  );
}

export default function UserUsageContent() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user } = useAuth();
  const customerScope = !!user?.api_key_id;
  // 成员筛选只有企业主/管理员才有数据；成员账号本人调 /members 会被 403，直接不请求
  const canListMembers = !customerScope && (user?.role === 'admin' || !!user?.is_enterprise_owner) && !((user?.member_id ?? 0) > 0);
  const { page, setPage, pageSize, setPageSize } = usePagination(20, 'user.usage');
  // 团队成员页「查看用量」经 ?member_id= 跳入：预置成员筛选
  const search: { member_id?: number | string } = useSearch({ strict: false });
  const initialMemberID = search.member_id != null && Number(search.member_id) > 0 ? Number(search.member_id) : undefined;
  const [filters, setFilters] = useState<Partial<UsageQuery>>(initialMemberID ? { member_id: initialMemberID } : {});
  const [autoRefresh, setAutoRefresh] = usePersistentAutoRefresh(USER_USAGE_AUTO_UPDATE_STORAGE_KEY, 0, USER_AUTO_REFRESH_OPTIONS);
  const autoRefreshEnabled = autoRefresh > 0;
  const autoRefreshLabel = `${t('usage.auto_update')} `;
  const autoRefreshOffLabel = t('usage.auto_update_off');

  const handleModelChange = useCallback((model: string) => {
    const nextModel = model || undefined;
    setPage(1);
    setFilters((prev) => (prev.model === nextModel ? prev : { ...prev, model: nextModel }));
  }, [setPage]);

  const queryParams = useMemo<UsageQuery>(() => ({
    page,
    page_size: pageSize,
    ...filters,
  }), [filters, page, pageSize]);

  const { platforms, platformName } = usePlatforms();
  const platformOptions = [
    { id: '', label: t('common.all') },
    ...platforms.map((p) => ({ id: p, label: platformName(p) })),
  ];
  const selectedPlatformLabel = platformOptions.find((item) => item.id === (filters.platform || ''))?.label ?? t('common.all');

  const resultOptions = [
    { id: '', label: t('common.all') },
    { id: 'success', label: t('usage.result_success', 'Success') },
    { id: 'error', label: t('usage.result_failed', 'Failed') },
  ];

  const { data: apiKeysData } = useQuery({
    queryKey: queryKeys.userKeys('usage-filter'),
    queryFn: () => apikeysApi.list(FETCH_ALL_PARAMS),
    enabled: !customerScope,
  });
  const apiKeyOptions = [
    { id: '', label: t('common.all') },
    ...(apiKeysData?.list ?? []).map((key) => ({ id: String(key.id), label: key.name })),
  ];
  const selectedApiKeyLabel = apiKeyOptions.find((item) => item.id === String(filters.api_key_id ?? ''))?.label ?? t('common.all');

  const { data: membersData } = useQuery({
    queryKey: queryKeys.membersForKeys(),
    queryFn: () => membersApi.list(FETCH_ALL_PARAMS),
    enabled: canListMembers,
    staleTime: 60_000,
  });
  const memberOptions = [
    { id: '', label: t('common.all') },
    ...(membersData?.list ?? []).map((member) => ({ id: String(member.id), label: member.name })),
  ];
  const hasMembers = (membersData?.list?.length ?? 0) > 0;
  const selectedMemberLabel = memberOptions.find((item) => item.id === String(filters.member_id ?? ''))?.label ?? t('common.all');

  const {
    data,
    dataUpdatedAt,
    isFetching: isUsageFetching,
    isLoading,
    isPlaceholderData,
    refetch: refetchUsage,
  } = useQuery({
    queryKey: queryKeys.userUsage(queryParams),
    queryFn: ({ signal }) => usageApi.list(queryParams, { signal }),
    meta: { globalLoading: false },
    refetchOnReconnect: autoRefreshEnabled,
    refetchOnWindowFocus: autoRefreshEnabled,
    placeholderData: keepPreviousData,
  });

  // 聚合统计（跟随筛选条件，独立于分页）
  const { data: stats, isFetching: isStatsFetching, refetch: refetchStats } = useQuery({
    queryKey: queryKeys.userUsageStats(filters),
    queryFn: ({ signal }) => usageApi.userStats(filters, { signal }),
    meta: { globalLoading: false },
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  const isRefreshing = isUsageFetching || isStatsFetching;
  const isUsageTableRefreshing = isUsageFetching;

  // 导出当前筛选范围的明细。后端要 RFC3339 的 start_time：
  // 日期筛选给的是本地时间字符串（"2026-09-01" 或 "2026-09-01T14:30:05"），
  // 纯日期按本地零点/当日 23:59:59 补齐再转 UTC；没选时间范围就默认最近 30 天。
  const [exporting, setExporting] = useState(false);
  const toRFC3339 = (raw: string | undefined, endOfDay: boolean): string | undefined => {
    if (!raw) return undefined;
    const normalized = raw.includes('T') ? raw : `${raw}T${endOfDay ? '23:59:59' : '00:00:00'}`;
    const parsed = new Date(normalized);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  };
  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const startTime = toRFC3339(filters.start_date, false)
        ?? new Date(Date.now() - 30 * 86400_000).toISOString();
      const { blob, filename } = await usageApi.exportCsv({
        start_time: startTime,
        end_time: toRFC3339(filters.end_date, true),
        member_id: filters.member_id,
        api_key_id: filters.api_key_id,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(href);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : t('common.error'));
    } finally {
      setExporting(false);
    }
  }, [filters.api_key_id, filters.end_date, filters.member_id, filters.start_date, t, toast]);

  const handleManualRefresh = useCallback(() => {
    void refetchUsage({ cancelRefetch: false });
    void refetchStats({ cancelRefetch: false });
  }, [refetchStats, refetchUsage]);

  const handleAutoRefresh = useCallback(() => {
    void refetchUsage({ cancelRefetch: false });
  }, [refetchUsage]);

  function updateFilter(key: string, value: string) {
    const nextValue = (key === 'api_key_id' || key === 'member_id') && value ? Number(value) : value || undefined;
    setFilters((prev) => ({ ...prev, [key]: nextValue }));
    setPage(1);
  }

  const list = data?.list ?? [];
  const total = data?.total ?? 0;
  const visibleActualCost = customerScope ? (stats?.total_billed_cost ?? 0) : (stats?.total_actual_cost ?? 0);

  const sharedColumns = useUsageColumns({ customerScope, adminView: false });
  const modelColumnIndex = sharedColumns.findIndex((column) => column.key === 'model');
  const timeColumnIndex = sharedColumns.findIndex((column) => column.key === 'created_at');
  const streamColumn = sharedColumns.find((column) => column.key === 'stream');
  const timingColumns = sharedColumns.filter((column) => column.key === 'first_token_ms' || column.key === 'duration_ms');
  const sharedColumnsAfterModel = sharedColumns
    .slice(modelColumnIndex + 1)
    .filter((column) => column.key !== 'first_token_ms' && column.key !== 'duration_ms' && column.key !== 'stream');
  const endpointColumn: UsageColumnConfig<UsageRow> = {
    key: 'endpoint',
    title: t('usage.endpoint', 'Endpoint'),
    width: '180px',
    hideOnMobile: true,
    render: (row) => {
      const endpoint = 'endpoint' in row && row.endpoint ? row.endpoint : '-';

      return (
        <span className="block truncate font-mono text-xs leading-tight text-text-secondary" title={endpoint}>
          {endpoint}
        </span>
      );
    },
  };
  const apiKeyColumn: UsageColumnConfig<UsageRow> = {
    key: 'api_key',
    title: 'API Key',
    width: '96px',
    hideOnMobile: true,
    render: (row) => {
      if ('api_key_deleted' in row && row.api_key_deleted) {
        return <span className="block max-w-full truncate text-[13px] text-text-tertiary">{t('usage.api_key_deleted')}</span>;
      }

      const name = 'api_key_name' in row && row.api_key_name ? row.api_key_name : '-';

      return (
        <span className="block max-w-full truncate text-xs text-text-secondary" title={name}>{name}</span>
      );
    },
  };
  const memberColumn: UsageColumnConfig<UsageRow> = {
    key: 'member',
    title: t('usage.member'),
    width: '88px',
    hideOnMobile: true,
    render: (row) => {
      const memberID = 'member_id' in row && row.member_id ? row.member_id : 0;
      if (!memberID) return <span className="block text-xs text-text-tertiary">-</span>;
      const name = 'member_name' in row && row.member_name ? row.member_name : t('usage.member_deleted');
      return (
        <span className="block max-w-full truncate text-xs text-text-secondary" title={name}>{name}</span>
      );
    },
  };
  // 有团队成员时才多一列，普通用户的表格保持原样
  const ownerExtraColumns = customerScope ? [] : hasMembers ? [apiKeyColumn, memberColumn] : [apiKeyColumn];
  const columns = modelColumnIndex >= 0
    ? [
        ...sharedColumns.slice(0, timeColumnIndex + 1),
        ...ownerExtraColumns,
        ...sharedColumns.slice(timeColumnIndex + 1, modelColumnIndex + 1),
        ...(streamColumn ? [streamColumn] : []),
        ...timingColumns,
        ...sharedColumnsAfterModel,
        endpointColumn,
      ]
    : [
        ...sharedColumns,
        endpointColumn,
        ...ownerExtraColumns,
      ];

  return (
    <div>
      {/* API Key 登录信息 */}
      <APIKeyInfoBar />

      {/* 概览摘要:客户侧只给请求数 / Token / 费用一行,不放失败数(仍可按结果筛选) */}
      <p className="ag-usage-summary">
        <span>{t('usage.total_requests')}</span>
        <b>{(stats?.total_requests ?? 0).toLocaleString()}</b>
        <span aria-hidden="true" className="ag-usage-summary-sep">·</span>
        <span>{t('usage.total_tokens')}</span>
        <b>{fmtNum(stats?.total_tokens ?? 0)}</b>
        <span aria-hidden="true" className="ag-usage-summary-sep">·</span>
        <span>{t('usage.actual_cost')}</span>
        <b><CostValue value={visibleActualCost} decimals={4} tone="actual" /></b>
      </p>

      {/* 筛选栏 */}
      <div className="ag-filter-bar flex flex-col sm:flex-row items-stretch sm:items-center gap-3 mb-5 flex-wrap">
        <div className="w-full sm:w-auto">
          <UsageDateRangeFilter
            clearLabel={t('common.clear')}
            endDate={filters.end_date}
            endTimeLabel={t('usage.end_time')}
            label={t('usage.time_range')}
            startDate={filters.start_date}
            startTimeLabel={t('usage.start_time')}
            onChange={(startDate, endDate) => {
              setPage(1);
              setFilters((prev) => ({ ...prev, start_date: startDate, end_date: endDate }));
            }}
          />
        </div>
        <div className="w-full sm:w-48">
          <Select
            aria-label={t('usage.platform')}
            fullWidth
            selectedKey={filters.platform || ''}
            onSelectionChange={(key) => updateFilter('platform', key == null ? '' : String(key))}
          >
            <Select.Trigger>
              <Select.Value>
                {filters.platform ? selectedPlatformLabel : (
                  <span className="text-text-tertiary">{t('usage.platform')}</span>
                )}
              </Select.Value>
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox items={platformOptions}>
                {(item) => (
                  <ListBox.Item id={item.id} textValue={item.label}>
                    {item.label}
                  </ListBox.Item>
                )}
              </ListBox>
            </Select.Popover>
          </Select>
        </div>
        <div className="w-full sm:w-40">
          <Select
            aria-label={t('usage.result', 'Result')}
            fullWidth
            selectedKey={filters.result ?? ''}
            onSelectionChange={(key) => updateFilter('result', key == null ? '' : String(key))}
          >
            <Select.Trigger>
              <Select.Value>
                {filters.result
                  ? t(filters.result === 'error' ? 'usage.result_failed' : 'usage.result_success')
                  : <span className="text-text-tertiary">{t('usage.result', 'Result')}</span>}
              </Select.Value>
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox items={resultOptions}>
                {(item) => (
                  <ListBox.Item id={item.id} textValue={item.label}>
                    {item.label}
                  </ListBox.Item>
                )}
              </ListBox>
            </Select.Popover>
          </Select>
        </div>
        {!customerScope && (
          <div className="w-full sm:w-48">
            <Select
              aria-label="API Key"
              fullWidth
              selectedKey={String(filters.api_key_id ?? '')}
              onSelectionChange={(key) => updateFilter('api_key_id', key == null ? '' : String(key))}
            >
              <Select.Trigger>
                <Select.Value>
                  {filters.api_key_id ? selectedApiKeyLabel : (
                    <span className="text-text-tertiary">API Key</span>
                  )}
                </Select.Value>
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox items={apiKeyOptions}>
                  {(item) => (
                    <ListBox.Item id={item.id} textValue={item.label}>
                      {item.label}
                    </ListBox.Item>
                  )}
                </ListBox>
              </Select.Popover>
            </Select>
          </div>
        )}
        {!customerScope && hasMembers && (
          <div className="w-full sm:w-44">
            <Select
              aria-label={t('team.filter_member')}
              fullWidth
              selectedKey={String(filters.member_id ?? '')}
              onSelectionChange={(key) => updateFilter('member_id', key == null ? '' : String(key))}
            >
              <Select.Trigger>
                <Select.Value>
                  {filters.member_id ? selectedMemberLabel : (
                    <span className="text-text-tertiary">{t('team.filter_member')}</span>
                  )}
                </Select.Value>
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox items={memberOptions}>
                  {(item) => (
                    <ListBox.Item id={item.id} textValue={item.label}>
                      {item.label}
                    </ListBox.Item>
                  )}
                </ListBox>
              </Select.Popover>
            </Select>
          </div>
        )}
        <div className="w-full sm:w-48">
          <UsageModelFilterInput
            ariaLabel={t('usage.model', 'Model')}
            placeholder={t('usage.model_placeholder')}
            value={filters.model ?? ''}
            onModelChange={handleModelChange}
          />
        </div>
        <Button
          isDisabled={exporting}
          size="md"
          variant="ghost"
          onPress={() => { void handleExport(); }}
        >
          <Download className="h-4 w-4" />
          {t('usage.export_csv')}
        </Button>
        <AutoRefreshControl
          value={autoRefresh}
          options={USER_AUTO_REFRESH_OPTIONS}
          label={autoRefreshLabel}
          offLabel={autoRefreshOffLabel}
          ariaLabel={t('usage.auto_update')}
          refreshAriaLabel={t('common.refresh', 'Refresh')}
          onChange={setAutoRefresh}
          onAutoRefresh={handleAutoRefresh}
          onRefresh={handleManualRefresh}
          isAutoRefreshing={isUsageTableRefreshing}
          isRefreshing={isRefreshing}
        />
      </div>

      {/* 使用记录表格 */}
      <UsageRecordsTable
        ariaLabel={t('usage.title', 'Usage')}
        columns={columns}
        dataVersion={dataUpdatedAt}
        emptyDescription={t('usage.empty_description', 'Adjust your filters and try again')}
        emptyTitle={t('common.no_data')}
        highlightNewRows={autoRefreshEnabled && page === 1}
        highlightResetKey={JSON.stringify({ ...filters, page, pageSize })}
        isLoading={isLoading}
        page={page}
        pageSize={pageSize}
        rows={list}
        setPage={setPage}
        setPageSize={setPageSize}
        suppressHighlight={isPlaceholderData}
        total={total}
      />
    </div>
  );
}
