import { useState, useEffect, useCallback, useMemo, lazy, Suspense } from 'react';
import '@/styles/index.css';
import '@/styles/inbox.css';
import '@/styles/master-data.css';
import '@/styles/workflow.css';

/**
 * الشاشات تُحمَّل عند الطلب (code splitting) حتى لا يُجمَّع التطبيق كله في حزمة واحدة ضخمة؛
 * شاشة المهام تبقى استيراداً مباشراً لأنها نقطة الهبوط الأولى لكل مستخدم.
 */
const OperationsBoard = lazy(() =>
  import('@/features/operations-board/OperationsBoard').then((m) => ({ default: m.OperationsBoard })));
const ProductionOrdersView = lazy(() =>
  import('@/features/production/ProductionOrdersView').then((m) => ({ default: m.ProductionOrdersView })));
const CustomersView = lazy(() =>
  import('@/features/customers/CustomersView').then((m) => ({ default: m.CustomersView })));
const CustomerDeliveriesView = lazy(() =>
  import('@/features/customers/CustomerDeliveriesView').then((m) => ({ default: m.CustomerDeliveriesView })));
const MainWarehouseView = lazy(() =>
  import('@/features/inventory/MainWarehouseView').then((m) => ({ default: m.MainWarehouseView })));
const MachineryView = lazy(() =>
  import('@/features/inventory/MachineryView').then((m) => ({ default: m.MachineryView })));
const FinishedGoodsView = lazy(() =>
  import('@/features/inventory/FinishedGoodsView').then((m) => ({ default: m.FinishedGoodsView })));
const StocktakeView = lazy(() =>
  import('@/features/inventory/StocktakeView').then((m) => ({ default: m.StocktakeView })));
const WarehouseGuideView = lazy(() =>
  import('@/features/inventory/WarehouseGuideView').then((m) => ({ default: m.WarehouseGuideView })));
const CatalogManagementView = lazy(() =>
  import('@/features/catalog/CatalogManagementView').then((m) => ({ default: m.CatalogManagementView })));
const TreasuryView = lazy(() =>
  import('@/features/finance/TreasuryView').then((m) => ({ default: m.TreasuryView })));
const ReceiptsDisbursementsView = lazy(() =>
  import('@/features/finance/ReceiptsDisbursementsView').then((m) => ({ default: m.ReceiptsDisbursementsView })));
const CustodyView = lazy(() =>
  import('@/features/finance/CustodyView').then((m) => ({ default: m.CustodyView })));
const SuppliersView = lazy(() =>
  import('@/features/finance/SuppliersView').then((m) => ({ default: m.SuppliersView })));
const PaymentsCollectionsView = lazy(() =>
  import('@/features/finance/PaymentsCollectionsView').then((m) => ({ default: m.PaymentsCollectionsView })));
const PayrollFinanceView = lazy(() =>
  import('@/features/finance/PayrollFinanceView').then((m) => ({ default: m.PayrollFinanceView })));
const FinancialReportsView = lazy(() =>
  import('@/features/finance/FinancialReportsView').then((m) => ({ default: m.FinancialReportsView })));
const MasterDataView = lazy(() =>
  import('@/features/master-data/MasterDataView').then((m) => ({ default: m.MasterDataView })));

import { TaskInboxView } from '@/features/inbox/TaskInboxView';
import { apiClient, ApiError } from '@/lib/api';
import { AuthProvider, useAuth } from '@/features/auth/AuthContext';
import { SignInModal } from '@/features/auth/SignInModal';
import { DialogProvider } from '@/components/feedback/DialogProvider';
import type { NavFocus } from '@/lib/navigation';

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

/**
 * القائمة الجانبية حسب الدور: كل موظف يرى أولاً ما يعمل عليه يومياً، وبأسماء عملية لا بأسماء الوحدات.
 * الإخفاء هنا لتسهيل الاستخدام فقط؛ التفويض الفعلي في الخادم وفي ROUTE_PERMISSIONS.
 */
