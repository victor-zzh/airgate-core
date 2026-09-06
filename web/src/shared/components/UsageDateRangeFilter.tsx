import { Button, DateField, Label, Popover, RangeCalendar } from '@heroui/react';
import type { CalendarDate, CalendarDateTime, DateValue } from '@internationalized/date';
import { getLocalTimeZone, parseDate, parseDateTime, toCalendarDate, toCalendarDateTime, today } from '@internationalized/date';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, ChevronDown } from 'lucide-react';

interface UsageDateRangeFilterProps {
  clearLabel?: string;
  className?: string;
  endDate?: string;
  endTimeLabel?: string;
  label: string;
  onChange: (startDate: string, endDate: string) => void;
  startDate?: string;
  startTimeLabel?: string;
}

type RangeValue = { end: CalendarDateTime; start: CalendarDateTime } | null;

type PresetKey = 'today' | 'yesterday' | '7d' | '30d' | '90d';

const PRESETS: PresetKey[] = ['today', 'yesterday', '7d', '30d', '90d'];

function toDateTime(value?: string): CalendarDateTime | null {
  if (!value) return null;
  // 秒粒度输出为 "2026-08-31T14:30:05";旧值/预设可能是纯日期,归一到
  // CalendarDateTime(00:00:00) 以免同一 range 里混两种粒度。
  try {
    return parseDateTime(value);
  } catch {
    try {
      return toCalendarDateTime(parseDate(value));
    } catch {
      return null;
    }
  }
}

function dayStart(date: CalendarDate): CalendarDateTime {
  return toCalendarDateTime(date).set({ hour: 0, minute: 0, second: 0, millisecond: 0 });
}

function dayEnd(date: CalendarDate): CalendarDateTime {
  return toCalendarDateTime(date).set({ hour: 23, minute: 59, second: 59, millisecond: 0 });
}

/** 快捷区间都按本地日历日取整:近 N 天 = 含今天在内往前 N 天 */
function presetRange(preset: PresetKey): { end: CalendarDateTime; start: CalendarDateTime } {
  const now = today(getLocalTimeZone());
  switch (preset) {
    case 'today':
      return { start: dayStart(now), end: dayEnd(now) };
    case 'yesterday': {
      const y = now.subtract({ days: 1 });
      return { start: dayStart(y), end: dayEnd(y) };
    }
    case '7d':
      return { start: dayStart(now.subtract({ days: 6 })), end: dayEnd(now) };
    case '30d':
      return { start: dayStart(now.subtract({ days: 29 })), end: dayEnd(now) };
    case '90d':
    default:
      return { start: dayStart(now.subtract({ days: 89 })), end: dayEnd(now) };
  }
}

