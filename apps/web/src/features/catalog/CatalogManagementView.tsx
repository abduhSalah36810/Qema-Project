import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  CatalogFilterParams,
  CatalogItem,
  ItemCategory,
  ItemCategoryTree,
  ApplicationLine,
  Unit,
  fetchCatalogItems,
  fetchCategories,
  fetchCategoriesTree,
  fetchApplicationLines,
  fetchUnits,
} from './catalogApi';
import { CatalogOverviewKPIs } from './CatalogOverviewKPIs';
import { CatalogItemsTable } from './CatalogItemsTable';
import { ItemDetailDrawer } from './ItemDetailDrawer';
import { ItemCreateModal } from './ItemCreateModal';
import { CategoriesExplorer } from './CategoriesExplorer';
import { ApplicationLinesView } from './ApplicationLinesView';
import { UnitsReferenceView } from './UnitsReferenceView';
import { ApiError } from '@/lib/api';

type TabKey = 'items' | 'categories' | 'applications' | 'units';

const PAGE_SIZE = 50;

export const CatalogManagementView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabKey>('items');

  // Shared Reference Data
  const [categories, setCategories] = useState<ItemCategory[]>([]);
  const [categoriesTree, setCategoriesTree] = useState<ItemCategoryTree[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [applicationLines, setApplicationLines] = useState<ApplicationLine[]>([]);
  const [refLoading, setRefLoading] = useState(true);
  const [refError, setRefError] = useState<string | null>(null);

  // Items State
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(true);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [filterParams, setFilterParams] = useState<CatalogFilterParams>({
    limit: PAGE_SIZE,
    offset: 0,
    search: '',
    category_id: 'all',
    item_type: 'all',
    classification_status: 'all',
    unit_id: 'all',
    application_line_id: 'all',
  });

  // Drawer & Modal State
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [createModalOpen, setCreateModalOpen] = useState(false);

  // Load Shared Reference Data
  const loadReferenceData = useCallback(async () => {
    setRefLoading(true);
    setRefError(null);
    try {
      const [cats, tree, uList, appLines] = await Promise.all([
        fetchCategories(),
        fetchCategoriesTree(),
        fetchUnits(),
        fetchApplicationLines(),
      ]);
      setCategories(cats);
      setCategoriesTree(tree);
      setUnits(uList);
      setApplicationLines(appLines);
    } catch (err: unknown) {
      setRefError(
        err instanceof ApiError ? err.message : 'تعذر تحميل البيانات المرجعية للدليل.'
      );
    } finally {
      setRefLoading(false);
    }
  }, []);

  // Load Catalog Items
  const loadItems = useCallback(async () => {
    setItemsLoading(true);
    setItemsError(null);
    try {
      const data = await fetchCatalogItems(filterParams);
      setItems(data);
    } catch (err: unknown) {
      setItemsError(
        err instanceof ApiError ? err.message : 'تعذر تحميل أصناف الدليل من الخادم.'
      );
      setItems([]);
    } finally {
      setItemsLoading(false);
    }
  }, [filterParams]);

  useEffect(() => {
    void loadReferenceData();
  }, [loadReferenceData]);

  useEffect(() => {
    void loadItems();
  }, [loadItems]);

  // Derived KPI Counts
  const kpiData = useMemo(() => {
    const total = items.length;
    const approved = items.filter((i) => i.approval_status === 'approved').length;
    const pendingReview = items.filter((i) => i.approval_status === 'pending_review').length;
    const drafts = items.filter(
      (i) => i.approval_status === 'draft' || i.approval_status === 'rejected'
    ).length;
    const openRevisions = items.filter((i) => i.has_pending_revision).length;
    const confirmed = items.filter((i) => i.classification_status === 'confirmed').length;
    const needsReview = items.filter(
      (i) => i.classification_status === 'needs_review'
    ).length;
    const activeCats = categories.filter((c) => c.is_active).length;

    return {
      total,
      approved,
      pendingReview,
      drafts,
      openRevisions,
      confirmed,
      needsReview,
      activeCats,
    };
  }, [items, categories]);

  // Filter handlers
  const handleFilterChange = (newParams: Partial<CatalogFilterParams>) => {
    setFilterParams((prev) => ({ ...prev, ...newParams }));
  };

  const handleResetFilters = () => {
    setFilterParams({
      limit: PAGE_SIZE,
      offset: 0,
      search: '',
      category_id: 'all',
      item_type: 'all',
      classification_status: 'all',
      unit_id: 'all',
      application_line_id: 'all',
    });
  };

  const handleSelectCategoryFilter = (categoryId: string) => {
    setFilterParams((prev) => ({
      ...prev,
      category_id: categoryId,
      offset: 0,
    }));
    setActiveTab('items');
  };

  const handleSelectLineFilter = (lineId: string) => {
    setFilterParams((prev) => ({
      ...prev,
      application_line_id: lineId,
      offset: 0,
    }));
    setActiveTab('items');
  };

  return (
    <div className="catalog-page" dir="rtl">
      {/* رأس الصفحة مع عنوان إداري وأزرار تنقل */}
      <header className="catalog-page__header">
        <div className="catalog-page__title-wrap">
          <span className="catalog-page__eyebrow">إدارة المخزون والتوصيف القياسي</span>
          <h1 className="catalog-page__title">دليل الأصناف والتصنيفات وخطوط الاستخدام</h1>
          <p className="catalog-page__subtitle">
            سجل موحد وشامل للخامات والمستلزمات وقطع الغيار والتعبئة والمنتجات التامة، مصنف هرمياً لخدمة كافة خطوط التشغيل.
          </p>
        </div>

        <div className="catalog-page__header-actions">
          <button
            type="button"
            onClick={() => setCreateModalOpen(true)}
            className="btn-teal"
          >
            ＋ إضافة صنف جديد
          </button>
        </div>
      </header>

      {/* بطاقات المؤشرات السريعة (KPI Overview) */}
      <CatalogOverviewKPIs
        totalItems={kpiData.total}
        approvedCount={kpiData.approved}
        pendingReviewCount={kpiData.pendingReview}
        draftsCount={kpiData.drafts}
        openRevisionsCount={kpiData.openRevisions}
        confirmedCount={kpiData.confirmed}
        needsReviewCount={kpiData.needsReview}
        activeCategoriesCount={kpiData.activeCats}
        loading={itemsLoading || refLoading}
        onFilterApproval={(status) => {
          handleFilterChange({ approval_status: status, offset: 0 });
          setActiveTab('items');
        }}
      />

      {/* شريط التبويبات الرئيسي (Sub-Navigation Tabs) */}
      <nav className="catalog-tabs" aria-label="أقسام دليل الأصناف">
        <button
          type="button"
          className={`catalog-tab ${activeTab === 'items' ? 'catalog-tab--active' : ''}`}
          onClick={() => setActiveTab('items')}
          aria-current={activeTab === 'items' ? 'page' : undefined}
        >
          <span className="catalog-tab__icon" aria-hidden>📦</span>
          <span>دليل الأصناف</span>
          <span className="catalog-tab__badge">{items.length}</span>
        </button>

        <button
          type="button"
          className={`catalog-tab ${
            activeTab === 'categories' ? 'catalog-tab--active' : ''
          }`}
          onClick={() => setActiveTab('categories')}
          aria-current={activeTab === 'categories' ? 'page' : undefined}
        >
          <span className="catalog-tab__icon" aria-hidden>🗂️</span>
          <span>شجرة التصنيفات</span>
          <span className="catalog-tab__badge">{categories.length}</span>
        </button>

        <button
          type="button"
          className={`catalog-tab ${
            activeTab === 'applications' ? 'catalog-tab--active' : ''
          }`}
          onClick={() => setActiveTab('applications')}
          aria-current={activeTab === 'applications' ? 'page' : undefined}
        >
          <span className="catalog-tab__icon" aria-hidden>🧵</span>
          <span>خطوط الاستخدام</span>
          <span className="catalog-tab__badge">{applicationLines.length}</span>
        </button>

        <button
          type="button"
          className={`catalog-tab ${activeTab === 'units' ? 'catalog-tab--active' : ''}`}
          onClick={() => setActiveTab('units')}
          aria-current={activeTab === 'units' ? 'page' : undefined}
        >
          <span className="catalog-tab__icon" aria-hidden>📏</span>
          <span>دليل الوحدات المرجعي</span>
          <span className="catalog-tab__badge">{units.length}</span>
        </button>
      </nav>

      {/* محتوى القسم النشط */}
      <main className="catalog-canvas">
        {activeTab === 'items' && (
          <CatalogItemsTable
            items={items}
            loading={itemsLoading}
            error={itemsError}
            onRefresh={() => void loadItems()}
            onSelectItem={(id) => setSelectedItemId(id)}
            onOpenCreateModal={() => setCreateModalOpen(true)}
            categories={categories}
            units={units}
            filterParams={filterParams}
            onFilterChange={handleFilterChange}
            onResetFilters={handleResetFilters}
            pageSize={PAGE_SIZE}
          />
        )}

        {activeTab === 'categories' && (
          <CategoriesExplorer
            tree={categoriesTree}
            flatCategories={categories}
            loading={refLoading}
            error={refError}
            onRefresh={() => void loadReferenceData()}
            onSelectCategoryFilter={handleSelectCategoryFilter}
          />
        )}

        {activeTab === 'applications' && (
          <ApplicationLinesView
            lines={applicationLines}
            loading={refLoading}
            error={refError}
            onRefresh={() => void loadReferenceData()}
            onSelectLineFilter={handleSelectLineFilter}
          />
        )}

        {activeTab === 'units' && (
          <UnitsReferenceView
            units={units}
            loading={refLoading}
            error={refError}
            onRefresh={() => void loadReferenceData()}
          />
        )}
      </main>

      {/* بطاقة تفاصيل الصنف (Item Detail Drawer) */}
      <ItemDetailDrawer
        itemId={selectedItemId}
        isOpen={Boolean(selectedItemId)}
        onClose={() => setSelectedItemId(null)}
        onItemUpdated={() => {
          void loadItems();
          void loadReferenceData();
        }}
        categories={categories}
        units={units}
        allApplicationLines={applicationLines}
      />

      {/* نافذة إضافة صنف جديد (Item Create Modal) */}
      <ItemCreateModal
        isOpen={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        onItemCreated={() => {
          void loadItems();
        }}
        categories={categories}
        units={units}
        applicationLines={applicationLines}
      />
    </div>
  );
};