const HOME_ITEM: NavEntry = { type: 'item', id: 'inbox', name: 'الرئيسية · مهامي', icon: '🏠' };

const GENERAL_NAV: NavEntry[] = [
  HOME_ITEM,
  { type: 'item', id: 'dashboard', name: 'لوحة التشغيل', icon: '📊', requiredPermission: 'reports:view' },
  // ترتيب القائمة يتبع دورة العمل في المصنع: شراء ← تخزين ← تشغيل ← بيع وتسليم ← مالية
  {
    type: 'group',
    id: 'procurement',
    name: 'المشتريات',
    icon: '🧾',
    children: [
      { id: 'finance-suppliers', name: 'فواتير الشراء والاستلام', requiredPermission: 'suppliers:view' },
    ],
  },
  {
    type: 'group',
    id: 'warehouses',
    name: 'المخازن',
    icon: '📦',
    children: [
      { id: 'warehouse-raw', name: 'مخزن الخامات', requiredPermission: 'inventory:view' },
      { id: 'warehouse-finished', name: 'مخزن المنتج التام', requiredPermission: 'inventory:view' },
      { id: 'warehouse-reports', name: 'أرصدة المخازن', requiredPermission: 'inventory:view' },
      { id: 'warehouse-stocktake', name: 'الجرد', requiredPermission: 'inventory:stocktake:view' },
    ],
  },
  { type: 'item', id: 'batches', name: 'أوامر التشغيل', icon: '🧵', requiredPermission: 'production:orders:view' },
  {
    type: 'group',
    id: 'deliveries',
    name: 'المبيعات والتسليم',
    icon: '🛍️',
    children: [
      { id: 'finance-customers', name: 'العملاء وطلبات البيع', requiredPermission: 'customers:view' },
      { id: 'orders', name: 'تسليم طلبات العملاء', requiredPermission: 'customers:deliveries:manage' },
    ],
  },
  {
    type: 'group',
    id: 'finance',
    name: 'المالية',
    icon: '💰',
    children: [
      { id: 'finance-treasury', name: 'الخزينة والاعتمادات', requiredPermission: 'finance:cash:view' },
      { id: 'finance-operations', name: 'سندات القبض والصرف', requiredPermission: 'finance:cash:view' },
      { id: 'finance-custody', name: 'العهد والمصروفات', requiredPermission: 'finance:cash:view' },
      { id: 'finance-payroll', name: 'الرواتب', requiredPermission: 'finance:payroll:view' },
      { id: 'finance-reports', name: 'التقارير', requiredPermission: 'finance:reports:view' },
    ],
  },
  {
    type: 'group',
    id: 'master-data-group',
    name: 'البيانات الأساسية',
    icon: '🗂️',
    children: [
      { id: 'master-data', name: 'الموردون والعملاء والموديلات' },
      { id: 'warehouse-catalog', name: 'دليل الخامات والأصناف', requiredPermission: 'catalog:view' },
    ],
  },
];

const WAREHOUSE_NAV: NavEntry[] = [
  { ...HOME_ITEM },
  { type: 'item', id: 'finance-suppliers', name: 'فواتير الشراء والاستلام', icon: '🧾', requiredPermission: 'suppliers:view' },
  { type: 'item', id: 'batches', name: 'صرف الخامات واستلام التام', icon: '🧵', requiredPermission: 'production:orders:view' },
  { type: 'item', id: 'orders', name: 'تسليم طلبات العملاء', icon: '🚚', requiredPermission: 'customers:deliveries:manage' },
  {
    type: 'group',
    id: 'warehouses',
    name: 'المخازن والجرد',
    icon: '📦',
    children: [
      { id: 'warehouse-raw', name: 'مخزن الخامات', requiredPermission: 'inventory:view' },
      { id: 'warehouse-finished', name: 'مخزن المنتج التام', requiredPermission: 'inventory:view' },
      { id: 'warehouse-reports', name: 'أرصدة المخازن', requiredPermission: 'inventory:view' },
      { id: 'warehouse-stocktake', name: 'الجرد', requiredPermission: 'inventory:stocktake:view' },
    ],
  },
  {
    type: 'group',
    id: 'master-data-group',
    name: 'البيانات الأساسية',
    icon: '🗂️',
    children: [
      { id: 'warehouse-catalog', name: 'دليل الخامات والأصناف', requiredPermission: 'catalog:view' },
      { id: 'master-data', name: 'الموردون والموديلات' },
    ],
  },
  { type: 'item', id: 'warehouse-guide', name: 'دليل الاستخدام', icon: '📖', requiredPermission: 'inventory:view' },
];

