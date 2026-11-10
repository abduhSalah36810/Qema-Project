import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { userLabel } from '@/lib/userLabel';
import { useAuth } from '@/features/auth/AuthContext';
import { fetchInboxTasks, type TaskItem, type TaskSection, type TaskSourceError } from './taskInboxApi';
import { financeApi } from '@/features/finance/financeApi';
import { useDialog } from '@/components/feedback/DialogProvider';
import { ApiError } from '@/lib/api';
import type { NavigateFn } from '@/lib/navigation';

/**
 * الصفحة الرئيسية لكل دور: ثلاثة أسئلة فقط
 * 1) ما المطلوب مني الآن؟  2) ما الذي أرسلته وينتظر غيري؟  3) ما الذي عاد إليّ أو يحتاج انتباهي؟
 * المهام تأتي من صندوق المهام الموحد (taskInboxApi) وتُعرض فقط إن كانت ضمن صلاحيات المستخدم.
 */
interface TaskInboxViewProps {
  onNavigate: NavigateFn;
}

interface Shortcut {
  navId: string;
  label: string;
  icon: string;
  permission?: string;
}

const ROLE_HOME: Record<string, { title: string; focus: string; shortcuts: Shortcut[] }> = {
  general_manager: {
    title: 'المدير العام',
    focus: 'متابعة التشغيل كاملاً، والاعتمادات التي تنتظر قرارك.',
    shortcuts: [
      { navId: 'dashboard', label: 'لوحة التشغيل', icon: '📊', permission: 'reports:view' },
      { navId: 'batches', label: 'أوامر التشغيل', icon: '🧵', permission: 'production:orders:view' },
      { navId: 'finance-treasury', label: 'الخزينة والاعتمادات', icon: '🏦', permission: 'finance:cash:view' },
      { navId: 'finance-customers', label: 'العملاء والطلبات', icon: '👥', permission: 'customers:view' },
    ],
  },
  warehouse_manager: {
    title: 'أمين المخزن',
    focus: 'الاستلام والصرف والتسليم والجرد.',
    shortcuts: [
      { navId: 'finance-suppliers', label: 'فواتير الشراء والاستلام', icon: '🧾', permission: 'suppliers:view' },
      { navId: 'batches', label: 'صرف الخامات واستلام التام', icon: '🧵', permission: 'production:orders:view' },
      { navId: 'orders', label: 'تسليم طلبات العملاء', icon: '🚚', permission: 'customers:deliveries:manage' },
      { navId: 'warehouse-stocktake', label: 'الجرد', icon: '📋', permission: 'inventory:stocktake:view' },
    ],
  },
  production_manager: {
    title: 'مسؤول الإنتاج',
    focus: 'استلام الخامات بالورشة، المراحل، العيوب، المرتجعات، وإغلاق الأوامر.',
    shortcuts: [
      { navId: 'batches', label: 'أوامر التشغيل', icon: '🧵', permission: 'production:orders:view' },
      { navId: 'warehouse-raw', label: 'أرصدة الخامات', icon: '📦', permission: 'inventory:view' },
      { navId: 'master-data', label: 'الموديلات والمقاسات', icon: '👕', permission: 'production:templates:manage' },
    ],
  },
  finance_manager: {
    title: 'المدير المالي',
    focus: 'الاعتمادات، التحصيل، سداد الموردين، المصروفات والرواتب.',
    shortcuts: [
      { navId: 'finance-treasury', label: 'الخزينة والاعتمادات', icon: '🏦', permission: 'finance:cash:view' },
      { navId: 'finance-customers', label: 'العملاء والتحصيل', icon: '👥', permission: 'customers:view' },
      { navId: 'finance-suppliers', label: 'مستحقات الموردين', icon: '🧾', permission: 'suppliers:view' },
      { navId: 'finance-payroll', label: 'الرواتب', icon: '🧮', permission: 'finance:payroll:view' },
    ],
  },
};

