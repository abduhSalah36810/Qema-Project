import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '@/lib/api';
import { useDialog } from '@/components/feedback/DialogProvider';
import { fetchCatalogItems, type CatalogItem } from './productionApi';
import { fetchProductBoms, saveVariantBom, type ProductBoms, type VariantBom } from './bomApi';

/**
 * مستلزمات التصنيع لموديل: لكل مقاس قائمة أصناف من دليل الأصناف وكمية القطعة الواحدة.
 * الحفظ يُنشئ إصداراً جديداً؛ أوامر التشغيل السابقة تحتفظ بالمستلزمات التي أُنشئت بها.
 */
interface Props {
  productId: string;
  canManage: boolean;
  /** المقاس الذي يُفتح عليه المحرر (مثلاً أول مقاس بلا مستلزمات) */
  initialVariantId?: string;
  canOpenCatalog?: boolean;
  onOpenCatalog?: () => void;
  onClose: () => void;
}

interface DraftLine {
  key: string;
  item_id: string;
  quantity: string;
  notes: string;
}

const ITEM_TYPE_GROUPS: Array<[string, string]> = [
  ['fabric', 'أقمشة وخامات'],
  ['accessory', 'إكسسوارات وحليات'],
  ['packaging', 'مواد تعبئة وتغليف'],
  ['maintenance_supply', 'مستلزمات صيانة'],
  ['reusable_tool', 'أدوات تشغيل'],
];

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError || err instanceof Error ? err.message || fallback : fallback;
}

function formatDate(value: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ar-EG', { year: 'numeric', month: 'short', day: 'numeric' });
}

let keySeq = 0;
const newKey = () => `l${(keySeq += 1)}`;

function toDraft(bom: VariantBom | undefined): DraftLine[] {
  return (bom?.lines ?? []).map((l) => ({ key: newKey(), item_id: l.item_id, quantity: String(l.quantity_per_piece), notes: l.notes }));
}

/** صنف يصلح لمستلزمات التصنيع: معتمد، نشط، وليس منتجاً تاماً */
export function isBomUsable(item: CatalogItem): boolean {
  return item.is_active && item.item_type !== 'finished_garment' && (item.approval_status ?? 'approved') === 'approved';
}

