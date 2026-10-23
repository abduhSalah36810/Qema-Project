import { useState, useEffect, useCallback } from 'react';
import '@/styles/index.css';
import { OperationsBoard } from '@/features/operations-board/OperationsBoard';
import { apiClient, ApiError } from '@/lib/api';
import { AuthProvider, useAuth } from '@/features/auth/AuthContext';
import { SignInModal } from '@/features/auth/SignInModal';

type ServerConnectionState =
  | { status: 'loading' }
  | { status: 'connected'; version: string; app: string }
  | { status: 'error'; message: string };

interface NavItem {
  id: string;
  name: string;
  icon: string;
  badge?: string;
  badgeVariant?: 'teal' | 'amber' | 'slate';
}

const SIDEBAR_NAV: NavItem[] = [
  { id: 'dashboard',  name: 'لوحة التشغيل',      icon: '📊' },
  { id: 'inventory',  name: 'المخازن والأصناف',  icon: '📦' },
  { id: 'batches',    name: 'دفعات الإنتاج',     icon: '⚡', badge: '٤ نشطة', badgeVariant: 'teal' },
  { id: 'orders',     name: 'الطلبات والتسليم',  icon: '🚚', badge: '٥', badgeVariant: 'amber' },
  { id: 'customers',  name: 'العملاء',            icon: '👥' },
  { id: 'reports',    name: 'التقارير والمتابعة', icon: '📈' },
  { id: 'settings',   name: 'إعدادات المصنع',    icon: '⚙️' },
];

