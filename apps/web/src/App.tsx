import '@/styles/index.css';
import { OperationsBoard } from '@/features/operations-board/OperationsBoard';

const NAV_ITEMS = ['التشغيل اليومي', 'المخازن', 'دفعات الإنتاج', 'الطلبات والتسليم', 'التقارير'];

export default function App() {
  return (
    <div className="shell">
      {/* ── شريط علوي ────────────────────────────────── */}
      <header className="top-bar">
        <div className="brand">
          <div className="brand__mark" aria-hidden>ق</div>
          <div>
            <span className="brand__name">مصنع القمة</span>
            <span className="brand__sub">لوحة متابعة التشغيل</span>
          </div>
        </div>

        <nav aria-label="القائمة الرئيسية">
          <ul className="top-nav">
            {NAV_ITEMS.map((item, i) => (
              <li key={item}>
                <button
                  className={`top-nav__btn${i === 0 ? ' top-nav__btn--active' : ''}`}
                  aria-current={i === 0 ? 'page' : undefined}
                >
                  {item}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="user-chip">
          <div className="user-chip__avatar" aria-hidden>م</div>
          <div>
            <span className="user-chip__name">مدير المصنع</span>
            <span className="user-chip__role">حساب تجريبي ⌄</span>
          </div>
        </div>
      </header>

      {/* ── بانر تجريبي ──────────────────────────────── */}
      <div className="demo-banner" role="status">
        🔶 هذه بيئة تطوير تجريبية — جميع البيانات وهمية ولا تمثل أي عمليات حقيقية
      </div>

      {/* ── المحتوى الرئيسي ──────────────────────────── */}
      <main>
        <OperationsBoard />
      </main>
    </div>
  );
}
