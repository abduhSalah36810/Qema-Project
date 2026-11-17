/**
 * اختبارات بطاقة التكلفة والربحية (بند 3 من تجربة المالك)
 * ─────────────────────────────────────────────────────────────────────────────
 * ما رصده المالك: فتح بطاقة التكلفة لأمر مغلق بمسؤول الإنتاج يُظهر صفحة بيضاء.
 * السبب: الواجهة كانت تقرأ حقولاً قديمة (labor/overhead/total_manufacturing_cost)
 * لا يرسلها الخادم أبداً (يرسل labor_detail/overhead_detail/total_factory_manufacturing_cost)
 * فينهار الرسم بخطأ JS عند costSheet.labor.total_cost على undefined.
 *
 * الاختبار يثبت:
 * 1. دور يرى الأسعار (production_manager): البطاقة تُرسم كاملة على أمر مغلق والقيم
 *    المعروضة تأتي من حقول الخادم الموائمة (لا انهيار ولا قيم صفرية زائفة).
 * 2. الدور المحجوب (أمين المخزن): القيم النقدية تخفي '—' مع تنبيه الحجب،
 *    ونماذج الإدارة المالية لا تظهر.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { OrderCostsSection } from './OrderCostsSection';
import { type SectionContext } from './constants';
import {
  PROVISIONAL_FALLBACK_ORDERS,
  type JobCostSheet,
  type ProductionOrder,
} from '../productionApi';
import * as productionApi from '../productionApi';

const maskedSheet: JobCostSheet = {
  order_id: 'ord-cost',
  order_number: 'PO-2026-0100',
  manufacturing_type: 'internal',
  manufacturing_type_label_ar: 'تصنيع داخلي',
  status: 'closed',
  status_label_ar: 'مغلق ومسوى نهائياً',
  customer_id: null,
  customer_name: null,
  product_name_ar: 'منتج بطاقة التكلفة',
  product_code: 'PRD-100',
  target_quantity: 50,
  completed_quantity: 50,
  factory_materials: [],
  customer_materials: [],
  factory_materials_cost: 2425,
  direct_labor_cost: 800,
  allocated_overhead_cost: 300,
  total_factory_manufacturing_cost: 3525,
  unit_factory_cost: 70.5,
  customer_materials_count: 0,
  customer_materials_total_consumed: 0,
  customer_materials_total_wasted: 0,
  customer_materials_total_returned: 0,
  labor_detail: { method: 'piece_based', method_label_ar: 'بالقطعة المنتجة', rate: 16, quantity_basis: 50, total_cost: 800 },
  overhead_detail: { basis: 'produced_pieces', basis_label_ar: 'حسب القطع المنتجة', rate: 6, base_quantity: 50, total_cost: 300 },
  waste_analysis: {
    allowed_waste_pct: 1.5,
    allowed_waste_qty: 1.5,
    actual_waste_qty: 0,
    actual_waste_pct: 0,
    excess_waste_qty: 0,
    excess_waste_cost: 0,
    is_excess: false,
    settlement_status: 'pending_review',
    settlement_status_ar: 'قيد مراجعة الإدارة',
  },
  agreed_service_price: 100,
  expected_revenue: 5000,
  gross_margin_amount: 1475,
  gross_margin_pct: 41.9,
  calculated_at: '2026-11-17T10:00:00Z',
  calculated_by: 'pm-user',
  can_view_prices: true,
};

function buildOrder(): ProductionOrder {
  return {
    ...PROVISIONAL_FALLBACK_ORDERS[0],
    id: 'ord-cost',
    order_number: 'PO-2026-0100',
    status: 'closed',
    manufacturing_type: 'internal',
    target_quantity: 50,
  };
}

function buildCtx(order: ProductionOrder): SectionContext {
  return {
    order,
    onOrderUpdated: vi.fn(),
    refreshOrder: vi.fn().mockResolvedValue(undefined),
    reportFailure: vi.fn(),
    setStatus: vi.fn(),
    setBusy: vi.fn(),
  };
}

describe('OrderCostsSection — بطاقة التكلفة (بند 3: إصلاح الشاشة البيضاء للأمر المغلق)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. يرسم البطاقة كاملة لأمر مغلق بلا انهيار، والقيم من حقول الخادم الموائمة', async () => {
    vi.spyOn(productionApi, 'fetchOrderCostSheet').mockResolvedValue(maskedSheet);
    const ctx = buildCtx(buildOrder());

    render(<OrderCostsSection ctx={ctx} />);

    // لو كانت الواجهة ما زالت تقرأ labor/overhead القديمة لانهار الرسم بخطأ JS (صفحة بيضاء)
    await waitFor(() => {
      expect(screen.getByText('2425.00 ج.م')).toBeInTheDocument(); // factory_materials_cost
    });
    expect(screen.getByText('800.00 ج.م')).toBeInTheDocument(); // labor_detail.total_cost
    expect(screen.getByText('300.00 ج.م')).toBeInTheDocument(); // overhead_detail.total_cost
    expect(screen.getByText('3525.00 ج.م')).toBeInTheDocument(); // total_factory_manufacturing_cost
    expect(screen.getByText(/تكلفة القطعة: 70\.50 ج\.م/)).toBeInTheDocument(); // unit_factory_cost
    expect(screen.getByText('1475.00 ج.م')).toBeInTheDocument(); // gross_margin_amount
    // أساس التحميل من overhead_detail.basis_label_ar (يظهر في البطاقة وفي خيار النموذج)
    expect(screen.getAllByText('حسب القطع المنتجة').length).toBeGreaterThan(0);
    // نموذج معايير الاحتساب ظاهر لمن يرى الأسعار
    expect(screen.getByText(/معايير احتساب التكاليف والأجور/)).toBeInTheDocument();
    // لا تنبيه حجب
    expect(screen.queryByText(/تم حجب التكاليف المالية/)).not.toBeInTheDocument();
  });

  it("2. الدور المحجوب (أمين المخزن): القيم النقدية '—' مع تنبيه الحجب وإخفاء نماذج الإدارة", async () => {
    vi.spyOn(productionApi, 'fetchOrderCostSheet').mockResolvedValue({ ...maskedSheet, can_view_prices: false });
    const ctx = buildCtx(buildOrder());

    render(<OrderCostsSection ctx={ctx} />);

    await waitFor(() => {
      expect(screen.getByText(/تم حجب التكاليف المالية وهوامش الربح/)).toBeInTheDocument();
    });
    // لا قيم نقدية مكشوفة
    expect(screen.queryByText('2425.00 ج.م')).not.toBeInTheDocument();
    expect(screen.queryByText('3525.00 ج.م')).not.toBeInTheDocument();
    expect(screen.queryByText('1475.00 ج.م')).not.toBeInTheDocument();
    // نماذج الإدارة المالية مخفية
    expect(screen.queryByText(/معايير احتساب التكاليف والأجور/)).not.toBeInTheDocument();
    // الكميات (الهالك) تبقى ظاهرة لأنها ليست مالية
    expect(screen.getByText(/تحليل الهالك وسقف التجاوز/)).toBeInTheDocument();
  });

  it('3. فشل تحميل البطاقة يظهر كرسالة خطأ داخل البطاقة لا كانهيار للصفحة', async () => {
    vi.spyOn(productionApi, 'fetchOrderCostSheet').mockRejectedValue(new Error('تعذر الاتصال بالخادم'));
    const ctx = buildCtx(buildOrder());

    render(<OrderCostsSection ctx={ctx} />);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/تعذر الاتصال بالخادم/);
    });
    // ترويسة البطاقة ما زالت مرسومة
    expect(screen.getByText(/بطاقة تكلفة وربحية أمر التشغيل/)).toBeInTheDocument();
  });
});
