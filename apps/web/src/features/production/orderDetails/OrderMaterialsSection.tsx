/**
 * تبويب «الخامات» في صفحة تفاصيل أمر التشغيل (T4.2):
 * شريط الصرف/الاستلام المتغير بالحالة + نموذج خامات المسودة + جدول الخامات بإدخال الاستلام لكل سطر
 * + لوحة الصرف الإضافي (ExtraIssuePanel) + عمود الملكية لأوامر التشغيل للغير (CMT).
 * المنطق منقول حرفيًا من تبويب materials بالـModal القديم.
 */
import React, { useEffect, useState } from 'react';
import { useAuth } from '@/features/auth/AuthContext';
import { ExtraIssuePanel } from '../ExtraIssuePanel';
import { DiscrepancyClaimsSection } from '../DiscrepancyClaims';
import { OrderShortageProcurementModal } from './OrderShortageProcurementModal';
import {
  CatalogItem,
  dispatchMaterialsApi,
  receiveMaterialsApi,
  addOrderMaterialApi,
  removeOrderMaterialApi,
  newIdempotencyKey,
  TransferDiscrepancyClaimRead,
} from '../productionApi';
import { EPSILON, round6, type SectionContext } from './constants';

interface OrderMaterialsSectionProps {
  ctx: SectionContext;
  catalogItems: CatalogItem[];
  isCatalogLoading: boolean;
  catalogError: string | null;
  claims?: TransferDiscrepancyClaimRead[];
  claimsLoading?: boolean;
  claimsError?: string | null;
  onRetryClaims?: () => void;
  onOpenClaim?: (claim: TransferDiscrepancyClaimRead) => void;
}