const PRODUCTION_NAV: NavEntry[] = [
  { ...HOME_ITEM },
  { type: 'item', id: 'batches', name: 'أوامر التشغيل', icon: '🧵', requiredPermission: 'production:orders:view' },
  { type: 'item', id: 'warehouse-raw', name: 'أرصدة الخامات', icon: '📦', requiredPermission: 'inventory:view' },
  { type: 'item', id: 'master-data', name: 'الموديلات والمقاسات', icon: '👕' },
  { type: 'item', id: 'warehouse-catalog', name: 'دليل الخامات والأصناف', icon: '📚', requiredPermission: 'catalog:view' },
  { type: 'item', id: 'dashboard', name: 'لوحة التشغيل', icon: '📊', requiredPermission: 'reports:view' },
];

const FINANCE_NAV: NavEntry[] = [
  { type: 'item', id: 'inbox', name: 'الرئيسية · مهامي واعتماداتي', icon: '🏠' },
  { type: 'item', id: 'finance-treasury', name: 'الخزينة والاعتمادات', icon: '🏦', requiredPermission: 'finance:cash:view' },
  { type: 'item', id: 'finance-customers', name: 'العملاء والطلبات والتحصيل', icon: '👥', requiredPermission: 'customers:view' },
  { type: 'item', id: 'finance-suppliers', name: 'مستحقات الموردين', icon: '🧾', requiredPermission: 'suppliers:view' },
  {
    type: 'group',
    id: 'finance',
    name: 'المصروفات والإيرادات',
    icon: '💳',
    children: [
      { id: 'finance-operations', name: 'سندات القبض والصرف', requiredPermission: 'finance:cash:view' },
      { id: 'finance-custody', name: 'العهد والمصروفات', requiredPermission: 'finance:cash:view' },
    ],
  },
  { type: 'item', id: 'finance-payroll', name: 'الرواتب', icon: '🧮', requiredPermission: 'finance:payroll:view' },
  { type: 'item', id: 'finance-reports', name: 'التقارير', icon: '📊', requiredPermission: 'finance:reports:view' },
  { type: 'item', id: 'master-data', name: 'البيانات الأساسية', icon: '🗂️' },
];

function navForRoles(roles: string[]): NavEntry[] {
  if (roles.includes('general_manager')) return GENERAL_NAV;
  if (roles.includes('finance_manager')) return FINANCE_NAV;
  if (roles.includes('warehouse_manager')) return WAREHOUSE_NAV;
  if (roles.includes('production_manager')) return PRODUCTION_NAV;
  return GENERAL_NAV;
}

