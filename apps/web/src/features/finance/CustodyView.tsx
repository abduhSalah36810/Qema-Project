import { FormEvent, useEffect, useState } from 'react';
import { CashAccount, CashDocument, financeApi } from './financeApi';

export function CustodyView() {
  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [documents, setDocuments] = useState<CashDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pettyName, setPettyName] = useState('');
  const [fundAccount, setFundAccount] = useState('');
  const [fundAmount, setFundAmount] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [accountRows, documentRows] = await Promise.all([
        financeApi.getAccounts(),
        financeApi.getCashDocuments(),
      ]);
      setAccounts(accountRows);
      // Filter documents where either from or to is petty cash
      const pettyIds = new Set(accountRows.filter((a) => a.account_type === 'petty_cash').map((a) => a.id));
      const pettyDocs = documentRows.filter(
        (d) => (d.from_account_id && pettyIds.has(d.from_account_id)) || (d.to_account_id && pettyIds.has(d.to_account_id))
      );
      setDocuments(pettyDocs);

      const firstPetty = accountRows.find((a) => a.account_type === 'petty_cash' && a.is_active);
      if (firstPetty) setFundAccount(firstPetty.id);
      setError('');
    } catch {
      setError('تعذر تحميل بيانات العهد المالية.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const createPetty = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await financeApi.createPettyCash(pettyName);
      setPettyName('');
      await load();
    } catch {
      setError('تعذر إنشاء حساب العهدة اليومية.');
    } finally {
      setBusy(false);
    }
  };

  const settlePetty = async (accountId: string, accountName: string) => {
    if (!window.confirm(`تأكيد تسوية صندوق العهدة "${accountName}"؟ سيُرد الرصيد المتبقي للخزنة الرئيسية ويُغلق الحساب.`)) {
      return;
    }
    setBusy(true);
    try {
      await financeApi.settlePettyCash(accountId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'تعذر تسوية صندوق العهدة.');
    } finally {
      setBusy(false);
    }
  };

  const fundPetty = async (e: FormEvent) => {
    e.preventDefault();
    const treasury = accounts.find((a) => a.account_type === 'treasury');
    if (!treasury) {
      setError('لم يتم العثور على حساب الخزنة الرئيسية لتمويل العهدة.');
      return;
    }
    setBusy(true);
    try {
      await financeApi.createCashDocument({
        document_type: 'transfer',
        from_account_id: treasury.id,
        to_account_id: fundAccount,
        amount: fundAmount,
        description: `تغذية عهدة نقدية من الخزينة الرئيسية`,
        occurred_at: new Date().toISOString(),
      });
      setFundAmount('');
      await load();
    } catch {
      setError('تعذر تقديم طلب تغذية العهدة.');
    } finally {
      setBusy(false);
    }
  };

  const pettyAccounts = accounts.filter((a) => a.account_type === 'petty_cash');
  const activePettyTotal = pettyAccounts
    .filter((a) => a.is_active)
    .reduce((sum, a) => sum + Number(a.balance), 0);

  const accountName = (id: string | null) => accounts.find((a) => a.id === id)?.name ?? '—';

  return (
    <section className="warehouse-page" dir="rtl" aria-labelledby="custody-title">
      <header className="warehouse-page__header">
        <div>
          <span className="warehouse-page__eyebrow">إدارة الصناديق والمصروفات اليومية</span>
          <h2 id="custody-title">العهد المالية المؤقتة</h2>
          <p>إنشاء العهد التشغيلية، تمويلها بالتحويل من الخزينة، وإجراء التسوية ورد الفائض.</p>
        </div>
        <button className="btn btn--secondary" onClick={() => void load()}>
          تحديث
        </button>
      </header>

      {error && <div className="warehouse-alert" role="alert">{error}</div>}

      <div className="warehouse-summary">
        <article>
          <span>إجمالي رصيد العهد النشطة</span>
          <strong style={{ color: '#0f766e' }}>
            {activePettyTotal.toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م
          </strong>
          <small>{pettyAccounts.filter((a) => a.is_active).length} صندوق عهدة نشط</small>
        </article>
        <article>
          <span>الصناديق المغلقة / المسواة</span>
          <strong>{pettyAccounts.filter((a) => !a.is_active).length}</strong>
          <small>تم رد فوائضها للخزينة</small>
        </article>
      </div>

      {/* صناديق العهد النشطة */}
      <section className="warehouse-draft" style={{ marginTop: '1.5rem' }}>
        <h3>صناديق العهد النقدية</h3>
        {pettyAccounts.length === 0 ? (
          <p style={{ color: '#64748b' }}>لا توجد صناديق عهد مسجلة حالياً.</p>
        ) : (
          <div className="warehouse-summary" style={{ marginTop: '0.75rem' }}>
            {pettyAccounts.map((account) => (
              <article key={account.id} style={{ borderColor: account.is_active ? '#cbd5e1' : '#e2e8f0', opacity: account.is_active ? 1 : 0.7 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>{account.name}</span>
                  <span
                    style={{
                      fontSize: '0.75rem',
                      padding: '0.15rem 0.5rem',
                      borderRadius: '4px',
                      backgroundColor: account.is_active ? '#dcfce7' : '#f1f5f9',
                      color: account.is_active ? '#166534' : '#64748b',
                    }}
                  >
                    {account.is_active ? 'نشطة' : 'مسواة ومغلقة'}
                  </span>
                </div>
                <strong>{Number(account.balance).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م</strong>
                <small>حساب: {account.account_number}</small>
                {account.is_active && (
                  <button
                    className="btn btn--secondary"
                    style={{ marginTop: '0.5rem', fontSize: '0.8rem', padding: '0.25rem 0.5rem' }}
                    disabled={busy}
                    onClick={() => void settlePetty(account.id, account.name)}
                    title="رد الرصيد المتبقي للخزنة الرئيسية وإغلاق العهدة"
                  >
                    تسوية العهدة ورد المتبقي
                  </button>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      {/* إنشاء عهدة جديدة وتغذية عهدة */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1rem', marginTop: '1.5rem' }}>
        <section className="warehouse-draft">
          <h3>إنشاء صندوق عهدة يومية جديد</h3>
          <form className="warehouse-toolbar" onSubmit={(e) => void createPetty(e)}>
            <label>
              اسم العهدة
              <input
                required
                value={pettyName}
                onChange={(e) => setPettyName(e.target.value)}
                placeholder="مثال: عهدة التشغيل اليومية"
              />
            </label>
            <button className="btn btn--secondary" disabled={busy || !pettyName.trim()}>
              إنشاء العهدة
            </button>
          </form>
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: '#64748b' }}>
            بعد إنشاء الحساب، أنشئ طلب تغذية لتحويل المبلغ المطلوب من الخزنة الرئيسية.
          </p>
        </section>

        <section className="warehouse-draft">
          <h3>طلب تغذية عهدة من الخزينة الرئيسية</h3>
          <form className="warehouse-toolbar" onSubmit={(e) => void fundPetty(e)}>
            <label>
              العهدة المستلمة
              <select required value={fundAccount} onChange={(e) => setFundAccount(e.target.value)}>
                {pettyAccounts
                  .filter((a) => a.is_active)
                  .map((acc) => (
                    <option key={acc.id} value={acc.id}>
                      {acc.name} (رصيد: {Number(acc.balance).toLocaleString('ar-EG')} ج.م)
                    </option>
                  ))}
              </select>
            </label>
            <label>
              المبلغ المطلوب
              <input
                required
                type="number"
                min="0.01"
                step="0.01"
                value={fundAmount}
                onChange={(e) => setFundAmount(e.target.value)}
                placeholder="0.00"
              />
            </label>
            <button className="btn btn--primary" disabled={busy || !fundAmount}>
              طلب التغذية
            </button>
          </form>
          <p style={{ margin: '0.5rem 0 0', fontSize: '0.85rem', color: '#64748b' }}>
            يتم إنشاء مستند تحويل داخلي ينتظر اعتماد مسؤول المالية.
          </p>
        </section>
      </div>

      {/* سجل حركات العهد */}
      <section className="warehouse-draft" style={{ marginTop: '1.5rem' }}>
        <h3>سجل حركات العهد المالية (تغذية، صرف، ورد)</h3>
        {loading ? (
          <p>جاري التحميل…</p>
        ) : documents.length === 0 ? (
          <p style={{ color: '#64748b' }}>لا توجد حركات مسجلة للعهد المالية حتى الآن.</p>
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
                  <th>البيان</th>
                  <th>الحالة</th>
                </tr>
              </thead>
              <tbody>
                {documents.map((doc) => (
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
                            doc.document_type === 'transfer' ? '#e0e7ff' : doc.document_type === 'expense' ? '#fee2e2' : '#dcfce7',
                          color:
                            doc.document_type === 'transfer' ? '#3730a3' : doc.document_type === 'expense' ? '#991b1b' : '#166534',
                        }}
                      >
                        {doc.document_type === 'transfer' ? 'تحويل / رد عهدة' : doc.document_type === 'expense' ? 'صرف من عهدة' : 'إيداع'}
                      </span>
                    </td>
                    <td>{accountName(doc.from_account_id)}</td>
                    <td>{accountName(doc.to_account_id)}</td>
                    <td>
                      <strong>{Number(doc.amount).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م</strong>
                    </td>
                    <td>{doc.description}</td>
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

