import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ApiError } from '@/lib/api';
import { useDialog } from '@/components/feedback/DialogProvider';
import { CALC_METHOD_LABELS, ITEM_CATEGORIES } from './payrollItems';
import {
  payrollApi,
  type CalcMethod,
  type Employee,
  type ItemCategory,
  type PayPeriod,
  type PayrollItem,
  type PayrollPeriodDetail,
  type PayrollRun,
} from './payrollApi';
import { payTypeSummary } from './PayTypeFields';

/**
 * كشف رواتب الفترة للمدير المالي:
 * اختيار الموظفين ← أيام عمل اليومية ← إضافة الحوافز والخصومات من قائمة ← رؤية الصافي ← المراجعة والتقديم للصرف.
 * لا يُطبَّق أي بند تلقائياً، وكل الحسابات النهائية من الخادم (المعاينة هنا للعرض فقط).
 */
interface Props {
  period: PayPeriod;
  detail: PayrollPeriodDetail | null;
  detailLoading: boolean;
  detailError: string;
  employees: Employee[];
  canCalculate: boolean;
  canSubmit: boolean;
  onDetail: (detail: PayrollPeriodDetail) => void;
  onReloadDetail: () => void;
  onNotice: (notice: { kind: 'success' | 'error' | 'info'; text: string }) => void;
}

const PERIOD_STATUS_LABELS: Record<string, string> = {
  draft: 'مسودة · لم يُعد الكشف',
  calculated: 'كشف قيد الإعداد والمراجعة',
  submitted: 'مقدم للصرف · بانتظار اعتماد الخزينة',
  paid: 'مصروف',
  closed: 'مغلق',
};
const EDITABLE = new Set(['draft', 'calculated']);

function money(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  return (Number.isFinite(n) ? n : 0).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError || err instanceof Error ? err.message || fallback : fallback;
}

/** وصف مصدر مبلغ البند بلغة المحاسب */
export function itemFormula(item: Pick<PayrollItem, 'calc_method' | 'value' | 'quantity' | 'percent_base' | 'category'>): string {
  if (item.calc_method === 'fixed') return 'مبلغ ثابت';
  if (item.calc_method === 'percent') return `${money(item.value)}% × ${money(item.percent_base)} (الأساسي)`;
  const unit = ITEM_CATEGORIES[item.category]?.unit ?? 'وحدة';
  return `${Number(item.quantity ?? 0).toLocaleString('ar-EG')} ${unit} × ${money(item.value)}`;
}

const INCENTIVE_CATEGORIES = (Object.keys(ITEM_CATEGORIES) as ItemCategory[]).filter((c) => ITEM_CATEGORIES[c].kind === 'incentive');
const DEDUCTION_CATEGORIES = (Object.keys(ITEM_CATEGORIES) as ItemCategory[]).filter((c) => ITEM_CATEGORIES[c].kind === 'deduction');

interface ItemDraft {
  category: ItemCategory | '';
  calc_method: CalcMethod;
  value: string;
  quantity: string;
  label: string;
  notes: string;
}
const EMPTY_DRAFT: ItemDraft = { category: '', calc_method: 'fixed', value: '', quantity: '', label: '', notes: '' };

