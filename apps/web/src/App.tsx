import { useState, useEffect, useCallback } from 'react';
import '@/styles/index.css';
import { OperationsBoard } from '@/features/operations-board/OperationsBoard';
import { ProductionOrdersView } from '@/features/production/ProductionOrdersView';
import { CustomersView } from '@/features/customers/CustomersView';
import { MainWarehouseView } from '@/features/inventory/MainWarehouseView';
import { MachineryView } from '@/features/inventory/MachineryView';
import { FinishedGoodsView } from '@/features/inventory/FinishedGoodsView';
import { StocktakeView } from '@/features/inventory/StocktakeView';
import { CatalogManagementView } from '@/features/catalog/CatalogManagementView';
import { TreasuryView } from '@/features/finance/TreasuryView';
import { RevenuesView } from '@/features/finance/RevenuesView';
import { ExpensesView } from '@/features/finance/ExpensesView';
import { CustodyView } from '@/features/finance/CustodyView';
import { SuppliersView } from '@/features/finance/SuppliersView';
import { PaymentsCollectionsView } from '@/features/finance/PaymentsCollectionsView';
import { PayrollFinanceView } from '@/features/finance/PayrollFinanceView';
import { FinancialReportsView } from '@/features/finance/FinancialReportsView';
import { apiClient, ApiError } from '@/lib/api';
import { AuthProvider, useAuth } from '@/features/auth/AuthContext';
import { SignInModal } from '@/features/auth/SignInModal';

type ServerConnectionState =
  | { status: 'loading' }
  | { status: 'connected'; version: string; app: string }
  | { status: 'error'; message: string };

type NavEntry =
  | {
      type: 'item';
      id: string;
      name: string;
      icon: string;
      badge?: string;
      badgeVariant?: 'teal' | 'amber' | 'slate';
      requiredPermission?: string;
    }
  | {
      type: 'group';
      id: string;
      name: string;
      icon: string;
      badge?: string;
      badgeVariant?: 'teal' | 'amber' | 'slate';
      requiredPermission?: string;
      children: Array<{
        id: string;
        name: string;
        icon?: string;
        badge?: string;
        badgeVariant?: 'teal' | 'amber' | 'slate';
        requiredPermission?: string;
      }>;
    };

const SIDEBAR_ITEMS: NavEntry[] = [
  { type: 'item', id: 'dashboard', name: 'لوحة التشغيل', icon: '📊' },
  {
    type: 'group',
    id: 'warehouses',
    name: 'المخازن',
    icon: '📦',
    children: [
      { id: 'warehouse-raw', name: 'مخزن الخامات والمستلزمات' },
      { id: 'warehouse-machinery', name: 'الماكينات والمعدات' },
      { id: 'warehouse-finished', name: 'مخزن المنتجات التامة' },
      { id: 'warehouse-catalog', name: 'دليل الأصناف والتصنيفات' },
      { id: 'warehouse-stocktake', name: 'الجرد والتسويات المخزنية', requiredPermission: 'inventory:stocktake:view' },
      { id: 'warehouse-reports', name: 'تقرير أرصدة المخزون', requiredPermission: 'inventory:view' },
    ],
  },
  { type: 'item', id: 'batches', name: 'دفعات الإنتاج', icon: '⚡', badge: '٤ نشطة', badgeVariant: 'teal' },
  { type: 'item', id: 'orders', name: 'الطلبات والتسليم', icon: '🚚', badge: '٥', badgeVariant: 'amber' },
  {
    type: 'group',
    id: 'finance',
    name: 'المالية',
    icon: '💰',
    children: [
      { id: 'finance-treasury', name: 'الخزنة' },
      { id: 'finance-revenues', name: 'الإيرادات' },
      { id: 'finance-expenses', name: 'المصروفات' },
      { id: 'finance-custody', name: 'العهد المالية' },
      { id: 'finance-customers', name: 'العملاء' },
      { id: 'finance-suppliers', name: 'الموردون' },
      { id: 'finance-payments', name: 'المدفوعات والتحصيلات' },
      { id: 'finance-payroll', name: 'الرواتب المالية' },
      { id: 'finance-reports', name: 'التقارير المالية', requiredPermission: 'finance:reports:view' },
    ],
  },
  { type: 'item', id: 'settings', name: 'إعدادات المصنع', icon: '⚙️' },
];

