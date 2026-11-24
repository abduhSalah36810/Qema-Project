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

const DEFAULT_SUPABASE_URL = 'https://kreuvfphivdwpijqbxlt.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtyZXV2ZnBoaXZkd3BpanFieGx0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTU0NzUzOTQsImV4cCI6MjExMTA1MTM5NH0.Cgysc5BgEqwDWCVc3Ej5uSsHuot8WmuqgEQCSRC-Zwk';

const envUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const envKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

const supabaseUrl = envUrl || (import.meta.env.PROD ? DEFAULT_SUPABASE_URL : '');
const supabaseAnonKey = envKey || (import.meta.env.PROD ? DEFAULT_SUPABASE_ANON_KEY : '');

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