const ROUTE_PERMISSIONS: Record<string, string[]> = {
  dashboard: ['reports:view'],
  batches: ['production:orders:view'],
  orders: ['customers:deliveries:manage'],
  'warehouse-raw': ['inventory:view'],
  'warehouse-machinery': ['inventory:view'],
  'warehouse-finished': ['inventory:view'],
  'warehouse-catalog': ['catalog:view'],
  catalog: ['catalog:view'],
  'warehouse-guide': ['inventory:view'],
  'warehouse-stocktake': ['inventory:stocktake:view'],
  'warehouse-reports': ['inventory:view'],
  'inventory-reports': ['inventory:view'],
  'finance-treasury': ['finance:cash:view'],
  finance: ['finance:cash:view'],
  'finance-operations': ['finance:cash:view'],
  'finance-revenues': ['finance:cash:view'],
  'finance-expenses': ['finance:cash:view'],
  'finance-custody': ['finance:cash:view'],
  'finance-customers': ['customers:view'],
  customers: ['customers:view'],
  'finance-suppliers': ['suppliers:view'],
  'finance-payments': ['finance:payments:manage'],
  'finance-payroll': ['finance:payroll:view'],
  payroll: ['finance:payroll:view'],
  'finance-reports': ['finance:reports:view', 'reports:view'],
  reports: ['finance:reports:view', 'reports:view'],
  'master-data': ['suppliers:view', 'customers:view', 'production:orders:view', 'finance:payroll:view'],
};

function getHeaderInfo(nav: string): { kicker: string; title: string } {
  switch (nav) {
    case 'inbox':
      return { kicker: 'مهامك اليوم حسب دورك', title: 'الرئيسية' };
    case 'batches':
      return { kicker: 'من صرف الخامات حتى استلام المنتج التام والإغلاق', title: 'أوامر التشغيل' };
    case 'orders':
      return { kicker: 'سلّم الكميات المتاحة من مخزن المنتج التام', title: 'تسليم طلبات العملاء' };
    case 'warehouse-guide':
      return { kicker: 'التشغيل والتدريب الميداني · دليل العمل المخزني المعتمد', title: 'دليل استخدام وتشغيل أمين المخازن' };
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
      return { kicker: 'كل اعتماد مالي يتم من هنا، ولا يعتمد أحد مستنداً أنشأه', title: 'الخزينة والاعتمادات' };
    case 'finance-operations':
      return { kicker: 'المالية · سندات القبض والصرف والتحويل الداخلي', title: 'سندات القبض والصرف' };
    case 'finance-revenues':
      return { kicker: 'المالية · التدفقات النقدية الداخلة', title: 'الإيرادات التشغيلية' };
    case 'finance-expenses':
      return { kicker: 'المالية · التدفقات النقدية الخارجة', title: 'المصروفات التشغيلية' };
    case 'finance-custody':
      return { kicker: 'المالية · الصناديق والمصروفات اليومية', title: 'العهد المالية المؤقتة' };
    case 'finance-customers':
    case 'customers':
      return { kicker: 'بيانات العملاء وطلبات البيع والتحصيل', title: 'العملاء وطلبات البيع' };
    case 'finance-suppliers':
      return { kicker: 'المشتريات · من الفاتورة إلى الاستلام والسداد', title: 'فواتير الشراء واستلام الخامات' };
    case 'finance-payments':
      return { kicker: 'المالية · متابعة حركة السيولة والسدادات', title: 'المدفوعات والتحصيلات' };
    case 'finance-payroll':
    case 'payroll':
      return { kicker: 'المالية · استحقاقات الأجور وصرف المرتبات', title: 'الرواتب والأجور المالية' };
    case 'finance-reports':
    case 'reports':
      return { kicker: 'المالية · التحليل المالي ومؤشرات الأداء', title: 'التقارير المالية ومؤشرات السيولة' };
    case 'master-data':
      return { kicker: 'البيانات الأساسية · تُضاف وتُعدل من هنا دون تدخل المطور', title: 'البيانات الأساسية' };
    case 'dashboard':
      return { kicker: 'متابعة تشغيل المصنع · مؤشرات القياس والرقابة التنفيذية', title: 'لوحة متابعة تشغيل المصنع' };
    default:
      return { kicker: 'متابعة تشغيل المصنع', title: 'لوحة متابعة تشغيل المصنع' };
  }
}