const SECTIONS: Array<{ id: TaskSection; title: string; hint: string; empty: string }> = [
  {
    id: 'action',
    title: 'مطلوب منك الآن',
    hint: 'مهام تستطيع تنفيذها بصلاحياتك الحالية.',
    empty: 'لا توجد مهام تنتظرك الآن.',
  },
  {
    id: 'attention',
    title: 'يحتاج انتباهك',
    hint: 'مستندات عادت إليك مرفوضة أو تحتاج مراجعة.',
    empty: 'لا يوجد ما عاد إليك أو يحتاج متابعة.',
  },
  {
    id: 'waiting',
    title: 'بانتظار الآخرين',
    hint: 'عمليات أرسلتها وتنتظر الخطوة التالية من شخص آخر. لا يلزمك إجراء.',
    empty: 'لا توجد عمليات أرسلتها بانتظار غيرك.',
  },
];

const CATEGORY_LABELS: Record<TaskItem['category'], string> = {
  warehouse: 'مخازن',
  production: 'إنتاج',
  finance: 'مالية',
  governance: 'اعتمادات',
};

function formatDate(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' });
}

export const TaskInboxView: React.FC<TaskInboxViewProps> = ({ onNavigate }) => {
  const { roles, permissions, hasPermission, user } = useAuth();
  const dialog = useDialog();
  const userId = user?.id;
  const activeRole = roles[0] || '';
  const canApproveCash = hasPermission('finance:cash:approve');
  const home = ROLE_HOME[activeRole];

  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [sourceErrors, setSourceErrors] = useState<TaskSourceError[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [isDeciding, setIsDeciding] = useState<boolean>(false);
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);

  const loadTasks = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await fetchInboxTasks(permissions, userId);
      setTasks(result.tasks);
      setSourceErrors(result.errors);
      setLastLoadedAt(new Date());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'تعذر تحميل المهام.');
    } finally {
      setIsLoading(false);
    }
  }, [permissions, userId]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  // قرار الاعتماد/الرفض عبر الحوارات الموحدة (DialogProvider): Esc + focus trap + استعادة التركيز
  const handleDecision = async (task: TaskItem, decision: 'approve' | 'reject') => {
    if (!task.directEntityId || isDeciding) return;
    const summary = [
      { label: 'المستند', value: <code>{task.referenceDoc}</code> },
      { label: 'البيان', value: task.title },
      ...(task.amount !== undefined && task.amount > 0
        ? [{ label: 'المبلغ', value: `${task.amount.toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م` }]
        : []),
      {
        label: 'ما سيحدث',
        value:
          decision === 'approve'
            ? 'يُسجَّل الأثر في الخزينة فوراً. يرفض النظام الاعتماد إن كان الرصيد غير كافٍ أو كنت منشئ المستند.'
            : 'يُرفض المستند دون أي أثر مالي ويعود لمنشئه مع السبب.',
      },
    ];
    let confirmed: boolean | string | null = false;
    if (decision === 'approve') {
      confirmed = await dialog.confirm({
        title: 'اعتماد المستند المالي',
        summary,
        confirmLabel: 'تأكيد الاعتماد',
        tone: 'success',
      });
    } else {
      confirmed = await dialog.prompt({
        title: 'رفض المستند المالي',
        summary,
        label: 'سبب الرفض',
        placeholder: 'مثال: المبلغ لا يطابق الفاتورة',
        required: true,
        multiline: true,
        confirmLabel: 'تأكيد الرفض',
        tone: 'danger',
      });
    }
    if (!confirmed) return;
    setIsDeciding(true);
    setSuccessBanner(null);
    try {
      await financeApi.decideDocument(
        task.directEntityId,
        decision,
        typeof confirmed === 'string' ? confirmed.trim() || undefined : undefined
      );
      setSuccessBanner(
        decision === 'approve'
          ? `تم اعتماد المستند ${task.referenceDoc} وسُجّل أثره في الخزينة.`
          : `تم رفض المستند ${task.referenceDoc}، وعاد لمنشئه مع السبب. لم يتغير أي رصيد.`
      );
      await loadTasks();
    } catch (err: unknown) {
      await dialog.notify({
        title: 'تعذر تنفيذ القرار على المستند',
        message: err instanceof ApiError || err instanceof Error ? err.message : 'تعذر تنفيذ القرار على المستند.',
        tone: 'danger',
      });
    } finally {
      setIsDeciding(false);
    }
  };

  const filteredTasks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter((t) =>
      [t.title, t.description, t.referenceDoc, t.currentStatus].some((v) => v.toLowerCase().includes(q))
    );
  }, [tasks, searchQuery]);

  const bySection = useMemo(() => {
    const groups: Record<TaskSection, TaskItem[]> = { action: [], waiting: [], attention: [] };
    for (const t of filteredTasks) groups[t.section ?? 'action'].push(t);
    return groups;
  }, [filteredTasks]);

  const shortcuts = (home?.shortcuts ?? []).filter((s) => !s.permission || hasPermission(s.permission));

  return (
    <div className="task-inbox home" dir="rtl">
      <header className="home__header">
        <div>
          <p className="home__eyebrow">الصفحة الرئيسية{home ? ` · ${home.title}` : ''}</p>
          <h1 className="home__title">ما المطلوب منك اليوم؟</h1>
          {home && <p className="home__subtitle">{home.focus}</p>}
        </div>
        <div className="home__header-actions">
          {lastLoadedAt && !isLoading && (
            <span className="home__updated">آخر تحديث {lastLoadedAt.toLocaleTimeString('ar-EG', { hour: 'numeric', minute: '2-digit' })}</span>
          )}
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => void loadTasks()} disabled={isLoading}>
            {isLoading ? 'جاري التحديث…' : 'تحديث'}
          </button>
        </div>
      </header>

      {shortcuts.length > 0 && (
        <nav className="home__shortcuts" aria-label="اختصارات عملك">
          {shortcuts.map((s) => (
            <button key={s.navId} type="button" className="home__shortcut" aria-label={`اختصار: ${s.label}`} onClick={() => onNavigate(s.navId)}>
              <span aria-hidden>{s.icon}</span>
              <span>{s.label}</span>
            </button>
          ))}
        </nav>
      )}

      {successBanner && (
        <div className="notice notice--success" role="status">
          <span>{successBanner}</span>
          <button type="button" className="notice__close" onClick={() => setSuccessBanner(null)} aria-label="إخفاء الرسالة">✕</button>
        </div>
      )}

      {error && (
        <div className="notice notice--error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => void loadTasks()}>إعادة المحاولة</button>
        </div>
      )}

      {!isLoading && sourceErrors.length > 0 && (
        <div className="notice notice--warning" role="alert">
          <div>
            <strong>تعذر تحميل جزء من المهام؛ قد تكون القائمة ناقصة.</strong>
            <ul>
              {sourceErrors.map((e) => <li key={e.source}>{e.source}: {e.message}</li>)}
            </ul>
          </div>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => void loadTasks()}>إعادة المحاولة</button>
        </div>
      )}

      <div className="home__summary" role="list" aria-label="ملخص المهام">
        {SECTIONS.map((section) => (
          <a key={section.id} role="listitem" href={`#home-${section.id}`} className={`home__summary-item home__summary-item--${section.id}`}>
            <strong>{isLoading ? '…' : bySection[section.id].length}</strong>
            <span>{section.title}</span>
          </a>
        ))}
        {tasks.length > 6 && (
          <input
            type="search"
            className="search-input home__search"
            placeholder="ابحث برقم المستند أو الوصف…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="بحث في المهام"
          />
        )}
      </div>

      {isLoading ? (
        <div className="inbox-loading" role="status">
          <div className="spinner" aria-hidden />
          <p>جاري تجميع مهامك…</p>
        </div>
      ) : (
        SECTIONS.map((section) => {
          const items = bySection[section.id];
          if (section.id !== 'action' && items.length === 0) return null;
          return (
            <section key={section.id} id={`home-${section.id}`} className={`home__section home__section--${section.id}`} aria-labelledby={`home-${section.id}-title`}>
              <div className="home__section-head">
                <h2 id={`home-${section.id}-title`}>{section.title} <span className="home__count">{items.length}</span></h2>
                <p>{section.hint}</p>
              </div>
              {items.length === 0 ? (
                <p className="home__empty">
                  {searchQuery ? 'لا توجد مهام تطابق البحث.' : sourceErrors.length > 0 ? 'لا تظهر مهام هنا، لكن بعض المصادر لم تُحمّل (انظر التنبيه أعلاه).' : section.empty}
                </p>
              ) : (
                <ul className="task-list">
                  {items.map((task) => (
                    <li key={task.id} className={`task-row task-row--${task.section}${task.priority === 'high' && task.section === 'action' ? ' task-row--urgent' : ''}`}>
                      <div className="task-row__main">
                        <div className="task-row__meta">
                          <span className="chip">{CATEGORY_LABELS[task.category]}</span>
                          <code className="task-row__ref">{task.referenceDoc}</code>
                          <span className={`status-badge status-badge--${task.section === 'attention' ? 'rejected' : task.section === 'waiting' ? 'waiting' : 'action'}`}>
                            {task.currentStatus}
                          </span>
                          {task.priority === 'high' && task.section === 'action' && <span className="status-badge status-badge--urgent">عاجل</span>}
                        </div>
                        <h3 className="task-row__title">{task.title}</h3>
                        <p className="task-row__desc">{task.description}</p>
                        {task.rejectionReason && (
                          <p className="task-row__reason"><strong>سبب الرفض:</strong> {task.rejectionReason}</p>
                        )}
                        <dl className="task-row__facts">
                          <div>
                            <dt>الخطوة التالية عند</dt>
                            <dd>{task.nextRole || '—'}</dd>
                          </div>
                          {task.section === 'waiting' && task.waitingReason && (
                            <div>
                              <dt>لماذا ينتظر</dt>
                              <dd>{task.waitingReason}</dd>
                            </div>
                          )}
                          {task.amount !== undefined && task.amount > 0 && (
                            <div>
                              <dt>المبلغ</dt>
                              <dd>{task.amount.toLocaleString('ar-EG', { minimumFractionDigits: 2 })} ج.م</dd>
                            </div>
                          )}
                          {task.requester && (
                            <div>
                              <dt>{task.canDirectApprove ? 'مقدم الطلب' : 'الجهة'}</dt>
                              <dd>{task.canDirectApprove ? userLabel(task.requester, userId) : task.requester}</dd>
                            </div>
                          )}
                          {formatDate(task.createdAt) && (
                            <div>
                              <dt>التاريخ</dt>
                              <dd>{formatDate(task.createdAt)}</dd>
                            </div>
                          )}
                        </dl>
                      </div>
                      <div className="task-row__actions">
                        {task.canDirectApprove && canApproveCash && task.section === 'action' && (
                          <>
                            <button type="button" className="btn btn--success btn--sm" disabled={isDeciding} onClick={() => void handleDecision(task, 'approve')}>اعتماد</button>
                            <button type="button" className="btn btn--danger-outline btn--sm" disabled={isDeciding} onClick={() => void handleDecision(task, 'reject')}>رفض</button>
                          </>
                        )}
                        <button
                          type="button"
                          className={`btn btn--sm ${task.section === 'action' && !task.canDirectApprove ? 'btn--primary' : 'btn--secondary'}`}
                          onClick={() => onNavigate(task.actionNavId, task.focus)}
                        >
                          {task.actionLabel}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })
      )}
    </div>
  );
};
