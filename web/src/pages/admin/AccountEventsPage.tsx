import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearch } from '@tanstack/react-router';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Chip, EmptyState, Label, ListBox, Select } from '@heroui/react';
import { PlatformIcon } from '../../shared/ui';
import { accountEventsApi } from '../../shared/api/accountEvents';
import { groupsApi } from '../../shared/api/groups';
import { usePlatforms } from '../../shared/hooks/usePlatforms';
import { usePagination } from '../../shared/hooks/usePagination';
import { ADMIN_AUTO_REFRESH_OPTIONS, usePersistentAutoRefresh } from '../../shared/hooks/usePersistentAutoRefresh';
import { queryKeys } from '../../shared/queryKeys';
import { DEFAULT_PAGE_SIZE, FETCH_ALL_PARAMS } from '../../shared/constants';
import { getTotalPages } from '../../shared/utils/pagination';
import { TablePaginationFooter } from '../../shared/components/TablePaginationFooter';
import { TableLoadingRow } from '../../shared/components/TableLoadingRow';
import { CommonTable } from '../../shared/components/CommonTable';
import { AutoRefreshControl } from '../../shared/components/AutoRefreshControl';
import type { AccountEventResp, AccountEventType } from '../../shared/types';

const EVENTS_AUTO_REFRESH_STORAGE_KEY = 'airgate.admin.account_events.auto_refresh';

type ChipColor = 'default' | 'warning' | 'success' | 'accent' | 'danger';

// 事件类型 → 展示样式。disabled 类是需要人工介入的红色；限流/降级/上游异常是
// 关注级的黄色；恢复类为绿色。
const EVENT_TYPE_META: Record<AccountEventType, { labelKey: string; color: ChipColor }> = {
  rate_limited: { labelKey: 'account_events.type_rate_limited', color: 'warning' },
  degraded: { labelKey: 'account_events.type_degraded', color: 'warning' },
  disabled: { labelKey: 'account_events.type_disabled', color: 'danger' },
  recovered: { labelKey: 'account_events.type_recovered', color: 'success' },
  upstream_error: { labelKey: 'account_events.type_upstream_error', color: 'warning' },
  manual_disabled: { labelKey: 'account_events.type_manual_disabled', color: 'default' },
  manual_recovered: { labelKey: 'account_events.type_manual_recovered', color: 'success' },
};

const EVENT_TYPE_FILTERS: AccountEventType[] = [
  'disabled',
  'rate_limited',
  'upstream_error',
  'degraded',
  'manual_disabled',
  'recovered',
  'manual_recovered',
];

