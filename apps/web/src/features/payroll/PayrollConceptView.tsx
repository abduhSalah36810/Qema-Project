import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import { ApiError } from '@/lib/api';
import {
  payrollApi,
  type AttendanceRecord,
  type AttendanceStatus,
  type Employee,
  type PayPeriod,
  type PayrollPeriodDetail,
} from './payrollApi';
import { EMPTY_PAY_VALUES, PayTypeFields, payPayload, payTypeSummary, validatePay, type PayFormValues } from './PayTypeFields';
import { PayrollSheet } from './PayrollSheet';

type PayrollTab = 'employees' | 'attendance' | 'periods';
type Notice = { kind: 'success' | 'error' | 'info'; text: string } | null;

const TABS: Array<{ id: PayrollTab; label: string }> = [
  { id: 'employees', label: 'ملفات العاملين' },
  { id: 'attendance', label: 'سجل الحضور' },
  { id: 'periods', label: 'فترات وكشوف المرتبات' },
];

const ATTENDANCE_STATUS_LABELS: Record<AttendanceStatus, string> = {
  present: 'حاضر',
  late: 'متأخر',
  absent_permitted: 'غياب بإذن',
  absent_unpermitted: 'غياب بدون إذن',
};

const PERIOD_STATUS_LABELS: Record<string, string> = {
  draft: 'مسودة',
  calculated: 'كشف مُعد للمراجعة',
  submitted: 'مقدم للصرف · بانتظار اعتماد الخزينة',
  paid: 'مصروف',
  closed: 'مغلق',
};


function fmtMoney(value: number | string | null | undefined): string {
  const n = Number(value ?? 0);
  return (Number.isFinite(n) ? n : 0).toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString('ar-EG');
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError || err instanceof Error) return err.message || fallback;
  return fallback;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function NoticeBox({ notice, onClose }: { notice: Notice; onClose?: () => void }) {
  if (!notice) return null;
  const palette =
    notice.kind === 'success'
      ? { bg: '#f0fdf4', bd: '#86efac', tx: '#166534' }
      : notice.kind === 'info'
      ? { bg: '#eff6ff', bd: '#bfdbfe', tx: '#1e40af' }
      : { bg: '#fff1f2', bd: '#fecdd3', tx: '#9f1239' };
  return (
    <div
      className="warehouse-alert"
      role={notice.kind === 'error' ? 'alert' : 'status'}
      style={{ backgroundColor: palette.bg, borderColor: palette.bd, color: palette.tx, display: 'flex', justifyContent: 'space-between', gap: '0.75rem' }}
    >
      <span>{notice.text}</span>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="إغلاق الرسالة" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontWeight: 700 }}>
          ✕
        </button>
      )}
    </div>
  );
}

const responsiveGrid = { gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))' } as const;