export const OrderMaterialsSection: React.FC<OrderMaterialsSectionProps> = ({
  ctx,
  catalogItems,
  isCatalogLoading,
  catalogError,
  claims = [],
  claimsLoading = false,
  claimsError = null,
  onRetryClaims,
  onOpenClaim,
}) => {
  const { order, onOrderUpdated, refreshOrder, reportFailure, setStatus, setBusy } = ctx;
  const { hasPermission, user } = useAuth();
  const canDispatch = hasPermission('warehouse:dispatch');
  // فصل الصارف عن المستلم: من صرف الخامات لا يرى زر تأكيد استلامها (الخادم يرفضه أيضاً)
  const dispatchedByMe = Boolean(user?.id && order.pending_transfer_dispatched_by === user.id);
  const canReceiveWip = hasPermission('production:wip:receive') && !dispatchedByMe;
  const canManageMaterials = hasPermission('production:orders:manage');
  const isCmt = order.manufacturing_type === 'external';

  const [isProcessing, setIsProcessing] = useState(false);
  const [newItemId, setNewItemId] = useState('');
  const [newItemQuantity, setNewItemQuantity] = useState('');
  const [newItemNotes, setNewItemNotes] = useState('');
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null);
  const [isProcurementModalOpen, setIsProcurementModalOpen] = useState(false);

  // نموذج تأكيد استلام الخامات في الورشة (القيمة الافتراضية = المنصرف)
  const [receiptInputs, setReceiptInputs] = useState<Record<string, { qty: string; notes: string }>>(() => {
    const init: Record<string, { qty: string; notes: string }> = {};
    order.materials.forEach((m) => {
      init[m.item_id] = { qty: String(m.dispatched_quantity), notes: '' };
    });
    return init;
  });
  const [receiptIdempotencyKey, setReceiptIdempotencyKey] = useState<string>(() => newIdempotencyKey());

  // مزامنة مدخلات الاستلام عند تحديث خامات أمر التشغيل
  useEffect(() => {
    setReceiptInputs((prev) => {
      const updated: Record<string, { qty: string; notes: string }> = {};
      order.materials.forEach((m) => {
        const previous = prev[m.item_id];
        // بعد الصرف مباشرة تكون القيمة المحفوظة صفراً من حالة المسودة؛ نعيدها إلى الكمية المنصرفة
        const stale = !previous || (Number(previous.qty || 0) === 0 && m.dispatched_quantity > 0);
        updated[m.item_id] = stale ? { qty: String(m.dispatched_quantity), notes: previous?.notes || '' } : previous;
      });
      return updated;
    });
  }, [order.id, order.materials]);

  const handleAddMaterial = async (event: React.FormEvent) => {
    event.preventDefault();
    const item = catalogItems.find((candidate) => candidate.id === newItemId);
    const quantity = Number(newItemQuantity);
    if (!item || !Number.isFinite(quantity) || quantity <= 0) {
      reportFailure(new Error('اختر صنفاً وأدخل كمية أكبر من صفر.'), 'اختر صنفاً وأدخل كمية أكبر من صفر.');
      return;
    }
    setIsProcessing(true);
    setBusy(true);
    setStatus(null);
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
      setStatus({ type: 'success', text: 'تمت إضافة الصنف إلى مسودة أمر التشغيل.' });
    } catch (err: unknown) {
      reportFailure(err, 'تعذرت إضافة الصنف. تحقق من الاتصال وحالة الأمر ثم أعد المحاولة.');
    } finally {
      setIsProcessing(false);
      setBusy(false);
    }
  };

  const handleRemoveMaterial = async (materialId: string) => {
    setIsProcessing(true);
    setBusy(true);
    setStatus(null);
    try {
      await removeOrderMaterialApi(order.id, materialId);
      onOrderUpdated({ ...order, materials: order.materials.filter((line) => line.id !== materialId) });
      setPendingRemoveId(null);
      setStatus({ type: 'success', text: 'تم حذف الصنف من المسودة.' });
    } catch (err: unknown) {
      reportFailure(err, 'تعذر حذف الصنف. تحقق من اتصال الخادم وحالة الأمر.');
    } finally {
      setIsProcessing(false);
      setBusy(false);
    }
  };

  // 1. صرف الخامات من المخزن الرئيسي
  const handleDispatch = async () => {
    setIsProcessing(true);
    setBusy(true);
    setStatus(null);
    try {
      await dispatchMaterialsApi(order.id, 'صرف خامات تشغيل الدفعة');
    } catch (err: unknown) {
      reportFailure(err, 'تعذر صرف الخامات من المخزن الرئيسي. تحقق من رصيد الخامات وصلاحياتك والاتصال بالخادم.');
      setIsProcessing(false);
      setBusy(false);
      return;
    }
    await refreshOrder('تم تسجيل صرف الخامات كـ "بالطريق" وتحديث حالة أمر التشغيل.');
    setIsProcessing(false);
    setBusy(false);
  };

  // التحقق من كميات استلام الخامات: بين صفر والمنصرف (مطابق لقواعد الخادم)
  const receiptLineError = (itemId: string, dispatched: number): string | null => {
    const raw = receiptInputs[itemId]?.qty ?? String(dispatched);
    if (raw.trim() === '') return 'أدخل الكمية المستلمة';
    const qty = Number(raw);
    if (!Number.isFinite(qty) || qty < 0) return 'الكمية لا تقل عن صفر';
    if (qty > dispatched + EPSILON) return `لا تتجاوز المنصرف (${dispatched})`;
    return null;
  };
  const receiptHasErrors = order.materials.some((m) => receiptLineError(m.item_id, m.dispatched_quantity) !== null);

  // 2. تأكيد استلام الخامات في مخزن تحت التشغيل
  const handleConfirmReceipt = async () => {
    if (receiptHasErrors) {
      reportFailure(new Error('راجع كميات الاستلام: يجب أن تكون كل كمية بين صفر والكمية المنصرفة.'), 'راجع كميات الاستلام: يجب أن تكون كل كمية بين صفر والكمية المنصرفة.');
      return;
    }
    setIsProcessing(true);
    setBusy(true);
    const payload = {
      received_lines: order.materials.map((m) => ({
        item_id: m.item_id,
        received_quantity: Number(receiptInputs[m.item_id]?.qty ?? m.dispatched_quantity),
        notes: receiptInputs[m.item_id]?.notes || '',
      })),
      notes: 'تأكيد استلام أمين المخزن',
    };
    try {
      await receiveMaterialsApi(order.id, payload, receiptIdempotencyKey);
    } catch (err: unknown) {
      reportFailure(err, 'تعذر تأكيد استلام الخامات بمخزن تحت التشغيل. تحقق من اتصال الخادم وصلاحياتك وحالة أمر التشغيل.');
      setIsProcessing(false);
      setBusy(false);
      return;
    }
    setReceiptIdempotencyKey(newIdempotencyKey());
    await refreshOrder('تم تأكيد الاستلام بمخزن تحت التشغيل وتوثيق الفروقات.');
    setIsProcessing(false);
    setBusy(false);
  };

  // الخامات المصدرها مستلزمات التصنيع المحفوظة في الأمر (الباقي أُضيف يدوياً)
  const orderItems = order.items || [];
  const bomItemIds = new Set(orderItems.flatMap((it) => (it.bom_lines ?? []).map((b) => b.item_id)));
  const hasBomSnapshot = bomItemIds.size > 0;

  return (
    <div className="tab-pane">
      {isCmt ? (
        <div className="provisional-hint" style={{ background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', marginBottom: '16px' }}>
          🧵 <strong>خامات أمانة العميل ({order.customer_name || 'العميل'}):</strong> الخامات مملوكة للعميل ومودعة بالمخزن لحساب هذا الأمر، وتُصرف بحدود سقف الهالك المعتمد ({order.allowed_waste_pct ?? '1.5'}%).
        </div>
      ) : (
        <div className="provisional-hint" style={{ background: '#f8fafc', border: '1px solid #e2e8f0', color: '#334155', marginBottom: '16px' }}>
          🏭 <strong>خامات المصنع:</strong> الخامات مملوكة للمصنع وتُصرف من المخزن الرئيسي للخامات والمستلزمات.
        </div>
      )}

      {/* مشتريات وتوريد عجز الخامات (T5) */}
      <div
        className="action-box"
        style={{
          background: '#f8fafc',
          border: '1px solid #cbd5e1',
          marginBottom: '1rem',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1rem',
          padding: '1rem 1.25rem',
          borderRadius: '8px',
        }}
      >
        <div>
          <strong style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#0f172a', fontSize: '1rem' }}>
            <span>🛒</span> مشتريات وتوريد خامات أمر التشغيل
          </strong>
          <p style={{ margin: '0.25rem 0 0', color: '#475569', fontSize: '0.85rem' }}>
            فحص أرصدة مخزن الخامات الحر واستبعاد خامات العملاء، وتوليد أوامر شراء مسودة مجمعة حسب الموردين لتغطية العجز.
          </p>
        </div>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => setIsProcurementModalOpen(true)}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontWeight: 600, padding: '0.5rem 1rem' }}
        >
          <span>📋</span> تدقيق عجز الخامات وتوليد أوامر الشراء
        </button>
      </div>

      <div className="warehouse-action-bar">
        {order.status === 'draft' && (
          <div className="action-box">
            <div>
              <strong>الخطوة ١: صرف الخامات من مخزن الخامات الرئيسي</strong>
              <p>تسجيل الخامات كـ "بالطريق" تمهيداً لتسليمها لخط الإنتاج.</p>
            </div>
            {canDispatch ? (
              <button
                className="btn btn--primary"
                onClick={() => void handleDispatch()}
                disabled={isProcessing}
              >
                {isProcessing ? 'جاري الصرف...' : 'صرف الخامات (بالطريق) ←'}
              </button>
            ) : (
              <span className="badge-tag" style={{ background: '#f1f5f9', color: '#475569', padding: '0.4rem 0.8rem' }}>
                صرف الخامات من مهام أمين المخزن؛ الأمر بانتظاره.
              </span>
            )}
          </div>
        )}

        {order.status === 'materials_dispatched' && (
          <div className="action-box action-box--highlight">
            <div>
              <strong>الخطوة ٢: تأكيد استلام الخامات في الورشة</strong>
              <p>
                سجّل الكمية المستلمة فعلياً لكل خامة (من صفر حتى الكمية المنصرفة)، وتوثَّق الفروقات دون مسح السجل.
              </p>
            </div>
            {canReceiveWip ? (
              <button
                className="btn btn--teal"
                onClick={() => void handleConfirmReceipt()}
                disabled={isProcessing || receiptHasErrors}
              >
                {isProcessing ? 'جاري التوثيق...' : '✓ تأكيد استلام الخامات وتسجيل الفروقات'}
              </button>
            ) : (
              <span className="badge-tag" style={{ background: '#fef3c7', color: '#92400e', padding: '0.4rem 0.8rem' }}>
                {dispatchedByMe
                  ? 'أنت من صرف هذه الخامات؛ بانتظار تأكيد استلامها في الورشة من مسؤول الإنتاج أو مستخدم آخر مخوّل.'
                  : 'تأكيد استلام الخامات بالورشة من مسؤولية مسؤول الإنتاج، ولا يؤكده من صرف الخامات بنفسه.'}
              </span>
            )}
          </div>
        )}

        {['in_production', 'manufacturing_completed', 'receipt_completed', 'completed', 'closed'].includes(order.status) && (
          <div className="action-box action-box--success">
            <div>
              <strong>✓ الخامات مستلمة في مخزن تحت التشغيل</strong>
              <p>تم إغلاق دورة الصرف والاستلام. سجّل مصير الخامات من تبويب "التسوية والمرتجعات".</p>
            </div>
          </div>
        )}
      </div>

      {order.status === 'draft' && canManageMaterials && (
        <form className="order-material-add" onSubmit={(event) => void handleAddMaterial(event)}>
          <div className="order-material-add__intro">
            <strong>إضافة خامة إلى المسودة</strong>
            <span>يمكن تعديل قائمة الخامات قبل تسجيل الصرف.</span>
          </div>
          <label>
            <span>الصنف</span>
            <select value={newItemId} onChange={(event) => setNewItemId(event.target.value)} required>
              <option value="">{isCatalogLoading ? 'جاري تحميل الأصناف…' : 'اختر صنفاً من دليل الأصناف المسجل'}</option>
              {catalogItems.filter((item) => item.is_active && item.item_type !== 'finished_garment' && (!item.approval_status || item.approval_status === 'approved') && !order.materials.some((line) => line.item_id === item.id)).map((item) => (
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
      {order.status !== 'draft' && <p className="provisional-hint">تم إيقاف تعديل الخامات بعد بدء الصرف للحفاظ على سجل الحركة. لإضافة خامة، استخدم الصرف الإضافي أدناه أو إجراء معتمداً لتعديل الأمر.</p>}

      <div className="order-table-wrap" style={{ overflowX: 'auto', marginBottom: '16px' }}>
        <table className="order-detail-table" style={{ width: '100%', minWidth: isCmt ? '950px' : '850px', fontSize: '14px' }}>
        <thead>
          <tr>
            <th>الصنف</th>
            <th>الكود</th>
            <th>الوحدة</th>
            {isCmt && <th>الملكية</th>}
            <th>الكمية المخططة (لقطة)</th>
            <th>المنصرف</th>
            <th>المستلم فعلياً</th>
            <th>الفارق</th>
            <th>الحالة</th>
            {hasBomSnapshot && <th>المصدر</th>}
            <th>ملاحظات الفروقات</th>
            {order.status === 'draft' && canManageMaterials && <th>إجراء</th>}
          </tr>
        </thead>
        <tbody>
          {order.materials.length === 0 ? (
            <tr><td colSpan={(order.status === 'draft' && canManageMaterials ? 10 : 9) + (hasBomSnapshot ? 1 : 0) + (isCmt ? 1 : 0)} className="empty-materials">لا توجد خامات مسجلة لهذا الأمر بعد. أضف الخامات قبل الصرف.</td></tr>
          ) : order.materials.map((m) => {
            const isReceiving = order.status === 'materials_dispatched';
            const rawQty = receiptInputs[m.item_id]?.qty ?? String(m.dispatched_quantity);
            const lineError = isReceiving ? receiptLineError(m.item_id, m.dispatched_quantity) : null;
            const currentRec = Number(rawQty);
            const diff = isReceiving
              ? (Number.isFinite(currentRec) ? round6(currentRec - m.dispatched_quantity) : 0)
              : m.discrepancy_quantity;

            return (
              <tr key={m.id}>
                <td><strong>{m.item_name_ar}</strong></td>
                <td><code>{m.item_code}</code></td>
                <td>{m.unit_name_ar}</td>
                {isCmt && (
                  <td>
                    <span className={`badge ${m.supplied_by === 'customer' ? 'badge--primary' : 'badge--secondary'}`} style={{ fontSize: '0.75rem' }}>
                      {m.supplied_by === 'customer' ? 'أمانة العميل' : 'المصنع'}
                    </span>
                  </td>
                )}
                <td className="qty-col">{m.planned_quantity}</td>
                <td className="qty-col">{m.dispatched_quantity}</td>
                <td className="qty-col">
                  {isReceiving ? (
                    <>
                      <input
                        type="number"
                        step="any"
                        min={0}
                        max={m.dispatched_quantity}
                        className="table-input"
                        aria-label={`الكمية المستلمة ${m.item_name_ar}`}
                        aria-invalid={lineError ? true : undefined}
                        value={rawQty}
                        onChange={(e) => {
                          const val = e.target.value;
                          setReceiptInputs((prev) => ({
                            ...prev,
                            [m.item_id]: { qty: val, notes: prev[m.item_id]?.notes || '' },
                          }));
                        }}
                      />
                      {lineError && <small role="alert" style={{ display: 'block', color: '#b91c1c' }}>{lineError}</small>}
                    </>
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
                {hasBomSnapshot && (
                  <td>
                    {bomItemIds.has(m.item_id)
                      ? <span className="status-badge status-badge--done order-bom__source" title="من مستلزمات التصنيع المحفوظة في الأمر">مستلزمات</span>
                      : <span className="status-badge status-badge--waiting order-bom__source" title="أضيفت يدوياً على الأمر">يدوي</span>}
                  </td>
                )}
                <td>
                  {isReceiving ? (
                    <input
                      type="text"
                      className="table-input table-input--text"
                      placeholder="سبب الفارق إن وجد"
                      value={receiptInputs[m.item_id]?.notes || ''}
                      onChange={(e) => {
                        const val = e.target.value;
                        setReceiptInputs((prev) => ({
                          ...prev,
                          [m.item_id]: { qty: prev[m.item_id]?.qty ?? String(m.dispatched_quantity), notes: val },
                        }));
                      }}
                    />
                  ) : (
                    m.notes || '—'
                  )}
                </td>
                {order.status === 'draft' && canManageMaterials && (
                  <td>
                    {bomItemIds.has(m.item_id) ? (
                      <small className="form-hint" title="بنود المستلزمات المحفوظة لا تُحذف حتى لا يختلف المطلوب عن المصروف دون توثيق">ثابت</small>
                    ) : pendingRemoveId === m.id ? (
                      <span style={{ display: 'inline-flex', gap: '4px' }}>
                        <button type="button" className="material-remove-button" onClick={() => void handleRemoveMaterial(m.id)} disabled={isProcessing}>تأكيد الحذف</button>
                        <button type="button" className="btn btn--sm btn--secondary" onClick={() => setPendingRemoveId(null)} disabled={isProcessing}>تراجع</button>
                      </span>
                    ) : (
                      <button type="button" className="material-remove-button" onClick={() => setPendingRemoveId(m.id)} disabled={isProcessing}>حذف</button>
                    )}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>

      {/* مطالبات عجز استلام الخامات (Phase 4.5 T2) في موضع حدوث الفارق */}
      {onOpenClaim && onRetryClaims && (
        <div style={{ marginTop: '24px' }}>
          <DiscrepancyClaimsSection
            claims={claims}
            isLoading={claimsLoading}
            errorText={claimsError}
            onRetry={onRetryClaims}
            onOpenClaim={onOpenClaim}
          />
        </div>
      )}

      {order.status !== 'draft' && order.status !== 'materials_dispatched' && (
        <ExtraIssuePanel
          key={`${order.id}:extra`}
          orderId={order.id}
          orderStatus={order.status}
          currentUserId={user?.id}
          canDispatch={canDispatch}
          canReceive={hasPermission('production:wip:receive')}
          finishedGoodsStarted={orderItems.some((it) => (it.received_quantity ?? 0) + (it.rejected_quantity ?? 0) > 0)}
          onChanged={async (message) => {
            await refreshOrder(message);
          }}
        />
      )}

      <OrderShortageProcurementModal
        isOpen={isProcurementModalOpen}
        onClose={() => setIsProcurementModalOpen(false)}
        orderId={order.id}
        onOrdersGenerated={() => {
          void refreshOrder('تم توليد أوامر الشراء بنجاح وتحديث بيانات أمر التشغيل.');
        }}
      />
    </div>
  );
};
