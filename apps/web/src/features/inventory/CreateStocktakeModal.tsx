import React, { useState, useEffect } from 'react';
import { fetchWarehouses, Warehouse } from '@/features/production/productionApi';
import { fetchCatalogItems, CatalogItem } from '@/features/catalog/catalogApi';
import { createStocktakeSession, StocktakeCreateRequest, StocktakeSession } from './stocktakeApi';
import { ApiError } from '@/lib/api';

interface CreateStocktakeModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (session: StocktakeSession) => void;
}

export const CreateStocktakeModal: React.FC<CreateStocktakeModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
}) => {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [catalogItems, setCatalogItems] = useState<CatalogItem[]>([]);
  const [selectedWarehouseId, setSelectedWarehouseId] = useState<string>('');
  const [scopeType, setScopeType] = useState<'full_warehouse' | 'specific_items'>('full_warehouse');
  const [selectedItemIds, setSelectedItemIds] = useState<string[]>([]);
  const [description, setDescription] = useState<string>('');
  const [itemSearchTerm, setItemSearchTerm] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    let isMounted = true;
    setLoading(true);
    setError(null);

    Promise.all([
      fetchWarehouses(),
      fetchCatalogItems({ is_active: true }),
    ])
      .then(([whs, items]) => {
        if (!isMounted) return;
        setWarehouses(whs);
        if (whs.length > 0 && !selectedWarehouseId) {
          setSelectedWarehouseId(whs[0].id);
        }
        setCatalogItems(items);
      })
      .catch((err: unknown) => {
        if (!isMounted) return;
        const msg = err instanceof ApiError ? err.message : 'فشل تحميل بيانات المخازن أو الأصناف.';
        setError(msg);
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const filteredItems = catalogItems.filter(
    (item) =>
      item.code.toLowerCase().includes(itemSearchTerm.toLowerCase()) ||
      item.name_ar.includes(itemSearchTerm)
  );

  const toggleItemSelection = (id: string) => {
    setSelectedItemIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    );
  };

  const selectAllFiltered = () => {
    const ids = filteredItems.map((i) => i.id);
    setSelectedItemIds((prev) => Array.from(new Set([...prev, ...ids])));
  };

  const clearSelection = () => {
    setSelectedItemIds([]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedWarehouseId) {
      setError('يرجى اختيار المخزن المراد جرده.');
      return;
    }

    if (scopeType === 'specific_items' && selectedItemIds.length === 0) {
      setError('يرجى تحديد صنف واحد على الأقل للجرد المحدد.');
      return;
    }

    setSubmitting(true);
    setError(null);

    const payload: StocktakeCreateRequest = {
      warehouse_id: selectedWarehouseId,
      scope_type: scopeType,
      item_ids: scopeType === 'specific_items' ? selectedItemIds : undefined,
      description: description.trim() || undefined,
    };

    try {
      const created = await createStocktakeSession(payload);
      onSuccess(created);
      onClose();
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'حدث خطأ أثناء فتح جلسة الجرد.';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="stocktake-modal-title"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(15, 23, 42, 0.65)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: '1rem',
      }}
    >
      <div
        className="modal-card"
        dir="rtl"
        style={{
          backgroundColor: '#ffffff',
          borderRadius: '12px',
          maxWidth: '640px',
          width: '100%',
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 8px 10px -6px rgba(0, 0, 0, 0.1)',
        }}
      >
        <header
          style={{
            padding: '1.25rem 1.5rem',
            borderBottom: '1px solid #e2e8f0',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <h3 id="stocktake-modal-title" style={{ margin: 0, fontSize: '1.2rem', color: '#0f172a' }}>
              فتح جلسة جرد مخزني جديدة
            </h3>
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.85rem', color: '#64748b' }}>
              تثبيت اللقطة الدفترية للأرصدة لحظة الفتح لبدء العد الميداني
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="إغلاق"
            style={{
              background: 'none',
              border: 'none',
              fontSize: '1.25rem',
              cursor: 'pointer',
              color: '#94a3b8',
            }}
          >
            ✕
          </button>
        </header>

        {error && (
          <div
            className="warehouse-alert"
            role="alert"
            style={{
              margin: '1rem 1.5rem 0',
              padding: '0.75rem 1rem',
              backgroundColor: '#fef2f2',
              color: '#991b1b',
              border: '1px solid #fecaca',
              borderRadius: '6px',
              fontSize: '0.9rem',
            }}
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          <div style={{ padding: '1.25rem 1.5rem', overflowY: 'auto', flex: 1 }}>
            {loading ? (
              <div style={{ textAlign: 'center', padding: '2rem', color: '#64748b' }}>
                جاري تحميل بيانات المخازن والأصناف...
              </div>
            ) : (
              <>
                {/* اختيار المخزن */}
                <div style={{ marginBottom: '1.25rem' }}>
                  <label htmlFor="stk-warehouse" style={{ display: 'block', fontWeight: 600, marginBottom: '0.5rem', color: '#1e293b' }}>
                    المخزن المراد جرده *
                  </label>
                  <select
                    id="stk-warehouse"
                    value={selectedWarehouseId}
                    onChange={(e) => setSelectedWarehouseId(e.target.value)}
                    required
                    style={{
                      width: '100%',
                      padding: '0.6rem 0.75rem',
                      borderRadius: '6px',
                      border: '1px solid #cbd5e1',
                      fontSize: '0.95rem',
                      backgroundColor: '#fff',
                    }}
                  >
                    {warehouses.map((wh) => (
                      <option key={wh.id} value={wh.id}>
                        {wh.name_ar} ({wh.code})
                      </option>
                    ))}
                  </select>
                </div>

                {/* نطاق الجرد */}
                <div style={{ marginBottom: '1.25rem' }}>
                  <label style={{ display: 'block', fontWeight: 600, marginBottom: '0.5rem', color: '#1e293b' }}>
                    نطاق الجرد *
                  </label>
                  <div style={{ display: 'flex', gap: '1rem' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
                      <input
                        type="radio"
                        name="scope_type"
                        value="full_warehouse"
                        checked={scopeType === 'full_warehouse'}
                        onChange={() => setScopeType('full_warehouse')}
                      />
                      <span>جرد شامل لجميع أصناف المخزن</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', cursor: 'pointer' }}>
                      <input
                        type="radio"
                        name="scope_type"
                        value="specific_items"
                        checked={scopeType === 'specific_items'}
                        onChange={() => setScopeType('specific_items')}
                      />
                      <span>جرد دوري / أصناف محددة فقط</span>
                    </label>
                  </div>
                </div>

                {/* قائمة الأصناف إذا كان الجرد محددًا */}
                {scopeType === 'specific_items' && (
                  <div
                    style={{
                      marginBottom: '1.25rem',
                      border: '1px solid #e2e8f0',
                      borderRadius: '8px',
                      padding: '0.75rem',
                      backgroundColor: '#f8fafc',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                      <span style={{ fontWeight: 600, fontSize: '0.875rem', color: '#334155' }}>
                        الأصناف المحددة ({selectedItemIds.length})
                      </span>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button
                          type="button"
                          onClick={selectAllFiltered}
                          style={{ background: 'none', border: 'none', color: '#0284c7', fontSize: '0.8rem', cursor: 'pointer' }}
                        >
                          تحديد الظاهر
                        </button>
                        <span style={{ color: '#cbd5e1' }}>|</span>
                        <button
                          type="button"
                          onClick={clearSelection}
                          style={{ background: 'none', border: 'none', color: '#64748b', fontSize: '0.8rem', cursor: 'pointer' }}
                        >
                          إلغاء التحديد
                        </button>
                      </div>
                    </div>

                    <input
                      type="text"
                      placeholder="بحث بكود أو اسم الصنف..."
                      value={itemSearchTerm}
                      onChange={(e) => setItemSearchTerm(e.target.value)}
                      style={{
                        width: '100%',
                        padding: '0.5rem 0.75rem',
                        borderRadius: '6px',
                        border: '1px solid #cbd5e1',
                        fontSize: '0.875rem',
                        marginBottom: '0.5rem',
                      }}
                    />

                    <div
                      style={{
                        maxHeight: '180px',
                        overflowY: 'auto',
                        border: '1px solid #e2e8f0',
                        borderRadius: '6px',
                        backgroundColor: '#fff',
                      }}
                    >
                      {filteredItems.length === 0 ? (
                        <div style={{ padding: '0.75rem', textAlign: 'center', color: '#94a3b8', fontSize: '0.85rem' }}>
                          لا توجد أصناف مطابقة
                        </div>
                      ) : (
                        filteredItems.map((item) => {
                          const isSelected = selectedItemIds.includes(item.id);
                          return (
                            <label
                              key={item.id}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.5rem',
                                padding: '0.4rem 0.6rem',
                                borderBottom: '1px solid #f1f5f9',
                                cursor: 'pointer',
                                backgroundColor: isSelected ? '#eff6ff' : 'transparent',
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={isSelected}
                                onChange={() => toggleItemSelection(item.id)}
                              />
                              <span style={{ fontWeight: 600, fontSize: '0.85rem', color: '#0f172a' }}>
                                {item.code}
                              </span>
                              <span style={{ fontSize: '0.85rem', color: '#475569', flex: 1 }}>
                                {item.name_ar}
                              </span>
                            </label>
                          );
                        })
                      )}
                    </div>
                  </div>
                )}

                {/* وصف أو سبب الجرد */}
                <div style={{ marginBottom: '1rem' }}>
                  <label htmlFor="stk-desc" style={{ display: 'block', fontWeight: 600, marginBottom: '0.5rem', color: '#1e293b' }}>
                    بيان / سبب الجرد (اختياري)
                  </label>
                  <textarea
                    id="stk-desc"
                    rows={2}
                    placeholder="مثال: جرد ربع سنوي دوري لخامات الأقمشة، أو جرد مفاجئ بعد اكتشاف عجز"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '0.6rem 0.75rem',
                      borderRadius: '6px',
                      border: '1px solid #cbd5e1',
                      fontSize: '0.9rem',
                    }}
                  />
                </div>
              </>
            )}
          </div>

          <footer
            style={{
              padding: '1rem 1.5rem',
              borderTop: '1px solid #e2e8f0',
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '0.75rem',
              backgroundColor: '#f8fafc',
            }}
          >
            <button
              type="button"
              className="btn btn--secondary"
              onClick={onClose}
              disabled={submitting}
            >
              إلغاء
            </button>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={submitting || loading}
            >
              {submitting ? 'جاري فتح الجلسة...' : 'فتح الجلسة وتثبيت اللقطة'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  );
};

