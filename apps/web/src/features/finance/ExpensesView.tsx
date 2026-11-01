import { FormEvent, useEffect, useState } from 'react';
import { CashAccount, CashDocument, financeApi } from './financeApi';

export function ExpensesView() {
  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [documents, setDocuments] = useState<CashDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [sourceAccount, setSourceAccount] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [accountRows, documentRows] = await Promise.all([
        financeApi.getAccounts(),
        financeApi.getCashDocuments(),
      ]);
      setAccounts(accountRows);
      const expenseDocs = documentRows.filter((d) => d.document_type === 'expense');
      setDocuments(expenseDocs);
      const treasury = accountRows.find((a) => a.account_type === 'treasury');
      setSourceAccount(treasury?.id || '');
      setError('');
    } catch {
      setError('تعذر تحميل بيانات المصروفات.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const submitExpense = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await financeApi.createCashDocument({
        document_type: 'expense',
        from_account_id: sourceAccount || null,
        to_account_id: null,
        amount,
        description,
        occurred_at: new Date().toISOString(),
      });
      setAmount('');
      setDescription('');
      await load();
    } catch {
      setError('تعذر تسجيل مستند المصروف. تحقق من كفاية الرصيد والصلاحيات.');
    } finally {
      setBusy(false);
    }
  };

  const accountName = (id: string | null) => accounts.find((a) => a.id === id)?.name ?? '—';

  const approvedTotal = documents
    .filter((d) => d.status === 'approved')
    .reduce((sum, d) => sum + Number(d.amount), 0);

  const pendingTotal = documents
    .filter((d) => d.status === 'pending')
    .reduce((sum, d) => sum + Number(d.amount), 0);

  return (
    <section className="warehouse-page" dir="rtl" aria-labelledby="expenses-title">
      <header className="warehouse-page__header">
        <div>
          <span className="warehouse-page__eyebrow">التدفقات النقدية الخارجة</span>
          <h2 id="expenses-title">المصروفات التشغيلية</h2>
          <p>توثيق المصروفات النقدية التشغيلية اليومية المعتمدة بخصمها من الخزينة أو العهد.</p>
        </div>
        <button className="btn btn--secondary" onClick={() => void load()}>
          تحديث
        </button>
      </header>

      {error && <div className="warehouse-alert" role="alert">{error}</div>}

      <div className="warehouse-summary">
        <article>
          <span>إجمالي المصروفات المعتمدة</span>
          <strong style={{ color: '#dc2626' }}>
            {approvedTotal.toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م
          </strong>
          <small>{documents.filter((d) => d.status === 'approved').length} مستند معتمد</small>
        </article>
        <article>
          <span>مصروفات قيد الاعتماد</span>
          <strong style={{ color: '#d97706' }}>
            {pendingTotal.toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م
          </strong>
          <small>{documents.filter((d) => d.status === 'pending').length} مستند قيد المراجعة</small>
        </article>
      </div>

      <section className="warehouse-draft" style={{ marginTop: '1.5rem' }}>
        <h3>تسجيل مصروف تشغيلي جديد</h3>
        <form className="warehouse-toolbar" onSubmit={(e) => void submitExpense(e)}>
          <label>
            خصم من حساب
            <select required value={sourceAccount} onChange={(e) => setSourceAccount(e.target.value)}>
              {accounts.map((acc) => (
                <option key={acc.id} value={acc.id}>
                  {acc.name} ({acc.account_type === 'treasury' ? 'خزنة' : 'عهدة'}) — رصيد: {Number(acc.balance).toLocaleString('ar-EG')} ج.م
                </option>
              ))}
            </select>
          </label>
          <label>
            المبلغ بالجنيه
            <input
              required
              type="number"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </label>
          <label>
            البيان وسبب الصرف
            <input
              required
              maxLength={2000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="مثال: صيانة ماكينة خياطة / شراء أدوات نظافة / مصاريف تشغيل"
            />
          </label>
          <button className="btn btn--primary" disabled={busy || loading}>
            إرسال للمراجعة
          </button>
        </form>
      </section>

      <section className="warehouse-draft" style={{ marginTop: '1.5rem' }}>
        <h3>سجل مستندات المصروفات</h3>
        {loading ? (
          <p>جاري التحميل…</p>
        ) : documents.length === 0 ? (
          <p style={{ color: '#64748b' }}>لا توجد مستندات مصروفات مسجلة حتى الآن.</p>
        ) : (
          <div className="warehouse-table-wrap">
            <table className="warehouse-table">
              <thead>
                <tr>
                  <th>رقم المستند</th>
                  <th>الحساب المخصوم منه</th>
                  <th>المبلغ</th>
                  <th>البيان</th>
                  <th>تاريخ القيد</th>
                  <th>الحالة</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => (
                  <tr key={doc.id}>
                    <td>
                      <code>{doc.document_number}</code>
                    </td>
                    <td>{accountName(doc.from_account_id)}</td>
                    <td>
                      <strong style={{ color: '#dc2626' }}>
                        -{Number(doc.amount).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م
                      </strong>
                    </td>
                    <td>{doc.description}</td>
                    <td>{new Date(doc.occurred_at).toLocaleDateString('ar-EG')}</td>
                    <td>
                      <span
                        style={{
                          fontSize: '0.8rem',
                          padding: '0.2rem 0.5rem',
                          borderRadius: '4px',
                          backgroundColor:
                            doc.status === 'approved' ? '#dcfce7' : doc.status === 'pending' ? '#fef3c7' : '#fee2e2',
                          color:
                            doc.status === 'approved' ? '#166534' : doc.status === 'pending' ? '#92400e' : '#991b1b',
                        }}
                      >
                        {doc.status === 'approved' ? 'معتمد' : doc.status === 'pending' ? 'بانتظار الاعتماد' : 'مرفوض'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}

