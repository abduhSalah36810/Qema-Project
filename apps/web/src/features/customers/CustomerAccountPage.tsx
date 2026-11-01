import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '@/lib/api';
import {
  createCustomerOrder,
  createCustomerProductionOrder,
  Customer,
  CustomerAccount,
  CustomerOrder,
  CustomerOrderLine,
  CustomerPayment,
  CustomerTemplate,
  fetchCustomerAccount,
  fetchCustomerTemplates,
  fetchOrderableProducts,
  OrderableProduct,
  recordCustomerDelivery,
  recordCustomerPayment,
  updateCustomer,
} from './customersApi';

interface CustomerAccountPageProps {
  customer: Customer;
  onBack: () => void;
  onEditCustomer: (customer: Customer) => void;
  onCustomerUpdated: (customer: Customer) => void;
}

interface DraftLine { product_id: string; variant_id: string; quantity: string; unit_price: string; notes: string }
const blankLine = (): DraftLine => ({ product_id: '', variant_id: '', quantity: '', unit_price: '', notes: '' });

function formatMoney(amount: number): string {
  return new Intl.NumberFormat('ar-EG', { style: 'currency', currency: 'EGP', maximumFractionDigits: 2 }).format(amount);
}

function formatDate(date: string): string {
  return new Date(date).toLocaleDateString('ar-EG');
}

function apiError(error: unknown): string {
  return error instanceof ApiError ? error.message : 'حدث خطأ غير متوقع. حاول مرة أخرى.';
}

function typeLabel(type: CustomerOrder['order_type']): string {
  return type === 'ready_goods' ? 'شراء منتج جاهز' : 'تصنيع خاص للعميل';
}

function statusLabel(status: CustomerOrder['status']): string {
  return ({ open: 'مفتوح', partially_delivered: 'تسليم جزئي', delivered: 'تم التسليم', cancelled: 'ملغي' })[status];
}

function methodLabel(method: CustomerPayment['method']): string {
  return ({ cash: 'نقدي', bank_transfer: 'تحويل بنكي', other: 'أخرى' })[method];
}

