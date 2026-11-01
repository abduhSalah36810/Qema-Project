import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CatalogManagementView } from './CatalogManagementView';
import * as catalogApi from './catalogApi';

// Sample mock data matching backend schema
const mockCategories: catalogApi.ItemCategory[] = [
  {
    id: 'cat-1',
    code: 'FABRICS_MAIN',
    name_ar: 'الأقمشة والخامات الرئيسية',
    name_en: 'Main Fabrics',
    parent_id: null,
    description: 'أقمشة القطن والكتان والبوليستر',
    is_active: true,
    sort_order: 10,
  },
  {
    id: 'cat-1-1',
    code: 'FAB_COTTON',
    name_ar: 'أقمشة قطنية',
    name_en: 'Cotton Fabrics',
    parent_id: 'cat-1',
    description: 'أقمشة قطن مصري صافي',
    is_active: true,
    sort_order: 11,
  },
];

const mockCategoriesTree: catalogApi.ItemCategoryTree[] = [
  {
    id: 'cat-1',
    code: 'FABRICS_MAIN',
    name_ar: 'الأقمشة والخامات الرئيسية',
    name_en: 'Main Fabrics',
    parent_id: null,
    description: 'أقمشة القطن والكتان والبوليستر',
    is_active: true,
    sort_order: 10,
    subcategories: [
      {
        id: 'cat-1-1',
        code: 'FAB_COTTON',
        name_ar: 'أقمشة قطنية',
        name_en: 'Cotton Fabrics',
        parent_id: 'cat-1',
        description: 'أقمشة قطن مصري صافي',
        is_active: true,
        sort_order: 11,
        subcategories: [],
      },
    ],
  },
];

const mockUnits: catalogApi.Unit[] = [
  { id: 'unit-piece', code: 'piece', name_ar: 'قطعة' },
  { id: 'unit-meter', code: 'meter', name_ar: 'متر' },
  { id: 'unit-kg', code: 'kg', name_ar: 'كيلو جرام' },
];

const mockApplicationLines: catalogApi.ApplicationLine[] = [
  {
    id: 'app-general',
    code: 'GENERAL',
    name_ar: 'عام لجميع الملابس',
    name_en: 'General Apparel',
    description: 'خامات ومستلزمات عامة مشتركة لجميع المنتجات',
    is_active: true,
    sort_order: 1,
  },
  {
    id: 'app-jalabiya',
    code: 'JALABIYA',
    name_ar: 'جلابية رجالي',
    name_en: 'Men Jalabiya',
    description: 'خامات وتطريزات وتجهيزات الجلابية الرجالي',
    is_active: true,
    sort_order: 2,
  },
];

const mockCatalogItems: catalogApi.CatalogItem[] = [
  {
    id: 'item-1',
    code: 'FAB-COT-01',
    name_ar: 'قماش قطن أبيض 100%',
    item_type: 'fabric',
    unit_id: 'unit-meter',
    unit_name_ar: 'متر',
    is_consumable: true,
    is_active: true,
    category_id: 'cat-1-1',
    classification_status: 'confirmed',
    attributes: { width_cm: 150, weight_gsm: 180 },
    reorder_level: 50,
    approval_status: 'approved',
    has_pending_revision: false,
  },
  {
    id: 'item-2',
    code: 'TRM-BTN-14',
    name_ar: 'زرار صدف جلابية 14مم',
    item_type: 'accessory',
    unit_id: 'unit-piece',
    unit_name_ar: 'قطعة',
    is_consumable: true,
    is_active: true,
    category_id: null,
    classification_status: 'needs_review',
    attributes: { diameter_mm: 14 },
    reorder_level: 100,
    approval_status: 'draft',
    has_pending_revision: false,
  },
  {
    id: 'item-fg-1',
    code: 'FG-VAR-101-56',
    name_ar: 'جلابية رجالي مطرزة - مقاس 56',
    item_type: 'finished_garment',
    unit_id: 'unit-piece',
    unit_name_ar: 'قطعة',
    is_consumable: false,
    is_active: true,
    category_id: null,
    classification_status: 'not_applicable',
    attributes: {},
    reorder_level: 0,
    approval_status: 'approved',
    has_pending_revision: false,
  },
];

const mockItemDetail: catalogApi.CatalogItemDetail = {
  id: 'item-1',
  code: 'FAB-COT-01',
  name_ar: 'قماش قطن أبيض 100%',
  item_type: 'fabric',
  unit_id: 'unit-meter',
  unit_name_ar: 'متر',
  is_consumable: true,
  is_active: true,
  category_id: 'cat-1-1',
  classification_status: 'confirmed',
  attributes: { width_cm: 150, weight_gsm: 180 },
  reorder_level: 50,
  approval_status: 'approved',
  has_pending_revision: false,
  pending_revision: null,
  category: mockCategories[1],
  unit: mockUnits[1],
  usages: [mockApplicationLines[1]],
};

