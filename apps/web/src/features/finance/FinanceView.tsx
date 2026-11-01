import { FormEvent, useEffect, useState } from 'react';
import { apiClient } from '@/lib/api';
import { SupplierPurchasingView } from './SupplierPurchasingView';

type CashAccount = { id: string; account_number: string; name: string; account_type: 'treasury' | 'petty_cash'; parent_account_id: string | null; is_active: boolean; balance: string };
type CashDocument = { id: string; document_number: string; document_type: 'income' | 'expense' | 'transfer'; from_account_id: string | null; to_account_id: string | null; amount: string; description: string; occurred_at: string; status: string; created_by: string; approved_by: string | null; rejection_reason: string | null };

export function FinanceView() {
  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [documents, setDocuments] = useState<CashDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [kind, setKind] = useState<'income' | 'expense' | 'transfer'>('expense');
  const [source, setSource] = useState('');
  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [pettyName, setPettyName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [accountRows, documentRows] = await Promise.all([
        apiClient.request<CashAccount[]>('/api/v1/finance/accounts'),
        apiClient.request<CashDocument[]>('/api/v1/finance/cash-documents'),
      ]);
      setAccounts(accountRows);
      setDocuments(documentRows);
      const treasury = accountRows.find((row) => row.account_type === 'treasury');
      setDestination((value) => value || treasury?.id || '');
      setSource((value) => value || treasury?.id || '');
      setError('');
    } catch { setError('تعذر تحميل بيانات الخزنة. سجّل الدخول بحساب مخوّل وتحقق من اتصال الخدمة.'); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, []);

  const submitDocument = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const treasury = accounts.find((row) => row.account_type === 'treasury');
      const payload = {
        document_type: kind,
        from_account_id: kind === 'income' ? null : source,
        to_account_id: kind === 'expense' ? null : (kind === 'income' ? treasury?.id : destination),
        amount, description, occurred_at: new Date().toISOString(),
      };
      await apiClient.request('/api/v1/finance/cash-documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      setAmount(''); setDescription(''); await load();
    } catch { setError('تعذر إنشاء المستند. راجع الحساب والمبلغ والصلاحية.'); }
    finally { setBusy(false); }
  };

  const createPetty = async (event: FormEvent) => {
    event.preventDefault();
    const query = new URLSearchParams({ name: pettyName, business_date: new Date().toISOString() });
    setBusy(true);
    try { await apiClient.request(`/api/v1/finance/petty-cash?${query}`, { method: 'POST' }); setPettyName(''); await load(); }
    catch { setError('تعذر إنشاء العهدة اليومية.'); }
    finally { setBusy(false); }
  };

  const settlePetty = async (accountId: string, accountName: string) => {
    if (!window.confirm(`تأكيد تسوية صندوق العهدة "${accountName}"؟ سيُرد الرصيد المتبقي للخزنة الرئيسية ويُغلق الحساب.`)) return;
    setBusy(true);
    try {
      const description = encodeURIComponent('تسوية صندوق العهدة اليومية');
      await apiClient.request(`/api/v1/finance/petty-cash/${accountId}/settle?description=${description}`, { method: 'POST' });
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : 'تعذر تسوية صندوق العهدة.'); }
    finally { setBusy(false); }
  };

  const decide = async (id: string, decision: 'approve' | 'reject') => {
    let rejection_reason: string | undefined;
    if (decision === 'reject') { rejection_reason = window.prompt('سبب رفض المستند؟')?.trim(); if (!rejection_reason) return; }
    setBusy(true);
    try { await apiClient.request(`/api/v1/finance/cash-documents/${id}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, rejection_reason }) }); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : 'تعذر اعتماد المستند.'); }
    finally { setBusy(false); }
  };

  const accountName = (id: string | null) => accounts.find((account) => account.id === id)?.name ?? '—';
  return <section className="warehouse-page" dir="rtl" aria-labelledby="finance-title">
    <header className="warehouse-page__header"><div><span className="warehouse-page__eyebrow">الإدارة المالية التشغيلية</span><h2 id="finance-title">الخزنة والعهدة اليومية</h2><p>الأرصدة مشتقة من المستندات المعتمدة، وكل اعتماد يسجل منفذ القرار.</p></div><button className="btn btn--secondary" onClick={() => void load()}>تحديث</button></header>
    {error && <div className="warehouse-alert" role="alert">{error}</div>}
    <div className="warehouse-summary">{accounts.map((account) => <article key={account.id}><span>{account.name}</span><strong>{Number(account.balance).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م</strong><small>{account.account_number}</small>{account.account_type === 'petty_cash' && account.is_active && <button className="btn btn--secondary" style={{ marginTop: '0.5rem', fontSize: '0.8rem', padding: '0.25rem 0.5rem' }} disabled={busy} onClick={() => void settlePetty(account.id, account.name)} title="رد الرصيد المتبقي للخزنة وإغلاق العهدة">تسوية العهدة</button>}</article>)}</div>
    <section className="warehouse-draft"><h3>إنشاء مستند مالي</h3><form className="warehouse-toolbar" onSubmit={(event) => void submitDocument(event)}>
      <label>نوع العملية<select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="expense">مصروف</option><option value="income">إيراد</option><option value="transfer">تحويل / تمويل عهدة / رد متبقي</option></select></label>
      {kind !== 'income' && <label>من حساب<select required value={source} onChange={(event) => setSource(event.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>}
      {kind !== 'expense' && <label>إلى حساب<select required value={destination} onChange={(event) => setDestination(event.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>}
      <label>المبلغ بالجنيه<input required type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
      <label>السبب / الوصف<input required maxLength={2000} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
      <button className="btn btn--primary" disabled={busy || loading}>إرسال للمراجعة</button>
    </form><p>يعتمد مدير المالية المستندات. لا يُرحّل أي أثر قبل الاعتماد، ويُمنع اعتماد صرف يتجاوز الرصيد.</p></section>
    <section className="warehouse-draft"><h3>إنشاء عهدة يومية</h3><form className="warehouse-toolbar" onSubmit={(event) => void createPetty(event)}><label>اسم العهدة<input required value={pettyName} onChange={(event) => setPettyName(event.target.value)} placeholder="عهدة التشغيل اليومية" /></label><button className="btn btn--secondary" disabled={busy}>إنشاء العهدة</button></form><p>بعد إنشائها، أنشئ مستند تحويل من الخزنة لتمويلها. وتُرد المبالغ المتبقية بتحويل عكسي معتمد.</p></section>
    <section className="warehouse-draft"><h3>سجل الحركات النقدية</h3>{loading ? <p>جاري التحميل…</p> : <div className="warehouse-table-wrap"><table className="warehouse-table"><thead><tr><th>المرجع</th><th>النوع</th><th>من</th><th>إلى</th><th>المبلغ</th><th>الوصف</th><th>الحالة</th><th>إجراء</th></tr></thead><tbody>{documents.map((doc) => <tr key={doc.id}><td>{doc.document_number}</td><td>{doc.document_type === 'income' ? 'إيراد' : doc.document_type === 'expense' ? 'مصروف' : 'تحويل'}</td><td>{accountName(doc.from_account_id)}</td><td>{accountName(doc.to_account_id)}</td><td>{Number(doc.amount).toLocaleString('ar-EG', { minimumFractionDigits: 2 })}</td><td>{doc.description}</td><td>{doc.status === 'pending' ? 'بانتظار الاعتماد' : doc.status === 'approved' ? 'معتمد' : doc.status === 'rejected' ? `مرفوض: ${doc.rejection_reason ?? ''}` : 'معكوس'}</td><td>{doc.status === 'pending' && <span><button disabled={busy} onClick={() => void decide(doc.id, 'approve')}>اعتماد</button> <button disabled={busy} onClick={() => void decide(doc.id, 'reject')}>رفض</button></span>}</td></tr>)}</tbody></table></div>}</section>
    <SupplierPurchasingView />
  </section>;
}
