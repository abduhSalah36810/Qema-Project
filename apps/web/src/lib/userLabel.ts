/**
 * تحويل معرّف المستخدم المخزن في المستندات إلى اسم مفهوم للموظف، من البيانات المتاحة فقط:
 * - المستخدم الحالي يظهر «أنت».
 * - حسابات الدخول المحلي (نسخة العرض) لها معرّفات ثابتة لكل دور فتُعرض باسم الدور.
 * - البريد الإلكتروني يُعرض بالجزء الذي قبل @ فقط.
 * - المعرّفات الداخلية الأخرى تُختصر إلى رمز قصير بدل عرض المعرّف الطويل.
 * لا تُخترع أسماء: ما لا يتوفر اسمه يظهر «مستخدم» مع رمز مختصر يكفي للتمييز.
 * النصوص التي ليست معرّفات (مثل اسم مورد أو اسم موظف مكتوب) تُعرض كما هي.
 */
const LOCAL_DEMO_USERS: Record<string, string> = {
  'dev-user-00000000-0000-0000-0000-000000000001': 'المدير العام',
  'dev-user-00000000-0000-0000-0000-000000000002': 'أمين المخزن',
  'dev-user-00000000-0000-0000-0000-000000000003': 'المدير المالي',
  'dev-user-00000000-0000-0000-0000-000000000004': 'مسؤول الإنتاج',
};

const LOCAL_DEMO_EMAILS: Record<string, string> = {
  'gm@qemma.local': 'المدير العام',
  'wh@qemma.local': 'أمين المخزن',
  'fin@qemma.local': 'المدير المالي',
  'prod@qemma.local': 'مسؤول الإنتاج',
};

const IDENTIFIER_LIKE = /^[A-Za-z0-9_.:@-]+$/;
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+$/;

/** رمز قصير ثابت مشتق من المعرّف كاملاً (FNV-1a)، حتى لا يتشابه رمز مستخدمَين يشتركان في نهاية المعرّف */
function shortCode(id: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).toUpperCase().padStart(4, '0').slice(-4);
}

export function userLabel(id: string | null | undefined, currentUserId?: string | null): string {
  if (!id) return '—';
  const value = id.trim();
  if (currentUserId && value === currentUserId) return 'أنت';
  if (LOCAL_DEMO_USERS[value]) return LOCAL_DEMO_USERS[value];
  if (LOCAL_DEMO_EMAILS[value.toLowerCase()]) return LOCAL_DEMO_EMAILS[value.toLowerCase()];
  if (value.startsWith('system')) return 'النظام';
  // نص مقروء (يحتوي مسافات أو حروفاً عربية): اسم مكتوب وليس معرّفاً
  if (!IDENTIFIER_LIKE.test(value)) return value;
  if (EMAIL_LIKE.test(value)) return value.split('@')[0];
  // معرّف قصير مقروء (مثل fin_user) يبقى كما هو؛ الطويل يختصر لرمز
  if (value.length <= 10) return value;
  return `مستخدم ${shortCode(value)}`;
}