export function PayrollConceptView() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('finance:payroll:manage');
  const canCalculate = hasPermission('finance:payroll:calculate');
  const canSubmitForDisbursement = hasPermission('finance:payroll:disburse');

  const [activeTab, setActiveTab] = useState<PayrollTab>('employees');
  const [notice, setNotice] = useState<Notice>(null);

  // البيانات
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);
  const [periods, setPeriods] = useState<PayPeriod[]>([]);
  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(null);
  const [periodDetail, setPeriodDetail] = useState<PayrollPeriodDetail | null>(null);

  // حالات التحميل
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [busy, setBusy] = useState(false);

  // النماذج
  const [employeeForm, setEmployeeForm] = useState({ code: '', name: '', department: '', job_title: '' });
  const [employeePay, setEmployeePay] = useState<PayFormValues>(EMPTY_PAY_VALUES);
  const [employeeFormError, setEmployeeFormError] = useState('');
  const [attendanceForm, setAttendanceForm] = useState({
    employee_id: '',
    attendance_date: today(),
    status: 'present' as AttendanceStatus,
    delay_minutes: '0',
    overtime_hours: '0',
    notes: '',
  });
  const [attendanceFormError, setAttendanceFormError] = useState('');
  const [periodForm, setPeriodForm] = useState({ period_name: '', start_date: '', end_date: '' });
  const [periodFormError, setPeriodFormError] = useState('');

  const selectedPeriod = useMemo(
    () => periods.find((p) => p.id === selectedPeriodId) ?? periodDetail?.period ?? null,
    [periods, selectedPeriodId, periodDetail]
  );
  const activeEmployees = useMemo(() => employees.filter((e) => e.status === 'active'), [employees]);

  const loadPeriodDetail = useCallback(async (periodId: string) => {
    setDetailLoading(true);
    setDetailError('');
    try {
      const detail = await payrollApi.getPeriodRuns(periodId);
      setPeriodDetail(detail ?? null);
    } catch (err: unknown) {
      setPeriodDetail(null);
      setDetailError(errorText(err, 'تعذر تحميل كشف الفترة.'));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [empRows, attRows, periodRows] = await Promise.all([
        payrollApi.listEmployees(),
        payrollApi.listAttendance(),
        payrollApi.listPeriods(),
      ]);
      const safePeriods = Array.isArray(periodRows) ? periodRows : [];
      setEmployees(Array.isArray(empRows) ? empRows : []);
      setAttendance(Array.isArray(attRows) ? attRows : []);
      setPeriods(safePeriods);
      setSelectedPeriodId((current) => {
        if (current && safePeriods.some((p) => p.id === current)) return current;
        const open = safePeriods.find((p) => p.status !== 'paid' && p.status !== 'closed');
        return (open ?? safePeriods[0])?.id ?? null;
      });
    } catch (err: unknown) {
      setLoadError(errorText(err, 'تعذر تحميل بيانات الرواتب.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (selectedPeriodId) {
      void loadPeriodDetail(selectedPeriodId);
    } else {
      setPeriodDetail(null);
    }
  }, [selectedPeriodId, loadPeriodDetail]);

  /** تحديث الفترة داخل القائمة بعد أي إجراء على الكشف */
  const applyDetail = (detail: PayrollPeriodDetail) => {
    setPeriodDetail(detail);
    setPeriods((prev) => prev.map((p) => (p.id === detail.period.id ? detail.period : p)));
  };

  // ─── الإجراءات ────────────────────────────────────────────────────────────
  const handleCreateEmployee = async (e: FormEvent) => {
    e.preventDefault();
    setEmployeeFormError('');
    if (!employeeForm.code.trim() || !employeeForm.name.trim()) {
      setEmployeeFormError('كود الموظف واسمه مطلوبان.');
      return;
    }
    const payError = validatePay(employeePay);
    if (payError) {
      setEmployeeFormError(payError);
      return;
    }
    setBusy(true);
    try {
      const created = await payrollApi.createEmployee({
        code: employeeForm.code.trim(),
        name: employeeForm.name.trim(),
        department: employeeForm.department.trim() || 'production',
        job_title: employeeForm.job_title.trim(),
        ...payPayload(employeePay),
      });
      setEmployees((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name, 'ar')));
      setEmployeeForm({ code: '', name: '', department: '', job_title: '' });
      setEmployeePay(EMPTY_PAY_VALUES);
      setNotice({ kind: 'success', text: `تمت إضافة الموظف ${created.name} (${created.code}).` });
    } catch (err: unknown) {
      setEmployeeFormError(errorText(err, 'تعذر إضافة الموظف.'));
    } finally {
      setBusy(false);
    }
  };

  const handleRecordAttendance = async (e: FormEvent) => {
    e.preventDefault();
    setAttendanceFormError('');
    const delay = Number(attendanceForm.delay_minutes || 0);
    const overtime = Number(attendanceForm.overtime_hours || 0);
    if (!attendanceForm.employee_id) {
      setAttendanceFormError('اختر الموظف.');
      return;
    }
    if (!attendanceForm.attendance_date) {
      setAttendanceFormError('حدد تاريخ اليوم.');
      return;
    }
    if (!Number.isInteger(delay) || delay < 0 || !Number.isFinite(overtime) || overtime < 0) {
      setAttendanceFormError('دقائق التأخير يجب أن تكون عدداً صحيحاً ≥ 0، وساعات الإضافي ≥ 0.');
      return;
    }
    setBusy(true);
    try {
      const rec = await payrollApi.recordAttendance({
        employee_id: attendanceForm.employee_id,
        attendance_date: attendanceForm.attendance_date,
        status: attendanceForm.status,
        delay_minutes: delay,
        overtime_hours: overtime,
        notes: attendanceForm.notes.trim(),
      });
      setAttendance((prev) => [rec, ...prev]);
      setAttendanceForm((f) => ({ ...f, delay_minutes: '0', overtime_hours: '0', notes: '' }));
      setNotice({ kind: 'success', text: `تم تسجيل حضور ${rec.employee_name} ليوم ${fmtDate(rec.attendance_date)}.` });
    } catch (err: unknown) {
      setAttendanceFormError(errorText(err, 'تعذر تسجيل الحضور.'));
    } finally {
      setBusy(false);
    }
  };

  const handleCreatePeriod = async (e: FormEvent) => {
    e.preventDefault();
    setPeriodFormError('');
    const { period_name, start_date, end_date } = periodForm;
    if (!period_name.trim() || !start_date || !end_date) {
      setPeriodFormError('اسم الفترة وتاريخ البداية والنهاية مطلوبة.');
      return;
    }
    if (end_date <= start_date) {
      setPeriodFormError('تاريخ نهاية الفترة يجب أن يكون بعد تاريخ البداية.');
      return;
    }
    setBusy(true);
    try {
      const created = await payrollApi.createPeriod({ period_name: period_name.trim(), start_date, end_date });
      setPeriods((prev) => [created, ...prev]);
      setSelectedPeriodId(created.id);
      setPeriodForm({ period_name: '', start_date: '', end_date: '' });
      setNotice({ kind: 'success', text: `تم إنشاء فترة الرواتب «${created.period_name}».` });
    } catch (err: unknown) {
      setPeriodFormError(errorText(err, 'تعذر إنشاء الفترة.'));
    } finally {
      setBusy(false);
    }
  };


  // ─── العرض ───────────────────────────────────────────────────────────────
  return (
    <section className="payroll-page" aria-labelledby="payroll-title" dir="rtl">
      <header className="payroll-page__header">
        <div>
          <span className="payroll-page__eyebrow">الموارد البشرية والرواتب</span>
          <h2 id="payroll-title">العمال والمرتبات</h2>
          <p>ملفات العاملين ونظام أجرهم، ثم كشف كل فترة: أيام عمل اليومية، الحوافز والخصومات، الصافي، والتقديم للصرف عبر الخزينة.</p>
        </div>
        <div className="payroll-page__header-actions">
          <button type="button" className="btn btn--secondary" onClick={() => void load()} disabled={loading || busy}>
            {loading ? 'جاري التحميل…' : 'تحديث'}
          </button>
        </div>
      </header>

      {loadError && (
        <div className="warehouse-alert" role="alert">
          تعذر تحميل بيانات الرواتب: {loadError}
        </div>
      )}
      <NoticeBox notice={notice} onClose={() => setNotice(null)} />
      {!canManage && !canCalculate && !loading && (
        <div className="warehouse-alert" role="status" style={{ backgroundColor: '#f8fafc', borderColor: '#e2e8f0', color: '#334155' }}>
          صلاحيتك على الرواتب للعرض فقط.
        </div>
      )}

      <div className="payroll-metrics" aria-label="ملخص وحدة المرتبات">
        <article>
          <span>العاملون</span>
          <strong>{loading ? '…' : employees.length.toLocaleString('ar-EG')}</strong>
          <small>{activeEmployees.length.toLocaleString('ar-EG')} نشط</small>
        </article>
        <article>
          <span>سجلات الحضور</span>
          <strong>{loading ? '…' : attendance.length.toLocaleString('ar-EG')}</strong>
          <small>آخر السجلات المسجلة (مرجع للمراجعة)</small>
        </article>
        <article>
          <span>فترات الرواتب</span>
          <strong>{loading ? '…' : periods.length.toLocaleString('ar-EG')}</strong>
          <small>{selectedPeriod ? `المحددة: ${selectedPeriod.period_name}` : 'لا توجد فترة محددة'}</small>
        </article>
        <article>
          <span>صافي كشف الفترة المحددة</span>
          <strong>{periodDetail ? `${fmtMoney(periodDetail.total_net)} ج.م` : '—'}</strong>
          <small>{selectedPeriod ? PERIOD_STATUS_LABELS[selectedPeriod.status] ?? selectedPeriod.status : '—'}</small>
        </article>
      </div>

      <nav className="payroll-tabs" aria-label="أقسام العمال والمرتبات">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={activeTab === tab.id ? 'payroll-tabs__tab payroll-tabs__tab--active' : 'payroll-tabs__tab'}
            onClick={() => setActiveTab(tab.id)}
            aria-current={activeTab === tab.id ? 'page' : undefined}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {/* ── ملفات العاملين ─────────────────────────────────────────────── */}
      {activeTab === 'employees' && (
        <section className="payroll-table-card" aria-labelledby="payroll-employees-title">
          <header>
            <div>
              <h3 id="payroll-employees-title">ملفات العاملين</h3>
              <p>نظام الأجر (شهري أو يومية) هو ما يدخل الكشف تلقائياً؛ الحوافز والخصومات تُضاف في كشف كل فترة.</p>
            </div>
          </header>

          {canManage && (
            <form onSubmit={(e) => void handleCreateEmployee(e)} style={{ padding: '1rem', borderBottom: '1px solid #e2e8f0' }} aria-label="إضافة موظف">
              <div className="form-grid" style={responsiveGrid}>
                <label className="form-field">
                  <span className="form-label">كود الموظف *</span>
                  <input className="form-input" required maxLength={64} value={employeeForm.code} onChange={(e) => setEmployeeForm({ ...employeeForm, code: e.target.value })} />
                </label>
                <label className="form-field">
                  <span className="form-label">الاسم *</span>
                  <input className="form-input" required maxLength={128} value={employeeForm.name} onChange={(e) => setEmployeeForm({ ...employeeForm, name: e.target.value })} />
                </label>
                <label className="form-field">
                  <span className="form-label">القسم</span>
                  <input className="form-input" maxLength={64} value={employeeForm.department} onChange={(e) => setEmployeeForm({ ...employeeForm, department: e.target.value })} />
                </label>
                <label className="form-field">
                  <span className="form-label">المسمى الوظيفي</span>
                  <input className="form-input" maxLength={64} value={employeeForm.job_title} onChange={(e) => setEmployeeForm({ ...employeeForm, job_title: e.target.value })} />
                </label>
              </div>
              <PayTypeFields values={employeePay} onChange={setEmployeePay} />
              {employeeFormError && <div className="warehouse-alert" role="alert" style={{ marginTop: '0.75rem' }}>{employeeFormError}</div>}
              <div style={{ marginTop: '0.75rem' }}>
                <button type="submit" className="btn btn--primary" disabled={busy}>إضافة موظف</button>
              </div>
            </form>
          )}

          <div className="payroll-table-wrap">
            <table className="payroll-table">
              <thead><tr><th>الكود</th><th>الاسم</th><th>القسم والوظيفة</th><th>الحالة</th><th>نظام الأجر</th></tr></thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={5}><div className="payroll-empty-state"><span aria-hidden>⌛</span><strong>جاري التحميل…</strong></div></td></tr>
                ) : employees.length === 0 ? (
                  <tr><td colSpan={5}><div className="payroll-empty-state"><span aria-hidden>▤</span><strong>لا توجد ملفات عاملين مسجلة.</strong>{canManage && <small>أضف أول موظف من النموذج أعلاه.</small>}</div></td></tr>
                ) : (
                  employees.map((emp) => (
                    <tr key={emp.id}>
                      <td>{emp.code}</td>
                      <td>{emp.name}</td>
                      <td>{emp.department}{emp.job_title ? ` · ${emp.job_title}` : ''}</td>
                      <td>{emp.status === 'active' ? 'نشط' : 'غير نشط'}</td>
                      <td>{payTypeSummary(emp)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── سجل الحضور ─────────────────────────────────────────────────── */}
      {activeTab === 'attendance' && (
        <section className="payroll-table-card" aria-labelledby="payroll-attendance-title">
          <header>
            <div>
              <h3 id="payroll-attendance-title">سجل الحضور</h3>
              <p>سجل الحضور مرجع للمراجعة فقط؛ لا يُحتسب منه خصم أو إضافي تلقائياً.</p>
            </div>
          </header>

          {canManage && (
            <form onSubmit={(e) => void handleRecordAttendance(e)} style={{ padding: '1rem', borderBottom: '1px solid #e2e8f0' }} aria-label="تسجيل حضور">
              <div className="form-grid" style={responsiveGrid}>
                <label className="form-field">
                  <span className="form-label">الموظف *</span>
                  <select className="form-select form-input" required value={attendanceForm.employee_id} onChange={(e) => setAttendanceForm({ ...attendanceForm, employee_id: e.target.value })}>
                    <option value="">اختر الموظف</option>
                    {activeEmployees.map((emp) => (
                      <option key={emp.id} value={emp.id}>{emp.name} ({emp.code})</option>
                    ))}
                  </select>
                </label>
                <label className="form-field">
                  <span className="form-label">التاريخ *</span>
                  <input className="form-input" required type="date" value={attendanceForm.attendance_date} onChange={(e) => setAttendanceForm({ ...attendanceForm, attendance_date: e.target.value })} />
                </label>
                <label className="form-field">
                  <span className="form-label">الحالة *</span>
                  <select className="form-select form-input" value={attendanceForm.status} onChange={(e) => setAttendanceForm({ ...attendanceForm, status: e.target.value as AttendanceStatus })}>
                    {(Object.keys(ATTENDANCE_STATUS_LABELS) as AttendanceStatus[]).map((s) => (
                      <option key={s} value={s}>{ATTENDANCE_STATUS_LABELS[s]}</option>
                    ))}
                  </select>
                </label>
                <label className="form-field">
                  <span className="form-label">تأخير (دقيقة)</span>
                  <input className="form-input" type="number" min="0" step="1" value={attendanceForm.delay_minutes} onChange={(e) => setAttendanceForm({ ...attendanceForm, delay_minutes: e.target.value })} />
                </label>
                <label className="form-field">
                  <span className="form-label">إضافي (ساعة)</span>
                  <input className="form-input" type="number" min="0" step="0.25" value={attendanceForm.overtime_hours} onChange={(e) => setAttendanceForm({ ...attendanceForm, overtime_hours: e.target.value })} />
                </label>
                <label className="form-field">
                  <span className="form-label">ملاحظات</span>
                  <input className="form-input" maxLength={1000} value={attendanceForm.notes} onChange={(e) => setAttendanceForm({ ...attendanceForm, notes: e.target.value })} />
                </label>
              </div>
              {activeEmployees.length === 0 && !loading && <p className="form-hint" style={{ fontSize: '0.8rem' }}>لا يوجد موظفون نشطون لتسجيل حضورهم.</p>}
              {attendanceFormError && <div className="warehouse-alert" role="alert" style={{ marginTop: '0.75rem' }}>{attendanceFormError}</div>}
              <div style={{ marginTop: '0.75rem' }}>
                <button type="submit" className="btn btn--primary" disabled={busy || activeEmployees.length === 0}>تسجيل الحضور</button>
              </div>
            </form>
          )}

          <div className="payroll-table-wrap">
            <table className="payroll-table">
              <thead><tr><th>التاريخ</th><th>الموظف</th><th>الحالة</th><th>تأخير (دقيقة)</th><th>إضافي (ساعة)</th><th>ملاحظات</th></tr></thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6}><div className="payroll-empty-state"><span aria-hidden>⌛</span><strong>جاري التحميل…</strong></div></td></tr>
                ) : attendance.length === 0 ? (
                  <tr><td colSpan={6}><div className="payroll-empty-state"><span aria-hidden>▤</span><strong>لا توجد سجلات حضور.</strong></div></td></tr>
                ) : (
                  attendance.map((rec) => (
                    <tr key={rec.id}>
                      <td>{fmtDate(rec.attendance_date)}</td>
                      <td>{rec.employee_name}</td>
                      <td>{ATTENDANCE_STATUS_LABELS[rec.status] ?? rec.status}</td>
                      <td>{rec.delay_minutes}</td>
                      <td>{rec.overtime_hours}</td>
                      <td>{rec.notes}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── فترات وكشوف المرتبات ──────────────────────────────────────── */}
      {activeTab === 'periods' && (
        <>
          <section className="payroll-table-card" aria-labelledby="payroll-periods-title">
            <header>
              <div>
                <h3 id="payroll-periods-title">فترات الرواتب</h3>
                <p>لا يُسمح بتداخل الفترات، ويجب أن يكون تاريخ النهاية بعد البداية.</p>
              </div>
            </header>

            {canManage && (
              <form onSubmit={(e) => void handleCreatePeriod(e)} style={{ padding: '1rem', borderBottom: '1px solid #e2e8f0' }} aria-label="إنشاء فترة رواتب">
                <div className="form-grid" style={responsiveGrid}>
                  <label className="form-field">
                    <span className="form-label">اسم الفترة *</span>
                    <input className="form-input" required maxLength={64} placeholder="مثال: رواتب نوفمبر" value={periodForm.period_name} onChange={(e) => setPeriodForm({ ...periodForm, period_name: e.target.value })} />
                  </label>
                  <label className="form-field">
                    <span className="form-label">من *</span>
                    <input className="form-input" required type="date" value={periodForm.start_date} onChange={(e) => setPeriodForm({ ...periodForm, start_date: e.target.value })} />
                  </label>
                  <label className="form-field">
                    <span className="form-label">إلى *</span>
                    <input className="form-input" required type="date" min={periodForm.start_date || undefined} value={periodForm.end_date} onChange={(e) => setPeriodForm({ ...periodForm, end_date: e.target.value })} />
                  </label>
                </div>
                {periodFormError && <div className="warehouse-alert" role="alert" style={{ marginTop: '0.75rem' }}>{periodFormError}</div>}
                <div style={{ marginTop: '0.75rem' }}>
                  <button type="submit" className="btn btn--primary" disabled={busy}>إنشاء الفترة</button>
                </div>
              </form>
            )}

            <div className="payroll-table-wrap">
              <table className="payroll-table">
                <thead><tr><th>الفترة</th><th>من</th><th>إلى</th><th>الحالة</th><th>عدد الكشوف</th><th>صافي الكشف</th><th></th></tr></thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={7}><div className="payroll-empty-state"><span aria-hidden>⌛</span><strong>جاري التحميل…</strong></div></td></tr>
                  ) : periods.length === 0 ? (
                    <tr><td colSpan={7}><div className="payroll-empty-state"><span aria-hidden>▤</span><strong>لا توجد فترات رواتب.</strong>{canManage && <small>أنشئ أول فترة من النموذج أعلاه.</small>}</div></td></tr>
                  ) : (
                    periods.map((p) => (
                      <tr key={p.id} aria-selected={p.id === selectedPeriodId}>
                        <td>{p.period_name}</td>
                        <td>{fmtDate(p.start_date)}</td>
                        <td>{fmtDate(p.end_date)}</td>
                        <td>{PERIOD_STATUS_LABELS[p.status] ?? p.status}</td>
                        <td>{p.runs_count.toLocaleString('ar-EG')}</td>
                        <td>{fmtMoney(p.total_net_amount)} ج.م</td>
                        <td>
                          <button type="button" className="btn btn--secondary btn--sm" onClick={() => setSelectedPeriodId(p.id)} disabled={p.id === selectedPeriodId}>
                            {p.id === selectedPeriodId ? 'معروضة' : 'عرض الكشف'}
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {selectedPeriod && (
            <PayrollSheet
              key={selectedPeriod.id}
              period={selectedPeriod}
              detail={periodDetail}
              detailLoading={detailLoading}
              detailError={detailError}
              employees={employees}
              canCalculate={canCalculate}
              canSubmit={canSubmitForDisbursement}
              onDetail={applyDetail}
              onReloadDetail={() => void loadPeriodDetail(selectedPeriod.id)}
              onNotice={setNotice}
            />
          )}
        </>
      )}

    </section>
  );
}
