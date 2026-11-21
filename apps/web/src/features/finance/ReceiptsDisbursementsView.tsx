import { FormEvent, useEffect, useState, useMemo } from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import { userLabel } from '@/lib/userLabel';
import { Customer, fetchCustomers } from '@/features/customers/customersApi';
import {
  CashAccount,
  CashDocument,
  Supplier,
  cashSourceLabel,
  cashStatusLabel,
  errorMessage,
  financeApi,
  formatMoney,
  toNumber,
} from './financeApi';

type OperationTab = 'expense' | 'income' | 'transfer' | 'log';

export function ReceiptsDisbursementsView() {
  const { hasPermission, roles, user } = useAuth();
  const canCreate = hasPermission('finance:cash:create');
  // قرار FIN-DEC-01 (معتمد من المالك 2026-11-15): مستندات المدير المالي النقدية تُرحَّل وتُعتمد
  // لحظة إنشائها (post_on_creation) لكافة الأنواع، والضابط التعويضي مراجعة لاحقة من المدير العام.
  const isFinanceManager = roles.includes('finance_manager');

  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [documents, setDocuments] = useState<CashDocument[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState<{ number: string; type: string; posted: boolean } | null>(null);

  const [activeTab, setActiveTab] = useState<OperationTab>('expense');

  // حقول النموذج
  const [sourceAccount, setSourceAccount] = useState('');
  const [targetAccount, setTargetAccount] = useState('');
  const [amount, setAmount] = useState('');
  const [classification, setClassification] = useState('operating_expense');
  const [description, setDescription] = useState('');

  // حقول تخصيص الأطراف (مورد / عميل)
  const [expenseTargetType, setExpenseTargetType] = useState<'general' | 'supplier'>('general');
  const [selectedSupplierId, setSelectedSupplierId] = useState('');
  const [incomeSourceType, setIncomeSourceType] = useState<'general' | 'customer'>('general');
  const [selectedCustomerId, setSelectedCustomerId] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const [accRows, docRows, suppRows, custRows] = await Promise.all([
        financeApi.getAccounts(),
        financeApi.getCashDocuments(),
        financeApi.getSuppliers().catch(() => []),
        fetchCustomers().catch(() => []),
      ]);
      setAccounts(accRows);
      setDocuments(docRows);
      setSuppliers(suppRows.filter((s) => s.is_active));
      setCustomers(custRows.filter((c) => c.status === 'active'));

      const canonicalTreasury = accRows.find(
        (a) => a.id === '00000000-0000-0000-0000-000000000001' || a.account_number === 'TREASURY-MAIN'
      ) || accRows.find((a) => a.account_type === 'treasury');

      if (canonicalTreasury) {
        setSourceAccount((prev) => prev || canonicalTreasury.id);
        setTargetAccount((prev) => prev || canonicalTreasury.id);
      }
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'تعذر تحميل بيانات الحسابات النقدية.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const resetForm = () => {
    setAmount('');
    setDescription('');
    setClassification(activeTab === 'expense' ? 'operating_expense' : 'direct_sales');
    setSelectedSupplierId('');
    setSelectedCustomerId('');
    setExpenseTargetType('general');
    setIncomeSourceType('general');
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccessMsg(null);

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount <= 0) {
      setError('يرجى إدخال مبلغ صحيح أكبر من الصفر.');
      return;
    }
    if (!description.trim()) {
      setError('يرجى إدخال بيان وسبب العملية بوضوح.');
      return;
    }

    let supplierId: string | null = null;
    let customerId: string | null = null;

    if (activeTab === 'expense' && expenseTargetType === 'supplier') {
      if (!selectedSupplierId) {
        setError('يرجى اختيار المورد المستفيد من الصرف.');
        return;
      }
      supplierId = selectedSupplierId;
    } else if (activeTab === 'income' && incomeSourceType === 'customer') {
      if (!selectedCustomerId) {
        setError('يرجى اختيار العميل المسدد للنقدية.');
        return;
      }
      customerId = selectedCustomerId;
    }

    setBusy(true);
    try {
      let fromAcc: string | null = null;
      let toAcc: string | null = null;
      let docType: 'income' | 'expense' | 'transfer' = 'expense';

      if (activeTab === 'expense') {
        docType = 'expense';
        fromAcc = sourceAccount;
        toAcc = null;
      } else if (activeTab === 'income') {
        docType = 'income';
        fromAcc = null;
        toAcc = targetAccount;
      } else if (activeTab === 'transfer') {
        docType = 'transfer';
        fromAcc = sourceAccount;
        toAcc = targetAccount;
        if (fromAcc === toAcc) {
          setError('لا يمكن التحويل من وإلى نفس الحساب.');
          setBusy(false);
          return;
        }
      }

      // توثيق التصنيف داخل البيان لمنع الازدواجية وتسهيل المراجعة
      let prefix = `[${classificationLabel(classification)}]`;
      if (supplierId) {
        const supp = suppliers.find((s) => s.id === supplierId);
        prefix = `[دفعة مورد: ${supp ? supp.name : 'مورد'}]`;
      } else if (customerId) {
        const cust = customers.find((c) => c.id === customerId);
        prefix = `[تحصيل عميل: ${cust ? cust.name : 'عميل'}]`;
      }
      const fullDescription = `${prefix} ${description.trim()}`;

      const res: CashDocument = await financeApi.createCashDocument({
        document_type: docType,
        from_account_id: fromAcc,
        to_account_id: toAcc,
        amount: numAmount.toFixed(2),
        description: fullDescription,
        supplier_id: supplierId,
        customer_id: customerId,
        expense_category: activeTab === 'expense' && !supplierId ? classification : undefined,
        occurred_at: new Date().toISOString(),
      });

      setSuccessMsg({
        number: res.document_number,
        type: docType === 'income' ? 'سند القبض' : docType === 'expense' ? 'سند الصرف' : 'طلب التحويل',
        posted: res.status === 'approved',
      });
      resetForm();
      await load();
    } catch (err) {
      setError(errorMessage(err, 'تعذر إنشاء المستند.'));
    } finally {
      setBusy(false);
    }
  };

  const accountName = (id: string | null) => accounts.find((a) => a.id === id)?.name ?? '—';

  const classificationLabel = (c: string) => {
    switch (c) {
      case 'operating_expense':
        return 'مصروفات تشغيلية ومستلزمات مكان';
      case 'maintenance':
        return 'صيانة ماكينات وتشغيل ورش';
      case 'administrative':
        return 'مصروفات إدارية وعمومية';
      case 'admin_salary':
        return 'مرتبات ومكافآت الإدارة والخدمات';
      case 'direct_wages':
        return 'أجور عمال التشغيل المباشرة';
      case 'direct_sales':
        return 'إيراد مبيعات نقدية مباشرة';
      case 'other_income':
        return 'إيرادات تشغيلية أخرى';
      default:
        return 'عملية عامة';
    }
  };

  const filteredLogs = useMemo(() => {
    return documents.slice(0, 50);
  }, [documents]);

  return (
    <section className="warehouse-page" dir="rtl" aria-labelledby="receipts-disbursements-title" style={{ padding: '16px 20px' }}>
      <header className="warehouse-page__header" style={{ marginBottom: '20px' }}>
        <div>
          <span className="warehouse-page__eyebrow" style={{ fontSize: '13px', fontWeight: 700, color: '#0f766e' }}>الإدارة المالية التشغيلية · النقدية والسيولة</span>
          <h2 id="receipts-disbursements-title" style={{ fontSize: '24px', fontWeight: 800, margin: '4px 0 6px', color: '#0f172a' }}>القبض والصرف والحركات النقدية</h2>
          <p style={{ fontSize: '14px', color: '#64748b', margin: 0 }}>
            {isFinanceManager
              ? 'تسجيل سندات القبض والصرف والتحويل الداخلي مع الترحيل الفوري لدفاتر الخزينة والأستاذ العام (صلاحية مدير مالي).'
              : 'تسجيل سندات القبض والصرف والتحويل الداخلي بانتظار الاعتماد من شاشة الخزينة.'}
          </p>
        </div>
        <button className="btn btn--secondary" style={{ height: '38px', padding: '0 16px', fontSize: '13.5px' }} onClick={() => void load()} disabled={loading}>
          {loading ? 'جاري التحديث…' : '↻ تحديث البيانات'}
        </button>
      </header>

      {error && (
        <div className="warehouse-alert" role="alert" style={{ marginBottom: '1.25rem', fontSize: '14px', padding: '12px 16px', borderRadius: '8px', background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c' }}>
          ⚠️ {error}
        </div>
      )}

      {!canCreate && (
        <div className="warehouse-alert" role="note" style={{ marginBottom: '1.25rem', fontSize: '14px', padding: '12px 16px', borderRadius: '8px', background: '#f8fafc', border: '1px solid #e2e8f0', color: '#475569' }}>
          ℹ️ حسابك يملك صلاحية استعراض سجل السندات النقدية فقط دون إضافة حركات جديدة.
        </div>
      )}

      {successMsg && (
        <div
          role="status"
          style={{
            padding: '14px 18px',
            backgroundColor: '#f0fdf4',
            border: '1px solid #86efac',
            borderRadius: '10px',
            color: '#166534',
            marginBottom: '1.5rem',
            fontSize: '14px',
          }}
        >
          <strong style={{ display: 'block', fontSize: '15px', marginBottom: '0.25rem' }}>
            ✓ تم تسجيل {successMsg.type} برقم <code>{successMsg.number}</code>
          </strong>
          <p style={{ margin: 0, fontSize: '14px' }}>
            {successMsg.posted
              ? 'اعتُمد المستند فوراً ورُحِّل إلى الأستاذ العام ودفتر النقدية.'
              : 'المستند بانتظار الاعتماد من شاشة الخزينة.'}
          </p>
        </div>
      )}

      {/* ── شريط اختيار العملية التشغيلية ── */}
      <nav
        style={{
          display: 'flex',
          gap: '8px',
          flexWrap: 'wrap',
          borderBottom: '2px solid #e2e8f0',
          paddingBottom: '12px',
          marginBottom: '20px',
        }}
      >
        <button
          className={`btn ${activeTab === 'expense' ? 'btn--primary' : 'btn--secondary'}`}
          onClick={() => {
            setActiveTab('expense');
            setClassification('operating_expense');
            setError('');
          }}
          style={{ height: '40px', padding: '0 18px', fontSize: '14px', fontWeight: 700, borderRadius: '8px' }}
        >
          📤 سند صرف نقدي
        </button>
        <button
          className={`btn ${activeTab === 'income' ? 'btn--primary' : 'btn--secondary'}`}
          onClick={() => {
            setActiveTab('income');
            setClassification('direct_sales');
            setError('');
          }}
          style={{ height: '40px', padding: '0 18px', fontSize: '14px', fontWeight: 700, borderRadius: '8px' }}
        >
          📥 سند قبض نقدي
        </button>
        <button
          className={`btn ${activeTab === 'transfer' ? 'btn--primary' : 'btn--secondary'}`}
          onClick={() => {
            setActiveTab('transfer');
            setError('');
          }}
          style={{ height: '40px', padding: '0 18px', fontSize: '14px', fontWeight: 700, borderRadius: '8px' }}
        >
          ⇄ تحويل داخلي / تغذية عهدة
        </button>
        <button
          className={`btn ${activeTab === 'log' ? 'btn--primary' : 'btn--secondary'}`}
          onClick={() => {
            setActiveTab('log');
            setError('');
          }}
          style={{ height: '40px', padding: '0 18px', fontSize: '14px', fontWeight: 700, borderRadius: '8px', marginRight: 'auto' }}
        >
          📋 سجل السندات الأخيرة ({documents.length})
        </button>
      </nav>

      {/* ── نموذج سند الصرف ── */}
      {activeTab === 'expense' && (
        <section className="warehouse-card" style={{ maxWidth: '820px', background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
          <h3 style={{ margin: '0 0 6px 0', color: '#991b1b', fontSize: '18px', fontWeight: 700 }}>تسجيل مستند صرف نقدي</h3>
          <p style={{ color: '#64748b', fontSize: '14px', margin: '0 0 20px 0' }}>
            صرف مصروفات تشغيلية أو سداد دفعات نقدية للموردين من حسابات الخزينة أو البنك.
          </p>

          <form onSubmit={(e) => void handleSubmit(e)}>
            {/* جهة الصرف */}
            <div style={{ marginBottom: '18px', padding: '12px 16px', backgroundColor: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0', display: 'flex', gap: '24px', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, fontSize: '14px', color: '#334155' }}>جهة الصرف:</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '14px', fontWeight: 600, color: '#1e293b' }}>
                <input
                  type="radio"
                  name="expenseTargetType"
                  value="general"
                  checked={expenseTargetType === 'general'}
                  onChange={() => setExpenseTargetType('general')}
                />
                مصروف عام / تشغيلي
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '14px', fontWeight: 600, color: '#1e293b' }}>
                <input
                  type="radio"
                  name="expenseTargetType"
                  value="supplier"
                  checked={expenseTargetType === 'supplier'}
                  onChange={() => setExpenseTargetType('supplier')}
                />
                دفعة لمورد خامات (حساب 2100)
              </label>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px', marginBottom: '16px' }}>
              <div>
                <label style={{ display: 'block', fontWeight: 700, fontSize: '14px', marginBottom: '6px', color: '#334155' }}>
                  يُصرف من حساب <span style={{ color: '#dc2626' }}>*</span>
                </label>
                <select
                  required
                  value={sourceAccount}
                  onChange={(e) => setSourceAccount(e.target.value)}
                  style={{ width: '100%', height: '42px', padding: '0 12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '14px', background: '#fff' }}
                >
                  {accounts
                    .filter((a) => a.is_active && (a.account_type === 'treasury' || a.account_type === 'bank'))
                    .map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.name} ({acc.account_type === 'bank' ? 'بنك' : 'خزنة'}) — رصيد: {formatMoney(acc.balance)}
                      </option>
                    ))}
                </select>
              </div>

              {expenseTargetType === 'general' ? (
                <div>
                  <label style={{ display: 'block', fontWeight: 700, fontSize: '14px', marginBottom: '6px', color: '#334155' }}>
                    تصنيف المصروف <span style={{ color: '#dc2626' }}>*</span>
                  </label>
                  <select
                    value={classification}
                    onChange={(e) => setClassification(e.target.value)}
                    style={{ width: '100%', height: '42px', padding: '0 12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '14px', background: '#fff' }}
                  >
                    <option value="operating_expense">مصروفات تشغيلية ومستلزمات (5300)</option>
                    <option value="maintenance">صيانة ماكينات وتشغيل ورش (5300)</option>
                    <option value="administrative">مصروفات إدارية وعمومية (5400)</option>
                    <option value="admin_salary">مرتبات ومكافآت الإدارة (5410)</option>
                    <option value="direct_wages">أجور عمال التشغيل المباشرة (5210)</option>
                  </select>
                </div>
              ) : (
                <div>
                  <label style={{ display: 'block', fontWeight: 700, fontSize: '14px', marginBottom: '6px', color: '#334155' }}>
                    المورد المستفيد <span style={{ color: '#dc2626' }}>*</span>
                  </label>
                  <select
                    required
                    value={selectedSupplierId}
                    onChange={(e) => setSelectedSupplierId(e.target.value)}
                    style={{ width: '100%', height: '42px', padding: '0 12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '14px', background: '#fff' }}
                  >
                    <option value="">— اختر المورد —</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.code})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label style={{ display: 'block', fontWeight: 700, fontSize: '14px', marginBottom: '6px', color: '#334155' }}>
                  المبلغ المنصرف (ج.م) <span style={{ color: '#dc2626' }}>*</span>
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  style={{ width: '100%', height: '42px', padding: '0 12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '15px', fontWeight: 700 }}
                />
              </div>
            </div>

            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontWeight: 700, fontSize: '14px', marginBottom: '6px', color: '#334155' }}>
                بيان وسبب الصرف بالتفصيل <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <textarea
                required
                rows={3}
                placeholder="اكتب بيان الصرف والغرض منه بدقة..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '14px', resize: 'vertical' }}
              />
            </div>

            <div style={{ padding: '10px 14px', backgroundColor: expenseTargetType === 'supplier' ? '#eff6ff' : '#f8fafc', borderRadius: '8px', marginBottom: '18px', fontSize: '13px', color: expenseTargetType === 'supplier' ? '#1e40af' : '#475569', border: '1px solid #e2e8f0' }}>
              {expenseTargetType === 'supplier' ? (
                <span>💡 <strong>ملاحظة:</strong> يُسجل السند كدفعة للمورد لتخصيصها على فواتيره لاحقاً من شاشة المشتريات والموردين.</span>
              ) : (
                <span>💡 <strong>تنبيه:</strong> إذا كان هذا الصرف مخصصاً لمورد خامات، اختر «دفعة لمورد خامات» أعلاه لربطه بحسابه.</span>
              )}
            </div>

            <button type="submit" className="btn btn--primary" disabled={busy || loading || !canCreate} style={{ height: '42px', padding: '0 24px', fontSize: '14px', fontWeight: 700, borderRadius: '8px', backgroundColor: isFinanceManager ? '#0f766e' : '#dc2626', borderColor: isFinanceManager ? '#0f766e' : '#dc2626' }}>
              {busy ? 'جاري التسجيل…' : isFinanceManager ? 'حفظ وترحيل سند الصرف فوراً' : 'تسجيل سند الصرف (بانتظار اعتماد الخزينة)'}
            </button>
          </form>
        </section>
      )}

      {/* ── نموذج سند القبض ── */}
      {activeTab === 'income' && (
        <section className="warehouse-card" style={{ maxWidth: '820px', background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
          <h3 style={{ margin: '0 0 6px 0', color: '#166534', fontSize: '18px', fontWeight: 700 }}>تسجيل مستند قبض نقدي</h3>
          <p style={{ color: '#64748b', fontSize: '14px', margin: '0 0 20px 0' }}>
            توريد نقدية إلى الخزينة أو البنك من إيرادات المبيعات أو تحصيل دفعات العملاء.
          </p>

          <form onSubmit={(e) => void handleSubmit(e)}>
            {/* مصدر القبض */}
            <div style={{ marginBottom: '18px', padding: '12px 16px', backgroundColor: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0', display: 'flex', gap: '24px', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 700, fontSize: '14px', color: '#334155' }}>مصدر القبض:</span>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '14px', fontWeight: 600, color: '#1e293b' }}>
                <input
                  type="radio"
                  name="incomeSourceType"
                  value="general"
                  checked={incomeSourceType === 'general'}
                  onChange={() => setIncomeSourceType('general')}
                />
                إيراد مبيعات مباشرة / متنوعة
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '14px', fontWeight: 600, color: '#1e293b' }}>
                <input
                  type="radio"
                  name="incomeSourceType"
                  value="customer"
                  checked={incomeSourceType === 'customer'}
                  onChange={() => setIncomeSourceType('customer')}
                />
                تحصيل دفعة من عميل (حساب 1100)
              </label>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px', marginBottom: '16px' }}>
              <div>
                <label style={{ display: 'block', fontWeight: 700, fontSize: '14px', marginBottom: '6px', color: '#334155' }}>
                  يُودع في حساب <span style={{ color: '#dc2626' }}>*</span>
                </label>
                <select
                  required
                  value={targetAccount}
                  onChange={(e) => setTargetAccount(e.target.value)}
                  style={{ width: '100%', height: '42px', padding: '0 12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '14px', background: '#fff' }}
                >
                  {accounts
                    .filter((a) => (a.account_type === 'treasury' || a.account_type === 'bank') && a.is_active)
                    .map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.name} ({acc.account_type === 'bank' ? 'بنك' : 'خزنة'}) — رصيد: {formatMoney(acc.balance)}
                      </option>
                    ))}
                </select>
              </div>

              {incomeSourceType === 'general' ? (
                <div>
                  <label style={{ display: 'block', fontWeight: 700, fontSize: '14px', marginBottom: '6px', color: '#334155' }}>
                    تصنيف المقبوض <span style={{ color: '#dc2626' }}>*</span>
                  </label>
                  <select
                    value={classification}
                    onChange={(e) => setClassification(e.target.value)}
                    style={{ width: '100%', height: '42px', padding: '0 12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '14px', background: '#fff' }}
                  >
                    <option value="direct_sales">إيراد مبيعات نقدية مباشرة (4100)</option>
                    <option value="other_income">إيرادات تشغيلية أخرى / مخلفات (4200)</option>
                  </select>
                </div>
              ) : (
                <div>
                  <label style={{ display: 'block', fontWeight: 700, fontSize: '14px', marginBottom: '6px', color: '#334155' }}>
                    العميل المسدد <span style={{ color: '#dc2626' }}>*</span>
                  </label>
                  <select
                    required
                    value={selectedCustomerId}
                    onChange={(e) => setSelectedCustomerId(e.target.value)}
                    style={{ width: '100%', height: '42px', padding: '0 12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '14px', background: '#fff' }}
                  >
                    <option value="">— اختر العميل —</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.code})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label style={{ display: 'block', fontWeight: 700, fontSize: '14px', marginBottom: '6px', color: '#334155' }}>
                  المبلغ المقبوض (ج.م) <span style={{ color: '#dc2626' }}>*</span>
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  style={{ width: '100%', height: '42px', padding: '0 12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '15px', fontWeight: 700 }}
                />
              </div>
            </div>

            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontWeight: 700, fontSize: '14px', marginBottom: '6px', color: '#334155' }}>
                بيان المقبوضات بالتفصيل <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <textarea
                required
                rows={3}
                placeholder="اكتب بيان ومصدر المقبوضات..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '14px', resize: 'vertical' }}
              />
            </div>

            <div style={{ padding: '10px 14px', backgroundColor: incomeSourceType === 'customer' ? '#f0fdf4' : '#f8fafc', borderRadius: '8px', marginBottom: '18px', fontSize: '13px', color: incomeSourceType === 'customer' ? '#166534' : '#475569', border: '1px solid #e2e8f0' }}>
              {incomeSourceType === 'customer' ? (
                <span>💡 <strong>ملاحظة:</strong> يُسجل السند كدفعة تحصيل للعميل لتخصيصها على طلباته لاحقاً من شاشة العملاء والمبيعات.</span>
              ) : (
                <span>💡 <strong>تنبيه:</strong> لتحصيل دفعات العملاء، اختر «تحصيل دفعة من عميل» أعلاه لربطها بملف العميل المحاسبي.</span>
              )}
            </div>

            <button type="submit" className="btn btn--primary" disabled={busy || loading || !canCreate} style={{ height: '42px', padding: '0 24px', fontSize: '14px', fontWeight: 700, borderRadius: '8px', backgroundColor: '#16a34a', borderColor: '#16a34a' }}>
              {busy ? 'جاري التسجيل…' : isFinanceManager ? 'حفظ وترحيل سند القبض فوراً' : 'تسجيل سند القبض (بانتظار اعتماد الخزينة)'}
            </button>
          </form>
        </section>
      )}

      {/* ── نموذج التحويل الداخلي ── */}
      {activeTab === 'transfer' && (
        <section className="warehouse-card" style={{ maxWidth: '820px', background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
          <h3 style={{ margin: '0 0 6px 0', color: '#1e40af', fontSize: '18px', fontWeight: 700 }}>تحويل نقدي داخلي / تغذية عهدة</h3>
          <p style={{ color: '#64748b', fontSize: '14px', margin: '0 0 20px 0' }}>
            نقل السيولة بين الخزنة المركزية والحسابات البنكية وصناديق العهد النقدية للموظفين.
          </p>

          <form onSubmit={(e) => void handleSubmit(e)}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px', marginBottom: '16px' }}>
              <div>
                <label style={{ display: 'block', fontWeight: 700, fontSize: '14px', marginBottom: '6px', color: '#334155' }}>
                  تحويل من حساب <span style={{ color: '#dc2626' }}>*</span>
                </label>
                <select
                  required
                  value={sourceAccount}
                  onChange={(e) => setSourceAccount(e.target.value)}
                  style={{ width: '100%', height: '42px', padding: '0 12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '14px', background: '#fff' }}
                >
                  {accounts
                    .filter((a) => a.is_active)
                    .map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.name} ({acc.account_type === 'treasury' ? 'خزنة' : acc.account_type === 'bank' ? 'بنك' : 'عهدة'}) — رصيد: {formatMoney(acc.balance)}
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontWeight: 700, fontSize: '14px', marginBottom: '6px', color: '#334155' }}>
                  إلى حساب <span style={{ color: '#dc2626' }}>*</span>
                </label>
                <select
                  required
                  value={targetAccount}
                  onChange={(e) => setTargetAccount(e.target.value)}
                  style={{ width: '100%', height: '42px', padding: '0 12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '14px', background: '#fff' }}
                >
                  {accounts
                    .filter((a) => a.is_active)
                    .map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.name} ({acc.account_type === 'treasury' ? 'خزنة' : acc.account_type === 'bank' ? 'بنك' : 'عهدة'}) — رصيد: {formatMoney(acc.balance)}
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontWeight: 700, fontSize: '14px', marginBottom: '6px', color: '#334155' }}>
                  المبلغ المحول (ج.م) <span style={{ color: '#dc2626' }}>*</span>
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  style={{ width: '100%', height: '42px', padding: '0 12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '15px', fontWeight: 700 }}
                />
              </div>
            </div>

            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontWeight: 700, fontSize: '14px', marginBottom: '6px', color: '#334155' }}>
                بيان وسبب التحويل <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <textarea
                required
                rows={3}
                placeholder="اكتب الغرض من التحويل الداخلي أو اسم مسؤول العهدة..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #cbd5e1', fontSize: '14px', resize: 'vertical' }}
              />
            </div>

            <button type="submit" className="btn btn--primary" disabled={busy || loading || !canCreate} style={{ height: '42px', padding: '0 24px', fontSize: '14px', fontWeight: 700, borderRadius: '8px', backgroundColor: '#1e40af', borderColor: '#1e40af' }}>
              {busy ? 'جاري التسجيل…' : isFinanceManager ? 'حفظ وترحيل التحويل فوراً' : 'تسجيل طلب التحويل (بانتظار اعتماد الخزينة)'}
            </button>
          </form>
        </section>
      )}

      {/* ── سجل العمليات النقدية الأخير ── */}
      {activeTab === 'log' && (
        <section className="warehouse-card" style={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
            <h3 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: '#0f172a' }}>سجل السندات النقدية الأخيرة</h3>
            <span style={{ fontSize: '13.5px', color: '#64748b' }}>أحدث {filteredLogs.length} حركة مسجلة</span>
          </div>

          <div className="warehouse-table-wrap" style={{ border: '1px solid #e2e8f0', borderRadius: '10px', overflowX: 'auto' }}>
            <table className="warehouse-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
              <thead>
                <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0' }}>
                  <th style={{ padding: '12px 14px', fontWeight: 700, color: '#334155' }}>رقم المستند</th>
                  <th style={{ padding: '12px 14px', fontWeight: 700, color: '#334155' }}>التاريخ</th>
                  <th style={{ padding: '12px 14px', fontWeight: 700, color: '#334155' }}>النوع</th>
                  <th style={{ padding: '12px 14px', fontWeight: 700, color: '#334155' }}>من حساب</th>
                  <th style={{ padding: '12px 14px', fontWeight: 700, color: '#334155' }}>إلى حساب</th>
                  <th style={{ padding: '12px 14px', fontWeight: 700, color: '#334155' }}>المبلغ</th>
                  <th style={{ padding: '12px 14px', fontWeight: 700, color: '#334155' }}>البيان والتصنيف</th>
                  <th style={{ padding: '12px 14px', fontWeight: 700, color: '#334155' }}>الحالة</th>
                  <th style={{ padding: '12px 14px', fontWeight: 700, color: '#334155' }}>المصدر</th>
                  <th style={{ padding: '12px 14px', fontWeight: 700, color: '#334155' }}>صاحب الطلب</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.length === 0 ? (
                  <tr>
                    <td colSpan={10} style={{ textAlign: 'center', color: '#64748b', padding: '32px' }}>
                      لا توجد مستندات مسجلة حتى الآن.
                    </td>
                  </tr>
                ) : (
                  filteredLogs.map((doc) => {
                    const isIncome = doc.document_type === 'income';
                    const isExpense = doc.document_type === 'expense';
                    return (
                      <tr key={doc.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '12px 14px' }}><code style={{ fontWeight: 700, color: '#0f766e', fontSize: '13.5px' }}>{doc.document_number}</code></td>
                        <td style={{ padding: '12px 14px', fontSize: '13.5px' }}>
                          {doc.occurred_at ? new Date(doc.occurred_at).toLocaleDateString('ar-EG') : '—'}
                        </td>
                        <td style={{ padding: '12px 14px' }}>
                          <span
                            style={{
                              fontSize: '12px',
                              padding: '3px 8px',
                              borderRadius: '999px',
                              fontWeight: 700,
                              backgroundColor: isIncome ? '#dcfce7' : isExpense ? '#fee2e2' : '#e0e7ff',
                              color: isIncome ? '#166534' : isExpense ? '#991b1b' : '#3730a3',
                            }}
                          >
                            {isIncome ? 'قبض' : isExpense ? 'صرف' : 'تحويل'}
                          </span>
                        </td>
                        <td style={{ padding: '12px 14px' }}>{accountName(doc.from_account_id)}</td>
                        <td style={{ padding: '12px 14px' }}>{accountName(doc.to_account_id)}</td>
                        <td className="cell-money" style={{ padding: '12px 14px', fontWeight: 700, fontSize: '15px', color: isIncome ? '#16a34a' : isExpense ? '#dc2626' : '#0f172a' }}>
                          {formatMoney(doc.amount)}
                        </td>
                        <td className="cell-wrap" style={{ padding: '12px 14px', maxWidth: '300px' }}>
                          {doc.supplier_name && (
                            <span className="cell-tag" style={{ backgroundColor: '#e0f2fe', color: '#0369a1', marginLeft: '0.35rem', fontSize: '12px' }}>
                              المورد: {doc.supplier_name}
                            </span>
                          )}
                          {doc.customer_name && (
                            <span className="cell-tag" style={{ backgroundColor: '#fef3c7', color: '#92400e', marginLeft: '0.35rem', fontSize: '12px' }}>
                              العميل: {doc.customer_name}
                            </span>
                          )}
                          {doc.unallocated_amount != null && toNumber(doc.unallocated_amount) > 0 && (
                            <span className="cell-tag" style={{ backgroundColor: '#f0fdf4', color: '#166534', border: '1px solid #86efac', marginLeft: '0.35rem', fontSize: '12px' }}>
                              غير مخصص: {formatMoney(doc.unallocated_amount)}
                            </span>
                          )}
                          {(() => {
                            const m = /^\[([^\]]+)\]\s*(.*)$/s.exec(doc.description || '');
                            return m ? <><span className="cell-tag" style={{ fontSize: '12px' }}>{m[1]}</span>{m[2] || '—'}</> : (doc.description || '—');
                          })()}
                        </td>
                        <td style={{ padding: '12px 14px' }}>
                          <span
                            style={{
                              fontSize: '12px',
                              padding: '3px 8px',
                              borderRadius: '999px',
                              fontWeight: 700,
                              backgroundColor:
                                doc.status === 'approved'
                                  ? '#dcfce7'
                                  : doc.status === 'pending'
                                  ? '#fef3c7'
                                  : '#fee2e2',
                              color:
                                doc.status === 'approved'
                                  ? '#166534'
                                  : doc.status === 'pending'
                                  ? '#92400e'
                                  : '#991b1b',
                            }}
                          >
                            {cashStatusLabel(doc.status)}
                          </span>
                          {doc.status === 'rejected' && doc.rejection_reason && (
                            <small style={{ display: 'block', marginTop: 4, whiteSpace: 'normal', minWidth: 160, color: '#991b1b', fontSize: '12px' }}>السبب: {doc.rejection_reason}</small>
                          )}
                        </td>
                        <td style={{ padding: '12px 14px', fontSize: '13px', color: '#475569' }}>{cashSourceLabel(doc.source_system)}</td>
                        <td style={{ padding: '12px 14px', fontSize: '13px', color: '#64748b' }}>{userLabel(doc.created_by, user?.id)}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </section>
  );
}
