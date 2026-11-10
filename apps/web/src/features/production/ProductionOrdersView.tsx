import React, { useState, useEffect } from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import {
  ProductionOrder,
  Product,
  ProductionTemplate,
  CatalogItem,
  fetchCatalogItems,
  fetchOrders,
  fetchProducts,
  fetchTemplates,
} from './productionApi';
import { NewOrderModal } from './NewOrderModal';
import { OrderDetailModal } from './OrderDetailModal';
import { nextStep, ORDER_STATUS_LABEL } from './orderWorkflow';
import type { NavFocus, OrderDetailTab } from '@/lib/navigation';
import { ApiError } from '@/lib/api';

const STAGE_AR: Record<string, string> = {
  cutting: 'القص',
  finishing: 'التقفيل والخياطة',
  snap_installation: 'الكباسين والأزرار',
  ironing: 'الكي',
  packing: 'التعبئة',
};
const STATUS_AR: Record<string, string> = {
  draft: 'مسودة',
  materials_dispatched: 'خامات في الطريق',
  in_production: 'قيد التشغيل',
  manufacturing_completed: 'اكتمل التصنيع',
  receipt_completed: 'تم استلام التام',
  completed: 'مكتمل',
  closed: 'مغلق',
};
const SEASON_AR: Record<string, string> = { summer: 'صيفي', autumn: 'خريفي', winter: 'شتوي' };
const seasonAr = (s?: string | null) => (s ? SEASON_AR[s.toLowerCase()] || s : '');
const sizeOf = (variantInfo?: string | null) => {
  const m = (variantInfo || '').match(/(\d{2,3})/);
  return m ? m[1] : variantInfo || '—';
};

interface ProductionOrdersViewProps {
  /** فتح أمر محدد على قسم محدد (من الصفحة الرئيسية) */
  focus?: NavFocus;
  onFocusHandled?: () => void;
}

