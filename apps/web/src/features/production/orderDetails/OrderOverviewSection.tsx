/**
 * تبويب «نظرة عامة» في مساحة عمل أمر التشغيل (Phase 4.5 / T7 — Executive Overview)
 * ─────────────────────────────────────────────────────────────────────────────
 * مركز القيادة التشغيلي الموحد لأمر التشغيل:
 * 1. لوحة الإجراء التالي وحواجز التشغيل (Next Action & Blockers Panel) وفقاً لقواعد العمل الفعلية.
 * 2. مؤشرات الأداء والكميات (المستهدف، المستلم، المتبقي، نسبة الإنجاز).
 * 3. تمييز نمط التصنيع التشغيلي (داخلي لحساب المصنع مقابل تشغيل للغير CMT بأمانات العميل).
 * 4. شريط خطوات دورة حياة أمر التشغيل (OrderProgress).
 * 5. تخصيصات طلبات العملاء للأوامر المجمعة (Demands Allocation - T3).
 * 6. جدول مقاسات وموديلات الدفعة مع مواصفات الأقمشة.
 * 7. لقطة مستلزمات التصنيع المحفوظة وقت إنشاء الأمر (BOM Snapshot).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import React from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import { OrderProgress } from '../OrderProgress';
import { nextStep, ORDER_STATUS_LABEL } from '../orderWorkflow';
import { fmtQty, cleanVariant, ORDER_STATUS_AR, type SectionContext } from './constants';
import type {
  ProductionOrderItem,
  ProductionOrderDemandRead,
  TransferDiscrepancyClaimRead,
  OrderWipSummary,
} from '../productionApi';
import type { PageTab } from '../OrderDetailsPage';

/** مستلزمات التصنيع كما حُفظت في الأمر وقت إنشائه (لا تتأثر بتعديل مستلزمات الموديل لاحقاً) */
function OrderBomSnapshot({ order, orderItems }: { order: SectionContext['order']; orderItems: ProductionOrderItem[] }) {
  const withBom = orderItems.filter((it) => (it.bom_lines ?? []).length > 0);
  const withoutBom = orderItems.filter((it) => (it.bom_lines ?? []).length === 0);

  const totals = new Map<string, { item_id: string; item_name: string; unit_name: string; required: number }>();
  for (const it of withBom) {
    for (const b of it.bom_lines ?? []) {
      const key = `${b.item_id}|${b.unit_name}`;
      const row = totals.get(key) ?? { item_id: b.item_id, item_name: b.item_name, unit_name: b.unit_name, required: 0 };
      row.required += Number(b.total_quantity || 0);
      totals.set(key, row);
    }
  }
  const materialByItem = new Map(order.materials.map((m) => [m.item_id, m]));
  const bomIds = new Set([...totals.values()].map((t) => t.item_id));
  const dispatchStarted = order.status !== 'draft';

  return (
    <section className="order-bom" aria-labelledby="order-bom-title" style={{ marginTop: '24px' }}>
      <h3 id="order-bom-title" style={{ fontSize: '1.05rem', fontWeight: 600 }}>مستلزمات التصنيع المحفوظة في الأمر</h3>
      <p className="form-hint">نسخة ثابتة من مستلزمات كل مقاس وقت إنشاء الأمر؛ تعديل مستلزمات الموديل لاحقاً لا يغيّرها.</p>

      {withBom.length === 0 ? (
        <p className="notice notice--warning">
          هذا الأمر أُنشئ بخامات مُدخلة يدوياً أو قبل تفعيل مستلزمات المقاسات، فلا توجد نسخة مستلزمات محفوظة له. الخامات المخططة والمصروفة في تبويب «الخامات».
        </p>
      ) : (
        <>
          {withBom.map((it) => (
            <article key={it.id} className="order-bom__line">
              <header>
                <strong>{it.product_name_ar} — {cleanVariant(it.variant_info, it.season)}</strong>
                <span>
                  <span className="status-badge status-badge--done">{fmtQty(it.target_quantity)} قطعة</span>{' '}
                  {it.bom_version_number ? <span className="status-badge status-badge--action">إصدار المستلزمات {it.bom_version_number}</span> : <span className="status-badge status-badge--muted">رقم الإصدار غير متاح</span>}
                </span>
              </header>
              <div className="payroll-table-wrap">
                <table className="md-table order-bom__table">
                  <thead><tr><th>الصنف</th><th>الوحدة</th><th>الكمية للقطعة</th><th>إجمالي السطر</th></tr></thead>
                  <tbody>
                    {(it.bom_lines ?? []).map((b) => (
                      <tr key={b.item_id}>
                        <td><strong>{b.item_name}</strong></td>
                        <td data-label="الوحدة">{b.unit_name || '—'}</td>
                        <td data-label="الكمية للقطعة">{fmtQty(b.quantity_per_piece)}</td>
                        <td data-label="إجمالي السطر"><strong>{fmtQty(b.total_quantity)}</strong></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          ))}

          {withoutBom.length > 0 && (
            <p className="form-hint">
              {withoutBom.length} سطر بدون مستلزمات محفوظة (أُنشئ بخامات يدوية): {withoutBom.map((it) => `${it.product_name_ar} ${cleanVariant(it.variant_info, it.season)}`).join('، ')}.
            </p>
          )}

          <h4 style={{ margin: '16px 0 6px', fontWeight: 600 }}>إجمالي احتياجات الأمر (مجمعة حسب الصنف)</h4>
          <div className="payroll-table-wrap">
            <table className="md-table order-bom__table">
              <thead>
                <tr><th>الصنف</th><th>الوحدة</th><th>المطلوب حسب المستلزمات</th><th>المخطط في الأمر</th><th>المنصرف</th><th>المستلم بالورشة</th></tr>
              </thead>
              <tbody>
                {[...totals.values()].sort((a, b) => a.item_name.localeCompare(b.item_name, 'ar')).map((row) => {
                  const m = materialByItem.get(row.item_id);
                  return (
                    <tr key={`${row.item_id}|${row.unit_name}`}>
                      <td><strong>{row.item_name}</strong></td>
                      <td data-label="الوحدة">{row.unit_name || '—'}</td>
                      <td data-label="المطلوب حسب المستلزمات"><strong>{fmtQty(row.required)}</strong></td>
                      <td data-label="المخطط في الأمر">{m ? fmtQty(m.planned_quantity) : <small className="form-hint">غير مسجل في خامات الأمر</small>}</td>
                      <td data-label="المنصرف">{!m ? '—' : dispatchStarted ? fmtQty(m.dispatched_quantity) : <small className="form-hint">لم يُصرف بعد</small>}</td>
                      <td data-label="المستلم بالورشة">{!m ? '—' : ['draft', 'materials_dispatched'].includes(order.status) ? <small className="form-hint">لم يُستلم بعد</small> : fmtQty(m.received_quantity)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {order.materials.some((m) => !bomIds.has(m.item_id)) && (
            <p className="form-hint">توجد خامات أُضيفت يدوياً على الأمر خارج المستلزمات؛ تظهر بعلامة «يدوي» في تبويب «الخامات».</p>
          )}
        </>
      )}
    </section>
  );
}

export interface OrderOverviewSectionProps {
  ctx: SectionContext;
  orderItems: ProductionOrderItem[];
  /** تخصيصات طلبات العملاء للأمر (fetchOrderDemands) */
  demands: ProductionOrderDemandRead[];
  /** مطالبات فروقات استلام الخامات (T2) */
  claims?: TransferDiscrepancyClaimRead[];
  /** ملخص خامات الورشة وحالة الإغلاق */
  wipSummary?: OrderWipSummary | null;
  /** انتقال شريط الخطوات إلى تبويب الصفحة المناسب */
  onGoToPageTab: (pageTab: PageTab) => void;
  /** فتح نافذة تدقيق عجز الخامات وتوليد أوامر الشراء (T5) */
  onOpenProcurementModal?: () => void;
}

const fmtPct = (n: number): string => `${Number(n).toLocaleString('ar-EG', { maximumFractionDigits: 1 })}%`;

export const OrderOverviewSection: React.FC<OrderOverviewSectionProps> = ({
  ctx,
  orderItems,
  demands,
  claims = [],
  wipSummary,
  onGoToPageTab,
  onOpenProcurementModal,
}) => {
  const { order } = ctx;
  const { hasPermission, user } = useAuth();
  const isCmt = order.manufacturing_type === 'external';

  // 1. حسابات الكميات والإنجاز
  const targetQty = Number(order.target_quantity || 0);
  const totalReceived = orderItems.reduce((sum, it) => sum + (it.received_quantity ?? 0), 0);
  const totalRejected = orderItems.reduce((sum, it) => sum + (it.rejected_quantity ?? 0), 0);
  const remainingQty = Math.max(0, targetQty - totalReceived);
  const progressPct = targetQty > 0 ? Math.min(100, Math.round((totalReceived / targetQty) * 100)) : 0;

  // 2. تحليل المراحل والاختناقات
  const completedStagesCount = order.stage_events.filter((s) => s.status === 'completed').length;
  const inProgressStage = order.stage_events.find((s) => s.status === 'in_progress');
  const delayedStage = order.stage_events.find((s) => s.is_bottleneck || s.delay_reason);

  // 3. تحليل الفروقات والمطالبات والهالك
  const openClaims = claims.filter((c) => c.status === 'open');
  const hasExcessWaste = Number(order.excess_waste_qty || 0) > 0 && order.excess_waste_settlement_status === 'pending_review';
  const pendingReturns = (order.returns_awaiting_receipt ?? 0) + (order.returns_awaiting_resolution ?? 0);

  // 4. استنتاج الخطوة التشغيلية وحواجز التنفيذ (Next Action & Blockers)
  const step = nextStep(order, hasPermission, user?.id);

  return (
    <div className="tab-pane" dir="rtl">
      {/* ─── 1. لوحة التوجيه التشغيلي والإجراء التالي (Hero Next Action) ──── */}
      <section
        className="action-box action-box--highlight"
        style={{
          padding: '16px 20px',
          marginBottom: '20px',
          border: '1px solid var(--border-subtle, #cbd5e1)',
          background: 'linear-gradient(to left, #ffffff, #f8fafc)',
          borderRadius: '10px',
          boxShadow: '0 2px 4px rgba(0,0,0,0.03)',
        }}
        aria-label="لوحة التوجيه التشغيلي"
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '14px' }}>
          <div style={{ flex: '1 1 360px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
              <span style={{ fontSize: '1.2rem' }}>🧭</span>
              <strong style={{ fontSize: '1.05rem', color: '#0f172a' }}>الإجراء التشغيلي الموصى به حالياً:</strong>
              <span className={`status-pill status-pill--${order.status}`}>
                {ORDER_STATUS_LABEL[order.status] || ORDER_STATUS_AR[order.status] || order.status}
              </span>
            </div>

            <p style={{ margin: '4px 0 8px', color: '#334155', fontSize: '0.92rem', lineHeight: '1.5' }}>
              {step ? (
                <>
                  الخطوة التالية هي <strong>«{step.label}»</strong> (المسؤول: {step.role}).
                  {step.isMine ? (
                    <span style={{ color: '#047857', fontWeight: 600 }}> — هذه الخطوة تقع ضمن اختصاصك المباشر.</span>
                  ) : step.blockedReason ? (
                    <span style={{ color: '#b91c1c' }}> — {step.blockedReason}</span>
                  ) : (
                    <span style={{ color: '#64748b' }}> — بانتظار استكمالها من الفريق المعني.</span>
                  )}
                </>
              ) : order.status === 'closed' ? (
                'أمر التشغيل مغلق ومسوى نهائياً في النظام.'
              ) : (
                'تابع مراحل تنفيذ أمر التشغيل واستيفاء الحصص والمطالبات.'
              )}
            </p>

            {/* تنبيهات الحواجز التشغيلية النشطة */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '10px' }}>
              {openClaims.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', color: '#b91c1c' }}>
                  <span>⚠️</span>
                  <span>توجد <strong>{openClaims.length} مطالبة عجز استلام خامات</strong> بانتظار قرار الحسم من أمين المخزن أو الإدارة.</span>
                  <button
                    type="button"
                    className="btn btn--sm btn--secondary"
                    onClick={() => onGoToPageTab('materials')}
                    style={{ padding: '2px 8px', fontSize: '0.78rem' }}
                  >
                    عرض المطالبات ←
                  </button>
                </div>
              )}

              {delayedStage && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', color: '#c2410c' }}>
                  <span>⏳</span>
                  <span>اختناق أو تأخير مسجل في مرحلة <strong>«{delayedStage.stage_name}»</strong>.</span>
                  <button
                    type="button"
                    className="btn btn--sm btn--secondary"
                    onClick={() => onGoToPageTab('execution')}
                    style={{ padding: '2px 8px', fontSize: '0.78rem' }}
                  >
                    متابعة المرحلة ←
                  </button>
                </div>
              )}

              {hasExcessWaste && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', color: '#92400e' }}>
                  <span>⚖️</span>
                  <span>انحراف الهالك تجاوز سقف الـ 1.5% بمقدار <strong>{Number(order.excess_waste_qty).toFixed(2)}</strong> (بانتظار المراجعة الإدارية).</span>
                  <button
                    type="button"
                    className="btn btn--sm btn--secondary"
                    onClick={() => onGoToPageTab('costing')}
                    style={{ padding: '2px 8px', fontSize: '0.78rem' }}
                  >
                    بطاقة التكلفة ←
                  </button>
                </div>
              )}

              {pendingReturns > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem', color: '#0369a1' }}>
                  <span>🔄</span>
                  <span>يوجد <strong>{pendingReturns} مرتجع ورشة</strong> بانتظار الاستلام أو التسوية الإدارية.</span>
                  <button
                    type="button"
                    className="btn btn--sm btn--secondary"
                    onClick={() => onGoToPageTab('reconcile')}
                    style={{ padding: '2px 8px', fontSize: '0.78rem' }}
                  >
                    تسوية المرتجعات ←
                  </button>
                </div>
              )}

              {wipSummary && wipSummary.blocking_reasons.length > 0 && order.status !== 'closed' && (
                <div style={{ fontSize: '0.82rem', color: '#64748b', marginTop: '4px' }}>
                  🔒 شروط تمنع الإغلاق النهائي حالياً: {wipSummary.blocking_reasons.join(' · ')}
                </div>
              )}
            </div>
          </div>

          {/* أزرار الإجراء السريع المباشر */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'stretch' }}>
            {step && step.isMine && (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  if (step.tab === 'materials') onGoToPageTab('materials');
                  else if (step.tab === 'stages' || step.tab === 'defects') onGoToPageTab('execution');
                  else if (step.tab === 'fg_receipt') onGoToPageTab('finished');
                  else if (step.tab === 'wip') onGoToPageTab('reconcile');
                  else onGoToPageTab('overview');
                }}
                style={{ fontWeight: 600, padding: '8px 16px', fontSize: '0.95rem' }}
              >
                الانتقال إلى: {step.label} ←
              </button>
            )}

            {onOpenProcurementModal && (
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={onOpenProcurementModal}
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
                title="فحص عجز الخامات وتوليد أوامر الشراء"
              >
                <span>🛒</span> تدقيق عجز الخامات وتوليد الشراء
              </button>
            )}
          </div>
        </div>
      </section>

      {/* ─── 2. بطاقات المؤشرات التشغيلية الرئيسية (KPI Grid) ─────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '20px' }}>
        {/* المستهدف الإجمالي */}
        <div style={{ padding: '14px', background: '#fff', borderRadius: '8px', border: '1px solid #e2e8f0', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
          <div style={{ fontSize: '0.8rem', color: '#64748b' }}>🎯 الكمية المستهدفة للدفعة</div>
          <div style={{ fontSize: '1.35rem', fontWeight: 700, color: '#0f172a', margin: '4px 0' }}>
            {targetQty.toLocaleString('ar-EG')} <small style={{ fontSize: '0.85rem' }}>قطعة</small>
          </div>
          <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
            {orderItems.length} مقاسات / موديلات مسجلة
          </div>
        </div>

        {/* المستلم سليم في مخزن التام */}
        <div style={{ padding: '14px', background: '#f0fdf4', borderRadius: '8px', border: '1px solid #bbf7d0', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
          <div style={{ fontSize: '0.8rem', color: '#166534' }}>📦 المستلم سليم (مخزن التام)</div>
          <div style={{ fontSize: '1.35rem', fontWeight: 700, color: '#15803d', margin: '4px 0' }}>
            {totalReceived.toLocaleString('ar-EG')} <small style={{ fontSize: '0.85rem' }}>قطعة</small>
          </div>
          <div style={{ fontSize: '0.75rem', color: '#166534' }}>
            نسبة الإنجاز: {progressPct}%
          </div>
        </div>

        {/* المتبقي قيد التشغيل في الورشة */}
        <div style={{ padding: '14px', background: '#fff', borderRadius: '8px', border: '1px solid #e2e8f0', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
          <div style={{ fontSize: '0.8rem', color: '#64748b' }}>⏳ المتبقي قيد التشغيل (WIP)</div>
          <div style={{ fontSize: '1.35rem', fontWeight: 700, color: remainingQty > 0 ? '#d97706' : '#64748b', margin: '4px 0' }}>
            {remainingQty.toLocaleString('ar-EG')} <small style={{ fontSize: '0.85rem' }}>قطعة</small>
          </div>
          <div style={{ fontSize: '0.75rem', color: totalRejected > 0 ? '#b91c1c' : '#64748b' }}>
            {totalRejected > 0 ? `مرفوض: ${totalRejected} قطعة · ` : ''}المراحل المنجزة: {completedStagesCount} من 5 {inProgressStage ? `(قيد العمل: ${inProgressStage.stage_name})` : ''}
          </div>
        </div>

        {/* نمط التصنيع والمسؤولية */}
        <div style={{ padding: '14px', background: isCmt ? '#fffbeb' : '#f8fafc', borderRadius: '8px', border: isCmt ? '1px solid #fde68a' : '1px solid #e2e8f0', boxShadow: '0 1px 2px rgba(0,0,0,0.03)' }}>
          <div style={{ fontSize: '0.8rem', color: isCmt ? '#92400e' : '#475569' }}>
            {isCmt ? '🧵 نمط تشغيل للغير (CMT)' : '🏭 نمط تصنيع داخلي'}
          </div>
          <div style={{ fontSize: '1.05rem', fontWeight: 700, color: isCmt ? '#92400e' : '#0f172a', margin: '4px 0' }}>
            {isCmt ? (order.customer_name || 'عميل محدد') : 'براند المصنع'}
          </div>
          <div style={{ fontSize: '0.75rem', color: isCmt ? '#a16207' : '#64748b' }}>
            {isCmt ? `سقف الهالك: ${order.allowed_waste_pct ?? '1.5'}% أمانة` : `خط التشغيل: ${order.assigned_to || 'الرئيسي'}`}
          </div>
        </div>
      </div>

      {/* ─── 3. شريط تقدم مراحل دورة الأمر (OrderProgress) ─────────────── */}
      <div style={{ background: '#fff', borderRadius: '8px', border: '1px solid #e2e8f0', padding: '4px', marginBottom: '20px' }}>
        <OrderProgress
          order={order}
          hasPermission={hasPermission}
          userId={user?.id}
          onGoToStep={(tab) => {
            if (tab === 'stages' || tab === 'defects') onGoToPageTab('execution');
            else if (tab === 'fg_receipt') onGoToPageTab('finished');
            else if (tab === 'wip') onGoToPageTab('reconcile');
            else onGoToPageTab('materials');
          }}
        />
      </div>

      {/* ─── 4. تخصيصات طلبات العملاء للأوامر المجمعة (T3) ─────────────── */}
      {!isCmt && demands.length > 0 && (
        <section aria-labelledby="order-demands-title" style={{ background: '#fff', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0', marginBottom: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <div>
              <h3 id="order-demands-title" style={{ fontSize: '1.05rem', fontWeight: 600, margin: 0 }}>
                تخصيصات طلبات العملاء في هذا الأمر المجمع ({demands.length})
              </h3>
              <p style={{ color: '#64748b', fontSize: '0.85rem', margin: '2px 0 0' }}>
                أمر تشغيل مجمع يغطي طلبات عملاء متعددة؛ تُستوفى الحصص تلقائياً عند استلام المنتج التام.
              </p>
            </div>
            <button
              type="button"
              className="btn btn--sm btn--secondary"
              onClick={() => onGoToPageTab('finished')}
            >
              استيفاء الحصص ←
            </button>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="preview-table table--compact" aria-label="تخصيصات طلبات العملاء">
              <thead>
                <tr>
                  <th>العميل</th>
                  <th>رقم طلب العميل</th>
                  <th style={{ textAlign: 'right' }}>الكمية المخصصة</th>
                  <th style={{ textAlign: 'right' }}>المستوفى</th>
                  <th style={{ textAlign: 'right' }}>المتبقي</th>
                  <th style={{ textAlign: 'right' }}>نسبة الاستيفاء</th>
                </tr>
              </thead>
              <tbody>
                {demands.map((d) => (
                  <tr key={d.id}>
                    <td><strong>{d.customer_name}</strong></td>
                    <td><code>{d.customer_order_number}</code></td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtQty(d.allocated_quantity)}</td>
                    <td style={{ textAlign: 'right', color: '#166534' }}>{fmtQty(d.fulfilled_quantity)}</td>
                    <td style={{ textAlign: 'right' }}>{fmtQty(d.remaining_quantity)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <span className={`badge ${d.fulfillment_pct >= 100 ? 'badge--success' : 'badge--primary'}`}>
                        {fmtPct(d.fulfillment_pct)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ─── 5. جدول موديلات ومقاسات الدفعة ────────────────────────────── */}
      {orderItems.length > 0 && (
        <section style={{ background: '#fff', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0', marginBottom: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <div>
              <h3 style={{ fontSize: '1.05rem', fontWeight: 600, margin: 0 }}>
                أصناف وموديلات أمر التشغيل ({orderItems.length})
              </h3>
              <p style={{ color: '#64748b', fontSize: '0.85rem', margin: '2px 0 0' }}>
                المقاسات والمواصفات الفنية المعتمدة للقص والتشغيل في هذا الأمر.
              </p>
            </div>
            <button
              type="button"
              className="btn btn--sm btn--secondary"
              onClick={() => onGoToPageTab('finished')}
            >
              استلام المنتج التام ←
            </button>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <table className="preview-table table--compact" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>الموديل</th>
                  <th>المقاس / الموسم</th>
                  <th style={{ textAlign: 'right' }}>الكمية المستهدفة</th>
                  <th style={{ textAlign: 'right' }}>المستلم سليم</th>
                  <th style={{ textAlign: 'right' }}>المتبقي</th>
                  <th>نوع التشغيل</th>
                  <th>مواصفات القماش</th>
                  <th>ملاحظات</th>
                </tr>
              </thead>
              <tbody>
                {orderItems.map((it, idx) => {
                  const itRec = it.received_quantity ?? 0;
                  const itRem = Math.max(0, it.target_quantity - itRec);
                  return (
                    <tr key={it.id || idx}>
                      <td>{idx + 1}</td>
                      <td><strong>{it.product_name_ar}</strong></td>
                      <td>
                        <small>{(it.variant_info || it.season || '').replace(/summer/g, 'صيفي').replace(/autumn/g, 'خريفي').replace(/winter/g, 'شتوي')}</small>
                      </td>
                      <td style={{ textAlign: 'right', fontWeight: 700, color: 'var(--teal-accent, #0d9488)' }}>
                        {it.target_quantity} قطعة
                      </td>
                      <td style={{ textAlign: 'right', color: '#166534', fontWeight: 600 }}>{itRec}</td>
                      <td style={{ textAlign: 'right', color: itRem > 0 ? '#b45309' : '#64748b' }}>{itRem}</td>
                      <td>
                        {it.product_type === 'factory_brand' ? (
                          <span className="badge-tag">براند المصنع</span>
                        ) : (
                          <span className="badge-tag" style={{ background: '#fef3c7', color: '#92400e' }}>
                            تشغيل: {it.customer_name || 'عميل خارجي'}
                          </span>
                        )}
                      </td>
                      <td>
                        <small>{it.fabric_name} · {it.fabric_color} · {it.fabric_weight} · {it.fabric_area}</small>
                      </td>
                      <td><small>{it.notes || '—'}</small></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* لقطة مستلزمات التصنيع المحفوظة (BOM Snapshot) */}
          <OrderBomSnapshot order={order} orderItems={orderItems} />
        </section>
      )}
    </div>
  );
};
