import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import {
  Product,
  ProductionTemplate,
  createProductionOrderApi,
  ProductionOrder,
  CatalogItem,
  ProductionOrderItemPayload,
} from './productionApi';
import { previewOrderRequirements, type Requirements } from './bomApi';
import { fetchCustomers, Customer } from '@/features/customers/customersApi';
import { useDialog } from '@/components/feedback/DialogProvider';

/**
 * أمر تشغيل موحد: سطر واحد أو أكثر (موديل + مقاس + مواصفات + كمية) دون اختيار «نوع» الأمر.
 * الاحتياجات تُحسب تلقائياً من مستلزمات التصنيع (BOM) لكل مقاس وتُقارن برصيد مخزن الخامات.
 * لا يُصرف شيء عند الإنشاء؛ الصرف يبقى بدورته الحالية بواسطة أمين المخزن.
 */
interface NewOrderModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOrderCreated: (order: ProductionOrder) => void;
  products: Product[];
  templates?: ProductionTemplate[];
  catalogItems?: CatalogItem[];
  isCatalogLoading?: boolean;
  catalogError?: string | null;
}

interface DraftLine {
  key: string;
  product_id: string;
  variant_id: string;
  quantity: string;
  product_type: 'factory_brand' | 'private_label';
  customer_id: string;
  fabric_name: string;
  fabric_area: string;
  fabric_color: string;
  fabric_weight: string;
  notes: string;
  showSpecs: boolean;
}

const SEASON_AR: Record<string, string> = { summer: 'صيفي', autumn: 'خريفي', winter: 'شتوي' };
let lineSeq = 0;
const emptyLine = (productId = ''): DraftLine => ({
  key: `ln${(lineSeq += 1)}`, product_id: productId, variant_id: '', quantity: '', product_type: 'factory_brand', customer_id: '',
  fabric_name: '', fabric_area: '', fabric_color: '', fabric_weight: '', notes: '', showSpecs: false,
});

function qty(n: number): string {
  return n.toLocaleString('ar-EG', { maximumFractionDigits: 3 });
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError || err instanceof Error ? err.message || fallback : fallback;
}