function AccessDeniedView({
  routeTitle,
  requiredPermissions,
  roleLabel,
  onReturnToInbox,
}: {
  routeTitle: string;
  requiredPermissions?: string[];
  roleLabel?: string;
  onReturnToInbox: () => void;
}) {
  return (
    <section className="warehouse-page" dir="rtl" aria-labelledby="forbidden-title">
      <header className="warehouse-page__header">
        <div>
          <span className="warehouse-page__eyebrow">الصلاحيات</span>
          <h2 id="forbidden-title">هذه الشاشة ليست ضمن صلاحيات حسابك</h2>
          <p>لا يمكنك فتح شاشة «{routeTitle}» بالدور الحالي.</p>
        </div>
      </header>
      <div
        className="warehouse-alert"
        role="alert"
        style={{
          backgroundColor: '#fff1f2',
          borderColor: '#fecdd3',
          color: '#9f1239',
          padding: '2.5rem 2rem',
          textAlign: 'center',
          borderRadius: '8px',
          margin: '1.5rem 0',
        }}
      >
        <div style={{ fontSize: '3rem', marginBottom: '0.75rem' }} aria-hidden>🔒</div>
        <h3 style={{ margin: '0 0 0.5rem', color: '#9f1239', fontSize: '1.25rem' }}>صلاحية الوصول غير كافية</h3>
        {roleLabel && (
          <p style={{ margin: '0 0 0.5rem', color: '#881337', fontSize: '0.95rem' }}>
            الدور الحالي المسجل: <strong>{roleLabel}</strong>
          </p>
        )}
        <p style={{ margin: '0 0 1.25rem', color: '#881337', fontSize: '0.9rem' }}>
          {requiredPermissions && requiredPermissions.length > 0
            ? 'إذا كان عملك يتطلب هذه الشاشة، اطلب من المدير العام إضافة الصلاحية لحسابك.'
            : 'تواصل مع المدير العام إذا كنت تحتاج هذه الشاشة.'}
        </p>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={onReturnToInbox}
          style={{ padding: '0.6rem 1.5rem', fontWeight: 600 }}
        >
          العودة إلى الرئيسية
        </button>
      </div>
    </section>
  );
}

/**
 * لوحة حالة الوصول: تُعرض بدلاً من الشاشات المحمية عندما لا يكون المستخدم مسجلاً،
 * أو أثناء تحميل الصلاحيات من الخادم، أو عند فشل تحميلها، أو عند خلو الحساب من أي صلاحية.
 */
