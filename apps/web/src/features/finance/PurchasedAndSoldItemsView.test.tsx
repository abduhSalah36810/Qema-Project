import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PurchasedItemsView } from './PurchasedItemsView';
import { SoldItemsView } from '@/features/customers/SoldItemsView';
import * as financeApi from './financeApi';
import * as customersApi from '@/features/customers/customersApi';
import * as prodApi from '@/features/production/productionApi';

vi.mock('./financeApi', () => ({
  financeApi: {
    getPurchasedItems: vi.fn(),
    getSuppliers: vi.fn(),
  },
}));

vi.mock('@/features/production/productionApi', () => ({
  fetchCatalogItems: vi.fn(),
  fetchProducts: vi.fn(),
}));

vi.mock('@/features/customers/customersApi', () => ({
  fetchSoldItems: vi.fn(),
  fetchCustomers: vi.fn(),
}));

describe('PurchasedItemsView UI Component Repair Verification', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all 5 summary statistic cards with proper card classes, filters, and table', async () => {
    vi.mocked(financeApi.financeApi.getSuppliers).mockResolvedValue([
      { id: 'sup-1', code: 'S1', name: 'مورد الأقمشة' } as any,
    ]);
    vi.mocked(prodApi.fetchCatalogItems).mockResolvedValue([
      { id: 'cat-1', code: 'RAW-1', name_ar: 'قماش تويل' } as any,
    ]);
    vi.mocked(financeApi.financeApi.getPurchasedItems).mockResolvedValue({
      summary: {
        lines_count: 12,
        distinct_items_count: 4,
        total_invoiced_quantity: 450,
        total_received_quantity: 400,
        total_amount: 36000,
        prices_visible: true,
      },
      items: [
        {
          line_id: 'pl-1',
          invoice_id: 'inv-1',
          internal_number: 'SINV-001',
          invoice_number: 'INV-99',
          invoice_date: '2026-11-10',
          invoice_status: 'partially_received',
          supplier_id: 'sup-1',
          supplier_name: 'مورد الأقمشة',
          item_id: 'cat-1',
          item_code: 'RAW-1',
          item_name_ar: 'قماش تويل',
          category_id: 'catg-1',
          category_name_ar: 'أقمشة',
          item_type: 'fabric',
          unit_name_ar: 'متر',
          invoiced_quantity: 100,
          received_quantity: 80,
          remaining_quantity: 20,
          unit_price: 80,
          net_unit_cost: 80,
          line_total: 8000,
        } as any,
      ],
    } as any);

    const { container } = render(<PurchasedItemsView />);

    // 1. Summary Cards Verification
    expect(await screen.findByText('عدد بنود الشراء')).toBeInTheDocument();
    expect(screen.getByText('عدد الأصناف الفريدة')).toBeInTheDocument();
    expect(screen.getByText('إجمالي الكمية المفوترة')).toBeInTheDocument();
    expect(screen.getByText('إجمالي الكمية المستلمة فعلياً')).toBeInTheDocument();
    expect(screen.getByText('إجمالي قيمة المشتريات المفلترة')).toBeInTheDocument();

    const kpiCards = container.querySelectorAll('.warehouse-kpi-card');
    expect(kpiCards.length).toBe(5);

    // 2. Filters Verification
    const filterBar = container.querySelector('.items-filter-bar');
    expect(filterBar).toBeInTheDocument();
    expect(container.querySelectorAll('.items-filter-input').length).toBeGreaterThanOrEqual(3);
    expect(container.querySelectorAll('.items-filter-select').length).toBeGreaterThanOrEqual(4);

    const resetBtn = screen.getByRole('button', { name: /مسح الفلاتر/ });
    expect(resetBtn).toBeInTheDocument();
    expect(resetBtn.className).toContain('items-filter-btn--reset');

    // 3. Table Verification
    const tableCard = container.querySelector('.items-table-card');
    expect(tableCard).toBeInTheDocument();
    const table = container.querySelector('.items-table');
    expect(table).toBeInTheDocument();

    expect(screen.getByText('الفاتورة المصدرية')).toBeInTheDocument();
    expect(screen.getByText('SINV-001')).toBeInTheDocument();
    expect(screen.getByText('قماش تويل')).toBeInTheDocument();
  });
});

describe('SoldItemsView UI Component Repair Verification', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders summary cards, filters, and data table with exact sold items columns', async () => {
    vi.mocked(customersApi.fetchCustomers).mockResolvedValue([
      { id: 'cus-1', code: 'C1', name: 'عميل النور' } as any,
    ]);
    vi.mocked(prodApi.fetchProducts).mockResolvedValue([
      { id: 'prd-1', code: 'PRD-1', name_ar: 'قميص صيفي' } as any,
    ]);
    vi.mocked(customersApi.fetchSoldItems).mockResolvedValue({
      summary: {
        lines_count: 8,
        distinct_products_count: 2,
        total_delivered_quantity: 120,
        total_returned_quantity: 10,
        total_net_sold_quantity: 110,
        total_delivered_value: 24000,
        total_returned_value: 2000,
        total_net_sold_value: 22000,
      },
      items: [
        {
          delivery_line_id: 'dl-1',
          delivered_at: '2026-11-12',
          delivery_id: 'del-1',
          delivery_number: 'DLV-001',
          order_id: 'ord-1',
          order_number: 'SO-001',
          customer_id: 'cus-1',
          customer_name: 'عميل النور',
          customer_code: 'C1',
          product_id: 'prd-1',
          product_code: 'PRD-1',
          product_name: 'قميص صيفي',
          variant_info: 'مقاس 56',
          order_type: 'ready_goods',
          delivered_quantity: 20,
          returned_quantity: 2,
          net_sold_quantity: 18,
          unit_price: 200,
          net_unit_price: 200,
          net_sold_value: 3600,
        } as any,
      ],
    } as any);

    const { container } = render(<SoldItemsView />);

    // 1. Summary Cards Verification
    expect(await screen.findByText('عدد حركات البيع')).toBeInTheDocument();
    expect(screen.getByText('عدد الموديلات المباعة')).toBeInTheDocument();
    expect(screen.getByText('المسلّم / المرتجع / الصافي')).toBeInTheDocument();
    expect(screen.getByText('صافي قيمة المبيعات')).toBeInTheDocument();

    const kpiCards = container.querySelectorAll('.warehouse-kpi-card');
    expect(kpiCards.length).toBe(4);

    // 2. Filters Verification
    const filterBar = container.querySelector('.items-filter-bar');
    expect(filterBar).toBeInTheDocument();
    const resetBtn = screen.getByRole('button', { name: /مسح الفلاتر/ });
    expect(resetBtn).toBeInTheDocument();
    expect(resetBtn.className).toContain('items-filter-btn--reset');

    // 3. Table Verification
    const tableCard = container.querySelector('.items-table-card');
    expect(tableCard).toBeInTheDocument();
    const table = container.querySelector('.items-table');
    expect(table).toBeInTheDocument();

    expect(screen.getByText('المستند / الطلب')).toBeInTheDocument();
    expect(screen.getByText('DLV-001')).toBeInTheDocument();
    expect(screen.getByText('قميص صيفي')).toBeInTheDocument();
  });
});
