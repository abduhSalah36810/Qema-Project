import React, { useState } from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import {
  financeApi,
  errorMessage,
  type AccountingLockStatusRead,
} from './financeApi';

interface OpeningLockStatusCardProps {
  lockStatus: AccountingLockStatusRead | null;
  onReload: () => void;
}

export function OpeningLockStatusCard({ lockStatus, onReload }: OpeningLockStatusCardProps) {
  const { roles, user } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Unlock request modal state
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [unlockReason, setUnlockReason] = useState('');

  const isGM = roles.includes('general_manager');
  const isFM = roles.includes('finance_manager');
  const canRequestUnlock = isGM || isFM;

  const isLocked = lockStatus?.is_locked ?? false;
  const isUnlockRequested = lockStatus?.current_action === 'unlock_request';
  const requester = lockStatus?.latest_performed_by;
  const isRequester = Boolean(user?.id && requester && (user.id === requester || user.email === requester));

  const handleManualLock = async () => {
    if (!window.confirm('هل أنت متأكد من قفل الأرصدة الافتتاحية يدويًا؟')) return;
    setSubmitting(true);
    setError('');
    setSuccess('');
    try {
      await financeApi.lockOpeningBalances({ reason: 'قفل يدوي من المدير العام' });
      setSuccess('تم قفل الأرصدة الافتتاحية بنجاح.');
      onReload();
    } catch (err: unknown) {
      setError(errorMessage(err, 'فشل قفل الأرصدة الافتتاحية.'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleSubmitUnlockRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!unlockReason.trim()) {
      setError('سبب طلب فك القفل إلزامي.');
      return;
    }
    setSubmitting(true);
    setError('');
    setSuccess('');
    try {
      await financeApi.requestUnlockOpeningBalances({ reason: unlockReason.trim() });
      setSuccess('تم تقديم طلب فك القفل بنجاح، بانتظار اعتماد المدير العام.');
      setShowRequestModal(false);
      setUnlockReason('');
      onReload();
    } catch (err: unknown) {
      setError(errorMessage(err, 'فشل تقديم طلب فك القفل.'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleApproveUnlock = async () => {
    if (!window.confirm('هل أنت متأكد من اعتماد فك قفل الأرصدة الافتتاحية؟')) return;
    setSubmitting(true);
    setError('');
    setSuccess('');
    try {
      await financeApi.approveUnlockOpeningBalances();
      setSuccess('تم فك قفل الأرصدة الافتتاحية بنجاح.');
      onReload();
    } catch (err: unknown) {
      setError(errorMessage(err, 'فشل اعتماد فك القفل.'));
    } finally {
      setSubmitting(false);
    }
  };

  const actionName = (act: string) => {
    switch (act) {
      case 'lock': return 'قفل الأرصدة';
      case 'unlock_request': return 'طلب فك قفل';
      case 'unlock_approved': return 'اعتماد فك قفل';
      default: return act;
    }
  };

  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid #cbd5e1',
        borderRadius: '8px',
        padding: '1.25rem',
        marginTop: '1.5rem',
        marginBottom: '1.5rem',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', marginBottom: '1rem' }}>
        <div>
          <h4 style={{ margin: '0 0 0.25rem 0', fontSize: '1.05rem', color: '#0f172a' }}>
            🔒 حالة قفل الأرصدة الافتتاحية
          </h4>
          <div style={{ fontSize: '0.9rem', color: '#475569' }}>
            {isLocked ? (
              <span>
                الحالة: <strong style={{ color: '#b91c1c' }}>مقفل 🔒</strong>
                {lockStatus?.latest_performed_at && (
                  <span> (أقفل في: {new Date(lockStatus.latest_performed_at).toLocaleString('ar-EG')})</span>
                )}
              </span>
            ) : (
              <span>
                الحالة: <strong style={{ color: '#047857' }}>مفتوح 🔓</strong> (يمكن تسجيل واعتماد الأرصدة الافتتاحية)
              </span>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {!isLocked && isGM && (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={handleManualLock}
              disabled={submitting}
            >
              قفل يدوي للأرصدة (GM)
            </button>
          )}

          {isLocked && !isUnlockRequested && canRequestUnlock && (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => { setShowRequestModal(true); setError(''); }}
              disabled={submitting}
            >
              طلب فك القفل 🔓
            </button>
          )}

          {isLocked && isUnlockRequested && isGM && (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={handleApproveUnlock}
              disabled={submitting || isRequester}
              title={isRequester ? 'لا يمكن لمقدم الطلب اعتماده بنفسه' : undefined}
            >
              اعتماد فك القفل (GM)
            </button>
          )}
        </div>
      </div>

      {isLocked && isUnlockRequested && (
        <div style={{ background: '#fef3c7', border: '1px solid #f59e0b', borderRadius: '6px', padding: '0.75rem', marginBottom: '1rem', fontSize: '0.88rem', color: '#92400e' }}>
          <strong>⚠️ يوجد طلب فك قفل معلق:</strong>
          <div style={{ marginTop: '0.25rem' }}>
            قدمه: <code>{lockStatus?.latest_performed_by}</code> بتاريخ {lockStatus?.latest_performed_at ? new Date(lockStatus.latest_performed_at).toLocaleString('ar-EG') : ''}
          </div>
          <div style={{ marginTop: '0.25rem' }}>
            السبب: <em>{lockStatus?.latest_reason}</em>
          </div>
          {isRequester && (
            <div style={{ marginTop: '0.25rem', color: '#b91c1c', fontWeight: 600 }}>
              (أنت مقدم هذا الطلب — يجب أن يعتمده مدير عام آخر تطبيقاً لفصل المهام Maker-Checker)
            </div>
          )}
        </div>
      )}

      {error && <div className="rh-state rh-state--error" style={{ marginBottom: '1rem' }}>{error}</div>}
      {success && <div className="rh-state" style={{ background: '#ecfdf5', color: '#047857', borderColor: '#10b981', marginBottom: '1rem' }}>{success}</div>}

      {/* Audit History */}
      {lockStatus?.history && lockStatus.history.length > 0 && (
        <div style={{ marginTop: '1rem' }}>
          <h5 style={{ margin: '0 0 0.5rem 0', fontSize: '0.9rem', color: '#334155' }}>سجل أحداث القفل وفك القفل:</h5>
          <div style={{ overflowX: 'auto' }}>
            <table className="rh-table" style={{ fontSize: '0.85rem' }}>
              <thead>
                <tr>
                  <th>التاريخ والوقت</th>
                  <th>الإجراء</th>
                  <th>المنفذ</th>
                  <th>السبب / البيان</th>
                </tr>
              </thead>
              <tbody>
                {lockStatus.history.map((h) => (
                  <tr key={h.id}>
                    <td>{new Date(h.performed_at).toLocaleString('ar-EG')}</td>
                    <td><span className="rh-pill">{actionName(h.action)}</span></td>
                    <td><code>{h.performed_by}</code></td>
                    <td>{h.reason || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Unlock Request Modal */}
      {showRequestModal && (
        <div
          className="modal-backdrop"
          onClick={() => setShowRequestModal(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15,23,42,0.5)',
            zIndex: 1300,
            display: 'grid',
            placeItems: 'center',
            padding: '16px',
          }}
        >
          <div
            className="modal-card"
            style={{ maxWidth: '500px', width: '100%', background: '#fff', borderRadius: '10px', padding: '20px' }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <h3 style={{ margin: '0 0 1rem 0' }}>طلب فك قفل الأرصدة الافتتاحية</h3>
            <form onSubmit={handleSubmitUnlockRequest}>
              <label style={{ display: 'block', marginBottom: '1rem' }}>
                <span style={{ display: 'block', fontSize: '0.88rem', fontWeight: 600, marginBottom: '0.25rem' }}>
                  سبب طلب فك القفل (إلزامي):
                </span>
                <textarea
                  value={unlockReason}
                  onChange={(e) => setUnlockReason(e.target.value)}
                  required
                  rows={3}
                  className="form-input"
                  style={{ width: '100%', padding: '8px' }}
                  placeholder="اكتب سبب طلب تعديل الأرصدة الافتتاحية بالتفصيل..."
                />
              </label>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                <button type="button" className="btn btn--secondary" onClick={() => setShowRequestModal(false)}>
                  إلغاء
                </button>
                <button type="submit" className="btn btn--primary" disabled={submitting || !unlockReason.trim()}>
                  {submitting ? 'جارٍ الإرسال...' : 'إرسال طلب فك القفل'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
