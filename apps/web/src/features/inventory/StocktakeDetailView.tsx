import React, { useState, useEffect, useCallback } from 'react';
import {
  StocktakeSession,
  StocktakeLine,
  StocktakeCountHistory,
  StocktakeAuditLog,
  StockLedgerEntry,
  startStocktakeCounting,
  recordStocktakeCounts,
  submitStocktakeForReview,
  reviewStocktakeSession,
  approveStocktakeSession,
  postStocktakeAdjustments,
  cancelStocktakeSession,
  fetchStocktakeSession,
  fetchStocktakeAudit,
  fetchStocktakeLedgerEntries,
} from './stocktakeApi';
import { useAuth } from '@/features/auth/AuthContext';
import { userLabel } from '@/lib/userLabel';
import { ApiError } from '@/lib/api';

const ROLE_AR_MAP: Record<string, string> = {
  general_manager: 'المدير العام',
  warehouse_manager: 'أمين المخازن',
  finance_manager: 'مدير المالية',
  production_manager: 'مدير الإنتاج',
  production_lead: 'قائد التشغيل',
};

const ACTION_AR_MAP: Record<string, string> = {
  session_created: 'إنشاء مسودة الجرد',
  counting_started: 'بدء العد الميداني',
  counts_recorded: 'تسجيل نتائج العد',
  submitted_for_review: 'رفع الجلسة للمراجعة',
  recount_requested: 'طلب إعادة العد',
  session_approved: 'اعتماد نتائج الجرد',
  adjustments_posted: 'ترحيل التسويات للأستاذ',
  session_cancelled: 'إلغاء جلسة الجرد',
};

/** عرض سلة الملكية لسطر الجرد بصيغة مقروءة. */
function formatBucketReference(bucket?: string | null): string {
  if (!bucket) return '—';
  if (bucket === 'factory_brand') return 'متاح للبيع';
  if (bucket.startsWith('private_label:')) return 'تصنيع خاص';
  if (bucket.startsWith('return_pending_inspection:')) return 'مرتجع تحت الفحص';
  if (bucket.startsWith('order:')) return 'خامات أمر تشغيل';
  return bucket;
}

const LINE_STATUS_AR: Record<string, string> = {
  uncounted: 'غير معدود',
  counted: 'معدود',
  recount_required: 'مطلوب إعادة عده',
};

function lineNeedsRecount(line: StocktakeLine): boolean {
  return Boolean(line.needs_recount) || line.status === 'recount_required';
}

function lineVariance(line: StocktakeLine): number | null {
  const v = line.variance_quantity ?? line.variance ?? null;
  return v === undefined ? null : v;
}

function formatSafeDate(val?: string | null): string {
  if (!val) return '—';
  const d = new Date(val);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('ar-EG');
}