function AppContent() {
  const [activeNav, setActiveNav] = useState('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [serverState, setServerState] = useState<ServerConnectionState>({
    status: 'loading',
  });

  const { authState, user, isConfigured } = useAuth();

  const checkServerHealth = useCallback(async () => {
    setServerState({ status: 'loading' });
    try {
      const health = await apiClient.getHealth();
      setServerState({
        status: 'connected',
        version: health.version,
        app: health.app,
      });
    } catch (err: unknown) {
      const message =
        err instanceof ApiError
          ? err.message
          : 'تعذر الاتصال بالخادم الخلفي.';
      setServerState({
        status: 'error',
        message,
      });
    }
  }, []);

  useEffect(() => {
    void checkServerHealth();
  }, [checkServerHealth]);

  return (
    <div className="app-shell" dir="rtl">
      {/* ── خلفية معتمة للهواتف عند فتح القائمة ───────── */}
      {mobileMenuOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setMobileMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ── الشريط الجانبي الأيمن الداكن (Dark Navy Sidebar) ── */}
      <aside className={`sidebar ${mobileMenuOpen ? 'sidebar--open' : ''}`}>
        {/* هوية المصنع */}
        <div className="sidebar__brand">
          <div className="sidebar__mark" aria-hidden>ق</div>
          <div className="sidebar__brand-text">
            <span className="sidebar__brand-name">مصنع القمة</span>
            <span className="sidebar__brand-sub">نظام ERP والتشغيل</span>
          </div>
          {/* زر إغلاق للشاشات الصغيرة */}
          <button
            className="sidebar__close-btn"
            onClick={() => setMobileMenuOpen(false)}
            aria-label="إغلاق القائمة"
          >
            ✕
          </button>
        </div>

        {/* عناصر التنقل */}
        <nav className="sidebar__nav" aria-label="شريط التنقل الرئيسي">
          <ul className="sidebar__menu">
            {SIDEBAR_NAV.map((item) => {
              const isActive = activeNav === item.id;
              return (
                <li key={item.id} className="sidebar__item-wrap">
                  <button
                    className={`sidebar__item ${isActive ? 'sidebar__item--active' : ''}`}
                    onClick={() => {
                      setActiveNav(item.id);
                      setMobileMenuOpen(false);
                    }}
                    aria-current={isActive ? 'page' : undefined}
                  >
                    <span className="sidebar__item-icon" aria-hidden>{item.icon}</span>
                    <span className="sidebar__item-label">{item.name}</span>
                    {item.badge && (
                      <span className={`sidebar__item-badge sidebar__item-badge--${item.badgeVariant || 'teal'}`}>
                        {item.badge}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* ملف المستخدم أسفل الشريط الجانبي */}
        <div className="sidebar__footer">
          <div className="sidebar__user">
            <div className="sidebar__avatar" aria-hidden>
              {user?.email ? user.email.charAt(0).toUpperCase() : '؟'}
            </div>
            <div className="sidebar__user-details">
              <span className="sidebar__user-name">
                {user?.email || 'حساب تجريبي (غير مسجل)'}
              </span>
              <span className="sidebar__user-role">
                {user
                  ? `معرّف موثق: ${user.id.slice(0, 8)}...`
                  : authState === 'unverified'
                  ? 'جلسة غير مؤكدة من الخادم'
                  : 'بيئة تجريبية · غير متصل بالمصنع'}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="sidebar__auth-btn"
            onClick={() => setAuthModalOpen(true)}
          >
            {user
              ? 'إدارة الجلسة / الخروج'
              : authState === 'unverified'
              ? 'تأكيد الجلسة / الخروج'
              : isConfigured
              ? 'تسجيل الدخول'
              : 'إعداد Supabase'}
          </button>
        </div>
      </aside>

      {/* ── مساحة العرض الرئيسية الدافئة (Main Canvas) ── */}
      <div className="main-canvas">
        {/* شريط الرأس الأبيض العلوي (White Top Design Panel) */}
        <header className="top-header">
          <div className="top-header__start">
            <button
              className="top-header__hamburger"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="فتح القائمة الرئيسية"
            >
              ☰
            </button>
            <div className="top-header__titles">
              <div className="top-header__kicker">الأحد · ١٨ أكتوبر ٢٠٢٦</div>
              <h1 className="top-header__title">لوحة متابعة تشغيل المصنع</h1>
            </div>
          </div>

          <div className="top-header__tools">
            {/* مؤشر حالة اتصال الخادم */}
            <div
              className={`server-status server-status--${serverState.status}`}
              role="status"
              aria-live="polite"
              title={
                serverState.status === 'connected'
                  ? `الخادم متصل (${serverState.app} v${serverState.version})`
                  : serverState.status === 'loading'
                  ? 'جاري فحص الاتصال بالخادم...'
                  : serverState.message
              }
            >
              <span className="server-status__pulse" aria-hidden />
              <span className="server-status__label">
                {serverState.status === 'connected' && `الخادم متصل · v${serverState.version}`}
                {serverState.status === 'loading' && 'جاري فحص الخادم...'}
                {serverState.status === 'error' && 'الخادم غير متصل'}
              </span>
              {serverState.status === 'error' && (
                <button
                  type="button"
                  className="server-status__retry"
                  onClick={() => void checkServerHealth()}
                  title="إعادة فحص الاتصال بالخادم"
                  aria-label="إعادة فحص الاتصال بالخادم"
                >
                  ↻
                </button>
              )}
            </div>

            {/* شارة حالة المصادقة */}
            <button
              type="button"
              className={`top-header__auth-badge ${
                user
                  ? 'top-header__auth-badge--active'
                  : authState === 'unverified'
                  ? 'top-header__auth-badge--amber'
                  : ''
              }`}
              onClick={() => setAuthModalOpen(true)}
              title={
                user
                  ? `مستخدم موثق (${user.email})`
                  : authState === 'unverified'
                  ? 'جلسة غير مؤكدة خادمياً'
                  : 'تسجيل الدخول للنظام'
              }
            >
              <span aria-hidden>{user ? '✓' : authState === 'unverified' ? '⚠️' : '🔒'}</span>
              <span>
                {user
                  ? user.email || 'مستخدم موثق'
                  : authState === 'unverified'
                  ? 'جلسة غير مؤكدة'
                  : 'تسجيل الدخول'}
              </span>
            </button>

            {/* شارة الوردية الحالية */}
            <div className="shift-indicator">
              <span className="shift-indicator__pulse" aria-hidden />
              <span className="shift-indicator__label">الوردية الصباحية</span>
              <span className="shift-indicator__hours">٨:٠٠ ص – ٤:٠٠ م</span>
            </div>

            {/* فلتر المخازن */}
            <button className="tool-dropdown">
              <span>كل المخازن</span>
              <span className="tool-dropdown__arrow">⌄</span>
            </button>

            {/* الزر الرئيسي التيل (Teal Action Button) */}
            <button className="btn-teal">
              <span>＋</span>
              <span>بدء دفعة إنتاج</span>
            </button>
          </div>
        </header>

        {/* مساحة لوحة التشغيل الفسيحة (Spacious Dashboard Area) */}
        <main className="dashboard-canvas">
          {/* شريط تنبيه تعذر الاتصال بالخادم الخلفي */}
          {serverState.status === 'error' && (
            <div className="api-error-strip" role="alert">
              <div className="api-error-strip__content">
                <span className="api-error-strip__icon" aria-hidden>⚠️</span>
                <div className="api-error-strip__body">
                  <strong>تنبيه اتصال الـ API:</strong> {serverState.message}
                  <span className="api-error-strip__hint">
                    تعمل الواجهة حاليًا في وضع العرض المحلي المستقل، ويمكنك الاستمرار في تصفح لوحة التشغيل بأمان.
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="api-error-strip__btn"
                onClick={() => void checkServerHealth()}
              >
                إعادة المحاولة
              </button>
            </div>
          )}

          {/* إشعار البيئة التجريبية الهادئ */}
          <div className="demo-strip" role="status">
            <span className="demo-strip__icon" aria-hidden>🔶</span>
            <span className="demo-strip__text">
              {user
                ? `جلسة عمل موثقة عبر Supabase & API — جميع بيانات الدفعات والمخازن أدناه هي نماذج للعرض البصري فقط، وليست محفوظة أو مرتبطة بقاعدة بيانات المصنع.`
                : `بيئة معاينة تجريبية محلية — لم يتم تسجيل الدخول، وجميع البيانات والأرقام المعروضة هي نماذج بصرية غير محفوظة ولا تتصل بالمصنع.`}
            </span>
            {serverState.status === 'connected' && (
              <span className="demo-strip__api-tag">
                ✓ متصل بالـ API (v{serverState.version})
              </span>
            )}
          </div>

          <OperationsBoard />
        </main>
      </div>

      {/* نافذة تسجيل الدخول وحالة الجلسة */}
      <SignInModal isOpen={authModalOpen} onClose={() => setAuthModalOpen(false)} />
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