export function CustomerAccountPage({ customer, onBack, onEditCustomer, onCustomerUpdated }: CustomerAccountPageProps) {
  const [account, setAccount] = useState<CustomerAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [orderModalOpen, setOrderModalOpen] = useState(false);
  const [deliveryOrder, setDeliveryOrder] = useState<CustomerOrder | null>(null);
  const [paymentOrder, setPaymentOrder] = useState<CustomerOrder | null>(null);
  const [productionOrder, setProductionOrder] = useState<{ order: CustomerOrder; line: CustomerOrderLine } | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchCustomerAccount(customer.id);
      setAccount(result);
      onCustomerUpdated(result.customer);
    } catch (loadError) {
      setError(apiError(loadError));
    } finally {
      setLoading(false);
    }
  }, [customer.id, onCustomerUpdated]);

  useEffect(() => { void reload(); }, [reload]);

  const totals = useMemo(() => (account?.orders ?? []).reduce((result, order) => ({
    orders: result.orders + 1,
    invoiced: result.invoiced + order.total_amount,
    collected: result.collected + order.paid_amount,
    balance: result.balance + order.balance_amount,
  }), { orders: 0, invoiced: 0, collected: 0, balance: 0 }), [account]);

  const setErrorFrom = (operationError: unknown) => setError(apiError(operationError));
  const toggleStatus = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await updateCustomer(customer.id, { status: customer.status === 'active' ? 'inactive' : 'active' });
      onCustomerUpdated(updated);
      setAccount((current) => current ? { ...current, customer: updated } : current);
    } catch (statusError) {
      setError(apiError(statusError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="customer-account" aria-labelledby="customer-account-title">
      <div className="customer-account__topline">
        <button className="customer-back" type="button" onClick={onBack}>‹ العودة إلى العملاء</button>
        <span className={`customer-status customer-status--${customer.status}`}>{customer.status === 'active' ? 'عميل نشط' : 'عميل موقوف'}</span>
      </div>
      <header className="customer-account__header">
        <div className="customer-account__identity">
          <div className="customer-avatar customer-avatar--large" aria-hidden>{customer.name.trim().charAt(0) || 'ع'}</div>
          <div><span>{customer.code}</span><h2 id="customer-account-title">{customer.name}</h2><p>{customer.city || 'المدينة غير مسجلة'} · {customer.phone || 'الهاتف غير مسجل'}</p></div>
        </div>
        <div className="customer-account__actions">
          <button className="btn btn--secondary" type="button" onClick={() => onEditCustomer(customer)}>تعديل بيانات العميل</button>
          <button className="btn btn--secondary" type="button" onClick={() => void toggleStatus()} disabled={saving}>{customer.status === 'active' ? 'إيقاف العميل' : 'إعادة تفعيل العميل'}</button>
          <button className="btn btn--primary" type="button" onClick={() => setOrderModalOpen(true)} disabled={customer.status !== 'active'}>＋ معاملة جديدة</button>
        </div>
      </header>

      {error && <div className="customers-alert" role="alert">{error}<button type="button" onClick={() => void reload()}>إعادة المحاولة</button></div>}

      <div className="customer-account__summary">
        <article><span>عدد المعاملات</span><strong>{totals.orders}</strong></article>
        <article><span>إجمالي قيمة الطلبات المسجلة</span><strong>{formatMoney(totals.invoiced)}</strong></article>
        <article><span>المدفوعات المسجلة</span><strong>{formatMoney(totals.collected)}</strong></article>
        <article><span>الرصيد المبدئي</span><strong>{formatMoney(totals.balance)}</strong></article>
      </div>

      <div className="customer-account__columns">
        <section className="customers-card customer-account__details">
          <div className="customer-section-heading"><div><span>الملف</span><h3>بيانات العميل وطريقة التعامل</h3></div><span className="customer-provisional-label">تصور مبدئي</span></div>
          <dl><div><dt>كود العميل</dt><dd>{customer.code}</dd></div><div><dt>الاسم</dt><dd>{customer.name}</dd></div><div><dt>الهاتف</dt><dd>{customer.phone || '—'}</dd></div><div><dt>المدينة</dt><dd>{customer.city || '—'}</dd></div><div><dt>العنوان</dt><dd>{customer.address || '—'}</dd></div><div><dt>مسجل منذ</dt><dd>{formatDate(customer.created_at)}</dd></div></dl>
          <div className="customer-method-note"><strong>طريقة التعامل تُحدد داخل كل معاملة</strong><p>يمكن تسجيل شراء منتج جاهز أو تصنيع خاص للعميل، ويمكن للعميل نفسه استخدام المسارين في معاملات مختلفة.</p></div>
        </section>

        <section className="customers-card customer-transactions" aria-label="سجل معاملات العميل">
          <div className="customer-section-heading"><div><span>السجل الكامل</span><h3>الطلبات والتصنيع والتسليمات والمدفوعات</h3></div><button className="btn btn--secondary" type="button" onClick={() => void reload()} disabled={loading}>تحديث</button></div>
          <div className="customer-provisional-banner">الأرقام المالية سجل تشغيلي مبدئي وليست دفترًا محاسبيًا. تسجيل دفعة تسليم لا يخصم مخزون المنتج التام حاليًا.</div>
          {loading ? <div className="customers-empty" role="status">جاري تحميل ملف العميل…</div> : !account?.orders.length ? <div className="customers-empty">لا توجد معاملات مسجلة لهذا العميل بعد. ابدأ بإنشاء معاملة جديدة.</div> : (
            <div className="customer-order-list">{account.orders.map((order) => (
              <article className="customer-order-card" key={order.id}>
                <header className="customer-order-card__header"><div><span className="customer-order-code">{order.order_number}</span><h4>{typeLabel(order.order_type)}</h4><small>{formatDate(order.order_date)}</small></div><span className={`customer-order-status customer-order-status--${order.status}`}>{statusLabel(order.status)}</span></header>
                <div className="customer-order-card__summary"><span>الإجمالي <strong>{formatMoney(order.total_amount)}</strong></span><span>المدفوع <strong>{formatMoney(order.paid_amount)}</strong></span><span>{order.balance_amount < 0 ? 'رصيد دائن مبدئي' : 'المتبقي'} <strong>{formatMoney(Math.abs(order.balance_amount))}</strong></span>{order.discount_amount > 0 && <span>الخصم <strong>{formatMoney(order.discount_amount)}</strong></span>}</div>
                {order.payment_terms && <p className="customer-terms"><b>شروط التعامل:</b> {order.payment_terms}</p>}
                <div className="customer-lines">{order.lines.map((line) => {
                  const remainingProduction = Math.max(0, line.quantity - line.production_orders.reduce((sum, item) => sum + (item.status === 'cancelled' ? 0 : item.target_quantity), 0));
                  return <div className="customer-line" key={line.id}>
                    <div><strong>{line.product_name}</strong><span>{line.variant_info} · المطلوب {line.quantity} · المسلّم {line.delivered_quantity}</span><small>{formatMoney(line.unit_price)} للوحدة · إجمالي {formatMoney(line.line_total)}</small></div>
                    {order.order_type === 'custom_manufacturing' && <button type="button" className="customer-link-action" onClick={() => setProductionOrder({ order, line })} disabled={remainingProduction <= 0}>＋ أمر تشغيل</button>}
                    {line.production_orders.length > 0 && <span className="customer-linked-orders">أوامر تشغيل: {line.production_orders.map((linked) => linked.order_number).join('، ')}</span>}
                  </div>;
                })}</div>
                <div className="customer-records-grid">
                  <section><h5>دفعات التسليم <span>{order.deliveries.length}</span></h5>{order.deliveries.length ? order.deliveries.map((delivery) => <div className="customer-record-row" key={delivery.id}><strong>{delivery.delivery_number}</strong><span>{formatDate(delivery.delivered_at)} · {delivery.lines.map((line) => `${line.product_name} (${line.quantity})`).join('، ')}</span></div>) : <p className="customer-muted">لم تسجل دفعات تسليم.</p>}</section>
                  <section><h5>المدفوعات <span>{order.payments.length}</span></h5>{order.payments.length ? order.payments.map((payment) => <div className="customer-record-row" key={payment.id}><strong>{formatMoney(payment.amount)} · {methodLabel(payment.method)}</strong><span>{payment.receipt_number} · {formatDate(payment.received_at)}{payment.reference ? ` · ${payment.reference}` : ''}</span></div>) : <p className="customer-muted">لم تسجل دفعات مالية.</p>}</section>
                </div>
                <footer className="customer-order-card__actions">
                  {order.status !== 'delivered' && order.status !== 'cancelled' && <button className="btn btn--secondary" type="button" onClick={() => setDeliveryOrder(order)}>＋ تسجيل دفعة تسليم</button>}
                  {order.status !== 'cancelled' && <button className="btn btn--secondary" type="button" onClick={() => setPaymentOrder(order)}>＋ تسجيل تحصيل مالي</button>}
                </footer>
              </article>
            ))}</div>
          )}
        </section>
      </div>

      {orderModalOpen && <CustomerOrderModal customerId={customer.id} onClose={() => setOrderModalOpen(false)} onSaved={() => { setOrderModalOpen(false); void reload(); }} />}
      {deliveryOrder && <DeliveryModal customerId={customer.id} order={deliveryOrder} onClose={() => setDeliveryOrder(null)} onSaved={() => { setDeliveryOrder(null); void reload(); }} onError={setErrorFrom} />}
      {paymentOrder && <PaymentModal customerId={customer.id} order={paymentOrder} onClose={() => setPaymentOrder(null)} onSaved={() => { setPaymentOrder(null); void reload(); }} onError={setErrorFrom} />}
      {productionOrder && <ProductionOrderModal customerId={customer.id} order={productionOrder.order} line={productionOrder.line} onClose={() => setProductionOrder(null)} onSaved={() => { setProductionOrder(null); void reload(); }} onError={setErrorFrom} />}
      {saving && <span className="sr-only" role="status">جاري حفظ التغيير…</span>}
    </section>
  );
}

function ModalFrame({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <div className="customer-modal-backdrop"><section className="customer-modal customer-flow-modal" role="dialog" aria-modal="true" aria-label={title}><header><div><span>معاملة عميل</span><h3>{title}</h3></div><button type="button" aria-label="إغلاق" onClick={onClose}>×</button></header>{children}</section></div>;
}

function CustomerOrderModal({ customerId, onClose, onSaved }: { customerId: string; onClose: () => void; onSaved: () => void }) {
  const [products, setProducts] = useState<OrderableProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [type, setType] = useState<CustomerOrder['order_type']>('ready_goods');
  const [lines, setLines] = useState<DraftLine[]>([blankLine()]);
  const [discount, setDiscount] = useState('0');
  const [expectedDate, setExpectedDate] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { void fetchOrderableProducts().then(setProducts).catch((e: unknown) => setError(apiError(e))).finally(() => setLoading(false)); }, []);
  const changeLine = (index: number, patch: Partial<DraftLine>) => setLines((current) => current.map((line, i) => i === index ? { ...line, ...patch } : line));
  const gross = lines.reduce((sum, line) => sum + (Number(line.quantity) || 0) * (Number(line.unit_price) || 0), 0);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      const payload = {
        order_type: type, discount_amount: Number(discount) || 0,
        ...(expectedDate ? { expected_delivery_at: new Date(expectedDate).toISOString() } : {}),
        payment_terms: paymentTerms, notes,
        lines: lines.map((line) => ({ product_id: line.product_id, variant_id: line.variant_id, quantity: Number(line.quantity), unit_price: Number(line.unit_price), notes: line.notes })),
      };
      await createCustomerOrder(customerId, payload); onSaved();
    } catch (e) { setError(apiError(e)); } finally { setSaving(false); }
  };

  return <ModalFrame title="إنشاء معاملة جديدة" onClose={onClose}><form className="customer-flow-form" onSubmit={(event) => void submit(event)}>
    {error && <div className="customers-alert" role="alert">{error}</div>}
    <label>نوع التعامل<select value={type} onChange={(event) => setType(event.target.value as CustomerOrder['order_type'])}><option value="ready_goods">شراء منتج جاهز</option><option value="custom_manufacturing">تصنيع خاص للعميل</option></select></label>
    {loading ? <p className="customer-muted">جاري تحميل المنتجات المسجلة…</p> : !products.length ? <p className="customers-alert">لا توجد منتجات مسجلة في قاعدة البيانات؛ لا يمكن إنشاء الطلب.</p> : <>
      <div className="customer-draft-lines">{lines.map((line, index) => {
        const product = products.find((item) => item.id === line.product_id);
        return <fieldset key={index}><legend>الصنف {index + 1}</legend>
          <label>الموديل<select required value={line.product_id} onChange={(event) => changeLine(index, { product_id: event.target.value, variant_id: '' })}><option value="">اختر موديلًا</option>{products.map((item) => <option key={item.id} value={item.id}>{item.name_ar} · {item.code}</option>)}</select></label>
          <label>المقاس والموسم<select required value={line.variant_id} onChange={(event) => changeLine(index, { variant_id: event.target.value })}><option value="">اختر المتغير</option>{product?.variants.map((variant) => <option key={variant.id} value={variant.id}>{[variant.numeric_size, variant.letter_size, variant.season].filter(Boolean).join(' · ')}</option>)}</select></label>
          <div className="customer-form-grid"><label>الكمية<input required type="number" min="0.001" step="0.001" value={line.quantity} onChange={(event) => changeLine(index, { quantity: event.target.value })} /></label><label>سعر الوحدة (ج.م)<input required type="number" min="0" step="0.01" value={line.unit_price} onChange={(event) => changeLine(index, { unit_price: event.target.value })} /></label></div>
          <label>ملاحظات الصنف<input value={line.notes} onChange={(event) => changeLine(index, { notes: event.target.value })} /></label>
          {lines.length > 1 && <button className="customer-remove-line" type="button" onClick={() => setLines((current) => current.filter((_, i) => i !== index))}>حذف البند</button>}
        </fieldset>;
      })}</div>
      <button className="btn btn--secondary" type="button" onClick={() => setLines((current) => [...current, blankLine()])}>＋ إضافة صنف آخر</button>
    </>}
    <div className="customer-form-grid"><label>خصم إجمالي مؤقت (ج.م)<input type="number" min="0" max={gross} step="0.01" value={discount} onChange={(event) => setDiscount(event.target.value)} /></label><label>موعد التسليم المتوقع<input type="date" value={expectedDate} onChange={(event) => setExpectedDate(event.target.value)} /></label></div>
    <label>طريقة/شروط التعامل<textarea rows={2} maxLength={2000} value={paymentTerms} onChange={(event) => setPaymentTerms(event.target.value)} placeholder="مثال: دفعة مقدمة والباقي عند الاستلام — نص توثيقي فقط" /></label>
    <label>ملاحظات<textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
    <p className="customer-provisional-banner">الأسعار والخصم وموعد التسليم قيم تسجيل مبدئية؛ لا يوجد اعتماد سعر أو حجز مخزون آلي في هذه النسخة.</p>
    <footer><button type="button" className="btn btn--secondary" onClick={onClose}>إلغاء</button><button className="btn btn--primary" type="submit" disabled={saving || loading || !products.length}>{saving ? 'جاري الحفظ…' : 'حفظ المعاملة'}</button></footer>
  </form></ModalFrame>;
}

