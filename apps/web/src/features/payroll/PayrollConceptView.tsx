import { useEffect, useState } from 'react';
import { payrollApi, type Employee, type AttendanceRecord, type PayPeriod, type PayrollPeriodDetail } from './payrollApi';

type PayrollTab = 'employees' | 'attendance' | 'adjustments' | 'statement';

const TABS: Array<{ id: PayrollTab; label: string }> = [
  { id: 'employees', label: 'ملفات العاملين' },
  { id: 'attendance', label: 'الحضور والأذونات' },
  { id: 'adjustments', label: 'السلف والحوافز' },
  { id: 'statement', label: 'كشف المرتبات' },
];

const OPEN_POLICIES = [
  'فترة المرتب وتاريخ بدايتها وإغلاقها',
  'تقويم العمل وطريقة توثيق الحضور والإذن',
  'معادلات الإضافي والتأخير والغياب والتقريب',
  'قواعد السلف والأقساط والحوافز والجزاءات',
  'من يطّلع على الأجور ومن يراجع ويعتمد الكشف',
];

const ATTENDANCE_STATUS_LABELS: Record<string, string> = {
  present: 'حاضر',
  absent_permitted: 'غياب بإذن',
  absent_unpermitted: 'غياب بدون إذن',
  on_leave: 'إجازة',
};

