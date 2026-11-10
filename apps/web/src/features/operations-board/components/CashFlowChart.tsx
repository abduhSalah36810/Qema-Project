interface CashFlowChartProps {
  revenues: number;
  expenses: number;
  net: number;
  treasuryBalance: number;
  pettyCashTotal: number;
  periodLabel?: string;
  loading?: boolean;
}

export function CashFlowChart({
  revenues,
  expenses,
  net,
  treasuryBalance,
  pettyCashTotal,
  periodLabel = 'الفترة الحالية',
  loading = false,
}: CashFlowChartProps) {
  const formatEgp = (val: number): string =>
    `${val.toLocaleString('ar-EG', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })} ج.م`;

  const totalFlow = revenues + expenses;
  const revPercent = totalFlow > 0 ? Math.round((revenues / totalFlow) * 100) : 50;
  const expPercent = totalFlow > 0 ? 100 - revPercent : 50;

  const totalLiquidity = treasuryBalance + pettyCashTotal;
  const treasuryPercent =
    totalLiquidity > 0 ? Math.round((treasuryBalance / totalLiquidity) * 100) : 50;
  const pettyPercent = totalLiquidity > 0 ? 100 - treasuryPercent : 50;

  const maxBarValue = Math.max(revenues, expenses, Math.abs(net), 1);
  const revBarHeight = Math.max(12, Math.round((revenues / maxBarValue) * 140));
  const expBarHeight = Math.max(12, Math.round((expenses / maxBarValue) * 140));
  const netBarHeight = Math.max(12, Math.round((Math.abs(net) / maxBarValue) * 140));

  if (loading) {
    return (
      <article className="card" style={{ padding: '1.5rem', marginBottom: '1.25rem' }}>
        <div style={{ height: '20px', width: '40%', background: '#e2e8f0', borderRadius: '4px', marginBottom: '1rem' }} />
        <div style={{ height: '160px', background: '#f1f5f9', borderRadius: '8px' }} />
      </article>
    );
  }

  return (
    <article
      className="card"
      style={{
        padding: '1.5rem',
        marginBottom: '1.5rem',
        backgroundColor: '#ffffff',
        border: '1px solid #e2e8f0',
        borderRadius: '12px',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.04)',
      }}
      aria-label="رسم بياني لميزان التدفق النقدي والسيولة"
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: '0.75rem',
          borderBottom: '1px solid #f1f5f9',
          paddingBottom: '1rem',
          marginBottom: '1.25rem',
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '1.2rem' }}>📈</span>
            <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: '#0f172a' }}>
              ميزان التدفق النقدي التشغيلي والسيولة
            </h3>
            <span
              style={{
                fontSize: '0.75rem',
                backgroundColor: '#f0fdf4',
                color: '#166534',
                border: '1px solid #bbf7d0',
                padding: '0.15rem 0.5rem',
                borderRadius: '999px',
                fontWeight: 600,
              }}
            >
              أساس نقدي فعلي (Cash Basis)
            </span>
          </div>
          <p style={{ margin: '0.35rem 0 0', fontSize: '0.84rem', color: '#64748b' }}>
            مقارنة بصرية بين المقبوضات التشغيلية والمصروفات النقدية وصافي التدفق النقدي ({periodLabel})
          </p>
        </div>

        <div style={{ textAlign: 'left', minWidth: '160px' }}>
          <div style={{ fontSize: '0.78rem', color: '#64748b' }}>إجمالي السيولة المتاحة</div>
          <div style={{ fontSize: '1.15rem', fontWeight: 800, color: '#0f766e' }}>
            {formatEgp(totalLiquidity)}
          </div>
        </div>
      </div>

      {totalFlow === 0 && totalLiquidity === 0 ? (
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
          لا توجد حركات تدفقات نقدية مسجلة بالفترة الحالية (الرصيد الفعلي ٠٫٠٠ ج.م).
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
          {/* العمود 1: أعمدة المقارنة البيانية */}
          <div>
            <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#334155', marginBottom: '0.75rem' }}>
              مقارنة مؤشرات التدفق للفترة
            </div>

            <div
              style={{
                display: 'flex',
                alignItems: 'flex-end',
                justifyContent: 'space-around',
                height: '160px',
                padding: '1rem 0 0.5rem',
                backgroundColor: '#f8fafc',
                borderRadius: '10px',
                border: '1px solid #f1f5f9',
              }}
            >
              {/* عمود المقبوضات */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  width: '75px',
                  height: '100%',
                  justifyContent: 'flex-end',
                }}
              >
                <span
                  style={{
                    fontSize: '0.75rem',
                    fontWeight: 700,
                    color: '#16a34a',
                    marginBottom: '0.35rem',
                    textAlign: 'center',
                  }}
                >
                  +{revenues > 0 ? (revenues >= 1000 ? `${(revenues / 1000).toFixed(1)}k` : revenues) : '0'}
                </span>
                <div
                  style={{
                    width: '42px',
                    height: `${revBarHeight}px`,
                    backgroundColor: '#16a34a',
                    borderRadius: '6px 6px 0 0',
                    transition: 'height 0.4s ease',
                  }}
                  title={`المقبوضات التشغيلية: ${formatEgp(revenues)}`}
                />
                <span style={{ fontSize: '0.75rem', color: '#475569', marginTop: '0.4rem', fontWeight: 600 }}>
                  المقبوضات
                </span>
              </div>

              {/* عمود المصروفات */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  width: '75px',
                  height: '100%',
                  justifyContent: 'flex-end',
                }}
              >
                <span
                  style={{
                    fontSize: '0.75rem',
                    fontWeight: 700,
                    color: '#dc2626',
                    marginBottom: '0.35rem',
                    textAlign: 'center',
                  }}
                >
                  -{expenses > 0 ? (expenses >= 1000 ? `${(expenses / 1000).toFixed(1)}k` : expenses) : '0'}
                </span>
                <div
                  style={{
                    width: '42px',
                    height: `${expBarHeight}px`,
                    backgroundColor: '#dc2626',
                    borderRadius: '6px 6px 0 0',
                    transition: 'height 0.4s ease',
                  }}
                  title={`المصروفات النقدية: ${formatEgp(expenses)}`}
                />
                <span style={{ fontSize: '0.75rem', color: '#475569', marginTop: '0.4rem', fontWeight: 600 }}>
                  المصروفات
                </span>
              </div>

              {/* عمود صافي التدفق */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  width: '75px',
                  height: '100%',
                  justifyContent: 'flex-end',
                }}
              >
                <span
                  style={{
                    fontSize: '0.75rem',
                    fontWeight: 700,
                    color: net >= 0 ? '#0f766e' : '#ea580c',
                    marginBottom: '0.35rem',
                    textAlign: 'center',
                  }}
                >
                  {net >= 0 ? '+' : ''}
                  {Math.abs(net) >= 1000 ? `${(net / 1000).toFixed(1)}k` : net}
                </span>
                <div
                  style={{
                    width: '42px',
                    height: `${netBarHeight}px`,
                    backgroundColor: net >= 0 ? '#0f766e' : '#ea580c',
                    borderRadius: '6px 6px 0 0',
                    transition: 'height 0.4s ease',
                  }}
                  title={`صافي التدفق النقدي: ${formatEgp(net)}`}
                />
                <span style={{ fontSize: '0.75rem', color: '#475569', marginTop: '0.4rem', fontWeight: 600 }}>
                  صافي التدفق
                </span>
              </div>
            </div>
          </div>

          {/* العمود 2: تفصيل النسب وتكوين السيولة */}
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '1.25rem' }}>
            {/* شريط نسبة التدفقات */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', marginBottom: '0.4rem' }}>
                <span style={{ color: '#166534', fontWeight: 600 }}>
                  ● المقبوضات التشغيلية: {formatEgp(revenues)} ({revPercent}%)
                </span>
                <span style={{ color: '#991b1b', fontWeight: 600 }}>
                  ● المصروفات النقدية: {formatEgp(expenses)} ({expPercent}%)
                </span>
              </div>
              <div
                style={{
                  height: '12px',
                  display: 'flex',
                  borderRadius: '999px',
                  overflow: 'hidden',
                  backgroundColor: '#e2e8f0',
                }}
              >
                <div style={{ width: `${revPercent}%`, backgroundColor: '#16a34a' }} />
                <div style={{ width: `${expPercent}%`, backgroundColor: '#dc2626' }} />
              </div>
            </div>

            {/* شريط توزيع السيولة النقدية الحاضرة */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', marginBottom: '0.4rem' }}>
                <span style={{ color: '#0f766e', fontWeight: 600 }}>
                  ● الخزينة الرئيسية: {formatEgp(treasuryBalance)} ({treasuryPercent}%)
                </span>
                <span style={{ color: '#0284c7', fontWeight: 600 }}>
                  ● صناديق العهد: {formatEgp(pettyCashTotal)} ({pettyPercent}%)
                </span>
              </div>
              <div
                style={{
                  height: '12px',
                  display: 'flex',
                  borderRadius: '999px',
                  overflow: 'hidden',
                  backgroundColor: '#e2e8f0',
                }}
              >
                <div style={{ width: `${treasuryPercent}%`, backgroundColor: '#0f766e' }} />
                <div style={{ width: `${pettyPercent}%`, backgroundColor: '#0284c7' }} />
              </div>
            </div>

            <div
              style={{
                fontSize: '0.78rem',
                color: '#64748b',
                lineHeight: 1.5,
                backgroundColor: '#f8fafc',
                padding: '0.5rem 0.75rem',
                borderRadius: '6px',
                border: '1px solid #f1f5f9',
              }}
            >
              <strong>ملاحظة سيولة:</strong> الحركات مستخلصة من قيود الخزينة وسندات الصرف والقبض الفعلية دون إيرادات استحقاقية غير محصلة.
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