function DeliveryModal({ customerId, order, onClose, onSaved, onError }: { customerId: string; order: CustomerOrder; onClose: () => void; onSaved: () => void; onError: (error: unknown) => void }) {
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [receivedBy, setReceivedBy] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(null);
    try {
      const lines = order.lines.map((line) => ({ order_line_id: line.id, quantity: Number(quantities[line.id] || 0) })).filter((line) => line.quantity > 0);
      if (!lines.length) throw new Error('أدخل كمية واحدة على الأقل لتسجيل دفعة التسليم.');
      await recordCustomerDelivery(customerId, order.id, { received_by: receivedBy, notes, lines }); onSaved();
    } catch (e) { const message = apiError(e); setError(e instanceof Error && !(e instanceof ApiError) ? e.message : message); onError(e instanceof ApiError ? e : new ApiError(message)); } finally { setSaving(false); }
  };
  return <ModalFrame title={`دفعة تسليم · ${order.order_number}`} onClose={onClose}><form className="customer-flow-form" onSubmit={(event) => void submit(event)}>{error && <div className="customers-alert" role="alert">{error}</div>}
    {order.lines.map((line) => { const remaining = line.quantity - line.delivered_quantity; return <label key={line.id}>{line.product_name} · {line.variant_info} (متبقي {remaining})<input type="number" min="0" max={remaining} step="0.001" value={quantities[line.id] || ''} onChange={(event) => setQuantities((current) => ({ ...current, [line.id]: event.target.value }))} /></label>; })}
    <label>اسم مستلم البضاعة<input maxLength={128} value={receivedBy} onChange={(event) => setReceivedBy(event.target.value)} /></label><label>ملاحظات<textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
    <p className="customer-provisional-banner">سيُسجل هذا كدفعة تسليم للعميل، دون خصم مخزون المنتج التام حاليًا.</p><footer><button type="button" className="btn btn--secondary" onClick={onClose}>إلغاء</button><button className="btn btn--primary" type="submit" disabled={saving}>{saving ? 'جاري التسجيل…' : 'تسجيل دفعة التسليم'}</button></footer>
  </form></ModalFrame>;
}

