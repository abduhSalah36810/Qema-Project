import { ReactNode, useMemo, useState } from 'react';
import { formatMoney, toNumber } from '../financeApi';
import { PRESET_LABELS, presetPeriod, monthLabel, type Period, type PeriodPreset } from './analyticsApi';
import '@/styles/reports.css';

/* ─── التنسيق ─────────────────────────────────────────────────────────────── */

export const fmtNum = (v: unknown, digits = 0) => toNumber(v).toLocaleString('ar-EG', { maximumFractionDigits: digits });
export const fmtPct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${toNumber(v).toLocaleString('ar-EG', { maximumFractionDigits: 1 })}٪`);
export function fmtCompactMoney(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${(v / 1_000_000).toLocaleString('ar-EG', { maximumFractionDigits: 1 })} مليون`;
  if (abs >= 1_000) return `${(v / 1_000).toLocaleString('ar-EG', { maximumFractionDigits: 1 })} ألف`;
  return v.toLocaleString('ar-EG', { maximumFractionDigits: 0 });
}

/* ألوان الرسوم (لوحة مُتحقق منها لعمى الألوان): سلسلتان متجاورتان + تدرج ترتيبي أزرق للأعمار */
export const SERIES = { blue: '#2a78d6', orange: '#eb6834' };
export const ORDINAL_BLUE = ['#86b6ef', '#3987e5', '#1c5cab', '#0d366b'];

/* ─── شريط الفترة ─────────────────────────────────────────────────────────── */

export function PeriodBar({ preset, period, onChange }: {
  preset: PeriodPreset;
  period: Period;
  onChange: (preset: PeriodPreset, period: Period) => void;
}) {
  const presets: PeriodPreset[] = ['this_month', 'last_month', 'this_quarter', 'this_year', 'last_30', 'custom'];
  return (
    <div className="rh-period no-print" role="group" aria-label="فترة التقرير">
      <div className="rh-segment">
        {presets.map((p) => (
          <button key={p} type="button" aria-pressed={preset === p}
            onClick={() => onChange(p, p === 'custom' ? period : presetPeriod(p))}>
            {PRESET_LABELS[p]}
          </button>
        ))}
      </div>
      {preset === 'custom' && (
        <div className="rh-period__custom">
          <label>من <input type="date" value={period.from} max={period.to} onChange={(e) => e.target.value && onChange('custom', { ...period, from: e.target.value })} /></label>
          <label>إلى <input type="date" value={period.to} min={period.from} onChange={(e) => e.target.value && onChange('custom', { ...period, to: e.target.value })} /></label>
        </div>
      )}
    </div>
  );
}

/* ─── بطاقة مؤشر مع المقارنة ──────────────────────────────────────────────── */

export function KpiCard({ label, value, change, goodWhen = 'up', hint, emphasis }: {
  label: string;
  value: ReactNode;
  change?: number | null;
  goodWhen?: 'up' | 'down' | 'neutral';
  hint?: string;
  emphasis?: boolean;
}) {
  let tone = 'flat';
  if (change !== undefined && change !== null && change !== 0 && goodWhen !== 'neutral') {
    tone = (change > 0) === (goodWhen === 'up') ? 'good' : 'bad';
  }
  return (
    <article className={`rh-kpi${emphasis ? ' rh-kpi--emphasis' : ''}`}>
      <span className="rh-kpi__label">{label}</span>
      <strong className="rh-kpi__value">{value}</strong>
      {change !== undefined && (
        <span className={`rh-kpi__delta rh-kpi__delta--${tone}`}>
          {change === null ? 'لا توجد بيانات للمقارنة' : (
            <>
              <span aria-hidden>{change > 0 ? '▲' : change < 0 ? '▼' : '■'}</span>
              {' '}{fmtPct(Math.abs(change))} {change > 0 ? 'زيادة' : change < 0 ? 'انخفاض' : 'بلا تغيير'}
            </>
          )}
        </span>
      )}
      {hint && <small className="rh-kpi__hint">{hint}</small>}
    </article>
  );
}

export function KpiGrid({ children }: { children: ReactNode }) {
  return <div className="rh-kpis">{children}</div>;
}

/* ─── بطاقة قسم ───────────────────────────────────────────────────────────── */