export function PayrollConceptView() {
  const [activeTab, setActiveTab] = useState<PayrollTab>('employees');

  // Data state
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);
  const [periods, setPeriods] = useState<PayPeriod[]>([]);
  const [activePeriod, setActivePeriod] = useState<PayPeriod | null>(null);
  const [periodDetail, setPeriodDetail] = useState<PayrollPeriodDetail | null>(null);

  // UI state
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [empRows, attRows, periodRows] = await Promise.all([
        payrollApi.listEmployees(),
        payrollApi.listAttendance(),
        payrollApi.listPeriods(),
      ]);
      setEmployees(empRows);
      setAttendance(attRows);
      setPeriods(periodRows);
      // Pick the most recent non-closed period as the active one
      const active = periodRows.find((p) => p.status !== 'closed') ?? periodRows[0] ?? null;
      setActivePeriod(active ?? null);
      if (active) {
        try {
          const detail = await payrollApi.getPeriodRuns(active.id);
          setPeriodDetail(detail);
        } catch {
          setPeriodDetail(null);
        }
      }
    } catch {
      setError('تعذر تحميل بيانات الرواتب. تحقق من تسجيل الدخول وصلاحية الوصول.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const handleCalculate = async () => {
    if (!activePeriod) return;
    setBusy(true);
    setError('');
    try {
      const detail = await payrollApi.calculatePeriod(activePeriod.id);
      setPeriodDetail(detail);
      // Refresh period list to get updated status
      const periodRows = await payrollApi.listPeriods();
      setPeriods(periodRows);
      const updated = periodRows.find((p) => p.id === activePeriod.id) ?? null;
      setActivePeriod(updated);
    } catch {
      setError('تعذر احتساب كشف المرتبات. راجع الصلاحية وبيانات الفترة.');
    } finally {
      setBusy(false);
    }
  };

  const handleDisburse = async () => {
    if (!activePeriod) return;
    if (!window.confirm('تأكيد صرف المرتبات للفترة الحالية؟ لا يمكن التراجع عن هذا الإجراء.')) return;
    setBusy(true);
    setError('');
    try {
      const detail = await payrollApi.disbursePeriod(activePeriod.id);
      setPeriodDetail(detail);
      const periodRows = await payrollApi.listPeriods();
      setPeriods(periodRows);
      const updated = periodRows.find((p) => p.id === activePeriod.id) ?? null;
      setActivePeriod(updated);
    } catch {
      setError('تعذر صرف المرتبات. راجع الصلاحية وحالة الفترة.');
    } finally {
      setBusy(false);
    }
  };

  const periodStatusLabel = (status: string) => {
    const map: Record<string, string> = {
      draft: 'مسودة',
      calculated: 'محتسب',
      paid: 'مصروف',
      closed: 'مغلق',
    };
    return map[status] ?? status;
  };

  return (
    <section className="payroll-page" aria-labelledby="payroll-title" dir="rtl">
      <header className="payroll-page__header">
        <div>
          <span className="payroll-page__eyebrow">الموارد البشرية</span>
          <h2 id="payroll-title">العمال والمرتبات</h2>
          <p>ملفات العاملين، الحضور، عناصر المرتب، ومراجعة كشف الفترة.</p>
        </div>
        <div className="payroll-page__header-actions">
          <button type="button" className="btn btn--secondary" onClick={() => void load()} disabled={loading || busy}>
            تحديث
          </button>
        </div>
      </header>

      {error && <div className="warehouse-alert" role="alert">{error}</div>}

      <div className="payroll-period-card">
        <div>
          <span>فترة المرتب الحالية</span>
          <strong>{activePeriod ? activePeriod.period_name : 'لم يتم تحديد الفترة'}</strong>
          {activePeriod && (
            <small>{activePeriod.start_date} — {activePeriod.end_date}</small>
          )}
        </div>
        <div>
          <span>حالة الكشف</span>
          <strong className={activePeriod?.status === 'paid' ? 'payroll-period-card__paid' : 'payroll-period-card__pending'}>
            {activePeriod ? periodStatusLabel(activePeriod.status) : 'بانتظار اعتماد السياسة'}
          </strong>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void handleCalculate()}
            disabled={busy || loading || !activePeriod || activePeriod.status === 'paid' || activePeriod.status === 'closed'}
            title={!activePeriod ? 'لا توجد فترة نشطة' : 'احتساب مرتبات الفترة'}
          >
            احسب الكشف
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void handleDisburse()}
            disabled={busy || loading || !activePeriod || activePeriod.status !== 'calculated'}
            title={activePeriod?.status !== 'calculated' ? 'يتاح بعد الاحتساب' : 'صرف المرتبات للفترة الحالية'}
          >
            صرف الرواتب
          </button>
        </div>
      </div>

      <div className="payroll-metrics" aria-label="ملخص وحدة المرتبات">
        <article>
          <span>العاملون</span>
          <strong>{loading ? '…' : employees.length}</strong>
          <small>{employees.filter((e) => e.status === 'active').length} نشط</small>
        </article>
        <article>
          <span>سجلات الحضور</span>
          <strong>{loading ? '…' : attendance.length}</strong>
          <small>للفترة الحالية</small>
        </article>
        <article>
          <span>عدد الكشوف</span>
          <strong>{loading ? '…' : (periodDetail?.runs.length ?? '—')}</strong>
          <small>{activePeriod ? activePeriod.period_name : 'لا يوجد كشف نشط'}</small>
        </article>
        <article>
          <span>إجمالي صافي المرتبات</span>
          <strong>
            {loading ? '…' : periodDetail
              ? periodDetail.total_net.toLocaleString('ar-EG', { minimumFractionDigits: 2 }) + ' ج.م'
              : '—'}
          </strong>
          <small>{activePeriod ? periodStatusLabel(activePeriod.status) : 'لا توجد فترة'}</small>
        </article>
      </div>

      <nav className="payroll-tabs" aria-label="أقسام العمال والمرتبات">
        {TABS.map((tab) => (
          <button key={tab.id} type="button" className={activeTab === tab.id ? 'payroll-tabs__tab payroll-tabs__tab--active' : 'payroll-tabs__tab'} onClick={() => setActiveTab(tab.id)} aria-current={activeTab === tab.id ? 'page' : undefined}>
            {tab.label}
          </button>
        ))}
      </nav>

      {/* Employees Tab */}
      {activeTab === 'employees' && (
        <section className="payroll-table-card" aria-labelledby="payroll-table-title">
          <header>
            <div><h3 id="payroll-table-title">ملفات العاملين</h3><p>بيانات العمل الأساسية للعاملين في المصنع.</p></div>
          </header>
          <div className="payroll-table-wrap">
            <table className="payroll-table">
              <thead><tr><th>كود العامل</th><th>اسم العامل</th><th>القسم والوظيفة</th><th>الحالة</th><th>الأجر الأساسي</th></tr></thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={5}><div className="payroll-empty-state"><span aria-hidden>⌛</span><strong>جاري التحميل…</strong></div></td></tr>
                ) : employees.length === 0 ? (
                  <tr><td colSpan={5}><div className="payroll-empty-state"><span aria-hidden>▤</span><strong>لا توجد ملفات عاملين مسجلة.</strong><small>أضف العاملين عبر الإعدادات أو API الموارد البشرية.</small></div></td></tr>
                ) : (
                  employees.map((emp) => (
                    <tr key={emp.id}>
                      <td>{emp.code}</td>
                      <td>{emp.name}</td>
                      <td>{emp.department} · {emp.job_title}</td>
                      <td>{emp.status === 'active' ? 'نشط' : 'غير نشط'}</td>
                      <td>{emp.base_salary.toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Attendance Tab */}
      {activeTab === 'attendance' && (
        <section className="payroll-table-card" aria-labelledby="payroll-table-title">
          <header>
            <div><h3 id="payroll-table-title">الحضور والأذونات</h3><p>سجلات الحضور والغياب المسجلة للفترة الحالية.</p></div>
          </header>
          <div className="payroll-table-wrap">
            <table className="payroll-table">
              <thead><tr><th>التاريخ</th><th>العامل</th><th>الحالة</th><th>تأخير (دقيقة)</th><th>إضافي (ساعة)</th><th>ملاحظات</th></tr></thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6}><div className="payroll-empty-state"><span aria-hidden>⌛</span><strong>جاري التحميل…</strong></div></td></tr>
                ) : attendance.length === 0 ? (
                  <tr><td colSpan={6}><div className="payroll-empty-state"><span aria-hidden>▤</span><strong>لا توجد سجلات حضور.</strong><small>سجّل الحضور عبر واجهة API الحضور.</small></div></td></tr>
                ) : (
                  attendance.map((rec) => (
                    <tr key={rec.id}>
                      <td>{rec.attendance_date}</td>
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

      {/* Adjustments Tab */}
      {activeTab === 'adjustments' && (
        <section className="payroll-table-card" aria-labelledby="payroll-table-title">
          <header>
            <div><h3 id="payroll-table-title">السلف والحوافز وعناصر المرتب</h3><p>إظهار البنود الإضافية والخصومات ومصدر كل بند.</p></div>
          </header>
          <div className="payroll-table-wrap">
            <table className="payroll-table">
              <thead><tr><th>العامل</th><th>نوع البند</th><th>القيمة</th><th>التاريخ أو الفترة</th><th>الحالة</th></tr></thead>
              <tbody>
                <tr><td colSpan={5}><div className="payroll-empty-state"><span aria-hidden>▤</span><strong>لا توجد بنود مسجلة.</strong><small>أنواع البنود وحدودها وموافقاتها ما زالت قيد المراجعة.</small></div></td></tr>
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Statement Tab */}
      {activeTab === 'statement' && (
        <section className="payroll-table-card" aria-labelledby="payroll-table-title">
          <header>
            <div>
              <h3 id="payroll-table-title">كشف المرتبات</h3>
              <p>
                {activePeriod
                  ? `فترة: ${activePeriod.period_name} · الحالة: ${periodStatusLabel(activePeriod.status)}`
                  : 'مسودة تفصيلية للفترة، ثم المراجعة والاعتماد والإغلاق.'}
              </p>
            </div>
          </header>
          <div className="payroll-table-wrap">
            <table className="payroll-table">
              <thead><tr><th>العامل</th><th>الأساسي</th><th>الإضافي والحوافز</th><th>الخصومات</th><th>السلف والأقساط</th><th>الصافي</th></tr></thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={6}><div className="payroll-empty-state"><span aria-hidden>⌛</span><strong>جاري التحميل…</strong></div></td></tr>
                ) : !periodDetail || periodDetail.runs.length === 0 ? (
                  <tr><td colSpan={6}><div className="payroll-empty-state"><span aria-hidden>▤</span><strong>لا توجد كشوف مرتبات.</strong><small>اضغط «احسب الكشف» لتوليد بيانات الفترة الحالية.</small></div></td></tr>
                ) : (
                  periodDetail.runs.map((run) => (
                    <tr key={run.id}>
                      <td>{run.employee_name}</td>
                      <td>{run.base_amount.toLocaleString('ar-EG', { minimumFractionDigits: 2 })}</td>
                      <td>{(run.overtime_amount + run.bonus_amount).toLocaleString('ar-EG', { minimumFractionDigits: 2 })}</td>
                      <td>{run.deductions_amount.toLocaleString('ar-EG', { minimumFractionDigits: 2 })}</td>
                      <td>{run.advances_amount.toLocaleString('ar-EG', { minimumFractionDigits: 2 })}</td>
                      <td><strong>{run.net_amount.toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م</strong></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {periodDetail && (
            <footer style={{ padding: '0.75rem 1rem', borderTop: '1px solid var(--border, #e5e7eb)', display: 'flex', gap: '2rem', flexWrap: 'wrap', fontWeight: 600 }}>
              <span>الإجمالي الصافي: {periodDetail.total_net.toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م</span>
              <span>الأساسي: {periodDetail.total_base.toLocaleString('ar-EG', { minimumFractionDigits: 2 })}</span>
              <span>الإضافي والحوافز: {(periodDetail.total_overtime + periodDetail.total_bonus).toLocaleString('ar-EG', { minimumFractionDigits: 2 })}</span>
              <span>الخصومات: {periodDetail.total_deductions.toLocaleString('ar-EG', { minimumFractionDigits: 2 })}</span>
              <span>السلف: {periodDetail.total_advances.toLocaleString('ar-EG', { minimumFractionDigits: 2 })}</span>
            </footer>
          )}
        </section>
      )}

      <section className="payroll-policy-card" aria-labelledby="payroll-policy-title">
        <div className="payroll-policy-card__heading"><span aria-hidden>ⓘ</span><div><h3 id="payroll-policy-title">نقاط تحتاج اعتماد المصنع</h3><p>لن تُنفذ كمعادلات أو صلاحيات نهائية قبل حسمها.</p></div></div>
        <ul>{OPEN_POLICIES.map((policy) => <li key={policy}>{policy}</li>)}</ul>
      </section>

      {periods.length > 1 && (
        <section className="payroll-table-card" aria-labelledby="payroll-periods-title">
          <header><div><h3 id="payroll-periods-title">فترات المرتب السابقة</h3></div></header>
          <div className="payroll-table-wrap">
            <table className="payroll-table">
              <thead><tr><th>الفترة</th><th>من</th><th>إلى</th><th>الحالة</th><th>عدد الكشوف</th><th>الإجمالي الصافي</th></tr></thead>
              <tbody>
                {periods.map((p) => (
                  <tr key={p.id}>
                    <td>{p.period_name}</td>
                    <td>{p.start_date}</td>
                    <td>{p.end_date}</td>
                    <td>{periodStatusLabel(p.status)}</td>
                    <td>{p.runs_count}</td>
                    <td>{p.total_net_amount.toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </section>
  );
}