function PaymentModal({ customerId, order, onClose, onSaved, onError }: { customerId: string; order: CustomerOrder; onClose: () => void; onSaved: () => void; onError: (error: unknown) => void }) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<CustomerPayment['method']>('cash');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => { event.preventDefault(); setSaving(true); setError(null); try { await recordCustomerPayment(customerId, order.id, { amount: Number(amount), method, reference, notes }); onSaved(); } catch (e) { setError(apiError(e)); onError(e); } finally { setSaving(false); } };
  return <ModalFrame title={`تسجيل تحصيل · ${order.order_number}`} onClose={onClose}><form className="customer-flow-form" onSubmit={(event) => void submit(event)}>{error && <div className="customers-alert" role="alert">{error}</div>}
    <p>المتبقي المبدئي على المعاملة: <strong>{formatMoney(order.balance_amount)}</strong></p><label>المبلغ المستلم (ج.م)<input required autoFocus type="number" min="0.01" step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
    <label>طريقة الدفع<select value={method} onChange={(event) => setMethod(event.target.value as CustomerPayment['method'])}><option value="cash">نقدي</option><option value="bank_transfer">تحويل بنكي</option><option value="other">أخرى</option></select></label>
    <label>رقم مرجعي / إيصال<input maxLength={128} value={reference} onChange={(event) => setReference(event.target.value)} /></label><label>ملاحظات<textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
    <p className="customer-provisional-banner">التسجيل متاح مؤقتًا للمدير المالي فقط، ويحفظ كإيصال تشغيلي ولا ينشئ قيدًا محاسبيًا.</p><footer><button type="button" className="btn btn--secondary" onClick={onClose}>إلغاء</button><button className="btn btn--primary" type="submit" disabled={saving}>{saving ? 'جاري التسجيل…' : 'تسجيل التحصيل'}</button></footer>
  </form></ModalFrame>;
}

