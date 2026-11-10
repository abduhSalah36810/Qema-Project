import { CSSProperties, FormEvent, useEffect, useState } from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import {
  CashAccount,
  CashDocument,
  CustodySettlementPreview,
  CustodySettlementRead,
  cashStatusLabel,
  errorMessage,
  financeApi,
  formatMoney,
  toNumber,
} from './financeApi';

const modalBackdrop: CSSProperties = {
  position: 'fixed',
  inset: 0,
  backgroundColor: 'rgba(15, 23, 42, 0.65)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 9999,
  padding: '1rem',
};

const errorBox: CSSProperties = {
  padding: '0.65rem 0.85rem',
  backgroundColor: '#fef2f2',
  border: '1px solid #fecaca',
  borderRadius: '6px',
  color: '#991b1b',
  fontSize: '0.85rem',
  marginBottom: '1rem',
};

const SETTLEMENT_STATUS_LABELS: Record<string, string> = {
  pending: 'بانتظار اعتماد الخزينة',
  approved: 'معتمدة',
  rejected: 'مرفوضة',
};

interface SettlementModalProps {
  accountId: string;
  accountName: string;
  onClose: () => void;
  onSettled: (settlement: CustodySettlementRead) => void;
}

function CustodySettlementModal({ accountId, accountName, onClose, onSettled }: SettlementModalProps) {
  const [preview, setPreview] = useState<CustodySettlementPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [returnedCash, setReturnedCash] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    let active = true;
    const fetchPreview = async () => {
      try {
        const data = await financeApi.previewCustodySettlement(accountId);
        if (!active) return;
        setPreview(data);
        setReturnedCash(toNumber(data.current_balance).toFixed(2));
      } catch (err) {
        if (active) setError(errorMessage(err, 'تعذر جلب موقف العهدة من الخادم.'));
      } finally {
        if (active) setLoading(false);
      }
    };
    void fetchPreview();
    return () => {
      active = false;
    };
  }, [accountId]);

  const currentBalance = toNumber(preview?.current_balance);
  const returnedNum = toNumber(returnedCash);
  const remainingAfter = Math.round((currentBalance - returnedNum) * 100) / 100;
  const amountInvalid = returnedCash.trim() === '' || returnedNum < 0 || returnedNum > currentBalance + 0.0001;
  const blocked = Boolean(preview?.has_pending_settlement) || preview?.is_active === false;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (amountInvalid) {
      setError(`النقدية المردودة يجب أن تكون بين صفر والرصيد الحالي للعهدة (${formatMoney(currentBalance)}).`);
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const settlement = await financeApi.createCustodySettlement(accountId, {
        returned_cash_amount: returnedNum.toFixed(2),
        notes: notes.trim(),
      });
      onSettled(settlement);
    } catch (err) {
      setError(errorMessage(err, 'تعذر رفع تسوية العهدة.'));
    } finally {
      setSubmitting(false);
    }
  };

  const stat = (label: string, value: unknown, color: string, bg: string) => (
    <div style={{ backgroundColor: bg, padding: '0.75rem', borderRadius: '8px', textAlign: 'center' }}>
      <span style={{ fontSize: '0.75rem', color, display: 'block' }}>{label}</span>
      <strong style={{ fontSize: '1.05rem', color }}>{formatMoney(value)}</strong>
    </div>
  );

  return (
    <div style={modalBackdrop} role="dialog" aria-modal="true" aria-labelledby="settlement-title" dir="rtl">
      <div
        style={{
          backgroundColor: '#ffffff',
          borderRadius: '12px',
          maxWidth: '620px',
          width: '100%',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.2)',
          overflow: 'hidden',
          maxHeight: '95vh',
          overflowY: 'auto',
        }}
      >
        <header
          style={{
            padding: '1.25rem 1.5rem',
            borderBottom: '1px solid #e2e8f0',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            backgroundColor: '#f8fafc',
          }}
        >
          <div>
            <h3 id="settlement-title" style={{ margin: 0, fontSize: '1.15rem', color: '#0f172a' }}>
              تسوية العهدة ورد النقدية للخزنة
            </h3>
            <span style={{ fontSize: '0.85rem', color: '#64748b' }}>العهدة: {accountName}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="btn btn--secondary"
            style={{ padding: '0.35rem 0.75rem', fontSize: '0.85rem' }}
            disabled={submitting}
          >
            إغلاق ✕
          </button>
        </header>

        {loading ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: '#64748b' }}>جاري تحميل موقف العهدة من الخادم…</div>
        ) : (
          <form onSubmit={(e) => void handleSubmit(e)} style={{ padding: '1.5rem' }}>
            {error && <div role="alert" style={errorBox}>{error}</div>}

            {preview && (
              <>
                <p style={{ margin: '0 0 0.75rem', fontSize: '0.82rem', color: '#475569' }}>
                  الأرقام التالية يحسبها النظام من دفتر النقدية (الحركات المعتمدة فقط):
                </p>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                    gap: '0.75rem',
                    marginBottom: '1.25rem',
                  }}
                >
                  {stat('صافي العهدة', preview.original_custody_amount, '#0f172a', '#f1f5f9')}
                  {stat('المصروفات المعتمدة', preview.total_expenses_recorded, '#991b1b', '#fef2f2')}
                  {stat('المردود سابقاً', preview.previously_returned, '#1e40af', '#eff6ff')}
                  {stat('الرصيد الحالي', preview.current_balance, '#065f46', '#ecfdf5')}
                </div>
              </>
            )}

            {preview?.has_pending_settlement && (
              <div role="alert" style={errorBox}>
                توجد تسوية سابقة لهذه العهدة بانتظار اعتماد الخزينة. لا يمكن رفع تسوية جديدة حتى يتم البت فيها.
              </div>
            )}

            <div style={{ marginBottom: '1rem' }}>
              <label
                htmlFor="custody-returned-cash"
                style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.35rem', color: '#334155' }}
              >
                النقدية المردودة الآن للخزنة (ج.م) *
              </label>
              <input
                id="custody-returned-cash"
                type="number"
                step="0.01"
                min="0"
                max={currentBalance}
                required
                value={returnedCash}
                onChange={(e) => setReturnedCash(e.target.value)}
                style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #cbd5e1' }}
              />
              <span style={{ display: 'block', fontSize: '0.78rem', color: '#64748b', marginTop: '0.3rem' }}>
                الحد الأقصى هو الرصيد الحالي ({formatMoney(currentBalance)}). المتبقي مع صاحب العهدة بعد هذا الرد:{' '}
                <strong>{formatMoney(Math.max(0, remainingAfter))}</strong>
              </span>
            </div>

            <div style={{ marginBottom: '1.25rem' }}>
              <label
                htmlFor="custody-settlement-notes"
                style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.35rem', color: '#334155' }}
              >
                ملاحظات التسوية
              </label>
              <textarea
                id="custody-settlement-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="بيان الفواتير المرفقة أو سبب التسوية…"
                rows={2}
                maxLength={2000}
                style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #cbd5e1', resize: 'vertical' }}
              />
            </div>

            <div
              style={{
                padding: '0.75rem',
                backgroundColor: '#eff6ff',
                borderRadius: '6px',
                border: '1px solid #bfdbfe',
                fontSize: '0.8rem',
                color: '#1e40af',
                marginBottom: '1.25rem',
                lineHeight: 1.6,
              }}
            >
              المصروفات والمتبقي يحسبهما الخادم. رد النقدية يُسجل كمستند تحويل بانتظار الاعتماد من شاشة الخزينة، ولا يتغير أي
              رصيد قبل الاعتماد. تُغلق العهدة تلقائياً عند رد كامل رصيدها واعتماد الرد. إذا كانت النقدية المردودة صفراً
              تُسجل التسوية توثيقياً دون حركة نقدية.
            </div>

            <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', flexWrap: 'wrap' }}>
              <button type="button" onClick={onClose} className="btn btn--secondary" disabled={submitting}>
                إلغاء
              </button>
              <button type="submit" className="btn btn--primary" disabled={submitting || amountInvalid || blocked || !preview}>
                {submitting ? 'جاري رفع التسوية…' : 'رفع التسوية للاعتماد'}
              </button>
            </footer>
          </form>
        )}
      </div>
    </div>
  );
}

