/**
 * تبويب «التنفيذ والمراحل» في صفحة تفاصيل أمر التشغيل (T4.2):
 * بطاقات المراحل الخمس بقاعدة التتابع الإلزامي (بدء/إكمال/تخطي/إعادة فتح/تعديل المدة)
 * + سجل العيوب والإصلاحات. المنطق منقول حرفيًا من تبويبَي stages وdefects بالـModal القديم.
 */
import React, { useEffect, useState } from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import { userLabel } from '@/lib/userLabel';
import {
  ProductionDefect,
  fetchOrderDefects,
  reportOrderDefect,
  updateOrderDefect,
  updateStageApi,
  rollbackStageApi,
  skipProductionStage,
  adjustStageDuration,
} from '../productionApi';
import {
  STAGE_TITLES_AR,
  STAGE_SEQUENCE,
  STAGE_STATUS_AR,
  DELAY_REASONS_AR,
  ROLLBACK_STATUSES,
  parseApiError,
  stageLockReason,
  type SectionContext,
} from './constants';

interface OrderExecutionSectionProps {
  ctx: SectionContext;
}

export const OrderExecutionSection: React.FC<OrderExecutionSectionProps> = ({ ctx }) => {
  const { order, onOrderUpdated, refreshOrder, reportFailure, setStatus, setBusy } = ctx;
  const { hasPermission, user } = useAuth();
  const canManageStages = hasPermission('production:stages:manage');
  const canReportDefects = hasPermission('production:orders:manage');

  const [isProcessing, setIsProcessing] = useState(false);
  const [defects, setDefects] = useState<ProductionDefect[]>([]);
  const [defectForm, setDefectForm] = useState({ stage_name: 'cutting', description: '', affected_quantity: '', responsible: '', repair_action: '', repair_cost_description: '' });
  const [stageNotes, setStageNotes] = useState<Record<string, string>>(() =>
    Object.fromEntries(order.stage_events.map((event) => [event.stage_name, event.notes || '']))
  );
  const [rollbackReasons, setRollbackReasons] = useState<Record<string, string>>({});
  const [stageDelayReasons, setStageDelayReasons] = useState<Record<string, string>>(() =>
    Object.fromEntries(order.stage_events.map((event) => [event.delay_reason || '', ''] as [string, string]).map(([k]) => [k, '']))
  );
  const [stageDelayNotes, setStageDelayNotes] = useState<Record<string, string>>(() =>
    Object.fromEntries(order.stage_events.map((event) => [event.stage_name, event.delay_notes || '']))
  );

  useEffect(() => {
    setStageNotes(Object.fromEntries(order.stage_events.map((event) => [event.stage_name, event.notes || ''])));
    setStageDelayReasons((prev) => {
      const next: Record<string, string> = {};
      order.stage_events.forEach((event) => {
        next[event.stage_name] = prev[event.stage_name] ?? (event.delay_reason || '');
      });
      return next;
    });
    setStageDelayNotes(Object.fromEntries(order.stage_events.map((event) => [event.stage_name, event.delay_notes || ''])));
  }, [order.id, order.stage_events]);

  const [defectsLoading, setDefectsLoading] = useState(false);
  const [defectsError, setDefectsError] = useState<string | null>(null);

  const loadDefects = async () => {
    setDefectsLoading(true);
    setDefectsError(null);
    try {
      const data = await fetchOrderDefects(order.id);
      setDefects(data);
    } catch (err: unknown) {
      setDefectsError(parseApiError(err, 'تعذر تحميل سجل العيوب.').text);
    } finally {
      setDefectsLoading(false);
    }
  };

  useEffect(() => { void loadDefects(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [order.id]);

  const handleReportDefect = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsProcessing(true);
    setBusy(true);
    try {
      const created = await reportOrderDefect(order.id, { ...defectForm, affected_quantity: Number(defectForm.affected_quantity) });
      setDefects((items) => [created, ...items]);
      setDefectForm({ stage_name: 'cutting', description: '', affected_quantity: '', responsible: '', repair_action: '', repair_cost_description: '' });
      setStatus({ type: 'success', text: 'تم تسجيل العيب.' });
    } catch (err: unknown) {
      reportFailure(err, 'تعذر تسجيل العيب؛ تحقق من الحقول والصلاحية.');
    } finally { setIsProcessing(false); setBusy(false); }
  };

  // 3. تحديث مرحلة إنتاج تتابعياً (TIME-DEC-03 & TIME-DEC-04)
  const handleUpdateStage = async (stageName: string, nextStatus: 'in_progress' | 'completed') => {
    const lockReason = stageLockReason(order.status);
    if (lockReason) {
      setStatus({ type: 'error', text: lockReason });
      return;
    }
    const stageIndex = STAGE_SEQUENCE.indexOf(stageName);
    if (stageIndex > 0) {
      for (let i = 0; i < stageIndex; i++) {
        const prevStage = STAGE_SEQUENCE[i];
        const prevEvent = order.stage_events.find((s) => s.stage_name === prevStage);
        if (prevEvent && !prevEvent.is_skipped && prevEvent.status !== 'completed') {
          setStatus({
            type: 'error',
            text: `لا يمكن نقل مرحلة (${STAGE_TITLES_AR[stageName]}) إلا بعد اكتمال مرحلة (${STAGE_TITLES_AR[prevStage]}).`,
          });
          return;
        }
      }
    }
    setIsProcessing(true);
    setBusy(true);
    setStatus(null);
    try {
      await updateStageApi(
        order.id,
        stageName,
        nextStatus,
        stageNotes[stageName] || '',
        stageDelayReasons[stageName] || undefined,
        stageDelayNotes[stageName] || undefined
      );
    } catch (err: unknown) {
      reportFailure(err, `تعذر تحديث مرحلة (${STAGE_TITLES_AR[stageName]}). تحقق من التتابع وصلاحياتك والاتصال بالخادم.`);
      setIsProcessing(false);
      setBusy(false);
      return;
    }
    await refreshOrder(`تم تحديث مرحلة (${STAGE_TITLES_AR[stageName]}) إلى: ${nextStatus === 'completed' ? 'مكتملة' : 'قيد التنفيذ'}.`);
    setIsProcessing(false);
    setBusy(false);
  };

  const handleSkipStage = async (stageName: string) => {
    const reason = window.prompt(`سبب تخطي مرحلة (${STAGE_TITLES_AR[stageName]}):`, 'موديل بدون كبسول / أزرار');
    if (!reason || !reason.trim()) return;
    setIsProcessing(true);
    setBusy(true);
    setStatus(null);
    try {
      await skipProductionStage(order.id, stageName, reason.trim());
      await refreshOrder(`تم تخطي مرحلة (${STAGE_TITLES_AR[stageName]}) بنجاح.`);
    } catch (err: unknown) {
      reportFailure(err, `تعذر تخطي مرحلة (${STAGE_TITLES_AR[stageName]}).`);
    } finally {
      setIsProcessing(false);
      setBusy(false);
    }
  };

  const handleAdjustDuration = async (stageName: string, currentMins: number) => {
    const input = window.prompt(`تعديل المدة المعيارية المتوقعة لمرحلة (${STAGE_TITLES_AR[stageName]}) بالدقائق:`, String(currentMins));
    if (input === null) return;
    const mins = Number(input);
    if (isNaN(mins) || mins < 0) {
      setStatus({ type: 'error', text: 'يرجى إدخال عدد صحيح موجب من الدقائق.' });
      return;
    }
    setIsProcessing(true);
    setBusy(true);
    setStatus(null);
    try {
      await adjustStageDuration(order.id, stageName, mins);
      await refreshOrder(`تم تحديث المدة المتوقعة لمرحلة (${STAGE_TITLES_AR[stageName]}) إلى ${mins} دقيقة.`);
    } catch (err: unknown) {
      reportFailure(err, `تعذر تعديل مدة مرحلة (${STAGE_TITLES_AR[stageName]}).`);
    } finally {
      setIsProcessing(false);
      setBusy(false);
    }
  };

  const handleRollbackStage = async (stageName: string) => {
    const reason = (rollbackReasons[stageName] || '').trim();
    if (reason.length < 3) {
      setStatus({ type: 'error', text: 'اكتب سبب التراجع (٣ أحرف على الأقل).' });
      return;
    }
    setIsProcessing(true);
    setBusy(true);
    setStatus(null);
    try {
      const rollbackResult = await rollbackStageApi(order.id, stageName, reason);
      onOrderUpdated(rollbackResult);
      setRollbackReasons((previous) => ({ ...previous, [stageName]: '' }));
      setStatus({ type: 'success', text: 'أُعيد فتح المرحلة، وسُجل التراجع في سجل المراحل.' });
    } catch (err: unknown) {
      reportFailure(err, 'تعذر التراجع عن المرحلة. قد تكون مرحلة لاحقة قد بدأت؛ حدّث الأمر وحاول مجدداً.');
    } finally {
      setIsProcessing(false);
      setBusy(false);
    }
  };

  const stageLock = stageLockReason(order.status);
  const rollbackAllowedByStatus = ROLLBACK_STATUSES.includes(order.status);
  const completedCount = order.stage_events.filter((s) => s.status === 'completed' || s.is_skipped).length;
  const inProgressEvent = order.stage_events.find((s) => s.status === 'in_progress');
  const bottlenecksCount = order.stage_events.filter((s) => s.is_bottleneck || s.delay_reason).length;

  return (
    <div className="tab-pane" dir="rtl">
      {/* ملخص تقدم مراحل التصنيع */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: '12px',
          marginBottom: '16px',
        }}
      >
        <div style={{ padding: '12px 14px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
          <div style={{ fontSize: '0.78rem', color: '#64748b' }}>إنجاز المراحل</div>
          <div style={{ fontSize: '1.25rem', fontWeight: 700, color: '#0f172a' }}>
            {completedCount} من 5 مراحل
          </div>
          <div style={{ fontSize: '0.75rem', color: completedCount === 5 ? '#166534' : '#64748b' }}>
            {completedCount === 5 ? '✓ كافة المراحل مكتملة' : `${5 - completedCount} مراحل متبقية`}
          </div>
        </div>

        <div style={{ padding: '12px 14px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
          <div style={{ fontSize: '0.78rem', color: '#64748b' }}>المرحلة قيد التشغيل</div>
          <div style={{ fontSize: '1.05rem', fontWeight: 700, color: inProgressEvent ? '#0d9488' : '#64748b' }}>
            {inProgressEvent ? STAGE_TITLES_AR[inProgressEvent.stage_name] : (completedCount === 5 ? 'اكتملت المراحل' : 'لا توجد مرحلة جارية')}
          </div>
          <div style={{ fontSize: '0.75rem', color: inProgressEvent ? '#0d9488' : '#94a3b8' }}>
            {inProgressEvent?.started_at ? `بدأت: ${new Date(inProgressEvent.started_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}` : ''}
          </div>
        </div>

        <div style={{ padding: '12px 14px', background: bottlenecksCount > 0 ? '#fef2f2' : '#f8fafc', borderRadius: '8px', border: bottlenecksCount > 0 ? '1px solid #fecaca' : '1px solid #e2e8f0' }}>
          <div style={{ fontSize: '0.78rem', color: bottlenecksCount > 0 ? '#b91c1c' : '#64748b' }}>الاختناقات والتأخيرات</div>
          <div style={{ fontSize: '1.25rem', fontWeight: 700, color: bottlenecksCount > 0 ? '#dc2626' : '#166534' }}>
            {bottlenecksCount > 0 ? `${bottlenecksCount} اختناق مسجل` : 'لا توجد اختناقات'}
          </div>
          <div style={{ fontSize: '0.75rem', color: bottlenecksCount > 0 ? '#b91c1c' : '#166534' }}>
            {bottlenecksCount > 0 ? 'يتطلب متابعة أسباب التأخير' : 'سير العمل منتظم'}
          </div>
        </div>

        <div style={{ padding: '12px 14px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
          <div style={{ fontSize: '0.78rem', color: '#64748b' }}>سجل عيوب الجودة</div>
          <div style={{ fontSize: '1.25rem', fontWeight: 700, color: defects.length > 0 ? '#d97706' : '#0f172a' }}>
            {defects.length} عيوب مسجلة
          </div>
          <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
            {defects.filter((d) => d.status === 'reported').length > 0 ? `${defects.filter((d) => d.status === 'reported').length} عيب قيد المعالجة` : 'كافة العيوب مسجلة ومتابعة'}
          </div>
        </div>
      </div>

      <div className="provisional-hint">
        📌 <strong>قاعدة التتابع الإلزامي:</strong> لا يُسمح بتخطي المراحل أو بدء مرحلة قبل اكتمال سابقتها. تحديث المراحل متاح فقط والأمر "قيد الإنتاج".
      </div>
      {stageLock && canManageStages && (
        <p className="form-hint" role="note" style={{ color: '#92400e' }}>{stageLock}</p>
      )}

      <div className="stages-flow-list">
        {STAGE_SEQUENCE.map((stageKey, idx) => {
          const event = order.stage_events.find((s) => s.stage_name === stageKey);
          const stageStatus = event?.is_skipped ? 'skipped' : (event?.status || 'not_started');
          const isPrevCompleted = idx === 0 || STAGE_SEQUENCE.slice(0, idx).every((k) => {
            const ev = order.stage_events.find((s) => s.stage_name === k);
            return ev?.is_skipped || ev?.status === 'completed';
          });
          const canRollback = rollbackAllowedByStatus && stageStatus === 'completed' && STAGE_SEQUENCE.slice(idx + 1).every((laterKey) => {
            const ev = order.stage_events.find((stage) => stage.stage_name === laterKey);
            return !ev || ev.is_skipped || ev.status === 'not_started';
          });

          return (
            <div
              key={stageKey}
              className={`stage-card stage-card--${stageStatus} ${
                !isPrevCompleted && !event?.is_skipped ? 'stage-card--locked' : ''
              }`}
            >
              <div className="stage-card__number">{idx + 1}</div>
              <div className="stage-card__info">
                <div className="stage-card__head">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <h3 className="stage-card__title">
                      {STAGE_TITLES_AR[stageKey]}
                    </h3>
                    {event?.is_bottleneck && (
                      <span className="badge badge--danger" style={{ fontSize: '0.75rem' }} title="استغرقت وقتاً أطول من المتوقع">
                        ⚠️ اختناق تشغيلي
                      </span>
                    )}
                  </div>
                  <span className={`stage-badge stage-badge--${stageStatus}`}>
                    {stageStatus === 'not_started' && 'لم تبدأ بعد'}
                    {stageStatus === 'in_progress' && 'قيد التنفيذ الآن'}
                    {stageStatus === 'completed' && '✓ مكتملة'}
                    {stageStatus === 'skipped' && 'تم تخطيها'}
                  </span>
                </div>

                {/* مؤشرات التوقيت واللقطة المجمدة (TIME-DEC-01 & TIME-DEC-02) */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', margin: '6px 0', fontSize: '0.825rem', color: '#475569', background: '#f8fafc', padding: '6px 10px', borderRadius: '6px' }}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <span>المدة المتوقعة (لقطة معتمدة):</span>
                    <strong style={{ color: '#0f172a' }}>{event?.expected_duration_minutes || 0} دقيقة</strong>
                    {canManageStages && stageStatus !== 'completed' && !event?.is_skipped && (
                      <button
                        type="button"
                        onClick={() => void handleAdjustDuration(stageKey, event?.expected_duration_minutes || 0)}
                        style={{ background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', fontSize: '0.75rem', padding: '0 2px', textDecoration: 'underline' }}
                        title="تعديل المدة المعيارية المحفوظة لهذا الأمر"
                      >
                        ✏️ تعديل
                      </button>
                    )}
                  </div>

                  {stageStatus === 'completed' && (
                    <>
                      <div>
                        <span>زمن الوردية الفعلي: </span>
                        <strong style={{ color: '#047857' }}>{event?.working_minutes || 0} دقيقة</strong>
                        <span style={{ fontSize: '0.75rem', marginRight: '4px', color: event?.is_working_time_provisional ? '#d97706' : '#059669' }}>
                          ({event?.is_working_time_provisional ? 'تقديري' : 'معتمد'})
                        </span>
                      </div>
                      <div>
                        <span>الزمن التقويمي الكلي: </span>
                        <strong style={{ color: '#64748b' }}>{event?.elapsed_minutes || 0} دقيقة</strong>
                      </div>
                    </>
                  )}

                  {event?.is_skipped && (
                    <div style={{ color: '#64748b' }}>
                      <span>سبب التخطي: </span>
                      <strong style={{ color: '#475569' }}>{event.skip_reason}</strong>
                    </div>
                  )}
                </div>

                <div className="stage-card__meta">
                  <span>المسؤول: {event ? userLabel(event.actor_id || event.actor_name, user?.id) : 'النظام'}</span>
                  {event?.timestamp && (
                    <span>التحديث: {new Date(event.timestamp).toLocaleTimeString('ar-EG')}</span>
                  )}
                  {event?.notes && <span className="stage-note">({event.notes})</span>}
                  {event?.delay_reason && (
                    <span style={{ color: '#dc2626', fontWeight: 500 }}>
                      · سبب التأخير: {DELAY_REASONS_AR[event.delay_reason] || event.delay_reason}
                    </span>
                  )}
                </div>

                {(order.stage_history || []).filter((history) => history.stage_name === stageKey).map((history) => (
                  <div className="stage-history-entry" key={history.id}>
                    <strong>تغيير موثق:</strong> {STAGE_STATUS_AR[history.from_status] || history.from_status} ← {STAGE_STATUS_AR[history.to_status] || history.to_status} · {userLabel(history.actor_id || history.actor_name, user?.id)} · {new Date(history.timestamp).toLocaleString('ar-EG')}
                    {history.previous_notes && <span>الملاحظة السابقة: {history.previous_notes}</span>}
                    <span>السبب: {history.reason}</span>
                  </div>
                ))}

                {/* حقول سبب التأخير وملاحظات العمل أثناء التشغيل (TIME-DEC-04) */}
                {stageStatus === 'in_progress' && canManageStages && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px', margin: '8px 0' }}>
                    <label style={{ fontSize: '0.8rem' }}>
                      <span style={{ display: 'block', marginBottom: '2px', color: '#475569' }}>سبب التأخير الفني (إن وجد)</span>
                      <select
                        className="form-input"
                        style={{ fontSize: '0.825rem', padding: '4px 8px' }}
                        value={stageDelayReasons[stageKey] || ''}
                        onChange={(e) => setStageDelayReasons((prev) => ({ ...prev, [stageKey]: e.target.value }))}
                      >
                        <option value="">بدون تأخير استثنائي</option>
                        {Object.entries(DELAY_REASONS_AR).map(([code, name]) => (
                          <option key={code} value={code}>{name}</option>
                        ))}
                      </select>
                    </label>
                    <label style={{ fontSize: '0.8rem' }}>
                      <span style={{ display: 'block', marginBottom: '2px', color: '#475569' }}>ملاحظات التأخير الفني</span>
                      <input
                        type="text"
                        className="form-input"
                        style={{ fontSize: '0.825rem', padding: '4px 8px' }}
                        value={stageDelayNotes[stageKey] || ''}
                        onChange={(e) => setStageDelayNotes((prev) => ({ ...prev, [stageKey]: e.target.value }))}
                        placeholder="تفاصيل العطل أو الصيانة"
                      />
                    </label>
                  </div>
                )}

                {stageStatus !== 'completed' && stageStatus !== 'skipped' && canManageStages && !stageLock && (
                  <label className="stage-detail-input">
                    <span>تفاصيل المرحلة / ملاحظات</span>
                    <textarea
                      value={stageNotes[stageKey] || ''}
                      onChange={(e) => setStageNotes((previous) => ({ ...previous, [stageKey]: e.target.value }))}
                      placeholder="مثال: تفاصيل العمل أو ملاحظة تحتاج المتابعة"
                      rows={2}
                    />
                  </label>
                )}
              </div>

              <div className="stage-card__actions">
                {canManageStages ? (
                  <>
                    {stageStatus === 'not_started' && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        <button
                          className="btn btn--sm btn--secondary"
                          onClick={() => void handleUpdateStage(stageKey, 'in_progress')}
                          disabled={Boolean(stageLock) || !isPrevCompleted || isProcessing}
                          title={
                            stageLock
                              ? stageLock
                              : !isPrevCompleted
                              ? 'يجب إكمال المرحلة السابقة أولاً'
                              : 'بدء تشغيل المرحلة'
                          }
                        >
                          بدء المرحلة ▶
                        </button>
                        <button
                          type="button"
                          className="btn btn--sm btn--outline"
                          style={{ fontSize: '0.75rem', color: '#64748b' }}
                          onClick={() => void handleSkipStage(stageKey)}
                          disabled={Boolean(stageLock) || isProcessing}
                          title="تخطي المرحلة للموديلات التي لا تتطلبها (TIME-DEC-03)"
                        >
                          تخطي (غير مطلوبة)
                        </button>
                      </div>
                    )}

                    {stageStatus === 'in_progress' && (
                      <button
                        className="btn btn--sm btn--primary"
                        onClick={() => void handleUpdateStage(stageKey, 'completed')}
                        disabled={Boolean(stageLock) || isProcessing}
                        title={stageLock || 'إكمال المرحلة'}
                      >
                        ✓ إكمال المرحلة
                      </button>
                    )}

                    {stageStatus === 'completed' && (
                      <>
                        <span className="stage-done-tag">تم الإنجاز</span>
                        {canRollback && (
                          <div className="stage-rollback-control">
                            <label>
                              <span>سبب إعادة فتح المرحلة *</span>
                              <input
                                value={rollbackReasons[stageKey] || ''}
                                onChange={(e) => setRollbackReasons((previous) => ({ ...previous, [stageKey]: e.target.value }))}
                                placeholder="اكتب سبب التراجع"
                              />
                            </label>
                            <button className="material-remove-button" onClick={() => void handleRollbackStage(stageKey)} disabled={isProcessing}>
                              إعادة فتح المرحلة
                            </button>
                          </div>
                        )}
                      </>
                    )}

                    {stageStatus === 'skipped' && (
                      <span className="badge badge--secondary">تم التخطي</span>
                    )}
                  </>
                ) : (
                  <span className="stage-badge stage-badge--read-only">
                    {stageStatus === 'completed' ? 'تم الإنجاز' : stageStatus === 'in_progress' ? 'قيد العمل' : stageStatus === 'skipped' ? 'تم التخطي' : 'معلق'}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* العيوب والإصلاحات (كانت تبويباً مستقلاً في الـModal القديم) */}
      <section aria-labelledby="order-defects-title" style={{ marginTop: '24px' }}>
        <h3 id="order-defects-title" style={{ fontSize: '1.05rem', fontWeight: 600 }}>العيوب والإصلاحات</h3>
        {canReportDefects ? (
          <form className="form-grid" onSubmit={(event) => void handleReportDefect(event)}>
            <label>المرحلة<select value={defectForm.stage_name} onChange={(e) => setDefectForm({ ...defectForm, stage_name: e.target.value })}>{STAGE_SEQUENCE.map((key) => <option key={key} value={key}>{STAGE_TITLES_AR[key]}</option>)}</select></label>
            <label>الكمية المتأثرة<input required type="number" min="0.001" step="0.001" value={defectForm.affected_quantity} onChange={(e) => setDefectForm({ ...defectForm, affected_quantity: e.target.value })} /></label>
            <label>المسؤول أو القسم<input required value={defectForm.responsible} onChange={(e) => setDefectForm({ ...defectForm, responsible: e.target.value })} /></label>
            <label>وصف العيب<input required value={defectForm.description} onChange={(e) => setDefectForm({ ...defectForm, description: e.target.value })} /></label>
            <label>الإجراء المطلوب<input required value={defectForm.repair_action} onChange={(e) => setDefectForm({ ...defectForm, repair_action: e.target.value })} /></label>
            <label>تكلفة الإصلاح (وصف فقط)<input value={defectForm.repair_cost_description} onChange={(e) => setDefectForm({ ...defectForm, repair_cost_description: e.target.value })} /></label>
            <button className="btn btn--primary" disabled={isProcessing}>تسجيل العيب</button>
          </form>
        ) : (
          <p className="provisional-hint">تسجيل العيوب من مهام مسؤول الإنتاج.</p>
        )}
        {defectsError && (
          <div className="modal-alert modal-alert--warning" style={{ margin: '8px 0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{defectsError}</span>
            <button
              type="button"
              className="btn btn--sm btn--secondary"
              onClick={() => void loadDefects()}
              disabled={defectsLoading}
            >
              {defectsLoading ? 'جاري التحميل...' : 'إعادة المحاولة'}
            </button>
          </div>
        )}
        <div className="defect-list">
          {defects.map((defect) => <article className="action-box" key={defect.id}>
            <strong>{defect.defect_number} · {STAGE_TITLES_AR[defect.stage_name]}</strong>
            <p>{defect.description} · الكمية: {defect.affected_quantity} · المسؤول: {defect.responsible}</p>
            <p>الإصلاح: {defect.repair_action}{defect.repair_cost_description ? ` · التكلفة الوصفية: ${defect.repair_cost_description}` : ''}</p>
            <select
              aria-label="حالة الإصلاح"
              value={defect.status}
              disabled={!canReportDefects}
              onChange={async (e) => {
                try {
                  const updated = await updateOrderDefect(order.id, defect.id, { status: e.target.value as ProductionDefect['status'] });
                  setDefects((items) => items.map((item) => item.id === updated.id ? updated : item));
                } catch (err: unknown) {
                  reportFailure(err, 'تعذر تحديث حالة الإصلاح.');
                }
              }}
            >
              <option value="reported">مسجل</option><option value="repair_in_progress">قيد الإصلاح</option><option value="repaired">تم الإصلاح</option><option value="closed">مغلق</option>
            </select>
          </article>)}
          {defects.length === 0 && <p>لا توجد عيوب مسجلة لهذا الأمر.</p>}
        </div>
      </section>
    </div>
  );
};