/** 事件时间戳精确到秒（监控场景下分钟粒度不够定位问题）。 */
function formatEventTime(date: string): string {
  return new Date(date).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function EventTypeChip({ eventType }: { eventType: AccountEventType }) {
  const { t } = useTranslation();
  const meta = EVENT_TYPE_META[eventType] ?? { labelKey: eventType, color: 'default' };
  return (
    <Chip color={meta.color} size="sm" variant="soft">
      {t(meta.labelKey, eventType)}
    </Chip>
  );
}

// TriggeredByCell 触发本次事件的终端用户（邮箱 + 所用密钥名）。
// 探测/手动事件没有用户上下文显示 "-"；用户已删除时回退显示 #ID。
function TriggeredByCell({ row }: { row: AccountEventResp }) {
  if (!row.user_id && !row.api_key_id) {
    return <span style={{ color: 'var(--ag-text-tertiary)' }}>-</span>;
  }
  const who = row.user_email || (row.user_id ? `#${row.user_id}` : '');
  const key = row.api_key_name || (row.api_key_id ? `key #${row.api_key_id}` : '');
  return (
    <div className="flex min-w-0 flex-col" title={[who, key].filter(Boolean).join(' · ')}>
      <span className="truncate" style={{ color: 'var(--ag-text)' }}>{who || '-'}</span>
      {key ? (
        <span className="truncate text-[11px]" style={{ color: 'var(--ag-text-tertiary)' }}>{key}</span>
      ) : null}
    </div>
  );
}

function ReasonCell({ row }: { row: AccountEventResp }) {
  const reason = row.reason?.trim() ?? '';
  if (!reason && !row.family) {
    return <span style={{ color: 'var(--ag-text-tertiary)' }}>-</span>;
  }
  return (
    <div className="flex min-w-0 items-center gap-1.5" title={reason || undefined}>
      {row.family ? (
        <Chip color="default" size="sm" variant="soft" className="shrink-0">
          {row.family}
        </Chip>
      ) : null}
      <span className="truncate" style={{ color: 'var(--ag-text)' }}>{reason}</span>
    </div>
  );
}

export default function AccountEventsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { platforms, platformName } = usePlatforms();

  // 分组页"异常"数下钻会带 ?group_id=X 预置分组筛选。
  const search = useSearch({ strict: false });
  const searchGroupID = search.group_id;
  const { page, setPage, pageSize, setPageSize } = usePagination(DEFAULT_PAGE_SIZE, 'admin.account_events');
  const [platformFilter, setPlatformFilter] = useState('');
  const [groupFilter, setGroupFilter] = useState(() => (searchGroupID != null ? String(searchGroupID) : ''));
  const [typeFilter, setTypeFilter] = useState('');

  // 同路由下 URL 变化不会重挂组件（如已在本页时点侧边栏/再次下钻），
  // 惰性初始化只跑一次，须显式跟随 search 同步分组筛选。
  useEffect(() => {
    setGroupFilter(searchGroupID != null ? String(searchGroupID) : '');
    setPage(1);
  }, [searchGroupID, setPage]);

  // 监控页默认 15s 自动刷新，做到"准实时"。
  const [autoRefresh, setAutoRefresh] = usePersistentAutoRefresh(EVENTS_AUTO_REFRESH_STORAGE_KEY, 15, ADMIN_AUTO_REFRESH_OPTIONS);
  const refreshEvents = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: queryKeys.accountEvents() }, { cancelRefetch: false });
  }, [queryClient]);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: queryKeys.accountEvents(page, pageSize, platformFilter, groupFilter, typeFilter),
    queryFn: () =>
      accountEventsApi.list({
        page,
        page_size: pageSize,
        platform: platformFilter || undefined,
        group_id: groupFilter ? Number(groupFilter) : undefined,
        event_type: typeFilter || undefined,
      }),
    meta: { globalLoading: false },
    placeholderData: keepPreviousData,
  });

  const { data: allGroupsData } = useQuery({
    queryKey: queryKeys.groupsAll(),
    queryFn: () => groupsApi.list(FETCH_ALL_PARAMS),
  });

  const rows = data?.list ?? [];
  const total = data?.total ?? 0;
  const totalPages = getTotalPages(total, pageSize);

  const platformOptions = useMemo(() => [
    { id: '', label: t('accounts.all_platforms') },
    ...platforms.map((p) => ({ id: p, label: platformName(p) })),
  ], [platformName, platforms, t]);
  const groupOptions = useMemo(() => [
    { id: '', label: t('accounts.all_groups') },
    ...(allGroupsData?.list ?? []).map((g) => ({ id: String(g.id), label: g.name })),
  ], [allGroupsData?.list, t]);
  const typeOptions = useMemo(() => [
    { id: '', label: t('account_events.all_types') },
    ...EVENT_TYPE_FILTERS.map((type) => ({ id: type, label: t(EVENT_TYPE_META[type].labelKey, type) })),
  ], [t]);

  const sourceLabel = (source?: string) => {
    switch (source) {
      case 'forward':
        return t('account_events.source_forward');
      case 'probe':
        return t('account_events.source_probe');
      case 'manual':
        return t('account_events.source_manual');
      default:
        return source || '-';
    }
  };

  const filters = [
    { key: 'platform', label: t('groups.platform'), value: platformFilter, options: platformOptions, setValue: setPlatformFilter },
    { key: 'group', label: t('accounts.group'), value: groupFilter, options: groupOptions, setValue: setGroupFilter },
    { key: 'type', label: t('account_events.event'), value: typeFilter, options: typeOptions, setValue: setTypeFilter },
  ];

  return (
    <div>
      {/* 筛选 + 自动刷新 */}
      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        {filters.map((filter) => (
          <div key={filter.key} className="w-full sm:w-48">
            <Select
              aria-label={filter.label}
              fullWidth
              selectedKey={filter.value}
              onSelectionChange={(key) => {
                filter.setValue(key == null ? '' : String(key));
                setPage(1);
              }}
            >
              <Label className="sr-only">{filter.label}</Label>
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
        <div className="flex items-center gap-2 sm:ml-auto">
          <AutoRefreshControl
            value={autoRefresh}
            options={ADMIN_AUTO_REFRESH_OPTIONS}
            label={t('accounts.auto_refresh')}
            offLabel={t('accounts.auto_refresh_off')}
            ariaLabel={t('accounts.auto_refresh')}
            refreshAriaLabel={t('common.refresh')}
            onChange={setAutoRefresh}
            onRefresh={refreshEvents}
            isRefreshing={isFetching}
          />
        </div>
      </div>

      {/* 事件表格 */}
      <CommonTable
        ariaLabel={t('account_events.title')}
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
        minWidth={960}
      >
        <CommonTable.Header>
          <CommonTable.Column id="time" style={{ width: 148 }}>{t('account_events.time')}</CommonTable.Column>
          <CommonTable.Column id="account" style={{ width: 200 }}>{t('account_events.account')}</CommonTable.Column>
          <CommonTable.Column id="event" style={{ width: 96 }}>{t('account_events.event')}</CommonTable.Column>
          <CommonTable.Column id="reason">{t('account_events.reason')}</CommonTable.Column>
          <CommonTable.Column id="upstream_status" style={{ width: 88 }}>{t('account_events.upstream_status')}</CommonTable.Column>
          <CommonTable.Column id="source" style={{ width: 72 }}>{t('account_events.source')}</CommonTable.Column>
          <CommonTable.Column id="triggered_by" style={{ width: 180 }}>{t('account_events.triggered_by')}</CommonTable.Column>
          <CommonTable.Column id="until" style={{ width: 148 }}>{t('account_events.cooldown_until')}</CommonTable.Column>
        </CommonTable.Header>
        <CommonTable.Body>
          {isLoading ? (
            <TableLoadingRow colSpan={8} />
          ) : rows.length === 0 ? (
            <CommonTable.Row id="empty">
              <CommonTable.Cell colSpan={8}>
                <EmptyState>
                  <div className="text-sm text-default-500">{t('account_events.empty')}</div>
                </EmptyState>
              </CommonTable.Cell>
            </CommonTable.Row>
          ) : (
            rows.map((row) => (
              <CommonTable.Row id={String(row.id)} key={row.id}>
                <CommonTable.Cell>
                  <span className="font-mono tabular-nums whitespace-nowrap">{formatEventTime(row.created_at)}</span>
                </CommonTable.Cell>
                <CommonTable.Cell>
                  <span className="inline-flex max-w-[11.5rem] items-center gap-1.5">
                    <PlatformIcon platform={row.platform} className="h-3.5 w-3.5 shrink-0" />
                    <span className="ag-cell-2line font-medium" style={{ color: 'var(--ag-text)' }} title={row.account_name}>
                      {row.account_name}
                    </span>
                  </span>
                </CommonTable.Cell>
                <CommonTable.Cell>
                  <EventTypeChip eventType={row.event_type} />
                </CommonTable.Cell>
                <CommonTable.Cell className="max-w-0">
                  <ReasonCell row={row} />
                </CommonTable.Cell>
                <CommonTable.Cell>
                  {row.upstream_status ? (
                    <span className="font-mono" style={{ color: row.upstream_status >= 500 ? 'var(--ag-warning)' : 'var(--ag-danger)' }}>
                      {row.upstream_status}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--ag-text-tertiary)' }}>-</span>
                  )}
                </CommonTable.Cell>
                <CommonTable.Cell>{sourceLabel(row.source)}</CommonTable.Cell>
                <CommonTable.Cell>
                  <TriggeredByCell row={row} />
                </CommonTable.Cell>
                <CommonTable.Cell>
                  {row.state_until ? (
                    <span className="font-mono tabular-nums whitespace-nowrap">{formatEventTime(row.state_until)}</span>
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
  );
}
