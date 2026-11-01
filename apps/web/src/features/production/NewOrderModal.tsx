import React, { useState, useEffect } from 'react';
import {
  Product,
  ProductionTemplate,
  OrderCreatePayload,
  createProductionOrderApi,
  ProductionOrder,
  CatalogItem,
  ProductionOrderItemPayload,
} from './productionApi';
import { fetchCustomers, Customer } from '@/features/customers/customersApi';

interface NewOrderModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOrderCreated: (order: ProductionOrder) => void;
  products: Product[];
  templates: ProductionTemplate[];
  catalogItems?: CatalogItem[];
  isCatalogLoading?: boolean;
  catalogError?: string | null;
}

interface OrderItemDisplay extends ProductionOrderItemPayload {
  product_name: string;
  variant_info: string;
  customer_name?: string;
}

export const NewOrderModal: React.FC<NewOrderModalProps> = ({
  isOpen,
  onClose,
  onOrderCreated,
  products,
  templates,
  catalogItems = [],
  isCatalogLoading = false,
  catalogError = null,
}) => {
  const [orderMode, setOrderMode] = useState<'single' | 'multiple'>('single');
  const [customers, setCustomers] = useState<Customer[]>([]);

  // حقول الموديل الفردي
  const [selectedProductId, setSelectedProductId] = useState<string>('');
  const [selectedVariantId, setSelectedVariantId] = useState<string>('');
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [targetQuantity, setTargetQuantity] = useState<number>(100);
  const [season, setSeason] = useState<string>('summer');
  const [assignedTo, setAssignedTo] = useState<string>('خط التشغيل الرئيسي ١');
  const [notes, setNotes] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // الخامات الإضافية اليدوية
  const [materialItemId, setMaterialItemId] = useState('');
  const [materialQuantity, setMaterialQuantity] = useState('');
  const [materialNotes, setMaterialNotes] = useState('');
  const [customMaterials, setCustomMaterials] = useState<Array<{ item_id: string; unit_id: string; planned_quantity: number; notes: string; item_name_ar: string; item_code: string; unit_name_ar: string }>>([]);

  // بنود الأمر المتعددة
  const [orderItems, setOrderItems] = useState<OrderItemDisplay[]>([]);
  const [itemProductId, setItemProductId] = useState<string>('');
  const [itemVariantId, setItemVariantId] = useState<string>('');
  const [itemQuantity, setItemQuantity] = useState<number>(50);
  const [itemSeason, setItemSeason] = useState<string>('summer');
  const [itemProductType, setItemProductType] = useState<'factory_brand' | 'private_label'>('factory_brand');
  const [itemCustomerId, setItemCustomerId] = useState<string>('');
  const [itemFabricName, setItemFabricName] = useState<string>('قطن مخلوط فاخر');
  const [itemFabricArea, setItemFabricArea] = useState<string>('3.2 متر');
  const [itemFabricColor, setItemFabricColor] = useState<string>('أبيض');
  const [itemFabricWeight, setItemFabricWeight] = useState<string>('220 جم');
  const [itemNotes, setItemNotes] = useState<string>('');

  useEffect(() => {
    if (isOpen) {
      fetchCustomers()
        .then((list) => setCustomers(list.filter((c) => c.status === 'active')))
        .catch(() => {});
    }
  }, [isOpen]);

  useEffect(() => {
    if (products.length > 0 && !selectedProductId) {
      setSelectedProductId(products[0].id);
    }
    if (products.length > 0 && !itemProductId) {
      setItemProductId(products[0].id);
    }
  }, [products, selectedProductId, itemProductId]);

  const currentProduct = products.find((p) => p.id === selectedProductId);
  const currentItemProduct = products.find((p) => p.id === itemProductId);

  useEffect(() => {
    if (currentProduct?.variants && currentProduct.variants.length > 0) {
      setSelectedVariantId(currentProduct.variants[0].id);
    } else {
      setSelectedVariantId('');
    }
  }, [currentProduct]);

  useEffect(() => {
    if (currentItemProduct?.variants && currentItemProduct.variants.length > 0) {
      setItemVariantId(currentItemProduct.variants[0].id);
    } else {
      setItemVariantId('');
    }
  }, [currentItemProduct]);

  // القوالب المتوافقة مع المنتج المحدد
  const matchingTemplates = templates.filter(
    (t) => !t.product_id || t.product_id === selectedProductId
  );

  useEffect(() => {
    if (matchingTemplates.length > 0) {
      setSelectedTemplateId(matchingTemplates[0].id);
    } else {
      setSelectedTemplateId('');
    }
  }, [selectedProductId, matchingTemplates.length]);

  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId);
  const activeVersion = selectedTemplate?.versions?.[0];
  const selectableMaterials = catalogItems.filter((item) =>
    item.is_active &&
    !activeVersion?.lines.some((line) => line.item_id === item.id) &&
    !customMaterials.some((line) => line.item_id === item.id)
  );

  const handleAddMaterial = () => {
    const item = catalogItems.find((candidate) => candidate.id === materialItemId && candidate.is_active);
    const quantity = Number(materialQuantity);
    if (!item || !Number.isFinite(quantity) || quantity <= 0) {
      setErrorMsg('اختر صنفاً وأدخل كمية أكبر من صفر لإضافته إلى الأمر.');
      return;
    }
    setCustomMaterials((previous) => [...previous, {
      item_id: item.id, unit_id: item.unit_id, planned_quantity: quantity,
      notes: materialNotes.trim(), item_name_ar: item.name_ar,
      item_code: item.code, unit_name_ar: item.unit_name_ar,
    }]);
    setMaterialItemId('');
    setMaterialQuantity('');
    setMaterialNotes('');
    setErrorMsg(null);
  };

  const handleAddOrderItem = () => {
    if (!itemProductId || !itemVariantId || itemQuantity <= 0) {
      setErrorMsg('اختر الموديل والمقاس وحدد كمية أكبر من صفر لإضافة البند.');
      return;
    }
    if (itemProductType === 'private_label' && !itemCustomerId) {
      setErrorMsg('اختر العميل عند تحديد نوع التصنيع للغير.');
      return;
    }
    const prod = products.find((p) => p.id === itemProductId);
    const variant = prod?.variants.find((v) => v.id === itemVariantId);
    const customer = customers.find((c) => c.id === itemCustomerId);

    const variantLabel = variant
      ? `مقاس رقمي ${variant.numeric_size || '—'} · حرفي ${variant.letter_size || '—'} · موسم ${variant.season || '—'}`
      : itemVariantId;

    const newItem: OrderItemDisplay = {
      product_id: itemProductId,
      variant_id: itemVariantId,
      product_name: prod ? prod.name_ar : 'موديل',
      variant_info: variantLabel,
      target_quantity: itemQuantity,
      season: itemSeason,
      product_type: itemProductType,
      customer_id: itemProductType === 'private_label' ? itemCustomerId : null,
      customer_name: customer ? customer.name : undefined,
      fabric_name: itemFabricName.trim(),
      fabric_area: itemFabricArea.trim(),
      fabric_color: itemFabricColor.trim(),
      fabric_weight: itemFabricWeight.trim(),
      notes: itemNotes.trim(),
    };

    setOrderItems((prev) => [...prev, newItem]);
    setItemNotes('');
    setErrorMsg(null);
  };

  const handleRemoveOrderItem = (index: number) => {
    setOrderItems((prev) => prev.filter((_, i) => i !== index));
  };

  // الحساب التناسبي المباشر للمعاينة
  const scalingRatio =
    activeVersion && activeVersion.reference_quantity > 0
      ? targetQuantity / activeVersion.reference_quantity
      : 1;

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setErrorMsg(null);

    let payload: OrderCreatePayload;

    if (orderMode === 'multiple' && orderItems.length > 0) {
      payload = {
        items: orderItems.map(({ product_id, variant_id, target_quantity: itemQty, season: itemSsn, product_type, customer_id, fabric_name, fabric_area, fabric_color, fabric_weight, notes: itemNts }) => ({
          product_id,
          variant_id,
          target_quantity: itemQty,
          season: itemSsn,
          product_type,
          customer_id,
          fabric_name,
          fabric_area,
          fabric_color,
          fabric_weight,
          notes: itemNts,
        })),
        assigned_to: assignedTo,
        notes,
      };
    } else {
      if (!selectedProductId || !selectedVariantId || targetQuantity <= 0) {
        setErrorMsg('يرجى تحديد المنتج والمقاس وإدخال كمية مستهدفة أكبر من صفر.');
        setIsSubmitting(false);
        return;
      }
      payload = {
        product_id: selectedProductId,
        variant_id: selectedVariantId,
        target_quantity: Number(targetQuantity),
        season,
        template_version_id: activeVersion?.id,
        custom_materials: customMaterials.map(({ item_id, unit_id, planned_quantity, notes: materialLineNotes }) => ({
          item_id, unit_id, planned_quantity, notes: materialLineNotes,
        })),
        assigned_to: assignedTo,
        notes,
      };
    }

    try {
      const created = await createProductionOrderApi(payload);
      onOrderCreated(created);
      onClose();
    } catch {
      setErrorMsg('تعذر حفظ أمر التشغيل. لم يتم إنشاء أمر محلي بديل؛ تحقق من تسجيل الدخول والاتصال ثم أعد المحاولة.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div
        className="modal-card modal-card--lg"
        onClick={(e) => e.stopPropagation()}
        dir="rtl"
      >
        <div className="modal-header">
          <div>
            <h2 className="modal-title">إنشاء أمر تشغيل جديد (مسودة دفعة)</h2>
            <p className="modal-subtitle">
              تحديد الموديل والمتغيرات ومواصفات الأقمشة وحساب لقطة الخامات التناسبية
            </p>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="إغلاق">
            ✕
          </button>
        </div>

        {errorMsg && (
          <div className="modal-alert modal-alert--danger">{errorMsg}</div>
        )}

        {/* أزرار التبديل بين الموديل الفردي والأمر المجمع */}
        <div style={{ display: 'flex', gap: '8px', padding: '12px 24px', borderBottom: '1px solid var(--border-color, #e2e8f0)', background: 'var(--bg-subtle, #f8fafc)' }}>
          <button
            type="button"
            className={`btn ${orderMode === 'single' ? 'btn--primary' : 'btn--secondary'}`}
            onClick={() => setOrderMode('single')}
            style={{ fontSize: '0.875rem' }}
          >
            📦 أمر موديل واحد
          </button>
          <button
            type="button"
            className={`btn ${orderMode === 'multiple' ? 'btn--primary' : 'btn--secondary'}`}
            onClick={() => setOrderMode('multiple')}
            style={{ fontSize: '0.875rem' }}
          >
            📋 أمر مجمع لعدة موديلات ومواصفات أقمشة ({orderItems.length})
          </button>
        </div>

        <form onSubmit={handleSubmit} className="modal-body">
          {orderMode === 'single' ? (
            <>
              <div className="form-grid">
                {/* اختيار الموديل */}
                <div className="form-field">
                  <label className="form-label">الموديل والتصميم المطلوب *</label>
                  <select
                    className="form-select"
                    value={selectedProductId}
                    onChange={(e) => setSelectedProductId(e.target.value)}
                    required
                  >
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name_ar} ({p.code})
                      </option>
                    ))}
                  </select>
                  <span className="form-hint">
                    {currentProduct?.description || 'الموديلات الستة المعتمدة للمصنع.'}
                  </span>
                </div>

                {/* اختيار المتغير: المقاسات والموسم */}
                <div className="form-field">
                  <label className="form-label">المقاس والموسم *</label>
                  <select
                    className="form-select"
                    value={selectedVariantId}
                    onChange={(e) => setSelectedVariantId(e.target.value)}
                    required
                  >
                    {currentProduct?.variants.map((v) => (
                      <option key={v.id} value={v.id}>
                        مقاس رقمي: {v.numeric_size || '—'} · حرفي: {v.letter_size || '—'} · موسم: {v.season || '—'}
                      </option>
                    ))}
                  </select>
                  <span className="form-hint">
                    الأبعاد الرقمية 56–64 محفوظة ومستقلة عن الحرفية S–2XL.
                  </span>
                </div>

                {/* الكمية المستهدفة */}
                <div className="form-field">
                  <label className="form-label" htmlFor="targetQtyInput">الكمية المستهدفة للدفعة (قطعة) *</label>
                  <input
                    id="targetQtyInput"
                    type="number"
                    min="1"
                    step="1"
                    className="form-input"
                    value={targetQuantity}
                    onChange={(e) => setTargetQuantity(Math.max(1, parseInt(e.target.value) || 0))}
                    required
                  />
                </div>

                {/* الموسم التشغيلي */}
                <div className="form-field">
                  <label className="form-label">الموسم التشغيلي</label>
                  <select
                    className="form-select"
                    value={season}
                    onChange={(e) => setSeason(e.target.value)}
                  >
                    <option value="summer">صيف (Summer)</option>
                    <option value="autumn">خريف (Autumn)</option>
                    <option value="winter">شتاء (Winter)</option>
                  </select>
                </div>

                {/* قالب الإنتاج المرجعي */}
                <div className="form-field form-field--full">
                  <label className="form-label">قالب الإنتاج لحساب استهلاك الخامات</label>
                  <select
                    className="form-select"
                    value={selectedTemplateId}
                    onChange={(e) => setSelectedTemplateId(e.target.value)}
                  >
                    <option value="">-- بدون قالب (إنشاء يدوي من الصفر) --</option>
                    {matchingTemplates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name_ar} (كمية مرجعية: {t.versions[0]?.reference_quantity || 50} قطعة)
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <section className="new-order-materials" aria-labelledby="new-order-materials-title">
                <div className="new-order-materials__heading">
                  <div>
                    <h3 id="new-order-materials-title">خامات أمر التشغيل</h3>
                    <p>يمكن استخدام خامات القالب وإضافة أصناف أخرى من دليل الأصناف قبل إنشاء المسودة.</p>
                  </div>
                  <span className="badge-tag">{(activeVersion?.lines.length || 0) + customMaterials.length} صنف</span>
                </div>
                <div className="new-order-material-form">
                  <label>
                    <span>إضافة صنف خامة</span>
                    <select value={materialItemId} onChange={(event) => setMaterialItemId(event.target.value)}>
                      <option value="">{isCatalogLoading ? 'جاري تحميل الأصناف…' : 'اختر صنفاً من دليل الأصناف المسجل'}</option>
                      {selectableMaterials.map((item) => <option key={item.id} value={item.id}>{item.name_ar} · {item.code} · {item.unit_name_ar}</option>)}
                    </select>
                  </label>
                  <label>
                    <span>الكمية المطلوبة</span>
                    <input type="number" min="0.01" step="0.01" value={materialQuantity} onChange={(event) => setMaterialQuantity(event.target.value)} />
                  </label>
                  <label>
                    <span>ملاحظة (اختياري)</span>
                    <input value={materialNotes} onChange={(event) => setMaterialNotes(event.target.value)} placeholder="مثال: لون أو مواصفة" />
                  </label>
                  <button type="button" className="btn btn--secondary" onClick={handleAddMaterial} disabled={!materialItemId || !materialQuantity}>＋ إضافة الصنف</button>
                  {catalogError && <span className="form-hint" role="alert">{catalogError}</span>}
                  {!catalogError && !isCatalogLoading && catalogItems.length === 0 && <span className="form-hint">لا توجد أصناف مسجلة في قاعدة البيانات؛ أضف الصنف أولاً من شاشة الأصناف والمخازن.</span>}
                </div>

                {/* معاينة لقطة الخامات التناسبية المحسوبة */}
                {(activeVersion?.lines.length || 0) + customMaterials.length > 0 ? (
                  <div className="materials-preview-card">
                    <div className="materials-preview-header">
                      <div>
                        <strong>معاينة لقطة الخامات المحسوبة نسبياً</strong>
                        <span className="materials-preview-ratio">
                          {activeVersion ? `معامل التناسب: ${targetQuantity} ÷ ${activeVersion.reference_quantity} = ${scalingRatio.toFixed(2)}x` : 'الكميات المضافة يدويًا'}
                        </span>
                      </div>
                      <span className="badge-tag">مسودة لقطة مستقلة</span>
                    </div>

                    <table className="preview-table">
                      <thead>
                        <tr>
                          <th>الصنف</th>
                          <th>الكود</th>
                          <th>الوحدة</th>
                          <th>{activeVersion ? `الكمية المرجعية (${activeVersion.reference_quantity} ق)` : 'المرجع'}</th>
                          <th>الكمية المخططة للدفعة ({targetQuantity} ق)</th>
                          <th>إجراء</th>
                        </tr>
                      </thead>
                      <tbody>
                        {activeVersion?.lines.map((l) => {
                          const scaledQty = Math.round(l.quantity_per_reference * scalingRatio * 100) / 100;
                          return (
                            <tr key={l.id}>
                              <td><strong>{l.item_name_ar}</strong></td>
                              <td><code>{l.item_code}</code></td>
                              <td>{l.unit_name_ar}</td>
                              <td>{l.quantity_per_reference}</td>
                              <td className="highlight-cell">
                                <strong>{scaledQty}</strong>
                              </td>
                              <td><span className="template-material-label">من القالب</span></td>
                            </tr>
                          );
                        })}
                        {customMaterials.map((line) => (
                          <tr key={`custom-${line.item_id}`}>
                            <td><strong>{line.item_name_ar}</strong><small className="material-source-label">إضافة يدوية</small></td>
                            <td><code>{line.item_code}</code></td>
                            <td>{line.unit_name_ar}</td>
                            <td>—</td>
                            <td className="highlight-cell"><strong>{line.planned_quantity}</strong></td>
                            <td><button type="button" className="material-remove-button" onClick={() => setCustomMaterials((previous) => previous.filter((candidate) => candidate.item_id !== line.item_id))}>حذف</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>

                    <div className="provisional-hint">
                      ℹ️ <strong>مبدأ التجميد (Snapshot):</strong> يتم نسخ هذه الخامات وربطها بأمر التشغيل كلقطة ثابتة فور إنشائه، بحيث لا يتأثر هذا الأمر بأي تعديلات تجري على قالب الإنتاج مستقبلاً.
                    </div>
                  </div>
                ) : <div className="empty-materials">لم تُضف خامات بعد. اختر قالباً أو أضف أصنافاً من دليل الأصناف.</div>}
              </section>
            </>
          ) : (
            <section className="multi-product-section" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div style={{ padding: '12px 16px', background: '#eff6ff', borderRadius: '8px', border: '1px solid #bfdbfe', color: '#1e40af', fontSize: '0.875rem' }}>
                💡 <strong>أمر مجمع متعدد الأصناف ومواصفات الأقمشة:</strong> أضف الموديلات والمقاسات المطلوبة ونوع التصنيع ومواصفات الأقمشة (المساحة، اللون، الوزن) لكل بند.
              </div>

              {/* بطاقة إضافة بند جديد */}
              <div style={{ border: '1px solid #cbd5e1', borderRadius: '8px', padding: '16px', background: '#ffffff' }}>
                <h4 style={{ margin: '0 0 12px 0', fontSize: '0.95rem', fontWeight: 600 }}>＋ إضافة بند منتج إلى أمر التشغيل</h4>
                <div className="form-grid">
                  <div className="form-field">
                    <label className="form-label">الموديل *</label>
                    <select
                      className="form-select"
                      value={itemProductId}
                      onChange={(e) => setItemProductId(e.target.value)}
                    >
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>{p.name_ar} ({p.code})</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-field">
                    <label className="form-label">المقاس والمتغير *</label>
                    <select
                      className="form-select"
                      value={itemVariantId}
                      onChange={(e) => setItemVariantId(e.target.value)}
                    >
                      {currentItemProduct?.variants.map((v) => (
                        <option key={v.id} value={v.id}>
                          رقمي: {v.numeric_size || '—'} · حرفي: {v.letter_size || '—'} · موسم: {v.season || '—'}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-field">
                    <label className="form-label">الكمية المطلوبة (قطعة) *</label>
                    <input
                      type="number"
                      min="1"
                      className="form-input"
                      value={itemQuantity}
                      onChange={(e) => setItemQuantity(Math.max(1, parseInt(e.target.value) || 0))}
                    />
                  </div>
                  <div className="form-field">
                    <label className="form-label">الموسم</label>
                    <select
                      className="form-select"
                      value={itemSeason}
                      onChange={(e) => setItemSeason(e.target.value)}
                    >
                      <option value="summer">صيف</option>
                      <option value="autumn">خريف</option>
                      <option value="winter">شتاء</option>
                    </select>
                  </div>
                  <div className="form-field">
                    <label className="form-label">نوع التصنيع</label>
                    <select
                      className="form-select"
                      value={itemProductType}
                      onChange={(e) => setItemProductType(e.target.value as any)}
                    >
                      <option value="factory_brand">براند المصنع (El-Qemma)</option>
                      <option value="private_label">تصنيع للغير (Private Label)</option>
                    </select>
                  </div>
                  {itemProductType === 'private_label' && (
                    <div className="form-field">
                      <label className="form-label">عميل التصنيع للغير *</label>
                      <select
                        className="form-select"
                        value={itemCustomerId}
                        onChange={(e) => setItemCustomerId(e.target.value)}
                      >
                        <option value="">-- اختر العميل --</option>
                        {customers.map((c) => (
                          <option key={c.id} value={c.id}>{c.name} ({c.code})</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {/* مواصفات القماش */}
                  <div className="form-field">
                    <label className="form-label">اسم / نوع القماش</label>
                    <input
                      type="text"
                      className="form-input"
                      value={itemFabricName}
                      onChange={(e) => setItemFabricName(e.target.value)}
                      placeholder="مثال: قطن مصري فاخر / كتان"
                    />
                  </div>
                  <div className="form-field">
                    <label className="form-label">مساحة القماش</label>
                    <input
                      type="text"
                      className="form-input"
                      value={itemFabricArea}
                      onChange={(e) => setItemFabricArea(e.target.value)}
                      placeholder="مثال: 3.2 متر مربع"
                    />
                  </div>
                  <div className="form-field">
                    <label className="form-label">لون القماش</label>
                    <input
                      type="text"
                      className="form-input"
                      value={itemFabricColor}
                      onChange={(e) => setItemFabricColor(e.target.value)}
                      placeholder="مثال: أبيض / كحلي"
                    />
                  </div>
                  <div className="form-field">
                    <label className="form-label">وزن القماش</label>
                    <input
                      type="text"
                      className="form-input"
                      value={itemFabricWeight}
                      onChange={(e) => setItemFabricWeight(e.target.value)}
                      placeholder="مثال: 220 جم/م²"
                    />
                  </div>
                </div>
                <div style={{ marginTop: '12px', display: 'flex', justifyContent: 'flex-end' }}>
                  <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={handleAddOrderItem}
                  >
                    ＋ إضافة البند إلى القائمة
                  </button>
                </div>
              </div>

              {/* جدول البنود المضافة */}
              <div style={{ border: '1px solid #cbd5e1', borderRadius: '8px', overflow: 'hidden' }}>
                <div style={{ padding: '10px 16px', background: '#f8fafc', fontWeight: 600, display: 'flex', justifyContent: 'space-between' }}>
                  <span>بنود أمر التشغيل المضافة ({orderItems.length})</span>
                  <span>إجمالي الكمية: {orderItems.reduce((acc, it) => acc + it.target_quantity, 0)} قطعة</span>
                </div>
                {orderItems.length > 0 ? (
                  <table className="preview-table" style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>الموديل</th>
                        <th>المقاس</th>
                        <th>الكمية</th>
                        <th>نوع التصنيع</th>
                        <th>مواصفات القماش</th>
                        <th>إجراء</th>
                      </tr>
                    </thead>
                    <tbody>
                      {orderItems.map((item, index) => (
                        <tr key={index}>
                          <td>{index + 1}</td>
                          <td><strong>{item.product_name}</strong></td>
                          <td><small>{item.variant_info}</small></td>
                          <td><strong style={{ color: 'var(--teal-accent, #0d9488)' }}>{item.target_quantity}</strong></td>
                          <td>
                            {item.product_type === 'factory_brand' ? (
                              <span className="badge-tag">براند المصنع</span>
                            ) : (
                              <span className="badge-tag" style={{ background: '#fef3c7', color: '#92400e' }}>
                                تصنيع: {item.customer_name || 'عميل'}
                              </span>
                            )}
                          </td>
                          <td>
                            <small>{item.fabric_name} · {item.fabric_color} · {item.fabric_weight} · {item.fabric_area}</small>
                          </td>
                          <td>
                            <button
                              type="button"
                              className="material-remove-button"
                              onClick={() => handleRemoveOrderItem(index)}
                            >
                              حذف
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div style={{ padding: '24px', textAlign: 'center', color: '#64748b' }}>
                    لم تتم إضافة بنود بعد. املأ النموذج أعلاه واضغط على "إضافة البند إلى القائمة".
                  </div>
                )}
              </div>
            </section>
          )}

          <div className="form-grid" style={{ marginTop: '16px' }}>
            <div className="form-field">
              <label className="form-label">خط التشغيل المسؤول</label>
              <input type="text" className="form-input" value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} placeholder="مثال: خط الخياطة ١ أو خط القص" />
            </div>
            <div className="form-field">
              <label className="form-label">ملاحظات التشغيل المؤقتة</label>
              <input type="text" className="form-input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="أي توجيهات خاصة بالوردية" />
            </div>
          </div>

          <div className="modal-actions">
            <button
              type="button"
              className="btn btn--secondary"
              onClick={onClose}
              disabled={isSubmitting}
            >
              إلغاء
            </button>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={isSubmitting || (orderMode === 'multiple' && orderItems.length === 0)}
            >
              {isSubmitting ? 'جاري الحفظ...' : '＋ تأكيد وإنشاء أمر التشغيل'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
