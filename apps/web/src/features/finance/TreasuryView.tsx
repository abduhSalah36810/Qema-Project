import { useCallback, useEffect, useState, useMemo } from 'react';
import { userLabel } from '@/lib/userLabel';
import { useAuth } from '@/features/auth/AuthContext';
import {
  CashAccount,
  CashDocument,
  cashSourceLabel,
  cashStatusLabel,
  errorMessage,
  financeApi,
  formatMoney,
  toNumber,
} from './financeApi';

interface RejectModalProps {
  document: CashDocument;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
  busy: boolean;
}

function RejectModal({ document, onClose, onConfirm, busy }: RejectModalProps) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) {
      setError('يرجى كتابة سبب رفض المعاملة بوضوح للمساءلة والتدقيق.');
      return;
    }
    setError('');
    await onConfirm(reason.trim());
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
      aria-labelledby="reject-title"
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
            borderBottom: '1px solid #fee2e2',
            backgroundColor: '#fef2f2',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '1.25rem' }}>⚠️</span>
            <h3 id="reject-title" style={{ margin: 0, fontSize: '1.1rem', color: '#991b1b' }}>
              رفض مستند مالي بانتظار الاعتماد
            </h3>
          </div>
          <button
            onClick={onClose}
            className="btn btn--secondary"
            style={{ padding: '0.25rem 0.5rem', fontSize: '0.85rem' }}
            disabled={busy}
          >
            ✕
          </button>
        </header>

        <form onSubmit={handleSubmit} style={{ padding: '1.5rem' }}>
          <div
            style={{
              backgroundColor: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: '8px',
              padding: '0.85rem',
              marginBottom: '1rem',
              fontSize: '0.88rem',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
              <span style={{ color: '#64748b' }}>رقم المستند:</span>
              <code>{document.document_number}</code>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
              <span style={{ color: '#64748b' }}>المبلغ:</span>
              <strong style={{ color: '#0f172a' }}>{formatMoney(document.amount)}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.35rem' }}>
              <span style={{ color: '#64748b' }}>المصدر:</span>
              <span>{cashSourceLabel(document.source_system)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#64748b' }}>البيان:</span>
              <span style={{ maxWidth: '300px', textAlign: 'left', wordBreak: 'break-word' }}>{document.description}</span>
            </div>
          </div>

          {error && (
            <div
              style={{
                padding: '0.65rem 0.85rem',
                backgroundColor: '#fef2f2',
                border: '1px solid #fecaca',
                borderRadius: '6px',
                color: '#991b1b',
                fontSize: '0.85rem',
                marginBottom: '1rem',
              }}
            >
              {error}
            </div>
          )}

          <div style={{ marginBottom: '1.25rem' }}>
            <label style={{ display: 'block', fontWeight: 600, fontSize: '0.88rem', marginBottom: '0.4rem', color: '#334155' }}>
              سبب الرفض الإلزامي <span style={{ color: '#dc2626' }}>*</span>
            </label>
            <textarea
              required
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="اكتب سبب الرفض بالتفصيل (مثل: تجاوز الموازنة، خطأ في الفواتير المرفقة، عدم موافقة الإدارة...)"
              style={{ width: '100%', padding: '0.6rem', borderRadius: '6px', border: '1px solid #cbd5e1', resize: 'vertical' }}
            />
          </div>

          <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
            <button type="button" onClick={onClose} className="btn btn--secondary" disabled={busy}>
              إلغاء
            </button>
            <button
              type="submit"
              className="btn btn--secondary"
              disabled={busy}
              style={{ backgroundColor: '#dc2626', color: '#ffffff', borderColor: '#dc2626' }}
            >
              {busy ? 'جاري الرفض…' : 'تأكيد الرفض وتوثيق السبب'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
}

interface ApproveModalProps {
  document: CashDocument;
  fromAccountName: string;
  toAccountName: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  busy: boolean;
}

function ApproveModal({ document, fromAccountName, toAccountName, onClose, onConfirm, busy }: ApproveModalProps) {
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
      aria-labelledby="approve-title"
      dir="rtl"
    >
      <div
        style={{
          backgroundColor: '#ffffff',
          borderRadius: '12px',
          maxWidth: '540px',
          width: '100%',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.2)',
          overflow: 'hidden',
        }}
      >
        <header
          style={{
            padding: '1.25rem 1.5rem',
            borderBottom: '1px solid #bbf7d0',
            backgroundColor: '#f0fdf4',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '1.25rem' }}>✓</span>
            <h3 id="approve-title" style={{ margin: 0, fontSize: '1.1rem', color: '#166534' }}>
              اعتماد الحركة المالية
            </h3>
          </div>
          <button
            onClick={onClose}
            className="btn btn--secondary"
            style={{ padding: '0.25rem 0.5rem', fontSize: '0.85rem' }}
            disabled={busy}
          >
            ✕
          </button>
        </header>

        <div style={{ padding: '1.5rem' }}>
          <p style={{ margin: '0 0 1rem 0', color: '#334155', fontSize: '0.92rem' }}>
            عند الاعتماد تُسجل الحركة في دفتر النقدية ويتغير رصيد الحساب، ويُحدّث المستند المرتبط بها (دفعة مورد، تحصيل عميل، رواتب، تسوية عهدة…). إذا فشل أي جزء لا يُسجل شيء.
          </p>

          <div
            style={{
              backgroundColor: '#f8fafc',
              border: '1px solid #e2e8f0',
              borderRadius: '8px',
              padding: '1rem',
              marginBottom: '1.25rem',
              fontSize: '0.88rem',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <span style={{ color: '#64748b' }}>رقم المستند:</span>
              <code>{document.document_number}</code>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <span style={{ color: '#64748b' }}>المبلغ:</span>
              <strong style={{ color: '#16a34a', fontSize: '1.1rem' }}>{formatMoney(document.amount)}</strong>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <span style={{ color: '#64748b' }}>المصدر:</span>
              <span>{cashSourceLabel(document.source_system)}</span>
            </div>
            {fromAccountName !== '—' && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <span style={{ color: '#64748b' }}>من حساب:</span>
                <span>{fromAccountName}</span>
              </div>
            )}
            {toAccountName !== '—' && (
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <span style={{ color: '#64748b' }}>إلى حساب:</span>
                <span>{toAccountName}</span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: '#64748b' }}>البيان:</span>
              <span style={{ maxWidth: '320px', textAlign: 'left', wordBreak: 'break-word' }}>{document.description}</span>
            </div>
          </div>

          <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
            <button type="button" onClick={onClose} className="btn btn--secondary" disabled={busy}>
              إلغاء
            </button>
            <button
              type="button"
              onClick={() => void onConfirm()}
              className="btn btn--primary"
              disabled={busy}
              style={{ backgroundColor: '#16a34a', borderColor: '#16a34a', color: '#ffffff' }}
            >
              {busy ? 'جاري الاعتماد…' : 'تأكيد الاعتماد'}
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}

export function TreasuryView() {
  const { user, hasPermission } = useAuth();
  const canApprove = hasPermission('finance:cash:approve');
  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [documents, setDocuments] = useState<CashDocument[]>([]);
  const [approvableIds, setApprovableIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'approved' | 'pending' | 'rejected'>('all');
  const [typeFilter, setTypeFilter] = useState<'all' | 'income' | 'expense' | 'transfer'>('all');

  // نوافذ الاعتماد والرفض
  const [approvingDoc, setApprovingDoc] = useState<CashDocument | null>(null);
  const [rejectingDoc, setRejectingDoc] = useState<CashDocument | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [accountRows, documentRows, approvableRows] = await Promise.all([
        financeApi.getAccounts(),
        financeApi.getCashDocuments(),
        canApprove
          ? financeApi.getCashDocuments({ status: 'pending', approvable_by_me: true })
          : Promise.resolve([] as CashDocument[]),
      ]);
      setAccounts(accountRows);
      setDocuments(documentRows);
      setApprovableIds(new Set(approvableRows.map((d) => d.id)));
      setError('');
    } catch (err) {
      setError(errorMessage(err, 'تعذر تحميل بيانات الخزنة والحسابات النقدية.'));
    } finally {
      setLoading(false);
    }
  }, [canApprove]);

  useEffect(() => {
    void load();
  }, [load]);

  const isOwnDocument = (doc: CashDocument) =>
    Boolean(user && (doc.created_by === user.id || (user.email && doc.created_by === user.email)));

  const accountName = (id: string | null) => accounts.find((a) => a.id === id)?.name ?? '—';

  // تصنيف الحسابات النقدية
  const canonicalTreasury = accounts.find(
    (a) => a.id === '00000000-0000-0000-0000-000000000001' || a.account_number === 'TREASURY-MAIN'
  );
  const otherTreasuries = accounts.filter(
    (a) => a.account_type === 'treasury' && a.id !== canonicalTreasury?.id
  );
  const pettyAccounts = accounts.filter((a) => a.account_type === 'petty_cash');
  const totalPettyBalance = pettyAccounts
    .filter((a) => a.is_active)
    .reduce((sum, a) => sum + toNumber(a.balance), 0);

  // المعاملات بانتظار الاعتماد المالي
  const pendingDocs = useMemo(() => {
    return documents.filter((d) => d.status === 'pending');
  }, [documents]);

  const handleApproveConfirm = async () => {
    if (!approvingDoc) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const result = await financeApi.decideDocument(approvingDoc.id, 'approve');
      setSuccess(
        `تم اعتماد المستند ${result.document_number} (${cashSourceLabel(result.source_system)}) بمبلغ ${formatMoney(result.amount)} وتحديث رصيد الحساب.`
      );
      setApprovingDoc(null);
      await load();
    } catch (err) {
      setError(errorMessage(err, 'تعذر اعتماد المستند.'));
    } finally {
      setBusy(false);
    }
  };

  const handleRejectConfirm = async (reason: string) => {
    if (!rejectingDoc) return;
    setBusy(true);
    setError('');
    setSuccess('');
    try {
      const result = await financeApi.decideDocument(rejectingDoc.id, 'reject', reason);
      setSuccess(`تم رفض المستند ${result.document_number} وتوثيق السبب. لم يتغير أي رصيد.`);
      setRejectingDoc(null);
      await load();
    } catch (err) {
      setError(errorMessage(err, 'تعذر رفض المستند.'));
    } finally {
      setBusy(false);
    }
  };

  const filteredDocs = useMemo(() => {
    return documents.filter((doc) => {
      if (statusFilter !== 'all' && doc.status !== statusFilter) return false;
      if (typeFilter !== 'all' && doc.document_type !== typeFilter) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          doc.document_number.toLowerCase().includes(q) ||
          (doc.description || '').toLowerCase().includes(q) ||
          (doc.created_by || '').toLowerCase().includes(q) ||
          accountName(doc.from_account_id).toLowerCase().includes(q) ||
          accountName(doc.to_account_id).toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [documents, statusFilter, typeFilter, searchQuery, accounts]);

  const getDocTypeBadge = (doc: CashDocument) => {
    const isIncome = doc.document_type === 'income';
    const isExpense = doc.document_type === 'expense';
    const label = isIncome ? 'قبض (+)' : isExpense ? 'صرف (-)' : 'تحويل (⇄)';

    return (
      <span
        style={{
          fontSize: '0.78rem',
          padding: '0.2rem 0.55rem',
          borderRadius: '4px',
          fontWeight: 600,
          backgroundColor: isIncome ? '#dcfce7' : isExpense ? '#fee2e2' : '#e0e7ff',
          color: isIncome ? '#166534' : isExpense ? '#991b1b' : '#3730a3',
          whiteSpace: 'nowrap',
          display: 'inline-block',
        }}
      >
        {label}
      </span>
    );
  };

  const formatDateTime = (isoDate: string | null) => {
    if (!isoDate) return '—';
    try {
      const d = new Date(isoDate);
      return d.toLocaleDateString('ar-EG', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoDate;
    }
  };

  return (
    <section className="warehouse-page" dir="rtl" aria-labelledby="treasury-title">
      <header className="warehouse-page__header">
        <div>
          <span className="warehouse-page__eyebrow">الإدارة المالية المركزية</span>
          <h2 id="treasury-title">الخزينة والحسابات النقدية</h2>
          <p>المكان الوحيد لاعتماد أو رفض الحركات النقدية. لا يتغير أي رصيد قبل الاعتماد هنا.</p>
        </div>
          <button className="btn btn--secondary" onClick={() => void load()} disabled={loading || busy}>
            {loading ? 'جاري التحديث…' : 'تحديث البيانات'}
          </button>
      </header>

      {error && (
        <div
          className="warehouse-alert"
          role="alert"
          style={{ backgroundColor: '#fef2f2', border: '1px solid #f87171', color: '#b91c1c', padding: '0.85rem 1rem', borderRadius: '8px', marginBottom: '1.25rem' }}
        >
          ⚠️ {error}
        </div>
      )}

      {success && (
        <div
          className="warehouse-alert"
          role="alert"
          style={{ backgroundColor: '#f0fdf4', border: '1px solid #86efac', color: '#166534', padding: '0.85rem 1rem', borderRadius: '8px', marginBottom: '1.25rem' }}
        >
          ✓ {success}
        </div>
      )}

      {/* ── بطاقات أرصدة الحسابات النقدية المفصلة ── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          gap: '1rem',
          marginBottom: '1.5rem',
        }}
      >
        {/* الخزنة الرئيسية الكانونية */}
        {canonicalTreasury && (
          <article
            style={{
              padding: '1.25rem',
              borderRadius: '8px',
              border: '2px solid #16a34a',
              backgroundColor: '#f0fdf4',
              boxShadow: '0 1px 3px rgba(0,0,0,0.05)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <span style={{ fontWeight: 700, color: '#166534', fontSize: '1rem' }}>
                {canonicalTreasury.name}
              </span>
              <span
                style={{
                  fontSize: '0.72rem',
                  padding: '0.15rem 0.5rem',
                  borderRadius: '4px',
                  backgroundColor: '#dcfce7',
                  color: '#166534',
                  fontWeight: 600,
                }}
              >
                الخزنة الرئيسية
              </span>
            </div>
            <strong style={{ display: 'block', fontSize: '1.5rem', color: '#15803d', marginBottom: '0.25rem' }}>
              {formatMoney(canonicalTreasury.balance)}
            </strong>
            <small style={{ color: '#475569' }}>
              رقم الحساب: <code>{canonicalTreasury.account_number}</code> · رصيد الحركات المعتمدة
            </small>
          </article>
        )}

        {/* الحسابات النقدية والبنوك الأخرى إن وجدت */}
        {otherTreasuries.map((acc) => (
          <article
            key={acc.id}
            style={{
              padding: '1.25rem',
              borderRadius: '8px',
              border: '1px solid #cbd5e1',
              backgroundColor: '#ffffff',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <span style={{ fontWeight: 600, color: '#1e293b' }}>{acc.name}</span>
              <span style={{ fontSize: '0.75rem', color: '#64748b' }}>حساب نقدي فرعي</span>
            </div>
            <strong style={{ display: 'block', fontSize: '1.35rem', color: '#0f172a', marginBottom: '0.25rem' }}>
              {formatMoney(acc.balance)}
            </strong>
            <small style={{ color: '#64748b' }}>رقم الحساب: <code>{acc.account_number}</code></small>
          </article>
        ))}

        {/* إجمالي أرصدة العهد النقدية النشطة */}
        <article
          style={{
            padding: '1.25rem',
            borderRadius: '8px',
            border: '1px solid #cbd5e1',
            backgroundColor: '#ffffff',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
            <span style={{ fontWeight: 600, color: '#1e293b' }}>إجمالي أرصدة العهد النقدية</span>
            <span style={{ fontSize: '0.75rem', color: '#64748b' }}>{pettyAccounts.filter((a) => a.is_active).length} عهدة نشطة</span>
          </div>
          <strong style={{ display: 'block', fontSize: '1.35rem', color: '#0f172a', marginBottom: '0.25rem' }}>
            {formatMoney(totalPettyBalance)}
          </strong>
          <small style={{ color: '#64748b' }}>عهدة نقدية بحوزة الموظفين لمصروفات التشغيل</small>
        </article>

        {/* العمليات المعلقة للاعتماد */}
        <article
          style={{
            padding: '1.25rem',
            borderRadius: '8px',
            border: pendingDocs.length > 0 ? '2px solid #f59e0b' : '1px solid #cbd5e1',
            backgroundColor: pendingDocs.length > 0 ? '#fffbeb' : '#ffffff',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <span style={{ fontWeight: 600, color: pendingDocs.length > 0 ? '#92400e' : '#1e293b' }}>
                معاملات بانتظار الاعتماد
              </span>
              <span
                style={{
                  fontSize: '0.75rem',
                  padding: '0.15rem 0.5rem',
                  borderRadius: '4px',
                  backgroundColor: pendingDocs.length > 0 ? '#fef3c7' : '#f1f5f9',
                  color: pendingDocs.length > 0 ? '#b45309' : '#64748b',
                  fontWeight: 600,
                }}
              >
                الاعتماد من هنا فقط
              </span>
          </div>
            <strong style={{ display: 'block', fontSize: '1.35rem', color: pendingDocs.length > 0 ? '#b45309' : '#0f172a', marginBottom: '0.25rem' }}>
              {pendingDocs.length} مستند
            </strong>
              <small style={{ color: pendingDocs.length > 0 ? '#92400e' : '#64748b' }}>
                {pendingDocs.length > 0 ? 'راجع القائمة بالأسفل' : 'لا توجد مستندات معلقة'}
              </small>
            </article>
          </div>

            {/* ── أولاً: مركز الاعتماد المالي الموحد (Unified Treasury Approvals Hub) ── */}
            <section
              style={{
                backgroundColor: '#ffffff',
                borderRadius: '10px',
                border: pendingDocs.length > 0 ? '2px solid #f59e0b' : '1px solid #e2e8f0',
                padding: '1.25rem',
                marginBottom: '2rem',
                boxShadow: '0 2px 4px rgba(0,0,0,0.04)',
              }}
              aria-labelledby="approval-hub-title"
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <span style={{ fontSize: '1.2rem' }}>⚖️</span>
                    <h3 id="approval-hub-title" style={{ margin: 0, fontSize: '1.15rem', color: '#0f172a' }}>
                      مستندات بانتظار الاعتماد
                    </h3>
                    {pendingDocs.length > 0 && (
                      <span
                        style={{
                          backgroundColor: '#fef3c7',
                          color: '#92400e',
                          fontSize: '0.78rem',
                          fontWeight: 700,
                          padding: '0.2rem 0.6rem',
                          borderRadius: '999px',
                        }}
                      >
                        {pendingDocs.length} مستند
                      </span>
                    )}
                  </div>
                  <p style={{ margin: '0.35rem 0 0', fontSize: '0.85rem', color: '#64748b' }}>
                    كل حركة نقدية (دفعات الموردين، تحصيلات العملاء، الرواتب، تسويات ومصروفات العهد، المستندات اليدوية) تُعتمد أو تُرفض هنا فقط. لا يمكن لمنشئ المستند اعتماده.
                    {!canApprove && ' ليست لديك صلاحية الاعتماد؛ القائمة للعرض فقط.'}
                  </p>
                </div>
              </div>

              {pendingDocs.length === 0 ? (
                <div
                  style={{
                    padding: '1.5rem',
                    backgroundColor: '#f0fdf4',
                    borderRadius: '8px',
                    border: '1px solid #bbf7d0',
                    textAlign: 'center',
                    color: '#166534',
                    fontSize: '0.92rem',
                  }}
                >
                  ✓ لا توجد مستندات بانتظار الاعتماد حالياً.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {pendingDocs.map((doc) => {
                    const fromName = accountName(doc.from_account_id);
                    const toName = accountName(doc.to_account_id);
                    const own = isOwnDocument(doc);
                    const mayDecide = canApprove && !own && approvableIds.has(doc.id);
                    return (
                      <div
                        key={doc.id}
                        style={{
                          border: '1px solid #fed7aa',
                          backgroundColor: '#fffdfa',
                          borderRadius: '8px',
                          padding: '1rem',
                          display: 'flex',
                          flexWrap: 'wrap',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: '1rem',
                        }}
                      >
                        <div style={{ flex: '1 1 320px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.4rem' }}>
                            <code>{doc.document_number}</code>
                            {getDocTypeBadge(doc)}
                            <span
                              style={{
                                fontSize: '0.78rem',
                                padding: '0.2rem 0.55rem',
                                borderRadius: '4px',
                                fontWeight: 600,
                                backgroundColor: '#f1f5f9',
                                color: '#334155',
                              }}
                            >
                              {cashSourceLabel(doc.source_system)}
                            </span>
                            <span style={{ fontSize: '0.8rem', color: '#64748b' }}>{formatDateTime(doc.occurred_at)}</span>
                          </div>

                          <div style={{ fontSize: '0.9rem', color: '#1e293b', marginBottom: '0.35rem' }}>
                            <strong>البيان:</strong> {doc.description}
                          </div>

                          <div style={{ fontSize: '0.82rem', color: '#64748b', display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
                            <span>من حساب: <strong>{fromName}</strong></span>
                            <span>إلى حساب: <strong>{toName}</strong></span>
                            <span>أنشأه: <strong>{own ? 'أنت' : userLabel(doc.created_by)}</strong></span>
                          </div>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
                          <div style={{ textAlign: 'left' }}>
                            <span style={{ display: 'block', fontSize: '0.78rem', color: '#64748b' }}>المبلغ المطلوب</span>
                            <strong style={{ fontSize: '1.3rem', color: '#0f172a' }}>{formatMoney(doc.amount)}</strong>
                          </div>

                          {own ? (
                            <span
                              style={{
                                fontSize: '0.8rem',
                                color: '#92400e',
                                backgroundColor: '#fffbeb',
                                border: '1px solid #fde68a',
                                padding: '0.35rem 0.6rem',
                                borderRadius: '6px',
                              }}
                            >
                              لا يمكنك اعتماد مستند أنشأته
                            </span>
                          ) : !mayDecide ? (
                            <span style={{ fontSize: '0.8rem', color: '#64748b' }}>
                              {canApprove
                                ? doc.source_system === 'payroll'
                                  ? 'شاركت في إعداد كشف الرواتب؛ يعتمده مسؤول آخر'
                                  : 'يعتمده مسؤول مالي آخر'
                                : 'بانتظار اعتماد المسؤول المالي'}
                            </span>
                          ) : (
                          <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <button
                              type="button"
                              className="btn btn--primary"
                              style={{
                                backgroundColor: '#16a34a',
                                borderColor: '#16a34a',
                                color: '#ffffff',
                                padding: '0.45rem 0.9rem',
                                fontSize: '0.85rem',
                                fontWeight: 600,
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.35rem',
                              }}
                              disabled={busy}
                              onClick={() => setApprovingDoc(doc)}
                            >
                              ✓ اعتماد
                            </button>

                            <button
                              type="button"
                              className="btn btn--secondary"
                              style={{
                                color: '#b91c1c',
                                borderColor: '#fca5a5',
                                backgroundColor: '#ffffff',
                                padding: '0.45rem 0.8rem',
                                fontSize: '0.85rem',
                              }}
                              disabled={busy}
                              onClick={() => setRejectingDoc(doc)}
                            >
                              ✕ رفض
                            </button>
                          </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {/* ── ثانياً: سجل قيود الخزينة والحركات النقدية (9 Columns Auditable Table) ── */}
            <section
              style={{
                backgroundColor: '#ffffff',
                borderRadius: '10px',
                border: '1px solid #e2e8f0',
                padding: '1.25rem',
                boxShadow: '0 1px 3px rgba(0,0,0,0.03)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginBottom: '1.25rem',
                  flexWrap: 'wrap',
                  gap: '0.75rem',
                }}
              >
                <div>
                  <h3 style={{ margin: 0, fontSize: '1.15rem' }}>سجل المستندات النقدية</h3>
                  <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#64748b' }}>
                    كل المقبوضات والمدفوعات والتحويلات بحالاتها (معلقة، معتمدة، مرفوضة).
                  </p>
                </div>

                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
                  <input
                    type="search"
                    placeholder="بحث بالرقم أو الوصف أو الحساب…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    style={{
                      padding: '0.45rem 0.75rem',
                      borderRadius: '6px',
                      border: '1px solid #cbd5e1',
                      fontSize: '0.85rem',
                      minWidth: '220px',
                    }}
                  />
                  <select
                    value={typeFilter}
                    onChange={(e) => setTypeFilter(e.target.value as typeof typeFilter)}
                    style={{ padding: '0.45rem 0.75rem', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '0.85rem' }}
                  >
                    <option value="all">كل أنواع الحركات</option>
                    <option value="income">قبض نقدي (+)</option>
                    <option value="expense">صرف نقدي (-)</option>
                    <option value="transfer">تحويل نقدي (⇄)</option>
                  </select>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
                    style={{ padding: '0.45rem 0.75rem', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '0.85rem' }}
                  >
                    <option value="all">كل الحالات</option>
                    <option value="approved">معتمد</option>
                    <option value="pending">بانتظار الاعتماد</option>
                    <option value="rejected">مرفوض</option>
                  </select>
                </div>
              </div>

              {loading ? (
          <div style={{ padding: '3rem', textAlign: 'center', color: '#64748b' }}>
            جاري تحميل سجل قيود الخزينة…
          </div>
              ) : filteredDocs.length === 0 ? (
          <div
            style={{
              padding: '3rem 1.5rem',
              textAlign: 'center',
              backgroundColor: '#f8fafc',
              borderRadius: '8px',
              border: '1px dashed #cbd5e1',
            }}
          >
            <p style={{ color: '#64748b', fontSize: '0.95rem', margin: '0 0 0.5rem 0' }}>
              لا توجد قيود أو حركات نقدية مطابقة لمعايير البحث والتصفية.
            </p>
            {(searchQuery || statusFilter !== 'all' || typeFilter !== 'all') && (
              <button
                type="button"
                className="btn btn--secondary"
                style={{ fontSize: '0.85rem' }}
                onClick={() => {
                  setSearchQuery('');
                  setStatusFilter('all');
                  setTypeFilter('all');
                }}
              >
                إعادة ضبط عوامل التصفية
              </button>
            )}
          </div>
              ) : (
                    <div style={{ overflowX: 'auto', border: '1px solid #e2e8f0', borderRadius: '8px' }}>
                      <table
                        style={{
                          width: '100%',
                          borderCollapse: 'collapse',
                          textAlign: 'right',
                          fontSize: '0.88rem',
                          minWidth: '980px',
                        }}
                      >
                        <thead>
                            <tr style={{ backgroundColor: '#f8fafc', borderBottom: '2px solid #e2e8f0' }}>
                              <th style={{ padding: '0.75rem 1rem', width: '140px', fontWeight: 600, color: '#334155' }}>
                                1. التاريخ والوقت
                              </th>
                              <th style={{ padding: '0.75rem 0.75rem', width: '130px', fontWeight: 600, color: '#334155' }}>
                                2. نوع الحركة
                              </th>
                              <th style={{ padding: '0.75rem 0.75rem', width: '130px', fontWeight: 600, color: '#334155' }}>
                                3. من حساب
                              </th>
                              <th style={{ padding: '0.75rem 0.75rem', width: '130px', fontWeight: 600, color: '#334155' }}>
                                4. إلى حساب
                              </th>
                              <th style={{ padding: '0.75rem 0.75rem', width: '120px', fontWeight: 600, color: '#166534', textAlign: 'left' }}>
                                5. المقبوض (+)
                              </th>
                              <th style={{ padding: '0.75rem 0.75rem', width: '120px', fontWeight: 600, color: '#991b1b', textAlign: 'left' }}>
                                6. المسحوب (-)
                              </th>
                              <th style={{ padding: '0.75rem 1rem', minWidth: '250px', fontWeight: 600, color: '#334155' }}>
                                7. البيان / السبب
                              </th>
                              <th style={{ padding: '0.75rem 0.75rem', width: '130px', fontWeight: 600, color: '#334155' }}>
                                8. المنشئ
                              </th>
                              <th style={{ padding: '0.75rem 0.75rem', width: '120px', fontWeight: 600, color: '#334155', textAlign: 'center' }}>
                                9. الحالة
                              </th>
                            </tr>
                        </thead>
                        <tbody>
                            {
                              filteredDocs.map((doc, idx) => {
                                const isIncome = doc.document_type === 'income';
                                const isExpense = doc.document_type === 'expense';
                                const isTransfer = doc.document_type === 'transfer';
                                const numAmount = toNumber(doc.amount);

                                const fromAcc = accountName(doc.from_account_id);
                                const toAcc = accountName(doc.to_account_id);

                                return (
                                      <tr
                                        key={doc.id}
                                        style={{
                                          borderBottom: '1px solid #f1f5f9',
                                          backgroundColor: idx % 2 === 0 ? '#ffffff' : '#fafafa',
                                        }}
                                      >
                                        {/* 1. التاريخ والوقت */}
                                        <td style={{ padding: '0.75rem 1rem', color: '#475569', fontSize: '0.82rem', whiteSpace: 'nowrap' }}>
                                          <div>{formatDateTime(doc.occurred_at)}</div>
                                          <code style={{ fontSize: '0.75rem', color: '#64748b' }}>{doc.document_number}</code>
                                        </td>

                                          {/* 2. نوع الحركة */}
                                          <td style={{ padding: '0.75rem 0.75rem' }}>
                                            {getDocTypeBadge(doc)}
                                            <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.2rem' }}>
                                              {cashSourceLabel(doc.source_system)}
                                            </div>
                                          </td>

                                            {/* 3. من حساب */}
                                            <td style={{ padding: '0.75rem 0.75rem', color: '#334155', fontSize: '0.85rem' }}>
                                              {fromAcc !== '—' ? (
                                                <span style={{ fontWeight: 500 }}>{fromAcc}</span>
                                              ) : (
                                                <span style={{ color: '#94a3b8' }}>—</span>
                                              )}
                                            </td>

                                              {/* 4. إلى حساب */}
                                              <td style={{ padding: '0.75rem 0.75rem', color: '#334155', fontSize: '0.85rem' }}>
                                                {toAcc !== '—' ? (
                                                  <span style={{ fontWeight: 500 }}>{toAcc}</span>
                                                ) : (
                                                  <span style={{ color: '#94a3b8' }}>—</span>
                                                )}
                                              </td>

                                                {/* 5. المقبوض (+) */}
                                                <td style={{ padding: '0.75rem 0.75rem', textAlign: 'left', fontWeight: 600, color: '#16a34a' }}>
                                                  {isIncome ? (
                                                    `+${numAmount.toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م`
                                                  ) : (
                                                    <span style={{ color: '#cbd5e1' }}>—</span>
                                                  )}
                                                </td>

                                                  {/* 6. المسحوب (-) */}
                                                  <td style={{ padding: '0.75rem 0.75rem', textAlign: 'left', fontWeight: 600, color: '#dc2626' }}>
                                                    {isExpense ? (
                                                      `-${numAmount.toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م`
                                                    ) : isTransfer ? (
                                                      `${numAmount.toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م`
                                                    ) : (
                                                      <span style={{ color: '#cbd5e1' }}>—</span>
                                                    )}
                                                  </td>

                                                  {/* 7. البيان / السبب */}
                                                  <td style={{ padding: '0.75rem 1rem', color: '#1e293b', lineHeight: 1.5, wordBreak: 'break-word' }}>
                                                    {doc.description}
                                                  </td>

                                                  {/* 8. المنشئ والمعتمد */}
                                                  <td style={{ padding: '0.75rem 0.75rem', fontSize: '0.82rem', color: '#475569' }}>
                                                    <div style={{ fontWeight: 500 }}>{userLabel(doc.created_by, user?.id)}</div>
                                                    {doc.approved_by && (
                                                      <div style={{ color: '#166534', fontSize: '0.75rem' }}>
                                                        اعتماد: {userLabel(doc.approved_by, user?.id)}
                                                      </div>
                                                    )}
                                                  </td>

                                                  {/* 9. الحالة */}
                                                  <td style={{ padding: '0.75rem 0.75rem', textAlign: 'center' }}>
                                                    <span
                                                      style={{
                                                        fontSize: '0.78rem',
                                                        padding: '0.2rem 0.55rem',
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
                                                        display: 'inline-block',
                                                        whiteSpace: 'nowrap',
                                                      }}
                                                    >
                                                      {cashStatusLabel(doc.status)}
                                                    </span>
                                                    {doc.status === 'rejected' && doc.rejection_reason && (
                                                      <div
                                                        style={{
                                                          fontSize: '0.72rem',
                                                          color: '#991b1b',
                                                          marginTop: '0.2rem',
                                                          maxWidth: '120px',
                                                          overflow: 'hidden',
                                                          textOverflow: 'ellipsis',
                                                          whiteSpace: 'nowrap',
                                                        }}
                                                        title={doc.rejection_reason}
                                                      >
                                                        {doc.rejection_reason}
                                                      </div>
                                                    )}
                                                  </td>
                                                </tr>
                                                );
                })}
                                              </tbody>
                                            </table>
                                          </div>
        )}
                                        </section>

                                        {/* مودال اعتماد المستند */}
                                        {approvingDoc && (
                                          <ApproveModal
                                            document={approvingDoc}
                                            fromAccountName={accountName(approvingDoc.from_account_id)}
                                            toAccountName={accountName(approvingDoc.to_account_id)}
                                            onClose={() => setApprovingDoc(null)}
                                            onConfirm={handleApproveConfirm}
                                            busy={busy}
                                          />
                                        )}

                                        {/* مودال رفض المستند مع السبب الإلزامي */}
                                        {rejectingDoc && (
                                          <RejectModal
                                            document={rejectingDoc}
                                            onClose={() => setRejectingDoc(null)}
                                            onConfirm={handleRejectConfirm}
                                            busy={busy}
                                          />
                                        )}
                                      </section>
                                      );
}
