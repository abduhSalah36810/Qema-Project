import React, { useState, useEffect } from 'react';
import {
  fetchFactoryCalendar,
  updateFactoryCalendar,
  fetchBottleneckAnalysis,
  BottleneckAnalysisResponse,
} from './productionApi';
import { ApiError } from '../../lib/api';

interface BottleneckCalendarModalProps {
  isOpen: boolean;
  onClose: () => void;
  canManageStages: boolean;
}

const ALL_DAYS: Array<{ id: string; name: string }> = [
  { id: 'saturday', name: 'السبت' },
  { id: 'sunday', name: 'الأحد' },
  { id: 'monday', name: 'الاثنين' },
  { id: 'tuesday', name: 'الثلاثاء' },
  { id: 'wednesday', name: 'الأربعاء' },
  { id: 'thursday', name: 'الخميس' },
  { id: 'friday', name: 'الجمعة (عطلة أسبوعية)' },
];

export const BottleneckCalendarModal: React.FC<BottleneckCalendarModalProps> = ({
  isOpen,
  onClose,
  canManageStages,
}) => {
  const [activeTab, setActiveTab] = useState<'bottlenecks' | 'calendar'>('bottlenecks');
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [analysis, setAnalysis] = useState<BottleneckAnalysisResponse | null>(null);

  // فورم التقويم
  const [shiftName, setShiftName] = useState('');
  const [shiftStart, setShiftStart] = useState('08:00');
  const [shiftEnd, setShiftEnd] = useState('17:00');
  const [workingDays, setWorkingDays] = useState<string[]>(['saturday', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday']);
  const [weeklyHolidays, setWeeklyHolidays] = useState<string[]>(['friday']);
  const [isApproved, setIsApproved] = useState(false);

  const loadData = async () => {
    setLoading(true);
    setStatusMessage(null);
    try {
      const [analysisData, calData] = await Promise.all([
        fetchBottleneckAnalysis(),
        fetchFactoryCalendar(),
      ]);
      setAnalysis(analysisData);

      setShiftName(calData.shift_name);
      setShiftStart(calData.shift_start_time);
      setShiftEnd(calData.shift_end_time);
      setWorkingDays(calData.working_days.split(',').map((d) => d.trim()));
      setWeeklyHolidays(calData.weekly_holidays.split(',').map((d) => d.trim()));
      setIsApproved(calData.is_approved);
    } catch (err) {
      setStatusMessage({
        type: 'error',
        text: err instanceof ApiError || err instanceof Error ? err.message : 'تعذر تحميل بيانات التقويم والاختناقات',
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      void loadData();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSaveCalendar = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setStatusMessage(null);
    try {
      await updateFactoryCalendar({
        shift_name: shiftName,
        shift_start_time: shiftStart,
        shift_end_time: shiftEnd,
        working_days: workingDays.join(','),
        weekly_holidays: weeklyHolidays.join(','),
        is_approved: isApproved,
      });
      setStatusMessage({ type: 'success', text: 'تم حفظ وتحديث تقويم ورديات المصنع بنجاح' });
      void loadData();
    } catch (err) {
      setStatusMessage({
        type: 'error',
        text: err instanceof ApiError || err instanceof Error ? err.message : 'تعذر حفظ إعدادات التقويم',
      });
    } finally {
      setSaving(false);
    }
  };

  const toggleWorkingDay = (dayId: string) => {
    if (workingDays.includes(dayId)) {
      setWorkingDays(workingDays.filter((d) => d !== dayId));
    } else {
      setWorkingDays([...workingDays, dayId]);
    }
  };

  const formatMinutes = (mins: number) => {
    const hours = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    if (hours === 0) return `${m} دقيقة`;
    return `${hours} س ${m > 0 ? `${m} د` : ''}`;
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div
        className="modal-container"
        style={{ maxWidth: '960px', width: '95%' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700 }}>
              📊 تحليل الاختناقات التشغيلية وتقويم المصنع
            </h2>
            <p style={{ margin: '4px 0 0 0', fontSize: '0.85rem', color: '#64748b' }}>
              متابعة أزمنة مراحل الإنتاج (TIME-DEC-01..04)، كشف الاختناقات وتأثير الورديات على دورة التشغيل.
            </p>
          </div>
          <button className="btn-close" onClick={onClose} aria-label="إغلاق">
            ✕
          </button>
        </div>

        {statusMessage && (
          <div
            style={{
              padding: '10px 16px',
              margin: '12px 20px 0 20px',
              borderRadius: '6px',
              backgroundColor: statusMessage.type === 'error' ? '#fef2f2' : '#f0fdf4',
              color: statusMessage.type === 'error' ? '#991b1b' : '#166534',
              border: `1px solid ${statusMessage.type === 'error' ? '#fecaca' : '#bbf7d0'}`,
              fontSize: '0.9rem',
            }}
          >
            {statusMessage.text}
          </div>
        )}

        <div className="modal-tabs" style={{ padding: '0 20px', marginTop: '12px', borderBottom: '1px solid #e2e8f0' }}>
          <button
            className={`tab-btn ${activeTab === 'bottlenecks' ? 'tab-btn--active' : ''}`}
            onClick={() => setActiveTab('bottlenecks')}
          >
            ⏱️ تحليل اختناقات المراحل
          </button>
          <button
            className={`tab-btn ${activeTab === 'calendar' ? 'tab-btn--active' : ''}`}
            onClick={() => setActiveTab('calendar')}
          >
            🗓️ تقويم ورديات العمل والعطلات
          </button>
        </div>

        <div className="modal-body" style={{ padding: '20px', maxHeight: '72vh', overflowY: 'auto' }}>
          {loading ? (
            <div style={{ textAlign: 'center', padding: '40px', color: '#64748b' }}>
              جاري تحميل إحصائيات التوقيت والاختناقات...
            </div>
          ) : activeTab === 'bottlenecks' && analysis ? (
            <div>
              {/* شريط المؤشرات السريعة */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px', marginBottom: '20px' }}>
                <div style={{ padding: '14px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
                  <div style={{ fontSize: '0.8rem', color: '#64748b' }}>حالة تقويم المصنع</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: 700, marginTop: '4px', color: analysis.calendar_approved ? '#047857' : '#d97706' }}>
                    {analysis.calendar_approved ? '✓ معتمد رسمياً' : '⚠️ تقديري (قيد الاعتماد)'}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '2px' }}>
                    {analysis.calendar_approved ? 'ساعات العمل الرسمية مفعلة' : 'الحساب يتم تقويمياً لحين الاعتماد'}
                  </div>
                </div>

                <div style={{ padding: '14px', background: '#fef2f2', borderRadius: '8px', border: '1px solid #fee2e2' }}>
                  <div style={{ fontSize: '0.8rem', color: '#991b1b' }}>أوامر قيد التشغيل متجاوزة للمدة</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 700, marginTop: '4px', color: '#b91c1c' }}>
                    {analysis.active_bottlenecks_count} أمر تشغيل
                  </div>
                  <div style={{ fontSize: '0.75rem', color: '#b91c1c', marginTop: '2px' }}>
                    مراحل حالية تجاوزت وقت الوردية المتوقع
                  </div>
                </div>
              </div>

              {/* جدول أزمنة المراحل الخمس واختناقاتها */}
              <div style={{ background: '#fff', borderRadius: '8px', border: '1px solid #e2e8f0', padding: '16px', marginBottom: '20px' }}>
                <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '12px' }}>
                  أداء المراحل الخمس ومعدل الاختناق (TIME-DEC-01 & TIME-DEC-04)
                </h3>
                <div className="table-responsive">
                  <table className="preview-table table--compact" style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th>المرحلة الفنية</th>
                        <th style={{ textAlign: 'center' }}>الطلبيات المكتملة</th>
                        <th style={{ textAlign: 'right' }}>المدة المتوقعة</th>
                        <th style={{ textAlign: 'right' }}>متوسط زمن الوردية</th>
                        <th style={{ textAlign: 'right' }}>متوسط الزمن التقويمي</th>
                        <th style={{ textAlign: 'right' }}>الفارق والانحراف</th>
                        <th style={{ textAlign: 'center' }}>تكرار الاختناق</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analysis.stages.map((st) => {
                        const isExcess = st.variance_minutes > 0;
                        return (
                          <tr key={st.stage_name}>
                            <td>
                              <strong>{st.stage_name_ar}</strong>
                            </td>
                            <td style={{ textAlign: 'center' }}>{st.total_completed_orders}</td>
                            <td style={{ textAlign: 'right' }}>{formatMinutes(st.avg_expected_minutes)}</td>
                            <td style={{ textAlign: 'right' }}>{formatMinutes(st.avg_working_minutes)}</td>
                            <td style={{ textAlign: 'right', color: '#64748b' }}>{formatMinutes(st.avg_elapsed_minutes)}</td>
                            <td style={{ textAlign: 'right', color: isExcess ? '#dc2626' : '#16a34a', fontWeight: 600 }}>
                              {isExcess ? `+${formatMinutes(st.variance_minutes)}` : `${formatMinutes(Math.abs(st.variance_minutes))} توفير`}
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              {st.bottleneck_count > 0 ? (
                                <span className="badge badge--danger">
                                  {st.bottleneck_count} ({st.bottleneck_percentage}%)
                                </span>
                              ) : (
                                <span className="badge badge--success">لا اختناقات</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* أسباب التأخير وتوزيعها */}
              <div style={{ background: '#fff', borderRadius: '8px', border: '1px solid #e2e8f0', padding: '16px', marginBottom: '20px' }}>
                <h3 style={{ fontSize: '1rem', fontWeight: 600, marginBottom: '12px' }}>
                  أكثر أسباب التأخير المسجلة (TIME-DEC-04)
                </h3>
                {analysis.top_delay_reasons.length === 0 ? (
                  <p style={{ color: '#64748b', fontSize: '0.875rem' }}>لم تُسجل أي حالات تأخير مع أسباب حتى الآن.</p>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
                    {analysis.top_delay_reasons.map((d) => (
                      <div key={d.reason_code} style={{ padding: '10px 14px', background: '#f8fafc', borderRadius: '6px', border: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: '0.9rem', fontWeight: 500 }}>{d.reason_name_ar}</span>
                        <span className="badge badge--primary">{d.count} مرة</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* الاختناقات الجارية حالياً */}
              {analysis.active_bottlenecks.length > 0 && (
                <div style={{ background: '#fff', borderRadius: '8px', border: '1px solid #fecaca', padding: '16px' }}>
                  <h3 style={{ fontSize: '1rem', fontWeight: 600, color: '#991b1b', marginBottom: '12px' }}>
                    ⚠️ أوامر تشغيل متوقفة ومتجاوزة للمدة حالياً
                  </h3>
                  <div className="table-responsive">
                    <table className="preview-table table--compact" style={{ width: '100%' }}>
                      <thead>
                        <tr>
                          <th>رقم الأمر</th>
                          <th>المرحلة العالقة</th>
                          <th>المدة المتوقعة</th>
                          <th>المدة المنقضية الحالية</th>
                          <th>سبب التأخير</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analysis.active_bottlenecks.map((ab, idx) => (
                          <tr key={idx}>
                            <td><strong>{ab.order_number}</strong></td>
                            <td>{ab.stage_name_ar}</td>
                            <td>{formatMinutes(ab.expected_minutes)}</td>
                            <td style={{ color: '#dc2626', fontWeight: 600 }}>{formatMinutes(ab.current_working_minutes)}</td>
                            <td>{ab.delay_reason_ar || 'لم يحدد سبب'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          ) : activeTab === 'calendar' ? (
            <form onSubmit={handleSaveCalendar} style={{ maxWidth: '650px' }}>
              <div style={{ marginBottom: '16px' }}>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 600 }}>تهيئة تقويم ورديات المصنع (TIME-DEC-02)</h3>
                <p style={{ color: '#64748b', fontSize: '0.85rem' }}>
                  يستخدم هذا التقويم لتصفية ساعات العمل الفعلية واستبعاد أوقات الراحة وأيام العطلات الأسبوعية من زمن تنفيذ المراحل.
                </p>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '14px', marginBottom: '16px' }}>
                <label className="form-label">
                  <span>اسم الوردية الأساسية</span>
                  <input
                    type="text"
                    className="form-input"
                    value={shiftName}
                    onChange={(e) => setShiftName(e.target.value)}
                    required
                  />
                </label>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <label className="form-label">
                    <span>بداية الوردية</span>
                    <input
                      type="time"
                      className="form-input"
                      value={shiftStart}
                      onChange={(e) => setShiftStart(e.target.value)}
                      required
                    />
                  </label>
                  <label className="form-label">
                    <span>نهاية الوردية</span>
                    <input
                      type="time"
                      className="form-input"
                      value={shiftEnd}
                      onChange={(e) => setShiftEnd(e.target.value)}
                      required
                    />
                  </label>
                </div>

                <div>
                  <span style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, marginBottom: '8px' }}>
                    أيام العمل الأسبوعية
                  </span>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '8px' }}>
                    {ALL_DAYS.map((day) => {
                      const isChecked = workingDays.includes(day.id);
                      return (
                        <label
                          key={day.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            padding: '8px',
                            border: '1px solid #e2e8f0',
                            borderRadius: '6px',
                            background: isChecked ? '#eff6ff' : '#fff',
                            cursor: 'pointer',
                            fontSize: '0.85rem',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => toggleWorkingDay(day.id)}
                          />
                          <span>{day.name}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div style={{ padding: '14px', background: isApproved ? '#f0fdf4' : '#fffbeb', borderRadius: '8px', border: `1px solid ${isApproved ? '#bbf7d0' : '#fde68a'}`, marginTop: '8px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={isApproved}
                      onChange={(e) => setIsApproved(e.target.checked)}
                      disabled={!canManageStages}
                    />
                    <div>
                      <strong style={{ fontSize: '0.9rem' }}>اعتماد تقويم الورديات رسمياً من إدارة المصنع</strong>
                      <p style={{ margin: '2px 0 0 0', fontSize: '0.8rem', color: '#64748b' }}>
                        عند تفعيل هذا الخيار، يتم إلغاء صفة &quot;التقديري&quot; وتعتبر إحصائيات زمن الوردية رسمية ومعتمدة.
                      </p>
                    </div>
                  </label>
                </div>
              </div>

              {canManageStages && (
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '20px' }}>
                  <button type="submit" className="btn btn--primary" disabled={saving}>
                    {saving ? 'جاري الحفظ…' : 'حفظ إعدادات التقويم'}
                  </button>
                </div>
              )}
            </form>
          ) : null}
        </div>

        <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', padding: '12px 20px', borderTop: '1px solid #e2e8f0' }}>
          <button className="btn btn--secondary" onClick={onClose}>
            إغلاق
          </button>
        </div>
      </div>
    </div>
  );
};