export function Panel({ title, subtitle, actions, children }: { title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rh-panel">
      <header className="rh-panel__head">
        <div>
          <h3>{title}</h3>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {actions && <div className="rh-panel__actions no-print">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

export function LoadState({ loading, error, onRetry, empty }: { loading: boolean; error: string; onRetry?: () => void; empty?: boolean }) {
  if (loading) {
    return (
      <div className="rh-skeleton" role="status" aria-label="جاري التحميل">
        <span /><span /><span />
      </div>
    );
  }
  if (error) {
    return (
      <div className="rh-state rh-state--error" role="alert">
        {error}
        {onRetry && <button type="button" className="btn btn--secondary btn--sm" onClick={onRetry}>إعادة المحاولة</button>}
      </div>
    );
  }
  if (empty) return <div className="rh-state">لا توجد بيانات في هذه الفترة.</div>;
  return null;
}

/* ─── جدول احترافي: بحث، ترتيب، إجماليات، ترقيم، تصدير ───────────────────── */

export type ColumnKind = 'money' | 'number' | 'pct' | 'text' | 'code' | 'date';

export interface Column<T> {
  key: string;
  label: string;
  kind?: ColumnKind;
  value?: (row: T) => unknown;
  render?: (row: T) => ReactNode;
  sum?: boolean;
  wrap?: boolean;
}

function cellValue<T>(row: T, col: Column<T>): unknown {
  return col.value ? col.value(row) : (row as Record<string, unknown>)[col.key];
}

function formatCell(kind: ColumnKind | undefined, v: unknown): ReactNode {
  switch (kind) {
    case 'money': return formatMoney(v);
    case 'number': return fmtNum(v, 3);
    case 'pct': return v === null || v === undefined ? '—' : fmtPct(toNumber(v));
    case 'date': return v ? new Date(String(v)).toLocaleDateString('ar-EG') : '—';
    case 'code': return <code>{String(v ?? '')}</code>;
    default: return v === null || v === undefined || v === '' ? '—' : String(v);
  }
}

function toCsv<T>(rows: T[], columns: Column<T>[]): string {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const head = columns.map((c) => esc(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => {
    const v = cellValue(r, c);
    return esc(v === null || v === undefined ? '' : String(v));
  }).join(',')).join('\n');
  return `${head}\n${body}`;
}

export function downloadCsv(name: string, csv: string) {
  // BOM حتى يفتح Excel النص العربي بشكل صحيح
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function DataTable<T>({ rows, columns, rowKey, exportName, searchPlaceholder, emptyText = 'لا توجد بيانات.', onRowClick, pageSize = 20, rowTitle }: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  exportName?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  onRowClick?: (row: T) => void;
  pageSize?: number;
  rowTitle?: string;
}) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = q
      ? rows.filter((r) => columns.some((c) => (c.kind === 'text' || c.kind === 'code' || !c.kind) && String(cellValue(r, c) ?? '').toLowerCase().includes(q)))
      : rows;
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col) {
        const numeric = col.kind === 'money' || col.kind === 'number' || col.kind === 'pct';
        out = [...out].sort((a, b) => {
          const va = cellValue(a, col);
          const vb = cellValue(b, col);
          const cmp = numeric ? toNumber(va) - toNumber(vb) : String(va ?? '').localeCompare(String(vb ?? ''), 'ar');
          return sort.dir === 'asc' ? cmp : -cmp;
        });
      }
    }
    return out;
  }, [rows, columns, query, sort]);

  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, pages - 1);
  const visible = filtered.slice(current * pageSize, current * pageSize + pageSize);
  const hasTotals = columns.some((c) => c.sum);

  const toggleSort = (key: string) => {
    setPage(0);
    setSort((s) => (s?.key === key ? (s.dir === 'desc' ? { key, dir: 'asc' } : null) : { key, dir: 'desc' }));
  };

  return (
    <div className="rh-table">
      {(searchPlaceholder || exportName) && (
        <div className="rh-table__tools no-print">
          {searchPlaceholder && (
            <input type="search" value={query} placeholder={searchPlaceholder} aria-label={searchPlaceholder}
              onChange={(e) => { setQuery(e.target.value); setPage(0); }} />
          )}
          <span className="rh-table__count">{fmtNum(filtered.length)} سجل</span>
          {exportName && (
            <button type="button" className="btn btn--secondary btn--sm" disabled={filtered.length === 0}
              onClick={() => downloadCsv(exportName, toCsv(filtered, columns))}>
              تصدير Excel
            </button>
          )}
        </div>
      )}
      <div className="rh-table__wrap">
        <table>
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th key={c.key} className={c.kind === 'money' || c.kind === 'number' || c.kind === 'pct' ? 'is-num' : undefined}
                    aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <button type="button" onClick={() => toggleSort(c.key)}>
                      {c.label}
                      <span aria-hidden className="rh-sort">{active ? (sort!.dir === 'asc' ? '▲' : '▼') : '↕'}</span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr><td colSpan={columns.length} className="rh-table__empty">{query ? 'لا توجد نتائج مطابقة للبحث.' : emptyText}</td></tr>
            ) : visible.map((r) => (
              <tr key={rowKey(r)} className={onRowClick ? 'is-clickable' : undefined} title={onRowClick ? rowTitle : undefined}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
                onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(r); } : undefined}
                tabIndex={onRowClick ? 0 : undefined}>
                {columns.map((c) => (
                  <td key={c.key} className={[c.kind === 'money' || c.kind === 'number' || c.kind === 'pct' ? 'is-num' : '', c.wrap ? 'is-wrap' : ''].join(' ').trim() || undefined}>
                    {c.render ? c.render(r) : formatCell(c.kind, cellValue(r, c))}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {hasTotals && filtered.length > 0 && (
            <tfoot>
              <tr>
                {columns.map((c, i) => (
                  <td key={c.key} className={c.sum ? 'is-num' : undefined}>
                    {c.sum ? formatCell(c.kind, filtered.reduce((s, r) => s + toNumber(cellValue(r, c)), 0)) : i === 0 ? 'الإجمالي' : ''}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {pages > 1 && (
        <div className="rh-table__pager no-print">
          <button type="button" className="btn btn--secondary btn--sm" disabled={current === 0} onClick={() => setPage(current - 1)}>السابق</button>
          <span>صفحة {fmtNum(current + 1)} من {fmtNum(pages)}</span>
          <button type="button" className="btn btn--secondary btn--sm" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>التالي</button>
        </div>
      )}
    </div>
  );
}

/* ─── رسم أعمدة شهرية مزدوجة ─────────────────────────────────────────────── */

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

export function MonthlyBars<T extends { month: string }>({ data, series, height = 230, ariaLabel }: {
  data: T[];
  series: Array<{ key: keyof T & string; label: string; color: string }>;
  height?: number;
  ariaLabel: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = height;
  const pad = { top: 12, right: 8, bottom: 26, left: 76 };
  const innerW = W - pad.left - pad.right;
  const innerH = H - pad.top - pad.bottom;
  const max = niceMax(Math.max(0, ...data.flatMap((d) => series.map((s) => toNumber(d[s.key])))));
  const slot = innerW / Math.max(1, data.length);
  const barW = Math.min(18, (slot - 10) / series.length - 2);
  const y = (v: number) => pad.top + innerH - (Math.max(0, v) / max) * innerH;
  // الزمن يتجه من اليمين لليسار (RTL): الشهر الأحدث على اليسار
  const xSlot = (i: number) => pad.left + (data.length - 1 - i) * slot;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);

  const bar = (x: number, v: number, w: number) => {
    const top = y(v);
    const h = pad.top + innerH - top;
    if (h <= 0) return '';
    const r = Math.min(4, w / 2, h);
    return `M${x},${pad.top + innerH} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${pad.top + innerH} Z`;
  };

  return (
    <figure className="rh-chart" aria-label={ariaLabel}>
      <div className="rh-legend">
        {series.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}
      </div>
      <div className="rh-chart__canvas">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.left} x2={W - pad.right} y1={y(t)} y2={y(t)} className="rh-grid" />
              <text x={pad.left - 8} y={y(t) + 4} className="rh-axis" textAnchor="end">{fmtCompactMoney(t)}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const groupW = series.length * (barW + 2) - 2;
            const x0 = xSlot(i) + (slot - groupW) / 2;
            return (
              <g key={d.month}>
                {hover === i && <rect x={xSlot(i)} y={pad.top} width={slot} height={innerH} className="rh-hover-band" />}
                {series.map((s, si) => (
                  <path key={s.key} d={bar(x0 + si * (barW + 2), toNumber(d[s.key]), barW)} fill={s.color} />
                ))}
                <text x={xSlot(i) + slot / 2} y={H - 8} className="rh-axis" textAnchor="middle">{monthLabel(d.month)}</text>
                <rect x={xSlot(i)} y={pad.top} width={slot} height={innerH + 20} fill="transparent"
                  onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
              </g>
            );
          })}
        </svg>
        {hover !== null && data[hover] && (
          <div className="rh-tooltip" style={{ left: `${((xSlot(hover) + slot / 2) / W) * 100}%` }} role="status">
            <strong>{monthLabel(data[hover].month, true)}</strong>
            {series.map((s) => (
              <span key={s.key}><i style={{ background: s.color }} />{s.label}: {formatMoney(data[hover][s.key])}</span>
            ))}
          </div>
        )}
      </div>
      <details className="rh-chart__table">
        <summary>عرض البيانات كجدول</summary>
        <table>
          <thead><tr><th>الشهر</th>{series.map((s) => <th key={s.key}>{s.label}</th>)}</tr></thead>
          <tbody>{data.map((d) => <tr key={d.month}><td>{monthLabel(d.month, true)}</td>{series.map((s) => <td key={s.key}>{formatMoney(d[s.key])}</td>)}</tr>)}</tbody>
        </table>
      </details>
    </figure>
  );
}

/* ─── أعمدة أفقية مرتبة (قيمة واحدة) ─────────────────────────────────────── */

export function HBarList({ rows, max = 8, valueFormat = formatMoney, onSelect }: {
  rows: Array<{ label: string; value: number; pct?: number; key?: string }>;
  max?: number;
  valueFormat?: (v: number) => string;
  onSelect?: (key: string) => void;
}) {
  const list = rows.slice(0, max);
  const rest = rows.slice(max);
  // «أخرى» سطر نصي وليس عموداً، حتى لا يصغّر مقياس الأعمدة الرئيسية
  const restValue = rest.reduce((s, r) => s + r.value, 0);
  const restPct = rest.reduce((s, r) => s + (r.pct ?? 0), 0);
  const top = Math.max(1, ...list.map((r) => r.value));
  if (list.length === 0) return <div className="rh-state">لا توجد بيانات في هذه الفترة.</div>;
  return (
    <ul className="rh-hbars">
      {rest.length > 0 && (
        <li className="rh-hbars__rest" style={{ order: 1 }}>و{fmtNum(rest.length)} أخرى بإجمالي <strong>{valueFormat(restValue)}</strong>{restPct ? ` (${fmtPct(restPct)})` : ''} — التفاصيل في الجدول.</li>
      )}
      {list.map((r) => (
        <li key={r.key ?? r.label}>
          <div className="rh-hbars__label">
            {onSelect && r.key ? <button type="button" className="md-link" onClick={() => onSelect(r.key!)}>{r.label}</button> : <span>{r.label}</span>}
            <strong>{valueFormat(r.value)}{r.pct !== undefined && <small> · {fmtPct(r.pct)}</small>}</strong>
          </div>
          <div className="rh-hbars__track"><i style={{ width: `${(r.value / top) * 100}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}

/* ─── شريط مكدس لأعمار الديون ────────────────────────────────────────────── */

export function AgingStack({ buckets, totals }: {
  buckets: Array<{ key: string; label: string }>;
  totals: Record<string, number>;
}) {
  const total = toNumber(totals.total);
  return (
    <div className="rh-aging">
      <div className="rh-aging__bar" role="img" aria-label="توزيع الأرصدة حسب العمر">
        {buckets.map((b, i) => {
          const v = toNumber(totals[b.key]);
          return v > 0 ? <i key={b.key} style={{ width: `${(v / (total || 1)) * 100}%`, background: ORDINAL_BLUE[i] }} title={`${b.label}: ${formatMoney(v)}`} /> : null;
        })}
      </div>
      <div className="rh-legend rh-legend--wrap">
        {buckets.map((b, i) => (
          <span key={b.key}><i style={{ background: ORDINAL_BLUE[i] }} />{b.label}: <strong>{formatMoney(totals[b.key])}</strong> ({fmtPct(total ? (toNumber(totals[b.key]) / total) * 100 : 0)})</span>
        ))}
      </div>
    </div>
  );
}