describe('Catalog Management Feature — Frontend Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(catalogApi, 'fetchCategories').mockResolvedValue(mockCategories);
    vi.spyOn(catalogApi, 'fetchCategoriesTree').mockResolvedValue(mockCategoriesTree);
    vi.spyOn(catalogApi, 'fetchUnits').mockResolvedValue(mockUnits);
    vi.spyOn(catalogApi, 'fetchApplicationLines').mockResolvedValue(mockApplicationLines);
    vi.spyOn(catalogApi, 'fetchCatalogItems').mockResolvedValue(mockCatalogItems);
    vi.spyOn(catalogApi, 'getCatalogItem').mockResolvedValue(mockItemDetail);
    vi.spyOn(catalogApi, 'createCatalogItem').mockResolvedValue(mockCatalogItems[0]);
    vi.spyOn(catalogApi, 'updateCatalogItem').mockResolvedValue(mockCatalogItems[0]);
    vi.spyOn(catalogApi, 'createCategory').mockResolvedValue(mockCategories[0]);
    vi.spyOn(catalogApi, 'fetchItemRevisions').mockResolvedValue([]);
    vi.spyOn(catalogApi, 'fetchItemHistory').mockResolvedValue([]);
  });

  it('1. renders Catalog view with header, KPI cards, tabs, and items table', async () => {
    render(<CatalogManagementView />);

    // Header check
    expect(
      screen.getByText('دليل الأصناف والتصنيفات وخطوط الاستخدام')
    ).toBeInTheDocument();

    // Tabs check
    expect(screen.getByRole('button', { name: /دليل الأصناف/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /شجرة التصنيفات/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /خطوط الاستخدام/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /دليل الوحدات المرجعي/ })).toBeInTheDocument();

    // Wait for items to load in table
    await waitFor(() => {
      expect(screen.getByText('قماش قطن أبيض 100%')).toBeInTheDocument();
      expect(screen.getByText('زرار صدف جلابية 14مم')).toBeInTheDocument();
      expect(screen.getByText('جلابية رجالي مطرزة - مقاس 56')).toBeInTheDocument();
    });

    // KPI cards check
    expect(screen.getByText('إجمالي أصناف الدليل')).toBeInTheDocument();
    expect(screen.getByText('أصناف معتمدة للتشغيل')).toBeInTheDocument();
    expect(screen.getByText('مسودات ومرفوضات')).toBeInTheDocument();
    expect(screen.getByText('التصنيفات النشطة')).toBeInTheDocument();
  });

  it('2. switches between tabs (Categories Tree, Application Lines, Units)', async () => {
    render(<CatalogManagementView />);

    // Switch to Categories Tree
    const catTab = screen.getByRole('button', { name: /شجرة التصنيفات/ });
    fireEvent.click(catTab);

    await waitFor(() => {
      expect(screen.getByText('شجرة التصنيفات الهرمية')).toBeInTheDocument();
      expect(screen.getByText('الأقمشة والخامات الرئيسية')).toBeInTheDocument();
    });

    // Switch to Application Lines
    const appTab = screen.getByRole('button', { name: /خطوط الاستخدام/ });
    fireEvent.click(appTab);

    await waitFor(() => {
      expect(screen.getByText('خطوط الاستخدام وتطبيقات الملابس')).toBeInTheDocument();
      expect(screen.getByText('عام لجميع الملابس')).toBeInTheDocument();
      expect(screen.getByText('جلابية رجالي')).toBeInTheDocument();
    });

    // Switch to Units Reference
    const unitsTab = screen.getByRole('button', { name: /دليل الوحدات المرجعي/ });
    fireEvent.click(unitsTab);

    await waitFor(() => {
      expect(screen.getByText('دليل وحدات القياس المعتمدة')).toBeInTheDocument();
      expect(screen.getByText('قطعة')).toBeInTheDocument();
      expect(screen.getByText('متر')).toBeInTheDocument();
      expect(screen.getByText('كيلو جرام')).toBeInTheDocument();
    });
  });

  it('3. opens Item Details Drawer with specifications and application usages', async () => {
    render(<CatalogManagementView />);

    await waitFor(() => {
      expect(screen.getByText('قماش قطن أبيض 100%')).toBeInTheDocument();
    });

    // Click on "عرض وتعديل" for item 1
    const editButtons = screen.getAllByRole('button', { name: 'عرض وتعديل' });
    fireEvent.click(editButtons[0]);

    await waitFor(() => {
      expect(screen.getByText('بطاقة مواصفات وحوكمة الصنف')).toBeInTheDocument();
      expect(screen.getByDisplayValue('FAB-COT-01')).toBeInTheDocument();
      expect(screen.getByDisplayValue('150')).toBeInTheDocument(); // width_cm
      expect(screen.getByDisplayValue('180')).toBeInTheDocument(); // weight_gsm
    });

    // Close drawer
    const closeBtn = screen.getByRole('button', { name: 'إغلاق البطاقة' });
    fireEvent.click(closeBtn);

    await waitFor(() => {
      expect(screen.queryByText('بطاقة مواصفات وحوكمة الصنف')).not.toBeInTheDocument();
    });
  });

  it('4. displays Finished Goods protection alert when inspecting an FG-VAR item', async () => {
    vi.spyOn(catalogApi, 'getCatalogItem').mockResolvedValueOnce({
      ...mockItemDetail,
      id: 'item-fg-1',
      code: 'FG-VAR-101-56',
      name_ar: 'جلابية رجالي مطرزة - مقاس 56',
      item_type: 'finished_garment',
      approval_status: 'approved',
      has_pending_revision: false,
      usages: [],
    });

    render(<CatalogManagementView />);

    await waitFor(() => {
      expect(screen.getByText('جلابية رجالي مطرزة - مقاس 56')).toBeInTheDocument();
    });

    const editButtons = screen.getAllByRole('button', { name: 'عرض وتعديل' });
    // Item 3 is FG
    fireEvent.click(editButtons[2]);

    await waitFor(() => {
      expect(screen.getByText(/صنف معتمد ومحمي/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'حذف الصنف' })).not.toBeInTheDocument();
    });
  });

  it('5. opens Create Item Modal and rejects Finished Goods FG-* code prefix', async () => {
    render(<CatalogManagementView />);

    await waitFor(() => {
      expect(screen.getByText('قماش قطن أبيض 100%')).toBeInTheDocument();
    });

    const addButtons = screen.getAllByRole('button', { name: '＋ إضافة صنف جديد' });
    fireEvent.click(addButtons[0]);

    await waitFor(() => {
      expect(screen.getByText('إضافة صنف جديد للدليل')).toBeInTheDocument();
    });

    // Fill code with FG- prefix
    const codeInput = screen.getByPlaceholderText(/FAB-COTTON-01/);
    fireEvent.change(codeInput, { target: { value: 'FG-NEW-ITEM' } });

    const nameInput = screen.getByPlaceholderText(/قماش قطن مصري/);
    fireEvent.change(nameInput, { target: { value: 'منتج غير مصرح به' } });

    const unitSelect = screen.getByLabelText(/الوحدة الأساسية/);
    fireEvent.change(unitSelect, { target: { value: 'unit-piece' } });

    const submitBtn = screen.getByRole('button', { name: '＋ إضافة الصنف للدليل' });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(
        screen.getByText(/لا يُسمح بإنشاء منتجات تامة \(FG-\*\) من هذه الواجهة/)
      ).toBeInTheDocument();
    });

    expect(catalogApi.createCatalogItem).not.toHaveBeenCalled();
  });

  it('6. expands and collapses tree subcategories in Categories Explorer', async () => {
    render(<CatalogManagementView />);

    // Switch to Categories Tree
    const catTab = screen.getByRole('button', { name: /شجرة التصنيفات/ });
    fireEvent.click(catTab);

    await waitFor(() => {
      expect(screen.getByText('الأقمشة والخامات الرئيسية')).toBeInTheDocument();
    });

    // Expand category
    const toggleBtn = screen.getByRole('button', { name: 'توسيع التصنيف' });
    fireEvent.click(toggleBtn);

    await waitFor(() => {
      expect(screen.getByText('أقمشة قطنية')).toBeInTheDocument();
      expect(screen.getByText('FAB_COTTON')).toBeInTheDocument();
    });
  });

  it('7. renders approval badges and revision request flow in drawer', async () => {
    render(<CatalogManagementView />);

    await waitFor(() => {
      expect(screen.getByText('قماش قطن أبيض 100%')).toBeInTheDocument();
    });

    const editButtons = screen.getAllByRole('button', { name: 'عرض وتعديل' });
    fireEvent.click(editButtons[0]);

    await waitFor(() => {
      expect(screen.getByText('بطاقة مواصفات وحوكمة الصنف')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '📝 طلب تعديل الصنف' })).toBeInTheDocument();
    });

    // Click request revision button
    const revBtn = screen.getByRole('button', { name: '📝 طلب تعديل الصنف' });
    fireEvent.click(revBtn);

    await waitFor(() => {
      expect(
        screen.getByText('تقديم طلب تعديل (Revision) للصنف المعتمد')
      ).toBeInTheDocument();
    });
  });
});