function sameInstant(a: CalendarDateTime, b: CalendarDateTime): boolean {
  return a.compare(b) === 0;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 触发按钮上的紧凑写法:同年省略年份,秒为 0 时省略秒 */
function formatCompact(value: CalendarDateTime, withYear: boolean): string {
  const date = `${withYear ? `${value.year}-` : ''}${pad(value.month)}-${pad(value.day)}`;
  const time = `${pad(value.hour)}:${pad(value.minute)}${value.second ? `:${pad(value.second)}` : ''}`;
  return `${date} ${time}`;
}

/**
 * 使用记录的时间范围筛选:一个下拉按钮显示当前区间,弹层里放快捷区间、日历与精确到秒的起止输入。
 * 对外契约不变:startDate / endDate 为 "2006-01-02T15:04:05" 字符串,清空时两者为空串。
 */
export function UsageDateRangeFilter({
  clearLabel = 'Clear',
  className = '',
  endDate,
  endTimeLabel = 'End time',
  label,
  onChange,
  startDate,
  startTimeLabel = 'Start time',
}: UsageDateRangeFilterProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  const value = useMemo<RangeValue>(() => {
    const start = toDateTime(startDate);
    const end = toDateTime(endDate);
    return start && end ? { start, end } : null;
  }, [endDate, startDate]);

  const activePreset = useMemo<PresetKey | null>(() => {
    if (!value) return null;
    return PRESETS.find((preset) => {
      const range = presetRange(preset);
      return sameInstant(range.start, value.start) && sameInstant(range.end, value.end);
    }) ?? null;
  }, [value]);

  const presetLabel = (preset: PresetKey) =>
    preset === 'yesterday' ? t('usage.range_yesterday') : t(`dashboard.range_${preset}`);

  const summary = useMemo(() => {
    if (!value) return t('usage.range_all');
    const thisYear = today(getLocalTimeZone()).year;
    const withYear = value.start.year !== thisYear || value.end.year !== thisYear;
    if (activePreset) {
      const short = activePreset === 'today' || activePreset === 'yesterday'
        ? `${pad(value.start.month)}-${pad(value.start.day)}`
        : `${pad(value.start.month)}-${pad(value.start.day)} → ${pad(value.end.month)}-${pad(value.end.day)}`;
      return `${presetLabel(activePreset)} · ${short}`;
    }
    return `${formatCompact(value.start, withYear)} → ${formatCompact(value.end, withYear)}`;
  }, [activePreset, t, value]); // eslint-disable-line react-hooks/exhaustive-deps

  const commit = (next: RangeValue) => {
    onChange(next?.start.toString() ?? '', next?.end.toString() ?? '');
  };

  // 日历只选到「日」:换日期时保留已选的时刻,没有值时起点 00:00:00、终点 23:59:59
  const commitDates = (range: { end: DateValue; start: DateValue } | null) => {
    if (!range) return;
    const start = toCalendarDate(range.start);
    const end = toCalendarDate(range.end);
    const startTime = value?.start ?? dayStart(start);
    const endTime = value?.end ?? dayEnd(end);
    commit({
      start: toCalendarDateTime(start).set({ hour: startTime.hour, minute: startTime.minute, second: startTime.second }),
      end: toCalendarDateTime(end).set({ hour: endTime.hour, minute: endTime.minute, second: endTime.second }),
    });
  };

  const commitEdge = (edge: 'end' | 'start', next: DateValue | null) => {
    if (!next) return;
    const nextValue = toCalendarDateTime(next);
    const start = edge === 'start' ? nextValue : (value?.start ?? dayStart(toCalendarDate(nextValue)));
    const end = edge === 'end' ? nextValue : (value?.end ?? dayEnd(toCalendarDate(nextValue)));
    commit(start.compare(end) <= 0 ? { start, end } : { start: end, end: start });
  };

  const calendarValue = value ? { start: toCalendarDate(value.start), end: toCalendarDate(value.end) } : null;

  return (
    <Popover isOpen={isOpen} onOpenChange={setIsOpen}>
      <Popover.Trigger
        aria-label={label}
        className={`ag-date-range-button button button--sm button--secondary ${value ? 'ag-date-range-button--active' : ''} ${className}`.trim()}
        data-active={value ? 'true' : undefined}
      >
        <CalendarDays aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span className="ag-date-range-summary">{summary}</span>
        <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 opacity-60" />
      </Popover.Trigger>
      <Popover.Content className="ag-date-range-popover" placement="bottom start">
        <Popover.Dialog aria-label={label} className="ag-date-range-dialog">
          <div className="ag-date-range-presets" role="group" aria-label={label}>
            {PRESETS.map((preset) => (
              <button
                aria-pressed={activePreset === preset}
                className="ag-date-range-preset"
                key={preset}
                type="button"
                onClick={() => commit(presetRange(preset))}
              >
                {presetLabel(preset)}
              </button>
            ))}
            <button
              aria-pressed={!value}
              className="ag-date-range-preset"
              type="button"
              onClick={() => commit(null)}
            >
              {t('usage.range_all')}
            </button>
          </div>
          <div className="ag-date-range-custom">
            <RangeCalendar aria-label={label} value={calendarValue} onChange={commitDates}>
              <RangeCalendar.Header>
                <RangeCalendar.YearPickerTrigger>
                  <RangeCalendar.YearPickerTriggerHeading />
                  <RangeCalendar.YearPickerTriggerIndicator />
                </RangeCalendar.YearPickerTrigger>
                <RangeCalendar.NavButton slot="previous" />
                <RangeCalendar.NavButton slot="next" />
              </RangeCalendar.Header>
              <RangeCalendar.Grid>
                <RangeCalendar.GridHeader>
                  {(day) => <RangeCalendar.HeaderCell>{day}</RangeCalendar.HeaderCell>}
                </RangeCalendar.GridHeader>
                <RangeCalendar.GridBody>
                  {(date) => <RangeCalendar.Cell date={date} />}
                </RangeCalendar.GridBody>
              </RangeCalendar.Grid>
              <RangeCalendar.YearPickerGrid>
                <RangeCalendar.YearPickerGridBody>
                  {({ year }) => <RangeCalendar.YearPickerCell year={year} />}
                </RangeCalendar.YearPickerGridBody>
              </RangeCalendar.YearPickerGrid>
            </RangeCalendar>
            <div className="ag-date-range-fields">
              <DateField
                granularity="second"
                hideTimeZone
                value={value?.start ?? null}
                onChange={(next) => commitEdge('start', next)}
              >
                <Label>{startTimeLabel}</Label>
                <DateField.Group fullWidth>
                  <DateField.Input>
                    {(segment) => <DateField.Segment segment={segment} />}
                  </DateField.Input>
                </DateField.Group>
              </DateField>
              <DateField
                granularity="second"
                hideTimeZone
                value={value?.end ?? null}
                onChange={(next) => commitEdge('end', next)}
              >
                <Label>{endTimeLabel}</Label>
                <DateField.Group fullWidth>
                  <DateField.Input>
                    {(segment) => <DateField.Segment segment={segment} />}
                  </DateField.Input>
                </DateField.Group>
              </DateField>
              <div className="ag-date-range-actions">
                <Button isDisabled={!value} size="sm" type="button" variant="ghost" onPress={() => commit(null)}>
                  {clearLabel}
                </Button>
                <Button size="sm" type="button" variant="primary" onPress={() => setIsOpen(false)}>
                  {t('common.confirm')}
                </Button>
              </div>
            </div>
          </div>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