export function PayrollSheet({ period, detail, detailLoading, detailError, employees, canCalculate, canSubmit, onDetail, onReloadDetail, onNotice }: Props) {
  const dialog = useDialog();
  const status = period.status;
  const editable = canCalculate && EDITABLE.has(status);
  const runs = useMemo(() => detail?.runs ?? [], [detail]);
  const activeEmployees = useMemo(() => employees.filter((e) => e.status === 'active'), [employees]);

  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ItemDraft>(EMPTY_DRAFT);
  const [draftError, setDraftError] = useState('');
  const [daysInput, setDaysInput] = useState('');
  const [printRunId, setPrintRunId] = useState<string | null | undefined>(undefined);

  const openRun = runs.find((r) => r.id === openRunId) ?? null;

  useEffect(() => {
    setDraft(EMPTY_DRAFT);
    setDraftError('');
    setDaysInput(openRun?.work_days != null ? String(openRun.work_days) : '');
  }, [openRunId]);

  // الطباعة بعد رسم منطقة الطباعة المطلوبة (الكشف كاملاً أو قسيمة موظف)
  useEffect(() => {
    if (printRunId === undefined) return;
    const done = () => setPrintRunId(undefined);
    window.addEventListener('afterprint', done, { once: true });
    window.print();
    return () => window.removeEventListener('afterprint', done);
  }, [printRunId]);

  const startSelection = () => {
    const current = new Set(runs.map((r) => r.employee_id));
    setChosen(current.size > 0 ? current : new Set(activeEmployees.map((e) => e.id)));
    setSelecting(true);
  };

  const prepare = async () => {
    if (chosen.size === 0) {
      onNotice({ kind: 'error', text: 'اختر موظفاً واحداً على الأقل.' });
      return;
    }
    const removing = runs.filter((r) => !chosen.has(r.employee_id));
    if (removing.length > 0) {
      const ok = await dialog.confirm({
        title: 'إزالة موظفين من الكشف؟',
        message: `سيُحذف من كشف هذه الفترة: ${removing.map((r) => r.employee_name).join('، ')} مع بنودهم المدخلة.`,
        confirmLabel: 'متابعة',
        tone: 'danger',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const result = await payrollApi.calculatePeriod(period.id, Array.from(chosen));
      onDetail(result);
      setSelecting(false);
      onNotice({
        kind: 'success',
        text: `أُعدّ الكشف لعدد ${result.runs.length.toLocaleString('ar-EG')} موظف بنظام أجر كل منهم. الخطوة التالية: أدخل أيام عمل اليومية، ثم الحوافز والخصومات لكل موظف.`,
      });
    } catch (err) {
      onNotice({ kind: 'error', text: errorText(err, 'تعذر إعداد الكشف.') });
    } finally {
      setBusy(false);
    }
  };

  const saveDays = async (run: PayrollRun) => {
    const days = Number(daysInput);
    if (daysInput.trim() === '' || !Number.isFinite(days) || days < 0 || days > 31) {
      setDraftError('أيام العمل رقم بين 0 و31.');
      return;
    }
    setBusy(true);
    setDraftError('');
    try {
      onDetail(await payrollApi.setWorkDays(period.id, run.id, days.toFixed(2)));
      onNotice({ kind: 'success', text: `سُجلت أيام عمل ${run.employee_name}: ${days.toLocaleString('ar-EG')} يوم.` });
    } catch (err) {
      setDraftError(errorText(err, 'تعذر حفظ أيام العمل.'));
    } finally {
      setBusy(false);
    }
  };

  const spec = draft.category ? ITEM_CATEGORIES[draft.category] : null;
  const previewAmount = (() => {
    if (!openRun || !spec) return null;
    const value = Number(draft.value);
    if (!Number.isFinite(value) || value <= 0) return null;
    if (draft.calc_method === 'fixed') return value;
    if (draft.calc_method === 'percent') return (openRun.base_amount * value) / 100;
    const qty = Number(draft.quantity);
    return Number.isFinite(qty) && qty > 0 ? qty * value : null;
  })();

  const addItem = async (ev: FormEvent) => {
    ev.preventDefault();
    if (!openRun || !draft.category || !spec) {
      setDraftError('اختر نوع البند.');
      return;
    }
    const value = Number(draft.value);
    if (!Number.isFinite(value) || value <= 0) {
      setDraftError(draft.calc_method === 'percent' ? 'أدخل النسبة المئوية.' : draft.calc_method === 'quantity' ? 'أدخل قيمة الوحدة.' : 'أدخل المبلغ.');
      return;
    }
    if (draft.calc_method === 'percent' && value > 100) {
      setDraftError('النسبة لا تتجاوز 100%.');
      return;
    }
    if (draft.calc_method === 'quantity' && !(Number(draft.quantity) > 0)) {
      setDraftError(`أدخل العدد (${spec.unit ?? 'وحدة'}).`);
      return;
    }
    if ((draft.category === 'incentive_other' || draft.category === 'other_deduction') && !draft.label.trim()) {
      setDraftError('اكتب اسم البند.');
      return;
    }
    setBusy(true);
    setDraftError('');
    try {
      const result = await payrollApi.addItem(period.id, openRun.id, {
        category: draft.category,
        calc_method: draft.calc_method,
        value: value.toFixed(2),
        quantity: draft.calc_method === 'quantity' ? Number(draft.quantity).toFixed(2) : undefined,
        label: draft.label.trim(),
        notes: draft.notes.trim(),
      });
      onDetail(result);
      setDraft({ ...EMPTY_DRAFT });
    } catch (err) {
      setDraftError(errorText(err, 'تعذر إضافة البند.'));
    } finally {
      setBusy(false);
    }
  };

  const removeItem = async (run: PayrollRun, item: PayrollItem) => {
    const ok = await dialog.confirm({
      title: `حذف بند «${item.label}»؟`,
      summary: [
        { label: 'الموظف', value: run.employee_name },
        { label: 'المبلغ', value: `${money(item.amount)} ج.م` },
      ],
      confirmLabel: 'حذف البند',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    try {
      onDetail(await payrollApi.removeItem(period.id, run.id, item.id));
    } catch (err) {
      onNotice({ kind: 'error', text: errorText(err, 'تعذر حذف البند.') });
    } finally {
      setBusy(false);
    }
  };

  const submitForPayment = async () => {
    if (!detail) return;
    const pendingDaily = runs.filter((r) => r.pay_type === 'daily' && (r.work_days == null || r.work_days === 0));
    const ok = await dialog.confirm({
      title: 'تقديم كشف الرواتب للصرف؟',
      summary: [
        { label: 'الفترة', value: period.period_name },
        { label: 'عدد الموظفين', value: runs.length.toLocaleString('ar-EG') },
        { label: 'إجمالي الصافي', value: `${money(detail.total_net)} ج.م` },
        { label: 'ما سيحدث', value: 'يُنشأ سند صرف واحد معلق في الخزينة. لا تُخصم النقدية حتى يعتمده مسؤول لم يشارك في إعداد الكشف.' },
        ...(pendingDaily.length > 0
          ? [{ label: 'تنبيه', value: `لم تُدخل أيام عمل: ${pendingDaily.map((r) => r.employee_name).join('، ')}` }]
          : []),
      ],
      confirmLabel: 'تقديم للصرف',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const updated = await payrollApi.submitPeriodForPayment(period.id);
      onDetail(updated);
      onNotice(updated.period.status === 'paid'
        ? { kind: 'success', text: 'تم صرف الكشف وخصم صافي الرواتب من الخزنة. الفترة الآن «مصروفة».' }
        : { kind: 'info', text: 'قُدّم الكشف للصرف. الخطوة التالية: يعتمده المدير المالي من «الخزينة والاعتمادات»؛ بعدها تصبح الفترة «مصروفة».' });
    } catch (err) {
      onNotice({ kind: 'error', text: errorText(err, 'تعذر تقديم الكشف للصرف.') });
    } finally {
      setBusy(false);
    }
  };

  const downloadExcel = async () => {
    setBusy(true);
    try {
      await payrollApi.downloadPeriodXlsx(period.id, `كشف-رواتب-${period.period_name}.xlsx`);
    } catch (err) {
      onNotice({ kind: 'error', text: errorText(err, 'تعذر تنزيل ملف Excel.') });
    } finally {
      setBusy(false);
    }
  };

  const printRuns = printRunId ? runs.filter((r) => r.id === printRunId) : runs;

  return (
    <section className="payroll-table-card payroll-sheet" aria-labelledby="payroll-sheet-title">
      <header className="payroll-sheet__head">
        <div>
          <h3 id="payroll-sheet-title">كشف الفترة: {period.period_name}</h3>
          <p>
            {new Date(period.start_date).toLocaleDateString('ar-EG')} — {new Date(period.end_date).toLocaleDateString('ar-EG')} ·{' '}
            <span className={`status-badge status-badge--${status === 'paid' ? 'done' : status === 'submitted' ? 'waiting' : 'action'}`}>
              {PERIOD_STATUS_LABELS[status] ?? status}
            </span>
          </p>
        </div>
        <div className="payroll-sheet__actions">
          {editable && (
            <button type="button" className="btn btn--primary" onClick={startSelection} disabled={busy}>
              {runs.length > 0 ? 'تعديل الموظفين في الكشف' : 'إعداد الكشف واختيار الموظفين'}
            </button>
          )}
          {canSubmit && status === 'calculated' && runs.length > 0 && (
            <button type="button" className="btn btn--teal" onClick={() => void submitForPayment()} disabled={busy}>
              مراجعة وتقديم للصرف
            </button>
          )}
          {runs.length > 0 && (
            <>
              <button type="button" className="btn btn--secondary" onClick={() => void downloadExcel()} disabled={busy}>تنزيل Excel</button>
              <button type="button" className="btn btn--secondary" onClick={() => setPrintRunId(null)}>طباعة / حفظ PDF</button>
            </>
          )}
        </div>
      </header>

      {status === 'submitted' && (
        <div className="notice notice--warning" role="status">قُدّم الكشف للصرف ولم تُخصم النقدية بعد. يعتمده مسؤول آخر من الخزينة؛ لا يمكن تعديله إلا إذا رُفض.</div>
      )}
      {status === 'paid' && <div className="notice notice--success" role="status">صُرفت رواتب هذه الفترة. الكشف محفوظ كما اعتُمد ولا يتأثر بتعديل ملفات الموظفين.</div>}
      {detailError && (
        <div className="notice notice--error" role="alert">
          <span>تعذر تحميل كشف الفترة: {detailError}</span>
          <button type="button" className="btn btn--secondary btn--sm" onClick={onReloadDetail}>إعادة المحاولة</button>
        </div>
      )}

      {selecting && (
        <div className="payroll-select" role="group" aria-label="اختيار موظفي الكشف">
          <div className="payroll-select__head">
            <strong>اختر الموظفين في كشف هذه الفترة ({chosen.size.toLocaleString('ar-EG')} من {activeEmployees.length.toLocaleString('ar-EG')})</strong>
            <div>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setChosen(new Set(activeEmployees.map((e) => e.id)))}>تحديد الكل</button>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setChosen(new Set())}>إلغاء التحديد</button>
            </div>
          </div>
          <ul className="payroll-select__list">
            {activeEmployees.map((e) => (
              <li key={e.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={chosen.has(e.id)}
                    onChange={(ev) => {
                      const next = new Set(chosen);
                      if (ev.target.checked) next.add(e.id);
                      else next.delete(e.id);
                      setChosen(next);
                    }}
                  />
                  <span><strong>{e.name}</strong> <small>{e.code} · {payTypeSummary(e)}</small></span>
                </label>
              </li>
            ))}
          </ul>
          {activeEmployees.length === 0 && <p className="form-hint">لا يوجد موظفون نشطون. أضفهم من «ملفات العاملين».</p>}
          <div className="payroll-select__foot">
            <button type="button" className="btn btn--primary" onClick={() => void prepare()} disabled={busy || chosen.size === 0}>
              {busy ? 'جاري الإعداد…' : 'إعداد الكشف'}
            </button>
            <button type="button" className="btn btn--secondary" onClick={() => setSelecting(false)} disabled={busy}>إلغاء</button>
          </div>
        </div>
      )}

      {detailLoading ? (
        <p className="home__empty">جاري تحميل الكشف…</p>
      ) : runs.length === 0 ? (
        <p className="home__empty">
          {editable ? 'لم يُعد كشف هذه الفترة بعد. اضغط «إعداد الكشف واختيار الموظفين».' : 'لا توجد أسطر في كشف هذه الفترة.'}
        </p>
      ) : (
        <div className="payroll-table-wrap">
          <table className="payroll-table payroll-sheet__table">
            <thead>
              <tr>
                <th>الموظف</th>
                <th>نظام الأجر</th>
                <th>الأساسي</th>
                <th>الحوافز</th>
                <th>الخصومات</th>
                <th>الصافي</th>
                <th aria-label="إجراء" />
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => {
                const needsDays = run.pay_type === 'daily' && (run.work_days == null || run.work_days === 0);
                return (
                  <tr key={run.id} className={run.id === openRunId ? 'payroll-sheet__row--open' : ''}>
                    <td><strong>{run.employee_name}</strong><br /><small>{run.employee_code}</small></td>
                    <td>
                      {run.pay_type === 'daily'
                        ? <>يومية · {money(run.rate_amount)} × {run.work_days != null ? run.work_days.toLocaleString('ar-EG') : '—'} يوم</>
                        : <>شهري · {money(run.rate_amount)}</>}
                      {needsDays && <small className="payroll-sheet__warn">أدخل أيام العمل</small>}
                    </td>
                    <td>{money(run.base_amount)}</td>
                    <td className="payroll-sheet__plus">{money(run.bonus_amount + run.overtime_amount)}</td>
                    <td className="payroll-sheet__minus">{money(run.total_deductions)}</td>
                    <td><strong>{money(run.net_amount)}</strong></td>
                    <td>
                      <button type="button" className={`btn btn--sm ${run.id === openRunId ? 'btn--primary' : 'btn--secondary'}`} onClick={() => setOpenRunId(run.id === openRunId ? null : run.id)}>
                        {run.id === openRunId ? 'إخفاء' : editable ? 'الحوافز والخصومات' : 'التفاصيل'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {detail && (
              <tfoot>
                <tr>
                  <th>الإجمالي ({runs.length.toLocaleString('ar-EG')})</th>
                  <th />
                  <th>{money(detail.total_base)}</th>
                  <th className="payroll-sheet__plus">{money(detail.total_bonus + detail.total_overtime)}</th>
                  <th className="payroll-sheet__minus">{money(detail.total_deductions + detail.total_advances)}</th>
                  <th>{money(detail.total_net)} ج.م</th>
                  <th />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}

      {openRun && (
        <section className="payroll-run" aria-label={`كشف ${openRun.employee_name}`}>
          <header className="payroll-run__head">
            <div>
              <h4>{openRun.employee_name} <small>{openRun.employee_code}</small></h4>
              <p>{openRun.pay_type === 'daily' ? 'أجر يومية' : 'راتب شهري'} · {openRun.department}</p>
            </div>
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => setPrintRunId(openRun.id)}>طباعة القسيمة</button>
          </header>

          <div className="payroll-run__grid">
            <div className="payroll-run__basis">
              <h5>الأجر الأساسي للفترة</h5>
              {openRun.pay_type === 'daily' ? (
                <>
                  <p>{money(openRun.rate_amount)} ج.م لليوم × أيام العمل الفعلية</p>
                  {editable ? (
                    <div className="payroll-run__days">
                      <label>
                        أيام العمل <span className="field-required" aria-hidden>*</span>
                        <input type="number" min="0" max="31" step="0.5" inputMode="decimal" value={daysInput} placeholder="مثال: 24" onChange={(e) => setDaysInput(e.target.value)} />
                      </label>
                      <button type="button" className="btn btn--primary btn--sm" onClick={() => void saveDays(openRun)} disabled={busy}>حفظ الأيام</button>
                    </div>
                  ) : (
                    <p>أيام العمل: {openRun.work_days ?? '—'}</p>
                  )}
                </>
              ) : (
                <p>الراتب الشهري: {money(openRun.rate_amount)} ج.م</p>
              )}
              <dl className="payroll-run__totals">
                <div><dt>الأجر الأساسي</dt><dd>{money(openRun.base_amount)}</dd></div>
                <div><dt>+ الحوافز</dt><dd>{money(openRun.bonus_amount)}</dd></div>
                {openRun.overtime_amount > 0 && <div><dt>+ إضافي (سابق)</dt><dd>{money(openRun.overtime_amount)}</dd></div>}
                <div className="payroll-run__sub"><dt>= إجمالي المستحقات</dt><dd>{money(openRun.gross_amount)}</dd></div>
                <div><dt>− الخصومات</dt><dd>{money(openRun.deductions_amount)}</dd></div>
                {openRun.advances_amount > 0 && <div><dt>− سلف (سابق)</dt><dd>{money(openRun.advances_amount)}</dd></div>}
                <div className="payroll-run__net"><dt>= صافي الراتب</dt><dd>{money(openRun.net_amount)} ج.م</dd></div>
              </dl>
            </div>

            <div className="payroll-run__items">
              <h5>البنود المدخلة في هذه الفترة</h5>
              {openRun.items.length === 0 ? (
                <p className="form-hint">
                  {openRun.bonus_amount > 0 || openRun.deductions_amount > 0
                    ? 'هذا الكشف أُدخلت قيمه بالطريقة السابقة (إجماليات بدون بنود).'
                    : 'لا توجد حوافز أو خصومات. لا يُضاف أي بند تلقائياً.'}
                </p>
              ) : (
                <ul className="payroll-items">
                  {openRun.items.map((item) => (
                    <li key={item.id} className={`payroll-item payroll-item--${item.kind}`}>
                      <div>
                        <strong>{item.label}</strong>
                        <small>{itemFormula(item)}{item.notes ? ` · ${item.notes}` : ''}</small>
                      </div>
                      <span className="payroll-item__amount">{item.kind === 'incentive' ? '+' : '−'} {money(item.amount)}</span>
                      {editable && (
                        <button type="button" className="md-link md-link--muted" onClick={() => void removeItem(openRun, item)} disabled={busy} aria-label={`حذف ${item.label}`}>حذف</button>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {editable && (
                <form className="payroll-add" onSubmit={(e) => void addItem(e)} aria-label="إضافة حافز أو خصم">
                  <h5>إضافة حافز أو خصم</h5>
                  <div className="payroll-add__grid">
                    <label>
                      البند <span className="field-required" aria-hidden>*</span>
                      <select
                        value={draft.category}
                        onChange={(e) => {
                          const category = e.target.value as ItemCategory | '';
                          const methods = category ? ITEM_CATEGORIES[category].methods : (['fixed'] as CalcMethod[]);
                          setDraft({ ...draft, category, calc_method: methods[0], label: '' });
                          setDraftError('');
                        }}
                      >
                        <option value="">— اختر —</option>
                        <optgroup label="حوافز">
                          {INCENTIVE_CATEGORIES.map((c) => <option key={c} value={c}>{ITEM_CATEGORIES[c].label}</option>)}
                        </optgroup>
                        <optgroup label="خصومات">
                          {DEDUCTION_CATEGORIES.map((c) => <option key={c} value={c}>{ITEM_CATEGORIES[c].label}</option>)}
                        </optgroup>
                      </select>
                    </label>
                    {spec && spec.methods.length > 1 && (
                      <label>
                        طريقة الحساب
                        <select value={draft.calc_method} onChange={(e) => setDraft({ ...draft, calc_method: e.target.value as CalcMethod })}>
                          {spec.methods.map((m) => <option key={m} value={m}>{CALC_METHOD_LABELS[m]}</option>)}
                        </select>
                      </label>
                    )}
                    {spec && draft.calc_method === 'quantity' && (
                      <label>
                        العدد ({spec.unit ?? 'وحدة'}) <span className="field-required" aria-hidden>*</span>
                        <input type="number" min="0" step="0.5" inputMode="decimal" placeholder={spec.unit === 'ساعة' ? 'مثال: 2' : 'مثال: 1'} value={draft.quantity} onChange={(e) => setDraft({ ...draft, quantity: e.target.value })} />
                      </label>
                    )}
                    {spec && (
                      <label>
                        {draft.calc_method === 'percent' ? 'النسبة %' : draft.calc_method === 'quantity' ? `قيمة ${spec.unit ?? 'الوحدة'} (ج.م)` : 'المبلغ (ج.م)'} <span className="field-required" aria-hidden>*</span>
                        <input
                          type="number"
                          min="0"
                          step="0.01"
                          inputMode="decimal"
                          placeholder={draft.calc_method === 'percent' ? 'مثال: 10' : draft.calc_method === 'quantity' ? 'مثال: 300' : 'مثال: 200'}
                          value={draft.value}
                          onChange={(e) => setDraft({ ...draft, value: e.target.value })}
                        />
                      </label>
                    )}
                    {spec && (
                      <label>
                        {draft.category === 'incentive_other' || draft.category === 'other_deduction' ? <>اسم البند <span className="field-required" aria-hidden>*</span></> : 'اسم مخصص (اختياري)'}
                        <input maxLength={128} placeholder={spec.label} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
                      </label>
                    )}
                    {spec && (
                      <label className="payroll-add__wide">
                        ملاحظة (اختياري)
                        <input maxLength={1000} placeholder="مثال: غياب يوم 12" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
                      </label>
                    )}
                  </div>
                  {spec && (
                    <p className="payroll-add__preview">
                      {previewAmount != null
                        ? <>المبلغ: <strong>{spec.kind === 'incentive' ? '+' : '−'} {money(previewAmount)} ج.م</strong>{draft.calc_method === 'percent' && ` (من أساسي ${money(openRun.base_amount)})`}</>
                        : 'أدخل القيم لرؤية المبلغ.'}
                    </p>
                  )}
                  {draftError && <p className="field-error" role="alert">{draftError}</p>}
                  <button type="submit" className="btn btn--primary btn--sm" disabled={busy || !spec}>إضافة البند</button>
                </form>
              )}
            </div>
          </div>
        </section>
      )}

      {detail && runs.length > 0 && Object.keys(detail.category_totals).length > 0 && (
        <section className="payroll-breakdown" aria-label="تفصيل البنود في الفترة">
          <h5>تفصيل الحوافز والخصومات في الفترة</h5>
          <dl>
            {(Object.keys(ITEM_CATEGORIES) as ItemCategory[])
              .filter((c) => detail.category_totals[c] !== undefined)
              .map((c) => (
                <div key={c} className={`payroll-breakdown__${ITEM_CATEGORIES[c].kind}`}>
                  <dt>{ITEM_CATEGORIES[c].label}</dt>
                  <dd>{money(detail.category_totals[c])}</dd>
                </div>
              ))}
          </dl>
        </section>
      )}

      {/* منطقة الطباعة: الكشف كاملاً أو قسيمة موظف واحد (تظهر في الطباعة فقط) */}
      {printRunId !== undefined && detail && (
        <div className="payroll-print" aria-hidden>
          <h1>{printRunId ? 'قسيمة راتب' : 'كشف رواتب'} — {period.period_name}</h1>
          <p>من {new Date(period.start_date).toLocaleDateString('ar-EG')} إلى {new Date(period.end_date).toLocaleDateString('ar-EG')} · {PERIOD_STATUS_LABELS[status] ?? status}</p>
          {!printRunId && (
            <table>
              <thead><tr><th>الكود</th><th>الموظف</th><th>نظام الأجر</th><th>الأساسي</th><th>الحوافز</th><th>الخصومات</th><th>الصافي</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>{r.employee_code}</td><td>{r.employee_name}</td>
                    <td>{r.pay_type === 'daily' ? `يومية ${money(r.rate_amount)} × ${r.work_days ?? 0}` : `شهري ${money(r.rate_amount)}`}</td>
                    <td>{money(r.base_amount)}</td><td>{money(r.bonus_amount + r.overtime_amount)}</td><td>{money(r.total_deductions)}</td><td>{money(r.net_amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr><th colSpan={3}>الإجمالي</th><th>{money(detail.total_base)}</th><th>{money(detail.total_bonus + detail.total_overtime)}</th><th>{money(detail.total_deductions + detail.total_advances)}</th><th>{money(detail.total_net)}</th></tr></tfoot>
            </table>
          )}
          {printRuns.map((r) => (
            <section key={r.id} className="payroll-print__slip">
              <h2>{r.employee_name} ({r.employee_code})</h2>
              <p>{r.pay_type === 'daily' ? `أجر يومية: ${money(r.rate_amount)} × ${r.work_days ?? 0} يوم` : `راتب شهري: ${money(r.rate_amount)}`}</p>
              <table>
                <thead><tr><th>البند</th><th>طريقة الحساب</th><th>المبلغ</th></tr></thead>
                <tbody>
                  <tr><td>الأجر الأساسي</td><td>—</td><td>{money(r.base_amount)}</td></tr>
                  {r.items.map((i) => (
                    <tr key={i.id}><td>{i.label}{i.notes ? ` (${i.notes})` : ''}</td><td>{itemFormula(i)}</td><td>{i.kind === 'incentive' ? '+' : '−'} {money(i.amount)}</td></tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><th colSpan={2}>إجمالي المستحقات</th><th>{money(r.gross_amount)}</th></tr>
                  <tr><th colSpan={2}>إجمالي الخصومات</th><th>{money(r.total_deductions)}</th></tr>
                  <tr><th colSpan={2}>صافي الراتب</th><th>{money(r.net_amount)} ج.م</th></tr>
                </tfoot>
              </table>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