export function BomEditor({ productId, canManage, initialVariantId, canOpenCatalog = false, onOpenCatalog, onClose }: Props) {
  const dialog = useDialog();
  const [data, setData] = useState<ProductBoms | null>(null);
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(initialVariantId ?? null);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [copyFrom, setCopyFrom] = useState('');
  const [showErrors, setShowErrors] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [boms, catalog] = await Promise.all([fetchProductBoms(productId), fetchCatalogItems()]);
      setData(boms);
      setItems(catalog.filter(isBomUsable));
      setSelectedId((cur) => (cur && boms.variants.some((v) => v.variant_id === cur) ? cur : boms.variants.find((v) => v.is_active !== false && !v.has_bom)?.variant_id ?? boms.variants[0]?.variant_id ?? null));
    } catch (err) {
      setError(errorText(err, 'تعذر تحميل مستلزمات الموديل.'));
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = data?.variants.find((v) => v.variant_id === selectedId);
  useEffect(() => {
    setLines(toDraft(selected));
    setDirty(false);
    setCopyFrom('');
    setShowErrors(false);
  }, [selected]);

  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const groupedItems = useMemo(() => {
    const groups = ITEM_TYPE_GROUPS.map(([type, label]) => ({ label, items: items.filter((i) => i.item_type === type) }));
    const known = new Set(ITEM_TYPE_GROUPS.map(([t]) => t));
    const other = items.filter((i) => !known.has(i.item_type));
    if (other.length) groups.push({ label: 'أصناف أخرى', items: other });
    return groups.filter((g) => g.items.length > 0);
  }, [items]);
  const activeVariants = data?.variants.filter((v) => v.is_active !== false) ?? [];
  const completeCount = activeVariants.filter((v) => v.has_bom).length;

  const lineError = (line: DraftLine): string | null => {
    if (!line.item_id) return 'اختر الصنف';
    if (!itemById.has(line.item_id)) return 'الصنف موقوف أو غير معتمد؛ استبدله';
    const qty = Number(line.quantity);
    if (!line.quantity.trim() || !Number.isFinite(qty) || qty <= 0) return 'اكتب كمية أكبر من صفر';
    if (lines.filter((l) => l.item_id === line.item_id).length > 1) return 'الصنف مكرر؛ اجمع كميته في سطر واحد';
    return null;
  };
  const errorCount = lines.filter((l) => lineError(l) !== null).length;

  const update = (key: string, patch: Partial<DraftLine>) => {
    setLines((cur) => cur.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    setDirty(true);
  };

  const confirmDiscard = async (): Promise<boolean> => {
    if (!dirty) return true;
    return dialog.confirm({
      title: 'تجاهل التغييرات غير المحفوظة؟',
      message: `مستلزمات ${selected?.label ?? 'هذا المقاس'} تغيرت ولم تُحفظ بعد.`,
      confirmLabel: 'تجاهل التغييرات',
      cancelLabel: 'الرجوع للتعديل',
      tone: 'danger',
    });
  };

  const selectVariant = async (variantId: string) => {
    if (variantId === selectedId) return;
    if (!(await confirmDiscard())) return;
    setNotice('');
    setSelectedId(variantId);
  };

  const close = async () => {
    if (await confirmDiscard()) onClose();
  };

  const copyLines = () => {
    const source = data?.variants.find((v) => v.variant_id === copyFrom);
    if (!source) return;
    setLines(toDraft(source));
    setDirty(true);
    setNotice(`نُسخت مستلزمات ${source.label}. راجع الكميات لتناسب هذا المقاس ثم احفظ.`);
  };

  const save = async () => {
    if (!selected) return;
    if (lines.length === 0 || errorCount > 0) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const saved = await saveVariantBom(
        selected.variant_id,
        lines.map((l) => ({ item_id: l.item_id, quantity_per_piece: Number(l.quantity).toFixed(4), notes: l.notes.trim() })),
      );
      const nextData = data && { ...data, variants: data.variants.map((v) => (v.variant_id === saved.variant_id ? saved : v)) };
      setData(nextData);
      setDirty(false);
      const nextMissing = nextData?.variants.find((v) => v.is_active !== false && !v.has_bom);
      setNotice(
        `حُفظت مستلزمات ${saved.label} (إصدار ${saved.version_number}). الأوامر الجديدة تستخدمها، والأوامر السابقة لا تتغير.`
        + (nextMissing ? ` المقاس التالي بدون مستلزمات: ${nextMissing.label}.` : ' كل مقاسات الموديل النشطة لها مستلزمات الآن.'),
      );
    } catch (err) {
      setError(errorText(err, 'تعذر حفظ المستلزمات.'));
    } finally {
      setSaving(false);
    }
  };

  const nextMissing = data?.variants.find((v) => v.is_active !== false && !v.has_bom && v.variant_id !== selectedId);

  return (
    <div className="customer-modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) void close(); }}>
      <section className="customer-modal bom-editor" role="dialog" aria-modal="true" aria-labelledby="bom-title">
        <header>
          <div>
            <span>مستلزمات التصنيع · الكميات لقطعة واحدة</span>
            <h3 id="bom-title">{data?.product_name ?? 'الموديل'}</h3>
          </div>
          <button type="button" aria-label="إغلاق" onClick={() => void close()}>×</button>
        </header>

        {error && <div className="customers-alert" role="alert">{error}</div>}
        {notice && <div className="notice notice--success" role="status"><span>{notice}</span><button type="button" className="notice__close" onClick={() => setNotice('')} aria-label="إخفاء">✕</button></div>}

        {loading ? (
          <p className="md-empty" role="status">جاري تحميل المستلزمات وأصناف الدليل…</p>
        ) : !data || data.variants.length === 0 ? (
          <p className="md-empty">لا توجد مقاسات لهذا الموديل. أضف مقاساته أولاً من «＋ مقاسات» في بطاقة الموديل.</p>
        ) : (
          <div className="bom-editor__body">
            <nav className="bom-editor__sizes" aria-label="المقاسات">
              <p className="form-hint">{completeCount} من {activeVariants.length} مقاس نشط له مستلزمات</p>
              {data.variants.map((v) => {
                const off = v.is_active === false;
                return (
                  <button
                    key={v.variant_id}
                    type="button"
                    className={`bom-size ${v.variant_id === selectedId ? 'bom-size--active' : ''}${off ? ' bom-size--off' : ''}`}
                    aria-current={v.variant_id === selectedId ? 'true' : undefined}
                    onClick={() => void selectVariant(v.variant_id)}
                  >
                    <span>{v.label}</span>
                    <span className={`status-badge status-badge--${off ? 'muted' : v.has_bom ? 'done' : 'waiting'}`}>
                      {off ? 'موقوف' : v.has_bom ? `مكتمل · إصدار ${v.version_number}` : 'بدون مستلزمات'}
                    </span>
                  </button>
                );
              })}
            </nav>

            {selected && (
              <div className="bom-editor__lines">
                <div className="bom-editor__head">
                  <div>
                    <h4>{selected.label}</h4>
                    <small className="form-hint">
                      {selected.has_bom
                        ? `الإصدار النشط: ${selected.version_number}${selected.updated_at ? ` · حُفظ ${formatDate(selected.updated_at)}` : ''}`
                        : 'لم تُعرّف مستلزمات هذا المقاس بعد؛ لا يمكن إنشاء أوامر تشغيل له.'}
                    </small>
                  </div>
                  {canManage && data.variants.some((v) => v.has_bom && v.variant_id !== selected.variant_id) && (
                    <div className="bom-editor__copy">
                      <select aria-label="نسخ المستلزمات من مقاس آخر" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
                        <option value="">نسخ من مقاس آخر…</option>
                        {data.variants.filter((v) => v.has_bom && v.variant_id !== selected.variant_id).map((v) => (
                          <option key={v.variant_id} value={v.variant_id}>{v.label}</option>
                        ))}
                      </select>
                      <button type="button" className="btn btn--secondary btn--sm" disabled={!copyFrom} onClick={copyLines}>نسخ</button>
                    </div>
                  )}
                </div>
                {selected.is_active === false && (
                  <p className="notice notice--warning">هذا المقاس موقوف؛ لا يُستخدم في أوامر جديدة حتى يُعاد تفعيله من «إدارة المقاسات».</p>
                )}
                {selected.lines.some((l) => !l.item_usable) && (
                  <p className="notice notice--warning">أحد أصناف هذه المستلزمات موقوف أو غير معتمد في دليل الأصناف؛ استبدله ثم احفظ، وإلا لن يمكن إنشاء أوامر لهذا المقاس.</p>
                )}
                {canManage && <p className="form-hint">اختر كل خامة أو مستلزم تحتاجه القطعة الواحدة من دليل الأصناف، واكتب كميته بوحدة الصنف (مثلاً 2.5 متر قماش، 6 زراير).</p>}

                <div className="payroll-table-wrap">
                  <table className="md-table bom-table">
                    <thead>
                      <tr><th>الصنف (من دليل الأصناف)</th><th>الكمية للقطعة</th><th>الوحدة</th><th>ملاحظة</th>{canManage && <th aria-label="حذف" />}</tr>
                    </thead>
                    <tbody>
                      {lines.length === 0 && (
                        <tr><td colSpan={canManage ? 5 : 4} className="md-empty">
                          {canManage ? 'لا توجد مستلزمات لهذا المقاس بعد. اضغط «＋ إضافة صنف» أو انسخ من مقاس آخر.' : 'لا توجد مستلزمات معرّفة لهذا المقاس.'}
                        </td></tr>
                      )}
                      {lines.map((line) => {
                        const err = showErrors || line.item_id || line.quantity ? lineError(line) : null;
                        const item = itemById.get(line.item_id);
                        const saved = selected.lines.find((l) => l.item_id === line.item_id);
                        return (
                          <tr key={line.key} className={err ? 'bom-table__row--error' : undefined}>
                            <td data-label="الصنف">
                              {canManage ? (
                                <select aria-label="الصنف" value={line.item_id} aria-invalid={Boolean(err) && (!line.item_id || !item || err?.startsWith('الصنف مكرر'))} onChange={(e) => update(line.key, { item_id: e.target.value })}>
                                  <option value="">— اختر الصنف —</option>
                                  {line.item_id && !item && <option value={line.item_id}>{saved?.item_name ?? 'صنف غير متاح'} (موقوف/غير معتمد)</option>}
                                  {groupedItems.map((g) => (
                                    <optgroup key={g.label} label={g.label}>
                                      {g.items.map((i) => <option key={i.id} value={i.id}>{i.name_ar} · {i.code}</option>)}
                                    </optgroup>
                                  ))}
                                </select>
                              ) : (item?.name_ar ?? saved?.item_name ?? '—')}
                            </td>
                            <td data-label="الكمية للقطعة">
                              {canManage ? (
                                <input type="number" min="0" step="0.0001" inputMode="decimal" aria-label="الكمية لكل قطعة" placeholder="مثال: 2.5" value={line.quantity} aria-invalid={Boolean(err) && err?.startsWith('اكتب كمية')} onChange={(e) => update(line.key, { quantity: e.target.value })} />
                              ) : line.quantity}
                              {err && canManage && <small className="field-error">{err}</small>}
                            </td>
                            <td data-label="الوحدة">{item?.unit_name_ar ?? saved?.unit_name ?? '—'}</td>
                            <td data-label="ملاحظة">{canManage ? <input aria-label="ملاحظة" maxLength={500} value={line.notes} placeholder="اختياري" onChange={(e) => update(line.key, { notes: e.target.value })} /> : (line.notes || '—')}</td>
                            {canManage && (
                              <td><button type="button" className="md-link md-link--muted" onClick={() => { setLines((cur) => cur.filter((l) => l.key !== line.key)); setDirty(true); }}>حذف</button></td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {canManage && (
                  <div className="bom-editor__actions">
                    <button type="button" className="btn btn--secondary btn--sm" onClick={() => { setLines((cur) => [...cur, { key: newKey(), item_id: '', quantity: '', notes: '' }]); setDirty(true); }}>＋ إضافة صنف</button>
                    <button type="button" className="btn btn--primary" disabled={saving || !dirty} onClick={() => void save()}>
                      {saving ? 'جاري الحفظ…' : 'حفظ مستلزمات هذا المقاس'}
                    </button>
                    {dirty && (
                      <button type="button" className="md-link md-link--muted" onClick={() => { setLines(toDraft(selected)); setDirty(false); setShowErrors(false); }}>تراجع عن التغييرات</button>
                    )}
                    {dirty && <small className="form-hint">تغييرات غير محفوظة{showErrors && errorCount > 0 ? ` · صحّح ${errorCount} سطر قبل الحفظ` : ''}{showErrors && lines.length === 0 ? ' · أضف صنفاً واحداً على الأقل' : ''}</small>}
                    {!dirty && nextMissing && (
                      <button type="button" className="md-link" onClick={() => void selectVariant(nextMissing.variant_id)}>المقاس التالي بدون مستلزمات: {nextMissing.label} ←</button>
                    )}
                  </div>
                )}
                {items.length === 0 && canManage && (
                  <p className="notice notice--warning">
                    لا توجد أصناف معتمدة نشطة في دليل الأصناف لاختيارها. أضف الخامات والمستلزمات واعتمدها من «دليل الخامات والأصناف» أولاً.
                    {canOpenCatalog && onOpenCatalog && <> <button type="button" className="md-link" onClick={onOpenCatalog}>فتح دليل الأصناف</button></>}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
