/**
 * نافذة تسجيل الدخول للمصنع (Sign-In Modal)
 * ─────────────────────────────────────────────────────────────────────────────
 * واجهة عربية RTL متكاملة تدعم:
 * 1. تسجيل الدخول بالبريد الإلكتروني وكلمة المرور عبر Supabase Auth.
 * 2. إظهار حالة عدم توفر التكوين (Configuration Required) عند غياب متغيرات البيئة.
 * 3. إظهار حالات التحميل والخطأ واستعادة الجلسة بنصوص عربية واضحة دون أي تسريب لبيانات حساسة.
 * 4. التعامل مع حالة الجلسة غير المؤكدة من الخادم (Unverified Session) مع إتاحة إعادة المحاولة أو الخروج.
 * 5. إظهار بيانات المستخدم الموثق مع خيار تسجيل الخروج النظيف.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import React, { useState } from 'react';
import { useAuth } from './AuthContext';
import { ChangePasswordForm } from './ChangePasswordForm';

interface SignInModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SignInModal({ isOpen, onClose }: SignInModalProps) {
  const {
    authState,
    user,
    session,
    roles,
    error,
    isConfigured,
    isDevAuthAvailable,
    signIn,
    signInLocalDev,
    signOut,
    retryVerification,
    clearError,
    authMode,
  } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submittingRole, setSubmittingRole] = useState<string | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  if (!isOpen) return null;

  const activeRole = roles[0] || 'general_manager';

  const roleLabels: Record<string, { title: string; desc: string; icon: string }> = {
    general_manager: {
      title: 'دخول كمدير عام',
      desc: 'صلاحيات كاملة (اعتماد أصناف، ترحيل جرد، إدارة إنتاج)',
      icon: '⚡',
    },
    warehouse_manager: {
      title: 'دخول كأمين مخزن',
      desc: 'حركات المخازن والعد الفعلي (محظور من الاعتماد والترحيل)',
      icon: '📦',
    },
    production_manager: {
      title: 'دخول كمدير إنتاج',
      desc: 'استلام الخامات بالورشة، تسجيل المراحل، العيوب والهالك، والإغلاق',
      icon: '⚙️',
    },
    finance_manager: {
      title: 'دخول كمدير مالي',
      desc: 'الخزينة والمصروفات والمدفوعات (محظور من حركات المخزن المباشرة)',
      icon: '💰',
    },
  };

  const handleLocalDevLogin = async (roleName: string) => {
    setLocalError(null);
    clearError();
    setSubmittingRole(roleName);
    try {
      await signInLocalDev(roleName);
      onClose();
    } catch (err: unknown) {
      if (err instanceof Error) {
        setLocalError(err.message);
      }
    } finally {
      setSubmittingRole(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    clearError();

    if (!email.trim() || !password) {
      setLocalError('يرجى إدخال البريد الإلكتروني وكلمة المرور.');
      return;
    }

    setIsSubmitting(true);
    try {
      await signIn(email, password);
      onClose();
    } catch (err: unknown) {
      if (err instanceof Error) {
        setLocalError(err.message);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSignOut = async () => {
    await signOut();
    onClose();
  };

  const handleRetry = async () => {
    setLocalError(null);
    clearError();
    setIsRetrying(true);
    try {
      await retryVerification();
    } finally {
      setIsRetrying(false);
    }
  };

  return (
    <div className="auth-modal-backdrop" onClick={onClose} aria-hidden="true">
      <div
        className="auth-modal"
        dir="rtl"
        role="dialog"
        aria-labelledby="auth-modal-title"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        {/* رأس النافذة */}
        <div className="auth-modal__header">
          <div className="auth-modal__brand">
            <div className="auth-modal__mark" aria-hidden>ق</div>
            <div>
              <h2 id="auth-modal-title" className="auth-modal__title">
                {user
                  ? 'بيانات المستخدم الموثق'
                  : authState === 'unverified'
                  ? 'تعذر تأكيد الجلسة مع الخادم'
                  : 'تسجيل الدخول للنظام'}
              </h2>
              <span className="auth-modal__sub">مصنع القمة للملابس · نظام ERP</span>
            </div>
          </div>
          <button
            type="button"
            className="auth-modal__close-btn"
            onClick={onClose}
            aria-label="إغلاق النافذة"
          >
            ✕
          </button>
        </div>

        {/* جسم النافذة حسب الحالة */}
        <div className="auth-modal__body">
          {/* حالة المستخدم المصادق عليه بنجاح من الخادم */}
          {user && (
            <div className="auth-modal__authenticated-view">
              <div className="auth-modal__user-card">
                <div className="auth-modal__user-avatar" aria-hidden>
                  {user.email ? user.email.charAt(0).toUpperCase() : 'م'}
                </div>
                <div className="auth-modal__user-info">
                  <span className="auth-modal__user-email">{user.email || 'مستخدم موثق بدون بريد'}</span>
                  <span className="auth-modal__status-tag">✓ تم تسجيل الدخول</span>
                </div>
              </div>

              {/* بطاقة عرض الدور المفعل مع إمكانية التبديل السريع */}
              <div className="auth-modal__active-role-card" style={{ marginTop: '0.75rem', padding: '0.75rem', background: '#f8fafc', borderRadius: '0.5rem', border: '1px solid #e2e8f0' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                  <span style={{ fontWeight: 600, fontSize: '0.875rem', color: '#475569' }}>الدور النشط في الجلسة:</span>
                  <span style={{
                    fontWeight: 700,
                    fontSize: '0.875rem',
                    padding: '0.2rem 0.6rem',
                    borderRadius: '9999px',
                    background: activeRole === 'general_manager' ? '#ccfbf1' : activeRole === 'warehouse_manager' ? '#e0f2fe' : '#f3e8ff',
                    color: activeRole === 'general_manager' ? '#0f766e' : activeRole === 'warehouse_manager' ? '#0369a1' : '#6b21a8',
                  }}>
                    {roleLabels[activeRole]?.title || activeRole}
                  </span>
                </div>
                {isDevAuthAvailable && (
                  <div>
                    <div style={{ fontSize: '0.75rem', color: '#64748b', marginBottom: '0.5rem' }}>
                      تبديل الدور (نسخة العرض): كل عملية مالية يعتمدها شخص غير الذي أنشأها، فبدّل الدور لتجربة الاعتماد.
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem' }}>
                      {Object.entries(roleLabels).map(([rKey, rInfo]) => (
                        <button
                          key={rKey}
                          type="button"
                          disabled={rKey === activeRole || submittingRole !== null}
                          onClick={() => handleLocalDevLogin(rKey)}
                          style={{
                            padding: '0.4rem 0.25rem',
                            fontSize: '0.75rem',
                            fontWeight: 600,
                            borderRadius: '0.375rem',
                            border: rKey === activeRole ? '2px solid #0d9488' : '1px solid #cbd5e1',
                            background: rKey === activeRole ? '#f0fdfa' : '#ffffff',
                            color: rKey === activeRole ? '#0f766e' : '#334155',
                            cursor: rKey === activeRole ? 'default' : 'pointer',
                          }}
                        >
                          {submittingRole === rKey ? '...' : rInfo.title}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {authMode === 'supabase' && <ChangePasswordForm />}

              <div className="auth-modal__notice" style={{ marginTop: '0.75rem' }}>
                <span>🔒 تسجيل الدخول يثبت هويتك فقط. صلاحيات الأدوار التشغيلية تُدار وتُعتمد خادمياً.</span>
              </div>

              <button
                type="button"
                className="btn-danger-outline"
                onClick={handleSignOut}
                style={{ marginTop: '0.5rem' }}
              >
                تسجيل الخروج
              </button>
            </div>
          )}

          {/* حالة تعذر التحقق من الجلسة مع الخادم الخلفي (Unverified Session) */}
          {!user && authState === 'unverified' && (
            <div className="auth-modal__unverified-view">
              <div className="auth-alert auth-alert--red" role="alert">
                <span className="auth-alert__icon" aria-hidden>⚠️</span>
                <div className="auth-alert__content">
                  <strong>فشل التحقق الخادمي من جلسة الدخول:</strong>
                  <p>{error || 'تعذر التحقق من هوية المستخدم مع مسار /api/v1/auth/me.'}</p>
                  <small>لم يتم اعتبار حسابك موثقاً لحين نجاح المطابقة الخادمية، وتم إخلاء توكن الوصول من الذاكرة.</small>
                </div>
              </div>

              {session?.user?.email && (
                <div className="auth-modal__user-card">
                  <div className="auth-modal__user-avatar" aria-hidden>؟</div>
                  <div className="auth-modal__user-info">
                    <span className="auth-modal__user-email">{session.user.email}</span>
                    <span className="auth-modal__status-tag auth-modal__status-tag--amber">
                      جلسة محلية بانتظار التحقق الخادمي
                    </span>
                  </div>
                </div>
              )}

              <div className="auth-modal__actions-row">
                <button
                  type="button"
                  className="btn-teal-outline"
                  onClick={handleRetry}
                  disabled={isRetrying}
                >
                  {isRetrying ? 'جاري إعادة الفحص...' : '↻ إعادة محاولة التحقق'}
                </button>
                <button
                  type="button"
                  className="btn-danger-outline"
                  onClick={handleSignOut}
                >
                  تسجيل الخروج ومسح الجلسة
                </button>
              </div>
            </div>
          )}

          {/* حالة غياب إعدادات Supabase */}
          {!user && authState !== 'unverified' && !isConfigured && (
            <div className="auth-modal__config-missing">
              {(localError || error) && (
                <div className="auth-alert auth-alert--red" role="alert" style={{ marginBottom: '1rem' }}>
                  <span className="auth-alert__icon" aria-hidden>⚠️</span>
                  <span className="auth-alert__text">{localError || error}</span>
                </div>
              )}

              {/* خيارات الدخول المحلي للأدوار الثلاثة في بيئة التطوير والاختبار */}
              {isDevAuthAvailable && (
                <div className="auth-alert auth-alert--teal" style={{ marginBottom: '1.25rem', borderColor: '#0d9488' }}>
                  <span className="auth-alert__icon" aria-hidden>💻</span>
                  <div className="auth-alert__content" style={{ width: '100%' }}>
                    <strong style={{ color: '#0f766e', fontSize: '1rem', display: 'block', marginBottom: '0.25rem' }}>
                      اختر دورك في نسخة العرض:
                    </strong>
                    <p style={{ margin: '0 0 0.75rem', fontSize: '0.825rem', color: '#334155' }}>
                      كل دور يرى الشاشات والعمليات المسموح بها له فقط.
                    </p>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      {Object.entries(roleLabels).map(([rKey, rInfo]) => (
                        <button
                          key={rKey}
                          type="button"
                          className="btn-teal"
                          style={{
                            width: '100%',
                            padding: '0.6rem 0.75rem',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            textAlign: 'right',
                            background: rKey === 'general_manager' ? '#0d9488' : rKey === 'warehouse_manager' ? '#0284c7' : '#7c3aed',
                            borderColor: 'transparent',
                          }}
                          onClick={() => handleLocalDevLogin(rKey)}
                          disabled={submittingRole !== null}
                        >
                          <span style={{ fontWeight: 700 }}>
                            {rInfo.icon} {submittingRole === rKey ? 'جاري التحضير والدخول...' : rInfo.title}
                          </span>
                          <span style={{ fontSize: '0.75rem', opacity: 0.9 }}>
                            {rKey === 'general_manager' ? 'مدير عام' : rKey === 'warehouse_manager' ? 'أمين مخزن' : rKey === 'production_manager' ? 'مدير إنتاج' : 'مدير مالي'}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {!isDevAuthAvailable && (
                <div className="auth-alert auth-alert--amber">
                  <span className="auth-alert__icon" aria-hidden>⚙️</span>
                  <div className="auth-alert__content">
                    <strong>تسجيل الدخول غير مُهيأ بعد</strong>
                    <p>اطلب من مسؤول النظام إعداد حسابات الدخول (راجع دليل التثبيت والتشغيل).</p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* نموذج تسجيل الدخول عند توفر الإعدادات */}
          {!user && authState !== 'unverified' && isConfigured && (
            <form onSubmit={handleSubmit} className="auth-modal__form">
              {(localError || error) && (
                <div className="auth-alert auth-alert--red" role="alert">
                  <span className="auth-alert__icon" aria-hidden>⚠️</span>
                  <span className="auth-alert__text">{localError || error}</span>
                </div>
              )}

              <div className="auth-field">
                <label htmlFor="auth-email" className="auth-field__label">
                  البريد الإلكتروني
                </label>
                <input
                  id="auth-email"
                  type="email"
                  className="auth-field__input"
                  placeholder="name@qemma.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  dir="ltr"
                  autoComplete="email"
                  required
                  disabled={isSubmitting || authState === 'loading'}
                />
              </div>

              <div className="auth-field">
                <label htmlFor="auth-password" className="auth-field__label">
                  كلمة المرور
                </label>
                <input
                  id="auth-password"
                  type="password"
                  className="auth-field__input"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  dir="ltr"
                  autoComplete="current-password"
                  required
                  disabled={isSubmitting || authState === 'loading'}
                />
              </div>

              <button
                type="submit"
                className="btn-teal auth-modal__submit-btn"
                disabled={isSubmitting || authState === 'loading'}
              >
                {isSubmitting || authState === 'loading' ? (
                  <span>جاري تسجيل الدخول والتحقق...</span>
                ) : (
                  <span>دخول إلى النظام</span>
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
