import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/features/auth/AuthContext';
import { CustomersView } from '@/features/customers/CustomersView';
import { financeApi, type Supplier } from '@/features/finance/financeApi';
import { payrollApi, type Employee } from '@/features/payroll/payrollApi';
import { EMPTY_PAY_VALUES, PayTypeFields, payPayload, payTypeSummary, validatePay, type PayFormValues } from '@/features/payroll/PayTypeFields';
import {
  addProductVariantsApi,
  createProductApi,
  fetchProducts,
  fetchWarehouses,
  updateProductApi,
  updateProductVariantApi,
  type Product,
  type ProductVariant,
  type Warehouse,
} from '@/features/production/productionApi';
import { fetchUnits, type Unit } from '@/features/catalog/catalogApi';
import { BomEditor } from '@/features/production/BomEditor';
import { useDialog } from '@/components/feedback/DialogProvider';

type TabId = 'suppliers' | 'customers' | 'products' | 'employees' | 'reference';

const SEASON_AR: Record<string, string> = { summer: 'صيفي', autumn: 'خريفي', winter: 'شتوي' };

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'تعذر إتمام العملية. تحقق من الاتصال وحاول مرة أخرى.';
}

/** يحول نص مثل "56، 58 ,60" إلى قائمة مقاسات صحيحة */
function parseSizes(text: string): number[] | null {
  const parts = text.split(/[\s,،]+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const sizes = parts.map((p) => Number(p));
  if (sizes.some((n) => !Number.isInteger(n) || n <= 0 || n > 999)) return null;
  return Array.from(new Set(sizes)).sort((a, b) => a - b);
}

function Notice({ kind, text, onClose }: { kind: 'success' | 'error'; text: string; onClose: () => void }) {
  return (
    <div className={`md-notice md-notice--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <span>{kind === 'success' ? '✓' : '⚠️'} {text}</span>
      <button type="button" onClick={onClose} aria-label="إخفاء الرسالة">×</button>
    </div>
  );
}

// ─── الموردون ───────────────────────────────────────────────────────────────

function SuppliersTab({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null);
  const [form, setForm] = useState({ code: '', name: '', phone: '', address: '' });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await financeApi.getSuppliers());
    } catch (err) {
      setNotice({ kind: 'error', text: errorText(err) });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const visible = rows.filter((s) => {
    const q = search.trim();
    return !q || s.name.includes(q) || s.code.toLowerCase().includes(q.toLowerCase()) || (s.phone || '').includes(q);
  });

  const openNew = () => { setForm({ code: '', name: '', phone: '', address: '' }); setFormError(''); setEditing('new'); };
  const openEdit = (s: Supplier) => { setForm({ code: s.code, name: s.name, phone: s.phone || '', address: s.address || '' }); setFormError(''); setEditing(s); };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      if (editing === 'new') {
        const created = await financeApi.createSupplier(form);
        setNotice({ kind: 'success', text: `تمت إضافة المورد «${created.name}». يمكنك الآن تسجيل فاتورة شراء له من شاشة الموردين وفواتير الشراء.` });
      } else if (editing) {
        const updated = await financeApi.updateSupplier(editing.id, { name: form.name, phone: form.phone, address: form.address });
        setNotice({ kind: 'success', text: `تم حفظ بيانات المورد «${updated.name}». الفواتير السابقة لم تتغير.` });
      }
      setEditing(null);
      await load();
    } catch (err) {
      setFormError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (s: Supplier) => {
    try {
      await financeApi.updateSupplier(s.id, { is_active: !s.is_active });
      setNotice({ kind: 'success', text: s.is_active ? `تم إيقاف المورد «${s.name}»؛ لن يظهر في الفواتير الجديدة.` : `تمت إعادة تفعيل المورد «${s.name}».` });
      await load();
    } catch (err) {
      setNotice({ kind: 'error', text: errorText(err) });
    }
  };

  return (
    <section className="md-panel" aria-label="الموردون">
      <div className="md-panel__head">
        <div>
          <h3>الموردون</h3>
          <p>من نشتري منهم الأقمشة والمستلزمات. الكود لا يتغير بعد الحفظ حتى تبقى الفواتير السابقة مرتبطة به.</p>
        </div>
        {canManage && <button className="btn btn--primary" type="button" onClick={openNew}>＋ مورد جديد</button>}
      </div>
      {notice && <Notice {...notice} onClose={() => setNotice(null)} />}
      <input className="md-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ابحث باسم المورد أو الكود أو الهاتف" />
      {loading ? <div className="md-empty" role="status">جاري التحميل…</div> : visible.length === 0 ? (
        <div className="md-empty">{search ? 'لا توجد نتائج مطابقة.' : 'لا يوجد موردون بعد. ابدأ بإضافة أول مورد.'}</div>
      ) : (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead><tr><th>المورد</th><th>الهاتف</th><th>العنوان</th><th>الحالة</th>{canManage && <th>إجراء</th>}</tr></thead>
            <tbody>
              {visible.map((s) => (
                <tr key={s.id}>
                  <td><strong>{s.name}</strong><small>{s.code}</small></td>
                  <td>{s.phone || '—'}</td>
                  <td>{s.address || '—'}</td>
                  <td><span className={`md-status md-status--${s.is_active ? 'on' : 'off'}`}>{s.is_active ? 'نشط' : 'موقوف'}</span></td>
                  {canManage && (
                    <td className="md-actions">
                      <button type="button" className="md-link" onClick={() => openEdit(s)}>تعديل</button>
                      <button type="button" className="md-link md-link--muted" onClick={() => void toggleActive(s)}>{s.is_active ? 'إيقاف' : 'تفعيل'}</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <div className="customer-modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setEditing(null); }}>
          <form className="customer-modal" onSubmit={(e) => void save(e)} aria-labelledby="supplier-form-title">
            <header><div><span>ملف المورد</span><h3 id="supplier-form-title">{editing === 'new' ? 'إضافة مورد جديد' : 'تعديل بيانات المورد'}</h3></div><button type="button" aria-label="إغلاق" onClick={() => setEditing(null)}>×</button></header>
            {formError && <div className="customers-alert" role="alert">{formError}</div>}
            <label>كود المورد{editing !== 'new' && <small className="md-hint"> (ثابت)</small>}
              <input required maxLength={64} value={form.code} disabled={editing !== 'new'} placeholder="مثال: SUP-010" onChange={(e) => setForm({ ...form, code: e.target.value })} />
            </label>
            <label>اسم المورد<input required maxLength={128} autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label>رقم الهاتف<input maxLength={32} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
            <label>العنوان<textarea rows={2} maxLength={2000} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></label>
            <footer><button className="btn btn--secondary" type="button" onClick={() => setEditing(null)}>إلغاء</button><button className="btn btn--primary" type="submit" disabled={saving}>{saving ? 'جاري الحفظ…' : 'حفظ'}</button></footer>
          </form>
        </div>
      )}
    </section>
  );
}

// ─── الموديلات والمقاسات ─────────────────────────────────────────────────────

type ProductMode =
  | { kind: 'new' }
  | { kind: 'edit'; product: Product }
  | { kind: 'sizes'; product: Product }
  | { kind: 'manage-sizes'; product: Product };

function sizeText(v: ProductVariant): string {
  const season = SEASON_AR[v.season || 'summer'] || v.season || '';
  return [String(v.numeric_size ?? ''), v.letter_size || '', season].filter(Boolean).join(' · ');
}

function ProductsTab({ canManage, canSeeCatalog, onOpenCatalog }: { canManage: boolean; canSeeCatalog: boolean; onOpenCatalog: () => void }) {
  const dialog = useDialog();
  const [rows, setRows] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [mode, setMode] = useState<ProductMode | null>(null);
  const [form, setForm] = useState({ code: '', name_ar: '', description: '', sizes: '', letter: '', season: 'summer' });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [bom, setBom] = useState<{ productId: string; variantId?: string } | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'missing' | 'stopped'>('all');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await fetchProducts());
    } catch (err) {
      setNotice({ kind: 'error', text: errorText(err) });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  /** مقاسات نشطة لموديل نشط بلا مستلزمات = لا يمكن إنشاء أوامر لها */
  const missingOf = (p: Product) => (p.is_active === false ? [] : p.variants.filter((v) => v.is_active !== false && !v.has_bom));
  const totalMissing = rows.reduce((n, p) => n + missingOf(p).length, 0);
  const modelsMissing = rows.filter((p) => missingOf(p).length > 0).length;
  const stoppedCount = rows.filter((p) => p.is_active === false).length;

  const visible = rows.filter((p) => {
    const q = search.trim().toLowerCase();
    if (q && !p.name_ar.toLowerCase().includes(q) && !p.code.toLowerCase().includes(q)) return false;
    if (filter === 'missing') return missingOf(p).length > 0;
    if (filter === 'stopped') return p.is_active === false;
    return true;
  });

  const open = (next: ProductMode | null) => {
    setFormError('');
    if (next?.kind === 'edit') setForm({ code: next.product.code, name_ar: next.product.name_ar, description: next.product.description || '', sizes: '', letter: '', season: 'summer' });
    else setForm({ code: '', name_ar: '', description: '', sizes: '', letter: '', season: 'summer' });
    setMode(next);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!mode || mode.kind === 'manage-sizes') return;
    setFormError('');
    const sizes = mode.kind === 'edit' ? [] : parseSizes(form.sizes);
    if (mode.kind !== 'edit' && !sizes) {
      setFormError('اكتب المقاسات أرقاماً مفصولة بفاصلة، مثل: 56، 58، 60');
      return;
    }
    if (mode.kind !== 'edit' && form.letter.trim() && (sizes || []).length > 1) {
      setFormError('المقاس الحرفي يُكتب عند إضافة مقاس واحد فقط. أضف المقاسات ثم عدّل الحرفي لكل مقاس من «إدارة المقاسات».');
      return;
    }
    setSaving(true);
    try {
      const variants = (sizes || []).map((n) => ({ numeric_size: n, season: form.season, letter_size: form.letter.trim() }));
      if (mode.kind === 'new') {
        const p = await createProductApi({ code: form.code, name_ar: form.name_ar, description: form.description, variants });
        setMode(null);
        await load();
        setNotice({ kind: 'success', text: `تمت إضافة الموديل «${p.name_ar}» بعدد ${p.variants.length} مقاس. الخطوة التالية: عرّف مستلزمات التصنيع لكل مقاس.` });
        if (canManage && p.variants.length > 0) setBom({ productId: p.id });
        return;
      }
      if (mode.kind === 'edit') {
        const p = await updateProductApi(mode.product.id, { name_ar: form.name_ar, description: form.description });
        setNotice({ kind: 'success', text: `تم حفظ الموديل «${p.name_ar}». الأوامر والحركات السابقة لم تتغير.` });
      } else {
        const p = await addProductVariantsApi(mode.product.id, variants);
        setNotice({ kind: 'success', text: `تمت إضافة ${variants.length} مقاس للموديل «${p.name_ar}». عرّف مستلزماتها (يمكنك نسخها من مقاس قائم).` });
      }
      setMode(null);
      await load();
    } catch (err) {
      setFormError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  const toggleProduct = async (p: Product) => {
    const stopping = p.is_active !== false;
    const ok = await dialog.confirm({
      title: stopping ? `إيقاف الموديل «${p.name_ar}»؟` : `إعادة تفعيل الموديل «${p.name_ar}»؟`,
      message: stopping
        ? 'لن يظهر في أوامر التشغيل الجديدة. أوامر التشغيل القائمة والمخزون والمستلزمات المحفوظة لا تتغير، ويمكنك إعادة تفعيله في أي وقت.'
        : 'سيظهر الموديل مرة أخرى عند إنشاء أوامر التشغيل.',
      confirmLabel: stopping ? 'إيقاف الموديل' : 'إعادة التفعيل',
      tone: stopping ? 'danger' : undefined,
    });
    if (!ok) return;
    setBusyId(p.id);
    try {
      await updateProductApi(p.id, { is_active: !stopping });
      setNotice({ kind: 'success', text: stopping ? `تم إيقاف الموديل «${p.name_ar}».` : `تمت إعادة تفعيل الموديل «${p.name_ar}».` });
      await load();
    } catch (err) {
      setNotice({ kind: 'error', text: errorText(err) });
    } finally {
      setBusyId(null);
    }
  };

  const updateVariant = async (product: Product, v: ProductVariant, payload: { is_active?: boolean; letter_size?: string }) => {
    setBusyId(v.id);
    setFormError('');
    try {
      const updated = await updateProductVariantApi(v.id, payload);
      setRows((cur) => cur.map((p) => (p.id === updated.id ? updated : p)));
      setMode({ kind: 'manage-sizes', product: updated });
      if (payload.is_active !== undefined) {
        setNotice({ kind: 'success', text: payload.is_active ? `أُعيد تفعيل مقاس ${sizeText(v)} للموديل «${product.name_ar}».` : `أُوقف مقاس ${sizeText(v)} للموديل «${product.name_ar}»؛ لن يُختار في أوامر جديدة.` });
      }
    } catch (err) {
      setFormError(errorText(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="md-panel" aria-label="الموديلات والمقاسات">
      <div className="md-panel__head">
        <div>
          <h3>الموديلات والمقاسات</h3>
          <p>ما يصنعه المصنع. لكل مقاس مستلزمات تصنيع (الخامات اللازمة للقطعة الواحدة)، ومنها تُحسب احتياجات أوامر التشغيل تلقائياً.</p>
        </div>
        {canManage && <button className="btn btn--primary" type="button" onClick={() => open({ kind: 'new' })}>＋ موديل جديد</button>}
      </div>
      {notice && <Notice {...notice} onClose={() => setNotice(null)} />}

      {!loading && totalMissing > 0 && (
        <div className="md-callout md-callout--warn" role="status">
          <span>
            <strong>{totalMissing} مقاس في {modelsMissing} موديل بدون مستلزمات تصنيع.</strong> لا يمكن إنشاء أوامر تشغيل لهذه المقاسات حتى تُعرّف مستلزماتها.
          </span>
          {filter !== 'missing' && <button type="button" className="btn btn--secondary btn--sm" onClick={() => setFilter('missing')}>عرضها فقط</button>}
        </div>
      )}

      {rows.length > 0 && (
        <div className="md-toolbar">
          <input className="md-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ابحث باسم الموديل أو الكود" aria-label="بحث في الموديلات" />
          <div className="md-segment" role="group" aria-label="تصفية الموديلات">
            <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>الكل ({rows.length})</button>
            <button type="button" aria-pressed={filter === 'missing'} onClick={() => setFilter('missing')}>تحتاج مستلزمات ({modelsMissing})</button>
            {stoppedCount > 0 && <button type="button" aria-pressed={filter === 'stopped'} onClick={() => setFilter('stopped')}>موقوفة ({stoppedCount})</button>}
          </div>
        </div>
      )}

      {loading ? <div className="md-empty" role="status">جاري التحميل…</div> : rows.length === 0 ? (
        <div className="md-empty md-empty--guide">
          <strong>لا توجد موديلات بعد.</strong>
          <ol>
            <li>أضف الموديل ومقاساته.</li>
            <li>عرّف مستلزمات تصنيع كل مقاس من أصناف دليل الأصناف.</li>
            <li>أنشئ أوامر التشغيل من شاشة الإنتاج؛ الاحتياجات تُحسب تلقائياً.</li>
          </ol>
          {canManage ? <button className="btn btn--primary" type="button" onClick={() => open({ kind: 'new' })}>＋ أضف أول موديل</button> : <small>إضافة الموديلات من صلاحية مسؤول الإنتاج أو المدير العام.</small>}
        </div>
      ) : visible.length === 0 ? (
        <div className="md-empty">
          لا توجد موديلات مطابقة. <button type="button" className="md-link" onClick={() => { setSearch(''); setFilter('all'); }}>عرض الكل</button>
        </div>
      ) : (
        <div className="md-cards">
          {visible.map((p) => {
            const stopped = p.is_active === false;
            const activeVariants = p.variants.filter((v) => v.is_active !== false);
            const withBom = activeVariants.filter((v) => v.has_bom).length;
            const missing = missingOf(p);
            const bySeason = p.variants.reduce<Record<string, ProductVariant[]>>((acc, v) => {
              (acc[v.season || 'summer'] ||= []).push(v);
              return acc;
            }, {});
            return (
              <article key={p.id} className={`md-card${stopped ? ' md-card--stopped' : ''}`}>
                <header>
                  <div>
                    <strong>{p.name_ar}</strong>
                    <small>{p.code}</small>
                  </div>
                  {stopped ? <span className="md-status md-status--off">موقوف</span> : activeVariants.length === 0 ? (
                    <span className="md-status md-status--warn">بلا مقاسات</span>
                  ) : missing.length === 0 ? (
                    <span className="md-status md-status--on">جاهز للتشغيل</span>
                  ) : (
                    <span className="md-status md-status--warn">ينقصه مستلزمات</span>
                  )}
                </header>
                {p.description && <p>{p.description}</p>}
                {!stopped && activeVariants.length > 0 && (
                  <div className="md-progress" aria-label={`مستلزمات التصنيع: ${withBom} من ${activeVariants.length} مقاس`}>
                    <span>مستلزمات التصنيع: {withBom} من {activeVariants.length} مقاس</span>
                    <div className="md-progress__bar"><i style={{ width: `${Math.round((withBom / activeVariants.length) * 100)}%` }} /></div>
                  </div>
                )}
                {Object.entries(bySeason).map(([season, sizes]) => (
                  <div key={season} className="md-sizes">
                    <span className="md-sizes__season">{SEASON_AR[season] || season}</span>
                    {sizes.sort((a, b) => Number(a.numeric_size) - Number(b.numeric_size)).map((v) => {
                      const off = v.is_active === false;
                      const state = off ? 'off' : v.has_bom ? 'ok' : 'missing';
                      const title = off ? 'مقاس موقوف' : v.has_bom ? `مستلزماته معرّفة (إصدار ${v.bom_version_number})` : 'بدون مستلزمات تصنيع — اضغط لتعريفها';
                      return (
                        <button key={v.id} type="button" className={`md-chip md-chip--${state}`} title={title} aria-label={`مقاس ${sizeText(v)}: ${title}`}
                          onClick={() => setBom({ productId: p.id, variantId: v.id })}>
                          {v.numeric_size}{v.letter_size ? ` ${v.letter_size}` : ''}
                          <span aria-hidden>{off ? ' ⏸' : v.has_bom ? ' ✓' : ' !'}</span>
                        </button>
                      );
                    })}
                  </div>
                ))}
                {p.variants.length === 0 && <p className="md-hint">لم تُضف مقاسات لهذا الموديل بعد.</p>}
                <footer className="md-card__actions">
                  <button type="button" className={`btn btn--sm ${missing.length > 0 && canManage ? 'btn--primary' : 'btn--secondary'}`} disabled={p.variants.length === 0}
                    onClick={() => setBom({ productId: p.id, variantId: missing[0]?.id })}>
                    {canManage ? (missing.length > 0 ? 'استكمال المستلزمات' : 'مستلزمات التصنيع') : 'عرض المستلزمات'}
                  </button>
                  {canManage && (
                    <>
                      <button type="button" className="md-link" onClick={() => open({ kind: 'sizes', product: p })}>＋ مقاسات</button>
                      {p.variants.length > 0 && <button type="button" className="md-link" onClick={() => open({ kind: 'manage-sizes', product: p })}>إدارة المقاسات</button>}
                      <button type="button" className="md-link md-link--muted" onClick={() => open({ kind: 'edit', product: p })}>تعديل</button>
                      <button type="button" className="md-link md-link--muted" disabled={busyId === p.id} onClick={() => void toggleProduct(p)}>{stopped ? 'تفعيل' : 'إيقاف'}</button>
                    </>
                  )}
                </footer>
              </article>
            );
          })}
        </div>
      )}

      {bom && (
        <BomEditor
          productId={bom.productId}
          initialVariantId={bom.variantId}
          canManage={canManage}
          canOpenCatalog={canSeeCatalog}
          onOpenCatalog={onOpenCatalog}
          onClose={() => { setBom(null); void load(); }}
        />
      )}

      {mode?.kind === 'manage-sizes' && (
        <div className="customer-modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setMode(null); }}>
          <section className="customer-modal" role="dialog" aria-modal="true" aria-labelledby="sizes-manage-title">
            <header>
              <div><span>إدارة المقاسات</span><h3 id="sizes-manage-title">{mode.product.name_ar}</h3></div>
              <button type="button" aria-label="إغلاق" onClick={() => setMode(null)}>×</button>
            </header>
            {formError && <div className="customers-alert" role="alert">{formError}</div>}
            <p className="md-hint">المقاسات لا تُحذف لأنها مرتبطة بحركات مخزن وأوامر سابقة. المقاس الموقوف لا يُختار في أوامر تشغيل جديدة فقط.</p>
            <div className="md-table-wrap">
              <table className="md-table">
                <thead><tr><th>المقاس</th><th>المقاس الحرفي</th><th>المستلزمات</th><th>الحالة</th><th>إجراء</th></tr></thead>
                <tbody>
                  {mode.product.variants.map((v) => (
                    <tr key={v.id}>
                      <td><strong>{v.numeric_size}</strong><small>{SEASON_AR[v.season || 'summer'] || v.season}</small></td>
                      <td>
                        <input className="md-inline-input" aria-label={`المقاس الحرفي لمقاس ${v.numeric_size}`} maxLength={16} defaultValue={v.letter_size || ''} placeholder="مثال: XL"
                          onBlur={(e) => { const val = e.target.value.trim(); if (val !== (v.letter_size || '')) void updateVariant(mode.product, v, { letter_size: val }); }} />
                      </td>
                      <td>{v.has_bom ? <span className="md-status md-status--on">إصدار {v.bom_version_number}</span> : <span className="md-status md-status--warn">غير معرّفة</span>}</td>
                      <td><span className={`md-status md-status--${v.is_active === false ? 'off' : 'on'}`}>{v.is_active === false ? 'موقوف' : 'نشط'}</span></td>
                      <td className="md-actions">
                        <button type="button" className="md-link md-link--muted" disabled={busyId === v.id} onClick={() => void updateVariant(mode.product, v, { is_active: v.is_active === false })}>
                          {v.is_active === false ? 'تفعيل' : 'إيقاف'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <footer>
              <button className="btn btn--secondary" type="button" onClick={() => open({ kind: 'sizes', product: mode.product })}>＋ إضافة مقاسات</button>
              <button className="btn btn--primary" type="button" onClick={() => setMode(null)}>تم</button>
            </footer>
          </section>
        </div>
      )}

      {mode && mode.kind !== 'manage-sizes' && (
        <div className="customer-modal-backdrop" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setMode(null); }}>
          <form className="customer-modal" onSubmit={(e) => void save(e)} aria-labelledby="product-form-title">
            <header>
              <div>
                <span>الموديلات</span>
                <h3 id="product-form-title">
                  {mode.kind === 'new' ? 'إضافة موديل جديد' : mode.kind === 'edit' ? 'تعديل الموديل' : `إضافة مقاسات: ${mode.product.name_ar}`}
                </h3>
              </div>
              <button type="button" aria-label="إغلاق" onClick={() => setMode(null)}>×</button>
            </header>
            {formError && <div className="customers-alert" role="alert">{formError}</div>}
            {mode.kind !== 'sizes' && (
              <>
                <label>كود الموديل{mode.kind === 'edit' && <small className="md-hint"> (ثابت)</small>}
                  <input required maxLength={64} value={form.code} disabled={mode.kind === 'edit'} placeholder="مثال: GLB-07" onChange={(e) => setForm({ ...form, code: e.target.value })} />
                  {mode.kind === 'new' && <small className="md-hint">رمز قصير ثابت يميز الموديل، ويُبنى منه كود كل مقاس.</small>}
                </label>
                <label>اسم الموديل<input required maxLength={128} autoFocus value={form.name_ar} placeholder="مثال: جلابية ياقة نصف" onChange={(e) => setForm({ ...form, name_ar: e.target.value })} /></label>
                <label>وصف مختصر <small className="md-hint">(اختياري)</small><textarea rows={2} maxLength={2000} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
              </>
            )}
            {mode.kind !== 'edit' && (
              <>
                <div className="customer-form-grid">
                  <label>المقاسات
                    <input required value={form.sizes} autoFocus={mode.kind === 'sizes'} inputMode="numeric" placeholder="56، 58، 60، 62" onChange={(e) => setForm({ ...form, sizes: e.target.value })} />
                    <small className="md-hint">أرقام مفصولة بفاصلة. كل مقاس يحصل على كود ومستلزمات مستقلة.</small>
                  </label>
                  <label>الموسم
                    <select value={form.season} onChange={(e) => setForm({ ...form, season: e.target.value })}>
                      <option value="summer">صيفي</option><option value="autumn">خريفي</option><option value="winter">شتوي</option>
                    </select>
                  </label>
                </div>
                <label>المقاس الحرفي <small className="md-hint">(اختياري، عند إضافة مقاس واحد مثل XL)</small>
                  <input maxLength={16} value={form.letter} onChange={(e) => setForm({ ...form, letter: e.target.value })} />
                </label>
              </>
            )}
            {mode.kind === 'edit' && <p className="md-hint">لإضافة مقاس أو إيقافه استخدم «＋ مقاسات» أو «إدارة المقاسات». المقاسات المسجلة لا تُحذف لأنها مرتبطة بحركات مخزن.</p>}
            <footer><button className="btn btn--secondary" type="button" onClick={() => setMode(null)}>إلغاء</button><button className="btn btn--primary" type="submit" disabled={saving}>{saving ? 'جاري الحفظ…' : mode.kind === 'new' ? 'حفظ ثم تعريف المستلزمات' : 'حفظ'}</button></footer>
          </form>
        </div>
      )}
    </section>
  );
}

// ─── الموظفون ───────────────────────────────────────────────────────────────

function EmployeesTab({ canManage }: { canManage: boolean }) {
  const [rows, setRows] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [editing, setEditing] = useState<Employee | 'new' | null>(null);
  const [form, setForm] = useState({ code: '', name: '', department: '', job_title: '' });
  const [pay, setPay] = useState<PayFormValues>(EMPTY_PAY_VALUES);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await payrollApi.listEmployees());
    } catch (err) {
      setNotice({ kind: 'error', text: errorText(err) });
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const openNew = () => { setForm({ code: '', name: '', department: '', job_title: '' }); setPay(EMPTY_PAY_VALUES); setFormError(''); setEditing('new'); };
  const openEdit = (e: Employee) => {
    setForm({ code: e.code, name: e.name, department: e.department || '', job_title: e.job_title || '' });
    setPay({ pay_type: e.pay_type || 'monthly', base_salary: String(e.base_salary ?? ''), daily_rate: e.daily_rate != null ? String(e.daily_rate) : '' });
    setFormError('');
    setEditing(e);
  };

  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    const payError = validatePay(pay);
    if (payError) {
      setFormError(payError);
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      if (editing === 'new') {
        await payrollApi.createEmployee({ code: form.code, name: form.name, department: form.department, job_title: form.job_title, ...payPayload(pay) });
        setNotice({ kind: 'success', text: `تمت إضافة الموظف «${form.name}».` });
      } else if (editing) {
        await payrollApi.updateEmployee(editing.id, { name: form.name, department: form.department, job_title: form.job_title, ...payPayload(pay) });
        setNotice({ kind: 'success', text: `تم حفظ بيانات «${form.name}». كشوف الرواتب السابقة لم تتغير.` });
      }
      setEditing(null);
      await load();
    } catch (err) {
      setFormError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="md-panel" aria-label="الموظفون">
      <div className="md-panel__head">
        <div>
          <h3>الموظفون</h3>
          <p>بيانات الموظفين ونظام أجر كل منهم (شهري أو يومية). الحوافز والخصومات تُدخل في كشف كل فترة ولا تُطبَّق تلقائياً.</p>
        </div>
        {canManage && <button className="btn btn--primary" type="button" onClick={openNew}>＋ موظف جديد</button>}
      </div>
      {notice && <Notice {...notice} onClose={() => setNotice(null)} />}
      {loading ? <div className="md-empty" role="status">جاري التحميل…</div> : rows.length === 0 ? (
        <div className="md-empty">لا يوجد موظفون مسجلون بعد.</div>
      ) : (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead><tr><th>الموظف</th><th>القسم</th><th>الوظيفة</th><th>نظام الأجر</th><th>الحالة</th>{canManage && <th>إجراء</th>}</tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id}>
                  <td><strong>{e.name}</strong><small>{e.code}</small></td>
                  <td>{e.department || '—'}</td>
                  <td>{e.job_title || '—'}</td>
                  <td>{payTypeSummary(e)}</td>
                  <td><span className={`md-status md-status--${e.status === 'active' ? 'on' : 'off'}`}>{e.status === 'active' ? 'نشط' : 'موقوف'}</span></td>
                  {canManage && <td><button type="button" className="md-link" onClick={() => openEdit(e)}>تعديل</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <div className="customer-modal-backdrop" role="presentation" onMouseDown={(ev) => { if (ev.target === ev.currentTarget) setEditing(null); }}>
          <form className="customer-modal" onSubmit={(ev) => void save(ev)} aria-labelledby="employee-form-title">
            <header><div><span>ملف الموظف</span><h3 id="employee-form-title">{editing === 'new' ? 'إضافة موظف' : 'تعديل بيانات الموظف'}</h3></div><button type="button" aria-label="إغلاق" onClick={() => setEditing(null)}>×</button></header>
            {formError && <div className="customers-alert" role="alert">{formError}</div>}
            <label>كود الموظف{editing !== 'new' && <small className="md-hint"> (ثابت)</small>}<input required maxLength={32} value={form.code} disabled={editing !== 'new'} onChange={(ev) => setForm({ ...form, code: ev.target.value })} /></label>
            <label>الاسم<input required maxLength={128} value={form.name} onChange={(ev) => setForm({ ...form, name: ev.target.value })} /></label>
            <div className="customer-form-grid">
              <label>القسم<input maxLength={64} value={form.department} placeholder="القص / الخياطة / التشطيب" onChange={(ev) => setForm({ ...form, department: ev.target.value })} /></label>
              <label>الوظيفة<input maxLength={64} value={form.job_title} onChange={(ev) => setForm({ ...form, job_title: ev.target.value })} /></label>
            </div>
            <PayTypeFields values={pay} onChange={setPay} />
            <footer><button className="btn btn--secondary" type="button" onClick={() => setEditing(null)}>إلغاء</button><button className="btn btn--primary" type="submit" disabled={saving}>{saving ? 'جاري الحفظ…' : 'حفظ'}</button></footer>
          </form>
        </div>
      )}
    </section>
  );
}

// ─── الوحدات والمخازن (مرجعية) ──────────────────────────────────────────────

function ReferenceTab({ onOpenCatalog, canSeeCatalog }: { onOpenCatalog: () => void; canSeeCatalog: boolean }) {
  const [units, setUnits] = useState<Unit[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    fetchUnits().then(setUnits).catch((err) => setError(errorText(err)));
    fetchWarehouses().then(setWarehouses).catch(() => setWarehouses([]));
  }, []);
  return (
    <section className="md-panel" aria-label="الوحدات والمخازن">
      <div className="md-panel__head">
        <div>
          <h3>المخازن ووحدات القياس والخامات</h3>
          <p>المخازن الثلاثة ثابتة. وحدات القياس والتصنيفات وأصناف الخامات والمستلزمات تُدار من «دليل الخامات والأصناف»: إضافة صنف، اعتماده، تعديله أو إيقافه. الصنف المعتمد النشط فقط يمكن استخدامه في مستلزمات التصنيع.</p>
        </div>
        {canSeeCatalog && <button type="button" className="btn btn--secondary" onClick={onOpenCatalog}>فتح دليل الخامات ←</button>}
      </div>
      {error && <Notice kind="error" text={error} onClose={() => setError('')} />}
      <div className="md-two-col">
        <div>
          <h4>المخازن</h4>
          <ul className="md-list">
            {warehouses.length === 0 && <li className="md-hint">يظهر للأدوار التي تتابع الإنتاج والمخازن.</li>}
            {warehouses.map((w) => <li key={w.id}>{w.name_ar}</li>)}
          </ul>
        </div>
        <div>
          <h4>وحدات القياس</h4>
          <div className="md-sizes">{units.map((u) => <span key={u.id} className="md-chip">{u.name_ar}</span>)}</div>
        </div>
      </div>
    </section>
  );
}

// ─── الشاشة الرئيسية ────────────────────────────────────────────────────────

export function MasterDataView({ onNavigate }: { onNavigate: (navId: string) => void }) {
  const { hasPermission } = useAuth();
  const tabs = useMemo(() => {
    const all: Array<{ id: TabId; label: string; visible: boolean }> = [
      { id: 'suppliers', label: 'الموردون', visible: hasPermission('suppliers:view') },
      { id: 'customers', label: 'العملاء', visible: hasPermission('customers:view') },
      { id: 'products', label: 'الموديلات والمقاسات', visible: hasPermission('production:orders:view') },
      { id: 'employees', label: 'الموظفون', visible: hasPermission('finance:payroll:view') },
      { id: 'reference', label: 'المخازن والوحدات والخامات', visible: true },
    ];
    return all.filter((t) => t.visible);
  }, [hasPermission]);
  const [active, setActive] = useState<TabId>(tabs[0]?.id ?? 'reference');

  return (
    <section className="md-page" dir="rtl" aria-labelledby="md-title">
      <header className="md-page__header">
        <h2 id="md-title" className="sr-only">البيانات الأساسية</h2>
        <p>أضف وعدّل بيانات المصنع الأساسية من هنا. التعديل لا يغير الفواتير والحركات المعتمدة سابقاً.</p>
      </header>
      <nav className="md-tabs" role="tablist" aria-label="أقسام البيانات الأساسية">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={active === t.id}
            className={`md-tab${active === t.id ? ' md-tab--active' : ''}`} onClick={() => setActive(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      {active === 'suppliers' && <SuppliersTab canManage={hasPermission('suppliers:manage')} />}
      {active === 'customers' && <CustomersView />}
      {active === 'products' && (
        <ProductsTab
          canManage={hasPermission('production:templates:manage')}
          canSeeCatalog={hasPermission('catalog:view')}
          onOpenCatalog={() => onNavigate('warehouse-catalog')}
        />
      )}
      {active === 'employees' && <EmployeesTab canManage={hasPermission('finance:payroll:manage')} />}
      {active === 'reference' && <ReferenceTab canSeeCatalog={hasPermission('catalog:view')} onOpenCatalog={() => onNavigate('warehouse-catalog')} />}
    </section>
  );
}