function getHeaderInfo(nav: string): { kicker: string; title: string } {
  switch (nav) {
    case 'batches':
      return { kicker: 'أوامر التشغيل · لقطات الخامات التناسبية والمراحل', title: 'متابعة دفعات الإنتاج ومراحل التصنيع' };
    case 'orders':
      return { kicker: 'الطلبات والعملاء · الشحن والتسليم', title: 'متابعة طلبات التشغيل والتسليم' };
    case 'warehouse-catalog':
    case 'catalog':
      return { kicker: 'المخازن · دليل الخامات والمستلزمات والتصنيفات', title: 'دليل الأصناف والتصنيفات وخطوط الاستخدام' };
    case 'warehouse-raw':
    case 'inventory':
      return { kicker: 'المخازن · الخامات والمستلزمات ومواد التعبئة', title: 'مخزن الخامات والمستلزمات' };
    case 'warehouse-machinery':
      return { kicker: 'المخازن · معدات التشغيل وخطوط الإنتاج', title: 'الماكينات ومعدات التشغيل' };
    case 'warehouse-finished':
      return { kicker: 'المخازن · المنتجات الجاهزة للتسليم النهائي', title: 'مخزن المنتجات التامة' };
    case 'warehouse-stocktake':
      return { kicker: 'المخازن · الجرد الميداني وتثبيت الدفاتر والتسويات المعتمدة', title: 'إدارة الجرد والتسويات المخزنية' };
    case 'warehouse-reports':
      return { kicker: 'المخازن · التحليل وأرصدة الدفاتر', title: 'تقرير حركة وأرصدة المخزون' };
    case 'finance-treasury':
    case 'finance':
      return { kicker: 'المالية · الخزنة الرئيسية وحركات النقدية', title: 'الخزنة والحسابات النقدية' };
    case 'finance-revenues':
      return { kicker: 'المالية · التدفقات النقدية الداخلة', title: 'الإيرادات التشغيلية' };
    case 'finance-expenses':
      return { kicker: 'المالية · التدفقات النقدية الخارجة', title: 'المصروفات التشغيلية' };
    case 'finance-custody':
      return { kicker: 'المالية · الصناديق والمصروفات اليومية', title: 'العهد المالية المؤقتة' };
    case 'finance-customers':
    case 'customers':
      return { kicker: 'المالية · ملفات العملاء وبيانات التواصل والمديونيات', title: 'إدارة العملاء' };
    case 'finance-suppliers':
      return { kicker: 'المالية · المشتريات وفواتير الخامات', title: 'الموردون وفواتير الشراء' };
    case 'finance-payments':
      return { kicker: 'المالية · متابعة حركة السيولة والسدادات', title: 'المدفوعات والتحصيلات' };
    case 'finance-payroll':
    case 'payroll':
      return { kicker: 'المالية · استحقاقات الأجور وصرف المرتبات', title: 'الرواتب والأجور المالية' };
    case 'finance-reports':
    case 'reports':
      return { kicker: 'المالية · التحليل المالي ومؤشرات الأداء', title: 'التقارير المالية ومؤشرات السيولة' };
    case 'settings':
      return { kicker: 'النظام · إعدادات المصنع والمستخدمين والتدقيق', title: 'إعدادات المصنع والتدقيق' };
    case 'dashboard':
    default:
      return { kicker: 'متابعة تشغيل المصنع', title: 'لوحة متابعة تشغيل المصنع' };
  }
}

