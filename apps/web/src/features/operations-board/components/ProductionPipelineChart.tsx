import type { ProductionOrder } from '@/features/production/productionApi';

interface ProductionPipelineChartProps {
  orders: ProductionOrder[] | null;
  loading?: boolean;
}

interface StageInfo {
  id: string;
  number: string;
  name: string;
  sub: string;
  icon: string;
  count: number;
  totalPieces: number;
  status: 'active' | 'pending' | 'completed';
}

export function ProductionPipelineChart({
  orders,
  loading = false,
}: ProductionPipelineChartProps) {
  if (loading) {
    return (
      <section className="card" style={{ padding: '1.25rem', marginBottom: '1.5rem' }}>
        <div style={{ height: '20px', width: '35%', background: '#e2e8f0', borderRadius: '4px', marginBottom: '1rem' }} />
        <div style={{ height: '80px', background: '#f1f5f9', borderRadius: '8px' }} />
      </section>
    );
  }

  const orderList = orders || [];

  // تصنيف الأوامر الفعلية على مراحل خط الإنتاج
  const stagesMap: Record<string, { count: number; pieces: number }> = {
    materials: { count: 0, pieces: 0 },
    cutting: { count: 0, pieces: 0 },
    sewing: { count: 0, pieces: 0 },
    snaps: { count: 0, pieces: 0 },
    ironing: { count: 0, pieces: 0 },
    packing: { count: 0, pieces: 0 },
    completed: { count: 0, pieces: 0 },
  };

  orderList.forEach((o) => {
    const qty = o.target_quantity || 0;
    if (o.status === 'receipt_completed' || o.status === 'completed' || o.status === 'closed') {
      stagesMap.completed.count += 1;
      stagesMap.completed.pieces += qty;
    } else if (o.status === 'materials_dispatched' || o.status === 'materials_received' || o.status === 'draft' || o.status === 'pending') {
      stagesMap.materials.count += 1;
      stagesMap.materials.pieces += qty;
    } else {
      // In progress: فحص آخر مرحلة نشطة
      const stages = o.stage_events || [];
      const hasPacking = stages.some((s) => s.stage_name === 'packing' && (s.status === 'in_progress' || s.status === 'completed'));
      const hasIroning = stages.some((s) => s.stage_name === 'ironing' && (s.status === 'in_progress' || s.status === 'completed'));
      const hasSnaps = stages.some((s) => s.stage_name === 'snap_installation' && (s.status === 'in_progress' || s.status === 'completed'));
      const hasFinishing = stages.some((s) => s.stage_name === 'finishing' && (s.status === 'in_progress' || s.status === 'completed'));

      if (hasPacking) {
        stagesMap.packing.count += 1;
        stagesMap.packing.pieces += qty;
      } else if (hasIroning) {
        stagesMap.ironing.count += 1;
        stagesMap.ironing.pieces += qty;
      } else if (hasSnaps) {
        stagesMap.snaps.count += 1;
        stagesMap.snaps.pieces += qty;
      } else if (hasFinishing) {
        stagesMap.sewing.count += 1;
        stagesMap.sewing.pieces += qty;
      } else {
        stagesMap.cutting.count += 1;
        stagesMap.cutting.pieces += qty;
      }
    }
  });

  const stages: StageInfo[] = [
    {
      id: 'materials',
      number: '١',
      name: 'صرف وتجهيز الخامات',
      sub: 'تحت التشغيل (WIP)',
      icon: '🧵',
      count: stagesMap.materials.count,
      totalPieces: stagesMap.materials.pieces,
      status: stagesMap.materials.count > 0 ? 'active' : 'pending',
    },
    {
      id: 'cutting',
      number: '٢',
      name: 'القص والتفصيل',
      sub: 'طاولات المقص الدائري',
      icon: '✂️',
      count: stagesMap.cutting.count,
      totalPieces: stagesMap.cutting.pieces,
      status: stagesMap.cutting.count > 0 ? 'active' : 'pending',
    },
    {
      id: 'sewing',
      number: '٣',
      name: 'التجميع والتشطيب',
      sub: 'خطوط الخياطة والأوفر',
      icon: '🪡',
      count: stagesMap.sewing.count,
      totalPieces: stagesMap.sewing.pieces,
      status: stagesMap.sewing.count > 0 ? 'active' : 'pending',
    },
    {
      id: 'snaps',
      number: '٤',
      name: 'تركيب الكبسولات',
      sub: 'ماكينة الكبسولة الهيدروليكية',
      icon: '🔘',
      count: stagesMap.snaps.count,
      totalPieces: stagesMap.snaps.pieces,
      status: stagesMap.snaps.count > 0 ? 'active' : 'pending',
    },
    {
      id: 'ironing',
      number: '٥',
      name: 'المكواة والتجهيز',
      sub: 'طاولات البخار والتعليق',
      icon: '♨️',
      count: stagesMap.ironing.count,
      totalPieces: stagesMap.ironing.pieces,
      status: stagesMap.ironing.count > 0 ? 'active' : 'pending',
    },
    {
      id: 'packing',
      number: '٦',
      name: 'التعبئة والتغليف',
      sub: 'أكياس وكراتين المنتج التام',
      icon: '📦',
      count: stagesMap.packing.count,
      totalPieces: stagesMap.packing.pieces,
      status: stagesMap.packing.count > 0 ? 'active' : 'pending',
    },
    {
      id: 'completed',
      number: '٧',
      name: 'مكتمل للتسليم',
      sub: 'بمخزن المنتجات التامة',
      icon: '✓',
      count: stagesMap.completed.count,
      totalPieces: stagesMap.completed.pieces,
      status: stagesMap.completed.count > 0 ? 'completed' : 'pending',
    },
  ];

  const totalActiveOrders = orderList.length;

  return (
    <section
      className="card"
      style={{
        padding: '1.25rem 1.5rem',
        marginBottom: '1.5rem',
        backgroundColor: '#ffffff',
        border: '1px solid #e2e8f0',
        borderRadius: '12px',
      }}
      aria-label="توزيع أوامر الإنتاج على مراحل التشغيل"
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '0.75rem',
          marginBottom: '1rem',
          borderBottom: '1px solid #f1f5f9',
          paddingBottom: '0.75rem',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '1.2rem' }}>⚡</span>
            <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: '#0f172a' }}>
              خط سير مراحل الإنتاج والتشغيل الحي
            </h3>
            <span
              style={{
                fontSize: '0.75rem',
                backgroundColor: totalActiveOrders > 0 ? '#f0fdfa' : '#f1f5f9',
                color: totalActiveOrders > 0 ? '#0f766e' : '#475569',
                border: '1px solid #cbd5e1',
                padding: '0.15rem 0.5rem',
                borderRadius: '999px',
                fontWeight: 600,
              }}
            >
              {totalActiveOrders > 0 ? `${totalActiveOrders.toLocaleString('ar-EG')} أمر نشط` : 'لا توجد أوامر جارية'}
            </span>
          </div>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.84rem', color: '#64748b' }}>
            توزيع وتتبع كميات الدفعات الفعلية عبر مراحل خط الإنتاج من صرف الخامات حتى تسليم المنتج التام
          </p>
        </div>
      </div>

      {totalActiveOrders === 0 ? (
        <div
          style={{
            padding: '2rem',
            textAlign: 'center',
            backgroundColor: '#f8fafc',
            borderRadius: '8px',
            border: '1px dashed #cbd5e1',
            color: '#64748b',
            fontSize: '0.9rem',
          }}
        >
          لا توجد أوامر تشغيل مسجلة على خط الإنتاج حالياً.
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))',
            gap: '0.75rem',
          }}
        >
          {stages.map((st, idx) => {
            const hasOrders = st.count > 0;
            return (
              <div
                key={st.id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  padding: '0.85rem 0.75rem',
                  borderRadius: '10px',
                  border: hasOrders
                    ? st.id === 'completed'
                      ? '1px solid #bbf7d0'
                      : '1px solid #99f6e4'
                    : '1px solid #e2e8f0',
                  backgroundColor: hasOrders
                    ? st.id === 'completed'
                      ? '#f0fdf4'
                      : '#f0fdfa'
                    : '#f8fafc',
                  position: 'relative',
                  transition: 'transform 0.15s ease',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                  <span
                    style={{
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      backgroundColor: hasOrders ? '#0f766e' : '#cbd5e1',
                      color: '#ffffff',
                      width: '20px',
                      height: '20px',
                      borderRadius: '50%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {st.number}
                  </span>
                  <span style={{ fontSize: '1.1rem' }}>{st.icon}</span>
                </div>

                <div style={{ fontWeight: 700, fontSize: '0.86rem', color: hasOrders ? '#0f172a' : '#64748b', marginBottom: '0.2rem' }}>
                  {st.name}
                </div>
                <div style={{ fontSize: '0.72rem', color: '#64748b', marginBottom: '0.6rem' }}>
                  {st.sub}
                </div>

                <div style={{ marginTop: 'auto', borderTop: '1px solid #e2e8f0', paddingTop: '0.5rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <span style={{ fontSize: '0.75rem', color: '#475569' }}>الأوامر:</span>
                    <strong style={{ fontSize: '0.92rem', color: hasOrders ? '#0f766e' : '#94a3b8' }}>
                      {st.count.toLocaleString('ar-EG')}
                    </strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginTop: '0.2rem' }}>
                    <span style={{ fontSize: '0.72rem', color: '#64748b' }}>القطع:</span>
                    <span style={{ fontSize: '0.8rem', fontWeight: 600, color: hasOrders ? '#0f172a' : '#94a3b8' }}>
                      {st.totalPieces.toLocaleString('ar-EG')}
                    </span>
                  </div>
                </div>

                {idx < stages.length - 1 && (
                  <span
                    aria-hidden
                    style={{
                      position: 'absolute',
                      left: '-8px',
                      top: '50%',
                      transform: 'translateY(-50%)',
                      fontSize: '0.85rem',
                      color: '#94a3b8',
                      display: 'none', // Can be enabled on large screens if desired
                    }}
                  >
                    ◀
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