function ProductionOrderModal({ customerId, order, line, onClose, onSaved, onError }: { customerId: string; order: CustomerOrder; line: CustomerOrderLine; onClose: () => void; onSaved: () => void; onError: (error: unknown) => void }) {
  const [templates, setTemplates] = useState<CustomerTemplate[]>([]);
  const [templateVersionId, setTemplateVersionId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void fetchCustomerTemplates(line.product_id).then(setTemplates).catch((e: unknown) => setError(apiError(e))).finally(() => setLoading(false)); }, [line.product_id]);
  const choices = templates.flatMap((template) => template.versions.filter((version) => version.status === 'active').map((version) => ({ id: version.id, label: `${template.name_ar} · إصدار ${version.version_number}` })));
  const submit = async (event: FormEvent) => { event.preventDefault(); setSaving(true); setError(null); try { await createCustomerProductionOrder(customerId, order.id, { customer_order_line_id: line.id, template_version_id: templateVersionId }); onSaved(); } catch (e) { setError(apiError(e)); onError(e); } finally { setSaving(false); } };
  return <ModalFrame title={`أمر تشغيل · ${line.product_name}`} onClose={onClose}><form className="customer-flow-form" onSubmit={(event) => void submit(event)}>{error && <div className="customers-alert" role="alert">{error}</div>}
    <p>{line.variant_info} · الكمية المطلوبة {line.quantity}</p>{loading ? <p>جاري تحميل قوالب الموديل…</p> : choices.length ? <label>قالب التشغيل<select required value={templateVersionId} onChange={(event) => setTemplateVersionId(event.target.value)}><option value="">اختر إصدار قالب نشطًا</option>{choices.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}</select></label> : <p className="customers-alert">لا يوجد قالب تشغيل نشط لهذا الموديل. أنشئ قالبًا أولًا من قسم دفعات الإنتاج.</p>}
    <p className="customer-provisional-banner">سيُنشأ أمر تشغيل مرتبط ببند العميل وبالكمية المتبقية. لا يتم صرف الخامات عند إنشاء الأمر.</p><footer><button type="button" className="btn btn--secondary" onClick={onClose}>إلغاء</button><button className="btn btn--primary" type="submit" disabled={saving || loading || !templateVersionId}>{saving ? 'جاري إنشاء الأمر…' : 'إنشاء أمر التشغيل'}</button></footer>
  </form></ModalFrame>;
}
