import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Chip, EmptyState, Label, ListBox, Select, Tooltip, useOverlayState } from '@heroui/react';
import { CircleAlert, CircleCheck, CircleX, Clock3, Copy, Eye, LoaderCircle } from 'lucide-react';
import { generationTasksApi } from '../../shared/api/generationTasks';
import { queryKeys } from '../../shared/queryKeys';
import { usePagination } from '../../shared/hooks/usePagination';
import { ADMIN_AUTO_REFRESH_OPTIONS, usePersistentAutoRefresh } from '../../shared/hooks/usePersistentAutoRefresh';
import { AutoRefreshControl } from '../../shared/components/AutoRefreshControl';
import { CommonTable } from '../../shared/components/CommonTable';
import { CommonModal } from '../../shared/components/CommonModal';
import { TableLoadingRow } from '../../shared/components/TableLoadingRow';
import { TablePaginationFooter } from '../../shared/components/TablePaginationFooter';
import { StatusChip } from '../../shared/ui/display/StatusChip';
import { DEFAULT_PAGE_SIZE } from '../../shared/constants';
import { getTotalPages } from '../../shared/utils/pagination';
import { useClipboard } from '../../shared/hooks/useClipboard';
import type { GenerationTaskResp, GenerationTaskStatus } from '../../shared/types';
import {
  failureSourceLabelKey,
  generationTaskFailureSource,
  taskModelNotApplicable,
} from '../../shared/failureDiagnostics';

const AUTO_REFRESH_STORAGE_KEY = 'airgate.admin.generation_tasks.auto_refresh';

const TASK_STATUSES: GenerationTaskStatus[] = [
  'pending',
  'processing',
  'retrying',
  'failed',
  'completed',
  'cancelling',
  'cancelled',
];

const ACTIVE_STATUSES = new Set<GenerationTaskStatus>(['pending', 'processing', 'retrying', 'cancelling']);

