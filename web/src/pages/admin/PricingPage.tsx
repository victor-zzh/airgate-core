import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Chip, EmptyState } from '@heroui/react';
import { ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react';
import { pricingApi, type PricingGroup } from '../../shared/api/pricing';
import { settingsApi } from '../../shared/api/settings';
import { queryKeys } from '../../shared/queryKeys';
import { parseQuoteFx, zheOfRate } from '../../shared/quoteMath';
import { CommonTable } from '../../shared/components/CommonTable';
import { TableLoadingRow } from '../../shared/components/TableLoadingRow';

// 毛利率 = (卖价倍率 − 成本倍率) / 卖价倍率。两者同为「每官方 $1 扣 ¥」口径，可直接相减。
function marginPct(sell: number, cost: number): number | null {
  if (!(sell > 0) || !(cost > 0)) return null;
  return ((sell - cost) / sell) * 100;
}

function fmtZhe(rate: number, fx: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  const z = zheOfRate(rate, fx);
  return z > 0 ? t('pricing.discount_label', { zhe: z, pct: Math.round(z * 10) }) : '—';
}

export default function PricingPage() {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.pricingOverview(),
    queryFn: pricingApi.overview,
  });
  const { data: publicSettings } = useQuery({
    queryKey: queryKeys.siteSettings(),
    queryFn: settingsApi.getPublic,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const fx = useMemo(() => parseQuoteFx(publicSettings?.toc_landing_pricing), [publicSettings?.toc_landing_pricing]);

  const groups = useMemo(() => {
    const list = data?.groups ?? [];
    // 有异常的排最前，其次按专属客户数降序——让需要处理的先被看到。
    return [...list].sort((a, b) => {
      const score = (g: PricingGroup) => {
        const loss = g.cost_multiplier > 0 && g.rate_multiplier > 0 && g.rate_multiplier < g.cost_multiplier ? 2 : 0;
        const inverted = (g.overrides ?? []).some((o) => g.rate_multiplier > 0 && o.rate > g.rate_multiplier) ? 1 : 0;
        return loss + inverted;
      };
      const diff = score(b) - score(a);
      if (diff !== 0) return diff;
      return (b.overrides?.length ?? 0) - (a.overrides?.length ?? 0);
    });
  }, [data?.groups]);

  const toggle = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="ag-page-title ag-page-title--inline">{t('pricing.title', '价格管理')}</h1>
        <p className="mt-1 text-sm text-text-secondary">
          {t('pricing.subtitle', '每个分组的标准价、成本与毛利，以及享受专属价的客户。折 = 倍率 ÷ 汇率，全站统一口径。')}
        </p>
      </div>

      <CommonTable ariaLabel={t('pricing.title', '价格管理')} minWidth={1040}>
        <CommonTable.Header>
          <CommonTable.Column id="expand" style={{ width: 40 }}>{' '}</CommonTable.Column>
          <CommonTable.Column id="name">{t('pricing.col_group', '分组')}</CommonTable.Column>
          <CommonTable.Column id="platform" style={{ width: 110 }}>{t('pricing.col_platform', '平台')}</CommonTable.Column>
          <CommonTable.Column id="models" style={{ width: 80 }}>{t('pricing.col_models', '模型数')}</CommonTable.Column>
          <CommonTable.Column id="sell" style={{ width: 110 }}>{t('pricing.col_standard', '标准价')}</CommonTable.Column>
          <CommonTable.Column id="cost" style={{ width: 150 }}>{t('pricing.col_cost', '成本')}</CommonTable.Column>
          <CommonTable.Column id="margin" style={{ width: 100 }}>{t('pricing.col_margin', '毛利')}</CommonTable.Column>
          <CommonTable.Column id="overrides" style={{ width: 120 }}>{t('pricing.col_overrides', '专属客户')}</CommonTable.Column>
          <CommonTable.Column id="status" style={{ width: 110 }}>{t('common.status', '状态')}</CommonTable.Column>
        </CommonTable.Header>
        <CommonTable.Body>
          {isLoading ? (
            <TableLoadingRow colSpan={9} />
          ) : groups.length === 0 ? (
            <CommonTable.Row id="empty">
              <CommonTable.Cell colSpan={9}>
                <EmptyState>
                  <div className="text-sm text-default-500">{t('common.no_data', '暂无数据')}</div>
                </EmptyState>
              </CommonTable.Cell>
            </CommonTable.Row>
          ) : (
            groups.flatMap((g) => {
              const margin = marginPct(g.rate_multiplier, g.cost_multiplier);
              const isLoss = margin !== null && margin < 0;
              const overrides = g.overrides ?? [];
              const inverted = overrides.filter((o) => g.rate_multiplier > 0 && o.rate > g.rate_multiplier);
              const isOpen = expanded.has(g.id);

              const rows = [
                <CommonTable.Row id={`g-${g.id}`} key={`g-${g.id}`}>
                  <CommonTable.Cell>
                    {overrides.length > 0 ? (
                      <button
                        aria-label={isOpen ? t('common.collapse', '收起') : t('common.expand', '展开')}
                        className="text-text-tertiary hover:text-text"
                        onClick={() => toggle(g.id)}
                        type="button"
                      >
                        {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </button>
                    ) : null}
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    <span className="text-text">{g.name}</span>
                    <span className="ml-2 font-mono text-xs text-text-tertiary">#{g.id}</span>
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    <span className="text-xs text-text-secondary">{g.platform}</span>
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    <span className="font-mono text-xs text-text-secondary">
                      {g.model_count > 0 ? g.model_count : t('pricing.models_unrestricted', '不限')}
                    </span>
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    <span className="font-mono">{fmtZhe(g.rate_multiplier, fx, t)}</span>
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    {g.cost_multiplier > 0 ? (
                      <div className="flex flex-col">
                        <span className="font-mono">{fmtZhe(g.cost_multiplier, fx, t)}</span>
                        <span className="truncate text-xs text-text-tertiary" title={g.cost_account_name}>
                          {g.cost_account_name}
                          {g.routed_accounts > 1 ? ` +${g.routed_accounts - 1}` : ''}
                        </span>
                      </div>
                    ) : (
                      <Chip color="warning" size="sm" variant="soft">
                        {t('pricing.no_account', '无可用账号')}
                      </Chip>
                    )}
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    {margin === null ? (
                      <span className="text-text-tertiary">—</span>
                    ) : (
                      <Chip color={isLoss ? 'danger' : margin < 10 ? 'warning' : 'success'} size="sm" variant="soft">
                        {margin.toFixed(1)}%
                      </Chip>
                    )}
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    {overrides.length === 0 ? (
                      <span className="text-xs text-text-tertiary">—</span>
                    ) : (
                      <div className="flex items-center gap-1">
                        <span className="font-mono text-sm">{overrides.length}</span>
                        {inverted.length > 0 ? (
                          <Chip color="danger" size="sm" variant="soft">
                            <span className="inline-flex items-center gap-1">
                              <TriangleAlert className="h-3 w-3" />
                              {t('pricing.inverted', '倒挂 {{n}}', { n: inverted.length })}
                            </span>
                          </Chip>
                        ) : null}
                      </div>
                    )}
                  </CommonTable.Cell>
                  <CommonTable.Cell>
                    <div className="flex gap-1">
                      {g.delisted ? (
                        <Chip color="default" size="sm" variant="soft">{t('pricing.delisted', '已下架')}</Chip>
                      ) : null}
                      {g.is_exclusive ? (
                        <Chip color="accent" size="sm" variant="soft">{t('pricing.exclusive', '专属')}</Chip>
                      ) : null}
                    </div>
                  </CommonTable.Cell>
                </CommonTable.Row>,
              ];

              if (isOpen) {
                overrides.forEach((o) => {
                  const oMargin = marginPct(o.rate, g.cost_multiplier);
                  const isInverted = g.rate_multiplier > 0 && o.rate > g.rate_multiplier;
                  rows.push(
                    <CommonTable.Row id={`o-${g.id}-${o.user_id}`} key={`o-${g.id}-${o.user_id}`}>
                      <CommonTable.Cell>{' '}</CommonTable.Cell>
                      <CommonTable.Cell colSpan={3}>
                        <div className="pl-4">
                          <span className="text-sm text-text">{o.email || o.username}</span>
                          <Chip className="ml-2" color={o.pricing_mode === 'quote' ? 'accent' : 'default'} size="sm" variant="soft">
                            {o.pricing_mode === 'quote'
                              ? t('pricing.mode_quote', '报价客户')
                              : t('pricing.mode_override', '专属倍率')}
                          </Chip>
                        </div>
                      </CommonTable.Cell>
                      <CommonTable.Cell>
                        <span className="font-mono">{fmtZhe(o.rate, fx, t)}</span>
                      </CommonTable.Cell>
                      <CommonTable.Cell>{' '}</CommonTable.Cell>
                      <CommonTable.Cell>
                        {oMargin === null ? (
                          <span className="text-text-tertiary">—</span>
                        ) : (
                          <Chip color={oMargin < 0 ? 'danger' : oMargin < 10 ? 'warning' : 'success'} size="sm" variant="soft">
                            {oMargin.toFixed(1)}%
                          </Chip>
                        )}
                      </CommonTable.Cell>
                      <CommonTable.Cell colSpan={2}>
                        {isInverted ? (
                          <Chip color="danger" size="sm" variant="soft">
                            <span className="inline-flex items-center gap-1">
                              <TriangleAlert className="h-3 w-3" />
                              {t('pricing.inverted_hint', '比标准价还贵')}
                            </span>
                          </Chip>
                        ) : null}
                      </CommonTable.Cell>
                    </CommonTable.Row>,
                  );
                });
              }
              return rows;
            })
          )}
        </CommonTable.Body>
      </CommonTable>
    </div>
  );
}