function AppContent() {
  const [activeNav, setActiveNav] = useState('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    warehouses: true,
    finance: true,
  });
  const [serverState, setServerState] = useState<ServerConnectionState>({
    status: 'loading',
  });

  const { authState, authMode, user, isConfigured, isDevAuthAvailable, hasPermission, roles } = useAuth();

  const canAccessFinanceReports =
    authMode === 'local_dev' ||
    !user ||
    roles.length === 0 ||
    hasPermission('finance:reports:view') ||
    hasPermission('reports:view');

  const canAccessInventoryReports =
    authMode === 'local_dev' ||
    !user ||
    roles.length === 0 ||
    hasPermission('inventory:view');

  const canAccessStocktake =
    authMode === 'local_dev' ||
    !user ||
    roles.length === 0 ||
    hasPermission('inventory:stocktake:view') ||
    hasPermission('inventory:view');

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

  const toggleGroup = (groupId: string) => {
    setOpenGroups((prev) => ({
      ...prev,
      [groupId]: !prev[groupId],
    }));
  };

  const headerInfo = getHeaderInfo(activeNav);

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

        {/* عناصر التنقل الهيكلية */}
        <nav className="sidebar__nav" aria-label="شريط التنقل الرئيسي">
          <ul className="sidebar__menu">
            {SIDEBAR_ITEMS.map((entry) => {
              if (entry.type === 'item') {
                const isActive = activeNav === entry.id;
                return (
                  <li key={entry.id} className="sidebar__item-wrap">
                    <button
                      className={`sidebar__item ${isActive ? 'sidebar__item--active' : ''}`}
                      onClick={() => {
                        setActiveNav(entry.id);
                        setMobileMenuOpen(false);
                      }}
                      aria-current={isActive ? 'page' : undefined}
                    >
                      <span className="sidebar__item-icon" aria-hidden>{entry.icon}</span>
                      <span className="sidebar__item-label">{entry.name}</span>
                      {entry.badge && (
                        <span className={`sidebar__item-badge sidebar__item-badge--${entry.badgeVariant || 'teal'}`}>
                          {entry.badge}
                        </span>
                      )}
                    </button>
                  </li>
                );
              }

              // Dropdown Group Item (المخازن / المالية)
              const isOpen = openGroups[entry.id] ?? false;
              const visibleChildren = entry.children.filter((sub) => {
                if (!sub.requiredPermission) return true;
                if (authMode === 'local_dev' || !user || roles.length === 0) return true;
                return hasPermission(sub.requiredPermission);
              });

              if (visibleChildren.length === 0) return null;

              const hasActiveChild = visibleChildren.some(
                (child) => activeNav === child.id || (entry.id === 'finance' && activeNav === 'customers' && child.id === 'finance-customers')
              );

              return (
                <li key={entry.id} className="sidebar__group">
                  <button
                    type="button"
                    className={`sidebar__group-header ${hasActiveChild ? 'sidebar__group-header--active' : ''}`}
                    onClick={() => toggleGroup(entry.id)}
                    aria-expanded={isOpen}
                  >
                    <div className="sidebar__group-title">
                      <span className="sidebar__item-icon" aria-hidden>{entry.icon}</span>
                      <span>{entry.name}</span>
                    </div>
                    <span className={`sidebar__group-arrow ${isOpen ? 'sidebar__group-arrow--open' : ''}`} aria-hidden>
                      ▾
                    </span>
                  </button>

                  {isOpen && (
                    <ul className="sidebar__sub-menu">
                      {visibleChildren.map((sub) => {
                        const isSubActive =
                          activeNav === sub.id ||
                          (sub.id === 'warehouse-raw' && activeNav === 'inventory') ||
                          (sub.id === 'warehouse-reports' && activeNav === 'inventory-reports') ||
                          (sub.id === 'finance-treasury' && activeNav === 'finance') ||
                          (sub.id === 'finance-customers' && activeNav === 'customers') ||
                          (sub.id === 'finance-payroll' && activeNav === 'payroll') ||
                          (sub.id === 'finance-reports' && activeNav === 'reports');

                        return (
                          <li key={sub.id}>
                            <button
                              type="button"
                              className={`sidebar__sub-item ${isSubActive ? 'sidebar__sub-item--active' : ''}`}
                              onClick={() => {
                                setActiveNav(sub.id);
                                setMobileMenuOpen(false);
                              }}
                              aria-current={isSubActive ? 'page' : undefined}
                            >
                              <span className="sidebar__sub-dot" aria-hidden />
                              <span>{sub.name}</span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>

        {/* ملف المستخدم أسفل الشريط الجانبي */}
        <div className="sidebar__footer">
          <div className="sidebar__user">
            <div className="sidebar__avatar" aria-hidden>
              {authMode === 'local_dev' ? '⚙️' : user?.email ? user.email.charAt(0).toUpperCase() : '؟'}
            </div>
            <div className="sidebar__user-details">
              <span className="sidebar__user-name">
                {authMode === 'local_dev'
                  ? 'المطور المحلي (General Manager)'
                  : user?.email || 'حساب تجريبي (غير مسجل)'}
              </span>
              <span className="sidebar__user-role">
                {authMode === 'local_dev'
                  ? 'LOCAL DEV AUTH'
                  : user
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
              : isDevAuthAvailable
              ? 'تسجيل دخول المطور'
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
              <div className="top-header__kicker">{headerInfo.kicker}</div>
              <h1 className="top-header__title">{headerInfo.title}</h1>
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

            {/* فلتر المخازن السريع */}
            <button className="tool-dropdown">
              <span>كل المخازن</span>
              <span className="tool-dropdown__arrow">⌄</span>
            </button>

            {/* الزر الرئيسي التيل (Teal Action Button) */}
            <button
              className="btn-teal"
              onClick={() => {
                setActiveNav('batches');
                setTimeout(() => {
                  const btn = document.getElementById('btnNewOrderModal');
                  if (btn) btn.click();
                }, 50);
              }}
            >
              <span>＋</span>
              <span>بدء دفعة إنتاج</span>
            </button>
          </div>
        </header>

        {/* مساحة لوحة التشغيل الفسيحة (Spacious Dashboard Area) */}
        <main className="dashboard-canvas">
          {/* شريط وضع التطوير المحلي المستقل */}
          {authMode === 'local_dev' && (
            <div
              className="local-dev-banner"
              role="status"
              style={{
                backgroundColor: '#0f766e',
                color: '#ffffff',
                padding: '0.65rem 1.25rem',
                borderRadius: '8px',
                marginBottom: '1rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontWeight: 600,
                fontSize: '0.92rem',
                boxShadow: '0 2px 4px rgba(15, 118, 110, 0.15)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                <span aria-hidden style={{ fontSize: '1.2rem' }}>💻</span>
                <span>
                  <strong>وضع التطوير المحلي المستقل (LOCAL DEV MODE)</strong> — تم توثيق الجلسة محلياً بصلاحيات المدير العام دون الحاجة إلى Supabase
                </span>
              </div>
              <span
                style={{
                  fontSize: '0.8rem',
                  backgroundColor: 'rgba(255, 255, 255, 0.2)',
                  padding: '0.2rem 0.6rem',
                  borderRadius: '4px',
                }}
              >
                DEV_AUTH_ENABLED
              </span>
            </div>
          )}

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
              {activeNav === 'finance-customers' || activeNav === 'customers'
                ? 'بيانات العملاء والمعاملات تُحمّل من API قاعدة البيانات، ولا تُعرض كبيانات تجريبية.'
                : user
                ? `جلسة عمل موثقة عبر Supabase & API — جميع بيانات الدفعات والمخازن أدناه هي نماذج للعرض البصري فقط، وليست محفوظة أو مرتبطة بقاعدة بيانات المصنع.`
                : `بيئة معاينة تجريبية محلية — لم يتم تسجيل الدخول، وجميع البيانات والأرقام المعروضة هي نماذج بصرية غير محفوظة ولا تتصل بالمصنع.`}
            </span>
            {serverState.status === 'connected' && (
              <span className="demo-strip__api-tag">
                ✓ متصل بالـ API (v{serverState.version})
              </span>
            )}
          </div>

          {/* محتوى الشاشة المحدد بحسب المسار */}
          {activeNav === 'batches' ? (
            <ProductionOrdersView />
          ) : activeNav === 'warehouse-catalog' || activeNav === 'catalog' ? (
            <CatalogManagementView />
          ) : activeNav === 'warehouse-raw' || activeNav === 'inventory' ? (
            <MainWarehouseView />
          ) : activeNav === 'warehouse-machinery' ? (
            <MachineryView />
          ) : activeNav === 'warehouse-finished' ? (
            <FinishedGoodsView />
          ) : activeNav === 'warehouse-stocktake' ? (
            canAccessStocktake ? (
              <StocktakeView />
            ) : (
              <section className="warehouse-page" dir="rtl">
                <header className="warehouse-page__header">
                  <div>
                    <span className="warehouse-page__eyebrow">الصلاحيات والتفويض</span>
                    <h2>تم رفض الوصول (403 Forbidden)</h2>
                    <p>حسابك لا يمتلك الصلاحية المطلوبة لعرض شاشة الجرد والتسويات المخزنية.</p>
                  </div>
                </header>
                <div
                  className="warehouse-alert"
                  role="alert"
                  style={{
                    backgroundColor: '#fff1f2',
                    borderColor: '#fecdd3',
                    color: '#9f1239',
                    padding: '2rem',
                    textAlign: 'center',
                  }}
                >
                  <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>🔒</div>
                  <h3 style={{ margin: '0 0 0.5rem', color: '#9f1239' }}>صلاحية الوصول غير كافية</h3>
                  <p style={{ margin: '0 0 1rem', color: '#881337', fontSize: '0.9rem' }}>
                    يتطلب عرض هذه الشاشة الحصول على صلاحية <code>inventory:stocktake:view</code>.
                  </p>
                  <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={() => setActiveNav('dashboard')}
                  >
                    العودة للوحة التشغيل
                  </button>
                </div>
              </section>
            )
          ) : activeNav === 'warehouse-reports' ? (
            canAccessInventoryReports ? (
              <FinancialReportsView initialTab="inventory" />
            ) : (
              <section className="warehouse-page" dir="rtl">
                <header className="warehouse-page__header">
                  <div>
                    <span className="warehouse-page__eyebrow">الصلاحيات والتفويض</span>
                    <h2>تم رفض الوصول (403 Forbidden)</h2>
                    <p>حسابك لا يمتلك الصلاحية المطلوبة لعرض تقرير أرصدة المخزون.</p>
                  </div>
                </header>
                <div
                  className="warehouse-alert"
                  role="alert"
                  style={{
                    backgroundColor: '#fff1f2',
                    borderColor: '#fecdd3',
                    color: '#9f1239',
                    padding: '2rem',
                    textAlign: 'center',
                  }}
                >
                  <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>🔒</div>
                  <h3 style={{ margin: '0 0 0.5rem', color: '#9f1239' }}>صلاحية الوصول غير كافية</h3>
                  <p style={{ margin: '0 0 1rem', color: '#881337', fontSize: '0.9rem' }}>
                    يتطلب عرض هذه الشاشة الحصول على صلاحية <code>inventory:view</code>.
                  </p>
                  <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={() => setActiveNav('dashboard')}
                  >
                    العودة إلى لوحة التشغيل
                  </button>
                </div>
              </section>
            )
          ) : activeNav === 'finance-treasury' || activeNav === 'finance' ? (
            <TreasuryView />
          ) : activeNav === 'finance-revenues' ? (
            <RevenuesView />
          ) : activeNav === 'finance-expenses' ? (
            <ExpensesView />
          ) : activeNav === 'finance-custody' ? (
            <CustodyView />
          ) : activeNav === 'finance-customers' || activeNav === 'customers' ? (
            <CustomersView />
          ) : activeNav === 'finance-suppliers' ? (
            <SuppliersView />
          ) : activeNav === 'finance-payments' ? (
            <PaymentsCollectionsView />
          ) : activeNav === 'finance-payroll' || activeNav === 'payroll' ? (
            <PayrollFinanceView />
          ) : activeNav === 'finance-reports' || activeNav === 'reports' ? (
            canAccessFinanceReports ? (
              <FinancialReportsView initialTab="summary" />
            ) : (
              <section className="warehouse-page" dir="rtl">
                <header className="warehouse-page__header">
                  <div>
                    <span className="warehouse-page__eyebrow">الصلاحيات والتفويض</span>
                    <h2>تم رفض الوصول (403 Forbidden)</h2>
                    <p>حسابك لا يمتلك الصلاحية المطلوبة لعرض التقارير المالية ومؤشرات السيولة.</p>
                  </div>
                </header>
                <div
                  className="warehouse-alert"
                  role="alert"
                  style={{
                    backgroundColor: '#fff1f2',
                    borderColor: '#fecdd3',
                    color: '#9f1239',
                    padding: '2rem',
                    textAlign: 'center',
                  }}
                >
                  <div style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>🔒</div>
                  <h3 style={{ margin: '0 0 0.5rem', color: '#9f1239' }}>صلاحية الوصول غير كافية</h3>
                  <p style={{ margin: '0 0 1rem', color: '#881337', fontSize: '0.9rem' }}>
                    يتطلب عرض هذه الشاشة الحصول على صلاحية <code>finance:reports:view</code> أو <code>reports:view</code>.
                  </p>
                  <button
                    type="button"
                    className="btn btn--secondary"
                    onClick={() => setActiveNav('dashboard')}
                  >
                    العودة إلى لوحة التشغيل
                  </button>
                </div>
              </section>
            )
          ) : (
            <OperationsBoard />
          )}
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
