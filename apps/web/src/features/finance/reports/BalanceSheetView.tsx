import React, { useState, useMemo, useEffect } from 'react';
import {
  financeApi,
  errorMessage,
  formatMoney,
  type BalanceSheetReport,
  type OpeningBalancesPayload,
  type CashAccount,
  type AccountingLockStatusRead,
} from '../financeApi';
import {
  KpiCard,
  KpiGrid,
  LoadState,
  Panel,
} from './reportUi';
import { useLoad } from '../FinancialReportsView';
import { OpeningLockStatusCard } from '../OpeningLockStatusCard';

export type BalanceSheetSubTab = 'all' | 'summary' | 'assets' | 'liabilities' | 'equity';

export function BalanceSheetView() {
  const [subTab, setSubTab] = useState<BalanceSheetSubTab>('all');

  const { data, loading, error, reload } = useLoad<BalanceSheetReport>(
    () => financeApi.getBalanceSheet(),
    [],
    'تعذر تحميل الميزانية العمومية.'
  );

  const [showOpeningModal, setShowOpeningModal] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [openingSubmitting, setOpeningSubmitting] = useState(false);
  const [openingError, setOpeningError] = useState('');
  const [openingSuccess, setOpeningSuccess] = useState('');
  const [bankAccounts, setBankAccounts] = useState<CashAccount[]>([]);
  const [bankAccountId, setBankAccountId] = useState('');

  const { data: lockStatus, reload: reloadLockStatus } = useLoad<AccountingLockStatusRead>(
    () => financeApi.getOpeningBalancesLockStatus(),
    [],
    'تعذر تحميل حالة قفل الأرصدة الافتتاحية.'
  );

  useEffect(() => {
    if (showOpeningModal) {
      void financeApi.getAccounts().then((accs) => {
        const banks = accs.filter((a) => a.account_type === 'bank' && a.is_active);
        setBankAccounts(banks);
        if (banks.length === 1 && !bankAccountId) {
          setBankAccountId(banks[0].id);
        }
      }).catch(() => {});
    }
  }, [showOpeningModal, bankAccountId]);

  // Form state for General Opening Balances (Restricted to Treasury, Bank, Capital)
  const [startDate, setStartDate] = useState('2026-01-01');
  const [treasuryBal, setTreasuryBal] = useState('0');
  const [bankBal, setBankBal] = useState('0');
  const [capitalBal, setCapitalBal] = useState('0');
  const [notes, setNotes] = useState('الأرصدة الافتتاحية المعتمدة للمصنع');

  const totalAssetsInput = useMemo(() => {
    return (parseFloat(treasuryBal) || 0) + (parseFloat(bankBal) || 0);
  }, [treasuryBal, bankBal]);

  const totalLiabEquityInput = useMemo(() => {
    return parseFloat(capitalBal) || 0;
  }, [capitalBal]);

  const diffInput = useMemo(() => {
    return Math.round((totalAssetsInput - totalLiabEquityInput) * 100) / 100;
  }, [totalAssetsInput, totalLiabEquityInput]);

  const isInputBalanced = Math.abs(diffInput) < 0.01 && totalAssetsInput > 0;

  const handleOpenConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isInputBalanced) {
      setOpeningError(`القيد غير متزن بمقدار ${formatMoney(diffInput)}. يجب أن تتساوى النقدية والبنوك تماماً مع رأس المال.`);
      return;
    }
    if (parseFloat(bankBal) > 0 && bankAccounts.length > 1 && !bankAccountId) {
      setOpeningError('يرجى اختيار الحساب البنكي المودع به رصيد البنك الافتتاحي.');
      return;
    }
    setOpeningError('');
    setShowConfirmModal(true);
  };

  const handleExecuteOpening = async () => {
    setOpeningSubmitting(true);
    setOpeningError('');
    try {
      const payload: OpeningBalancesPayload = {
        accounting_start_date: startDate,
        treasury_balance: treasuryBal,
        bank_balance: bankBal,
        bank_account_id: bankAccountId || undefined,
        paid_in_capital: capitalBal,
        notes,
      };
      await financeApi.createOpeningBalances(payload);
      setOpeningSuccess('تم تسجيل واعتماد القيد الافتتاحي بنجاح!');
      setShowConfirmModal(false);
      setTimeout(() => {
        setShowOpeningModal(false);
        reload();
        reloadLockStatus();
      }, 1200);
    } catch (err: unknown) {
      setOpeningError(errorMessage(err, 'فشل تسجيل القيد الافتتاحي.'));
      setShowConfirmModal(false);
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

          {/* Opening Balances Lock Status Card */}
          <OpeningLockStatusCard lockStatus={lockStatus} onReload={reloadLockStatus} />

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
                              <td>
                                <strong>{item.code === '3900' ? 'حقوق ملكية: أرصدة افتتاحية' : item.name_ar}</strong>
                                {item.code === '3900' && (
                                  <small style={{ display: 'block', color: '#64748b', fontSize: '0.78rem' }}>
                                    تسوية الحركات الافتتاحية الموزعة (المخزون + العملاء − الموردين)
                                  </small>
                                )}
                              </td>
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

                {/* Guide Box */}
                <div
                  style={{
                    background: '#eff6ff',
                    border: '1px solid #bfdbfe',
                    borderRadius: '8px',
                    padding: '0.9rem',
                    marginBottom: '1.25rem',
                    fontSize: '0.88rem',
                    color: '#1e40af',
                    lineHeight: '1.5',
                  }}
                >
                  <strong>ℹ️ تنبيه هام حول نطاق القيد الافتتاحي العام:</strong>
                  <div style={{ marginTop: '0.25rem' }}>
                    يقتصر هذا القيد على إثبات <strong>رصيد الخزينة، رصيد البنك، ورأس المال المدفوع</strong>.
                    أرصدة المخزون، والعملاء، والموردين تُسجَّل كلٌّ في شاشتها المتخصصة (الجرد الافتتاحي للمخزون، فواتير الموردين الافتتاحية، وأرصدة العملاء الافتتاحية) وتُسوَّى آلياً في حساب <code>3900 - حقوق ملكية: أرصدة افتتاحية</code>.
                    أما أرصدة العهد فتُسجَّل بعد يوم القطع بتحويل رسمي من الخزينة.
                  </div>
                </div>

                <form onSubmit={handleOpenConfirm}>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem', marginBottom: '1.5rem' }}>
                    {/* الطرف المدين: النقدية والبنوك */}
                    <fieldset style={{ border: '1px solid #cbd5e1', borderRadius: '8px', padding: '1rem' }}>
                      <legend style={{ fontWeight: 700, color: '#0f172a', padding: '0 0.5rem' }}>طرف الأصول النقدية (المدين)</legend>
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
                          <span style={{ display: 'block', fontSize: '0.85rem' }}>رصيد الحساب البنكي (1030):</span>
                          <input type="number" step="0.01" min="0" value={bankBal} onChange={(e) => setBankBal(e.target.value)} className="form-input" style={{ width: '100%', padding: '6px' }} />
                        </label>
                        {parseFloat(bankBal) > 0 && bankAccounts.length > 0 && (
                          <label>
                            <span style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, color: '#1e3a8a' }}>الحساب البنكي المودع به:</span>
                            <select
                              value={bankAccountId}
                              onChange={(e) => setBankAccountId(e.target.value)}
                              className="form-input"
                              style={{ width: '100%', padding: '6px' }}
                              required={bankAccounts.length > 1}
                            >
                              <option value="">-- اختر الحساب البنكي --</option>
                              {bankAccounts.map((b) => (
                                <option key={b.id} value={b.id}>
                                  {b.name} ({b.account_number || b.id})
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        <div style={{ marginTop: '0.5rem', fontWeight: 700, textAlign: 'left', color: '#0f172a' }}>
                          إجمالي النقدية والبنوك: {formatMoney(totalAssetsInput)}
                        </div>
                      </div>
                    </fieldset>

                    {/* الطرف الدائن: رأس المال المدفوع */}
                    <fieldset style={{ border: '1px solid #cbd5e1', borderRadius: '8px', padding: '1rem' }}>
                      <legend style={{ fontWeight: 700, color: '#0f172a', padding: '0 0.5rem' }}>طرف حقوق الملكية (الدائن)</legend>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                        <label>
                          <span style={{ display: 'block', fontSize: '0.85rem' }}>رأس المال المدفوع (3000):</span>
                          <input type="number" step="0.01" min="0" value={capitalBal} onChange={(e) => setCapitalBal(e.target.value)} className="form-input" style={{ width: '100%', padding: '6px' }} />
                        </label>
                        <div style={{ marginTop: '0.5rem', fontWeight: 700, textAlign: 'left', color: '#0f172a' }}>
                          إجمالي رأس المال: {formatMoney(totalLiabEquityInput)}
                        </div>

                        <div style={{ marginTop: '1.5rem', padding: '1rem', background: isInputBalanced ? '#ecfdf5' : '#fef2f2', border: `1px solid ${isInputBalanced ? '#10b981' : '#ef4444'}`, borderRadius: '6px' }}>
                          <div style={{ fontWeight: 700, color: isInputBalanced ? '#047857' : '#b91c1c' }}>
                            {isInputBalanced ? '✅ القيد متزن تماماً' : `⚠️ الفرق الحسابي: ${formatMoney(diffInput)}`}
                          </div>
                          <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.8rem', color: '#475569' }}>
                            {isInputBalanced
                              ? 'يمكن ترحيل القيد الافتتاحي الآن.'
                              : 'يجب أن يتساوى مجموع النقدية والبنك تماماً مع رأس المال المدفوع.'}
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
                      مراجعة وترحيل القيد الافتتاحي 🚀
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {/* Confirmation Modal */}
          {showConfirmModal && (
            <div
              className="modal-backdrop"
              onClick={() => setShowConfirmModal(false)}
              style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(15,23,42,0.6)',
                zIndex: 1300,
                display: 'grid',
                placeItems: 'center',
                padding: '16px',
              }}
            >
              <div
                className="modal-card"
                style={{
                  maxWidth: '520px',
                  width: '100%',
                  background: '#fff',
                  borderRadius: '12px',
                  padding: '24px',
                }}
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
              >
                <div style={{ color: '#b45309', fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.75rem' }}>
                  ⚠️ تأكيد ترحيل القيد الافتتاحي
                </div>
                <p style={{ fontSize: '0.95rem', color: '#334155', lineHeight: '1.6', marginBottom: '1.25rem' }}>
                  <strong>ترحيل هذا القيد يقفل الأرصدة الافتتاحية للمصنع.</strong>
                  <br />
                  سيتم إنشاء قيد اليومية الافتتاحي وحركات دفتر النقدية، وسيتم قفل فترة ما قبل بداية المحاسبة نهائياً. لا يمكن التعديل لاحقاً إلا بطلب فك قفل معتمد من الإدارة العامة.
                </p>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
                  <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={() => setShowConfirmModal(false)}
                    disabled={openingSubmitting}
                  >
                    تراجع
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={handleExecuteOpening}
                    disabled={openingSubmitting}
                  >
                    {openingSubmitting ? 'جارٍ الترحيل...' : 'تأكيد الترحيل النهائي وإقفال الأرصدة'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
