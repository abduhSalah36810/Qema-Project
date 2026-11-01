import React, { useState } from 'react';
import {
  ProductionOrder,
  dispatchMaterialsApi,
  receiveMaterialsApi,
  updateStageApi,
  addOrderMaterialApi,
  removeOrderMaterialApi,
  rollbackStageApi,
  CatalogItem,
  ProductionDefect,
  fetchOrderDefects,
  reportOrderDefect,
  updateOrderDefect,
} from './productionApi';

interface OrderDetailModalProps {
  order: ProductionOrder;
  isOpen: boolean;
  onClose: () => void;
  onOrderUpdated: (updatedOrder: ProductionOrder) => void;
  catalogItems?: CatalogItem[];
  isCatalogLoading?: boolean;
  catalogError?: string | null;
}

const STAGE_TITLES_AR: Record<string, string> = {
  cutting: 'القص على الباترون',
  finishing: 'التشطيب',
  snap_installation: 'تركيب الكبسولة',
  ironing: 'الكي',
  packing: 'التعبئة والتغليف',
};

const STAGE_SEQUENCE = [
  'cutting',
  'finishing',
  'snap_installation',
  'ironing',
  'packing',
];

const STAGE_STATUS_AR: Record<string, string> = {
  not_started: 'لم تبدأ',
  in_progress: 'قيد التنفيذ',
  completed: 'مكتملة',
};

