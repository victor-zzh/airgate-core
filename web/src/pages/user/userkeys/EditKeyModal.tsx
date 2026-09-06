import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Description, Input, Label, ListBox, Select, Spinner, TextField as HeroTextField, useOverlayState } from '@heroui/react';
import { CommonDatePicker } from '../../../shared/components/CommonDatePicker';
import { CommonModal } from '../../../shared/components/CommonModal';
import type { KeyForm } from './types';

export interface KeyGroupOption {
  value: string;
  label: string;
  description?: string;
  suffix?: ReactNode;
}

export interface KeyMemberOption {
  value: string;
  label: string;
}

export function EditKeyModal({
  open,
  isEdit,
  form,
  setForm,
  groupOptions,
  memberOptions = [],
  onClose,
  onSubmit,
  loading,
}: {
  open: boolean;
  isEdit: boolean;
  form: KeyForm;
  setForm: (form: KeyForm) => void;
  groupOptions: KeyGroupOption[];
  /** 团队成员选项；为空时不渲染归属成员字段（普通用户看不到这一层） */
  memberOptions?: KeyMemberOption[];
  onClose: () => void;
  onSubmit: () => void;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const selectedGroup = groupOptions.find((option) => option.value === form.group_id);
  const groupItems = groupOptions.map((option) => ({
    id: option.value,
    label: (
      <div className="flex w-full min-w-0 items-center justify-between gap-6">
        <div className="min-w-0 flex-1">
          <div className="truncate">{option.label}</div>
          {option.description ? (
            <div className="mt-0.5 truncate pr-2 text-xs font-normal leading-5 text-text-tertiary">
              {option.description}
            </div>
          ) : null}
        </div>
        {option.suffix ? (
          <span className="ml-auto min-w-[9rem] shrink-0 text-right text-xs tabular-nums text-text-secondary">
            {option.suffix}
          </span>
        ) : null}
      </div>
    ),
    textValue: option.label,
  }));
  const selectedGroupLabel = selectedGroup ? (
    <div className="flex w-full min-w-0 items-center justify-between gap-6">
      <span className="truncate">{selectedGroup.label}</span>
      {selectedGroup.suffix ? (
        <span className="ml-auto min-w-[9rem] shrink-0 text-right text-xs tabular-nums text-text-secondary">
          {selectedGroup.suffix}
        </span>
      ) : null}
    </div>
  ) : t('user_keys.select_group');
  const modalState = useOverlayState({
    isOpen: open,
    onOpenChange: (nextOpen) => {
      if (!nextOpen) onClose();
    },
  });

  return (
    <CommonModal
      footer={(
        <div className="flex w-full justify-end gap-2">
          <Button variant="secondary" onPress={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            data-onboarding-target={!isEdit ? 'key-create-submit' : undefined}
            variant="primary"
            isDisabled={loading}
            onPress={onSubmit}
          >
            {loading ? <Spinner size="sm" /> : null}
            {isEdit ? t('common.save') : t('common.create')}
          </Button>
        </div>
      )}
      state={modalState}
      title={isEdit ? t('user_keys.edit') : t('user_keys.create')}
    >
      <div className="space-y-4">
        <HeroTextField fullWidth isRequired>
          <Label>{t('common.name')}</Label>
          <Input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder={t('user_keys.name_placeholder')}
            required
          />
        </HeroTextField>
        <Select
          fullWidth
          isRequired
          selectedKey={form.group_id || null}
          onSelectionChange={(key) => setForm({ ...form, group_id: key == null ? '' : String(key) })}
        >
          <Label>{t('user_keys.group')}</Label>
          <Select.Trigger data-onboarding-target={!isEdit ? 'key-create-group' : undefined}>
            <Select.Value>{selectedGroupLabel}</Select.Value>
            <Select.Indicator />
          </Select.Trigger>
          {/* 分组选项是两行文本 + 右侧「¥X/$1 约 N 折」价格后缀,内容天然很宽;
              Select.Popover 默认按内容自适应宽度,会撑得比弹窗还宽、左右溢出到对话框外。
              react-aria 的 Select 会在 Popover 上注入 --trigger-width(见
              react-aria-components/dist/private/Select.mjs),这里据此把弹层钉成
              与触发器同宽,长文案交给选项内部既有的 truncate 处理。 */}
          <Select.Popover className="w-[var(--trigger-width)]">
            <ListBox items={groupItems}>
              {(item) => (
                <ListBox.Item id={item.id} textValue={item.textValue}>
                  {item.label}
                </ListBox.Item>
              )}
            </ListBox>
          </Select.Popover>
        </Select>
        {selectedGroup?.description ? (
          <p className="-mt-2 truncate text-xs leading-5 text-text-tertiary" title={selectedGroup.description}>
            {selectedGroup.description}
          </p>
        ) : null}
        {memberOptions.length > 0 ? (
          <Select
            fullWidth
            selectedKey={form.member_id || ''}
            onSelectionChange={(key) => setForm({ ...form, member_id: key == null || key === '' ? '' : String(key) })}
          >
            <Label>{t('user_keys.member_label')}</Label>
            <Select.Trigger>
              <Select.Value>
                {memberOptions.find((option) => option.value === form.member_id)?.label ?? t('user_keys.member_none')}
              </Select.Value>
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover className="w-[var(--trigger-width)]">
              <ListBox items={[{ id: '', label: t('user_keys.member_none') }, ...memberOptions.map((option) => ({ id: option.value, label: option.label }))]}>
                {(item) => (
                  <ListBox.Item id={item.id} textValue={item.label}>
                    {item.label}
                  </ListBox.Item>
                )}
              </ListBox>
            </Select.Popover>
            <Description>{t('user_keys.member_hint')}</Description>
          </Select>
        ) : null}
        {/* 配额与并发并排,售价倍率单独一行:同一弹窗少滚一屏 */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <HeroTextField fullWidth>
            <Label>{t('user_keys.quota_label')}</Label>
            <Input
              type="number"
              value={form.quota_usd}
              onChange={(e) => setForm({ ...form, quota_usd: e.target.value })}
              placeholder={t('user_keys.quota_unlimited_hint')}
            />
            <Description>{t('user_keys.quota_hint')}</Description>
          </HeroTextField>
          <HeroTextField fullWidth>
            <Label>{t('user_keys.max_concurrency_label', 'Maximum concurrency')}</Label>
            <Input
              type="number"
              value={form.max_concurrency}
              onChange={(e) => setForm({ ...form, max_concurrency: e.target.value })}
              placeholder="0"
            />
            <Description>{t('user_keys.max_concurrency_hint', 'Leave blank or set to 0 for no limit')}</Description>
          </HeroTextField>
        </div>
        <HeroTextField fullWidth>
          <Label>{t('user_keys.sell_rate_label', 'Selling multiplier (customer price)')}</Label>
          <Input
            type="number"
            value={form.sell_rate}
            onChange={(e) => setForm({ ...form, sell_rate: e.target.value })}
            placeholder="0"
          />
          <Description>{t('user_keys.sell_rate_hint', 'Leave blank or set to 0 to bill at the platform list price')}</Description>
        </HeroTextField>
        <CommonDatePicker
          description={t('user_keys.expire_hint')}
          label={t('user_keys.expires_at')}
          value={form.expires_at}
          onChange={(value) => setForm({ ...form, expires_at: value })}
        />
      </div>
    </CommonModal>
  );
}
