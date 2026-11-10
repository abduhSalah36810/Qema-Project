/**
 * تهيئة عميل Supabase للمتصفح (Frontend Supabase Client)
 * ─────────────────────────────────────────────────────────────────────────────
 * يقرأ حصراً المتغيرات العامة المسبوقة بـ VITE_ المخصصة للمتصفح:
 * - VITE_SUPABASE_URL: عنوان مشروع Supabase
 * - VITE_SUPABASE_ANON_KEY: المفتاح العام المجهول (Anon / Publishable Key)
 *
 * تحذير أمني صارم:
 * - يُمنع نهائياً وضع أي مفاتيح سرية (Service Role Key, JWT Secret, DATABASE_URL) هنا.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

/**
 * التحقق مما إذا كانت إعدادات Supabase العامة محددة في ملف البيئة
 */
export function isSupabaseConfigured(): boolean {
  return Boolean(
    supabaseUrl &&
    supabaseUrl.length > 0 &&
    !supabaseUrl.includes('<project-ref>') &&
    supabaseAnonKey &&
    supabaseAnonKey.length > 0 &&
    !supabaseAnonKey.includes('<anon-key')
  );
}

/**
 * إنشاء نسخة عميل Supabase إذا كانت الإعدادات متوفرة
 */
export const supabase: SupabaseClient | null = isSupabaseConfigured()
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;
