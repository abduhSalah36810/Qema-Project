import { useState } from 'react';
import '@/styles/index.css';
import { OperationsBoard } from '@/features/operations-board/OperationsBoard';

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

export default function App() {
  const [activeNav, setActiveNav] = useState('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

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
            <div className="sidebar__avatar" aria-hidden>م</div>
            <div className="sidebar__user-details">
              <span className="sidebar__user-name">محمود حسن</span>
              <span className="sidebar__user-role">مدير المصنع · حساب تجريبي</span>
            </div>
          </div>
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
          {/* إشعار البيئة التجريبية الهادئ */}
          <div className="demo-strip" role="status">
            <span className="demo-strip__icon" aria-hidden>🔶</span>
            <span className="demo-strip__text">
              بيئة تطوير ومعاينة تجريبية — جميع البيانات والأرقام المعروضة هي نماذج للعرض البصري فقط وليست بيانات تشغيل حقيقية.
            </span>
          </div>

          <OperationsBoard />
        </main>
      </div>
    </div>
  );
}