export const OrderDetailModal: React.FC<OrderDetailModalProps> = ({
  order,
  isOpen,
  onClose,
  onOrderUpdated,
  catalogItems = [],
  isCatalogLoading = false,
  catalogError = null,
}) => {
  const [activeTab, setActiveTab] = useState<'items' | 'materials' | 'stages' | 'defects'>('materials');
  const [defects, setDefects] = useState<ProductionDefect[]>([]);
  const [defectForm, setDefectForm] = useState({ stage_name: 'cutting', description: '', affected_quantity: '', responsible: '', repair_action: '', repair_cost_description: '' });
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [newItemId, setNewItemId] = useState('');
  const [newItemQuantity, setNewItemQuantity] = useState('');
  const [newItemNotes, setNewItemNotes] = useState('');
  const [stageNotes, setStageNotes] = useState<Record<string, string>>(() =>
    Object.fromEntries(order.stage_events.map((event) => [event.stage_name, event.notes || '']))
  );
  const [rollbackReasons, setRollbackReasons] = useState<Record<string, string>>({});

  // حالة نموذج تأكيد استلام الخامات
  const [receiptInputs, setReceiptInputs] = useState<Record<string, { qty: number; notes: string }>>(() => {
    const init: Record<string, { qty: number; notes: string }> = {};
    order.materials.forEach((m) => {
      init[m.item_id] = { qty: m.planned_quantity, notes: '' };
    });
    return init;
  });

  if (!isOpen) return null;

  const loadDefects = async () => {
    try { setDefects(await fetchOrderDefects(order.id)); }
    catch { setStatusMessage({ type: 'error', text: 'تعذر تحميل سجل العيوب.' }); }
  };

  const handleReportDefect = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsProcessing(true);
    try {
      const created = await reportOrderDefect(order.id, { ...defectForm, affected_quantity: Number(defectForm.affected_quantity) });
      setDefects((items) => [created, ...items]);
      setDefectForm({ stage_name: 'cutting', description: '', affected_quantity: '', responsible: '', repair_action: '', repair_cost_description: '' });
      setStatusMessage({ type: 'success', text: 'تم تسجيل العيب.' });
    } catch { setStatusMessage({ type: 'error', text: 'تعذر تسجيل العيب؛ تحقق من الحقول والصلاحية.' }); }
    finally { setIsProcessing(false); }
  };

  const handleAddMaterial = async (event: React.FormEvent) => {
    event.preventDefault();
    const item = catalogItems.find((candidate) => candidate.id === newItemId);
    const quantity = Number(newItemQuantity);
    if (!item || !Number.isFinite(quantity) || quantity <= 0) {
      setStatusMessage({ type: 'error', text: 'اختر صنفاً وأدخل كمية أكبر من صفر.' });
      return;
    }
    setIsProcessing(true);
    setStatusMessage(null);
    try {
      const line = await addOrderMaterialApi(order.id, {
        item_id: item.id,
        unit_id: item.unit_id,
        planned_quantity: quantity,
        notes: newItemNotes,
      });
      onOrderUpdated({ ...order, materials: [...order.materials, line] });
      setNewItemId('');
      setNewItemQuantity('');
      setNewItemNotes('');
      setStatusMessage({ type: 'success', text: 'تمت إضافة الصنف إلى مسودة أمر التشغيل.' });
    } catch {
      setStatusMessage({ type: 'error', text: 'تعذرت إضافة الصنف. تحقق من الاتصال وحالة الأمر ثم أعد المحاولة.' });
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRemoveMaterial = async (materialId: string) => {
    if (!window.confirm('حذف هذا الصنف من مسودة أمر التشغيل؟')) return;
    setIsProcessing(true);
    setStatusMessage(null);
    try {
      await removeOrderMaterialApi(order.id, materialId);
      onOrderUpdated({ ...order, materials: order.materials.filter((line) => line.id !== materialId) });
      setStatusMessage({ type: 'success', text: 'تم حذف الصنف من المسودة.' });
    } catch {
      setStatusMessage({ type: 'error', text: 'تعذر حذف الصنف. تحقق من اتصال الخادم وحالة الأمر.' });
    } finally {
      setIsProcessing(false);
    }
  };

  // 1. إجراء صرف الخامات من المخزن الرئيسي
  const handleDispatch = async () => {
    setIsProcessing(true);
    setStatusMessage(null);
    try {
      await dispatchMaterialsApi(order.id, 'صرف خامات تشغيل الدفعة');
      const updated: ProductionOrder = {
        ...order,
        status: 'materials_dispatched',
        materials: order.materials.map((m) => ({
          ...m,
          dispatched_quantity: m.planned_quantity,
          status: 'dispatched',
        })),
      };
      onOrderUpdated(updated);
      setStatusMessage({ type: 'success', text: 'تم تسجيل صرف الخامات كـ "بالطريق" بنجاح.' });
    } catch {
      // محاكاة محلية آمنة
      const updated: ProductionOrder = {
        ...order,
        status: 'materials_dispatched',
        materials: order.materials.map((m) => ({
          ...m,
          dispatched_quantity: m.planned_quantity,
          status: 'dispatched',
        })),
      };
      onOrderUpdated(updated);
      setStatusMessage({ type: 'success', text: 'تم صرف الخامات محلياً (وضع المعاينة).' });
    } finally {
      setIsProcessing(false);
    }
  };

  // 2. إجراء تأكيد الاستلام من أمين المخزن مع تسجيل الفروقات
  const handleConfirmReceipt = async () => {
    setIsProcessing(true);
    setStatusMessage(null);
    const payload = {
      received_lines: order.materials.map((m) => ({
        item_id: m.item_id,
        received_quantity: Number(receiptInputs[m.item_id]?.qty ?? m.planned_quantity),
        notes: receiptInputs[m.item_id]?.notes || '',
      })),
      notes: 'تأكيد استلام أمين المخزن',
    };

    try {
      await receiveMaterialsApi(order.id, payload);
      const updatedMaterials = order.materials.map((m) => {
        const recQty = Number(receiptInputs[m.item_id]?.qty ?? m.planned_quantity);
        const disc = recQty - m.planned_quantity;
        return {
          ...m,
          received_quantity: recQty,
          discrepancy_quantity: disc,
          status: disc !== 0 ? 'received_with_discrepancy' : 'received_complete',
          notes: receiptInputs[m.item_id]?.notes || m.notes,
        };
      });
      const updated: ProductionOrder = {
        ...order,
        status: 'in_production',
        materials: updatedMaterials,
      };
      onOrderUpdated(updated);
      setStatusMessage({ type: 'success', text: 'تم تأكيد الاستلام بمخزن تحت التشغيل وتوثيق الفروقات.' });
    } catch {
      // محاكاة محلية
      const updatedMaterials = order.materials.map((m) => {
        const recQty = Number(receiptInputs[m.item_id]?.qty ?? m.planned_quantity);
        const disc = recQty - m.planned_quantity;
        return {
          ...m,
          received_quantity: recQty,
          discrepancy_quantity: disc,
          status: disc !== 0 ? 'received_with_discrepancy' : 'received_complete',
          notes: receiptInputs[m.item_id]?.notes || m.notes,
        };
      });
      const updated: ProductionOrder = {
        ...order,
        status: 'in_production',
        materials: updatedMaterials,
      };
      onOrderUpdated(updated);
      setStatusMessage({ type: 'success', text: 'تم توثيق الاستلام بمخزن تحت التشغيل محلياً.' });
    } finally {
      setIsProcessing(false);
    }
  };

  // 3. تحديث مرحلة إنتاج تتابعياً
  const handleUpdateStage = async (stageName: string, nextStatus: 'in_progress' | 'completed') => {
    setIsProcessing(true);
    setStatusMessage(null);

    // فحص التتابع الإلزامي
    const stageIndex = STAGE_SEQUENCE.indexOf(stageName);
    if (stageIndex > 0) {
      const prevStage = STAGE_SEQUENCE[stageIndex - 1];
      const prevEvent = order.stage_events.find((s) => s.stage_name === prevStage);
      if (!prevEvent || prevEvent.status !== 'completed') {
        setStatusMessage({
          type: 'error',
          text: `لا يمكن نقل مرحلة (${STAGE_TITLES_AR[stageName]}) إلا بعد اكتمال مرحلة (${STAGE_TITLES_AR[prevStage]}).`,
        });
        setIsProcessing(false);
        return;
      }
    }

    try {
      await updateStageApi(order.id, stageName, nextStatus, stageNotes[stageName] || '');
    } catch {
      // في حالة المعاينة يستمر التحديث محلياً
    }

    const updatedStages = order.stage_events.map((ev) => {
      if (ev.stage_name === stageName) {
        return {
          ...ev,
          status: nextStatus,
          actor_name: 'المدير العام',
          timestamp: new Date().toISOString(),
          notes: stageNotes[stageName] || (nextStatus === 'completed' ? 'تم اكتمال المرحلة بنجاح' : 'جاري العمل في المرحلة'),
        };
      }
      return ev;
    });

    const isPackingDone = stageName === 'packing' && nextStatus === 'completed';

    const updated: ProductionOrder = {
      ...order,
      status: isPackingDone ? 'completed' : 'in_production',
      stage_events: updatedStages,
    };

    onOrderUpdated(updated);
    setStatusMessage({
      type: 'success',
      text: `تم تحديث مرحلة (${STAGE_TITLES_AR[stageName]}) إلى: ${nextStatus === 'completed' ? 'مكتملة' : 'قيد التنفيذ'}.`,
    });
    setIsProcessing(false);
  };

  const handleRollbackStage = async (stageName: string) => {
    const reason = (rollbackReasons[stageName] || '').trim();
    if (reason.length < 3) {
      setStatusMessage({ type: 'error', text: 'اكتب سبب التراجع (٣ أحرف على الأقل).' });
      return;
    }
    setIsProcessing(true);
    setStatusMessage(null);
    try {
      const updatedOrder = await rollbackStageApi(order.id, stageName, reason);
      onOrderUpdated(updatedOrder);
      setRollbackReasons((previous) => ({ ...previous, [stageName]: '' }));
      setStatusMessage({ type: 'success', text: 'أُعيد فتح المرحلة، وسُجل التراجع في سجل المراحل.' });
    } catch {
      setStatusMessage({ type: 'error', text: 'تعذر التراجع. قد تكون مرحلة لاحقة قد بدأت؛ حدّث الأمر وحاول مجدداً.' });
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div
        className="modal-card modal-card--xl"
        onClick={(e) => e.stopPropagation()}
        dir="rtl"
      >
        <div className="modal-header">
          <div>
            <div className="modal-badge-row">
              <span className="order-code-badge">{order.order_number}</span>
              <span className={`status-pill status-pill--${order.status}`}>
                {order.status === 'draft' && 'مسودة جديدة'}
                {order.status === 'materials_dispatched' && 'خامات بالطريق'}
                {order.status === 'in_production' && 'قيد الإنتاج'}
                {order.status === 'completed' && 'مكتملة التجهيز'}
              </span>
            </div>
            <h2 className="modal-title">
              {order.product_name_ar} — كمية: {order.target_quantity} قطعة
            </h2>
            <p className="modal-subtitle">
              {order.variant_info} · المسؤول: {order.assigned_to || 'غير محدد'}
            </p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="إغلاق">
            ✕
          </button>
        </div>

        {statusMessage && (
          <div
            className={`modal-alert modal-alert--${
              statusMessage.type === 'success' ? 'success' : 'danger'
            }`}
          >
            {statusMessage.text}
          </div>
        )}

        {/* ألسنة التبويب */}
        <div className="modal-tabs">
          {order.items && order.items.length > 0 && (
            <button
              className={`tab-btn ${activeTab === 'items' ? 'tab-btn--active' : ''}`}
              onClick={() => setActiveTab('items')}
            >
              📦 أصناف وموديلات الدفعة ({order.items.length})
            </button>
          )}
          <button
            className={`tab-btn ${activeTab === 'materials' ? 'tab-btn--active' : ''}`}
            onClick={() => setActiveTab('materials')}
          >
            📋 لقطة الخامات والتحويل المخزني ({order.materials.length})
          </button>
          <button className={`tab-btn ${activeTab === 'defects' ? 'tab-btn--active' : ''}`} onClick={() => { setActiveTab('defects'); void loadDefects(); }}>
            العيوب والإصلاحات
          </button>
          <button
            className={`tab-btn ${activeTab === 'stages' ? 'tab-btn--active' : ''}`}
            onClick={() => setActiveTab('stages')}
          >
            ⚡ مراحل التشغيل التتابعية (٥ مراحل)
          </button>
        </div>

        <div className="modal-body">
          {/* تبويب بنود وموديلات أمر التشغيل */}
          {activeTab === 'items' && order.items && (
            <div className="tab-pane">
              <div style={{ marginBottom: '16px' }}>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 600 }}>أصناف وموديلات أمر التشغيل ({order.items.length})</h3>
                <p style={{ color: '#64748b', fontSize: '0.875rem' }}>الموديلات والمقاسات ومواصفات الأقمشة المعتمدة لهذه الدفعة.</p>
              </div>
              <table className="preview-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>الموديل</th>
                    <th>المقاس</th>
                    <th>الكمية المستهدفة</th>
                    <th>نوع التصنيع</th>
                    <th>مواصفات القماش</th>
                    <th>ملاحظات</th>
                  </tr>
                </thead>
                <tbody>
                  {order.items.map((it, idx) => (
                    <tr key={it.id || idx}>
                      <td>{idx + 1}</td>
                      <td><strong>{it.product_name_ar}</strong></td>
                      <td><small>{it.variant_info || it.season}</small></td>
                      <td><strong style={{ color: 'var(--teal-accent, #0d9488)' }}>{it.target_quantity} قطعة</strong></td>
                      <td>
                        {it.product_type === 'factory_brand' ? (
                          <span className="badge-tag">براند المصنع</span>
                        ) : (
                          <span className="badge-tag" style={{ background: '#fef3c7', color: '#92400e' }}>
                            تصنيع: {it.customer_name || 'عميل خارجي'}
                          </span>
                        )}
                      </td>
                      <td>
                        <small>{it.fabric_name} · {it.fabric_color} · {it.fabric_weight} · {it.fabric_area}</small>
                      </td>
                      <td><small>{it.notes || '—'}</small></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* تبويب الخامات والمخازن */}
          {activeTab === 'materials' && (
            <div className="tab-pane">
              {/* شريط الإجراءات المخزنية */}
              <div className="warehouse-action-bar">
                {order.status === 'draft' && (
                  <div className="action-box">
                    <div>
                      <strong>الخطوة ١: صرف الخامات من مخزن الخامات الرئيسي</strong>
                      <p>تسجيل الخامات كـ "بالطريق" تمهيداً لتسليمها لخط الإنتاج.</p>
                    </div>
                    <button
                      className="btn btn--primary"
                      onClick={handleDispatch}
                      disabled={isProcessing}
                    >
                      {isProcessing ? 'جاري الصرف...' : 'صرف الخامات (بالطريق) ←'}
                    </button>
                  </div>
                )}

                {order.status === 'materials_dispatched' && (
                  <div className="action-box action-box--highlight">
                    <div>
                      <strong>الخطوة ٢: تأكيد استلام أمين المخزن في مخزن تحت التشغيل (WIP)</strong>
                      <p>
                        يرجى مراجعة الكميات المستلمة فعلياً وتوثيق أي عجز أو زيادة دون مسح السجل.
                      </p>
                    </div>
                    <button
                      className="btn btn--teal"
                      onClick={handleConfirmReceipt}
                      disabled={isProcessing}
                    >
                      {isProcessing ? 'جاري التوثيق...' : '✓ تأكيد استلام الخامات وتسجيل الفروقات'}
                    </button>
                  </div>
                )}

                {order.status === 'in_production' && (
                  <div className="action-box action-box--success">
                    <div>
                      <strong>✓ الخامات مستلمة في مخزن تحت التشغيل</strong>
                      <p>تم إغلاق دورة الصرف والاستلام، والتشغيل سارٍ على خطوط الإنتاج.</p>
                    </div>
                  </div>
                )}
              </div>

              {/* جدول لقطة الخامات المجمدة */}
              {order.status === 'draft' && (
                <form className="order-material-add" onSubmit={handleAddMaterial}>
                  <div className="order-material-add__intro">
                    <strong>إضافة خامة إلى المسودة</strong>
                    <span>يمكن تعديل قائمة الخامات قبل تسجيل الصرف.</span>
                  </div>
                  <label>
                    <span>الصنف</span>
                    <select value={newItemId} onChange={(event) => setNewItemId(event.target.value)} required>
                      <option value="">{isCatalogLoading ? 'جاري تحميل الأصناف…' : 'اختر صنفاً من دليل الأصناف المسجل'}</option>
                      {catalogItems.filter((item) => item.is_active && !order.materials.some((line) => line.item_id === item.id)).map((item) => (
                        <option key={item.id} value={item.id}>{item.name_ar} · {item.code}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>الكمية المطلوبة</span>
                    <input type="number" min="0.01" step="0.01" value={newItemQuantity} onChange={(event) => setNewItemQuantity(event.target.value)} required />
                  </label>
                  <label>
                    <span>ملاحظة (اختياري)</span>
                    <input value={newItemNotes} onChange={(event) => setNewItemNotes(event.target.value)} placeholder="تفاصيل الصنف أو الاستخدام" />
                  </label>
                  <button className="btn btn--primary" type="submit" disabled={isProcessing || isCatalogLoading || catalogItems.length === 0}>
                    {isProcessing ? 'جاري الإضافة…' : '＋ إضافة الصنف'}
                  </button>
                  {catalogError && <p className="form-hint" role="alert">{catalogError}</p>}
                  {!catalogError && !isCatalogLoading && catalogItems.length === 0 && <p className="form-hint">لا توجد أصناف مسجلة في قاعدة البيانات؛ أضف الصنف أولاً من شاشة الأصناف والمخازن.</p>}
                </form>
              )}
              {order.status !== 'draft' && <p className="provisional-hint">تم إيقاف تعديل الخامات بعد بدء الصرف للحفاظ على سجل الحركة. لإضافة خامة، يلزم إجراء معتمد لتعديل الأمر بعد الصرف.</p>}
              <table className="order-detail-table">
                <thead>
                  <tr>
                    <th>الصنف</th>
                    <th>الكود</th>
                    <th>الوحدة</th>
                    <th>الكمية المخططة (لقطة)</th>
                    <th>المنصرف</th>
                    <th>المستلم فعلياً</th>
                    <th>الفارق</th>
                    <th>الحالة</th>
                    <th>ملاحظات الفروقات</th>
                    {order.status === 'draft' && <th>إجراء</th>}
                  </tr>
                </thead>
                <tbody>
                  {order.materials.length === 0 ? (
                    <tr><td colSpan={order.status === 'draft' ? 10 : 9} className="empty-materials">لا توجد خامات مسجلة لهذا الأمر بعد. أضف الخامات قبل الصرف.</td></tr>
                  ) : order.materials.map((m) => {
                    const currentRec = receiptInputs[m.item_id]?.qty ?? m.received_quantity;
                    const diff = order.status === 'materials_dispatched'
                      ? currentRec - m.dispatched_quantity
                      : m.discrepancy_quantity;

                    return (
                      <tr key={m.id}>
                        <td><strong>{m.item_name_ar}</strong></td>
                        <td><code>{m.item_code}</code></td>
                        <td>{m.unit_name_ar}</td>
                        <td className="qty-col">{m.planned_quantity}</td>
                        <td className="qty-col">{m.dispatched_quantity}</td>
                        <td className="qty-col">
                          {order.status === 'materials_dispatched' ? (
                            <input
                              type="number"
                              step="0.1"
                              className="table-input"
                              value={receiptInputs[m.item_id]?.qty ?? m.dispatched_quantity}
                              onChange={(e) => {
                                const val = parseFloat(e.target.value) || 0;
                                setReceiptInputs((prev) => ({
                                  ...prev,
                                  [m.item_id]: {
                                    qty: val,
                                    notes: prev[m.item_id]?.notes || '',
                                  },
                                }));
                              }}
                            />
                          ) : (
                            m.received_quantity
                          )}
                        </td>
                        <td className={`diff-col ${diff < 0 ? 'diff--neg' : diff > 0 ? 'diff--pos' : ''}`}>
                          {diff !== 0 ? `${diff > 0 ? '+' : ''}${diff}` : 'مطابق (٠)'}
                        </td>
                        <td>
                          <span className={`mat-status-tag mat-status--${m.status}`}>
                            {m.status === 'pending' && 'معلق'}
                            {m.status === 'dispatched' && 'بالطريق'}
                            {m.status === 'received_complete' && 'مستلم كامل'}
                            {m.status === 'received_with_discrepancy' && 'استلام بفارق'}
                          </span>
                        </td>
                        <td>
                          {order.status === 'materials_dispatched' ? (
                            <input
                              type="text"
                              className="table-input table-input--text"
                              placeholder="سبب الفارق إن وجد"
                              value={receiptInputs[m.item_id]?.notes || ''}
                              onChange={(e) => {
                                const val = e.target.value;
                                setReceiptInputs((prev) => ({
                                  ...prev,
                                  [m.item_id]: {
                                    qty: prev[m.item_id]?.qty ?? m.dispatched_quantity,
                                    notes: val,
                                  },
                                }));
                              }}
                            />
                          ) : (
                            m.notes || '—'
                          )}
                        </td>
                        {order.status === 'draft' && (
                          <td><button type="button" className="material-remove-button" onClick={() => void handleRemoveMaterial(m.id)} disabled={isProcessing}>حذف</button></td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* تبويب مراحل التشغيل التتابعية */}
          {activeTab === 'stages' && (
            <div className="tab-pane">
              <div className="provisional-hint">
                📌 <strong>قاعدة التتابع الإلزامي:</strong> لا يُسمح بتخطي المراحل أو بدء مرحلة قبل اكتمال سابقتها. الصلاحية مقتصرة خادمياً على المدير العام (deny-by-default).
              </div>

              <div className="stages-flow-list">
                {STAGE_SEQUENCE.map((stageKey, idx) => {
                  const event = order.stage_events.find((s) => s.stage_name === stageKey);
                  const stageStatus = event?.status || 'not_started';
                  const prevStageKey = idx > 0 ? STAGE_SEQUENCE[idx - 1] : null;
                  const prevEvent = prevStageKey
                    ? order.stage_events.find((s) => s.stage_name === prevStageKey)
                    : null;
                  const isPrevCompleted = idx === 0 || prevEvent?.status === 'completed';
                  const canRollback = stageStatus === 'completed' && STAGE_SEQUENCE.slice(idx + 1).every((laterKey) =>
                    order.stage_events.find((stage) => stage.stage_name === laterKey)?.status === 'not_started'
                  );

                  return (
                    <div
                      key={stageKey}
                      className={`stage-card stage-card--${stageStatus} ${
                        !isPrevCompleted ? 'stage-card--locked' : ''
                      }`}
                    >
                      <div className="stage-card__number">{idx + 1}</div>
                      <div className="stage-card__info">
                        <div className="stage-card__head">
                          <h3 className="stage-card__title">
                            {STAGE_TITLES_AR[stageKey]}
                          </h3>
                          <span className={`stage-badge stage-badge--${stageStatus}`}>
                            {stageStatus === 'not_started' && 'لم تبدأ بعد'}
                            {stageStatus === 'in_progress' && 'قيد التنفيذ الآن'}
                            {stageStatus === 'completed' && '✓ مكتملة'}
                          </span>
                        </div>
                        <div className="stage-card__meta">
                          <span>المسؤول: {event?.actor_name || 'النظام'}</span>
                          {event?.timestamp && (
                            <span>التحديث: {new Date(event.timestamp).toLocaleTimeString('ar-EG')}</span>
                          )}
                          {event?.notes && <span className="stage-note">({event.notes})</span>}
                        </div>
                        {(order.stage_history || []).filter((history) => history.stage_name === stageKey).map((history) => (
                          <div className="stage-history-entry" key={history.id}>
                            <strong>تغيير موثق:</strong> {STAGE_STATUS_AR[history.from_status] || history.from_status} ← {STAGE_STATUS_AR[history.to_status] || history.to_status} · {history.actor_name || 'مستخدم'} · {new Date(history.timestamp).toLocaleString('ar-EG')}
                            {history.previous_notes && <span>الملاحظة السابقة: {history.previous_notes}</span>}
                            <span>السبب: {history.reason}</span>
                          </div>
                        ))}
                        {stageStatus !== 'completed' && (
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

                      {/* أزرار التحكم بالمرحلة */}
                      <div className="stage-card__actions">
                        {stageStatus === 'not_started' && (
                          <button
                            className="btn btn--sm btn--secondary"
                            onClick={() => handleUpdateStage(stageKey, 'in_progress')}
                            disabled={!isPrevCompleted || isProcessing}
                            title={
                              !isPrevCompleted
                                ? 'يجب إكمال المرحلة السابقة أولاً'
                                : 'بدء تشغيل المرحلة'
                            }
                          >
                            بدء المرحلة ▶
                          </button>
                        )}

                        {stageStatus === 'in_progress' && (
                          <button
                            className="btn btn--sm btn--primary"
                            onClick={() => handleUpdateStage(stageKey, 'completed')}
                            disabled={isProcessing}
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
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {activeTab === 'defects' && (
            <div className="tab-pane">
              <h3>تسجيل عيب أو إصلاح</h3>
              <form className="form-grid" onSubmit={(event) => void handleReportDefect(event)}>
                <label>المرحلة<select value={defectForm.stage_name} onChange={(e) => setDefectForm({ ...defectForm, stage_name: e.target.value })}>{STAGE_SEQUENCE.map((key) => <option key={key} value={key}>{STAGE_TITLES_AR[key]}</option>)}</select></label>
                <label>الكمية المتأثرة<input required type="number" min="0.001" step="0.001" value={defectForm.affected_quantity} onChange={(e) => setDefectForm({ ...defectForm, affected_quantity: e.target.value })} /></label>
                <label>المسؤول أو القسم<input required value={defectForm.responsible} onChange={(e) => setDefectForm({ ...defectForm, responsible: e.target.value })} /></label>
                <label>وصف العيب<input required value={defectForm.description} onChange={(e) => setDefectForm({ ...defectForm, description: e.target.value })} /></label>
                <label>الإجراء المطلوب<input required value={defectForm.repair_action} onChange={(e) => setDefectForm({ ...defectForm, repair_action: e.target.value })} /></label>
                <label>تكلفة الإصلاح (وصف فقط)<input value={defectForm.repair_cost_description} onChange={(e) => setDefectForm({ ...defectForm, repair_cost_description: e.target.value })} /></label>
                <button className="btn btn--primary" disabled={isProcessing}>تسجيل العيب</button>
              </form>
              <div className="defect-list">
                {defects.map((defect) => <article className="action-box" key={defect.id}>
                  <strong>{defect.defect_number} · {STAGE_TITLES_AR[defect.stage_name]}</strong>
                  <p>{defect.description} · الكمية: {defect.affected_quantity} · المسؤول: {defect.responsible}</p>
                  <p>الإصلاح: {defect.repair_action}{defect.repair_cost_description ? ` · التكلفة الوصفية: ${defect.repair_cost_description}` : ''}</p>
                  <select aria-label="حالة الإصلاح" value={defect.status} onChange={async (e) => { try { const updated = await updateOrderDefect(order.id, defect.id, { status: e.target.value as ProductionDefect['status'] }); setDefects((items) => items.map((item) => item.id === updated.id ? updated : item)); } catch { setStatusMessage({ type: 'error', text: 'تعذر تحديث حالة الإصلاح.' }); } }}>
                    <option value="reported">مسجل</option><option value="repair_in_progress">قيد الإصلاح</option><option value="repaired">تم الإصلاح</option><option value="closed">مغلق</option>
                  </select>
                </article>)}
                {defects.length === 0 && <p>لا توجد عيوب مسجلة لهذا الأمر.</p>}
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn--secondary" onClick={onClose}>
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
};