export const ProductionOrdersView: React.FC<ProductionOrdersViewProps> = ({ focus, onFocusHandled }) => {
  const { hasPermission, user } = useAuth();
  const canCreateOrder = hasPermission('production:orders:create');

  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [templates, setTemplates] = useState<ProductionTemplate[]>([]);
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);
  const [isCatalogLoading, setIsCatalogLoading] = useState<boolean>(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');

  // حالة النوافذ المنبثقة
  const [isNewModalOpen, setIsNewModalOpen] = useState<boolean>(false);
  const [selectedOrder, setSelectedOrder] = useState<ProductionOrder | null>(null);
  const [selectedTab, setSelectedTab] = useState<OrderDetailTab | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const openOrder = (order: ProductionOrder, tab?: OrderDetailTab) => {
    setSelectedTab(tab);
    setSelectedOrder(order);
  };

  // تحميل البيانات الأولية
  useEffect(() => {
    let isMounted = true;
    const loadData = async () => {
      setIsLoading(true);
      try {
        const [oList, pList, tList] = await Promise.all([
          fetchOrders(),
          fetchProducts(),
          fetchTemplates(),
        ]);
        if (isMounted) {
          setOrders(oList);
          setProducts(pList);
          setTemplates(tList);
        }
        if (isMounted) setLoadError(null);
      } catch (err) {
        if (isMounted) {
          setLoadError(err instanceof ApiError ? err.message : 'تعذر تحميل أوامر التشغيل من الخادم. تحقق من الاتصال ثم اضغط «تحديث».');
        }
      } finally {
        if (isMounted) setIsLoading(false);
      }
      try {
        const items = await fetchCatalogItems();
        if (isMounted) {
          setCatalogItems(items);
          setCatalogError(null);
        }
      } catch (err) {
        console.error('Failed to load catalog items', err);
        if (isMounted) {
          setCatalogItems([]);
          setCatalogError('تعذر تحميل دليل الأصناف من قاعدة البيانات. تحقق من اتصال الخادم ثم أعد تحميل الصفحة.');
        }
      } finally {
        if (isMounted) setIsCatalogLoading(false);
      }
    };
    void loadData();
    return () => {
      isMounted = false;
    };
  }, []);

  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);

  const handleRefreshAll = async () => {
    setIsRefreshing(true);
    try {
      const oList = await fetchOrders();
      setOrders(oList);
      setLoadError(null);
      if (selectedOrder) {
        const freshSelected = oList.find((o) => o.id === selectedOrder.id);
        if (freshSelected) {
          setSelectedOrder(freshSelected);
        }
      }
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'تعذر تحديث قائمة أوامر التشغيل.');
    } finally {
      setIsRefreshing(false);
    }
  };

  useEffect(() => {
    if (!focus?.orderId || isLoading) return;
    const target = orders.find((o) => o.id === focus.orderId);
    if (target) openOrder(target, focus.orderTab);
    onFocusHandled?.();
  }, [focus?.orderId, focus?.orderTab, isLoading, orders]);

  const handleOrderCreated = (newOrder: ProductionOrder) => {
    setOrders((prev) => [newOrder, ...prev]);
  };

  const handleOrderUpdated = (updatedOrder: ProductionOrder) => {
    setOrders((prev) =>
      prev.map((o) => (o.id === updatedOrder.id ? updatedOrder : o))
    );
    if (selectedOrder?.id === updatedOrder.id) {
      setSelectedOrder(updatedOrder);
    }
  };

  // التصفية والبحث
  const isMine = (o: ProductionOrder) => Boolean(nextStep(o, hasPermission, user?.id)?.isMine);
  const myOrdersCount = orders.filter(isMine).length;
  const filteredOrders = orders.filter((o) => {
    const matchesStatus =
      statusFilter === 'all' ||
      (statusFilter === 'mine' && isMine(o)) ||
      (statusFilter === 'draft' && o.status === 'draft') ||
      (statusFilter === 'dispatched' && o.status === 'materials_dispatched') ||
      (statusFilter === 'in_production' && (o.status === 'in_production' || o.status === 'manufacturing_completed')) ||
      (statusFilter === 'completed' && ['completed', 'receipt_completed', 'closed'].includes(o.status));

    const matchesSearch =
      searchQuery.trim() === '' ||
      o.order_number.toLowerCase().includes(searchQuery.toLowerCase()) ||
      o.product_name_ar.includes(searchQuery) ||
      o.variant_info.includes(searchQuery);

    return matchesStatus && matchesSearch;
  });

  // عدد الأوامر الجارية حالياً في كل مرحلة (من بيانات المراحل الفعلية)
  const stageLoad: Record<string, number> = { cutting: 0, finishing: 0, snap_installation: 0, ironing: 0, packing: 0 };
  for (const o of orders) {
    if (o.status !== 'in_production') continue;
    const current = o.stage_events.find((st) => st.status === 'in_progress');
    if (current && current.stage_name in stageLoad) stageLoad[current.stage_name] += 1;
  }

  // حساب الإحصائيات السريعة
  const totalOrders = orders.length;
  const draftOrders = orders.filter((o) => o.status === 'draft').length;
  const inTransitOrders = orders.filter((o) => o.status === 'materials_dispatched').length;
  const inProdOrders = orders.filter((o) => o.status === 'in_production' || o.status === 'manufacturing_completed').length;
  const completedOrders = orders.filter((o) => ['completed', 'receipt_completed', 'closed'].includes(o.status)).length;

  return (
    <div className="production-view-container" dir="rtl">
      {/* ── شريط المراحل الخمس الرئيسي ────────────────────────────── */}
      <section className="flow flow--five-stages" aria-label="مراحل التصنيع وعدد الأوامر الجارية في كل مرحلة">
        <div className="flow-step">
          <div className="flow-top">
            <span className="flow-no">١</span> المرحلة ٠١
          </div>
          <div className="flow-title">القص على الباترون</div>
          <div className="flow-desc">{stageLoad.cutting ? `${stageLoad.cutting} أمر جارٍ الآن` : 'لا أوامر جارية'}</div>
          <span className="flow-chevron">‹</span>
        </div>
        <div className="flow-step">
          <div className="flow-top">
            <span className="flow-no">٢</span> المرحلة ٠٢
          </div>
          <div className="flow-title">التشطيب والخياطة</div>
          <div className="flow-desc">{stageLoad.finishing ? `${stageLoad.finishing} أمر جارٍ الآن` : 'لا أوامر جارية'}</div>
          <span className="flow-chevron">‹</span>
        </div>
        <div className="flow-step">
          <div className="flow-top">
            <span className="flow-no">٣</span> المرحلة ٠٣
          </div>
          <div className="flow-title">تركيب الكبسولة والأزرار</div>
          <div className="flow-desc">{stageLoad.snap_installation ? `${stageLoad.snap_installation} أمر جارٍ الآن` : 'لا أوامر جارية'}</div>
          <span className="flow-chevron">‹</span>
        </div>
        <div className="flow-step">
          <div className="flow-top">
            <span className="flow-no">٤</span> المرحلة ٠٤
          </div>
          <div className="flow-title">الكي والبخار</div>
          <div className="flow-desc">{stageLoad.ironing ? `${stageLoad.ironing} أمر جارٍ الآن` : 'لا أوامر جارية'}</div>
          <span className="flow-chevron">‹</span>
        </div>
        <div className="flow-step">
          <div className="flow-top">
            <span className="flow-no">٥</span> المرحلة ٠٥
          </div>
          <div className="flow-title">التعبئة والتغليف</div>
          <div className="flow-desc">{stageLoad.packing ? `${stageLoad.packing} أمر جارٍ الآن` : 'لا أوامر جارية'}</div>
        </div>
      </section>

      {/* ── شريط الأدوات والتحكم ──────────────────────────────────── */}
      <div className="prod-toolbar">
        <div className="prod-toolbar__filters">
          <button
            className={`tool ${statusFilter === 'mine' ? 'tool--active' : ''}`}
            onClick={() => setStatusFilter('mine')}
          >
            يحتاج إجرائي ({myOrdersCount})
          </button>
          <button
            className={`tool ${statusFilter === 'all' ? 'tool--active' : ''}`}
            onClick={() => setStatusFilter('all')}
          >
            كل الأوامر ({totalOrders})
          </button>
          <button
            className={`tool ${statusFilter === 'draft' ? 'tool--active' : ''}`}
            onClick={() => setStatusFilter('draft')}
          >
            مسودات ({draftOrders})
          </button>
          <button
            className={`tool ${statusFilter === 'dispatched' ? 'tool--active' : ''}`}
            onClick={() => setStatusFilter('dispatched')}
          >
            بالطريق للتشغيل ({inTransitOrders})
          </button>
          <button
            className={`tool ${statusFilter === 'in_production' ? 'tool--active' : ''}`}
            onClick={() => setStatusFilter('in_production')}
          >
            قيد التشغيل ({inProdOrders})
          </button>
          <button
            className={`tool ${statusFilter === 'completed' ? 'tool--active' : ''}`}
            onClick={() => setStatusFilter('completed')}
          >
            مكتملة ({completedOrders})
          </button>
        </div>

        <div className="prod-toolbar__actions">
          <input
            type="search"
            placeholder="بحث برقم الأمر أو الموديل..."
            className="search-input"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <button
            type="button"
            className="tool"
            onClick={() => void handleRefreshAll()}
            disabled={isLoading || isRefreshing}
            title="تحديث قائمة أوامر التشغيل من الخادم"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}
          >
            {isRefreshing ? 'جاري التحديث...' : '🔄 تحديث'}
          </button>
          {canCreateOrder && (
            <button
              className="tool primary"
              id="btnNewOrderModal"
              onClick={() => setIsNewModalOpen(true)}
            >
              ＋ أمر تشغيل جديد
            </button>
          )}
        </div>
      </div>

      {/* ── المخطط الشبكي: قائمة الأوامر + اللوحة الجانبية ───────────── */}
      <div className="layout">
        {/* العمود الأيمن: قائمة أوامر التشغيل */}
        <div className="column">
          <article className="board">
            <div className="board-head">
              <div>
                <h2>أوامر التشغيل</h2>
                <p>افتح الأمر لتنفيذ خطوته التالية. كل خطوة تتم بواسطة صاحب الدور المسؤول عنها.</p>
              </div>
              <div className="live">
                <span></span>متابعة حية
              </div>
            </div>

            {loadError && (
              <div className="notice notice--error" role="alert">
                <span>{loadError}</span>
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => void handleRefreshAll()}>إعادة المحاولة</button>
              </div>
            )}
            {isLoading ? (
              <div className="loading-state">جاري تحميل أوامر التشغيل...</div>
            ) : filteredOrders.length === 0 ? (
              <div className="empty-state">
                <p>{statusFilter === 'mine' ? 'لا توجد أوامر تنتظر إجراءً منك الآن.' : 'لا توجد أوامر مطابقة لخيارات التصفية الحالية.'}</p>
                {canCreateOrder && (
                  <button
                    className="btn btn--secondary btn--sm"
                    onClick={() => setIsNewModalOpen(true)}
                  >
                    إنشاء أمر تشغيل جديد الآن
                  </button>
                )}
              </div>
            ) : (
              <div className="batch-list">
                {filteredOrders.map((ord) => {
                  const activeStage = ord.stage_events.find((s) => s.status === 'in_progress');
                  const completedCount = ord.stage_events.filter((s) => s.status === 'completed').length;
                  const progressPct = Math.round((completedCount / 5) * 100);
                  const sizes = (ord.items && ord.items.length > 0 ? ord.items : [{ variant_info: ord.variant_info, target_quantity: ord.target_quantity }])
                    .map((it) => `مقاس ${sizeOf(it.variant_info)}: ${Number(it.target_quantity)}`)
                    .join('، ');
                  const step = nextStep(ord, hasPermission, user?.id);
                  return (
                    <div key={ord.id} className="batch batch--extended">
                      <div>
                        <div className="batch-id">{ord.order_number}</div>
                        <div className="batch-name">
                          <i className="batch-color"></i>
                          {ord.product_name_ar}
                        </div>
                        <div className="batch-variant-tag">{sizes} — {seasonAr(ord.season)}</div>
                      </div>

                      <div className="batch-progress">
                        <div className="progress-meta">
                          <span>
                            {ord.status === 'closed'
                              ? 'مغلق'
                              : activeStage
                              ? `جارٍ الآن: ${STAGE_AR[activeStage.stage_name] || activeStage.stage_name}`
                              : completedCount === 5
                              ? 'اكتملت المراحل الخمس'
                              : completedCount > 0
                              ? `أُنجزت ${completedCount} من 5 مراحل`
                              : 'لم تبدأ المراحل'}
                          </span>
                          <span>{Number(ord.target_quantity)} قطعة</span>
                        </div>
                        <div className="progress">
                          <i className={progressPct === 100 ? '' : 'amber'} style={{ width: `${progressPct}%` }}></i>
                        </div>
                        {step && (
                          <div className={`materials-summary-pill ${step.isMine ? 'materials-summary-pill--mine' : ''}`}>
                            {step.isMine ? 'دورك: ' : 'التالي: '}{step.label}{!step.isMine && ` (${step.role})`}
                          </div>
                        )}
                      </div>

                      <div>
                        <span className={`status status--${ord.status}`}>{ORDER_STATUS_LABEL[ord.status] || STATUS_AR[ord.status] || ord.status}</span>
                      </div>

                      <div>
                        <button
                          className={`tool tool--details ${step?.isMine ? 'primary' : ''}`}
                          onClick={() => openOrder(ord, step?.isMine ? step.tab : undefined)}
                        >
                          {step?.isMine ? 'نفّذ الخطوة ‹' : 'فتح الأمر ‹'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </article>
        </div>

        {/* العمود الأيسر: خطوات أمر التشغيل */}
        <aside className="column">
          <article className="side-panel">
            <div className="side-head">
              <div>
                <h2>خطوات أمر التشغيل</h2>
                <p>كل خطوة تسجل حركة في المخازن، فلا تختفي خامات دون أثر.</p>
              </div>
            </div>
            <ol className="assumptions-list" style={{ paddingInlineStart: '1.2rem', margin: 0 }}>
              <li className="assumption-item"><div><strong>إنشاء الأمر</strong><p>الموديل والمقاسات والكميات والخامات المطلوبة (مدير الإنتاج).</p></div></li>
              <li className="assumption-item"><div><strong>صرف الخامات</strong><p>تخرج من مخزن الخامات إلى الطريق للورشة (أمين المخزن).</p></div></li>
              <li className="assumption-item"><div><strong>استلام الخامات بالورشة</strong><p>تدخل رصيد «تحت التشغيل» لهذا الأمر، ويُسجل أي عجز في النقل (مدير الإنتاج).</p></div></li>
              <li className="assumption-item"><div><strong>المراحل الخمس</strong><p>قص ← تقفيل ← كباسين وأزرار ← كي ← تعبئة، بالترتيب.</p></div></li>
              <li className="assumption-item"><div><strong>استلام المنتج التام</strong><p>كمية مقبولة ومرفوضة لكل مقاس، تدخل مخزن التام كل مقاس في رصيده (أمين المخزن).</p></div></li>
              <li className="assumption-item"><div><strong>تسوية الخامات ثم الإغلاق</strong><p>المستهلك والمرتجع للمخزن والهالك حتى يصبح رصيد الورشة صفراً، ثم يغلق المدير الأمر.</p></div></li>
            </ol>
          </article>
        </aside>
      </div>

      {/* النافذة المنبثقة لإنشاء أمر جديد */}
      <NewOrderModal
        isOpen={isNewModalOpen}
        onClose={() => setIsNewModalOpen(false)}
        onOrderCreated={handleOrderCreated}
        products={products}
        templates={templates}
        catalogItems={catalogItems}
        isCatalogLoading={isCatalogLoading}
        catalogError={catalogError}
      />

      {/* النافذة المنبثقة لتفاصيل الأمر ولقطة الخامات والمراحل */}
      {selectedOrder && (
        <OrderDetailModal
          key={`${selectedOrder.id}:${selectedTab ?? ''}`}
          order={selectedOrder}
          initialTab={selectedTab}
          isOpen={Boolean(selectedOrder)}
          onClose={() => setSelectedOrder(null)}
          onOrderUpdated={handleOrderUpdated}
          catalogItems={catalogItems}
          isCatalogLoading={isCatalogLoading}
          catalogError={catalogError}
        />
      )}
    </div>
  );
};