function renderAuditDetails(details?: Record<string, unknown> | null, notes?: string | null): React.ReactNode {
  if (!details && !notes) return '—';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
      {notes && <div style={{ fontWeight: 500 }}>{notes}</div>}
      {details && Object.entries(details).length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', marginTop: '0.2rem' }}>
          {Object.entries(details).map(([k, v]) => {
            const keyLabel = k === 'counted_lines' ? 'الأصناف المعدودة'
              : k === 'lines_count' ? 'إجمالي الأسطر'
              : k === 'shortage_lines' ? 'العجز'
              : k === 'surplus_lines' ? 'الزيادة'
              : k === 'exact_lines' ? 'المطابق'
              : k === 'adjustments_created' ? 'قيود التسوية'
              : k === 'decision' ? 'القرار'
              : k === 'scope_type' ? 'نطاق الجرد'
              : k;
            const valDisplay = v === 'approve' ? 'اعتماد'
              : v === 'request_recount' || v === 'recount_required' ? 'إعادة عد'
              : v === 'reject' ? 'رفض'
              : v === 'full_warehouse' ? 'شامل'
              : String(v);
            return (
              <span
                key={k}
                style={{
                  backgroundColor: '#f1f5f9',
                  padding: '1px 6px',
                  borderRadius: '3px',
                  fontSize: '0.75rem',
                  color: '#475569',
                }}
              >
                {keyLabel}: <strong>{valDisplay}</strong>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface StocktakeDetailViewProps {
  sessionId: string;
  onBack: () => void;
  onSessionUpdated?: (session: StocktakeSession) => void;
}

export const StocktakeDetailView: React.FC<StocktakeDetailViewProps> = ({
  sessionId,
  onBack,
  onSessionUpdated,
}) => {
  const { hasPermission, user } = useAuth();
  const [session, setSession] = useState<StocktakeSession | null>(null);
  const [auditLogs, setAuditLogs] = useState<StocktakeAuditLog[]>([]);
  const [ledgerEntries, setLedgerEntries] = useState<StockLedgerEntry[]>([]);
  const [countsMap, setCountsMap] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState<'lines' | 'audit' | 'ledger'>('lines');
  const [filterType, setFilterType] = useState<string>('all');
  const [loading, setLoading] = useState<boolean>(true);
  const [actionBusy, setActionBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Modals state
  const [selectedHistoryLine, setSelectedHistoryLine] = useState<StocktakeLine | null>(null);
  const [isPostingModalOpen, setIsPostingModalOpen] = useState<boolean>(false);
  const [postingNotes, setPostingNotes] = useState<string>('');
  const [isCancelModalOpen, setIsCancelModalOpen] = useState<boolean>(false);
  const [cancelReason, setCancelReason] = useState<string>('');
  const [isRecountModalOpen, setIsRecountModalOpen] = useState<boolean>(false);
  const [recountNotes, setRecountNotes] = useState<string>('');
  const [selectedRecountLineIds, setSelectedRecountLineIds] = useState<string[]>([]);
  const [isRejectModalOpen, setIsRejectModalOpen] = useState<boolean>(false);
  const [rejectNotes, setRejectNotes] = useState<string>('');
  const [postingIdempotencyKey, setPostingIdempotencyKey] = useState<string>('');

  // RBAC checks
  const canCount = hasPermission('inventory:stocktake:count');
  const canSubmit = hasPermission('inventory:stocktake:submit');
  const canReview = hasPermission('inventory:stocktake:review');
  const canApprove = hasPermission('inventory:stocktake:approve');
  const canPost = hasPermission('inventory:stocktake:post');
  const canCancel = hasPermission('inventory:stocktake:cancel');

  const loadSession = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchStocktakeSession(sessionId);
      setSession(data);
      if (onSessionUpdated) onSessionUpdated(data);

      // Initialize counts map from lines
      const initialMap: Record<string, string> = {};
      data.lines?.forEach((line) => {
        // أسطر إعادة العد تبدأ فارغة حتى يُدخل العداد قيمة جديدة فعلياً
        if (line.status === 'recount_required') return;
        if (line.counted_quantity !== null && line.counted_quantity !== undefined) {
          initialMap[line.id] = String(line.counted_quantity);
        }
      });
      setCountsMap(initialMap);

      // Load audit
      const audit = await fetchStocktakeAudit(sessionId);
      setAuditLogs(audit);

      // If posted, load ledger entries
      if (data.status === 'posted') {
        const entries = await fetchStocktakeLedgerEntries(sessionId);
        setLedgerEntries(entries);
      }
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'فشل تحميل بيانات جلسة الجرد.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [sessionId, onSessionUpdated]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  const handleStartCounting = async () => {
    setActionBusy(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const updated = await startStocktakeCounting(sessionId);
      setSession(updated);
      setSuccessMsg('تم بدء مرحلة العد الميداني بنجاح.');
      await loadSession();
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'تعذر بدء العد الميداني.';
      setError(msg);
    } finally {
      setActionBusy(false);
    }
  };

  /**
   * مطابقة لقواعد الخادم (record_counts): العد مسموح أثناء counting، وأثناء under_review
   * نقصر الإدخال على الأسطر المطلوب إعادة عدها حتى لا يُعاد عد أسطر لم يطلبها المراجع.
   */
  const isLineEditable = (line: StocktakeLine): boolean => {
    if (!session || !canCount) return false;
    if (session.status === 'counting') return true;
    return session.status === 'under_review' && line.status === 'recount_required';
  };

  const countInputError = (val: string | undefined): string | null => {
    if (val === undefined || val.trim() === '') return null;
    const n = Number(val);
    if (!Number.isFinite(n)) return 'قيمة غير صالحة';
    if (n < 0) return 'لا تقبل قيم سالبة';
    return null;
  };

  const buildCountsToSave = () => {
    const sessionLines = session?.lines || [];
    return sessionLines
      .filter((line) => isLineEditable(line))
      .filter((line) => {
        const val = countsMap[line.id];
        if (val === undefined || val.trim() === '' || countInputError(val)) return false;
        if (line.status === 'recount_required') return true;
        return line.counted_quantity === null || line.counted_quantity === undefined || Number(val) !== Number(line.counted_quantity);
      })
      .map((line) => ({ line_id: line.id, counted_quantity: Number(countsMap[line.id]) }));
  };

  const hasInvalidCounts = (session?.lines || []).some((line) => isLineEditable(line) && countInputError(countsMap[line.id]) !== null);

  const handleSaveCounts = async () => {
    if (!session || !session.lines) return;
    if (hasInvalidCounts) {
      setError('راجع الكميات المعدودة: لا تقبل قيم سالبة أو غير رقمية.');
      return;
    }
    setActionBusy(true);
    setError(null);
    setSuccessMsg(null);

    const countsToSave = buildCountsToSave();

    if (countsToSave.length === 0) {
      setError('يرجى إدخال كمية معدودة لصنف واحد على الأقل قبل الحفظ.');
      setActionBusy(false);
      return;
    }

    try {
      const updated = await recordStocktakeCounts(sessionId, { counts: countsToSave });
      setSession(updated);
      setSuccessMsg(`تم حفظ العد الفعلي لـ ${countsToSave.length} صنفاً بنجاح.`);
      await loadSession();
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'تعذر حفظ الكميات المعدودة.';
      setError(msg);
    } finally {
      setActionBusy(false);
    }
  };

  const handleSubmitForReview = async () => {
    if (!session) return;
    if (hasInvalidCounts) {
      setError('راجع الكميات المعدودة: لا تقبل قيم سالبة أو غير رقمية.');
      return;
    }
    setActionBusy(true);
    setError(null);
    setSuccessMsg(null);
    try {
      // حفظ أي كميات لم تُحفظ بعد قبل الرفع
      const countsToSave = buildCountsToSave();

      if (countsToSave.length > 0) {
        await recordStocktakeCounts(sessionId, { counts: countsToSave });
      }

      const updated = await submitStocktakeForReview(sessionId, 'تم استكمال العد ورفع النتائج للمراجعة والاعتماد');
      setSession(updated);
      setSuccessMsg('تم رفع الجلسة للمراجعة والاعتماد من قبل الإدارة العامة بنجاح.');
      await loadSession();
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'تعذر رفع الجلسة للمراجعة.';
      setError(msg);
    } finally {
      setActionBusy(false);
    }
  };

  const handleApprove = async () => {
    setActionBusy(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const updated = await approveStocktakeSession(sessionId, 'تم اعتماد نتائج الجرد');
      setSession(updated);
      setSuccessMsg('تم اعتماد نتائج الجرد بنجاح. الجلسة جاهزة لترحيل التسويات للأستاذ.');
      await loadSession();
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'تعذر اعتماد الجلسة.';
      setError(msg);
    } finally {
      setActionBusy(false);
    }
  };

  const handleRequestRecount = async () => {
    const hasVarianceLines = (session?.lines || []).some((l) => {
      const v = lineVariance(l);
      return v !== null && v !== 0;
    });
    if (selectedRecountLineIds.length === 0 && !hasVarianceLines) {
      setError('حدد صنفاً واحداً على الأقل لإعادة العد؛ لا توجد أصناف ذات فروقات لإعادة عدها تلقائياً.');
      return;
    }
    setActionBusy(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const updated = await reviewStocktakeSession(sessionId, {
        decision: 'recount_required',
        notes: recountNotes,
        recount_line_ids: selectedRecountLineIds.length > 0 ? selectedRecountLineIds : undefined,
      });
      setSession(updated);
      setIsRecountModalOpen(false);
      setSelectedRecountLineIds([]);
      setRecountNotes('');
      setSuccessMsg('تم توجيه طلب إعادة العد لفريق المستودع.');
      await loadSession();
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'تعذر طلب إعادة العد.';
      setError(msg);
    } finally {
      setActionBusy(false);
    }
  };

  const openPostingModal = () => {
    // مفتاح منع تكرار واحد لكل فتح لنافذة الترحيل (إعادة المحاولة تستخدم نفس المفتاح)
    setPostingIdempotencyKey(`stk-post-${sessionId}-${Date.now()}`);
    setIsPostingModalOpen(true);
  };

  const handleReject = async () => {
    setActionBusy(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const updated = await reviewStocktakeSession(sessionId, { decision: 'reject', notes: rejectNotes.trim() || undefined });
      setSession(updated);
      setIsRejectModalOpen(false);
      setRejectNotes('');
      setSuccessMsg('تم رفض نتائج الجرد وإعادة الجلسة إلى المسودة للتصحيح.');
      await loadSession();
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'تعذر رفض الجلسة.';
      setError(msg);
    } finally {
      setActionBusy(false);
    }
  };

  const handlePostAdjustments = async () => {
    setActionBusy(true);
    setError(null);
    setSuccessMsg(null);
    const idempotencyKey = postingIdempotencyKey || `stk-post-${sessionId}-${Date.now()}`;
    try {
      const res = await postStocktakeAdjustments(sessionId, { notes: postingNotes }, idempotencyKey);
      setIsPostingModalOpen(false);
      setSuccessMsg(`تم ترحيل قيود التسوية المخزنية بنجاح (${res.adjustments_created} قيد ليدجر).`);
      await loadSession();
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'تعذر ترحيل التسويات المخزنية.';
      setError(msg);
    } finally {
      setActionBusy(false);
    }
  };

  const handleCancelSession = async () => {
    if (!cancelReason.trim()) {
      setError('يرجى كتابة سبب الإلغاء.');
      return;
    }
    setActionBusy(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const updated = await cancelStocktakeSession(sessionId, cancelReason.trim());
      setSession(updated);
      setIsCancelModalOpen(false);
      setSuccessMsg('تم إلغاء جلسة الجرد.');
      await loadSession();
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'تعذر إلغاء الجلسة.';
      setError(msg);
    } finally {
      setActionBusy(false);
    }
  };

  const setZeroCount = (lineId: string) => {
    setCountsMap((prev) => ({
      ...prev,
      [lineId]: '0',
    }));
  };

  if (loading || !session) {
    return (
      <div style={{ textAlign: 'center', padding: '3rem', color: '#64748b' }}>
        جاري تحميل تفاصيل الجلسة...
      </div>
    );
  }

  const lines = session.lines || [];
  const pendingRecountLines = lines.filter((l) => l.status === 'recount_required');
  const isReviewPhase = session.status === 'submitted' || session.status === 'under_review';
  const hasEditableLines = lines.some((l) => isLineEditable(l));
  const canResubmit = session.status === 'counting' || session.status === 'under_review';

  const filteredLines = lines.filter((line) => {
    const varQty = lineVariance(line);
    const varType = line.variance_type ?? (varQty !== null ? (varQty < 0 ? 'shortage' : varQty > 0 ? 'surplus' : 'exact') : 'pending');
    if (filterType === 'all') return true;
    if (filterType === 'shortage') return varType === 'shortage';
    if (filterType === 'surplus') return varType === 'surplus';
    if (filterType === 'exact') return varType === 'exact';
    if (filterType === 'uncounted') return line.counted_quantity === null || line.counted_quantity === undefined;
    if (filterType === 'recount') return lineNeedsRecount(line);
    return true;
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'draft':
        return <span style={{ backgroundColor: '#f1f5f9', color: '#475569', padding: '0.25rem 0.6rem', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600 }}>مسودة</span>;
      case 'counting':
        return <span style={{ backgroundColor: '#e0f2fe', color: '#0369a1', padding: '0.25rem 0.6rem', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600 }}>جارٍ العد الفعلي</span>;
      case 'submitted':
        return <span style={{ backgroundColor: '#fef3c7', color: '#b45309', padding: '0.25rem 0.6rem', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600 }}>بانتظار المراجعة</span>;
      case 'under_review':
        return <span style={{ backgroundColor: '#f3e8ff', color: '#7e22ce', padding: '0.25rem 0.6rem', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600 }}>قيد المراجعة (إعادة عد)</span>;
      case 'approved':
        return <span style={{ backgroundColor: '#dcfce7', color: '#15803d', padding: '0.25rem 0.6rem', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600 }}>معتمد للترحيل</span>;
      case 'posted':
        return <span style={{ backgroundColor: '#14532d', color: '#f0fdf4', padding: '0.25rem 0.6rem', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600 }}>مرحل للأستاذ</span>;
      case 'cancelled':
        return <span style={{ backgroundColor: '#fee2e2', color: '#b91c1c', padding: '0.25rem 0.6rem', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600 }}>ملغى</span>;
      default:
        return <span>{status}</span>;
    }
  };

  return (
    <section className="warehouse-page" dir="rtl" aria-labelledby="stocktake-detail-title">
      {/* رأس الصفحة وزر العودة */}
      <header className="warehouse-page__header" style={{ marginBottom: '1.25rem' }}>
        <div>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={onBack}
            style={{ marginBottom: '0.5rem', padding: '0.3rem 0.6rem', fontSize: '0.85rem' }}
          >
            ← العودة لقائمة الجلسات
          </button>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <h2 id="stocktake-detail-title" style={{ margin: 0 }}>
              جلسة الجرد: {session.session_number}
            </h2>
            {getStatusBadge(session.status)}
          </div>
          <p style={{ margin: '0.25rem 0 0', color: '#64748b', fontSize: '0.9rem' }}>
            {session.warehouse_name_ar || 'مستودع'} · {session.scope_type === 'full_warehouse' ? 'جرد شامل للمخزن' : 'جرد أصناف محددة'} · أنشئت بتاريخ {formatSafeDate(session.created_at)}
          </p>
        </div>

        {/* أزرار العمليات ودورة الحياة */}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {session.status === 'draft' && canCount && (
            <button
              type="button"
              className="btn btn--primary"
              disabled={actionBusy}
              onClick={handleStartCounting}
            >
              بدء العد الميداني
            </button>
          )}

          {hasEditableLines && (
            <button
              type="button"
              className="btn btn--secondary"
              disabled={actionBusy || hasInvalidCounts}
              onClick={handleSaveCounts}
            >
              {session.status === 'under_review' ? 'حفظ إعادة العد' : 'حفظ مسودة العد'}
            </button>
          )}
          {canResubmit && canSubmit && (
            <button
              type="button"
              className="btn btn--primary"
              disabled={actionBusy || hasInvalidCounts}
              onClick={handleSubmitForReview}
            >
              {session.status === 'under_review' ? 'إعادة الرفع للمراجعة' : 'رفع للاعتماد والمراجعة'}
            </button>
          )}

          {isReviewPhase && (
            <>
              {canReview && (
                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={actionBusy}
                  onClick={() => setIsRecountModalOpen(true)}
                >
                  طلب إعادة عد
                </button>
              )}
              {canReview && (
                <button
                  type="button"
                  className="btn btn--secondary"
                  disabled={actionBusy}
                  onClick={() => setIsRejectModalOpen(true)}
                  style={{ color: '#b91c1c' }}
                >
                  رفض النتائج
                </button>
              )}
              {canApprove && (
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={actionBusy || pendingRecountLines.length > 0}
                  title={pendingRecountLines.length > 0 ? 'لا يمكن الاعتماد قبل تسجيل إعادة العد المطلوبة' : undefined}
                  onClick={handleApprove}
                >
                  اعتماد نتائج الجرد
                </button>
              )}
            </>
          )}

          {session.status === 'approved' && canPost && (
            <button
              type="button"
              className="btn btn--primary"
              disabled={actionBusy}
              onClick={openPostingModal}
              style={{ backgroundColor: '#15803d', borderColor: '#15803d' }}
            >
              ترحيل التسويات للأستاذ
            </button>
          )}

          {session.status !== 'posted' && session.status !== 'cancelled' && canCancel && (
            <button
              type="button"
              className="btn btn--secondary"
              disabled={actionBusy}
              onClick={() => setIsCancelModalOpen(true)}
              style={{ color: '#b91c1c' }}
            >
              إلغاء الجلسة
            </button>
          )}
        </div>
      </header>

      {/* التنبيهات ورسائل النجاح */}
      {error && (
        <div className="warehouse-alert" role="alert" style={{ backgroundColor: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', marginBottom: '1rem', padding: '0.75rem 1rem', borderRadius: '6px' }}>
          {error}
        </div>
      )}
      {successMsg && (
        <div className="warehouse-alert" role="status" style={{ backgroundColor: '#f0fdf4', color: '#166534', border: '1px solid #bbf7d0', marginBottom: '1rem', padding: '0.75rem 1rem', borderRadius: '6px' }}>
          {successMsg}
        </div>
      )}

      {/* بطاقات الإحصاءات والمؤشرات */}
      <div className="warehouse-summary" style={{ marginBottom: '1.5rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '1rem' }}>
        <article style={{ padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid #e2e8f0', backgroundColor: '#fff' }}>
          <span style={{ fontSize: '0.8rem', color: '#64748b' }}>إجمالي الأصناف</span>
          <strong style={{ fontSize: '1.4rem', color: '#0f172a', display: 'block' }}>{session.total_lines || lines.length}</strong>
        </article>
        <article style={{ padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid #e2e8f0', backgroundColor: '#fff' }}>
          <span style={{ fontSize: '0.8rem', color: '#64748b' }}>الأصناف المعدودة</span>
          <strong style={{ fontSize: '1.4rem', color: '#0369a1', display: 'block' }}>
            {session.counted_lines || 0} <small style={{ fontSize: '0.8rem', color: '#64748b' }}>({session.total_lines > 0 ? Math.round(((session.counted_lines || 0) / session.total_lines) * 100) : 0}%)</small>
          </strong>
        </article>
        <article style={{ padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid #e2e8f0', backgroundColor: '#fff' }}>
          <span style={{ fontSize: '0.8rem', color: '#64748b' }}>أصناف العجز</span>
          <strong style={{ fontSize: '1.4rem', color: '#b91c1c', display: 'block' }}>{session.shortage_lines ?? session.shortage_count ?? 0}</strong>
        </article>
        <article style={{ padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid #e2e8f0', backgroundColor: '#fff' }}>
          <span style={{ fontSize: '0.8rem', color: '#64748b' }}>أصناف الزيادة</span>
          <strong style={{ fontSize: '1.4rem', color: '#15803d', display: 'block' }}>{session.surplus_lines ?? session.surplus_count ?? 0}</strong>
        </article>
        <article style={{ padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid #e2e8f0', backgroundColor: '#fff' }}>
          <span style={{ fontSize: '0.8rem', color: '#64748b' }}>مطابق تماماً</span>
          <strong style={{ fontSize: '1.4rem', color: '#475569', display: 'block' }}>{session.exact_lines ?? session.exact_count ?? 0}</strong>
        </article>
        {pendingRecountLines.length > 0 && (
          <article style={{ padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid #e9d5ff', backgroundColor: '#faf5ff' }}>
            <span style={{ fontSize: '0.8rem', color: '#7e22ce' }}>مطلوب إعادة عدها</span>
            <strong style={{ fontSize: '1.4rem', color: '#7e22ce', display: 'block' }}>{pendingRecountLines.length}</strong>
          </article>
        )}
      </div>

      {/* المسؤولون عن مراحل الجلسة */}
      <dl
        aria-label="مسؤولو مراحل الجلسة"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.5rem 1rem', margin: '0 0 1.25rem', padding: '0.75rem 1rem', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '0.85rem' }}
      >
        <div><dt style={{ color: '#64748b' }}>أنشأها</dt><dd style={{ margin: 0, fontWeight: 600 }}>{userLabel(session.created_by, user?.id)} · {formatSafeDate(session.created_at)}</dd></div>
        <div><dt style={{ color: '#64748b' }}>رفعها للمراجعة</dt><dd style={{ margin: 0, fontWeight: 600 }}>{session.submitted_by ? `${session.submitted_by} · ${formatSafeDate(session.submitted_at)}` : '—'}</dd></div>
        <div><dt style={{ color: '#64748b' }}>آخر مراجعة</dt><dd style={{ margin: 0, fontWeight: 600 }}>{(session.reviewed_by || session.reviewer_id) ? `${session.reviewed_by || session.reviewer_id} · ${formatSafeDate(session.reviewed_at)}` : '—'}</dd></div>
        <div><dt style={{ color: '#64748b' }}>اعتمدها</dt><dd style={{ margin: 0, fontWeight: 600 }}>{session.approved_by ? `${userLabel(session.approved_by, user?.id)} · ${formatSafeDate(session.approved_at)}` : '—'}</dd></div>
        <div><dt style={{ color: '#64748b' }}>رحّلها</dt><dd style={{ margin: 0, fontWeight: 600 }}>{session.posted_by ? `${session.posted_by} · ${formatSafeDate(session.posted_at)}` : '—'}</dd></div>
        {session.status === 'cancelled' && (
          <div><dt style={{ color: '#64748b' }}>ألغاها</dt><dd style={{ margin: 0, fontWeight: 600 }}>{session.cancelled_by || '—'} · {session.cancellation_reason || ''}</dd></div>
        )}
        {session.review_notes && (
          <div style={{ gridColumn: '1 / -1' }}><dt style={{ color: '#64748b' }}>ملاحظات المراجعة</dt><dd style={{ margin: 0 }}>{session.review_notes}</dd></div>
        )}
      </dl>

      {session.status === 'under_review' && pendingRecountLines.length > 0 && (
        <p role="note" style={{ margin: '0 0 1rem', color: '#7e22ce', fontSize: '0.9rem' }}>
          طلب المراجع إعادة عد {pendingRecountLines.length} صنف. أدخل الكمية الجديدة للأسطر المظللة ثم احفظ؛ لا يمكن الاعتماد قبل ذلك.
        </p>
      )}

      {/* تبويبات الشاشة: الأسطر، سجل التدقيق، قيود الأستاذ */}
      <div style={{ display: 'flex', gap: '0.5rem', borderBottom: '1px solid #e2e8f0', marginBottom: '1rem' }}>
        <button
          type="button"
          onClick={() => setActiveTab('lines')}
          style={{
            padding: '0.6rem 1.25rem',
            border: 'none',
            borderBottom: activeTab === 'lines' ? '2px solid #0284c7' : '2px solid transparent',
            color: activeTab === 'lines' ? '#0284c7' : '#64748b',
            fontWeight: 600,
            cursor: 'pointer',
            backgroundColor: 'transparent',
          }}
        >
          أسطر الجرد والعد الفعلي ({lines.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('audit')}
          style={{
            padding: '0.6rem 1.25rem',
            border: 'none',
            borderBottom: activeTab === 'audit' ? '2px solid #0284c7' : '2px solid transparent',
            color: activeTab === 'audit' ? '#0284c7' : '#64748b',
            fontWeight: 600,
            cursor: 'pointer',
            backgroundColor: 'transparent',
          }}
        >
          سجل التدقيق والتتبع ({auditLogs.length})
        </button>
        {session.status === 'posted' && (
          <button
            type="button"
            onClick={() => setActiveTab('ledger')}
            style={{
              padding: '0.6rem 1.25rem',
              border: 'none',
              borderBottom: activeTab === 'ledger' ? '2px solid #0284c7' : '2px solid transparent',
              color: activeTab === 'ledger' ? '#0284c7' : '#64748b',
              fontWeight: 600,
              cursor: 'pointer',
              backgroundColor: 'transparent',
            }}
          >
            قيود الأستاذ المرحلة ({ledgerEntries.length})
          </button>
        )}
      </div>

      {/* ── تبويب 1: جدول أسطر الجرد ── */}
      {activeTab === 'lines' && (
        <>
          {/* فلتر أنواع الفروقات */}
          <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className={`btn ${filterType === 'all' ? 'btn--primary' : 'btn--secondary'}`}
              style={{ fontSize: '0.8rem', padding: '0.3rem 0.6rem' }}
              onClick={() => setFilterType('all')}
            >
              الكل ({lines.length})
            </button>
            <button
              type="button"
              className={`btn ${filterType === 'shortage' ? 'btn--primary' : 'btn--secondary'}`}
              style={{ fontSize: '0.8rem', padding: '0.3rem 0.6rem' }}
              onClick={() => setFilterType('shortage')}
            >
              العجز ({session.shortage_lines})
            </button>
            <button
              type="button"
              className={`btn ${filterType === 'surplus' ? 'btn--primary' : 'btn--secondary'}`}
              style={{ fontSize: '0.8rem', padding: '0.3rem 0.6rem' }}
              onClick={() => setFilterType('surplus')}
            >
              الزيادة ({session.surplus_lines})
            </button>
            <button
              type="button"
              className={`btn ${filterType === 'exact' ? 'btn--primary' : 'btn--secondary'}`}
              style={{ fontSize: '0.8rem', padding: '0.3rem 0.6rem' }}
              onClick={() => setFilterType('exact')}
            >
              المطابق ({session.exact_lines})
            </button>
            <button
              type="button"
              className={`btn ${filterType === 'uncounted' ? 'btn--primary' : 'btn--secondary'}`}
              style={{ fontSize: '0.8rem', padding: '0.3rem 0.6rem' }}
              onClick={() => setFilterType('uncounted')}
            >
              غير معدود ({session.total_lines - session.counted_lines})
            </button>
            {lines.some((l) => lineNeedsRecount(l)) && (
              <button
                type="button"
                className={`btn ${filterType === 'recount' ? 'btn--primary' : 'btn--secondary'}`}
                style={{ fontSize: '0.8rem', padding: '0.3rem 0.6rem', color: '#7e22ce' }}
                onClick={() => setFilterType('recount')}
              >
                مطلوب إعادة عدها
              </button>
            )}
          </div>

          <div className="warehouse-table-wrap">
            <table className="warehouse-table">
              <thead>
                <tr>
                  <th>كود الصنف</th>
                  <th>اسم الصنف</th>
                  <th>الملكية</th>
                  <th>الوحدة</th>
                  <th style={{ textAlign: 'center' }}>الرصيد الدفتري (اللقطة)</th>
                  <th style={{ textAlign: 'center', width: '220px' }}>العد الفعلي</th>
                  <th style={{ textAlign: 'center' }}>الفرق (المعدود − الدفتري)</th>
                  <th style={{ textAlign: 'center' }}>نوع الفرق</th>
                  <th style={{ textAlign: 'center' }}>حالة السطر</th>
                  <th style={{ textAlign: 'center' }}>السجل</th>
                </tr>
              </thead>
              <tbody>
                {filteredLines.length === 0 ? (
                  <tr>
                    <td colSpan={10} style={{ textAlign: 'center', padding: '2rem', color: '#94a3b8' }}>
                      لا توجد أسطر مطابقة للفلتر المحدد
                    </td>
                  </tr>
                ) : (
                  filteredLines.map((line) => {
                    const isCounted = line.counted_quantity !== null && line.counted_quantity !== undefined;
                    const countVal = countsMap[line.id] ?? '';
                    const editable = isLineEditable(line);
                    const needsRecount = lineNeedsRecount(line);
                    const inputError = editable ? countInputError(countsMap[line.id]) : null;
                    const historyCount = (line.history || line.count_history || []).length;

                    return (
                      <tr
                        key={line.id}
                        data-needs-recount={needsRecount ? 'true' : undefined}
                        style={{
                          backgroundColor: needsRecount ? '#faf5ff' : undefined,
                          boxShadow: needsRecount ? 'inset -4px 0 0 #a855f7' : undefined,
                        }}
                      >
                        <td style={{ fontWeight: 600 }}>{line.item_code}</td>
                        <td>{line.item_name_ar}</td>
                        <td title={line.bucket_reference || undefined}>{formatBucketReference(line.bucket_reference)}</td>
                        <td>{line.unit_name_ar}</td>
                        <td style={{ textAlign: 'center', fontWeight: 600 }}>
                          {Number(line.book_quantity).toLocaleString('ar-EG', { maximumFractionDigits: 3 })}
                        </td>

                        {/* إدخال العد الفعلي */}
                        <td style={{ textAlign: 'center' }}>
                          {editable ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                              <input
                                type="number"
                                min="0"
                                step="any"
                                placeholder="أدخل الكمية..."
                                aria-label={`العد الفعلي ${line.item_code}`}
                                aria-invalid={inputError ? true : undefined}
                                value={countVal}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  setCountsMap((prev) => ({ ...prev, [line.id]: val }));
                                }}
                                style={{
                                  width: '100px',
                                  padding: '0.35rem 0.5rem',
                                  borderRadius: '4px',
                                  border: '1px solid #cbd5e1',
                                  textAlign: 'center',
                                  fontSize: '0.9rem',
                                }}
                              />
                              <button
                                type="button"
                                title="تحديد رصيد نافد (0.0)"
                                onClick={() => setZeroCount(line.id)}
                                style={{
                                  padding: '0.3rem 0.5rem',
                                  fontSize: '0.75rem',
                                  backgroundColor: '#f1f5f9',
                                  border: '1px solid #cbd5e1',
                                  borderRadius: '4px',
                                  cursor: 'pointer',
                                }}
                              >
                                نافد (0)
                              </button>
                              {line.status === 'recount_required' && isCounted && (
                                <small style={{ flexBasis: '100%', color: '#7e22ce' }}>
                                  العد السابق: {Number(line.counted_quantity).toLocaleString('ar-EG', { maximumFractionDigits: 3 })}
                                </small>
                              )}
                              {inputError && <small role="alert" style={{ flexBasis: '100%', color: '#b91c1c' }}>{inputError}</small>}
                            </div>
                          ) : (
                            <div>
                              {isCounted ? (
                                <span style={{ fontWeight: 600, color: '#0f172a' }}>
                                  {Number(line.counted_quantity).toLocaleString('ar-EG', { maximumFractionDigits: 3 })}
                                </span>
                              ) : (
                                <span style={{ color: '#94a3b8', fontSize: '0.85rem' }}>غير معدود</span>
                              )}
                            </div>
                          )}
                        </td>

                        {/* الفرق */}
                        <td style={{ textAlign: 'center', fontWeight: 600 }}>
                          {(() => {
                            const varQty = lineVariance(line);
                            if (varQty !== null) {
                              return (
                                <span
                                  style={{
                                    color:
                                      varQty < 0
                                        ? '#b91c1c'
                                        : varQty > 0
                                        ? '#15803d'
                                        : '#64748b',
                                  }}
                                >
                                  {varQty > 0 ? `+${varQty}` : varQty}
                                </span>
                              );
                            }
                            return <span style={{ color: '#cbd5e1' }}>—</span>;
                          })()}
                        </td>

                        {/* نوع الفرق */}
                        <td style={{ textAlign: 'center' }}>
                          {(() => {
                            const varQty = lineVariance(line);
                            const varType = line.variance_type ?? (varQty !== null ? (varQty < 0 ? 'shortage' : varQty > 0 ? 'surplus' : 'exact') : 'pending');
                            return (
                              <>
                                {varType === 'shortage' && (
                                  <span style={{ backgroundColor: '#fee2e2', color: '#b91c1c', padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600 }}>
                                    عجز مخزني
                                  </span>
                                )}
                                {varType === 'surplus' && (
                                  <span style={{ backgroundColor: '#dcfce7', color: '#15803d', padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600 }}>
                                    زيادة مخزنية
                                  </span>
                                )}
                                {varType === 'exact' && (
                                  <span style={{ backgroundColor: '#f1f5f9', color: '#475569', padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600 }}>
                                    مطابق تماماً
                                  </span>
                                )}
                                {varType === 'pending' && (
                                  <span style={{ backgroundColor: '#f8fafc', color: '#94a3b8', padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.75rem' }}>
                                    معلق
                                  </span>
                                )}
                              </>
                            );
                          })()}
                        </td>

                        {/* حالة السطر */}
                        <td style={{ textAlign: 'center', fontSize: '0.8rem' }}>
                          {needsRecount ? (
                            <span style={{ color: '#7e22ce', fontWeight: 700 }}>⚠️ مطلوب إعادة عده</span>
                          ) : (
                            <span style={{ color: '#475569' }}>
                              {LINE_STATUS_AR[line.status || ''] || (isCounted ? 'معدود' : 'غير معدود')}
                            </span>
                          )}
                        </td>

                        {/* زر عرض سجل إعادة العد */}
                        <td style={{ textAlign: 'center' }}>
                          <button
                            type="button"
                            onClick={() => setSelectedHistoryLine(line)}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: '#0284c7',
                              fontSize: '0.8rem',
                              cursor: 'pointer',
                              textDecoration: 'underline',
                            }}
                          >
                            السجل ({historyCount})
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* ── تبويب 2: سجل التدقيق والتتبع ── */}
      {activeTab === 'audit' && (
        <div className="warehouse-table-wrap">
          <table className="warehouse-table">
            <thead>
              <tr>
                <th>الحدث</th>
                <th>المستخدم / الفاعل</th>
                <th>الدور الوظيفي</th>
                <th>التاريخ والوقت</th>
                <th>التفاصيل والملاحظات</th>
              </tr>
            </thead>
            <tbody>
              {auditLogs.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', padding: '2rem', color: '#94a3b8' }}>
                    لا توجد حركات تدقيق مسجلة
                  </td>
                </tr>
              ) : (
                auditLogs.map((log) => (
                  <tr key={log.id}>
                    <td style={{ fontWeight: 600 }}>{log.event_name_ar || (log.action ? ACTION_AR_MAP[log.action] : undefined) || log.action || '—'}</td>
                    <td>{log.actor_id}</td>
                    <td><span style={{ fontSize: '0.8rem', color: '#64748b' }}>{ROLE_AR_MAP[log.actor_role] || log.actor_role}</span></td>
                    <td style={{ fontSize: '0.85rem' }}>{formatSafeDate(log.created_at || log.timestamp)}</td>
                    <td style={{ fontSize: '0.8rem', color: '#475569' }}>
                      {renderAuditDetails(log.details, log.notes)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ── تبويب 3: قيود الأستاذ المرحلة ── */}
      {activeTab === 'ledger' && (
        <div className="warehouse-table-wrap">
          <table className="warehouse-table">
            <thead>
              <tr>
                <th>كود الصنف</th>
                <th>اسم الصنف</th>
                <th>نوع الحركة</th>
                <th style={{ textAlign: 'center' }}>الكمية</th>
                <th>المستند المرجعي</th>
                <th>التاريخ</th>
                <th>المُرحّل</th>
              </tr>
            </thead>
            <tbody>
              {ledgerEntries.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', padding: '2rem', color: '#94a3b8' }}>
                    لا توجد قيود أستاذ مرحلة لهذه الجلسة
                  </td>
                </tr>
              ) : (
                ledgerEntries.map((entry) => (
                  <tr key={entry.id}>
                    <td style={{ fontWeight: 600 }}>{entry.item_code || entry.item_id}</td>
                    <td>{entry.item_name_ar || '—'}</td>
                    <td>
                      {entry.entry_type === 'inventory_adjustment_shortage' && (
                        <span style={{ backgroundColor: '#fee2e2', color: '#b91c1c', padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600 }}>
                          تسوية عجز مخزني (خصم)
                        </span>
                      )}
                      {entry.entry_type === 'inventory_adjustment_surplus' && (
                        <span style={{ backgroundColor: '#dcfce7', color: '#15803d', padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600 }}>
                          تسوية زيادة مخزنية (إضافة)
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: 'center', fontWeight: 600, color: entry.quantity < 0 ? '#b91c1c' : '#15803d' }}>
                      {entry.quantity > 0 ? `+${entry.quantity}` : entry.quantity}
                    </td>
                    <td style={{ fontSize: '0.85rem' }}>{entry.reference_doc_id}</td>
                    <td style={{ fontSize: '0.85rem' }}>{new Date(entry.created_at).toLocaleString('ar-EG')}</td>
                    <td>{userLabel(entry.created_by, user?.id)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ── نافذة منبثقة: سجل تاريخ إعادة العد للصنف ── */}
      {selectedHistoryLine && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
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
        >
          <div
            className="modal-card"
            dir="rtl"
            style={{
              backgroundColor: '#ffffff',
              borderRadius: '12px',
              maxWidth: '540px',
              width: '100%',
              padding: '1.25rem',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '0.5rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.1rem' }}>
                سجل محاولات العد: {selectedHistoryLine.item_name_ar} ({selectedHistoryLine.item_code})
              </h3>
              <button
                type="button"
                onClick={() => setSelectedHistoryLine(null)}
                style={{ background: 'none', border: 'none', fontSize: '1.25rem', cursor: 'pointer', color: '#94a3b8' }}
              >
                ✕
              </button>
            </div>

            <p style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '1rem' }}>
              الرصيد الدفتري الأصلي: <strong>{selectedHistoryLine.book_quantity} {selectedHistoryLine.unit_name_ar}</strong>
            </p>

            <div style={{ maxHeight: '250px', overflowY: 'auto' }}>
              {(() => {
                const historyList: StocktakeCountHistory[] = selectedHistoryLine.history || selectedHistoryLine.count_history || [];
                if (historyList.length === 0) {
                  return (
                    <div style={{ textAlign: 'center', padding: '1rem', color: '#94a3b8' }}>
                      لا توجد محاولات عد مسجلة
                    </div>
                  );
                }
                return (
                  <table className="warehouse-table" style={{ fontSize: '0.85rem' }}>
                    <thead>
                      <tr>
                        <th># الترتيب</th>
                        <th>الكمية المعدودة</th>
                        <th>العداد</th>
                        <th>التاريخ والوقت</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyList.map((h, idx) => (
                        <tr key={h.id || idx}>
                          <td>محاولة {h.count_sequence || idx + 1}</td>
                          <td style={{ fontWeight: 600 }}>{h.counted_quantity}</td>
                          <td>{h.counter_id} ({ROLE_AR_MAP[h.counter_role] || h.counter_role || '—'})</td>
                          <td>{formatSafeDate(h.recorded_at || h.counted_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                );
              })()}
            </div>

            <div style={{ marginTop: '1.25rem', textAlign: 'left' }}>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => setSelectedHistoryLine(null)}
              >
                إغلاق
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── نافذة منبثقة: تأكيد ترحيل التسويات للأستاذ ── */}
      {isPostingModalOpen && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
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
        >
          <div
            className="modal-card"
            dir="rtl"
            style={{
              backgroundColor: '#ffffff',
              borderRadius: '12px',
              maxWidth: '560px',
              width: '100%',
              padding: '1.5rem',
            }}
          >
            <h3 style={{ margin: '0 0 0.5rem', color: '#15803d', fontSize: '1.2rem' }}>
              تأكيد ترحيل التسويات المخزنية للأستاذ
            </h3>
            <p style={{ margin: '0 0 1rem', fontSize: '0.9rem', color: '#334155', lineHeight: 1.5 }}>
              سيتم إنشاء قيود أستاذ مخزنية دائمة غير قابلة للتعديل أو المسح لمعالجة فروقات الجرد:
            </p>

            <div style={{ backgroundColor: '#f8fafc', padding: '1rem', borderRadius: '8px', border: '1px solid #e2e8f0', marginBottom: '1rem' }}>
              <ul style={{ margin: 0, paddingRight: '1.25rem', fontSize: '0.9rem', color: '#1e293b' }}>
                <li>أصناف العجز التي سيتم خصمها من المخزن: <strong>{session.shortage_lines} صنف</strong></li>
                <li>أصناف الزيادة التي سيتم إضافتها للمخزن: <strong>{session.surplus_lines} صنف</strong></li>
                <li>أصناف مطابقة (لن ينشأ لها قيود): <strong>{session.exact_lines} صنف</strong></li>
                <li>تُحسب تكلفة التسويات وقيودها المحاسبية على الخادم عند الترحيل بمتوسط التكلفة.</li>
              </ul>
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label htmlFor="post-notes" style={{ display: 'block', fontWeight: 600, marginBottom: '0.4rem', fontSize: '0.85rem' }}>
                ملاحظات الترحيل (اختياري)
              </label>
              <textarea
                id="post-notes"
                rows={2}
                value={postingNotes}
                onChange={(e) => setPostingNotes(e.target.value)}
                placeholder="مثال: تم ترحيل قيود التسوية بعد اعتماد الإدارة العامة"
                style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '0.85rem' }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
              <button
                type="button"
                className="btn btn--secondary"
                disabled={actionBusy}
                onClick={() => setIsPostingModalOpen(false)}
              >
                إلغاء
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={actionBusy}
                onClick={handlePostAdjustments}
                style={{ backgroundColor: '#15803d', borderColor: '#15803d' }}
              >
                {actionBusy ? 'جاري الترحيل...' : 'تأكيد الترحيل النهائي'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── نافذة منبثقة: طلب إعادة العد ── */}
      {isRecountModalOpen && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
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
        >
          <div
            className="modal-card"
            dir="rtl"
            style={{
              backgroundColor: '#ffffff',
              borderRadius: '12px',
              maxWidth: '540px',
              width: '100%',
              padding: '1.5rem',
            }}
          >
            <h3 style={{ margin: '0 0 0.5rem', color: '#7e22ce', fontSize: '1.2rem' }}>
              طلب إعادة عد أصناف محددة
            </h3>
            <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: '#64748b' }}>
              حدد الأصناف التي تطلب من فريق المخزن إعادة عدها ميدانياً. إن لم تحدد شيئاً يُطلب إعادة عد كل الأصناف ذات الفروقات.
            </p>

            <div style={{ maxHeight: '180px', overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: '6px', padding: '0.5rem', marginBottom: '1rem' }}>
              {lines.map((l) => (
                <label key={l.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.3rem 0', borderBottom: '1px solid #f1f5f9' }}>
                  <input
                    type="checkbox"
                    checked={selectedRecountLineIds.includes(l.id)}
                    onChange={() => {
                      setSelectedRecountLineIds((prev) =>
                        prev.includes(l.id) ? prev.filter((id) => id !== l.id) : [...prev, l.id]
                      );
                    }}
                  />
                  <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>{l.item_code}</span>
                  <span style={{ fontSize: '0.85rem', color: '#475569', flex: 1 }}>{l.item_name_ar}</span>
                  <span style={{ fontSize: '0.8rem', color: (lineVariance(l) ?? 0) < 0 ? '#b91c1c' : '#15803d' }}>
                    {(() => {
                      const v = lineVariance(l);
                      if (v === null) return 'غير معدود';
                      if (v === 0) return 'مطابق';
                      return `${v < 0 ? 'عجز' : 'زيادة'} (${v > 0 ? '+' : ''}${v})`;
                    })()}
                  </span>
                </label>
              ))}
            </div>

            <div style={{ marginBottom: '1rem' }}>
              <label htmlFor="recount-notes" style={{ display: 'block', fontWeight: 600, marginBottom: '0.4rem', fontSize: '0.85rem' }}>
                سبب طلب إعادة العد
              </label>
              <textarea
                id="recount-notes"
                rows={2}
                value={recountNotes}
                onChange={(e) => setRecountNotes(e.target.value)}
                placeholder="مثال: يرجى التحقق من رف خامات القطن لوجود عجز غير مبرر"
                style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '0.85rem' }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
              <button
                type="button"
                className="btn btn--secondary"
                disabled={actionBusy}
                onClick={() => setIsRecountModalOpen(false)}
              >
                إلغاء
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={actionBusy}
                onClick={handleRequestRecount}
              >
                {actionBusy ? 'جاري الإرسال...' : 'إرسال طلب إعادة العد'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── نافذة منبثقة: رفض نتائج الجرد ── */}
      {isRejectModalOpen && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
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
        >
          <div
            className="modal-card"
            dir="rtl"
            style={{ backgroundColor: '#ffffff', borderRadius: '12px', maxWidth: '500px', width: '100%', padding: '1.5rem' }}
          >
            <h3 style={{ margin: '0 0 0.5rem', color: '#b91c1c', fontSize: '1.2rem' }}>رفض نتائج الجرد</h3>
            <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: '#64748b' }}>
              تعود الجلسة إلى حالة المسودة للتصحيح، ويُسجل الرفض في سجل التدقيق.
            </p>
            <div style={{ marginBottom: '1rem' }}>
              <label htmlFor="reject-notes" style={{ display: 'block', fontWeight: 600, marginBottom: '0.4rem', fontSize: '0.85rem' }}>
                سبب الرفض
              </label>
              <textarea
                id="reject-notes"
                rows={3}
                value={rejectNotes}
                onChange={(e) => setRejectNotes(e.target.value)}
                style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '0.85rem' }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
              <button type="button" className="btn btn--secondary" disabled={actionBusy} onClick={() => setIsRejectModalOpen(false)}>
                تراجع
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={actionBusy}
                onClick={handleReject}
                style={{ backgroundColor: '#b91c1c', borderColor: '#b91c1c' }}
              >
                {actionBusy ? 'جاري الرفض...' : 'تأكيد الرفض'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── نافذة منبثقة: إلغاء الجلسة ── */}
      {isCancelModalOpen && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
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
        >
          <div
            className="modal-card"
            dir="rtl"
            style={{
              backgroundColor: '#ffffff',
              borderRadius: '12px',
              maxWidth: '500px',
              width: '100%',
              padding: '1.5rem',
            }}
          >
            <h3 style={{ margin: '0 0 0.5rem', color: '#b91c1c', fontSize: '1.2rem' }}>
              إلغاء جلسة الجرد
            </h3>
            <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: '#64748b' }}>
              لن يتم ترحيل أي قيود تسوية للأستاذ المخزني، وسيتم تثبيت سبب الإلغاء في سجل التدقيق.
            </p>

            <div style={{ marginBottom: '1rem' }}>
              <label htmlFor="cancel-reason" style={{ display: 'block', fontWeight: 600, marginBottom: '0.4rem', fontSize: '0.85rem' }}>
                سبب الإلغاء *
              </label>
              <textarea
                id="cancel-reason"
                rows={3}
                required
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="أدخل سبب إلغاء الجلسة بالتفصيل..."
                style={{ width: '100%', padding: '0.5rem', borderRadius: '6px', border: '1px solid #cbd5e1', fontSize: '0.85rem' }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
              <button
                type="button"
                className="btn btn--secondary"
                disabled={actionBusy}
                onClick={() => setIsCancelModalOpen(false)}
              >
                تراجع
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={actionBusy}
                onClick={handleCancelSession}
                style={{ backgroundColor: '#b91c1c', borderColor: '#b91c1c' }}
              >
                {actionBusy ? 'جاري الإلغاء...' : 'تأكيد الإلغاء'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
