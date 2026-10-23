/**
 * سياق المصادقة وإدارة الجلسات (Authentication Context)
 * ─────────────────────────────────────────────────────────────────────────────
 * يربط بين:
 * 1. عميل Supabase Auth لإدارة تسجيل الدخول والجلسات في المتصفح.
 * 2. خادم FastAPI والتحقق من الهوية الأدنى عبر مسار GET /api/v1/auth/me.
 * 3. تزويد عميل API بتوكن الوصول (Bearer Token) بنطاق محمي لخادم المصنع حصراً.
 * 4. التعامل الصارم مع انتهاء الصلاحية، إلغاء الجلسات، فشل التجديد، وتعطل الخادم.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from '@/lib/supabase';
import { apiClient, type UserIdentity, ApiError } from '@/lib/api';

export type AuthState =
  | 'config_missing' // غياب متغيرات VITE_SUPABASE_* في البيئة
  | 'loading'        // جاري استعادة الجلسة أو التحقق من الخادم
  | 'signed_out'     // مهيأ لكن لا توجد جلسة نشطة
  | 'authenticated'  // مصادق عليه ومطابق بنجاح عبر الخادم الخلفي
  | 'unverified';    // توجد جلسة لكن تعذر التحقق منها أو رفضها الخادم الخلفي

interface AuthContextValue {
  authState: AuthState;
  user: UserIdentity | null;
  session: Session | null;
  error: string | null;
  isConfigured: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  retryVerification: () => Promise<void>;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>(
    isSupabaseConfigured() ? 'loading' : 'config_missing'
  );
  const [user, setUser] = useState<UserIdentity | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  // مرجع لتفادي تكرار طلبات المزامنة المتزامنة
  const isSyncingRef = useRef(false);

  const clearError = useCallback(() => setError(null), []);

  /**
   * مطابقة جلسة Supabase مع الخادم الخلفي عبر GET /api/v1/auth/me
   */
  const syncWithBackend = useCallback(async (activeSession: Session | null) => {
    if (!activeSession || !activeSession.access_token) {
      apiClient.setAccessToken(null);
      setUser(null);
      setSession(null);
      setAuthState('signed_out');
      return;
    }

    // التحقق من تاريخ انتهاء صلاحية الجلسة محلياً
    const nowSec = Math.floor(Date.now() / 1000);
    if (activeSession.expires_at && activeSession.expires_at <= nowSec) {
      apiClient.setAccessToken(null);
      setUser(null);
      setSession(null);
      setAuthState('signed_out');
      setError('انتهت صلاحية جلسة الدخول. يرجى تسجيل الدخول مجدداً.');
      return;
    }

    if (isSyncingRef.current) return;
    isSyncingRef.current = true;

    try {
      apiClient.setAccessToken(activeSession.access_token);
      const identity = await apiClient.getAuthMe({ token: activeSession.access_token });
      setUser(identity);
      setSession(activeSession);
      setAuthState('authenticated');
      setError(null);
    } catch (err: unknown) {
      // إخلاء التوكن المعتمد وعدم إبقاء الواجهة في حالة توثيق زائف
      apiClient.setAccessToken(null);
      setUser(null);
      setSession(activeSession);
      setAuthState('unverified');

      let errorMsg = 'تعذر التحقق من هوية المستخدم مع الخادم الخلفي.';
      if (err instanceof ApiError) {
        if (err.status === 401) {
          errorMsg = 'رفض خادم الـ API توكن الدخول (غير صالح أو منتهي الصلاحية).';
        } else if (err.isNetworkError || err.isTimeout) {
          errorMsg = 'تعذر الاتصال بخادم الـ API للتحقق من هوية المستخدم.';
        }
      }
      setError(errorMsg);
    } finally {
      isSyncingRef.current = false;
    }
  }, []);

  // استعادة الجلسة الأولية والاستماع لتغيرات حالة المصادقة
  useEffect(() => {
    if (!isSupabaseConfigured() || !supabase) {
      setAuthState('config_missing');
      return;
    }

    let isMounted = true;

    // فحص الجلسة المحفوظة أولياً
    void supabase.auth.getSession().then(({ data: { session: initialSession }, error: sessionError }) => {
      if (!isMounted) return;
      if (sessionError) {
        apiClient.setAccessToken(null);
        setUser(null);
        setSession(null);
        setAuthState('signed_out');
        setError('تعذر استعادة الجلسة السابقة.');
        return;
      }
      if (initialSession) {
        void syncWithBackend(initialSession);
      } else {
        setAuthState('signed_out');
      }
    });

    // الاستماع لأحداث الدخول والخروج وتجديد التوكن
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, newSession) => {
      if (!isMounted) return;

      if (event === 'SIGNED_OUT') {
        apiClient.setAccessToken(null);
        setUser(null);
        setSession(null);
        setAuthState('signed_out');
        setError(null);
      } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
        if (newSession) {
          void syncWithBackend(newSession);
        } else {
          apiClient.setAccessToken(null);
          setUser(null);
          setSession(null);
          setAuthState('signed_out');
        }
      }
    });

    return () => {
      isMounted = false;
      subscription.unsubscribe();
    };
  }, [syncWithBackend]);

  /**
   * تسجيل الدخول بالبريد وكلمة المرور
   */
  const signIn = useCallback(async (email: string, password: string) => {
    if (!isSupabaseConfigured() || !supabase) {
      setAuthState('config_missing');
      throw new Error('إعدادات Supabase غير متوفرة في بيئة التشغيل.');
    }

    setError(null);
    setAuthState('loading');

    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (signInError) {
      setAuthState('signed_out');
      let friendlyMessage = 'بيانات تسجيل الدخول غير صحيحة.';
      if (signInError.message.includes('Invalid login credentials')) {
        friendlyMessage = 'البريد الإلكتروني أو كلمة المرور غير صحيحة.';
      } else if (signInError.message.includes('Email not confirmed')) {
        friendlyMessage = 'يرجى تأكيد البريد الإلكتروني أولاً.';
      } else if (signInError.status === 429) {
        friendlyMessage = 'تم تجاوز عدد المحاولات المسموح بها، يرجى المحاولة لاحقاً.';
      }
      setError(friendlyMessage);
      throw new Error(friendlyMessage);
    }

    if (data.session) {
      await syncWithBackend(data.session);
    }
  }, [syncWithBackend]);

  /**
   * إعادة محاولة التحقق مع الخادم الخلفي
   */
  const retryVerification = useCallback(async () => {
    if (session) {
      setAuthState('loading');
      setError(null);
      await syncWithBackend(session);
    } else if (supabase) {
      setAuthState('loading');
      setError(null);
      const { data: { session: currentSession } } = await supabase.auth.getSession();
      await syncWithBackend(currentSession);
    }
  }, [session, syncWithBackend]);

  /**
   * تسجيل الخروج وضمان مسح التوكن والهوية محلياً حتى لو فشل طلب Supabase
   */
  const signOut = useCallback(async () => {
    try {
      if (supabase) {
        await supabase.auth.signOut();
      }
    } catch {
      // نتجاهل خطأ الشبكة لضمان الإخلاء المحلي التام
    } finally {
      apiClient.setAccessToken(null);
      setUser(null);
      setSession(null);
      setAuthState(isSupabaseConfigured() ? 'signed_out' : 'config_missing');
      setError(null);
    }
  }, []);

  const value: AuthContextValue = {
    authState,
    user,
    session,
    error,
    isConfigured: isSupabaseConfigured(),
    signIn,
    signOut,
    retryVerification,
    clearError,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