export const NewOrderModal: React.FC<NewOrderModalProps> = ({ isOpen, onClose, onOrderCreated, products: allProducts }) => {
  const dialog = useDialog();
  // الموديلات والمقاسات الموقوفة لا تُختار في أوامر جديدة
  const products = useMemo(
    () => allProducts
      .filter((p) => p.is_active !== false)
      .map((p) => ({ ...p, variants: p.variants.filter((v) => v.is_active !== false) })),
    [allProducts],
  );
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  const [assignedTo, setAssignedTo] = useState('');
  const [notes, setNotes] = useState('');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customersUnavailable, setCustomersUnavailable] = useState(false);
  const [requirements, setRequirements] = useState<Requirements | null>(null);
  const [reqLoading, setReqLoading] = useState(false);
  const [reqError, setReqError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const requestSeq = useRef(0);

  useEffect(() => {
    if (!isOpen) return;
    setLines([emptyLine()]);
    setAssignedTo('');
    setNotes('');
    setRequirements(null);
    setSubmitError('');
    fetchCustomers()
      .then((list) => { setCustomers(list.filter((c) => c.status === 'active')); setCustomersUnavailable(false); })
      .catch(() => setCustomersUnavailable(true));
  }, [isOpen]);

  const productById = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);

  const lineIssue = (line: DraftLine): string | null => {
    if (!line.product_id) return 'اختر الموديل';
    if (!line.variant_id) return 'اختر المقاس';
    const q = Number(line.quantity);
    if (!Number.isFinite(q) || q <= 0) return 'أدخل الكمية';
    if (line.product_type === 'private_label' && !line.customer_id) return 'اختر العميل';
    return null;
  };
  const validLines = lines.filter((l) => lineIssue(l) === null);
  const allValid = lines.length > 0 && validLines.length === lines.length;

  // معاينة الاحتياجات تلقائياً عند تغيّر الأسطر الصالحة
  const reqKey = JSON.stringify(validLines.map((l) => [l.product_id, l.variant_id, Number(l.quantity)]));
  useEffect(() => {
    if (!isOpen) return;
    if (validLines.length === 0) {
      setRequirements(null);
      setReqError('');
      return;
    }
    const seq = (requestSeq.current += 1);
    setReqLoading(true);
    const timer = setTimeout(() => {
      previewOrderRequirements(validLines.map((l) => ({ product_id: l.product_id, variant_id: l.variant_id, quantity: Number(l.quantity) })))
        .then((res) => { if (seq === requestSeq.current) { setRequirements(res); setReqError(''); } })
        .catch((err) => { if (seq === requestSeq.current) setReqError(errorText(err, 'تعذر حساب الاحتياجات.')); })
        .finally(() => { if (seq === requestSeq.current) setReqLoading(false); });
    }, 350);
    return () => clearTimeout(timer);
  }, [reqKey, isOpen]);

  if (!isOpen) return null;

  const update = (key: string, patch: Partial<DraftLine>) =>
    setLines((cur) => cur.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const lineReq = (line: DraftLine) =>
    requirements?.lines.find((r) => r.variant_id === line.variant_id && r.product_id === line.product_id);

  const isPristine = lines.every((l) => !l.product_id && !l.quantity) && !assignedTo.trim() && !notes.trim();
  const requestClose = async () => {
    if (submitting) return;
    if (isPristine) { onClose(); return; }
    const ok = await dialog.confirm({
      title: 'إغلاق دون إنشاء الأمر؟',
      message: 'ستُفقد الموديلات والكميات التي أدخلتها.',
      confirmLabel: 'إغلاق',
      cancelLabel: 'متابعة الإدخال',
      tone: 'danger',
    });
    if (ok) onClose();
  };

  // سطر مكرر بنفس الموديل والمقاس ونوع التصنيع والعميل والقماش: تنبيه فقط لأن المواصفات قد تختلف
  const duplicateKeys = new Set<string>();
  const seenKeys = new Map<string, string>();
  for (const l of lines) {
    if (!l.product_id || !l.variant_id) continue;
    const k = [l.product_id, l.variant_id, l.product_type, l.customer_id, l.fabric_name, l.fabric_color].join('|');
    const first = seenKeys.get(k);
    if (first) { duplicateKeys.add(l.key); duplicateKeys.add(first); } else seenKeys.set(k, l.key);
  }
  const shortageCount = requirements?.materials.filter((m) => m.shortage_quantity > 0).length ?? 0;
  const blockedLines = requirements?.lines.filter((l) => !l.has_bom) ?? [];

  const totalPieces = validLines.reduce((sum, l) => sum + Number(l.quantity), 0);
  const canCreate = allValid && !!requirements?.can_create && !reqLoading && !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canCreate) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const items: ProductionOrderItemPayload[] = lines.map((l) => {
        const variant = productById.get(l.product_id)?.variants.find((v) => v.id === l.variant_id);
        return {
          product_id: l.product_id,
          variant_id: l.variant_id,
          target_quantity: Number(l.quantity),
          season: variant?.season || 'summer',
          product_type: l.product_type,
          customer_id: l.product_type === 'private_label' ? l.customer_id : null,
          fabric_name: l.fabric_name.trim(),
          fabric_area: l.fabric_area.trim(),
          fabric_color: l.fabric_color.trim(),
          fabric_weight: l.fabric_weight.trim(),
          notes: l.notes.trim(),
        };
      });
      const order = await createProductionOrderApi({ items, assigned_to: assignedTo.trim(), notes: notes.trim() });
      onOrderCreated(order);
      onClose();
    } catch (err) {
      setSubmitError(errorText(err, 'تعذر إنشاء أمر التشغيل.'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={() => void requestClose()} role="dialog" aria-modal="true" aria-labelledby="new-order-title">
      <div className="modal-card modal-card--lg new-order" onClick={(e) => e.stopPropagation()} dir="rtl">
        <div className="modal-header">
          <div>
            <h2 className="modal-title" id="new-order-title">إنشاء أمر تشغيل جديد (مسودة دفعة)</h2>
            <p className="modal-subtitle">أضف موديلاً واحداً أو أكثر بمقاساتهم وكمياتهم؛ تُحسب الخامات المطلوبة تلقائياً من مستلزمات كل مقاس.</p>
          </div>
          <button className="modal-close" onClick={() => void requestClose()} aria-label="إغلاق">✕</button>
        </div>

        <form className="modal-body" onSubmit={(e) => void handleSubmit(e)}>
          <section aria-labelledby="order-lines-title">
            <h3 id="order-lines-title" className="new-order__title">١. الموديلات والكميات</h3>
            {products.length === 0 && (
              <p className="notice notice--warning">لا توجد موديلات نشطة. أضف الموديلات ومقاساتها ومستلزماتها من «البيانات الأساسية ← الموديلات والمقاسات» أولاً.</p>
            )}
            <div className="payroll-table-wrap">
              <table className="md-table new-order__lines">
                <thead>
                  <tr><th>الموديل</th><th>المقاس / المواصفة</th><th>الكمية (قطعة)</th><th>المستلزمات</th><th aria-label="إجراءات" /></tr>
                </thead>
                <tbody>
                  {lines.map((line, idx) => {
                    const product = productById.get(line.product_id);
                    const req = lineReq(line);
                    const issue = lineIssue(line);
                    return (
                      <React.Fragment key={line.key}>
                        <tr>
                          <td>
                            <select aria-label={`موديل السطر ${idx + 1}`} value={line.product_id} onChange={(e) => update(line.key, { product_id: e.target.value, variant_id: '' })}>
                              <option value="">— اختر الموديل —</option>
                              {products.map((p) => <option key={p.id} value={p.id}>{p.name_ar} ({p.code})</option>)}
                            </select>
                          </td>
                          <td>
                            <select aria-label={`مقاس السطر ${idx + 1}`} value={line.variant_id} disabled={!product} onChange={(e) => update(line.key, { variant_id: e.target.value })}>
                              <option value="">— اختر المقاس —</option>
                              {(product?.variants ?? [])
                                .slice()
                                .sort((a, b) => Number(a.numeric_size) - Number(b.numeric_size))
                                .map((v) => (
                                  <option key={v.id} value={v.id}>
                                    مقاس {v.numeric_size}{v.letter_size ? ` · ${v.letter_size}` : ''} · {SEASON_AR[v.season || ''] || v.season}{v.has_bom === false ? ' — بدون مستلزمات' : ''}
                                  </option>
                                ))}
                            </select>
                            {product && product.variants.length === 0 && <small className="field-error">لا توجد مقاسات نشطة لهذا الموديل</small>}
                            {duplicateKeys.has(line.key) && <small className="form-hint">نفس الموديل والمقاس في سطر آخر؛ اجمع الكمية في سطر واحد إلا إذا اختلفت المواصفات.</small>}
                          </td>
                          <td>
                            <input type="number" min="1" step="1" inputMode="numeric" aria-label={`كمية السطر ${idx + 1}`} placeholder="مثال: 100" value={line.quantity} onChange={(e) => update(line.key, { quantity: e.target.value })} />
                          </td>
                          <td>
                            {issue ? <small className="form-hint">{issue}</small>
                              : !req ? <small className="form-hint">{reqLoading ? 'جاري الحساب…' : '—'}</small>
                              : req.has_bom ? <span className="status-badge status-badge--done">مستلزمات إصدار {req.bom_version_number}</span>
                              : <span className="status-badge status-badge--rejected" title={req.issue}>{req.issue.includes('موقوف') ? 'موقوف' : 'بدون مستلزمات'}</span>}
                          </td>
                          <td className="new-order__line-actions">
                            {line.product_id && (
                              <button type="button" className="md-link" title="إضافة سطر جديد بنفس الموديل لمقاس آخر"
                                onClick={() => setLines((cur) => {
                                  const i = cur.findIndex((l) => l.key === line.key);
                                  const next = cur.slice();
                                  next.splice(i + 1, 0, emptyLine(line.product_id));
                                  return next;
                                })}>
                                ＋ مقاس
                              </button>
                            )}
                            <button type="button" className="md-link" onClick={() => update(line.key, { showSpecs: !line.showSpecs })} aria-expanded={line.showSpecs}>
                              {line.showSpecs ? 'إخفاء المواصفات' : 'المواصفات'}
                            </button>
                            {lines.length > 1 && (
                              <button type="button" className="md-link md-link--muted" onClick={() => setLines((cur) => cur.filter((l) => l.key !== line.key))}>حذف</button>
                            )}
                          </td>
                        </tr>
                        {line.showSpecs && (
                          <tr className="new-order__specs">
                            <td colSpan={5}>
                              <div className="payroll-add__grid">
                                <label>نوع التصنيع
                                  <select value={line.product_type} onChange={(e) => update(line.key, { product_type: e.target.value as DraftLine['product_type'], customer_id: '' })}>
                                    <option value="factory_brand">إنتاج المصنع</option>
                                    <option value="private_label" disabled={customersUnavailable}>تصنيع لعميل</option>
                                  </select>
                                </label>
                                {line.product_type === 'private_label' && (
                                  <label>العميل <span className="field-required" aria-hidden>*</span>
                                    <select value={line.customer_id} onChange={(e) => update(line.key, { customer_id: e.target.value })}>
                                      <option value="">— اختر العميل —</option>
                                      {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                                    </select>
                                  </label>
                                )}
                                <label>نوع القماش<input maxLength={128} value={line.fabric_name} placeholder="مثال: قطن مصري" onChange={(e) => update(line.key, { fabric_name: e.target.value })} /></label>
                                <label>اللون<input maxLength={64} value={line.fabric_color} placeholder="مثال: أبيض" onChange={(e) => update(line.key, { fabric_color: e.target.value })} /></label>
                                <label>الوزن<input maxLength={64} value={line.fabric_weight} placeholder="مثال: 220 جم" onChange={(e) => update(line.key, { fabric_weight: e.target.value })} /></label>
                                <label>المساحة<input maxLength={128} value={line.fabric_area} placeholder="مثال: 3.2 متر" onChange={(e) => update(line.key, { fabric_area: e.target.value })} /></label>
                                <label className="payroll-add__wide">ملاحظات السطر<input maxLength={2000} value={line.notes} onChange={(e) => update(line.key, { notes: e.target.value })} /></label>
                              </div>
                              {customersUnavailable && <small className="form-hint">التصنيع لعميل غير متاح بصلاحيتك الحالية.</small>}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => setLines((cur) => [...cur, emptyLine()])}>＋ إضافة موديل / مقاس</button>
            {validLines.length > 0 && <p className="form-hint">إجمالي الأمر: {qty(totalPieces)} قطعة في {validLines.length} سطر.</p>}
          </section>

          <section aria-labelledby="order-req-title" className="new-order__req">
            <h3 id="order-req-title" className="new-order__title">٢. الاحتياجات من مخزن الخامات</h3>
            {reqError && <p className="notice notice--error" role="alert">{reqError}</p>}
            {!requirements && !reqLoading && <p className="form-hint">اختر الموديلات والمقاسات والكميات لتظهر الخامات المطلوبة.</p>}
            {blockedLines.length > 0 && (
              <div className="notice notice--error" role="alert">
                <div>
                  <strong>لا يمكن الإنشاء: مستلزمات التصنيع ناقصة لـ</strong>
                  <ul>{blockedLines.map((l) => <li key={l.variant_id}>{l.product_name} — {l.variant_label}{l.issue.includes('موقوف') ? ` (${l.issue})` : ''}</li>)}</ul>
                  <small>يعرّفها مسؤول الإنتاج من «البيانات الأساسية ← الموديلات والمقاسات ← مستلزمات التصنيع»، أو احذف السطر من الأمر.</small>
                </div>
              </div>
            )}
            {requirements && requirements.materials.length > 0 && (
              <div className="new-order__summary" aria-label="ملخص الاحتياجات">
                <span><strong>{requirements.materials.length}</strong> صنف مطلوب</span>
                <span className={shortageCount ? 'new-order__summary--bad' : 'new-order__summary--ok'}>
                  {shortageCount ? <><strong>{shortageCount}</strong> صنف به عجز</> : 'كل الأصناف متوفرة بالكامل'}
                </span>
                {reqLoading && <span role="status">جاري التحديث…</span>}
              </div>
            )}
            {requirements && requirements.materials.length > 0 && (
              <div className="payroll-table-wrap">
                <table className="md-table new-order__materials">
                  <thead>
                    <tr><th>الصنف</th><th>الوحدة</th><th>المطلوب</th><th>المتاح بالخامات</th><th>يمكن صرفه</th><th>العجز</th><th>الحالة</th></tr>
                  </thead>
                  <tbody>
                    {requirements.materials.map((m) => (
                      <tr key={`${m.item_id}:${m.unit_id}`} className={m.shortage_quantity > 0 ? 'new-order__short' : ''}>
                        <td><strong>{m.item_name}</strong><br /><small>{m.item_code}</small>{!m.item_active && <small className="field-error">الصنف موقوف أو غير معتمد</small>}</td>
                        <td data-label="الوحدة">{m.unit_name}</td>
                        <td data-label="المطلوب">{qty(m.required_quantity)}</td>
                        <td data-label="المتاح بالخامات">{qty(m.available_quantity)}</td>
                        <td data-label="يمكن صرفه">{qty(m.dispatchable_quantity)}</td>
                        <td data-label="العجز">{m.shortage_quantity > 0 ? <strong className="payroll-sheet__minus">{qty(m.shortage_quantity)}</strong> : '—'}</td>
                        <td data-label="الحالة">
                          {!m.item_active ? <span className="status-badge status-badge--rejected">صنف موقوف</span>
                            : m.shortage_quantity > 0 ? <span className="status-badge status-badge--rejected">عجز · يوقف الصرف</span>
                            : <span className="status-badge status-badge--done">متوفر</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {requirements?.has_shortage && requirements.can_create && (
              <p className="notice notice--warning">
                يوجد عجز في بعض الخامات. يمكنك إنشاء الأمر الآن، لكن صرف الخامات لن يتم حتى يتوفر الرصيد كاملاً في مخزن الخامات.
              </p>
            )}
            {requirements && requirements.lines.some((l) => l.materials.length > 0) && (
              <details className="new-order__breakdown">
                <summary>تفاصيل المستلزمات لكل سطر</summary>
                {requirements.lines.filter((l) => l.materials.length > 0).map((l) => (
                  <div key={`${l.product_id}:${l.variant_id}`}>
                    <strong>{l.product_name} — {l.variant_label}</strong> <small>({qty(l.quantity)} قطعة · إصدار {l.bom_version_number})</small>
                    <ul>
                      {l.materials.map((m) => (
                        <li key={m.item_id}>{m.item_name}: {qty(m.quantity_per_piece)} {m.unit_name} للقطعة × {qty(l.quantity)} = <strong>{qty(m.total_quantity)} {m.unit_name}</strong></li>
                      ))}
                    </ul>
                  </div>
                ))}
              </details>
            )}
            <p className="form-hint">الأرقام للمعاينة ولا تحجز رصيداً ولا تصرف شيئاً؛ قد يتغير المتاح قبل الصرف بسبب أوامر أخرى.</p>
          </section>

          <section className="payroll-add__grid" aria-label="بيانات الأمر">
            <label>خط التشغيل المسؤول<input maxLength={128} value={assignedTo} placeholder="مثال: خط الإنتاج 1" onChange={(e) => setAssignedTo(e.target.value)} /></label>
            <label className="payroll-add__wide">ملاحظات الأمر<input maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
          </section>

          {submitError && <p className="field-error" role="alert">{submitError}</p>}
          <div className="modal-footer">
            <button type="button" className="btn btn--secondary" onClick={() => void requestClose()}>إلغاء</button>
            <button type="submit" className="btn btn--primary" disabled={!canCreate}>
              {submitting ? 'جاري الإنشاء…' : 'إنشاء أمر التشغيل'}
            </button>
          </div>
          {!allValid && <p className="form-hint">أكمل كل الأسطر (الموديل، المقاس، الكمية) قبل الإنشاء.</p>}
        </form>
      </div>
    </div>
  );
};
