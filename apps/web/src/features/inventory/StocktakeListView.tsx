import React, { useState, useEffect, useCallback } from 'react';
import { StocktakeSession, fetchStocktakeSessions } from './stocktakeApi';
import { fetchWarehouses, Warehouse } from '@/features/production/productionApi';
import { useAuth } from '@/features/auth/AuthContext';
import { ApiError } from '@/lib/api';

interface StocktakeListViewProps {
  onSelectSession: (sessionId: string) => void;
  onOpenCreateModal: () => void;
}

export const StocktakeListView: React.FC<StocktakeListViewProps> = ({
  onSelectSession,
  onOpenCreateModal,
}) => {
  const { hasPermission } = useAuth();
  const [sessions, setSessions] = useState<StocktakeSession[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [selectedWarehouse, setSelectedWarehouse] = useState<string>('all');
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const canCreate = hasPermission('inventory:stocktake:create');

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sessionsData, whsData] = await Promise.all([
        fetchStocktakeSessions({
          warehouse_id: selectedWarehouse,
          status: selectedStatus,
        }),
        fetchWarehouses(),
      ]);
      setSessions(sessionsData);
      setWarehouses(whsData);
    } catch (err: unknown) {
      const msg = err instanceof ApiError ? err.message : 'فشل تحميل بيانات جلسات الجرد.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [selectedWarehouse, selectedStatus]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Metrics calculation
  const totalSessions = sessions.length;
  const activeSessions = sessions.filter((s) => s.status === 'draft' || s.status === 'counting' || s.status === 'recounting').length;
  const underReviewSessions = sessions.filter((s) => s.status === 'under_review').length;
  const postedSessions = sessions.filter((s) => s.status === 'posted').length;

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'draft':
        return <span style={{ backgroundColor: '#f1f5f9', color: '#475569', padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600 }}>مسودة</span>;
      case 'counting':
        return <span style={{ backgroundColor: '#e0f2fe', color: '#0369a1', padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600 }}>جارٍ العد الفعلي</span>;
      case 'under_review':
        return <span style={{ backgroundColor: '#fef3c7', color: '#b45309', padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600 }}>قيد الاعتماد والمراجعة</span>;
      case 'recounting':
        return <span style={{ backgroundColor: '#f3e8ff', color: '#7e22ce', padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600 }}>إعادة العد مطلوبة</span>;
      case 'approved':
        return <span style={{ backgroundColor: '#dcfce7', color: '#15803d', padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600 }}>معتمد للترحيل</span>;
      case 'posted':
        return <span style={{ backgroundColor: '#14532d', color: '#f0fdf4', padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600 }}>مرحل للأستاذ</span>;
      case 'cancelled':
        return <span style={{ backgroundColor: '#fee2e2', color: '#b91c1c', padding: '0.2rem 0.5rem', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600 }}>ملغى</span>;
      default:
        return <span>{status}</span>;
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {/* بطاقات الإحصاءات */}
      <div className="warehouse-summary" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '1rem' }}>
        <article style={{ padding: '0.85rem 1.25rem', borderRadius: '8px', border: '1px solid #e2e8f0', backgroundColor: '#fff' }}>
          <span style={{ fontSize: '0.85rem', color: '#64748b' }}>إجمالي جلسات الجرد</span>
          <strong style={{ fontSize: '1.6rem', color: '#0f172a', display: 'block' }}>{totalSessions}</strong>
        </article>
        <article style={{ padding: '0.85rem 1.25rem', borderRadius: '8px', border: '1px solid #e2e8f0', backgroundColor: '#fff' }}>
          <span style={{ fontSize: '0.85rem', color: '#64748b' }}>جلسات قيد العد والمسودات</span>
          <strong style={{ fontSize: '1.6rem', color: '#0369a1', display: 'block' }}>{activeSessions}</strong>
        </article>
        <article style={{ padding: '0.85rem 1.25rem', borderRadius: '8px', border: '1px solid #e2e8f0', backgroundColor: '#fff' }}>
          <span style={{ fontSize: '0.85rem', color: '#64748b' }}>بانتظار مراجعة واعتماد الإدارة</span>
          <strong style={{ fontSize: '1.6rem', color: '#b45309', display: 'block' }}>{underReviewSessions}</strong>
        </article>
        <article style={{ padding: '0.85rem 1.25rem', borderRadius: '8px', border: '1px solid #e2e8f0', backgroundColor: '#fff' }}>
          <span style={{ fontSize: '0.85rem', color: '#64748b' }}>تسويات مرحلة للأستاذ</span>
          <strong style={{ fontSize: '1.6rem', color: '#15803d', display: 'block' }}>{postedSessions}</strong>
        </article>
      </div>

      {/* شريط الأدوات والفلاتر */}
      <div
        className="warehouse-toolbar"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1rem',
          backgroundColor: '#fff',
          padding: '0.75rem 1rem',
          borderRadius: '8px',
          border: '1px solid #e2e8f0',
        }}
      >
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {/* فلتر المخزن */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <label htmlFor="filter-warehouse" style={{ fontSize: '0.85rem', fontWeight: 600, color: '#475569' }}>
              المخزن:
            </label>
            <select
              id="filter-warehouse"
              value={selectedWarehouse}
              onChange={(e) => setSelectedWarehouse(e.target.value)}
              style={{
                padding: '0.4rem 0.6rem',
                borderRadius: '6px',
                border: '1px solid #cbd5e1',
                fontSize: '0.85rem',
              }}
            >
              <option value="all">كافة المخازن</option>
              {warehouses.map((wh) => (
                <option key={wh.id} value={wh.id}>
                  {wh.name_ar}
                </option>
              ))}
            </select>
          </div>

          {/* فلتر الحالة */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <label htmlFor="filter-status" style={{ fontSize: '0.85rem', fontWeight: 600, color: '#475569' }}>
              الحالة:
            </label>
            <select
              id="filter-status"
              value={selectedStatus}
              onChange={(e) => setSelectedStatus(e.target.value)}
              style={{
                padding: '0.4rem 0.6rem',
                borderRadius: '6px',
                border: '1px solid #cbd5e1',
                fontSize: '0.85rem',
              }}
            >
              <option value="all">كافة الحالات</option>
              <option value="draft">مسودة</option>
              <option value="counting">جارٍ العد الفعلي</option>
              <option value="under_review">قيد المراجعة والاعتماد</option>
              <option value="recounting">إعادة العد مطلوبة</option>
              <option value="approved">معتمد للترحيل</option>
              <option value="posted">مرحل للأستاذ</option>
              <option value="cancelled">ملغى</option>
            </select>
          </div>

          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => void loadData()}
            disabled={loading}
            style={{ fontSize: '0.85rem', padding: '0.4rem 0.75rem' }}
          >
            تحديث
          </button>
        </div>

        {canCreate && (
          <button
            type="button"
            className="btn btn--primary"
            onClick={onOpenCreateModal}
            style={{ fontSize: '0.85rem', padding: '0.4rem 1rem' }}
          >
            + فتح جلسة جرد جديدة
          </button>
        )}
      </div>

      {/* التنبيهات ورسائل الخطأ */}
      {error && (
        <div className="warehouse-alert" role="alert" style={{ backgroundColor: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', padding: '0.75rem 1rem', borderRadius: '6px' }}>
          {error}
        </div>
      )}

      {/* جدول جلسات الجرد */}
      <div className="warehouse-table-wrap">
        <table className="warehouse-table">
          <thead>
            <tr>
              <th>رقم الجلسة</th>
              <th>المخزن</th>
              <th>نطاق الجرد</th>
              <th style={{ textAlign: 'center' }}>الحالة</th>
              <th style={{ textAlign: 'center' }}>تقدم العد</th>
              <th style={{ textAlign: 'center' }}>فروقات الجرد</th>
              <th style={{ textAlign: 'center' }}>صافي الأثر المالي</th>
              <th>تاريخ الإنشاء</th>
              <th style={{ textAlign: 'center' }}>الإجراءات</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={9} style={{ textAlign: 'center', padding: '3rem', color: '#64748b' }}>
                  جاري تحميل جلسات الجرد...
                </td>
              </tr>
            ) : sessions.length === 0 ? (
              <tr>
                <td colSpan={9} style={{ textAlign: 'center', padding: '3rem', color: '#94a3b8' }}>
                  لا توجد جلسات جرد مسجلة مطابقة للخيارات المحددة
                </td>
              </tr>
            ) : (
              sessions.map((st) => {
                const progressPct = st.total_lines > 0 ? Math.round((st.counted_lines / st.total_lines) * 100) : 0;
                return (
                  <tr key={st.id}>
                    <td style={{ fontWeight: 600 }}>
                      <span style={{ color: '#0f172a' }}>{st.session_number}</span>
                      {st.description && (
                        <small style={{ display: 'block', color: '#64748b', fontSize: '0.75rem' }}>
                          {st.description}
                        </small>
                      )}
                    </td>
                    <td>{st.warehouse_name_ar}</td>
                    <td>
                      <span style={{ fontSize: '0.85rem', color: '#475569' }}>
                        {st.scope_type === 'full_warehouse' ? 'جرد شامل' : 'أصناف محددة'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'center' }}>{getStatusBadge(st.status)}</td>
                    <td style={{ textAlign: 'center' }}>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.2rem' }}>
                        <span style={{ fontSize: '0.8rem', fontWeight: 600 }}>
                          {st.counted_lines} / {st.total_lines} ({progressPct}%)
                        </span>
                        <div style={{ width: '80px', height: '6px', backgroundColor: '#e2e8f0', borderRadius: '3px', overflow: 'hidden' }}>
                          <div style={{ width: `${progressPct}%`, height: '100%', backgroundColor: progressPct === 100 ? '#15803d' : '#0284c7' }} />
                        </div>
                      </div>
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'center', fontSize: '0.8rem' }}>
                        {st.shortage_lines > 0 && (
                          <span style={{ color: '#b91c1c', fontWeight: 600 }}>
                            {st.shortage_lines} عجز
                          </span>
                        )}
                        {st.surplus_lines > 0 && (
                          <span style={{ color: '#15803d', fontWeight: 600 }}>
                            {st.surplus_lines} زيادة
                          </span>
                        )}
                        {st.shortage_lines === 0 && st.surplus_lines === 0 && st.counted_lines > 0 && (
                          <span style={{ color: '#64748b' }}>مطابق</span>
                        )}
                        {st.counted_lines === 0 && <span style={{ color: '#cbd5e1' }}>—</span>}
                      </div>
                    </td>
                    <td style={{ textAlign: 'center', fontSize: '0.85rem', fontWeight: 600 }}>
                      {st.net_variance_cost !== 0 ? (
                        <span style={{ color: st.net_variance_cost < 0 ? '#b91c1c' : '#15803d' }}>
                          {Number(st.net_variance_cost).toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م
                        </span>
                      ) : (
                        <span style={{ color: '#94a3b8' }}>0.00</span>
                      )}
                    </td>
                    <td style={{ fontSize: '0.85rem', color: '#475569' }}>
                      {new Date(st.created_at).toLocaleDateString('ar-EG')}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <button
                        type="button"
                        className="btn btn--secondary"
                        onClick={() => onSelectSession(st.id)}
                        style={{ fontSize: '0.8rem', padding: '0.25rem 0.6rem' }}
                      >
                        عرض وإدارة
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