// ── نافذة تسجيل مصروف يومي من عهدة ──
interface DailyExpenseModalProps {
  accounts: CashAccount[];
  onClose: () => void;
  onCreated: (doc: CashDocument) => void;
}

function DailyExpenseModal({ accounts, onClose, onCreated }: DailyExpenseModalProps) {
  const pettyAccounts = accounts.filter((a) => a.account_type === 'petty_cash' && a.is_active);
  const [accountId, setAccountId] = useState(pettyAccounts[0]?.id || '');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const num = toNumber(amount);
    if (num <= 0) {
      setError('يرجى إدخال مبلغ صحيح أكبر من الصفر.');
      return;
    }
    if (!description.trim()) {
      setError('يرجى كتابة بيان المصروف.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const doc = await financeApi.createDailyExpense({
        from_account_id: accountId,
        amount: num.toFixed(2),
        description: description.trim(),
        occurred_at: new Date().toISOString(),
      });
      onCreated(doc);
    } catch (err) {
      setError(errorMessage(err, 'تعذر تسجيل المصروف.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={modalBackdrop} role="dialog" aria-modal="true" aria-labelledby="daily-expense-title" dir="rtl">
      <div
        style={{
          backgroundColor: '#ffffff',
          borderRadius: '12px',
          maxWidth: '520px',
          width: '100%',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.2)',
          overflow: 'hidden',
        }}
      >
        <header
          style={{
            padding: '1.25rem 1.5rem',
            borderBottom: '1px solid #e2e8f0',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            backgroundColor: '#f8fafc',
          }}
        >
          <h3 id="daily-expense-title" style={{ margin: 0, fontSize: '1.1rem', color: '#0f172a' }}>
            تسجيل مصروف يومي من عهدة
          </h3>
          <button type="button" onClick={onClose} className="btn btn--secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.85rem' }} disabled={busy}>
            ✕
          </button>
        </header>
        <form onSubmit={(e) => void handleSubmit(e)} style={{ padding: '1.5rem' }}>
          {error && <div role="alert" style={errorBox}>{error}</div>}
          <div style={{ marginBottom: '1rem' }}>
            <label htmlFor="daily-expense-account" style={{ display: 'block', fontWeight: 600, fontSize: '0.88rem', marginBottom: '0.35rem' }}>
              يُصرف من عهدة *
            </label>
            <select
              id="daily-expense-account"
              required
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              style={{ width: '100%', padding: '0.55rem', borderRadius: '6px', border: '1px solid #cbd5e1' }}
            >
              {pettyAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} (الرصيد: {formatMoney(a.balance)})
                </option>
              ))}
            </select>
          </div>
          <div style={{ marginBottom: '1rem' }}>
            <label htmlFor="daily-expense-amount" style={{ display: 'block', fontWeight: 600, fontSize: '0.88rem', marginBottom: '0.35rem' }}>
              المبلغ (ج.م) *
            </label>
            <input
              id="daily-expense-amount"
              required
              type="number"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              style={{ width: '100%', padding: '0.55rem', borderRadius: '6px', border: '1px solid #cbd5e1' }}
            />
          </div>
          <div style={{ marginBottom: '1.25rem' }}>
            <label htmlFor="daily-expense-desc" style={{ display: 'block', fontWeight: 600, fontSize: '0.88rem', marginBottom: '0.35rem' }}>
              بيان المصروف *
            </label>
            <input
              id="daily-expense-desc"
              required
              maxLength={2000}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              style={{ width: '100%', padding: '0.55rem', borderRadius: '6px', border: '1px solid #cbd5e1' }}
            />
          </div>
          <p style={{ fontSize: '0.8rem', color: '#1e40af', margin: '0 0 1.25rem' }}>
            يُسجل المصروف بانتظار الاعتماد من شاشة الخزينة، ولا يُخصم من رصيد العهدة قبل اعتماده.
          </p>
          <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
            <button type="button" onClick={onClose} className="btn btn--secondary" disabled={busy}>
              إلغاء
            </button>
            <button type="submit" className="btn btn--primary" disabled={busy || !accountId}>
              {busy ? 'جاري التسجيل…' : 'تسجيل المصروف'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

// ── نافذة إنشاء صندوق عهدة جديد ──
interface CreateCustodyModalProps {
  onClose: () => void;
  onCreated: () => void;
}

function CreateCustodyModal({ onClose, onCreated }: CreateCustodyModalProps) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('يرجى إدخال اسم العهدة والمسؤول عنها بوضوح.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await financeApi.createPettyCash(name.trim());
      onCreated();
    } catch (err) {
      setError(errorMessage(err, 'تعذر إنشاء حساب العهدة اليومية.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '1rem',
      }}
      role="dialog"
      aria-modal="true"
      dir="rtl"
    >
      <div
        style={{
          backgroundColor: '#ffffff',
          borderRadius: '12px',
          maxWidth: '480px',
          width: '100%',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.2)',
          overflow: 'hidden',
        }}
      >
        <header
          style={{
            padding: '1.25rem 1.5rem',
            borderBottom: '1px solid #e2e8f0',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            backgroundColor: '#f8fafc',
          }}
        >
          <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#0f172a' }}>إنشاء صندوق عهدة تشغيلية جديد</h3>
          <button onClick={onClose} className="btn btn--secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.85rem' }} disabled={busy}>
            ✕
          </button>
        </header>

        <form onSubmit={handleSubmit} style={{ padding: '1.5rem' }}>
          {error && (
            <div style={{ padding: '0.65rem 0.85rem', backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: '6px', color: '#991b1b', fontSize: '0.85rem', marginBottom: '1rem' }}>
              {error}
            </div>
          )}

          <div style={{ marginBottom: '1.25rem' }}>
            <label style={{ display: 'block', fontWeight: 600, fontSize: '0.88rem', marginBottom: '0.4rem', color: '#334155' }}>
              اسم العهدة وصاحب المسؤولية <span style={{ color: '#dc2626' }}>*</span>
            </label>
            <input
              required
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="مثال: عهدة الصيانة ومستلزمات الإنتاج — م/ أحمد"
              style={{ width: '100%', padding: '0.6rem', borderRadius: '6px', border: '1px solid #cbd5e1' }}
            />
            <span style={{ display: 'block', marginTop: '0.35rem', fontSize: '0.78rem', color: '#64748b' }}>
              سيتم إنشاء حساب مالي فرعي مخصص للمسؤول. بعد الإنشاء يمكنك طلب تغذية العهدة بالتحويل من الخزينة.
            </span>
          </div>

          <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
            <button type="button" onClick={onClose} className="btn btn--secondary" disabled={busy}>
              إلغاء
            </button>
            <button type="submit" className="btn btn--primary" disabled={busy || !name.trim()}>
              {busy ? 'جاري الإنشاء…' : 'إنشاء حساب العهدة'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

// ── نافذة طلب تغذية عهدة من الخزينة ──
interface FundCustodyModalProps {
  accounts: CashAccount[];
  onClose: () => void;
  onFunded: (doc: CashDocument) => void;
}

function FundCustodyModal({ accounts, onClose, onFunded }: FundCustodyModalProps) {
  const pettyAccounts = accounts.filter((a) => a.account_type === 'petty_cash' && a.is_active);
  const treasury = accounts.find((a) => a.account_type === 'treasury');

  const [fundAccount, setFundAccount] = useState(pettyAccounts[0]?.id || '');
  const [fundAmount, setFundAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!treasury) {
      setError('لم يتم العثور على حساب الخزينة الرئيسية لتمويل العهدة.');
      return;
    }
    const num = parseFloat(fundAmount);
    if (isNaN(num) || num <= 0) {
      setError('يرجى إدخال مبلغ صحيح أكبر من الصفر.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const selectedPetty = accounts.find((a) => a.id === fundAccount);
      const desc = `تغذية عهدة نقدية: ${selectedPetty?.name || ''}${notes ? ` - ${notes.trim()}` : ''}`;
      const doc = await financeApi.createCashDocument({
        document_type: 'transfer',
        from_account_id: treasury.id,
        to_account_id: fundAccount,
        amount: num.toFixed(2),
        description: desc,
        occurred_at: new Date().toISOString(),
      });
      onFunded(doc);
    } catch (err) {
      setError(errorMessage(err, 'تعذر إنشاء طلب التغذية.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '1rem',
      }}
      role="dialog"
      aria-modal="true"
      dir="rtl"
    >
      <div
        style={{
          backgroundColor: '#ffffff',
          borderRadius: '12px',
          maxWidth: '520px',
          width: '100%',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.2)',
          overflow: 'hidden',
        }}
      >
        <header
          style={{
            padding: '1.25rem 1.5rem',
            borderBottom: '1px solid #e2e8f0',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            backgroundColor: '#f8fafc',
          }}
        >
          <div>
            <h3 style={{ margin: 0, fontSize: '1.1rem', color: '#0f172a' }}>طلب تغذية عهدة نقدية</h3>
            <span style={{ fontSize: '0.82rem', color: '#64748b' }}>تحويل سيولة من الخزينة الرئيسية إلى صندوق العهدة</span>
          </div>
          <button onClick={onClose} className="btn btn--secondary" style={{ padding: '0.25rem 0.5rem', fontSize: '0.85rem' }} disabled={busy}>
            ✕
          </button>
        </header>

        <form onSubmit={handleSubmit} style={{ padding: '1.5rem' }}>
          {error && (
            <div style={{ padding: '0.65rem 0.85rem', backgroundColor: '#fef2f2', border: '1px solid #fecaca', borderRadius: '6px', color: '#991b1b', fontSize: '0.85rem', marginBottom: '1rem' }}>
              {error}
            </div>
          )}

          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontWeight: 600, fontSize: '0.88rem', marginBottom: '0.35rem', color: '#334155' }}>
              صندوق العهدة المستلم <span style={{ color: '#dc2626' }}>*</span>
            </label>
            <select
              value={fundAccount}
              onChange={(e) => setFundAccount(e.target.value)}
              required
              style={{ width: '100%', padding: '0.55rem', borderRadius: '6px', border: '1px solid #cbd5e1' }}
            >
              {pettyAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} (الرصيد الحالي: {formatMoney(a.balance)})
                </option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontWeight: 600, fontSize: '0.88rem', marginBottom: '0.35rem', color: '#334155' }}>
              المبلغ المطلوب تحويله (ج.م) <span style={{ color: '#dc2626' }}>*</span>
            </label>
            <input
              required
              type="number"
              min="1"
              step="0.01"
              placeholder="0.00"
              value={fundAmount}
              onChange={(e) => setFundAmount(e.target.value)}
              style={{ width: '100%', padding: '0.55rem', borderRadius: '6px', border: '1px solid #cbd5e1' }}
            />
            {treasury && (
              <span style={{ display: 'block', marginTop: '0.3rem', fontSize: '0.78rem', color: '#64748b' }}>
                رصيد الخزينة الرئيسية المعتمد: {formatMoney(treasury.balance)}
              </span>
            )}
          </div>

          <div style={{ marginBottom: '1.25rem' }}>
            <label style={{ display: 'block', fontWeight: 600, fontSize: '0.88rem', marginBottom: '0.35rem', color: '#334155' }}>
              ملاحظات وبيان التغذية
            </label>
            <input
              type="text"
              placeholder="مثال: سلفة لمصروفات الصيانة الطارئة للأسبوع الحالي"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              style={{ width: '100%', padding: '0.55rem', borderRadius: '6px', border: '1px solid #cbd5e1' }}
            />
          </div>

          <div style={{ padding: '0.75rem', backgroundColor: '#eff6ff', borderRadius: '6px', border: '1px solid #bfdbfe', fontSize: '0.8rem', color: '#1e40af', marginBottom: '1.25rem' }}>
            ℹ️ يُسجل طلب التغذية كمستند تحويل <strong>بانتظار الاعتماد من شاشة الخزينة</strong>، ولا يتغير رصيد الخزنة أو العهدة قبل الاعتماد.
          </div>

          <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
            <button type="button" onClick={onClose} className="btn btn--secondary" disabled={busy}>
              إلغاء
            </button>
            <button type="submit" className="btn btn--primary" disabled={busy || !fundAmount}>
              {busy ? 'جاري الإرسال…' : 'إرسال طلب التغذية للاعتماد'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

export function CustodyView() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('finance:cash:manage');
  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [documents, setDocuments] = useState<CashDocument[]>([]);
  const [settlements, setSettlements] = useState<CustodySettlementRead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // النوافذ المنبثقة
  const [settlingAccount, setSettlingAccount] = useState<{ id: string; name: string } | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showFundModal, setShowFundModal] = useState(false);
  const [showExpenseModal, setShowExpenseModal] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [accountRows, documentRows, settlementRows] = await Promise.all([
        financeApi.getAccounts(),
        financeApi.getCashDocuments(),
        financeApi.getCustodySettlements().catch((): CustodySettlementRead[] => []),
      ]);
      setAccounts(accountRows);
      setSettlements(settlementRows);

      // تصفية مستندات النقدية المرتبطة بالعهد
      const pettyIds = new Set(accountRows.filter((a) => a.account_type === 'petty_cash').map((a) => a.id));
      const pettyDocs = documentRows.filter(
        (d) => (d.from_account_id && pettyIds.has(d.from_account_id)) || (d.to_account_id && pettyIds.has(d.to_account_id))
      );
      setDocuments(pettyDocs);
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'تعذر تحميل بيانات العهد المالية.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const pettyAccounts = accounts.filter((a) => a.account_type === 'petty_cash');
  const activePettyAccounts = pettyAccounts.filter((a) => a.is_active);
  const activePettyTotal = activePettyAccounts.reduce((sum, a) => sum + toNumber(a.balance), 0);
  const pendingSettlements = settlements.filter((s) => s.status === 'pending').length;

  const accountName = (id: string | null) => accounts.find((a) => a.id === id)?.name ?? '—';

  return (
    <section className="warehouse-page" dir="rtl" aria-labelledby="custody-title">
      <header className="warehouse-page__header">
        <div>
          <span className="warehouse-page__eyebrow">إدارة الصناديق والمصروفات اليومية</span>
          <h2 id="custody-title">العهد المالية المؤقتة</h2>
          <p>متابعة أرصدة العهد، طلبات التغذية، المصروفات اليومية والتسويات. كل حركة نقدية تُعتمد من شاشة الخزينة فقط.</p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {canManage && (
            <>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => setShowCreateModal(true)}
                style={{ fontWeight: 600 }}
              >
                + إنشاء صندوق عهدة جديد
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setShowFundModal(true)}
                disabled={activePettyAccounts.length === 0}
                style={{ fontWeight: 600 }}
              >
                ⇄ طلب تغذية عهدة من الخزينة
              </button>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => setShowExpenseModal(true)}
                disabled={activePettyAccounts.length === 0}
                style={{ fontWeight: 600 }}
              >
                ＋ مصروف يومي من عهدة
              </button>
            </>
          )}
          <button className="btn btn--secondary" onClick={() => void load()} disabled={loading}>
            {loading ? 'جاري التحديث…' : 'تحديث'}
          </button>
        </div>
      </header>

      {error && (
        <div className="warehouse-alert" role="alert" style={{ backgroundColor: '#fef2f2', border: '1px solid #f87171', color: '#b91c1c', padding: '0.85rem 1rem', borderRadius: '8px', marginBottom: '1.25rem' }}>
          ⚠️ {error}
        </div>
      )}

      {success && (
        <div className="warehouse-alert" role="status" style={{ backgroundColor: '#f0fdf4', border: '1px solid #86efac', color: '#166534', padding: '0.85rem 1rem', borderRadius: '8px', marginBottom: '1.25rem' }}>
          ✓ {success}
        </div>
      )}

      {/* المؤشرات الرئيسية للعهد */}
      <div className="warehouse-summary">
        <div className="warehouse-summary__card">
          <span>إجمالي العهد النشطة</span>
          <strong>{activePettyAccounts.length}</strong>
        </div>
        <div className="warehouse-summary__card">
          <span>رصيد العهد المعتمد</span>
          <strong style={{ color: '#0f766e' }}>{formatMoney(activePettyTotal)}</strong>
        </div>
        <div className="warehouse-summary__card">
          <span>التسويات المسجلة</span>
          <strong>{settlements.length}</strong>
        </div>
        <div className="warehouse-summary__card">
          <span>تسويات بانتظار اعتماد الخزينة</span>
          <strong style={{ color: pendingSettlements > 0 ? '#b45309' : undefined }}>{pendingSettlements}</strong>
        </div>
      </div>

      {/* ── بطاقات حسابات العهد النقدية ── */}
      <section style={{ marginTop: '1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ margin: 0, fontSize: '1.15rem' }}>حسابات العهد النقدية الحالية</h3>
          <span style={{ fontSize: '0.85rem', color: '#64748b' }}>
            {activePettyAccounts.length} عهدة تشغيلية نشطة
          </span>
        </div>

        {loading ? (
          <p>جاري تحميل العهد…</p>
        ) : pettyAccounts.length === 0 ? (
          <div style={{ padding: '2.5rem', textAlign: 'center', backgroundColor: '#f8fafc', borderRadius: '8px', border: '1px dashed #cbd5e1' }}>
            <p style={{ color: '#64748b', margin: '0 0 1rem 0' }}>لا توجد حسابات عهد نقدية مسجلة حتى الآن.</p>
            <button type="button" className="btn btn--secondary" onClick={() => setShowCreateModal(true)}>
              + إنشاء أول عهدة نقدية
            </button>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem' }}>
            {pettyAccounts.map((account) => (
              <article
                key={account.id}
                style={{
                  border: account.is_active ? '1px solid #cbd5e1' : '1px solid #e2e8f0',
                  borderRadius: '10px',
                  padding: '1.25rem',
                  backgroundColor: account.is_active ? '#ffffff' : '#f8fafc',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.6rem',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.03)',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h4 style={{ margin: 0, fontSize: '1.05rem', color: '#0f172a' }}>{account.name}</h4>
                  <span
                    style={{
                      fontSize: '0.75rem',
                      padding: '0.2rem 0.55rem',
                      borderRadius: '4px',
                      fontWeight: 600,
                      backgroundColor: account.is_active ? '#dcfce7' : '#f1f5f9',
                      color: account.is_active ? '#166534' : '#64748b',
                    }}
                  >
                    {account.is_active ? 'عهدة نشطة' : 'مسواة ومغلقة'}
                  </span>
                </div>

                <div style={{ margin: '0.25rem 0' }}>
                  <span style={{ fontSize: '0.78rem', color: '#64748b', display: 'block' }}>الرصيد المعتمد بالعهدة:</span>
                  <strong style={{ fontSize: '1.35rem', color: '#0f172a' }}>{formatMoney(account.balance)}</strong>
                </div>

                <small style={{ color: '#64748b', fontSize: '0.78rem' }}>
                  كود الحساب: <code>{account.account_number}</code>
                </small>

                {account.is_active && canManage ? (
                  <button
                    className="btn btn--secondary"
                    style={{
                      marginTop: '0.5rem',
                      fontSize: '0.85rem',
                      padding: '0.45rem 0.75rem',
                      backgroundColor: '#f0fdf4',
                      borderColor: '#86efac',
                      color: '#166534',
                      fontWeight: 600,
                      width: '100%',
                    }}
                    onClick={() => setSettlingAccount({ id: account.id, name: account.name })}
                    title="عرض موقف العهدة ورفع تسوية برد النقدية للخزنة"
                  >
                    تسوية العهدة ورد النقدية
                  </button>
                ) : account.is_active ? null : (
                  <span style={{ fontSize: '0.8rem', color: '#64748b', marginTop: '0.5rem', textAlign: 'center' }}>
                    ✓ تمت التسوية وإغلاق الحساب
                  </span>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      {/* ── سجل التسويات المحاسبية المعتمدة للعهد ── */}
      {settlements.length > 0 && (
        <section style={{ marginTop: '2.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: '1.15rem' }}>سجل تسويات العهد</h3>
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#64748b' }}>
                صافي العهدة = المصروفات المعتمدة + النقدية المردودة + المتبقي مع صاحب العهدة.
              </p>
            </div>
            <span style={{ fontSize: '0.85rem', color: '#64748b' }}>{settlements.length} تسوية مسجلة</span>
          </div>

          <div className="warehouse-table-wrap">
            <table className="warehouse-table">
              <thead>
                <tr>
                  <th>رقم التسوية</th>
                  <th>صندوق العهدة / المسؤول</th>
                  <th>العهدة الأصلية</th>
                  <th>المصروفات المعتمدة</th>
                  <th>المردود للخزنة الرئيسية</th>
                  <th>المتبقي غير المسوى</th>
                  <th>المطابقة</th>
                  <th>الحالة</th>
                  <th>التاريخ</th>
                </tr>
              </thead>
              <tbody>
                {settlements.map((s) => (
                  <tr key={s.id}>
                    <td><code>{s.settlement_number}</code></td>
                    <td style={{ fontWeight: 600 }}>{s.custody_account_name || 'عهدة مسواة'}</td>
                    <td><strong>{formatMoney(s.original_custody_amount)}</strong></td>
                    <td style={{ color: '#991b1b' }}>{formatMoney(s.approved_expenses_amount)}</td>
                    <td style={{ color: '#166534', fontWeight: 600 }}>{formatMoney(s.returned_cash_amount)}</td>
                    <td>{formatMoney(s.remaining_unsettled_amount)}</td>
                    <td>
                      <span
                        style={{
                          fontSize: '0.78rem',
                          padding: '0.2rem 0.55rem',
                          borderRadius: '4px',
                          fontWeight: 600,
                          backgroundColor: s.is_mathematically_balanced ? '#dcfce7' : '#fee2e2',
                          color: s.is_mathematically_balanced ? '#166534' : '#991b1b',
                        }}
                      >
                        {s.is_mathematically_balanced ? '✓ متطابقة' : 'فارق'}
                      </span>
                    </td>
                    <td>
                      <span
                        style={{
                          fontSize: '0.78rem',
                          padding: '0.2rem 0.55rem',
                          borderRadius: '4px',
                          fontWeight: 600,
                          backgroundColor: s.status === 'approved' ? '#dcfce7' : s.status === 'pending' ? '#fef3c7' : '#fee2e2',
                          color: s.status === 'approved' ? '#166534' : s.status === 'pending' ? '#92400e' : '#991b1b',
                        }}
                      >
                        {SETTLEMENT_STATUS_LABELS[s.status] ?? s.status}
                      </span>
                    </td>
                    <td style={{ fontSize: '0.82rem', color: '#64748b' }}>{new Date(s.created_at).toLocaleDateString('ar-EG')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── جدول الحركات النقدية لصناديق العهد ── */}
      <section style={{ marginTop: '2.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1.15rem' }}>حركات النقدية وصرف العهد</h3>
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#64748b' }}>
              سجل التحويلات والمصروفات الخاصة بحسابات العهد اليومية.
            </p>
          </div>
          <span style={{ fontSize: '0.85rem', color: '#64748b' }}>{documents.length} حركة مسجلة</span>
        </div>

        <div
          style={{
            padding: '0.65rem 1rem',
            backgroundColor: '#eff6ff',
            border: '1px solid #bfdbfe',
            borderRadius: '6px',
            fontSize: '0.85rem',
            color: '#1e40af',
            marginBottom: '1rem',
          }}
        >
          ℹ️ تحويلات التغذية ومصروفات العهد ورد النقدية تُعتمد من <strong>شاشة الخزينة</strong> فقط، ولا تؤثر على الأرصدة قبل الاعتماد.
        </div>

        {loading ? (
          <p>جاري التحميل…</p>
        ) : documents.length === 0 ? (
          <div style={{ padding: '2rem', textAlign: 'center', color: '#64748b', backgroundColor: '#f8fafc', borderRadius: '8px' }}>
            لا توجد حركات مسجلة للعهد المالية حتى الآن.
          </div>
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
                  <th>موقف الاعتماد بالخزينة</th>
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
                          fontSize: '0.78rem',
                          padding: '0.2rem 0.5rem',
                          borderRadius: '4px',
                          fontWeight: 600,
                          backgroundColor:
                            doc.document_type === 'transfer' ? '#e0e7ff' : doc.document_type === 'expense' ? '#fee2e2' : '#dcfce7',
                          color:
                            doc.document_type === 'transfer' ? '#3730a3' : doc.document_type === 'expense' ? '#991b1b' : '#166534',
                        }}
                      >
                        {doc.document_type === 'transfer' ? 'تحويل / تغذية عهدة' : doc.document_type === 'expense' ? 'صرف من عهدة' : 'إيداع'}
                      </span>
                    </td>
                    <td>{accountName(doc.from_account_id)}</td>
                    <td>{accountName(doc.to_account_id)}</td>
                    <td>
                      <strong>{formatMoney(doc.amount)}</strong>
                    </td>
                    <td className="cell-wrap">{doc.description}</td>
                    <td>
                      <span
                        style={{
                          fontSize: '0.78rem',
                          padding: '0.2rem 0.5rem',
                          borderRadius: '4px',
                          fontWeight: 600,
                          backgroundColor:
                            doc.status === 'approved' ? '#dcfce7' : doc.status === 'pending' ? '#fef3c7' : '#fee2e2',
                          color:
                            doc.status === 'approved' ? '#166534' : doc.status === 'pending' ? '#92400e' : '#991b1b',
                        }}
                      >
                        {cashStatusLabel(doc.status)}
                      </span>
                    </td>
                    <td>
                      {doc.status === 'pending' ? (
                        <span
                          style={{
                            fontSize: '0.78rem',
                            color: '#92400e',
                            backgroundColor: '#fef3c7',
                            padding: '0.2rem 0.5rem',
                            borderRadius: '4px',
                            fontWeight: 600,
                            display: 'inline-block',
                          }}
                        >
                          بانتظار الاعتماد من شاشة الخزينة
                        </span>
                      ) : doc.status === 'approved' ? (
                        <span style={{ fontSize: '0.78rem', color: '#166534', fontWeight: 600 }}>
                          ✓ معتمد بالخزينة
                        </span>
                      ) : doc.status === 'rejected' ? (
                        <span style={{ fontSize: '0.78rem', color: '#991b1b' }}>
                          مرفوض{doc.rejection_reason ? `: ${doc.rejection_reason}` : ''}
                        </span>
                      ) : (
                        <span style={{ fontSize: '0.78rem', color: '#64748b' }}>—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* نافذة تسوية العهدة */}
      {settlingAccount && (
        <CustodySettlementModal
          accountId={settlingAccount.id}
          accountName={settlingAccount.name}
          onClose={() => setSettlingAccount(null)}
          onSettled={(settlement) => {
            setSettlingAccount(null);
            setError('');
            if (settlement.status === 'pending') {
              setSuccess(`تم تسجيل التسوية برقم ${settlement.settlement_number} برد ${formatMoney(settlement.returned_cash_amount)} وهي بانتظار الاعتماد من شاشة الخزينة. تُغلق العهدة تلقائياً عند رد كامل رصيدها واعتماد الرد.`);
            } else if (Number(settlement.returned_cash_amount) > 0) {
              setSuccess(`تم تسجيل التسوية برقم ${settlement.settlement_number} برد ${formatMoney(settlement.returned_cash_amount)} واعتُمدت فوراً وعادت النقدية للخزنة. تُغلق العهدة تلقائياً إذا رُد كامل رصيدها.`);
            } else {
              setSuccess(`تم تسجيل التسوية برقم ${settlement.settlement_number} دون حركة نقدية (لا توجد نقدية مردودة).`);
            }
            void load();
          }}
        />
      )}

      {/* نافذة إنشاء صندوق عهدة جديد */}
      {showCreateModal && (
        <CreateCustodyModal
          onClose={() => setShowCreateModal(false)}
          onCreated={() => {
            setShowCreateModal(false);
            setError('');
            setSuccess('تم إنشاء صندوق العهدة برصيد صفر. الخطوة التالية: طلب تغذية العهدة من الخزينة.');
            void load();
          }}
        />
      )}

      {/* نافذة طلب تغذية عهدة */}
      {showFundModal && (
        <FundCustodyModal
          accounts={accounts}
          onClose={() => setShowFundModal(false)}
          onFunded={(doc) => {
            setShowFundModal(false);
            setError('');
            setSuccess(doc.status === 'approved' ? `تم تسجيل التغذية برقم ${doc.document_number} واعتُمد فوراً وتحرك الرصيد.` : `تم تسجيل طلب التغذية برقم ${doc.document_number} وهو بانتظار الاعتماد من شاشة الخزينة.`);
            void load();
          }}
        />
      )}

      {/* نافذة مصروف يومي من عهدة */}
      {showExpenseModal && (
        <DailyExpenseModal
          accounts={accounts}
          onClose={() => setShowExpenseModal(false)}
          onCreated={(doc) => {
            setShowExpenseModal(false);
            setError('');
            setSuccess(doc.status === 'approved' ? `تم تسجيل المصروف برقم ${doc.document_number} واعتُمد فوراً وتحرك الرصيد.` : `تم تسجيل المصروف برقم ${doc.document_number} وهو بانتظار الاعتماد من شاشة الخزينة.`);
            void load();
          }}
        />
      )}
    </section>
  );
}
