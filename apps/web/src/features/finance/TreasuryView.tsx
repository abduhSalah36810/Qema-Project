import { FormEvent, useEffect, useState } from 'react';
import { CashAccount, CashDocument, financeApi } from './financeApi';

export function TreasuryView() {
  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [documents, setDocuments] = useState<CashDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [kind, setKind] = useState<'income' | 'expense' | 'transfer'>('expense');
  const [source, setSource] = useState('');
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('all');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [accountRows, documentRows] = await Promise.all([
        financeApi.getAccounts(),
        financeApi.getCashDocuments(),
      ]);
      setAccounts(accountRows);
      setDocuments(documentRows);
      const treasury = accountRows.find((row) => row.account_type === 'treasury');
      setDestination((val) => val || treasury?.id || '');
      setSource((val) => val || treasury?.id || '');
      setError('');
    } catch {
      setError('تعذر تحميل بيانات الخزنة. سجّل الدخول بحساب مخوّل وتحقق من اتصال الخدمة.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const submitDocument = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const treasury = accounts.find((row) => row.account_type === 'treasury');
      const payload = {
        document_type: kind,
        from_account_id: kind === 'income' ? null : source,
        to_account_id: kind === 'expense' ? null : kind === 'income' ? treasury?.id || null : destination,
        amount,
        description,
        occurred_at: new Date().toISOString(),
      };
      await financeApi.createCashDocument(payload);
      setAmount('');
      setDescription('');
      await load();
    } catch {
      setError('تعذر إنشاء المستند. راجع الحساب والمبلغ والصلاحية.');
    } finally {
      setBusy(false);
    }
  };

  const decide = async (id: string, decision: 'approve' | 'reject') => {
    let rejection_reason: string | undefined;
    if (decision === 'reject') {
      rejection_reason = window.prompt('سبب رفض المستند؟')?.trim();
      if (!rejection_reason) return;
    }
    setBusy(true);
    try {
      await financeApi.decideDocument(id, decision, rejection_reason);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر اعتماد المستند.');
    } finally {
      setBusy(false);
    }
  };

  const accountName = (id: string | null) => accounts.find((a) => a.id === id)?.name ?? '—';
  const treasuryAccounts = accounts.filter((a) => a.account_type === 'treasury');

  const filteredDocs = documents.filter((doc) => {
    if (statusFilter === 'all') return true;
    return doc.status === statusFilter;
  });

  return (
    <section className="warehouse-page" dir="rtl" aria-labelledby="treasury-title">
      <header className="warehouse-page__header">
        <div>
          <span className="warehouse-page__eyebrow">الإدارة المالية التشغيلية</span>
          <h2 id="treasury-title">الخزنة الرئيسية والحسابات النقدية</h2>
          <p>متابعة أرصدة الخزينة، إصدار مستندات الصرف والقبض والتحويل، واعتماد القيود.</p>
        </div>
        <button className="btn btn--secondary" onClick={() => void load()}>
          تحديث
        </button>
      </header>

      {error && <div className="warehouse-alert" role="alert">{error}</div>}

      {/* بطاقات أرصدة الخزينة */}
      <div className="warehouse-summary">
        {treasuryAccounts.map((account) => (
          <article key={account.id}>
            <span>{account.name}</span>
            <strong>{Number(account.balance).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م</strong>
            <small>رقم الحساب: {account.account_number}</small>
          </article>
        ))}
        <article>
          <span>المستندات بانتظار الاعتماد</span>
          <strong style={{ color: '#d97706' }}>
            {documents.filter((d) => d.status === 'pending').length} مستند
          </strong>
          <small>تتطلب موافقة مسؤول المالية</small>
        </article>
      </div>

      {/* نموذج إنشاء مستند مالي جديد */}
      <section className="warehouse-draft" style={{ marginTop: '1.5rem' }}>
        <h3>إنشاء مستند مالي (صرف / قبض / تحويل)</h3>
        <form className="warehouse-toolbar" onSubmit={(e) => void submitDocument(e)}>
          <label>
            نوع العملية
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="expense">مصروف نقدي</option>
              <option value="income">إيراد نقدي</option>
              <option value="transfer">تحويل داخلي / تغذية عهدة</option>
            </select>
          </label>
          {kind !== 'income' && (
            <label>
              من حساب
              <select required value={source} onChange={(e) => setSource(e.target.value)}>
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.name} ({acc.account_type === 'treasury' ? 'خزنة' : 'عهدة'})
                  </option>
                ))}
              </select>
            </label>
          )}
          {kind !== 'expense' && (
            <label>
              إلى حساب
              <select required value={destination} onChange={(e) => setDestination(e.target.value)}>
                {accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    {acc.name} ({acc.account_type === 'treasury' ? 'خزنة' : 'عهدة'})
                  </option>
                ))}
              </select>
            </label>
          )}
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
            السبب / الوصف
            <input
              required
              maxLength={2000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="بيان العملية وسبب الصرف/القبض"
            />
          </label>
          <button className="btn btn--primary" disabled={busy || loading}>
            إرسال للمراجعة
          </button>
        </form>
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: '#64748b' }}>
          لا يرحل أي أثر مالي على رصيد الخزنة قبل الاعتماد، ويُمنع اعتماد صرف يتجاوز الرصيد المتاح.
        </p>
      </section>

      {/* سجل الحركات النقدية */}
      <section className="warehouse-draft" style={{ marginTop: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
          <div>
            <h3 style={{ margin: 0 }}>سجل الحركات النقدية للخزينة</h3>
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#64748b' }}>
              كل عملية معتمدة توثق المنفذ والوقت والمبلغ في دفتر اليومية النقدي.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              style={{ padding: '0.35rem 0.75rem', borderRadius: '6px', border: '1px solid #cbd5e1' }}
            >
              <option value="all">كل الحالات</option>
              <option value="pending">بانتظار الاعتماد</option>
              <option value="approved">معتمد</option>
              <option value="rejected">مرفوض</option>
            </select>
          </div>
        </div>

        {loading ? (
          <p>جاري التحميل…</p>
        ) : filteredDocs.length === 0 ? (
          <p style={{ color: '#64748b' }}>لا توجد مستندات نقدية مطابقة للفلتر المحدد.</p>
        ) : (
          <div className="warehouse-table-wrap">
            <table className="warehouse-table">
              <thead>
                <tr>
                  <th>رقم المستند</th>
                  <th>النوع</th>
                  <th>من حساب</th>
                  <th>إلى حساب</th>
                  <th>المبلغ</th>
                  <th>الوصف</th>
                  <th>الحالة</th>
                  <th>إجراء</th>
                </tr>
              </thead>
              <tbody>
                {filteredDocs.map((doc) => (
                  <tr key={doc.id}>
                    <td>
                      <code>{doc.document_number}</code>
                    </td>
                    <td>
                      <span
                        style={{
                          fontSize: '0.8rem',
                          padding: '0.2rem 0.5rem',
                          borderRadius: '4px',
                          backgroundColor:
                            doc.document_type === 'income'
                              ? '#dcfce7'
                              : doc.document_type === 'expense'
                              ? '#fee2e2'
                              : '#e0e7ff',
                          color:
                            doc.document_type === 'income'
                              ? '#166534'
                              : doc.document_type === 'expense'
                              ? '#991b1b'
                              : '#3730a3',
                        }}
                      >
                        {doc.document_type === 'income' ? 'إيراد' : doc.document_type === 'expense' ? 'مصروف' : 'تحويل'}
                      </span>
                    </td>
                    <td>{accountName(doc.from_account_id)}</td>
                    <td>{accountName(doc.to_account_id)}</td>
                    <td>
                      <strong>
                        {Number(doc.amount).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م
                      </strong>
                    </td>
                    <td>{doc.description}</td>
                    <td>
                      <span
                        style={{
                          fontSize: '0.8rem',
                          padding: '0.2rem 0.5rem',
                          borderRadius: '4px',
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
                        {doc.status === 'pending'
                          ? 'بانتظار الاعتماد'
                          : doc.status === 'approved'
                          ? 'معتمد'
                          : doc.status === 'rejected'
                          ? `مرفوض: ${doc.rejection_reason ?? ''}`
                          : 'معكوس'}
                      </span>
                    </td>
                    <td>
                      {doc.status === 'pending' && (
                        <div style={{ display: 'flex', gap: '0.35rem' }}>
                          <button
                            className="btn btn--primary"
                            style={{ padding: '0.25rem 0.6rem', fontSize: '0.8rem' }}
                            disabled={busy}
                            onClick={() => void decide(doc.id, 'approve')}
                          >
                            اعتماد
                          </button>
                          <button
                            className="btn btn--secondary"
                            style={{ padding: '0.25rem 0.6rem', fontSize: '0.8rem', color: '#dc2626' }}
                            disabled={busy}
                            onClick={() => void decide(doc.id, 'reject')}
                          >
                            رفض
                          </button>
                        </div>
                      )}
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