function formatTime(value: string, locale: string) {
  return new Date(value).toLocaleString(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDuration(seconds: number) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  if (safeSeconds < 60) return `${safeSeconds}s`;
  const minutes = Math.floor(safeSeconds / 60);
  if (minutes < 60) return `${minutes}m ${safeSeconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function elapsedSeconds(from?: string, to?: string, now = Date.now()) {
  if (!from) return 0;
  const start = Date.parse(from);
  const end = to ? Date.parse(to) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return (end - start) / 1000;
}

export function hasUpstreamTiming(task: GenerationTaskResp) {
  return Boolean(
    task.upstream_created_at
    && (task.upstream_completed_at || ACTIVE_STATUSES.has(task.status)),
  );
}

export function generationDurationSeconds(task: GenerationTaskResp, now = Date.now()) {
  const upstream = hasUpstreamTiming(task);
  const from = upstream ? task.upstream_created_at : task.created_at;
  const to = upstream
    ? task.upstream_completed_at
    : task.completed_at || (ACTIVE_STATUSES.has(task.status) ? undefined : task.updated_at);
  return elapsedSeconds(from, to, now);
}

function taskTypeLabel(taskType: string, t: ReturnType<typeof useTranslation>['t']) {
  const key = `generation_tasks.type_${taskType.replace(/\./g, '_')}`;
  return t(key, { defaultValue: taskType });
}

function MetricCard({
  accent,
  detail,
  icon,
  label,
  value,
}: {
  accent: string;
  detail: ReactNode;
  icon: ReactNode;
  label: string;
  value: ReactNode;
}) {
  return (
    <Card className="ag-dashboard-metric min-h-[92px]">
      <Card.Content className="ag-dashboard-metric-content p-3.5">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-text-tertiary">{label}</div>
          <div className="mt-1 font-mono text-2xl font-semibold leading-none text-text">{value}</div>
          <div className="mt-2 truncate text-xs text-text-secondary">{detail}</div>
        </div>
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--field-radius)] ring-1"
          style={{
            background: `color-mix(in srgb, ${accent} 14%, transparent)`,
            borderColor: `color-mix(in srgb, ${accent} 24%, transparent)`,
            color: accent,
          }}
        >
          {icon}
        </div>
      </Card.Content>
    </Card>
  );
}

function TaskStatusCell({ task }: { task: GenerationTaskResp }) {
  const { t } = useTranslation();
  const active = ACTIVE_STATUSES.has(task.status);
  const determinate = active && task.progress > 0;
  return (
    <div className="flex min-w-[8.5rem] flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <StatusChip status={task.status} />
        {active ? <span className="font-mono text-[11px] text-text-tertiary">{task.progress}%</span> : null}
      </div>
      {active ? (
        <div
          aria-label={t('generation_tasks.progress_aria', { progress: task.progress })}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={determinate ? task.progress : undefined}
          className="h-1.5 w-28 overflow-hidden rounded-full bg-default-100"
          role="progressbar"
        >
          <span
            className={`block h-full rounded-full bg-accent ${determinate ? '' : 'w-1/3 animate-pulse'}`}
            style={determinate ? { width: `${Math.max(2, Math.min(100, task.progress))}%` } : undefined}
          />
        </div>
      ) : null}
      {task.stage ? <span className="max-w-36 truncate text-[11px] text-text-tertiary" title={task.stage}>{task.stage}</span> : null}
    </div>
  );
}

function TimingCell({ task }: { task: GenerationTaskResp }) {
  const { t } = useTranslation();
  const queueEnd = task.started_at || task.completed_at || (ACTIVE_STATUSES.has(task.status) ? undefined : task.updated_at);
  const queueSeconds = elapsedSeconds(task.created_at, queueEnd);
  const totalSeconds = generationDurationSeconds(task);
  const upstreamTiming = hasUpstreamTiming(task);
  return (
    <div className="flex min-w-0 flex-col gap-0.5 font-mono text-[11px] tabular-nums">
      <span title={t('generation_tasks.queue_time')}>{t('generation_tasks.queue_short')} {formatDuration(queueSeconds)}</span>
      <span
        className="text-text-tertiary"
        title={t(upstreamTiming ? 'generation_tasks.total_time_upstream' : 'generation_tasks.total_time_local')}
      >
        {t('generation_tasks.total_short')} {formatDuration(totalSeconds)}
      </span>
    </div>
  );
}

function ErrorCell({
  task,
  staleThresholdSeconds,
  onInspect,
}: {
  task: GenerationTaskResp;
  staleThresholdSeconds: number;
  onInspect: (task: GenerationTaskResp) => void;
}) {
  const { t } = useTranslation();
  const stale = task.status === 'processing' && elapsedSeconds(task.updated_at) >= staleThresholdSeconds;
  const source = generationTaskFailureSource(task);
  const sourceLabel = t(failureSourceLabelKey(source));
  const sourceClass = source === 'upstream'
    ? 'bg-danger-subtle text-danger'
    : source === 'scheduler' || source === 'quota'
      ? 'bg-warning-subtle text-warning'
      : 'bg-info-subtle text-info';
  const code = task.error_code?.trim();
  const message = task.error_message || (stale ? t('generation_tasks.stale_task') : '');
  const evidence = [
    task.account_id
      ? `${t('generation_tasks.account_id')} #${task.account_id}`
      : source === 'scheduler' ? t('usage.account_not_selected') : '',
    task.request_id ? `Req ${task.request_id}` : '',
    task.upstream_status ? `HTTP ${task.upstream_status}` : '',
  ].filter(Boolean);
  if (!message && !code && !task.error_type) {
    return <span className="text-text-tertiary">-</span>;
  }
  return (
    <div className="flex min-w-0 items-start gap-1.5">
      <div
        className="flex min-w-0 flex-1 flex-col gap-1"
        title={[sourceLabel, code, task.error_type, message, ...evidence].filter(Boolean).join('\n')}
      >
        <div className="flex min-w-0 items-center gap-1 overflow-hidden">
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none ${sourceClass}`}>
            {sourceLabel}
          </span>
          {code ? (
            <span className="min-w-0 truncate font-mono text-[11px] font-semibold leading-none text-danger">{code}</span>
          ) : null}
          {task.error_type && task.error_type !== code ? (
            <span className="min-w-0 truncate font-mono text-[10px] leading-none text-text-tertiary">{task.error_type}</span>
          ) : null}
        </div>
        {message ? <span className={`line-clamp-2 break-words text-xs leading-4 ${stale ? 'text-warning' : 'text-text'}`}>{message}</span> : null}
        {evidence.length > 0 ? (
          <span className="truncate font-mono text-[10px] leading-none text-text-tertiary">{evidence.join(' · ')}</span>
        ) : null}
      </div>
      <Tooltip>
        <Tooltip.Trigger>
          <Button
            isIconOnly
            aria-label={t('generation_tasks.inspect_error')}
            className="h-7 w-7 min-w-7 shrink-0"
            size="sm"
            variant="ghost"
            onPress={() => onInspect(task)}
          >
            <Eye className="h-3.5 w-3.5" />
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Content>{t('generation_tasks.inspect_error')}</Tooltip.Content>
      </Tooltip>
    </div>
  );
}

function TaskErrorModal({ task, onClose }: { task: GenerationTaskResp | null; onClose: () => void }) {
  const { t } = useTranslation();
  const copy = useClipboard();
  const modalState = useOverlayState({
    isOpen: task !== null,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
  });
  if (!task) return null;

  const message = task.error_message || t('generation_tasks.stale_task');
  const sourceLabel = t(failureSourceLabelKey(generationTaskFailureSource(task)));
  const modelLabel = taskModelNotApplicable(task)
    ? `${t('generation_tasks.asset_task')} / ${t('generation_tasks.model_not_applicable')}`
    : task.model || '-';
  const diagnostics = [
    { label: t('usage.error_source'), value: sourceLabel },
    { label: t('generation_tasks.request_id'), value: task.request_id || '-' },
    { label: t('generation_tasks.user'), value: `${task.user_email || '-'} (#${task.user_id})` },
    { label: t('generation_tasks.group_id'), value: task.group_id ? `#${task.group_id}` : '-' },
    { label: t('generation_tasks.api_key_id'), value: task.api_key_id ? `#${task.api_key_id}` : '-' },
    { label: t('generation_tasks.account_id'), value: task.account_id ? `#${task.account_id}` : '-' },
    { label: t('generation_tasks.plugin'), value: task.plugin_id || '-' },
    { label: t('generation_tasks.task_type'), value: task.task_type || '-' },
    { label: t('generation_tasks.model'), value: modelLabel },
    { label: t('generation_tasks.stage'), value: task.stage || '-' },
    { label: t('generation_tasks.upstream_status'), value: task.upstream_status || '-' },
    { label: t('generation_tasks.upstream_error_code'), value: task.upstream_error_code || '-' },
  ];
  const copyText = [
    `${t('generation_tasks.task')}: ${task.public_task_id || `#${task.id}`}`,
    ...diagnostics.map((item) => `${item.label}: ${item.value}`),
    `${t('generation_tasks.error_type')}: ${task.error_type || '-'}`,
    `${t('generation_tasks.error_code')}: ${task.error_code || '-'}`,
    `${t('generation_tasks.error_message')}: ${message}`,
  ].join('\n');

  return (
    <CommonModal
      icon={<CircleAlert className="h-5 w-5" />}
      iconClassName="bg-danger-subtle text-danger"
      size="lg"
      state={modalState}
      surface={false}
      title={t('generation_tasks.error_details')}
      description={task.public_task_id || `#${task.id}`}
      footer={(
        <div className="flex w-full justify-end gap-2">
          <Button
            variant="secondary"
            onPress={() => {
              void copy(copyText);
            }}
          >
            <Copy className="h-3.5 w-3.5" />
            {t('generation_tasks.copy_error')}
          </Button>
          <Button onPress={onClose}>{t('common.close')}</Button>
        </div>
      )}
    >
      <div className="space-y-4">
        <dl className="grid gap-3 sm:grid-cols-2">
          {diagnostics.map((item) => (
            <div className={`min-w-0 ${item.label === t('generation_tasks.request_id') ? 'sm:col-span-2' : ''}`} key={item.label}>
              <dt className="text-xs font-medium text-text-tertiary">{item.label}</dt>
              <dd className="mt-1 break-all font-mono text-sm text-text select-text">{item.value}</dd>
            </div>
          ))}
          <div className="min-w-0">
            <dt className="text-xs font-medium text-text-tertiary">{t('generation_tasks.error_type')}</dt>
            <dd className="mt-1 break-words font-mono text-sm text-text">{task.error_type || '-'}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs font-medium text-text-tertiary">{t('generation_tasks.error_code')}</dt>
            <dd className="mt-1 break-words font-mono text-sm text-text">{task.error_code || '-'}</dd>
          </div>
        </dl>
        <div>
          <div className="text-xs font-medium text-text-tertiary">{t('generation_tasks.error_message')}</div>
          <pre className="mt-2 max-h-[55vh] overflow-auto whitespace-pre-wrap break-words rounded-[var(--field-radius)] border border-danger/25 bg-danger-subtle p-3 font-mono text-sm leading-6 text-text select-text">
            {message}
          </pre>
        </div>
      </div>
    </CommonModal>
  );
}

export default function GenerationTasksPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { page, pageSize, setPage, setPageSize } = usePagination(DEFAULT_PAGE_SIZE, 'admin.generation_tasks');
  const [statusFilter, setStatusFilter] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [pluginFilter, setPluginFilter] = useState('');
  const [errorTask, setErrorTask] = useState<GenerationTaskResp | null>(null);
  const [autoRefresh, setAutoRefresh] = usePersistentAutoRefresh(
    AUTO_REFRESH_STORAGE_KEY,
    5,
    ADMIN_AUTO_REFRESH_OPTIONS,
  );

  const listQuery = useQuery({
    queryKey: queryKeys.generationTasks('list', page, pageSize, statusFilter, kindFilter, typeFilter, pluginFilter),
    queryFn: () => generationTasksApi.list({
      page,
      page_size: pageSize,
      status: statusFilter ? statusFilter as GenerationTaskStatus : undefined,
      kind: kindFilter || undefined,
      task_type: typeFilter || undefined,
      plugin_id: pluginFilter || undefined,
    }),
    meta: { globalLoading: false },
    placeholderData: keepPreviousData,
  });
  const summaryQuery = useQuery({
    queryKey: queryKeys.generationTasks('summary'),
    queryFn: generationTasksApi.summary,
    meta: { globalLoading: false },
  });

  const refreshTasks = useCallback(() => (
    queryClient.invalidateQueries({ queryKey: queryKeys.generationTasks() }, { cancelRefetch: false })
  ), [queryClient]);

  const summary = summaryQuery.data;
  const rows = listQuery.data?.list ?? [];
  const total = listQuery.data?.total ?? 0;
  const totalPages = getTotalPages(total, pageSize);
  const isFetching = listQuery.isFetching || summaryQuery.isFetching;
  const thresholdMinutes = Math.round((summary?.backlog_threshold_seconds ?? 300) / 60);
  const staleMinutes = Math.round((summary?.stale_threshold_seconds ?? 900) / 60);
  const oldestWait = summary?.oldest_queued_at ? formatDuration(elapsedSeconds(summary.oldest_queued_at)) : '-';

  const kindOptions = useMemo(() => [
    { id: '', label: t('generation_tasks.all_kinds') },
    { id: 'asset', label: t('generation_tasks.kind_asset') },
    { id: 'image', label: t('generation_tasks.kind_image') },
    { id: 'video', label: t('generation_tasks.kind_video') },
    { id: 'audio', label: t('generation_tasks.kind_audio') },
  ], [t]);
  const statusOptions = useMemo(() => [
    { id: '', label: t('generation_tasks.all_statuses') },
    ...TASK_STATUSES.map((status) => ({ id: status, label: t(`status.${status}`) })),
  ], [t]);
  const typeOptions = useMemo(() => [
    { id: '', label: t('generation_tasks.all_types') },
    ...(summary?.task_types ?? []).map((taskType) => ({ id: taskType, label: taskTypeLabel(taskType, t) })),
  ], [summary?.task_types, t]);
  const pluginOptions = useMemo(() => [
    { id: '', label: t('generation_tasks.all_plugins') },
    ...(summary?.plugins ?? []).map((plugin) => ({ id: plugin, label: plugin })),
  ], [summary?.plugins, t]);

  const filters = [
    { key: 'status', label: t('generation_tasks.status'), value: statusFilter, options: statusOptions, setValue: setStatusFilter },
    { key: 'kind', label: t('generation_tasks.kind'), value: kindFilter, options: kindOptions, setValue: setKindFilter },
    { key: 'type', label: t('generation_tasks.task_type'), value: typeFilter, options: typeOptions, setValue: setTypeFilter },
    { key: 'plugin', label: t('generation_tasks.plugin'), value: pluginFilter, options: pluginOptions, setValue: setPluginFilter },
  ];

  const healthy = (summary?.backlog ?? 0) === 0 && (summary?.stale_processing ?? 0) === 0;

  return (
    <div className="space-y-5">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <h1 className="ag-page-title ag-page-title--inline">{t('generation_tasks.title')}</h1>
        <Chip color={healthy ? 'success' : 'warning'} size="sm" variant="soft">
          {t(healthy ? 'generation_tasks.health_normal' : 'generation_tasks.health_attention')}
        </Chip>
      </div>

      <div className="ag-stats-grid grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          accent={healthy ? 'var(--ag-success)' : 'var(--ag-warning)'}
          detail={summary?.queued
            ? t('generation_tasks.queue_detail', { count: summary.backlog, duration: oldestWait, minutes: thresholdMinutes })
            : t('generation_tasks.queue_empty')}
          icon={<Clock3 className="h-5 w-5" />}
          label={t('generation_tasks.queued')}
          value={summary?.queued ?? '-'}
        />
        <MetricCard
          accent={(summary?.stale_processing ?? 0) > 0 ? 'var(--ag-warning)' : 'var(--ag-primary)'}
          detail={t('generation_tasks.stale_detail', { count: summary?.stale_processing ?? 0, minutes: staleMinutes })}
          icon={<LoaderCircle className="h-5 w-5" />}
          label={t('generation_tasks.processing')}
          value={summary?.processing ?? '-'}
        />
        <MetricCard
          accent="var(--ag-danger)"
          detail={t('generation_tasks.failure_rate', { rate: ((summary?.failure_rate_recent ?? 0) * 100).toFixed(1) })}
          icon={<CircleX className="h-5 w-5" />}
          label={t('generation_tasks.failed_recent')}
          value={summary?.failed_recent ?? '-'}
        />
        <MetricCard
          accent="var(--ag-success)"
          detail={t('generation_tasks.cancelled_recent_detail', { count: summary?.cancelled_recent ?? 0 })}
          icon={<CircleCheck className="h-5 w-5" />}
          label={t('generation_tasks.completed_recent')}
          value={summary?.completed_recent ?? '-'}
        />
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        {filters.map((filter) => (
          <div key={filter.key} className="w-full sm:w-44">
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
                  {(item) => <ListBox.Item id={item.id} textValue={item.label}>{item.label}</ListBox.Item>}
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
            onRefresh={refreshTasks}
            isRefreshing={isFetching}
          />
        </div>
      </div>

      <CommonTable
        ariaLabel={t('generation_tasks.title')}
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
        minWidth={1500}
      >
        <CommonTable.Header>
          <CommonTable.Column id="created_at" style={{ width: 150 }}>{t('generation_tasks.created_at')}</CommonTable.Column>
          <CommonTable.Column id="id" style={{ width: 205 }}>{t('generation_tasks.task')}</CommonTable.Column>
          <CommonTable.Column id="model" style={{ width: 210 }}>{t('generation_tasks.model_plugin')}</CommonTable.Column>
          <CommonTable.Column id="user" style={{ width: 210 }}>{t('generation_tasks.user')}</CommonTable.Column>
          <CommonTable.Column id="status" style={{ width: 160 }}>{t('generation_tasks.status')}</CommonTable.Column>
          <CommonTable.Column id="timing" style={{ width: 125 }}>{t('generation_tasks.timing')}</CommonTable.Column>
          <CommonTable.Column id="attempts" style={{ width: 82 }}>{t('generation_tasks.attempts')}</CommonTable.Column>
          <CommonTable.Column id="error" style={{ width: 380 }}>{t('generation_tasks.error')}</CommonTable.Column>
        </CommonTable.Header>
        <CommonTable.Body>
          {listQuery.isLoading ? (
            <TableLoadingRow colSpan={8} />
          ) : rows.length === 0 ? (
            <CommonTable.Row id="empty">
              <CommonTable.Cell colSpan={8}>
                <EmptyState>
                  <div className="text-sm text-default-500">{t('generation_tasks.empty')}</div>
                </EmptyState>
              </CommonTable.Cell>
            </CommonTable.Row>
          ) : rows.map((task) => (
            <CommonTable.Row id={task.id} key={task.id}>
              <CommonTable.Cell>
                <span className="whitespace-nowrap font-mono tabular-nums">{formatTime(task.created_at, i18n.language)}</span>
              </CommonTable.Cell>
              <CommonTable.Cell>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate font-mono font-medium text-text" title={task.public_task_id || String(task.id)}>
                    {task.public_task_id || `#${task.id}`}
                  </span>
                  <span className="truncate text-[11px] text-text-tertiary" title={task.task_type}>{taskTypeLabel(task.task_type, t)}</span>
                </div>
              </CommonTable.Cell>
              <CommonTable.Cell>
                {taskModelNotApplicable(task) ? (
                  <div
                    className="flex min-w-0 flex-col gap-0.5"
                    title={`${t('generation_tasks.asset_task')} / ${t('generation_tasks.model_not_applicable')}`}
                  >
                    <span className="truncate font-medium text-text">{t('generation_tasks.asset_task')}</span>
                    <span className="truncate text-[11px] text-text-tertiary">
                      {t('generation_tasks.model_not_applicable')} · {task.plugin_id}
                    </span>
                  </div>
                ) : (
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate font-mono text-text" title={task.model || undefined}>{task.model || '-'}</span>
                    <span className="truncate text-[11px] text-text-tertiary" title={task.plugin_id}>{task.plugin_id}</span>
                  </div>
                )}
              </CommonTable.Cell>
              <CommonTable.Cell>
                <div
                  className="flex min-w-0 flex-col gap-0.5"
                  title={[task.user_email || `#${task.user_id}`, task.group_id ? `Group #${task.group_id}` : '', task.api_key_id ? `API Key #${task.api_key_id}` : ''].filter(Boolean).join('\n')}
                >
                  <span className="truncate text-text">{task.user_email || `#${task.user_id}`}</span>
                  <span className="truncate font-mono text-[11px] text-text-tertiary">
                    {[
                      `U#${task.user_id}`,
                      task.group_id ? `G#${task.group_id}` : '',
                      task.api_key_id ? `K#${task.api_key_id}` : '',
                    ].filter(Boolean).join(' · ')}
                  </span>
                </div>
              </CommonTable.Cell>
              <CommonTable.Cell><TaskStatusCell task={task} /></CommonTable.Cell>
              <CommonTable.Cell><TimingCell task={task} /></CommonTable.Cell>
              <CommonTable.Cell>
                <span className={`font-mono ${task.attempts >= task.max_attempts ? 'text-danger' : 'text-text'}`}>
                  {task.attempts}/{task.max_attempts}
                </span>
              </CommonTable.Cell>
              <CommonTable.Cell className="max-w-0">
                <ErrorCell
                  task={task}
                  staleThresholdSeconds={summary?.stale_threshold_seconds ?? 900}
                  onInspect={setErrorTask}
                />
              </CommonTable.Cell>
            </CommonTable.Row>
          ))}
        </CommonTable.Body>
      </CommonTable>
      <TaskErrorModal task={errorTask} onClose={() => setErrorTask(null)} />
    </div>
  );
}
