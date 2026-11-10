import { FormEvent, useEffect, useState, useMemo } from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import { userLabel } from '@/lib/userLabel';
import {
  CashAccount,
  CashDocument,
  cashSourceLabel,
  cashStatusLabel,
  errorMessage,
  financeApi,
  formatMoney,
} from './financeApi';

type OperationTab = 'expense' | 'income' | 'transfer' | 'log';

export function ReceiptsDisbursementsView() {
  const { hasPermission, user } = useAuth();
  const canCreate = hasPermission('finance:cash:create');

  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [documents, setDocuments] = useState<CashDocument[]>([]);
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

  const load = async () => {
    setLoading(true);
    try {
      const [accRows, docRows] = await Promise.all([
        financeApi.getAccounts(),
        financeApi.getCashDocuments(),
      ]);
      setAccounts(accRows);
      setDocuments(docRows);

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
      const fullDescription = `[${classificationLabel(classification)}] ${description.trim()}`;

      const res: CashDocument = await financeApi.createCashDocument({
        document_type: docType,
        from_account_id: fromAcc,
        to_account_id: toAcc,
        amount: numAmount.toFixed(2),
        description: fullDescription,
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
        return 'مصروفات تشغيلية وإنتاجية';
      case 'maintenance':
        return 'صيانة ومستلزمات تشغيل';
      case 'administrative':
        return 'مصروفات إدارية ونثرية';
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
    <section className="warehouse-page" dir="rtl" aria-labelledby="receipts-disbursements-title">
      <header className="warehouse-page__header">
        <div>
          <span className="warehouse-page__eyebrow">الإدارة المالية التشغيلية · النقدية والسيولة</span>
          <h2 id="receipts-disbursements-title">القبض والصرف والحركات النقدية</h2>
          <p>
            تسجيل سندات القبض والصرف والتحويل الداخلي. كل سند يُسجل بانتظار الاعتماد من شاشة الخزينة ولا يغير أي رصيد قبل اعتماده.
          </p>
        </div>
        <button className="btn btn--secondary" onClick={() => void load()} disabled={loading}>
          {loading ? 'جاري التحديث…' : 'تحديث البيانات'}
        </button>
      </header>

      {error && (
        <div className="warehouse-alert" role="alert" style={{ marginBottom: '1.25rem' }}>
          ⚠️ {error}
        </div>
      )}

      {!canCreate && (
        <div className="warehouse-alert" role="note" style={{ marginBottom: '1.25rem' }}>
          ليست لديك صلاحية تسجيل مستندات نقدية؛ يمكنك عرض السجل فقط.
        </div>
      )}

      {successMsg && (
        <div
          role="status"
          style={{
            padding: '1rem 1.25rem',
            backgroundColor: '#f0fdf4',
            border: '1px solid #86efac',
            borderRadius: '8px',
            color: '#166534',
            marginBottom: '1.5rem',
          }}
        >
          <strong style={{ display: 'block', fontSize: '1rem', marginBottom: '0.25rem' }}>
            ✓ تم تسجيل {successMsg.type} برقم <code>{successMsg.number}</code>
          </strong>
          <p style={{ margin: 0, fontSize: '0.88rem' }}>
            {successMsg.posted
              ? 'اعتُمد المستند فوراً وتحرك رصيد الحساب.'
              : 'المستند بانتظار الاعتماد من شاشة الخزينة. لن يتغير رصيد أي حساب قبل اعتماده.'}
          </p>
        </div>
      )}

      {/* ── شريط اختيار العملية التشغيلية ── */}
      <nav
        style={{
          display: 'flex',
          gap: '0.5rem',
          borderBottom: '2px solid #e2e8f0',
          paddingBottom: '0.5rem',
          marginBottom: '1.5rem',
        }}
      >
        <button
          className={`btn ${activeTab === 'expense' ? 'btn--primary' : 'btn--secondary'}`}
          onClick={() => {
            setActiveTab('expense');
            setClassification('operating_expense');
            setError('');
          }}
          style={{ fontWeight: 600 }}
        >
          📤 سند صرف نقدي (Disbursement)
        </button>
        <button
          className={`btn ${activeTab === 'income' ? 'btn--primary' : 'btn--secondary'}`}
          onClick={() => {
            setActiveTab('income');
            setClassification('direct_sales');
            setError('');
          }}
          style={{ fontWeight: 600 }}
        >
          📥 سند قبض نقدي (Receipt)
        </button>
        <button
          className={`btn ${activeTab === 'transfer' ? 'btn--primary' : 'btn--secondary'}`}
          onClick={() => {
            setActiveTab('transfer');
            setError('');
          }}
          style={{ fontWeight: 600 }}
        >
          ⇄ تحويل داخلي / تغذية عهدة
        </button>
        <button
          className={`btn ${activeTab === 'log' ? 'btn--primary' : 'btn--secondary'}`}
          onClick={() => {
            setActiveTab('log');
            setError('');
          }}
          style={{ fontWeight: 600, marginRight: 'auto' }}
        >
          📋 سجل السندات الأخيرة ({documents.length})
        </button>
      </nav>

      {/* ── نموذج سند الصرف ── */}
      {activeTab === 'expense' && (
        <section className="warehouse-card" style={{ maxWidth: '780px' }}>
          <h3 style={{ margin: '0 0 0.5rem 0', color: '#991b1b' }}>تسجيل مستند صرف نقدي جديد</h3>
          <p style={{ color: '#64748b', fontSize: '0.85rem', margin: '0 0 1.25rem 0' }}>
            لصرف المصروفات التشغيلية من الخزنة الرئيسية. لا يُخصم المبلغ إلا بعد الاعتماد من شاشة الخزينة. مصروفات العهد تُسجل من شاشة العهد.
          </p>

          <form onSubmit={(e) => void handleSubmit(e)}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1rem', marginBottom: '1rem' }}>
              <div>
                <label style={{ display: 'block', fontWeight: 600, fontSize: '0.88rem', marginBottom: '0.35rem' }}>
                  يُصرف من حساب <span style={{ color: '#dc2626' }}>*</span>
                </label>
                <select
                  required
                  value={sourceAccount}
                  onChange={(e) => setSourceAccount(e.target.value)}
                  style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                >
                  {accounts
                    .filter((a) => a.is_active && a.account_type === 'treasury')
                    .map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.name} — رصيد معتمد: {formatMoney(acc.balance)}
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontWeight: 600, fontSize: '0.88rem', marginBottom: '0.35rem' }}>
                  تبويب / تصنيف المصروف <span style={{ color: '#dc2626' }}>*</span>
                </label>
                <select
                  value={classification}
                  onChange={(e) => setClassification(e.target.value)}
                  style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                >
                  <option value="operating_expense">مصروفات تشغيلية وإنتاجية (حساب 5300)</option>
                  <option value="maintenance">صيانة ماكينات وقطع غيار (حساب 5300)</option>
                  <option value="administrative">مصروفات إدارية ونثرية (حساب 5400)</option>
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontWeight: 600, fontSize: '0.88rem', marginBottom: '0.35rem' }}>
                  المبلغ المنصرف (بالجنيه المصري) <span style={{ color: '#dc2626' }}>*</span>
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                />
              </div>
            </div>

            <div style={{ marginBottom: '1.25rem' }}>
              <label style={{ display: 'block', fontWeight: 600, fontSize: '0.88rem', marginBottom: '0.35rem' }}>
                بيان وسبب الصرف بالتفصيل <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <textarea
                required
                rows={3}
                placeholder="اكتب الغرض من الصرف والجهة أو الموظف المستلم وأي تفاصيل داعمة..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #cbd5e1', resize: 'vertical' }}
              />
            </div>

            <div style={{ padding: '0.75rem 1rem', backgroundColor: '#fef2f2', borderRadius: '6px', marginBottom: '1.25rem', fontSize: '0.82rem', color: '#991b1b' }}>
              💡 <strong>تنبيه لمنع الازدواجية:</strong> لسداد فواتير الموردين، يرجى استخدام شاشة <strong>الموردون ومستحقاتهم</strong> ليتم ربط الدفعة بالفاتورة وتخفيض مديونية المورد آلياً.
            </div>

            <button type="submit" className="btn btn--primary" disabled={busy || loading || !canCreate} style={{ backgroundColor: '#dc2626', borderColor: '#dc2626' }}>
              {busy ? 'جاري التسجيل…' : 'تسجيل سند الصرف (بانتظار اعتماد الخزينة)'}
            </button>
          </form>
        </section>
      )}

      {/* ── نموذج سند القبض ── */}
      {activeTab === 'income' && (
        <section className="warehouse-card" style={{ maxWidth: '780px' }}>
          <h3 style={{ margin: '0 0 0.5rem 0', color: '#166534' }}>تسجيل مستند قبض نقدي جديد</h3>
          <p style={{ color: '#64748b', fontSize: '0.85rem', margin: '0 0 1.25rem 0' }}>
            يوثق توريد النقدية إلى الخزينة المركزية لإيرادات المبيعات أو الإيرادات المتنوعة.
          </p>

          <form onSubmit={(e) => void handleSubmit(e)}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1rem', marginBottom: '1rem' }}>
              <div>
                <label style={{ display: 'block', fontWeight: 600, fontSize: '0.88rem', marginBottom: '0.35rem' }}>
                  يُودع في حساب الخزينة <span style={{ color: '#dc2626' }}>*</span>
                </label>
                <select
                  required
                  value={targetAccount}
                  onChange={(e) => setTargetAccount(e.target.value)}
                  style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                >
                  {accounts
                    .filter((a) => a.account_type === 'treasury' && a.is_active)
                    .map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.name} — رصيد معتمد: {formatMoney(acc.balance)}
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontWeight: 600, fontSize: '0.88rem', marginBottom: '0.35rem' }}>
                  تصنيف المقبوض <span style={{ color: '#dc2626' }}>*</span>
                </label>
                <select
                  value={classification}
                  onChange={(e) => setClassification(e.target.value)}
                  style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                >
                  <option value="direct_sales">إيراد مبيعات نقدية مباشرة (حساب 4100)</option>
                  <option value="other_income">إيرادات تشغيلية أخرى / بيع مخلفات (حساب 4200)</option>
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontWeight: 600, fontSize: '0.88rem', marginBottom: '0.35rem' }}>
                  المبلغ المقبوض (بالجنيه المصري) <span style={{ color: '#dc2626' }}>*</span>
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                />
              </div>
            </div>

            <div style={{ marginBottom: '1.25rem' }}>
              <label style={{ display: 'block', fontWeight: 600, fontSize: '0.88rem', marginBottom: '0.35rem' }}>
                بيان ومصدر المقبوضات بالتفصيل <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <textarea
                required
                rows={3}
                placeholder="اكتب بيان المقبوضات، اسم العميل أو المورد، أو مصدر النقدية ورقم إيصال الاستلام..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #cbd5e1', resize: 'vertical' }}
              />
            </div>

            <div style={{ padding: '0.75rem 1rem', backgroundColor: '#f0fdf4', borderRadius: '6px', marginBottom: '1.25rem', fontSize: '0.82rem', color: '#166534' }}>
              💡 <strong>تنبيه لمنع الازدواجية:</strong> لتحصيل دفعات العملاء على الطلبات القائمة، يرجى استخدام شاشة <strong>العملاء والتحصيلات</strong> لربط الدفعة بالطلب وتخفيض مديونية العميل آلياً.
            </div>

            <button type="submit" className="btn btn--primary" disabled={busy || loading || !canCreate} style={{ backgroundColor: '#16a34a', borderColor: '#16a34a' }}>
              {busy ? 'جاري التسجيل…' : 'تسجيل سند القبض (بانتظار اعتماد الخزينة)'}
            </button>
          </form>
        </section>
      )}

      {/* ── نموذج التحويل الداخلي ── */}
      {activeTab === 'transfer' && (
        <section className="warehouse-card" style={{ maxWidth: '780px' }}>
          <h3 style={{ margin: '0 0 0.5rem 0', color: '#1e40af' }}>طلب تحويل نقدي داخلي / تغذية عهدة</h3>
          <p style={{ color: '#64748b', fontSize: '0.85rem', margin: '0 0 1.25rem 0' }}>
            نقل السيولة بين الخزنة المركزية وصناديق العهد النقدية، أو رد متبقي العهدة إلى الخزنة.
          </p>

          <form onSubmit={(e) => void handleSubmit(e)}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1rem', marginBottom: '1rem' }}>
              <div>
                <label style={{ display: 'block', fontWeight: 600, fontSize: '0.88rem', marginBottom: '0.35rem' }}>
                  تحويل من حساب <span style={{ color: '#dc2626' }}>*</span>
                </label>
                <select
                  required
                  value={sourceAccount}
                  onChange={(e) => setSourceAccount(e.target.value)}
                  style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                >
                  {accounts
                    .filter((a) => a.is_active)
                    .map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.name} ({acc.account_type === 'treasury' ? 'خزنة' : 'عهدة'}) — رصيد معتمد: {formatMoney(acc.balance)}
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontWeight: 600, fontSize: '0.88rem', marginBottom: '0.35rem' }}>
                  إلى حساب <span style={{ color: '#dc2626' }}>*</span>
                </label>
                <select
                  required
                  value={targetAccount}
                  onChange={(e) => setTargetAccount(e.target.value)}
                  style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                >
                  {accounts
                    .filter((a) => a.is_active)
                    .map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.name} ({acc.account_type === 'treasury' ? 'خزنة' : 'عهدة'}) — رصيد معتمد: {formatMoney(acc.balance)}
                      </option>
                    ))}
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontWeight: 600, fontSize: '0.88rem', marginBottom: '0.35rem' }}>
                  المبلغ المحول (بالجنيه المصري) <span style={{ color: '#dc2626' }}>*</span>
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #cbd5e1' }}
                />
              </div>
            </div>

            <div style={{ marginBottom: '1.25rem' }}>
              <label style={{ display: 'block', fontWeight: 600, fontSize: '0.88rem', marginBottom: '0.35rem' }}>
                بيان وسبب التحويل <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <textarea
                required
                rows={3}
                placeholder="مثال: تغذية عهدة مشتريات محلية للمسؤول فلان لمصروفات الأسبوع..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #cbd5e1', resize: 'vertical' }}
              />
            </div>

            <button type="submit" className="btn btn--primary" disabled={busy || loading || !canCreate}>
              {busy ? 'جاري التسجيل…' : 'تسجيل طلب التحويل (بانتظار اعتماد الخزينة)'}
            </button>
          </form>
        </section>
      )}

      {/* ── سجل العمليات النقدية الأخير ── */}
      {activeTab === 'log' && (
        <section className="warehouse-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h3 style={{ margin: 0 }}>سجل السندات النقدية الأخيرة</h3>
            <span style={{ fontSize: '0.85rem', color: '#64748b' }}>عرض أحدث {filteredLogs.length} حركة</span>
          </div>

          <div className="warehouse-table-wrap">
            <table className="warehouse-table">
              <thead>
                <tr>
                  <th>رقم المستند</th>
                  <th>التاريخ</th>
                  <th>النوع</th>
                  <th>من حساب</th>
                  <th>إلى حساب</th>
                  <th>المبلغ</th>
                  <th>البيان والتصنيف</th>
                  <th>الحالة</th>
                  <th>المصدر</th>
                  <th>صاحب الطلب</th>
                </tr>
              </thead>
              <tbody>
                {filteredLogs.length === 0 ? (
                  <tr>
                    <td colSpan={10} style={{ textAlign: 'center', color: '#64748b' }}>
                      لا توجد مستندات مسجلة حتى الآن.
                    </td>
                  </tr>
                ) : (
                  filteredLogs.map((doc) => {
                    const isIncome = doc.document_type === 'income';
                    const isExpense = doc.document_type === 'expense';
                    return (
                      <tr key={doc.id}>
                        <td><code>{doc.document_number}</code></td>
                        <td style={{ fontSize: '0.82rem' }}>
                          {doc.occurred_at ? new Date(doc.occurred_at).toLocaleDateString('ar-EG') : '—'}
                        </td>
                        <td>
                          <span
                            style={{
                              fontSize: '0.78rem',
                              padding: '0.2rem 0.5rem',
                              borderRadius: '4px',
                              fontWeight: 600,
                              backgroundColor: isIncome ? '#dcfce7' : isExpense ? '#fee2e2' : '#e0e7ff',
                              color: isIncome ? '#166534' : isExpense ? '#991b1b' : '#3730a3',
                            }}
                          >
                            {isIncome ? 'قبض' : isExpense ? 'صرف' : 'تحويل'}
                          </span>
                        </td>
                        <td style={{ fontSize: '0.85rem' }}>{accountName(doc.from_account_id)}</td>
                        <td style={{ fontSize: '0.85rem' }}>{accountName(doc.to_account_id)}</td>
                        <td className="cell-money" style={{ fontWeight: 600, color: isIncome ? '#16a34a' : isExpense ? '#dc2626' : '#0f172a' }}>
                          {formatMoney(doc.amount)}
                        </td>
                        <td className="cell-wrap" style={{ fontSize: '0.85rem' }}>
                          {(() => {
                            // البيان محفوظ بصيغة «[التصنيف] النص»: نعرض التصنيف كوسم والنص يلتف داخل العمود
                            const m = /^\[([^\]]+)\]\s*(.*)$/s.exec(doc.description || '');
                            return m ? <><span className="cell-tag">{m[1]}</span>{m[2] || '—'}</> : (doc.description || '—');
                          })()}
                        </td>
                        <td>
                          <span
                            style={{
                              fontSize: '0.78rem',
                              padding: '0.2rem 0.5rem',
                              borderRadius: '4px',
                              fontWeight: 600,
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
                            <small style={{ display: 'block', marginTop: 4, whiteSpace: 'normal', minWidth: 160, color: '#991b1b' }}>السبب: {doc.rejection_reason}</small>
                          )}
                        </td>
                        <td style={{ fontSize: '0.8rem' }}>{cashSourceLabel(doc.source_system)}</td>
                        <td style={{ fontSize: '0.8rem', color: '#64748b' }}>{userLabel(doc.created_by, user?.id)}</td>
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
