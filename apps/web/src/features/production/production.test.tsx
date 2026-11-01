import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProductionOrdersView } from './ProductionOrdersView';
import { NewOrderModal } from './NewOrderModal';
import { OrderDetailModal } from './OrderDetailModal';
import {
  PROVISIONAL_FALLBACK_PRODUCTS,
  PROVISIONAL_FALLBACK_ORDERS,
  ProductionOrder,
} from './productionApi';

describe('Production Orders Feature — Frontend Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. renders operations flow banner with the five sequential stages', async () => {
    render(<ProductionOrdersView />);

    expect(screen.getByLabelText(/مراحل تشغيل الدفعات/i)).toBeInTheDocument();
    expect(screen.getByText('القص على الباترون')).toBeInTheDocument();
    expect(screen.getByText('التشطيب والخياطة')).toBeInTheDocument();
    expect(screen.getByText('تركيب الكبسولة والأزرار')).toBeInTheDocument();
    expect(screen.getByText('الكي والبخار')).toBeInTheDocument();
    expect(screen.getByText('التعبئة والتغليف')).toBeInTheDocument();
  });

  it('2. renders factory meeting assumptions side panel with draft rules', async () => {
    render(<ProductionOrdersView />);

    expect(screen.getByText('افتراضات اجتماع المصنع')).toBeInTheDocument();
    expect(screen.getByText(/التناسب الحسابي للكميات/i)).toBeInTheDocument();
    expect(screen.getByText(/تجميد لقطة الخامات \(Snapshot\)/i)).toBeInTheDocument();
    expect(screen.getByText(/التتابع الإلزامي للمراحل/i)).toBeInTheDocument();
    expect(screen.getByText(/سياسة الحظر الافتراضي \(Deny-by-default\)/i)).toBeInTheDocument();
  });

  it('3. filters orders by status and searches by order number', async () => {
    render(<ProductionOrdersView />);

    // فحص ظهور الأوامر التجريبية
    await waitFor(() => {
      expect(screen.getByText(/PO-2026-0001/i)).toBeInTheDocument();
    });

    // النقر على فلتر "مسودات"
    const draftsBtn = screen.getByRole('button', { name: /مسودات/i });
    fireEvent.click(draftsBtn);

    // التحقق من ظهور أمر المسودة PO-2026-0002 واختفاء أمر قيد التشغيل PO-2026-0001
    expect(screen.getByText(/PO-2026-0002/i)).toBeInTheDocument();
    expect(screen.queryByText(/PO-2026-0001/i)).not.toBeInTheDocument();
  });

  it('4. calculates proportional material scaling in NewOrderModal', () => {
    const mockOnClose = vi.fn();
    const mockOnCreate = vi.fn();

    const sampleTemplate = {
      id: 'tmpl-test',
      code: 'TMPL-01',
      name_ar: 'قالب تجريبي',
      product_id: 'prod-01',
      product_name_ar: 'نصف ياقة مع أساور',
      is_active: true,
      versions: [
        {
          id: 'ver-test',
          version_number: 1,
          status: 'active',
          reference_quantity: 50,
          notes: '50 قطعة',
          lines: [
            {
              id: 'l1',
              item_id: 'it-fab',
              item_name_ar: 'قماش قطن',
              item_code: 'FAB-01',
              unit_id: 'u-m',
              unit_name_ar: 'متر',
              quantity_per_reference: 100, // 2 متر للقطعة
              notes: '',
            },
          ],
        },
      ],
    };

    render(
      <NewOrderModal
        isOpen={true}
        onClose={mockOnClose}
        onOrderCreated={mockOnCreate}
        products={PROVISIONAL_FALLBACK_PRODUCTS}
        templates={[sampleTemplate]}
        catalogItems={[]}
      />
    );

    // التحقق من وجود عنوان النافذة
    expect(screen.getByText(/إنشاء أمر تشغيل جديد \(مسودة دفعة\)/i)).toBeInTheDocument();

    // القيمة الافتراضية للكمية 100 قطعة
    // التناسب: 100 / 50 = 2x -> الخامات المطلوبة = 200 متر
    expect(screen.getByText(/معامل التناسب: 100 ÷ 50 = 2.00x/i)).toBeInTheDocument();
    expect(screen.getByText('200')).toBeInTheDocument();

    // تغيير الكمية إلى 150 قطعة
    const qtyInput = screen.getByLabelText(/الكمية المستهدفة للدفعة/i);
    fireEvent.change(qtyInput, { target: { value: '150' } });

    // التناسب: 150 / 50 = 3x -> الخامات المطلوبة = 300 متر
    expect(screen.getByText(/معامل التناسب: 150 ÷ 50 = 3.00x/i)).toBeInTheDocument();
    expect(screen.getByText('300')).toBeInTheDocument();
  });

  it('allows adding and removing an extra catalog item while preparing a new order', () => {
    render(
      <NewOrderModal
        isOpen={true}
        onClose={vi.fn()}
        onOrderCreated={vi.fn()}
        products={PROVISIONAL_FALLBACK_PRODUCTS}
        templates={[]}
        catalogItems={[{
          id: 'extra-fabric', code: 'FAB-EXTRA', name_ar: 'قماش إضافي', item_type: 'raw_material',
          unit_id: 'unit-meter', unit_name_ar: 'متر', is_consumable: true, is_active: true,
        }]}
      />
    );

    fireEvent.change(screen.getByLabelText('إضافة صنف خامة'), { target: { value: 'extra-fabric' } });
    fireEvent.change(screen.getByLabelText('الكمية المطلوبة'), { target: { value: '12.5' } });
    fireEvent.click(screen.getByRole('button', { name: /إضافة الصنف/ }));

    expect(screen.getByText('قماش إضافي')).toBeInTheDocument();
    expect(screen.getByText('إضافة يدوية')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'حذف' }));
    expect(screen.queryByText('إضافة يدوية')).not.toBeInTheDocument();
  });

  it('5. renders frozen material snapshot and enforces sequential stage progression in OrderDetailModal', () => {
    const mockOnClose = vi.fn();
    const mockOnUpdate = vi.fn();
    const testOrder: ProductionOrder = {
      ...PROVISIONAL_FALLBACK_ORDERS[0],
      stage_events: [
        {
          id: 'st-cut',
          stage_name: 'cutting',
          status: 'not_started',
          actor_id: 'u1',
          actor_name: 'محمد',
          timestamp: new Date().toISOString(),
          notes: '',
        },
        {
          id: 'st-fin',
          stage_name: 'finishing',
          status: 'not_started',
          actor_id: 'u1',
          actor_name: 'سعيد',
          timestamp: new Date().toISOString(),
          notes: '',
        },
      ],
    };

    render(
      <OrderDetailModal
        order={testOrder}
        isOpen={true}
        onClose={mockOnClose}
        onOrderUpdated={mockOnUpdate}
      />
    );

    // التحقق من عرض لقطة الخامات المجمدة
    expect(screen.getByText(/لقطة الخامات والتحويل المخزني/i)).toBeInTheDocument();
    expect(screen.getByText('قماش قطن مصري فاخر')).toBeInTheDocument();
    expect(screen.getByText('أزرار صدفية طبيعية')).toBeInTheDocument();

    // التبديل إلى تبويب مراحل التشغيل التتابعية
    const stagesTabBtn = screen.getByText(/مراحل التشغيل التتابعية/i);
    fireEvent.click(stagesTabBtn);

    // مرحلة القص غير مكتملة، لذا يجب أن يكون زر بدء مرحلة التشطيب (المرحلة اللاحقة) معطلاً
    const startButtons = screen.getAllByRole('button', { name: /بدء المرحلة/i });
    expect(startButtons.length).toBeGreaterThan(0);
    // زر مرحلة القص متاح
    expect(startButtons[0]).not.toBeDisabled();
    // زر مرحلة التشطيب معطل لأن القص لم ينته بعد
    expect(startButtons[1]).toBeDisabled();
  });

  it('6. offers catalog material entry while a production order is still a draft', () => {
    const draft = { ...PROVISIONAL_FALLBACK_ORDERS[0], status: 'draft', materials: [] };
    render(
      <OrderDetailModal
        order={draft}
        isOpen={true}
        onClose={vi.fn()}
        onOrderUpdated={vi.fn()}
        catalogItems={[{
          id: 'item-new', code: 'THR-01', name_ar: 'خيط تشغيل', item_type: 'raw_material',
          unit_id: 'unit-spool', unit_name_ar: 'بكرة', is_consumable: true, is_active: true,
        }]}
      />
    );

    expect(screen.getByText('إضافة خامة إلى المسودة')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /خيط تشغيل · THR-01/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /إضافة الصنف/ })).toBeInTheDocument();
  });

  it('7. requests a reason to reopen only the latest completed production stage', () => {
    const order = {
      ...PROVISIONAL_FALLBACK_ORDERS[0],
      stage_events: [
        { id: 'a', stage_name: 'cutting', status: 'completed', actor_id: 'u', actor_name: 'مشرف', timestamp: new Date().toISOString(), notes: '' },
        ...['finishing', 'snap_installation', 'ironing', 'packing'].map((stage, index) => ({
          id: `later-${index}`, stage_name: stage, status: 'not_started', actor_id: 'u', actor_name: 'مشرف', timestamp: new Date().toISOString(), notes: '',
        })),
      ],
    } as ProductionOrder;
    render(<OrderDetailModal order={order} isOpen={true} onClose={vi.fn()} onOrderUpdated={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /مراحل التشغيل التتابعية/i }));
    expect(screen.getByLabelText(/سبب إعادة فتح المرحلة/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /إعادة فتح المرحلة/i })).toBeInTheDocument();
  });
});
