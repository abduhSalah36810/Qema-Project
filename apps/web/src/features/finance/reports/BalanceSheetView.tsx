import React, { useState, useMemo } from 'react';
import {
  financeApi,
  errorMessage,
  formatMoney,
  type BalanceSheetReport,
  type OpeningBalancesPayload,
} from '../financeApi';
import {
  KpiCard,
  KpiGrid,
  LoadState,
  Panel,
} from './reportUi';
import { useLoad } from '../FinancialReportsView';

export type BalanceSheetSubTab = 'all' | 'summary' | 'assets' | 'liabilities' | 'equity';

export function BalanceSheetView() {
  const [subTab, setSubTab] = useState<BalanceSheetSubTab>('all');

  const { data, loading, error, reload } = useLoad<BalanceSheetReport>(
    () => financeApi.getBalanceSheet(),
    [],
    'تعذر تحميل الميزانية العمومية.'
  );

  const [showOpeningModal, setShowOpeningModal] = useState(false);
  const [openingSubmitting, setOpeningSubmitting] = useState(false);
  const [openingError, setOpeningError] = useState('');
  const [openingSuccess, setOpeningSuccess] = useState('');

  // Form state for Opening Balances
  const [startDate, setStartDate] = useState('2026-01-01');
  const [treasuryBal, setTreasuryBal] = useState('0');
  const [bankBal, setBankBal] = useState('0');
  const [custodyBal, setCustodyBal] = useState('0');
  const [arBal, setArBal] = useState('0');
  const [rawBal, setRawBal] = useState('0');
  const [wipBal, setWipBal] = useState('0');
  const [finishedBal, setFinishedBal] = useState('0');
  const [apBal, setApBal] = useState('0');
  const [capitalBal, setCapitalBal] = useState('0');
  const [notes, setNotes] = useState('الأرصدة الافتتاحية المعتمدة للمصنع');

  const totalAssetsInput = useMemo(() => {
    return (
      (parseFloat(treasuryBal) || 0) +
      (parseFloat(bankBal) || 0) +
      (parseFloat(custodyBal) || 0) +
      (parseFloat(arBal) || 0) +
      (parseFloat(rawBal) || 0) +
      (parseFloat(wipBal) || 0) +
      (parseFloat(finishedBal) || 0)
    );
  }, [treasuryBal, bankBal, custodyBal, arBal, rawBal, wipBal, finishedBal]);

  const totalLiabEquityInput = useMemo(() => {
    return (parseFloat(apBal) || 0) + (parseFloat(capitalBal) || 0);
  }, [apBal, capitalBal]);

  const diffInput = useMemo(() => {
    return Math.round((totalAssetsInput - totalLiabEquityInput) * 100) / 100;
  }, [totalAssetsInput, totalLiabEquityInput]);

  const isInputBalanced = Math.abs(diffInput) < 0.01;

  const handleSubmitOpening = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isInputBalanced) {
      setOpeningError(`القيد غير متزن بمقدار ${diffInput.toFixed(2)} ج.م. يجب أن تتساوى الأصول تماماً مع الخصوم ورأس المال.`);
      return;
    }
    setOpeningSubmitting(true);
    setOpeningError('');
    try {
      const payload: OpeningBalancesPayload = {
        accounting_start_date: startDate,
        treasury_balance: treasuryBal,
        bank_balance: bankBal,
        custody_balance: custodyBal,
        accounts_receivable: arBal,
        raw_materials_inventory: rawBal,
        wip_inventory: wipBal,
        finished_goods_inventory: finishedBal,
        accounts_payable: apBal,
        paid_in_capital: capitalBal,
        notes,
      };
      await financeApi.createOpeningBalances(payload);
      setOpeningSuccess('تم تسجيل واعتماد القيد الافتتاحي بنجاح!');
      setTimeout(() => {
        setShowOpeningModal(false);
        reload();
      }, 1200);
    } catch (err: unknown) {
      setOpeningError(errorMessage(err, 'فشل تسجيل القيد الافتتاحي.'));
    } finally {
      setOpeningSubmitting(false);
    }
  };

  const showSummary = subTab === 'all' || subTab === 'summary';
  const showAssets = subTab === 'all' || subTab === 'assets';
  const showLiabilities = subTab === 'all' || subTab === 'liabilities';
  const showEquity = subTab === 'all' || subTab === 'equity';

  return (
    <section className="warehouse-page rh" dir="rtl" aria-labelledby="balance-sheet-title">
      <header className="rh-head">
        <div>
          <span className="rh-eyebrow">التقارير المالية · المركز المالي</span>
          <h2 id="balance-sheet-title">الميزانية العمومية</h2>
          <p>قائمة المركز المالي والأصول المتداولة والالتزامات وحقوق الملكية والتوازن المحاسبي للمصنع.</p>
        </div>
        <div className="rh-head__actions no-print">
          <button type="button" className="btn btn--secondary" onClick={() => window.print()}>
            طباعة / حفظ PDF
          </button>
        </div>
      </header>

      <div className="rh-subnav no-print" role="tablist" aria-label="أقسام الميزانية العمومية">
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
          ملخص الميزانية
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'assets'}
          aria-pressed={subTab === 'assets'}
          onClick={() => setSubTab('assets')}
        >
          الأصول
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'liabilities'}
          aria-pressed={subTab === 'liabilities'}
          onClick={() => setSubTab('liabilities')}
        >
          الالتزامات
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subTab === 'equity'}
          aria-pressed={subTab === 'equity'}
          onClick={() => setSubTab('equity')}
        >
          حقوق الملكية
        </button>
      </div>

      <div className="rh-toolbar">
        <span className="rh-period-note">
          هذا التقرير يعرض <strong>الأرصدة التراكمية حتى اليوم</strong> من واقع دفتر الأستاذ العام ولا يتأثر باختيار الفترة.
        </span>
      </div>

      <h2 className="rh-print-title">مصنع القمة للملابس — الميزانية العمومية (الأرصدة حتى اليوم)</h2>

      {!data || !data.assets || !data.liabilities || !data.equity ? (
        <LoadState loading={loading} error={error} onRetry={reload} />
      ) : (
        <>
          {/* Opening Balance Banner */}
          {data.opening_balance?.is_set ? (
            <div
              style={{
                padding: '1rem',
                background: '#ecfdf5',
                border: '1px solid #10b981',
                borderRadius: '8px',
                marginBottom: '1.5rem',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <span style={{ color: '#047857', fontWeight: 700 }}>✅ القيد الافتتاحي معتمد ومثبت في النظام</span>
                <span style={{ margin: '0 0.5rem', color: '#6ee7b7' }}>|</span>
                <span>تاريخ بداية المحاسبة: <strong>{data.opening_balance.accounting_start_date}</strong></span>
                {data.opening_balance.journal_entry_number && (
                  <>
                    <span style={{ margin: '0 0.5rem', color: '#6ee7b7' }}>|</span>
                    <span>رقم القيد الافتتاحي: <code>{data.opening_balance.journal_entry_number}</code></span>
                  </>
                )}
              </div>
              <span className="rh-pill rh-pill--good">معتمد</span>
            </div>
          ) : (
            <div
              style={{
                padding: '1.25rem',
                background: '#fffbeb',
                border: '1px solid #f59e0b',
                borderRadius: '8px',
                marginBottom: '1.5rem',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '1rem',
              }}
            >
              <div>
                <div style={{ color: '#b45309', fontWeight: 700, fontSize: '1.05rem', marginBottom: '0.25rem' }}>
                  ⚠️ تنبيه: لم يتم تثبيت القيد الافتتاحي للنظام بعد
                </div>
                <p style={{ margin: 0, color: '#78350f', fontSize: '0.9rem' }}>
                  حسب متطلبات المعايير المحاسبية المعتمدة (ACC-01 / ACC-02)، يتطلب تفعيل الميزانية العمومية تسجيل الأرصدة
                  الافتتاحية المعتمدة للمصنع بتاريخ بداية محدد.
                </p>
              </div>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setShowOpeningModal(true)}
              >
                تسجيل القيد الافتتاحي ✍️
              </button>
            </div>
          )}

          {/* KPIs */}
          {showSummary && (
            <KpiGrid>
              <KpiCard label="إجمالي الأصول (Assets)" value={formatMoney(data.assets.total_assets)} emphasis />
              <KpiCard
                label="إجمالي الخصوم وحقوق الملكية"
                value={formatMoney(data.total_liabilities_and_equity)}
                emphasis
              />
              <article className="rh-kpi">
                <span className="rh-kpi__label">حالة توازن الميزانية</span>
                <strong className="rh-kpi__value">
                  {data.is_balanced ? (
                    <span className="rh-pill rh-pill--good">متزنة (الفرق 0.00 ج.م)</span>
                  ) : (
                    <span className="rh-pill rh-pill--bad">غير متزنة (فرق: {formatMoney(data.difference)})</span>
                  )}
                </strong>
                <small className="rh-kpi__hint">
                  {data.is_balanced ? 'الأصول = الخصوم + حقوق الملكية' : 'يوجد فارق حسابي يتطلب مراجعة'}
                </small>
              </article>
            </KpiGrid>
          )}

          {/* Main Grid: Assets & Liabilities / Equity */}
          <div className="rh-grid2" style={{ marginTop: '1.5rem' }}>
            {/* Assets Side */}
            {showAssets && (
              <Panel title="الأصول المتداولة (Assets)" subtitle="الأصول وحسابات النقدية والمدينين والمخزون">
                <table className="rh-table">
                  <thead>
                    <tr>
                      <th>كود</th>
                      <th>اسم الحساب</th>
                      <th style={{ textAlign: 'left' }}>الرصيد</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.assets.current_assets.map((item) => (
                      <tr key={item.code}>
                        <td><code>{item.code}</code></td>
                        <td><strong>{item.name_ar}</strong></td>
                        <td style={{ textAlign: 'left' }}>{formatMoney(item.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={2}><strong>إجمالي الأصول</strong></td>
                      <td style={{ textAlign: 'left' }}><strong>{formatMoney(data.assets.total_assets)}</strong></td>
                    </tr>
                  </tfoot>
                </table>
              </Panel>
            )}

            {/* Liabilities & Equity Side */}
            {(showLiabilities || showEquity) && (
              <div>
                {showLiabilities && (
                  <Panel title="الخصوم المتداولة (Liabilities)" subtitle="مستحقات الموردين والالتزامات المتداولة">
                    <table className="rh-table">
                      <thead>
                        <tr>
                          <th>كود</th>
                          <th>اسم الحساب</th>
                          <th style={{ textAlign: 'left' }}>الرصيد</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.liabilities.current_liabilities.map((item) => (
                          <tr key={item.code}>
                            <td><code>{item.code}</code></td>
                            <td><strong>{item.name_ar}</strong></td>
                            <td style={{ textAlign: 'left' }}>{formatMoney(item.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr>
                          <td colSpan={2}><strong>إجمالي الخصوم</strong></td>
                          <td style={{ textAlign: 'left' }}><strong>{formatMoney(data.liabilities.total_liabilities)}</strong></td>
                        </tr>
                      </tfoot>
                    </table>
                  </Panel>
                )}

                {showEquity && (
                  <div style={{ marginTop: showLiabilities ? '1.5rem' : '0' }}>
                    <Panel title="حقوق الملكية (Equity)" subtitle="رأس المال المدفوع والأرباح/الخسائر المرحلة">
                      <table className="rh-table">
                        <thead>
                          <tr>
                            <th>كود</th>
                            <th>اسم الحساب</th>
                            <th style={{ textAlign: 'left' }}>الرصيد</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.equity.equity_items.map((item) => (
                            <tr key={item.code}>
                              <td><code>{item.code}</code></td>
                              <td><strong>{item.name_ar}</strong></td>
                              <td style={{ textAlign: 'left' }}>{formatMoney(item.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr>
                            <td colSpan={2}><strong>إجمالي حقوق الملكية</strong></td>
                            <td style={{ textAlign: 'left' }}><strong>{formatMoney(data.equity.total_equity)}</strong></td>
                          </tr>
                          {subTab === 'all' && (
                            <tr style={{ background: '#f8fafc' }}>
                              <td colSpan={2}><strong>إجمالي الخصوم وحقوق الملكية</strong></td>
                              <td style={{ textAlign: 'left' }}>
                                <strong>{formatMoney(data.total_liabilities_and_equity)}</strong>
                              </td>
                            </tr>
                          )}
                        </tfoot>
                      </table>
                    </Panel>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Opening Balances Modal */}
          {showOpeningModal && (
            <div
              className="modal-backdrop"
              onClick={() => setShowOpeningModal(false)}
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
                  maxWidth: '850px',
                  width: '100%',
                  background: '#fff',
                  borderRadius: '12px',
                  padding: '24px',
                  maxHeight: '90vh',
                  overflowY: 'auto',
                }}
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-labelledby="opening-modal-title"
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
                  <h3 id="opening-modal-title" style={{ margin: 0, fontSize: '1.25rem' }}>
                    تسجيل واعتماد القيد الافتتاحي للنظام
                  </h3>
                  <button type="button" className="btn btn--secondary btn--sm" onClick={() => setShowOpeningModal(false)}>
                    إغلاق ✕
                  </button>
                </div>

                {openingError && <div className="rh-state rh-state--error" style={{ marginBottom: '1rem' }}>{openingError}</div>}
                {openingSuccess && <div className="rh-state" style={{ background: '#ecfdf5', color: '#047857', borderColor: '#10b981', marginBottom: '1rem' }}>{openingSuccess}</div>}

                <form onSubmit={handleSubmitOpening}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', marginBottom: '1.5rem' }}>
                    {/* الطرف المدين: الأصول */}
                    <fieldset style={{ border: '1px solid #cbd5e1', borderRadius: '8px', padding: '1rem' }}>
                      <legend style={{ fontWeight: 700, color: '#0f172a', padding: '0 0.5rem' }}>طرف الأصول (المدين)</legend>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                        <label>
                          <span style={{ display: 'block', fontSize: '0.85rem' }}>تاريخ بداية المحاسبة:</span>
                          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required className="form-input" style={{ width: '100%', padding: '6px' }} />
                        </label>
                        <label>
                          <span style={{ display: 'block', fontSize: '0.85rem' }}>رصيد الخزينة الرئيسية (1010):</span>
                          <input type="number" step="0.01" min="0" value={treasuryBal} onChange={(e) => setTreasuryBal(e.target.value)} className="form-input" style={{ width: '100%', padding: '6px' }} />
                        </label>
                        <label>
                          <span style={{ display: 'block', fontSize: '0.85rem' }}>رصيد البنك (1020):</span>
                          <input type="number" step="0.01" min="0" value={bankBal} onChange={(e) => setBankBal(e.target.value)} className="form-input" style={{ width: '100%', padding: '6px' }} />
                        </label>
                        <label>
                          <span style={{ display: 'block', fontSize: '0.85rem' }}>رصيد العهد النقدية المؤقتة (1030):</span>
                          <input type="number" step="0.01" min="0" value={custodyBal} onChange={(e) => setCustodyBal(e.target.value)} className="form-input" style={{ width: '100%', padding: '6px' }} />
                        </label>
                        <label>
                          <span style={{ display: 'block', fontSize: '0.85rem' }}>أرصدة العملاء والمدينين (1100):</span>
                          <input type="number" step="0.01" min="0" value={arBal} onChange={(e) => setArBal(e.target.value)} className="form-input" style={{ width: '100%', padding: '6px' }} />
                        </label>
                        <label>
                          <span style={{ display: 'block', fontSize: '0.85rem' }}>مخزون الخامات (1210):</span>
                          <input type="number" step="0.01" min="0" value={rawBal} onChange={(e) => setRawBal(e.target.value)} className="form-input" style={{ width: '100%', padding: '6px' }} />
                        </label>
                        <label>
                          <span style={{ display: 'block', fontSize: '0.85rem' }}>مخزون تحت التشغيل (1220):</span>
                          <input type="number" step="0.01" min="0" value={wipBal} onChange={(e) => setWipBal(e.target.value)} className="form-input" style={{ width: '100%', padding: '6px' }} />
                        </label>
                        <label>
                          <span style={{ display: 'block', fontSize: '0.85rem' }}>مخزون تام الصنع (1230):</span>
                          <input type="number" step="0.01" min="0" value={finishedBal} onChange={(e) => setFinishedBal(e.target.value)} className="form-input" style={{ width: '100%', padding: '6px' }} />
                        </label>
                        <div style={{ marginTop: '0.5rem', fontWeight: 700, textAlign: 'left', color: '#0f172a' }}>
                          إجمالي الأصول: {totalAssetsInput.toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م
                        </div>
                      </div>
                    </fieldset>

                    {/* الطرف الدائن: الخصوم وحقوق الملكية */}
                    <fieldset style={{ border: '1px solid #cbd5e1', borderRadius: '8px', padding: '1rem' }}>
                      <legend style={{ fontWeight: 700, color: '#0f172a', padding: '0 0.5rem' }}>طرف الخصوم ورأس المال (الدائن)</legend>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                        <label>
                          <span style={{ display: 'block', fontSize: '0.85rem' }}>مستحقات الموردين والدائنين (2000):</span>
                          <input type="number" step="0.01" min="0" value={apBal} onChange={(e) => setApBal(e.target.value)} className="form-input" style={{ width: '100%', padding: '6px' }} />
                        </label>
                        <label>
                          <span style={{ display: 'block', fontSize: '0.85rem' }}>رأس المال المدفوع (3000):</span>
                          <input type="number" step="0.01" min="0" value={capitalBal} onChange={(e) => setCapitalBal(e.target.value)} className="form-input" style={{ width: '100%', padding: '6px' }} />
                        </label>
                        <div style={{ marginTop: '0.5rem', fontWeight: 700, textAlign: 'left', color: '#0f172a' }}>
                          إجمالي الخصوم ورأس المال: {totalLiabEquityInput.toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م
                        </div>

                        <div style={{ marginTop: '1.5rem', padding: '1rem', background: isInputBalanced ? '#ecfdf5' : '#fef2f2', border: `1px solid ${isInputBalanced ? '#10b981' : '#ef4444'}`, borderRadius: '6px' }}>
                          <div style={{ fontWeight: 700, color: isInputBalanced ? '#047857' : '#b91c1c' }}>
                            {isInputBalanced ? '✅ القيد متزن تماماً' : `⚠️ الفرق الحسابي: ${diffInput.toFixed(2)} ج.م`}
                          </div>
                          <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.8rem', color: '#475569' }}>
                            {isInputBalanced
                              ? 'يمكن اعتماد وترحيل القيد الافتتاحي الآن.'
                              : 'لا يمكن اعتماد القيد حتى يتساوى طرف الأصول تماماً مع طرف الخصوم وحقوق الملكية.'}
                          </p>
                        </div>

                        <label style={{ marginTop: '1rem' }}>
                          <span style={{ display: 'block', fontSize: '0.85rem' }}>ملاحظات القيد:</span>
                          <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} className="form-input" style={{ width: '100%', padding: '6px' }} />
                        </label>
                      </div>
                    </fieldset>
                  </div>

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
                    <button type="button" className="btn btn--secondary" onClick={() => setShowOpeningModal(false)}>
                      إلغاء
                    </button>
                    <button
                      type="submit"
                      className="btn btn--primary"
                      disabled={!isInputBalanced || openingSubmitting}
                    >
                      {openingSubmitting ? 'جارٍ الاعتماد والترحيل...' : 'اعتماد وترحيل القيد الافتتاحي 🚀'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
