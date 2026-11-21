/**
 * بطاقة التكلفة والربحية وقسم التكاليف والهالك (Phase 6 / T6 — Job Cost Sheet)
 * ─────────────────────────────────────────────────────────────────────────────
 * يوفر:
 * 1. فصلاً تشغيلياً ومالياً كاملاً بين التصنيع الداخلي وتشغيل للغير (CMT).
 * 2. عزل خامات العميل دفترياً بتكلفة صفرية (0.00 ج.م) مع الحفاظ الكامل على الرصيد الكمي.
 * 3. حجب الأسعار والتكاليف تلقائياً لأمين المخزن (Role-Based Price Masking).
 * 4. احتساب أجور العمالة (بالقطعة أو بالزمن) والتحميل غير المباشر بأسس متعددة.
 * 5. تحليل الهالك وسقف 1.5% المعتمد لـ CMT ومراجعة تسوية التجاوز (بدون غرامات آلية).
 * 6. احتساب إجمالي تكلفة الأمر وتكلفة القطعة والإيرادات وهوامش الربحية.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import React, { useState, useEffect, useCallback } from 'react';
import {
  calculateOrderCosts,
  logOrderMaterialConsumption,
  fetchOrderCostSheet,
  updateWasteSettlement,
  JobCostSheet,
} from '../productionApi';
import { type SectionContext } from './constants';

interface OrderCostsSectionProps {
  ctx: SectionContext;
}

export const OrderCostsSection: React.FC<OrderCostsSectionProps> = ({ ctx }) => {
  const { order, onOrderUpdated, setStatus, setBusy } = ctx;
  const isCmt = order.manufacturing_type === 'external';

  // حالة بطاقة التكلفة
  const [costSheet, setCostSheet] = useState<JobCostSheet | null>(null);
  const [sheetLoading, setSheetLoading] = useState<boolean>(true);
  const [sheetError, setSheetError] = useState<string | null>(null);

  // حالة معايير احتساب التكاليف
  const [isProcessing, setIsProcessing] = useState(false);
  const [costMethod, setCostMethod] = useState<'piece_based' | 'time_based'>(order.labor_costing_method || 'piece_based');
  const [costLaborRate, setCostLaborRate] = useState<string>(String(order.labor_rate ?? ''));
  const [costLaborHours, setCostLaborHours] = useState<string>(String(order.labor_hours ?? ''));
  const [costOverheadBasis, setCostOverheadBasis] = useState<string>(order.overhead_allocation_basis || '');
  const [costOverheadRate, setCostOverheadRate] = useState<string>(String(order.allocated_overhead_rate ?? ''));
  const [costServicePrice, setCostServicePrice] = useState<string>(String(order.agreed_service_price ?? ''));

  // مدخلات الاستهلاك الفعلي
  const [consumptionInputs, setConsumptionInputs] = useState<Record<string, { consumed: string; waste: string; returned: string; notes: string }>>(() =>
    Object.fromEntries(order.materials.map((m) => [m.id, {
      consumed: String(m.actual_consumed_quantity ?? ''),
      waste: String(m.actual_waste_quantity ?? ''),
      returned: String(m.actual_returned_quantity ?? ''),
      notes: '',
    }]))
  );

  // حالة قرار مراجعة الهالك الزائد
  const [settlementDecision, setSettlementDecision] = useState<'pending_review' | 'approved_by_factory' | 'claimed_from_customer' | 'waived'>(
    order.excess_waste_settlement_status || 'pending_review'
  );
  const [settlementNotes, setSettlementNotes] = useState<string>('');
  const [settlementSubmitting, setSettlementSubmitting] = useState<boolean>(false);

  // تحميل بطاقة التكلفة
  const loadCostSheet = useCallback(async () => {
    setSheetLoading(true);
    setSheetError(null);
    try {
      const sheet = await fetchOrderCostSheet(order.id);
      setCostSheet(sheet);
      if (sheet.agreed_service_price && !costServicePrice) {
        setCostServicePrice(String(sheet.agreed_service_price));
      }
      if (sheet.waste_analysis?.settlement_status) {
        setSettlementDecision(sheet.waste_analysis.settlement_status as any);
      }
    } catch (err: unknown) {
      setSheetError(err instanceof Error ? err.message : 'تعذر تحميل بطاقة التكلفة والربحية');
    } finally {
      setSheetLoading(false);
    }
  }, [order.id]);

  useEffect(() => {
    void loadCostSheet();
  }, [loadCostSheet]);

  // تحديث مدخلات الاستهلاك عند تغير خامات الأمر
  useEffect(() => {
    setConsumptionInputs(
      Object.fromEntries(order.materials.map((m) => [m.id, {
        consumed: String(m.actual_consumed_quantity ?? ''),
        waste: String(m.actual_waste_quantity ?? ''),
        returned: String(m.actual_returned_quantity ?? ''),
        notes: '',
      }]))
    );
  }, [order.materials]);

  // حفظ واحتساب التكاليف
  const handleSaveCosts = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsProcessing(true);
    setBusy(true);
    try {
      const updated = await calculateOrderCosts(order.id, {
        labor_costing_method: costMethod,
        labor_rate: costLaborRate ? Number(costLaborRate) : undefined,
        labor_hours: costLaborHours ? Number(costLaborHours) : undefined,
        overhead_allocation_basis: (costOverheadBasis as 'produced_pieces' | 'labor_hours') || undefined,
        allocated_overhead_rate: costOverheadRate ? Number(costOverheadRate) : undefined,
        agreed_service_price: costServicePrice ? Number(costServicePrice) : undefined,
      });
      onOrderUpdated(updated);
      await loadCostSheet();
      setStatus({ type: 'success', text: 'تم احتساب وتحديث تكاليف الأمر وبطاقة التكلفة بنجاح' });
    } catch (err: unknown) {
      setStatus({ type: 'error', text: err instanceof Error ? err.message : 'تعذر احتساب التكاليف' });
    } finally {
      setIsProcessing(false);
      setBusy(false);
    }
  };

  // تسجيل الاستهلاك الفعلي
  const handleLogConsumption = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsProcessing(true);
    setBusy(true);
    try {
      const items = order.materials.map((m) => {
        const inp = consumptionInputs[m.id] || { consumed: '0', waste: '0', returned: '0', notes: '' };
        return {
          material_line_id: m.id,
          consumed_quantity: Number(inp.consumed) || 0,
          waste_quantity: Number(inp.waste) || 0,
          returned_quantity: Number(inp.returned) || 0,
          notes: inp.notes,
        };
      });
      const updated = await logOrderMaterialConsumption(order.id, { items });
      onOrderUpdated(updated);
      await loadCostSheet();
      setStatus({ type: 'success', text: 'تم تسجيل الاستهلاك الفعلي واحتساب انحراف الهالك بنجاح' });
    } catch (err: unknown) {
      setStatus({ type: 'error', text: err instanceof Error ? err.message : 'تعذر تسجيل الاستهلاك' });
    } finally {
      setIsProcessing(false);
      setBusy(false);
    }
  };

  // تسجيل قرار مراجعة تسوية الهالك
  const handleSaveWasteSettlement = async (e: React.FormEvent) => {
    e.preventDefault();
    setSettlementSubmitting(true);
    setBusy(true);
    try {
      const updated = await updateWasteSettlement(order.id, {
        decision: settlementDecision,
        notes: settlementNotes,
      });
      onOrderUpdated(updated);
      await loadCostSheet();
      setStatus({ type: 'success', text: 'تم تحديث قرار مراجعة تسوية الهالك بنجاح' });
    } catch (err: unknown) {
      setStatus({ type: 'error', text: err instanceof Error ? err.message : 'تعذر تحديث تسوية الهالك' });
    } finally {
      setSettlementSubmitting(false);
      setBusy(false);
    }
  };

  const canViewPrices = costSheet ? costSheet.can_view_prices : true;

  return (
    <div className="tab-pane" dir="rtl">
      {/* ─── ترويسة بطاقة التكلفة والربحية ────────────────────────────── */}
      <div style={{ marginBottom: '16px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '10px' }}>
        <div>
          <h3 style={{ fontSize: '1.15rem', fontWeight: 700, margin: '0 0 4px', color: '#0f172a' }}>
            بطاقة تكلفة وربحية أمر التشغيل (Job Cost Sheet)
          </h3>
          <p style={{ color: '#64748b', fontSize: '0.875rem', margin: 0 }}>
            تتبع التكاليف المباشرة وغير المباشرة، مع الفصل المحاسبي التام لخامات العميل المحايدة (CMT) وتحليل الهالك والربحية.
          </p>
        </div>
        <button
          type="button"
          className="btn btn--secondary btn--sm"
          onClick={() => void loadCostSheet()}
          disabled={sheetLoading}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
        >
          {sheetLoading ? 'جاري التحميل...' : '🔄 تحديث البطاقة'}
        </button>
      </div>

      {/* تنبيه خطأ تحميل البطاقة */}
      {sheetError && (
        <div
          role="alert"
          style={{
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: '8px',
            padding: '12px 16px',
            marginBottom: '16px',
            color: '#b91c1c',
            fontSize: '0.875rem',
          }}
        >
          {sheetError}
        </div>
      )}

      {/* تنبيه حجب الأسعار لأمين المخزن */}
      {!canViewPrices && (
        <div
          role="status"
          style={{
            background: '#fffbeb',
            border: '1px solid #fde68a',
            borderRadius: '8px',
            padding: '12px 16px',
            marginBottom: '16px',
            color: '#92400e',
            fontSize: '0.875rem',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          }}
        >
          <span style={{ fontSize: '1.2rem' }}>🔒</span>
          <span>
            <strong>تم حجب التكاليف المالية وهوامش الربح:</strong> وفقاً لصلاحيات الدور (أمين المخزن)، يُعرض الجانب المادي والكمي فقط (كميات الاستهلاك، الهالك، والمرتجع) دون الإفصاح عن القيم النقدية.
          </span>
        </div>
      )}

      {/* لافتة تمييز نمط التصنيع والعزل المحاسبي */}
      <div
        style={{
          background: isCmt ? '#f0fdf4' : '#f8fafc',
          border: isCmt ? '1px solid #bbf7d0' : '1px solid #e2e8f0',
          borderRadius: '8px',
          padding: '12px 16px',
          marginBottom: '20px',
        }}
      >
        {isCmt ? (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#166534', fontWeight: 600 }}>
              <span>🧵 تشغيل للغير (CMT) — العميل: {order.customer_name || 'غير محدد'}</span>
              <span className="badge badge--success">خامات أمانة محايدة</span>
            </div>
            <div style={{ fontSize: '0.825rem', color: '#15803d', marginTop: '4px' }}>
              خامات العميل أمانة محايدة دفترياً بتكلفة صفرية (0.00 ج.م) على المصنع ولا تؤثر على تكلفة المخزون أو قائمة الدخل. تكلفة الإنتاج على المصنع تقتصر على أجور العمالة، التحميل غير المباشر، وأي مستلزمات يقدمها المصنع. سقف الهالك المعتمد: {order.allowed_waste_pct ?? '1.50'}%.
            </div>
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#1e293b', fontWeight: 600 }}>
              <span>🏭 تصنيع داخلي لحساب المصنع</span>
              <span className="badge badge--secondary">خامات ملك المصنع</span>
            </div>
            <div style={{ fontSize: '0.825rem', color: '#64748b', marginTop: '4px' }}>
              جميع الخامات ملك للمصنع وتدخل في تكلفة الإنتاج بالكامل ومخزون الإنتاج التام وسعر التكلفة للقطعة.
            </div>
          </div>
        )}
      </div>

      {/* ─── بطاقات المؤشرات المالية الرئيسية (KPI Grid) ────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '12px', marginBottom: '24px' }}>
        {/* 1. تكلفة خامات المصنع */}
        <div style={{ padding: '14px', background: '#fff', borderRadius: '8px', border: '1px solid #e2e8f0', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#64748b' }}>خامات المصنع المباشرة</div>
          <div style={{ fontSize: '1.35rem', fontWeight: 700, color: '#0f172a', margin: '4px 0' }}>
            {canViewPrices ? `${Number(costSheet?.factory_materials_cost ?? order.actual_material_cost ?? 0).toFixed(2)} ج.م` : '—'}
          </div>
          <div style={{ fontSize: '12px', color: '#94a3b8' }}>
            {isCmt ? 'مستلزمات وإضافات المصنع فقط' : 'إجمالي الأقمشة والمستلزمات'}
          </div>
        </div>

        {/* 2. أجور العمالة المباشرة */}
        <div style={{ padding: '14px', background: '#fff', borderRadius: '8px', border: '1px solid #e2e8f0', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#64748b' }}>أجور التشغيل المباشرة</div>
          <div style={{ fontSize: '1.35rem', fontWeight: 700, color: '#0f172a', margin: '4px 0' }}>
            {canViewPrices ? `${Number(costSheet?.labor_detail.total_cost ?? order.actual_labor_cost ?? 0).toFixed(2)} ج.م` : '—'}
          </div>
          <div style={{ fontSize: '12px', color: '#94a3b8' }}>
            {order.labor_costing_method === 'time_based' ? 'حسب ساعات العمل' : 'حسب القطع المنتجة'}
          </div>
        </div>

        {/* 3. التكاليف غير المباشرة */}
        <div style={{ padding: '14px', background: '#fff', borderRadius: '8px', border: '1px solid #e2e8f0', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#64748b' }}>المصاريف غير المباشرة الموزعة</div>
          <div style={{ fontSize: '1.35rem', fontWeight: 700, color: '#0f172a', margin: '4px 0' }}>
            {canViewPrices ? `${Number(costSheet?.overhead_detail.total_cost ?? order.actual_overhead_cost ?? 0).toFixed(2)} ج.م` : '—'}
          </div>
          <div style={{ fontSize: '12px', color: '#94a3b8' }}>
            {costSheet?.overhead_detail.basis_label_ar || 'بدون تحميل إضافي'}
          </div>
        </div>

        {/* 4. إجمالي تكلفة أمر التشغيل وتكلفة القطعة */}
        <div style={{ padding: '14px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #cbd5e1', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#475569' }}>إجمالي تكلفة أمر التشغيل</div>
          <div style={{ fontSize: '1.35rem', fontWeight: 700, color: '#0f172a', margin: '4px 0' }}>
            {canViewPrices ? `${Number(costSheet?.total_factory_manufacturing_cost ?? order.total_actual_cost ?? 0).toFixed(2)} ج.م` : '—'}
          </div>
          <div style={{ fontSize: '12px', color: '#475569' }}>
            تكلفة القطعة: {canViewPrices ? `${Number(costSheet?.unit_factory_cost ?? order.unit_manufacturing_cost ?? 0).toFixed(2)} ج.م` : '—'}
          </div>
        </div>

        {/* 5. سعر الخدمة / الإيراد المتوقع */}
        <div style={{ padding: '14px', background: '#eff6ff', borderRadius: '8px', border: '1px solid #bfdbfe', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#1e40af' }}>{isCmt ? 'أتعاب التشغيل المستهدفة' : 'سعر البيع المستهدف'}</div>
          <div style={{ fontSize: '1.35rem', fontWeight: 700, color: '#1e3a8a', margin: '4px 0' }}>
            {canViewPrices ? `${Number(costSheet?.expected_revenue ?? 0).toFixed(2)} ج.م` : '—'}
          </div>
          <div style={{ fontSize: '12px', color: '#3b82f6' }}>
            {canViewPrices ? `@ ${Number(costSheet?.agreed_service_price ?? order.agreed_service_price ?? 0).toFixed(2)} ج.م / قطعة` : '—'}
          </div>
        </div>

        {/* 6. مجمل الربح وهامش الربحية */}
        <div
          style={{
            padding: '14px',
            background: (costSheet?.gross_margin_amount ?? 0) >= 0 ? '#ecfdf5' : '#fef2f2',
            borderRadius: '8px',
            border: (costSheet?.gross_margin_amount ?? 0) >= 0 ? '1px solid #a7f3d0' : '1px solid #fecaca',
            boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
          }}
        >
          <div style={{ fontSize: '13px', fontWeight: 600, color: (costSheet?.gross_margin_amount ?? 0) >= 0 ? '#047857' : '#b91c1c' }}>
            مجمل الربح والنسبة
          </div>
          <div style={{ fontSize: '1.35rem', fontWeight: 700, color: (costSheet?.gross_margin_amount ?? 0) >= 0 ? '#065f46' : '#991b1b', margin: '4px 0' }}>
            {canViewPrices ? `${Number(costSheet?.gross_margin_amount ?? 0).toFixed(2)} ج.م` : '—'}
          </div>
          <div style={{ fontSize: '12px', color: (costSheet?.gross_margin_amount ?? 0) >= 0 ? '#059669' : '#dc2626' }}>
            هامش الربح: {canViewPrices ? `${Number(costSheet?.gross_margin_pct ?? 0).toFixed(1)}%` : '—'}
          </div>
        </div>
      </div>

      {/* ─── جدول خامات أمانة العميل المعزولة دفترياً (CMT) ────────────── */}
      {isCmt && costSheet && costSheet.customer_materials.length > 0 && (
        <div style={{ background: '#fff', padding: '16px', borderRadius: '8px', border: '1px solid #bbf7d0', marginBottom: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <div>
              <h4 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0, color: '#166534' }}>
                📦 خامات أمانة العميل (Customer-Supplied Custody) — تكلفة صفرية على المصنع
              </h4>
              <p style={{ fontSize: '0.8rem', color: '#15803d', margin: '2px 0 0' }}>
                الخامات التالية ملك للعميل؛ تُدار كمياً فقط ومحايدة دفترياً (0.00 ج.م) في تكاليف الإنتاج.
              </p>
            </div>
            <span className="badge badge--success">0.00 ج.م على المصنع</span>
          </div>

          <div className="table-responsive" style={{ overflowX: 'auto', marginBottom: '16px' }}>
            <table className="preview-table table--compact" style={{ width: '100%', minWidth: '750px', fontSize: '14px' }}>
              <thead>
                <tr>
                  <th>الصنف / الخامة</th>
                  <th>الوحدة</th>
                  <th style={{ textAlign: 'right' }}>المخطط</th>
                  <th style={{ textAlign: 'right' }}>المصروف</th>
                  <th style={{ textAlign: 'right' }}>المستلم بالورشة</th>
                  <th style={{ textAlign: 'right' }}>المستهلك الفعلي</th>
                  <th style={{ textAlign: 'right' }}>الهالك الفعلي</th>
                  <th style={{ textAlign: 'right' }}>المرتجع للعميل</th>
                  <th style={{ textAlign: 'right' }}>سعر الوحدة الدفتري</th>
                  <th style={{ textAlign: 'right' }}>إجمالي التكلفة للمصنع</th>
                </tr>
              </thead>
              <tbody>
                {costSheet.customer_materials.map((m) => (
                  <tr key={m.item_id}>
                    <td>
                      <strong>{m.item_name_ar}</strong>
                      <div style={{ fontSize: '0.75rem', color: '#64748b' }}>{m.item_code}</div>
                    </td>
                    <td>{m.unit_name_ar}</td>
                    <td style={{ textAlign: 'right' }}>{Number(m.planned_quantity).toFixed(2)}</td>
                    <td style={{ textAlign: 'right' }}>{Number(m.dispatched_quantity).toFixed(2)}</td>
                    <td style={{ textAlign: 'right' }}>{Number(m.received_quantity).toFixed(2)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{Number(m.actual_consumed_quantity).toFixed(2)}</td>
                    <td style={{ textAlign: 'right', color: Number(m.actual_waste_quantity) > 0 ? '#b91c1c' : 'inherit' }}>
                      {Number(m.actual_waste_quantity).toFixed(2)}
                    </td>
                    <td style={{ textAlign: 'right' }}>{Number(m.actual_returned_quantity).toFixed(2)}</td>
                    <td style={{ textAlign: 'right', color: '#64748b' }}>0.00 ج.م (أمانة)</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: '#166534' }}>0.00 ج.م</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ─── جدول خامات ومستلزمات المصنع ────────────────────────────── */}
      {costSheet && costSheet.factory_materials.length > 0 && (
        <div style={{ background: '#fff', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0', marginBottom: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <div>
              <h4 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0, color: '#0f172a' }}>
                🏭 خامات ومستلزمات ملك المصنع (Factory Materials)
              </h4>
              <p style={{ fontSize: '0.8rem', color: '#64748b', margin: '2px 0 0' }}>
                خامات ومستلزمات (أزرار، خيوط، بطانة، إكسسوار) مملوكة للمصنع وتدخل في التكلفة الفعلية.
              </p>
            </div>
            {canViewPrices && (
              <span className="badge badge--primary">
                إجمالي خامات المصنع: {Number(costSheet.factory_materials_cost).toFixed(2)} ج.م
              </span>
            )}
          </div>

          <div className="table-responsive" style={{ overflowX: 'auto', marginBottom: '16px' }}>
            <table className="preview-table table--compact" style={{ width: '100%', minWidth: '750px', fontSize: '14px' }}>
              <thead>
                <tr>
                  <th>الصنف / الخامة</th>
                  <th>الوحدة</th>
                  <th style={{ textAlign: 'right' }}>المخطط</th>
                  <th style={{ textAlign: 'right' }}>المستهلك الفعلي</th>
                  <th style={{ textAlign: 'right' }}>الهالك الفعلي</th>
                  <th style={{ textAlign: 'right' }}>المرتجع</th>
                  <th style={{ textAlign: 'right' }}>سعر الوحدة</th>
                  <th style={{ textAlign: 'right' }}>إجمالي التكلفة</th>
                </tr>
              </thead>
              <tbody>
                {costSheet.factory_materials.map((m) => (
                  <tr key={m.item_id}>
                    <td>
                      <strong>{m.item_name_ar}</strong>
                      <div style={{ fontSize: '0.75rem', color: '#64748b' }}>{m.item_code}</div>
                    </td>
                    <td>{m.unit_name_ar}</td>
                    <td style={{ textAlign: 'right' }}>{Number(m.planned_quantity).toFixed(2)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{Number(m.actual_consumed_quantity).toFixed(2)}</td>
                    <td style={{ textAlign: 'right' }}>{Number(m.actual_waste_quantity).toFixed(2)}</td>
                    <td style={{ textAlign: 'right' }}>{Number(m.actual_returned_quantity).toFixed(2)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {canViewPrices ? `${Number(m.unit_cost).toFixed(2)} ج.م` : '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>
                      {canViewPrices ? `${Number(m.total_cost).toFixed(2)} ج.م` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ─── بطاقة تحليل الهالك ومراجعة تسوية التجاوز ────────────────── */}
      {costSheet?.waste_analysis && (
        <div style={{ background: '#fff', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0', marginBottom: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap', gap: '8px' }}>
            <div>
              <h4 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0, color: '#0f172a' }}>
                ⚖️ تحليل الهالك وسقف التجاوز (Waste Policy & Settlement Review)
              </h4>
              <p style={{ fontSize: '0.8rem', color: '#64748b', margin: '2px 0 0' }}>
                سقف الهالك المعتمد: {Number(costSheet.waste_analysis.allowed_waste_pct).toFixed(2)}% محسوب على إجمالي الاستهلاك الفعلي.
              </p>
            </div>
            <div>
              <span
                className={`badge ${
                  costSheet.waste_analysis.settlement_status === 'approved_by_factory'
                    ? 'badge--success'
                    : costSheet.waste_analysis.settlement_status === 'claimed_from_customer'
                    ? 'badge--primary'
                    : costSheet.waste_analysis.settlement_status === 'waived'
                    ? 'badge--secondary'
                    : 'badge--warning'
                }`}
                style={{ fontSize: '0.85rem', padding: '4px 10px' }}
              >
                حالة الهالك: {costSheet.waste_analysis.settlement_status_ar}
              </span>
            </div>
          </div>

          {/* مؤشرات الهالك */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px', marginBottom: '16px' }}>
            <div style={{ padding: '10px', background: '#f8fafc', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
              <div style={{ fontSize: '0.75rem', color: '#64748b' }}>الهالك الفعلي الإجمالي</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0f172a' }}>
                {Number(costSheet.waste_analysis.actual_waste_qty).toFixed(3)}
              </div>
              <div style={{ fontSize: '0.75rem', color: '#64748b' }}>
                نسبة الهالك: {Number(costSheet.waste_analysis.actual_waste_pct).toFixed(2)}%
              </div>
            </div>

            <div style={{ padding: '10px', background: '#f8fafc', borderRadius: '6px', border: '1px solid #e2e8f0' }}>
              <div style={{ fontSize: '0.75rem', color: '#64748b' }}>سقف الهالك المسموح ({Number(costSheet.waste_analysis.allowed_waste_pct).toFixed(2)}%)</div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, color: '#0f172a' }}>
                {Number(costSheet.waste_analysis.allowed_waste_qty).toFixed(3)}
              </div>
              <div style={{ fontSize: '0.75rem', color: '#166534' }}>كمية مسموحة تعاقدياً</div>
            </div>

            <div
              style={{
                padding: '10px',
                background: costSheet.waste_analysis.is_excess ? '#fef2f2' : '#f0fdf4',
                borderRadius: '6px',
                border: costSheet.waste_analysis.is_excess ? '1px solid #fecaca' : '1px solid #bbf7d0',
              }}
            >
              <div style={{ fontSize: '0.75rem', color: costSheet.waste_analysis.is_excess ? '#b91c1c' : '#166534' }}>
                {costSheet.waste_analysis.is_excess ? '⚠️ انحراف الهالك الزائد' : '✓ ضمن السقف المسموح'}
              </div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, color: costSheet.waste_analysis.is_excess ? '#991b1b' : '#15803d' }}>
                {Number(costSheet.waste_analysis.excess_waste_qty).toFixed(3)}
              </div>
              <div style={{ fontSize: '0.75rem', color: costSheet.waste_analysis.is_excess ? '#b91c1c' : '#166534' }}>
                {canViewPrices && costSheet.waste_analysis.is_excess
                  ? `تكلفة التجاوز: ${Number(costSheet.waste_analysis.excess_waste_cost).toFixed(2)} ج.م`
                  : 'لا يوجد تجاوز'}
              </div>
            </div>
          </div>

          {/* تنبيه سياسة عدم الخصم الآلي */}
          <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '6px', padding: '10px 14px', marginBottom: '14px', fontSize: '0.825rem', color: '#475569' }}>
            ℹ️ <strong>سياسة المصنع في تسوية الهالك:</strong> تجاوز سقف الهالك لا يُطبق عليه أي غرامات أو خصومات آلية على الفاتورة، بل يُسجل كحالة مراجعة إدارية تتطلب قراراً صريحاً من الإدارة (اعتماد تشغيلي طبيعي، مطالبة العميل، أو إعفاء).
          </div>

          {/* فورم تحديث قرار تسوية الهالك */}
          {canViewPrices && (
            <form onSubmit={handleSaveWasteWasteSettlementWrap(handleSaveWasteSettlement)} style={{ background: '#fafafa', padding: '12px', borderRadius: '6px', border: '1px dashed #cbd5e1' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px', alignItems: 'flex-end' }}>
                <label className="form-label">
                  <span>قرار مراجعة الهالك الزائد</span>
                  <select
                    className="form-input"
                    value={settlementDecision}
                    onChange={(e) => setSettlementDecision(e.target.value as any)}
                  >
                    <option value="pending_review">قيد مراجعة الإدارة (معلق)</option>
                    <option value="approved_by_factory">هالك تشغيلي طبيعي معتمد من المصنع</option>
                    <option value="claimed_from_customer">مطالبة العميل بتعويض التجاوز</option>
                    <option value="waived">تسوية وإعفاء</option>
                  </select>
                </label>

                <label className="form-label">
                  <span>ملاحظات القرار الإداري</span>
                  <input
                    type="text"
                    className="form-input"
                    value={settlementNotes}
                    onChange={(e) => setSettlementNotes(e.target.value)}
                    placeholder="سبب القرار أو رقم محضر المراجعة..."
                  />
                </label>

                <div>
                  <button type="submit" className="btn btn--secondary btn--sm" disabled={settlementSubmitting}>
                    {settlementSubmitting ? 'جاري الحفظ...' : 'اعتماد قرار التسوية'}
                  </button>
                </div>
              </div>
            </form>
          )}
        </div>
      )}

      {/* ─── فورم معايير احتساب الأجور والتحميل ────────────────────────── */}
      {canViewPrices && (
        <form onSubmit={handleSaveCosts} style={{ background: '#fff', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0', marginBottom: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <div>
              <h4 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0, color: '#0f172a' }}>
                ⚙️ معايير احتساب التكاليف والأجور
              </h4>
              <p style={{ fontSize: '0.8rem', color: '#64748b', margin: '2px 0 0' }}>
                تحديد طريقة أجور العمالة، أساس التحميل غير المباشر، وسعر الخدمة أو بيع القطعة المستهدف.
              </p>
            </div>
            {order.cost_calculated_at && (
              <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
                آخر احتساب: {new Date(order.cost_calculated_at).toLocaleString('ar-EG')}
              </span>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '12px' }}>
            <label className="form-label">
              <span>طريقة احتساب أجور العمالة</span>
              <select
                className="form-input"
                value={costMethod}
                onChange={(e) => setCostMethod(e.target.value as 'piece_based' | 'time_based')}
              >
                <option value="piece_based">بالقطعة المنتجة (Piece-based)</option>
                <option value="time_based">بساعات العمل الفعلية (Time-based)</option>
              </select>
            </label>

            <label className="form-label">
              <span>معدل الأجر (ج.م / {costMethod === 'time_based' ? 'ساعة' : 'قطعة'})</span>
              <input
                type="number"
                step="0.01"
                className="form-input"
                value={costLaborRate}
                onChange={(e) => setCostLaborRate(e.target.value)}
                placeholder="0.00"
              />
            </label>

            {costMethod === 'time_based' && (
              <label className="form-label">
                <span>إجمالي ساعات العمل الفعلية</span>
                <input
                  type="number"
                  step="0.1"
                  className="form-input"
                  value={costLaborHours}
                  onChange={(e) => setCostLaborHours(e.target.value)}
                  placeholder="0.0"
                />
              </label>
            )}

            <label className="form-label">
              <span>أساس توزيع التكاليف غير المباشرة</span>
              <select
                className="form-input"
                value={costOverheadBasis}
                onChange={(e) => setCostOverheadBasis(e.target.value)}
              >
                <option value="">بدون تحميل مصاريف إضافية</option>
                <option value="produced_pieces">حسب القطع المنتجة</option>
                <option value="labor_hours">حسب ساعات العمل</option>
              </select>
            </label>

            {costOverheadBasis && (
              <label className="form-label">
                <span>معدل التحميل (ج.م / وحدة الأساس)</span>
                <input
                  type="number"
                  step="0.01"
                  className="form-input"
                  value={costOverheadRate}
                  onChange={(e) => setCostOverheadRate(e.target.value)}
                  placeholder="0.00"
                />
              </label>
            )}

            <label className="form-label">
              <span>{isCmt ? 'سعر مصنعية القطعة المتفق عليه' : 'سعر بيع القطعة المستهدف'} (ج.م)</span>
              <input
                type="number"
                step="0.01"
                className="form-input"
                value={costServicePrice}
                onChange={(e) => setCostServicePrice(e.target.value)}
                placeholder="0.00"
              />
            </label>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '14px' }}>
            <button type="submit" className="btn btn--secondary" disabled={isProcessing}>
              {isProcessing ? 'جاري الاحتساب...' : 'حفظ واحتساب التكاليف'}
            </button>
          </div>
        </form>
      )}

      {/* ─── فورم تسجيل الاستهلاك الفعلي والهالك والمرتجع ───────────── */}
      <form onSubmit={handleLogConsumption} style={{ background: '#fff', padding: '16px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <div>
            <h4 style={{ fontSize: '0.95rem', fontWeight: 700, margin: 0, color: '#0f172a' }}>
              📋 تسجيل الاستهلاك الفعلي والهالك والمرتجع لخامات الأمر
            </h4>
            <p style={{ fontSize: '0.8rem', color: '#64748b', margin: '2px 0 0' }}>
              إدخال الكميات المستهلكة فعلياً في الورشة لحساب انحراف الهالك بدقة ومقارنته بنسبة الـ 1.5%.
            </p>
          </div>
          {(order.excess_waste_qty || 0) > 0 && (
            <span className="badge badge--danger">
              ⚠️ تجاوز الهالك المسموح ({Number(order.excess_waste_qty).toFixed(2)})
            </span>
          )}
        </div>

        <div className="table-responsive" style={{ overflowX: 'auto', marginBottom: '16px' }}>
          <table className="preview-table table--compact" style={{ width: '100%', minWidth: '750px', fontSize: '14px' }}>
            <thead>
              <tr>
                <th>الخامة</th>
                <th>الملكية</th>
                <th>المعاملة التجارية</th>
                <th style={{ textAlign: 'right' }}>المخطط</th>
                <th style={{ width: '130px' }}>المستهلك الفعلي</th>
                <th style={{ width: '130px' }}>الهالك الفعلي</th>
                <th style={{ width: '130px' }}>المرتجع</th>
              </tr>
            </thead>
            <tbody>
              {order.materials.map((m) => {
                const inp = consumptionInputs[m.id] || { consumed: '', waste: '', returned: '', notes: '' };
                return (
                  <tr key={m.id}>
                    <td>
                      <strong>{m.item_name_ar}</strong><br />
                      <small>{m.item_code} · {m.unit_name_ar}</small>
                    </td>
                    <td>
                      <span className={`badge ${m.supplied_by === 'customer' ? 'badge--success' : 'badge--secondary'}`}>
                        {m.supplied_by === 'customer' ? 'أمانة عميل' : 'ملك المصنع'}
                      </span>
                    </td>
                    <td>
                      <small>{m.commercial_treatment === 'billed_separately' ? 'فاتورة منفصلة' : 'ضمن مصنعية التشغيل'}</small>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {Number(m.planned_quantity).toFixed(2)}
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.001"
                        min="0"
                        className="table-input"
                        value={inp.consumed}
                        onChange={(e) => {
                          const val = e.target.value;
                          setConsumptionInputs((prev) => ({
                            ...prev,
                            [m.id]: { ...prev[m.id], consumed: val },
                          }));
                        }}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.001"
                        min="0"
                        className="table-input"
                        value={inp.waste}
                        onChange={(e) => {
                          const val = e.target.value;
                          setConsumptionInputs((prev) => ({
                            ...prev,
                            [m.id]: { ...prev[m.id], waste: val },
                          }));
                        }}
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        step="0.001"
                        min="0"
                        className="table-input"
                        value={inp.returned}
                        onChange={(e) => {
                          const val = e.target.value;
                          setConsumptionInputs((prev) => ({
                            ...prev,
                            [m.id]: { ...prev[m.id], returned: val },
                          }));
                        }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
          <button type="submit" className="btn btn--primary" disabled={isProcessing}>
            {isProcessing ? 'جاري التسجيل...' : 'تسجيل الاستهلاك وتحديث انحراف الهالك'}
          </button>
        </div>
      </form>
    </div>
  );
};

function handleSaveWasteWasteSettlementWrap(fn: (e: React.FormEvent) => void) {
  return (e: React.FormEvent) => {
    fn(e);
  };
}
