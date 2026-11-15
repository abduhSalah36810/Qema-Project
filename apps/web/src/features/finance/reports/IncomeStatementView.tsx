import { useState } from 'react';
import {
  financeApi,
  errorMessage,
  formatMoney,
  type ProfitAndLossReport,
  type ProfitAndLossDrilldownReport,
} from '../financeApi';
import {
  formatPeriod,
  presetPeriod,
  type Period,
  type PeriodPreset,
} from './analyticsApi';
import {
  KpiCard,
  KpiGrid,
  LoadState,
  Panel,
  PeriodBar,
  fmtPct,
} from './reportUi';
import { useLoad } from '../FinancialReportsView';

export type IncomeStatementSubTab = 'all' | 'summary' | 'revenues' | 'cogs' | 'expenses' | 'profit';

export function IncomeStatementView() {
  const [preset, setPreset] = useState<PeriodPreset>('this_month');
  const [period, setPeriod] = useState<Period>(presetPeriod('this_month'));
  const [subTab, setSubTab] = useState<IncomeStatementSubTab>('all');

  const { data, loading, error, reload } = useLoad<ProfitAndLossReport>(
    () => financeApi.getProfitAndLossReport(period),
    [period.from, period.to],
    'تعذر تحميل قائمة الدخل.'
  );

  const [drilldownCode, setDrilldownCode] = useState<string | null>(null);
  const [drilldownData, setDrilldownData] = useState<ProfitAndLossDrilldownReport | null>(null);
  const [drilldownLoading, setDrilldownLoading] = useState(false);
  const [drilldownError, setDrilldownError] = useState('');

  const openDrilldown = (code: string) => {
    setDrilldownCode(code);
    setDrilldownLoading(true);
    setDrilldownError('');
    financeApi
      .getProfitAndLossDrilldown(code, period)
      .then((res) => setDrilldownData(res))
      .catch((err: unknown) => setDrilldownError(errorMessage(err, 'تعذر تحميل تفاصيل الحساب.')))
      .finally(() => setDrilldownLoading(false));
  };

  const closeDrilldown = () => {
    setDrilldownCode(null);
    setDrilldownData(null);
  };

  const showSummary = subTab === 'all' || subTab === 'summary' || subTab === 'profit';
  const showRevenues = subTab === 'all' || subTab === 'revenues';
  const showCogs = subTab === 'all' || subTab === 'cogs';
  const showExpenses = subTab === 'all' || subTab === 'expenses';
  const showProfitDetails = subTab === 'profit';

  return (
    <section className="warehouse-page rh" dir="rtl" aria-labelledby="income-statement-title">
      <header className="rh-head">
        <div>
          <span className="rh-eyebrow">التقارير المالية · الأرباح والخسائر</span>
          <h2 id="income-statement-title">قائمة الدخل</h2>
          <p>إيرادات المبيعات وتكلفة البضاعة المباعة والمصروفات وصافي الدخل من القيود المعتمدة في دفتر الأستاذ.</p>
        </div>
        <div className="rh-head__actions no-print">
          <button type="button" className="btn btn--secondary" onClick={() => window.print()}>
            طباعة / حفظ PDF
          </button>
        </div>
      </header>

      <div className="rh-subnav no-print" role="tablist" aria-label="أقسام قائمة الدخل">
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'all'}
          aria-pressed={subTab === 'all'}
          onClick={() => setSubTab('all')}
        >
          الكل
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'summary'}
          aria-pressed={subTab === 'summary'}
          onClick={() => setSubTab('summary')}
        >
          ملخص قائمة الدخل
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'revenues'}
          aria-pressed={subTab === 'revenues'}
          onClick={() => setSubTab('revenues')}
        >
          الإيرادات
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'cogs'}
          aria-pressed={subTab === 'cogs'}
          onClick={() => setSubTab('cogs')}
        >
          تكلفة المبيعات
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'expenses'}
          aria-pressed={subTab === 'expenses'}
          onClick={() => setSubTab('expenses')}
        >
          المصروفات
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'profit'}
          aria-pressed={subTab === 'profit'}
          onClick={() => setSubTab('profit')}
        >
          صافي الربح
        </button>
      </div>

      <div className="rh-toolbar">
        <PeriodBar
          preset={preset}
          period={period}
          onChange={(p, next) => {
            setPreset(p);
            setPeriod(next);
          }}
        />
        <span className="rh-period-note">
          الفترة: <strong>{formatPeriod(period)}</strong>
        </span>
      </div>

      <h2 className="rh-print-title">
        مصنع القمة للملابس — قائمة الدخل ({formatPeriod(period)})
      </h2>

      {!data || !data.revenues || !data.cost_of_goods_sold || !data.operating_expenses ? (
        <LoadState loading={loading} error={error} onRetry={reload} />
      ) : (
        <>
          {showSummary && (
            <KpiGrid>
              <KpiCard label="إجمالي الإيرادات" value={formatMoney(data.revenues.total_revenue)} emphasis />
              <KpiCard
                label="مجمل الربح"
                value={formatMoney(data.gross_profit)}
                hint={`هامش مجمل الربح: ${fmtPct(data.gross_profit_margin_pct)}`}
              />
              <KpiCard label="المصروفات التشغيلية" value={formatMoney(data.operating_expenses.total_expenses)} />
              <KpiCard
                label="صافي الدخل (الربح / الخسارة)"
                value={formatMoney(data.net_income)}
                emphasis
                hint={`هامش صافي الربح: ${fmtPct(data.net_profit_margin_pct)}`}
              />
            </KpiGrid>
          )}

          {showProfitDetails && (
            <div style={{ marginTop: '1.5rem' }}>
              <Panel title="تحليل صافي الربح وهوامش التشغيل">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', padding: '1rem 0' }}>
                  <div style={{ padding: '1rem', background: '#f8fafc', borderRadius: '8px' }}>
                    <div style={{ fontSize: '0.85rem', color: '#64748b' }}>إجمالي الإيرادات التشغيلية</div>
                    <div style={{ fontSize: '1.25rem', fontWeight: 700, color: '#0f172a' }}>{formatMoney(data.revenues.total_revenue)}</div>
                  </div>
                  <div style={{ padding: '1rem', background: '#f8fafc', borderRadius: '8px' }}>
                    <div style={{ fontSize: '0.85rem', color: '#64748b' }}>إجمالي تكلفة المبيعات والتصنيع</div>
                    <div style={{ fontSize: '1.25rem', fontWeight: 700, color: '#dc2626' }}>− {formatMoney(data.cost_of_goods_sold.total_cogs)}</div>
                  </div>
                  <div style={{ padding: '1rem', background: '#f8fafc', borderRadius: '8px' }}>
                    <div style={{ fontSize: '0.85rem', color: '#64748b' }}>مجمل الربح التشغيلي</div>
                    <div style={{ fontSize: '1.25rem', fontWeight: 700, color: '#16a34a' }}>{formatMoney(data.gross_profit)}</div>
                    <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: '0.25rem' }}>الهامش: {fmtPct(data.gross_profit_margin_pct)}</div>
                  </div>
                  <div style={{ padding: '1rem', background: '#f8fafc', borderRadius: '8px' }}>
                    <div style={{ fontSize: '0.85rem', color: '#64748b' }}>المصروفات الإدارية والعمومية</div>
                    <div style={{ fontSize: '1.25rem', fontWeight: 700, color: '#dc2626' }}>− {formatMoney(data.operating_expenses.total_expenses)}</div>
                  </div>
                  <div style={{ padding: '1rem', background: '#eff6ff', borderRadius: '8px', border: '1px solid #bfdbfe' }}>
                    <div style={{ fontSize: '0.85rem', color: '#1e40af', fontWeight: 600 }}>صافي الدخل النهائي</div>
                    <div style={{ fontSize: '1.35rem', fontWeight: 800, color: data.net_income >= 0 ? '#15803d' : '#b91c1c' }}>
                      {formatMoney(data.net_income)}
                    </div>
                    <div style={{ fontSize: '0.8rem', color: '#1e40af', marginTop: '0.25rem' }}>صافي الهامش: {fmtPct(data.net_profit_margin_pct)}</div>
                  </div>
                </div>
              </Panel>
            </div>
          )}

          {(showRevenues || showCogs) && (
            <div className="rh-grid2" style={{ marginTop: '1.5rem' }}>
              {showRevenues && (
                <Panel title="الإيرادات" subtitle="انقر على أي حساب لعرض القيود التفصيلية">
                  <table className="rh-table">
                    <thead>
                      <tr>
                        <th>كود</th>
                        <th>الحساب</th>
                        <th style={{ textAlign: 'left' }}>المبلغ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.revenues.items.map((it) => (
                        <tr
                          key={it.code}
                          onClick={() => openDrilldown(it.code)}
                          style={{ cursor: 'pointer' }}
                          title="انقر للتفصيل"
                        >
                          <td><code>{it.code}</code></td>
                          <td><strong>{it.name_ar}</strong></td>
                          <td style={{ textAlign: 'left' }}>{formatMoney(it.net_amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={2}><strong>مجموع الإيرادات</strong></td>
                        <td style={{ textAlign: 'left' }}><strong>{formatMoney(data.revenues.total_revenue)}</strong></td>
                      </tr>
                    </tfoot>
                  </table>
                </Panel>
              )}

              {showCogs && (
                <Panel title="تكلفة البضاعة المباعة وتكاليف التصنيع" subtitle="انقر على أي حساب لعرض القيود التفصيلية">
                  <table className="rh-table">
                    <thead>
                      <tr>
                        <th>كود</th>
                        <th>الحساب</th>
                        <th style={{ textAlign: 'left' }}>المبلغ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.cost_of_goods_sold.items.map((it) => (
                        <tr
                          key={it.code}
                          onClick={() => openDrilldown(it.code)}
                          style={{ cursor: 'pointer' }}
                          title="انقر للتفصيل"
                        >
                          <td><code>{it.code}</code></td>
                          <td><strong>{it.name_ar}</strong></td>
                          <td style={{ textAlign: 'left' }}>{formatMoney(it.net_amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr>
                        <td colSpan={2}><strong>إجمالي التكلفة المباشرة</strong></td>
                        <td style={{ textAlign: 'left' }}><strong>{formatMoney(data.cost_of_goods_sold.total_cogs)}</strong></td>
                      </tr>
                    </tfoot>
                  </table>
                </Panel>
              )}
            </div>
          )}

          {showExpenses && (
            <div style={{ marginTop: '1.5rem' }}>
              <Panel title="المصروفات الإدارية والعمومية" subtitle="انقر على أي حساب لعرض القيود التفصيلية">
                <table className="rh-table">
                  <thead>
                    <tr>
                      <th>كود</th>
                      <th>الحساب</th>
                      <th style={{ textAlign: 'left' }}>المبلغ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.operating_expenses.items.map((it) => (
                      <tr
                        key={it.code}
                        onClick={() => openDrilldown(it.code)}
                        style={{ cursor: 'pointer' }}
                        title="انقر للتفصيل"
                      >
                        <td><code>{it.code}</code></td>
                        <td><strong>{it.name_ar}</strong></td>
                        <td style={{ textAlign: 'left' }}>{formatMoney(it.net_amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={2}><strong>إجمالي المصروفات</strong></td>
                      <td style={{ textAlign: 'left' }}><strong>{formatMoney(data.operating_expenses.total_expenses)}</strong></td>
                    </tr>
                  </tfoot>
                </table>
              </Panel>
            </div>
          )}

          {drilldownCode && (
            <div
              className="modal-backdrop"
              onClick={closeDrilldown}
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(15,23,42,0.5)',
                zIndex: 1200,
                display: 'grid',
                placeItems: 'center',
                padding: '16px',
              }}
            >
              <div
                className="modal-card modal-card--lg"
                style={{
                  maxWidth: '900px',
                  width: '100%',
                  background: '#fff',
                  borderRadius: '12px',
                  padding: '20px',
                }}
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-labelledby="drilldown-title"
              >
                <div
                  className="modal-header"
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: '1rem',
                  }}
                >
                  <h3 id="drilldown-title" style={{ margin: 0 }}>
                    تفاصيل حركة الحساب {drilldownCode}
                    {drilldownData?.account ? ` — ${drilldownData.account.name_ar}` : ''}
                  </h3>
                  <button type="button" className="btn btn--secondary btn--sm" onClick={closeDrilldown}>
                    إغلاق ✕
                  </button>
                </div>
                <div className="modal-body">
                  {drilldownLoading ? (
                    <p>جارٍ تحميل القيود التفصيلية...</p>
                  ) : drilldownError ? (
                    <p className="rh-error">{drilldownError}</p>
                  ) : drilldownData ? (
                    <>
                      <div
                        style={{
                          display: 'flex',
                          gap: '1.5rem',
                          marginBottom: '1rem',
                          background: '#f8fafc',
                          padding: '10px 14px',
                          borderRadius: '8px',
                        }}
                      >
                        <span>مدين: <strong>{formatMoney(drilldownData.summary.total_debit)}</strong></span>
                        <span>دائن: <strong>{formatMoney(drilldownData.summary.total_credit)}</strong></span>
                        <span>الصافي: <strong>{formatMoney(drilldownData.summary.net_amount)}</strong></span>
                        <span>عدد القيود: <strong>{drilldownData.summary.lines_count}</strong></span>
                      </div>
                      <div className="rh-table__wrap">
                        <table className="rh-table">
                          <thead>
                            <tr>
                              <th>رقم القيد</th>
                              <th>التاريخ</th>
                              <th>نوع المستند</th>
                              <th>البيان</th>
                              <th style={{ textAlign: 'left' }}>مدين</th>
                              <th style={{ textAlign: 'left' }}>دائن</th>
                              <th style={{ textAlign: 'left' }}>الأثر</th>
                            </tr>
                          </thead>
                          <tbody>
                            {drilldownData.lines.map((l) => (
                              <tr key={l.line_id}>
                                <td><code>{l.entry_number}</code></td>
                                <td>{l.entry_date?.slice(0, 10)}</td>
                                <td>{l.source_doc_type}</td>
                                <td>{l.description}</td>
                                <td style={{ textAlign: 'left' }}>{formatMoney(l.debit)}</td>
                                <td style={{ textAlign: 'left' }}>{formatMoney(l.credit)}</td>
                                <td style={{ textAlign: 'left' }}>{formatMoney(l.net_effect)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : (
                    <p>لا توجد تفاصيل متاحة لهذا الحساب في الفترة المحددة.</p>
                  )}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