function AccessStateNotice({
  icon,
  title,
  message,
  tone = 'info',
  actionLabel,
  onAction,
}: {
  icon: string;
  title: string;
  message: string;
  tone?: 'info' | 'error';
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <section className="warehouse-page" dir="rtl" aria-labelledby="access-state-title">
      <div
        className="warehouse-alert"
        role={tone === 'error' ? 'alert' : 'status'}
        style={{
          backgroundColor: tone === 'error' ? '#fff1f2' : '#f8fafc',
          borderColor: tone === 'error' ? '#fecdd3' : '#e2e8f0',
          color: tone === 'error' ? '#9f1239' : '#334155',
          padding: '2.25rem 2rem',
          textAlign: 'center',
          borderRadius: '8px',
          margin: '1.5rem 0',
          display: 'block',
        }}
      >
        <div style={{ fontSize: '2.5rem', marginBottom: '0.75rem' }} aria-hidden>{icon}</div>
        <h2 id="access-state-title" style={{ margin: '0 0 0.5rem', fontSize: '1.2rem' }}>{title}</h2>
        <p style={{ margin: '0 0 1rem', fontSize: '0.95rem', lineHeight: 1.6 }}>{message}</p>
        {actionLabel && onAction && (
          <button type="button" className="btn btn--secondary" onClick={onAction} style={{ padding: '0.6rem 1.5rem', fontWeight: 600 }}>
            {actionLabel}
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * شاشة انتظار عربية بسيطة تُعرض أثناء تحميل أي شاشة مُقيَّلة (lazy) لأول مرة.
 */
function ScreenLoader() {
  return (
    <div className="screen-loader" dir="rtl" role="status" aria-live="polite">
      <span className="screen-loader__spinner" aria-hidden />
      <p className="screen-loader__text">جاري تحميل الشاشة…</p>
    </div>
  );
}

function AppContent() {
  const [activeNav, setActiveNavState] = useState('inbox');
  const [navFocus, setNavFocus] = useState<NavFocus | undefined>(undefined);
  const setActiveNav = useCallback((navId: string, focus?: NavFocus) => {
    setActiveNavState(navId);
    setNavFocus(focus);
  }, []);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    warehouses: true,
    procurement: true,
    deliveries: true,
    finance: true,
    'master-data-group': true,
  });
  const [serverState, setServerState] = useState<ServerConnectionState>({
    status: 'loading',
  });

  const {
    authState,
    authMode,
    user,
    isConfigured,
    isDevAuthAvailable,
    hasPermission,
    roles,
    permissions,
    permissionsStatus,
    permissionsError,
    retryVerification,
  } = useAuth();

  // الصلاحيات الخادمية جاهزة وغير فارغة: الشرط الوحيد لعرض أي شاشة محمية
  const isAuthorizedSession = authState === 'authenticated' && user !== null && permissionsStatus === 'ready';
  const hasAnyPermission = isAuthorizedSession && permissions.length > 0;

  // تخصيص شكل القائمة فقط بحسب الدور الخادمي؛ التفويض الفعلي يتم بالصلاحيات
  const sidebarItems: NavEntry[] = useMemo(() => navForRoles(roles), [roles]);

  const roleArabicNames: Record<string, string> = {
    general_manager: 'المدير العام',
    warehouse_manager: 'أمين المخزن',
    production_manager: 'مسؤول الإنتاج',
    finance_manager: 'المدير المالي',
  };
  const activeRoleLabel = roles[0] ? (roleArabicNames[roles[0]] || roles[0]) : '';

  // حارس المسارات: لا وصول لأي شاشة محمية دون صلاحية خادمية صريحة (Deny-by-default)
  const canAccessRoute = useCallback(
    (routeId: string): boolean => {
      if (routeId === 'inbox') return true;
      const perms = ROUTE_PERMISSIONS[routeId];
      if (!perms || perms.length === 0) return hasAnyPermission;
      return perms.some((p) => hasPermission(p));
    },
    [hasAnyPermission, hasPermission]
  );

  const isNavPermitted = useCallback(
    (requiredPermission?: string): boolean =>
      requiredPermission ? hasPermission(requiredPermission) : true,
    [hasPermission]
  );

  useEffect(() => {
    if (isAuthorizedSession && !canAccessRoute(activeNav)) {
      setActiveNav('inbox');
    }
  }, [isAuthorizedSession, activeNav, canAccessRoute, setActiveNav]);

  // إنشاء أمر تشغيل يتطلب production:orders:manage في الخادم
  const canCreateBatch = hasPermission('production:orders:create');

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
            {sidebarItems.map((entry) => {
              if (entry.type === 'item') {
                if (!isNavPermitted(entry.requiredPermission)) return null;
                if (entry.id !== 'inbox' && !canAccessRoute(entry.id)) return null;

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
              if (entry.requiredPermission && !isNavPermitted(entry.requiredPermission)) return null;
              const visibleChildren = entry.children.filter((sub) => isNavPermitted(sub.requiredPermission) && canAccessRoute(sub.id));

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
              {user?.email ? user.email.charAt(0).toUpperCase() : authMode === 'local_dev' ? '⚙️' : '؟'}
            </div>
            <div className="sidebar__user-details">
              <span className="sidebar__user-name">
                {user
                  ? (activeRoleLabel ? `${activeRoleLabel}` : user.email || 'مستخدم موثق')
                  : 'حساب تجريبي (غير مسجل)'}
              </span>
              <span className="sidebar__user-role">
                {user
                  ? (user.email ? `${user.email}` : 'مستخدم موثق')
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
            {/* مؤشر حالة اتصال الخادم: يظهر فقط عند وجود مشكلة */}
            {serverState.status === 'error' && (
              <div className="server-status server-status--error" role="status" aria-live="polite" title={serverState.message}>
                <span className="server-status__pulse" aria-hidden />
                <span className="server-status__label">الخادم غير متصل</span>
                <button
                  type="button"
                  className="server-status__retry"
                  onClick={() => void checkServerHealth()}
                  title="إعادة فحص الاتصال بالخادم"
                  aria-label="إعادة فحص الاتصال بالخادم"
                >
                  ↻
                </button>
              </div>
            )}

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
                  ? `مستخدم موثق (${user.email || user.id})${activeRoleLabel ? ` — الدور: ${activeRoleLabel}` : ''}`
                  : authState === 'unverified'
                  ? 'جلسة غير مؤكدة خادمياً'
                  : 'تسجيل الدخول للنظام'
              }
            >
              <span aria-hidden>{user ? '✓' : authState === 'unverified' ? '⚠️' : '🔒'}</span>
              <span>
                {user
                  ? `${activeRoleLabel ? `${activeRoleLabel} · ` : ''}${user.email || 'مستخدم موثق'}`
                  : authState === 'unverified'
                  ? 'جلسة غير مؤكدة'
                  : 'تسجيل الدخول'}
              </span>
            </button>

            {/* الزر الرئيسي التيل (Teal Action Button) - محمي بصلاحية إنشاء أوامر التشغيل */}
            {canCreateBatch && (
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
                <span>أمر تشغيل جديد</span>
              </button>
            )}
          </div>
        </header>

        {/* مساحة لوحة التشغيل الفسيحة (Spacious Dashboard Area) */}
        <main className="dashboard-canvas">
          {/* نسخة العرض: تمييز واضح للبيانات التجريبية عن بيانات المصنع الفعلية */}
          {authMode === 'local_dev' && (
            <div className="demo-strip" role="status">
              <span className="demo-strip__icon" aria-hidden>🧪</span>
              <span className="demo-strip__text">
                نسخة العرض التجريبي — البيانات المعروضة تجريبية (أكوادها تبدأ بـ DEMO وأسماؤها تنتهي بـ «تجريبي») ولا تمثل حسابات المصنع الفعلية.
                {activeRoleLabel ? ` أنت تعمل الآن بصفة: ${activeRoleLabel}.` : ''}
              </span>
            </div>
          )}

          {/* شريط تنبيه تعذر الاتصال بالخادم الخلفي */}
          {serverState.status === 'error' && (
            <div className="api-error-strip" role="alert">
              <div className="api-error-strip__content">
                <span className="api-error-strip__icon" aria-hidden>⚠️</span>
                <div className="api-error-strip__body">
                  <strong>تعذر الاتصال بخادم النظام.</strong> لن تُحفظ أي عملية حتى يعود الاتصال.
                  <span className="api-error-strip__hint">
                    تأكد من تشغيل الخادم ثم اضغط «إعادة المحاولة». إن استمرت المشكلة أبلغ مسؤول النظام.
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

          {/* محتوى الشاشة المحدد بحسب المسار ومحمي بـ Route Guard (الشاشات المُقيَّلة تُحمَّل عند الطلب) */}
          <Suspense fallback={<ScreenLoader />}>
            {!user ? (
            authState === 'loading' ? (
              <AccessStateNotice icon="⏳" title="جاري التحقق من الجلسة" message="يتم التحقق من هوية المستخدم وصلاحياته مع خادم المصنع..." />
            ) : (
              <AccessStateNotice
                icon="🔒"
                title={authState === 'unverified' ? 'تعذر تأكيد الجلسة مع الخادم' : 'سجّل الدخول لعرض شاشات المصنع'}
                message={
                  authState === 'unverified'
                    ? 'توجد جلسة دخول لكن الخادم لم يؤكدها، لذلك لا تُعرض أي شاشة محمية. أعد محاولة التحقق أو سجّل الخروج.'
                    : 'لا تُعرض المهام أو بيانات المخازن والإنتاج والمالية قبل تسجيل الدخول والتحقق من صلاحياتك.'
                }
                tone={authState === 'unverified' ? 'error' : 'info'}
                actionLabel={authState === 'unverified' ? 'إدارة الجلسة' : 'تسجيل الدخول'}
                onAction={() => setAuthModalOpen(true)}
              />
            )
          ) : permissionsStatus === 'loading' || permissionsStatus === 'idle' ? (
            <AccessStateNotice icon="⏳" title="جاري تحميل الصلاحيات" message="يتم تحميل صلاحيات حسابك من الخادم. لن تظهر أي شاشة محمية قبل اكتمال التحميل." />
          ) : permissionsStatus === 'error' ? (
            <AccessStateNotice
              icon="⚠️"
              title="تعذر تحميل صلاحيات الحساب"
              message={permissionsError || 'تعذر تحميل الصلاحيات من الخادم. لا تُعرض الشاشات المحمية حتى يتم التحميل بنجاح.'}
              tone="error"
              actionLabel="إعادة المحاولة"
              onAction={() => void retryVerification()}
            />
          ) : !hasAnyPermission ? (
            <AccessStateNotice
              icon="🚫"
              title="لا توجد صلاحيات مسندة لحسابك"
              message="تم تسجيل دخولك بنجاح، لكن حسابك لا يملك أي صلاحية في النظام حالياً. تواصل مع المدير العام لإسناد الدور المناسب."
            />
          ) : !canAccessRoute(activeNav) ? (
            <AccessDeniedView
              routeTitle={headerInfo.title}
              requiredPermissions={ROUTE_PERMISSIONS[activeNav]}
              roleLabel={activeRoleLabel}
              onReturnToInbox={() => setActiveNav('inbox')}
            />
          ) : activeNav === 'inbox' ? (
            <TaskInboxView onNavigate={setActiveNav} />
          ) : activeNav === 'master-data' ? (
            <MasterDataView onNavigate={(id) => setActiveNav(id)} />
          ) : activeNav === 'batches' ? (
            <ProductionOrdersView focus={navFocus} onFocusHandled={() => setNavFocus(undefined)} />
          ) : activeNav === 'orders' ? (
            <CustomerDeliveriesView />
          ) : activeNav === 'warehouse-guide' ? (
            <WarehouseGuideView />
          ) : activeNav === 'warehouse-catalog' || activeNav === 'catalog' ? (
            <CatalogManagementView />
          ) : activeNav === 'warehouse-raw' || activeNav === 'inventory' ? (
            <MainWarehouseView />
          ) : activeNav === 'warehouse-machinery' ? (
            <MachineryView />
          ) : activeNav === 'warehouse-finished' ? (
            <FinishedGoodsView />
          ) : activeNav === 'warehouse-stocktake' ? (
            <StocktakeView />
          ) : activeNav === 'warehouse-reports' || activeNav === 'inventory-reports' ? (
            <FinancialReportsView initialTab="inventory" />
          ) : activeNav === 'finance-treasury' || activeNav === 'finance' ? (
            <TreasuryView />
          ) : activeNav === 'finance-operations' || activeNav === 'finance-revenues' || activeNav === 'finance-expenses' ? (
            <ReceiptsDisbursementsView />
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
            <FinancialReportsView initialTab="summary" />
          ) : activeNav === 'dashboard' ? (
            <OperationsBoard />
          ) : (
            <TaskInboxView onNavigate={setActiveNav} />
          )}
          </Suspense>
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
      <DialogProvider>
        <AppContent />
      </DialogProvider>
    </AuthProvider>
  );
}
