import React, { useState, useEffect } from 'react';
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

export const ProductionOrdersView: React.FC = () => {
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
      } catch (err) {
        console.error('Failed to load production data', err);
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
  const filteredOrders = orders.filter((o) => {
    const matchesStatus =
      statusFilter === 'all' ||
      (statusFilter === 'draft' && o.status === 'draft') ||
      (statusFilter === 'dispatched' && o.status === 'materials_dispatched') ||
      (statusFilter === 'in_production' && o.status === 'in_production') ||
      (statusFilter === 'completed' && o.status === 'completed');

    const matchesSearch =
      searchQuery.trim() === '' ||
      o.order_number.toLowerCase().includes(searchQuery.toLowerCase()) ||
      o.product_name_ar.includes(searchQuery) ||
      o.variant_info.includes(searchQuery);

    return matchesStatus && matchesSearch;
  });

  // حساب الإحصائيات السريعة
  const totalOrders = orders.length;
  const draftOrders = orders.filter((o) => o.status === 'draft').length;
  const inTransitOrders = orders.filter((o) => o.status === 'materials_dispatched').length;
  const inProdOrders = orders.filter((o) => o.status === 'in_production').length;
  const completedOrders = orders.filter((o) => o.status === 'completed').length;

  return (
    <div className="production-view-container" dir="rtl">
      {/* ── شريط المراحل الخمس الرئيسي ────────────────────────────── */}
      <section className="flow flow--five-stages" aria-label="مراحل تشغيل الدفعات">
        <div className="flow-step">
          <div className="flow-top">
            <span className="flow-no">١</span> المرحلة ٠١
          </div>
          <div className="flow-title">القص على الباترون</div>
          <div className="flow-desc">فرز القماش والقص حسب المقاسات 56-64</div>
          <span className="flow-chevron">‹</span>
        </div>
        <div className="flow-step">
          <div className="flow-top">
            <span className="flow-no">٢</span> المرحلة ٠٢
          </div>
          <div className="flow-title">التشطيب والخياطة</div>
          <div className="flow-desc">تجميع الصدر والظهر والأكمام والياقة</div>
          <span className="flow-chevron">‹</span>
        </div>
        <div className="flow-step">
          <div className="flow-top">
            <span className="flow-no">٣</span> المرحلة ٠٣
          </div>
          <div className="flow-title">تركيب الكبسولة والأزرار</div>
          <div className="flow-desc">تثبيت الأزرار الصدفية والكباسيل</div>
          <span className="flow-chevron">‹</span>
        </div>
        <div className="flow-step">
          <div className="flow-top">
            <span className="flow-no">٤</span> المرحلة ٠٤
          </div>
          <div className="flow-title">الكي والبخار</div>
          <div className="flow-desc">فرد الجلابيب وإزالة الانكماش</div>
          <span className="flow-chevron">‹</span>
        </div>
        <div className="flow-step">
          <div className="flow-top">
            <span className="flow-no">٥</span> المرحلة ٠٥
          </div>
          <div className="flow-title">التعبئة والتغليف</div>
          <div className="flow-desc">الفرز في الأكياس وعلب المصنع</div>
        </div>
      </section>

      {/* ── شريط الأدوات والتحكم ──────────────────────────────────── */}
      <div className="prod-toolbar">
        <div className="prod-toolbar__filters">
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
            className="tool primary"
            id="btnNewOrderModal"
            onClick={() => setIsNewModalOpen(true)}
          >
            ＋ أمر تشغيل جديد
          </button>
        </div>
      </div>

      {/* ── المخطط الشبكي: قائمة الأوامر + اللوحة الجانبية ───────────── */}
      <div className="layout">
        {/* العمود الأيمن: قائمة أوامر التشغيل */}
        <div className="column">
          <article className="board">
            <div className="board-head">
              <div>
                <h2>أوامر تشغيل المصنع (Production Orders)</h2>
                <p>متابعة لقطات الخامات المعتمدة وتدفق المراحل على خطوط الإنتاج</p>
              </div>
              <div className="live">
                <span></span>متابعة حية
              </div>
            </div>

            {isLoading ? (
              <div className="loading-state">جاري تحميل أوامر التشغيل...</div>
            ) : filteredOrders.length === 0 ? (
              <div className="empty-state">
                <p>لا توجد أوامر مطابقة لخيارات التصفية الحالية.</p>
                <button
                  className="btn btn--secondary btn--sm"
                  onClick={() => setIsNewModalOpen(true)}
                >
                  إنشاء أمر تشغيل جديد الآن
                </button>
              </div>
            ) : (
              <div className="batch-list">
                {filteredOrders.map((ord) => {
                  // حساب المرحلة الجارية
                  const activeStage = ord.stage_events.find((s) => s.status === 'in_progress');
                  const completedCount = ord.stage_events.filter((s) => s.status === 'completed').length;
                  const progressPct = Math.round((completedCount / 5) * 100);

                  return (
                    <div key={ord.id} className="batch batch--extended">
                      {/* معلومات الدفعة والموديل */}
                      <div>
                        <div className="batch-id">
                          {ord.order_number} · {ord.assigned_to || 'خط الإنتاج العام'}
                        </div>
                        <div className="batch-name">
                          <i className="batch-color"></i>
                          {ord.product_name_ar}
                        </div>
                        <div className="batch-variant-tag">{ord.variant_info}</div>
                      </div>

                      {/* مؤشر تقدم المراحل الخمس */}
                      <div className="batch-progress">
                        <div className="progress-meta">
                          <span>
                            {activeStage
                              ? `جارٍ: ${
                                  activeStage.stage_name === 'cutting'
                                    ? 'القص'
                                    : activeStage.stage_name === 'finishing'
                                    ? 'التشطيب'
                                    : activeStage.stage_name === 'snap_installation'
                                    ? 'الكبسولة'
                                    : activeStage.stage_name === 'ironing'
                                    ? 'الكي'
                                    : 'التعبئة'
                                }`
                              : ord.status === 'completed'
                              ? 'اكتملت المراحل'
                              : 'بانتظار البدء'}
                          </span>
                          <span>{ord.target_quantity} قطعة ({progressPct}%)</span>
                        </div>
                        <div className="progress">
                          <i
                            className={progressPct === 100 ? '' : 'amber'}
                            style={{ width: `${progressPct}%` }}
                          ></i>
                        </div>
                        <div className="materials-summary-pill">
                          📋 {ord.materials.length} خامات مجمدة باللقطة
                        </div>
                      </div>

                      {/* حالة الأمر التشغيلية */}
                      <div>
                        <span className={`status status--${ord.status}`}>
                          {ord.status === 'draft' && 'مسودة'}
                          {ord.status === 'materials_dispatched' && 'خامات بالطريق'}
                          {ord.status === 'in_production' && 'قيد التشغيل'}
                          {ord.status === 'completed' && 'مكتمل'}
                        </span>
                      </div>

                      {/* زر الإجراء والتفاصيل */}
                      <div>
                        <button
                          className="tool tool--details"
                          onClick={() => setSelectedOrder(ord)}
                        >
                          التفاصيل والخامات ‹
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </article>
        </div>

        {/* العمود الأيسر: لوحة افتراضات اجتماع المصنع */}
        <aside className="column">
          <article className="side-panel">
            <div className="side-head">
              <div>
                <h2>افتراضات اجتماع المصنع</h2>
                <p>قواعد مبدئية قابلة للمراجعة والتعديل غداً</p>
              </div>
              <small className="badge-tag badge-tag--amber">مسودة مراجعة</small>
            </div>

            <div className="assumptions-list">
              <div className="assumption-item">
                <span className="assumption-icon">📐</span>
                <div>
                  <strong>التناسب الحسابي للكميات:</strong>
                  <p>تُحسب كميات الخامات بتناسب خطي بسيط مع الكمية المرجعية للقالب.</p>
                </div>
              </div>

              <div className="assumption-item">
                <span className="assumption-icon">❄️</span>
                <div>
                  <strong>تجميد لقطة الخامات (Snapshot):</strong>
                  <p>تُنسخ خامات القالب وتُجمد بالأمر لحمايته من أي تعديل مستقبلي للقالب.</p>
                </div>
              </div>

              <div className="assumption-item">
                <span className="assumption-icon">📦</span>
                <div>
                  <strong>دورة التحويل والاستلام المخزني:</strong>
                  <p>صرف الخامات يسجلها بالطريق، وتأكيد أمين المخزن يوثق الفروقات دون مسح الأثر.</p>
                </div>
              </div>

              <div className="assumption-item">
                <span className="assumption-icon">⛓️</span>
                <div>
                  <strong>التتابع الإلزامي للمراحل:</strong>
                  <p>القص ‹ التشطيب ‹ الكبسولة ‹ الكي ‹ التعبئة. لا يُسمح بتخطي المراحل.</p>
                </div>
              </div>

              <div className="assumption-item">
                <span className="assumption-icon">🔒</span>
                <div>
                  <strong>سياسة الحظر الافتراضي (Deny-by-default):</strong>
                  <p>التحقق خادمي صارم؛ أمين المخزن يؤكد الاستلام، والمدير العام يملك تحريك المراحل.</p>
                </div>
              </div>
            </div>
          </article>

          <div className="note">
            <b>تنبيه اجتماع الغد</b>
            <br />
            لم يتم احتساب تكاليف الإنتاج، الهالك، الأجور بالقطعة، أو مردودات الخامات في هذا الإصدار، وتُطرح كبنود نقاش للاعتماد النهائي.
          </div>
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
          order={selectedOrder}
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
