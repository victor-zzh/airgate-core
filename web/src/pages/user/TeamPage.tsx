import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, AlertDialog, Button, Dropdown, EmptyState, Spinner } from '@heroui/react';
import { DialogTriggerShim } from '../../shared/components/DialogTriggerShim';
import { membersApi } from '../../shared/api/members';
import { usePagination } from '../../shared/hooks/usePagination';
import { useCrudMutation } from '../../shared/hooks/useCrudMutation';
import { useToast, StatusChip } from '../../shared/ui';
import { queryKeys } from '../../shared/queryKeys';
import { DEFAULT_PAGE_SIZE } from '../../shared/constants';
import { getTotalPages } from '../../shared/utils/pagination';
import { TablePaginationFooter } from '../../shared/components/TablePaginationFooter';
import { TableLoadingRow } from '../../shared/components/TableLoadingRow';
import { CommonTable } from '../../shared/components/CommonTable';
import {
  Ban,
  CheckCircle,
  Info,
  KeyRound,
  MoreHorizontal,
  Pencil,
  Plus,
  ReceiptText,
  RefreshCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import type { CreateMemberReq, MemberResp, UpdateMemberReq } from '../../shared/types';
import { EditMemberModal } from './team/EditMemberModal';
import { type MemberForm, emptyMemberForm } from './team/types';

// 团队成员（企业子账号）：企业主侧的花名册——给成员开登录账号（邮箱+密码）、分配额度与
// 可用分组、看本期用量、管理密钥、停用/删除。成员用自己的账号正常登录、功能与普通用户一致，
// 只是消耗从企业主余额扣、用量归属到成员。
export default function TeamPage() {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { page, setPage, pageSize, setPageSize } = usePagination(DEFAULT_PAGE_SIZE, 'user.team');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<MemberResp | null>(null);
  const [form, setForm] = useState<MemberForm>(emptyMemberForm);
  const [deleteTarget, setDeleteTarget] = useState<MemberResp | null>(null);
  const [resetTarget, setResetTarget] = useState<MemberResp | null>(null);

  const { data, isLoading, refetch } = useQuery({
    queryKey: queryKeys.members(page, pageSize),
    queryFn: () => membersApi.list({ page, page_size: pageSize }),
    placeholderData: keepPreviousData,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.members() });
    queryClient.invalidateQueries({ queryKey: queryKeys.membersForKeys() });
  };

  const createMutation = useCrudMutation<MemberResp, CreateMemberReq>({
    mutationFn: (payload) => membersApi.create(payload),
    successMessage: t('team.create_success'),
    queryKey: queryKeys.members(),
    onSuccess: () => {
      closeModal();
      invalidate();
    },
  });
  const updateMutation = useCrudMutation<MemberResp, { id: number; data: UpdateMemberReq }>({
    mutationFn: ({ id, data: payload }) => membersApi.update(id, payload),
    successMessage: t('team.update_success'),
    queryKey: queryKeys.members(),
    onSuccess: () => {
      closeModal();
      invalidate();
    },
  });
  const deleteMutation = useCrudMutation<unknown, number>({
    mutationFn: (id) => membersApi.delete(id),
    successMessage: t('team.delete_success'),
    queryKey: queryKeys.members(),
    onSuccess: () => {
      setDeleteTarget(null);
      invalidate();
      queryClient.invalidateQueries({ queryKey: queryKeys.userKeys() });
    },
  });
  const resetMutation = useCrudMutation<MemberResp, number>({
    mutationFn: (id) => membersApi.resetPeriod(id),
    successMessage: t('team.reset_success'),
    queryKey: queryKeys.members(),
    onSuccess: () => setResetTarget(null),
  });
  const toggleStatusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: 'active' | 'disabled' }) =>
      membersApi.update(id, { status }),
    onSuccess: (_resp, variables) => {
      toast('success', variables.status === 'active' ? t('team.enable_success') : t('team.disable_success'));
      invalidate();
    },
    onError: (err: Error) => toast('error', err.message),
  });

  function openCreate() {
    setEditing(null);
    setForm(emptyMemberForm);
    setModalOpen(true);
  }

  function openEdit(member: MemberResp) {
    setEditing(member);
    setForm({
      name: member.name,
      email: member.email,
      password: '',
      note: member.note,
      quota_usd: member.quota_usd > 0 ? String(member.quota_usd) : '',
      quota_period: member.quota_period,
      allowed_group_ids: member.allowed_group_ids ?? [],
    });
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditing(null);
    setForm(emptyMemberForm);
  }

  function handleSubmit() {
    const name = form.name.trim();
    if (!name) {
      toast('error', t('team.name_placeholder'));
      return;
    }
    const email = form.email.trim();
    const password = form.password;
    const quota = form.quota_usd.trim() ? Number(form.quota_usd) : 0;
    if (!Number.isFinite(quota) || quota < 0) {
      toast('error', t('team.quota_hint'));
      return;
    }
    // 新建成员 = 开登录账号：邮箱与密码必填；编辑时密码留空表示不改。
    // 有登录账号的成员额度必填(成员控制台的"余额"就是本期剩余额度,0 = 不限没有意义);
    // 老模型无账号成员(has_account === false)沿用 0 = 不限。
    if (!editing || editing.has_account) {
      if (!email) {
        toast('error', t('team.email_required'));
        return;
      }
      if (quota <= 0) {
        toast('error', t('team.quota_required'));
        return;
      }
    }
    if (!editing && password.length < 6) {
      toast('error', t('team.password_hint'));
      return;
    }
    if (editing && password && password.length < 6) {
      toast('error', t('team.password_hint'));
      return;
    }
    if (editing) {
      updateMutation.mutate({
        id: editing.id,
        data: {
          name,
          email,
          ...(password ? { password } : {}),
          note: form.note.trim(),
          quota_usd: quota,
          quota_period: form.quota_period,
          allowed_group_ids: form.allowed_group_ids,
        },
      });
    } else {
      createMutation.mutate({
        name,
        email,
        password,
        note: form.note.trim(),
        quota_usd: quota,
        quota_period: form.quota_period,
        allowed_group_ids: form.allowed_group_ids,
      });
    }
  }

  const saving = createMutation.isPending || updateMutation.isPending;
  const rows = data?.list ?? [];
  const total = data?.total ?? 0;
  const totalPages = getTotalPages(total, pageSize);
  const formatDate = (value?: string) => (value ? new Date(value).toLocaleDateString(i18n.language) : '');

  return (
    <div className="p-6">
      <Alert className="mb-5" status="accent">
        <Alert.Indicator>
          <Info className="h-4 w-4" />
        </Alert.Indicator>
        <Alert.Content>
          <Alert.Description>
            {t('team.description')}
            {' '}
            {t('team.login_hint')}
          </Alert.Description>
        </Alert.Content>
      </Alert>

      <div className="mb-5 flex justify-end">
        <div className="ml-auto flex items-center gap-2">
          <Button
            isIconOnly
            aria-label={t('common.refresh', 'Refresh')}
            size="md"
            variant="ghost"
            onPress={() => refetch()}
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          <Button variant="primary" onPress={openCreate}>
            <Plus className="h-4 w-4" />
            {t('team.create')}
          </Button>
        </div>
      </div>

      <CommonTable
        ariaLabel={t('team.title')}
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
          <CommonTable.Column id="name">{t('team.name')}</CommonTable.Column>
          <CommonTable.Column id="status">{t('common.status')}</CommonTable.Column>
          <CommonTable.Column id="account" style={{ width: '7rem' }}>{t('team.account_col', '登录账号')}</CommonTable.Column>
          <CommonTable.Column id="quota" style={{ width: '15rem' }}>{t('team.quota_label')}</CommonTable.Column>
          <CommonTable.Column id="period" style={{ width: '9rem' }}>{t('team.period_col', '周期')}</CommonTable.Column>
          <CommonTable.Column id="groups" style={{ width: '8rem' }}>{t('team.groups')}</CommonTable.Column>
          <CommonTable.Column id="usage" style={{ width: '11.5rem' }}>{t('api_keys.usage')}</CommonTable.Column>
          <CommonTable.Column id="keys" style={{ width: '9rem' }}>{t('team.keys')}</CommonTable.Column>
          <CommonTable.Column id="actions" style={{ width: 132 }}>{t('common.actions')}</CommonTable.Column>
        </CommonTable.Header>
        <CommonTable.Body>
          {isLoading ? (
            <TableLoadingRow colSpan={9} />
          ) : rows.length === 0 ? (
            <CommonTable.Row id="empty">
              <CommonTable.Cell colSpan={9}>
                <EmptyState>
                  <div className="text-sm text-default-500">{t('team.empty_hint')}</div>
                </EmptyState>
              </CommonTable.Cell>
            </CommonTable.Row>
          ) : (
            rows.map((row) => {
              const unlimited = row.quota_usd <= 0;
              const pct = unlimited ? 0 : Math.min((row.period_used / row.quota_usd) * 100, 100);
              return (
                <CommonTable.Row id={String(row.id)} key={row.id}>
                  <CommonTable.Cell>
                    <div className="min-w-0">
                      <div className="truncate font-medium text-text">{row.name}</div>
                      {row.email ? (
                        <div className="truncate text-xs text-text-tertiary" title={row.email}>{row.email}</div>
                      ) : null}
                      {row.note ? (
                        <div className="truncate text-xs text-text-tertiary" title={row.note}>{row.note}</div>
                      ) : null}
                    </div>
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    <StatusChip status={row.status} />
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    {row.has_account ? (
                      <span className="text-xs text-text-secondary">{t('team.account_opened', '已开通')}</span>
                    ) : (
                      <span className="text-xs text-warning" title={t('team.no_account_hint')}>{t('team.no_account')}</span>
                    )}
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    {/* 额度:一行「已用 / 总额」+ 细进度条 + 周期说明,替代两枚彩色徽记 */}
                    <div className="ag-quota-cell">
                      <div className="ag-quota-cell-line">
                        <b>${row.period_used.toFixed(2)}</b>
                        <span>/ {unlimited ? '∞' : `$${row.quota_usd.toFixed(2)}`}</span>
                      </div>
                      {!unlimited ? (
                        <div className="ag-quota-bar" aria-hidden="true">
                          <i data-tone={pct >= 90 ? 'danger' : pct >= 70 ? 'warning' : undefined} style={{ width: `${pct}%` }} />
                        </div>
                      ) : null}
                    </div>
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    <span className="text-xs text-text-secondary">
                      {row.quota_period === 'monthly'
                        ? t('team.period_ends', { date: formatDate(row.period_end) })
                        : t('team.period_none')}
                    </span>
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    <span className="text-sm text-text-secondary">
                      {row.allowed_group_ids.length > 0
                        ? t('team.groups_count', { count: row.allowed_group_ids.length })
                        : t('team.groups_all')}
                    </span>
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    {/* 用量:一行三段,零值弱化;累计取 used_quota_actual(主账号实付,与今日 / 30 天同基准),
                        与额度列的「本期已用」(账面口径,受 sell_rate 影响)刻意不混 */}
                    <span className="ag-usage-line">
                      <span>{t('team.usage_today')}</span><b data-zero={row.today_cost === 0}>${row.today_cost.toFixed(2)}</b>
                      <span>{t('team.usage_30d')}</span><b data-zero={row.thirty_day_cost === 0}>${row.thirty_day_cost.toFixed(2)}</b>
                      <span>{t('team.cumulative')}</span><b data-zero={row.used_quota_actual === 0}>${row.used_quota_actual.toFixed(2)}</b>
                    </span>
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    <Button
                      size="sm"
                      variant="ghost"
                      onPress={() => navigate({ to: '/keys', search: { member_id: row.id } })}
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                      {t('team.keys_count', { count: row.key_count })}
                    </Button>
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    <div className="flex items-center gap-1">
                      <Button isIconOnly aria-label={t('team.edit')} size="sm" variant="ghost" onPress={() => openEdit(row)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        isIconOnly
                        aria-label={t('team.view_usage')}
                        size="sm"
                        variant="ghost"
                        onPress={() => navigate({ to: '/usage', search: { member_id: row.id } })}
                      >
                        <ReceiptText className="h-4 w-4" />
                      </Button>
                      <Dropdown>
                        <Button isIconOnly aria-label={t('common.more')} size="sm" variant="ghost">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                        <Dropdown.Popover placement="bottom end">
                          <Dropdown.Menu
                            aria-label={t('common.actions')}
                            onAction={(key) => {
                              if (key === 'reset') setResetTarget(row);
                              else if (key === 'toggle') toggleStatusMutation.mutate({ id: row.id, status: row.status === 'active' ? 'disabled' : 'active' });
                              else if (key === 'delete') setDeleteTarget(row);
                            }}
                          >
                            <Dropdown.Item id="reset" textValue={t('team.reset_period')}>
                              <span className="flex items-center gap-2">
                                <RotateCcw className="w-3.5 h-3.5" />
                                {t('team.reset_period')}
                              </span>
                            </Dropdown.Item>
                            <Dropdown.Item id="toggle" textValue={row.status === 'active' ? t('common.disable') : t('common.enable')}>
                              <span className="flex items-center gap-2">
                                {row.status === 'active' ? <Ban className="w-3.5 h-3.5" /> : <CheckCircle className="w-3.5 h-3.5" />}
                                {row.status === 'active' ? t('common.disable') : t('common.enable')}
                              </span>
                            </Dropdown.Item>
                            <Dropdown.Item id="delete" className="text-danger" textValue={t('team.delete_member')}>
                              <span className="flex items-center gap-2">
                                <Trash2 className="w-3.5 h-3.5" />
                                {t('team.delete_member')}
                              </span>
                            </Dropdown.Item>
                          </Dropdown.Menu>
                        </Dropdown.Popover>
                      </Dropdown>
                    </div>
                  </CommonTable.Cell>
                </CommonTable.Row>
              );
            })
          )}
        </CommonTable.Body>
      </CommonTable>

      <EditMemberModal
        open={modalOpen}
        isEdit={!!editing}
        hasAccount={!!editing?.has_account}
        form={form}
        setForm={setForm}
        onClose={closeModal}
        onSubmit={handleSubmit}
        loading={saving}
      />

      {/* 重置本期确认 */}
      <AlertDialog
        isOpen={!!resetTarget}
        onOpenChange={(open) => {
          if (!open) setResetTarget(null);
        }}
      >
        <DialogTriggerShim />
        <AlertDialog.Backdrop>
          <AlertDialog.Container placement="center" size="sm">
            <AlertDialog.Dialog className="ag-elevation-modal">
              <AlertDialog.Header>
                <AlertDialog.Icon status="warning" />
                <AlertDialog.Heading>{t('team.reset_period')}</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>{t('team.reset_confirm', { name: resetTarget?.name })}</AlertDialog.Body>
              <AlertDialog.Footer>
                <Button variant="secondary" onPress={() => setResetTarget(null)}>
                  {t('common.cancel')}
                </Button>
                <Button
                  aria-busy={resetMutation.isPending}
                  isDisabled={resetMutation.isPending}
                  variant="primary"
                  onPress={() => resetTarget && resetMutation.mutate(resetTarget.id)}
                >
                  {resetMutation.isPending ? <Spinner size="sm" /> : null}
                  {t('common.confirm')}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>

      {/* 删除确认 */}
      <AlertDialog
        isOpen={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <DialogTriggerShim />
        <AlertDialog.Backdrop>
          <AlertDialog.Container placement="center" size="sm">
            <AlertDialog.Dialog className="ag-elevation-modal">
              <AlertDialog.Header>
                <AlertDialog.Icon status="danger" />
                <AlertDialog.Heading>{t('team.delete_member')}</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>{t('team.delete_confirm', { name: deleteTarget?.name })}</AlertDialog.Body>
              <AlertDialog.Footer>
                <Button variant="secondary" onPress={() => setDeleteTarget(null)}>
                  {t('common.cancel')}
                </Button>
                <Button
                  aria-busy={deleteMutation.isPending}
                  isDisabled={deleteMutation.isPending}
                  variant="danger"
                  onPress={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
                >
                  {deleteMutation.isPending ? <Spinner size="sm" /> : null}
                  {t('common.confirm')}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    </div>
  );
}
