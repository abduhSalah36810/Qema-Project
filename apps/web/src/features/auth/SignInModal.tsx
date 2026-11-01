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

interface SignInModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SignInModal({ isOpen, onClose }: SignInModalProps) {
  const {
    authState,
    user,
    session,
    error,
    isConfigured,
    isDevAuthAvailable,
    signIn,
    signInLocalDev,
    signOut,
    retryVerification,
    clearError,
  } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isLocalDevSubmitting, setIsLocalDevSubmitting] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleLocalDevLogin = async () => {
    setLocalError(null);
    clearError();
    setIsLocalDevSubmitting(true);
    try {
      await signInLocalDev();
      onClose();
    } catch (err: unknown) {
      if (err instanceof Error) {
        setLocalError(err.message);
      }
    } finally {
      setIsLocalDevSubmitting(false);
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
                  <span className="auth-modal__user-id" title={user.id}>
                    معرّف المستخدم (ID): {user.id.slice(0, 13)}...
                  </span>
                  <span className="auth-modal__status-tag">✓ موثق من خادم الـ API</span>
                </div>
              </div>

              <div className="auth-modal__notice">
                <span>🔒 تسجيل الدخول يثبت هويتك فقط. صلاحيات الأدوار التشغيلية تُدار وتُعتمد خادمياً.</span>
              </div>

              <button
                type="button"
                className="btn-danger-outline"
                onClick={handleSignOut}
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

              {/* خيار الدخول المحلي للمطور عند توفره في بيئة التطوير */}
              {isDevAuthAvailable && (
                <div className="auth-alert auth-alert--teal" style={{ marginBottom: '1.25rem', borderColor: '#0d9488' }}>
                  <span className="auth-alert__icon" aria-hidden>💻</span>
                  <div className="auth-alert__content">
                    <strong style={{ color: '#0f766e', fontSize: '1rem' }}>
                      المصادقة المحلية المستقلة (Local Development Auth):
                    </strong>
                    <p style={{ margin: '0.35rem 0 0.75rem' }}>
                      يمكنك الدخول فورياً بصلاحيات <strong>المدير العام (General Manager)</strong> وتجربة كامل وظائف النظام وحفظ العمليات على قاعدة البيانات دون الحاجة إلى حساب Supabase.
                    </p>
                    <button
                      type="button"
                      className="btn-teal"
                      style={{ width: '100%', padding: '0.65rem' }}
                      onClick={handleLocalDevLogin}
                      disabled={isLocalDevSubmitting}
                    >
                      {isLocalDevSubmitting ? 'جاري تسجيل الدخول المحلي...' : '⚡ دخول كمطور محلي (صلاحيات كاملة)'}
                    </button>
                  </div>
                </div>
              )}

              <div className="auth-alert auth-alert--amber">
                <span className="auth-alert__icon" aria-hidden>⚙️</span>
                <div className="auth-alert__content">
                  <strong>إعدادات Supabase السحابية (للإنتاج):</strong>
                  <p>
                    لربط المصادقة السحابية عبر Supabase، اضبط المتغيرات في ملف <code>.env</code> للواجهة الأمامية:
                  </p>
                  <ul>
                    <li><code>VITE_SUPABASE_URL=https://&lt;project&gt;.supabase.co</code></li>
                    <li><code>VITE_SUPABASE_ANON_KEY=&lt;anon-key&gt;</code></li>
                  </ul>
                  <small>تنبيه أمني: لا تضع المفاتيح السرية أو رابط قاعدة البيانات في متغيرات المتصفح VITE_*.</small>
                </div>
              </div>

              <div className="auth-modal__demo-action">
                <p>
                  وضع المعاينة التجريبي مخصص للاستعراض البصري فقط؛ لا يمثل جلسة موثقة ولا يحفظ أو يعدل أي بيانات على خادم المصنع.
                </p>
                <button
                  type="button"
                  className="btn-teal-outline"
                  onClick={onClose}
                >
                  المتابعة في وضع العرض التجريبي
                </button>
              </div>
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
