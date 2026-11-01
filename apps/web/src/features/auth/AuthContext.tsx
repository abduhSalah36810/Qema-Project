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

export type AuthMode = 'supabase' | 'local_dev' | 'none';

export const LOCAL_DEV_STORAGE_KEY = 'qemma_local_dev_token';

interface AuthContextValue {
  authState: AuthState;
  authMode: AuthMode;
  user: UserIdentity | null;
  session: Session | null;
  error: string | null;
  isConfigured: boolean;
  isDevAuthAvailable: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signInLocalDev: () => Promise<void>;
  signOut: () => Promise<void>;
  retryVerification: () => Promise<void>;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [authState, setAuthState] = useState<AuthState>(
    isSupabaseConfigured() ? 'loading' : 'config_missing'
  );
  const [authMode, setAuthMode] = useState<AuthMode>('none');
  const [user, setUser] = useState<UserIdentity | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isDevAuthAvailable = !isSupabaseConfigured() && import.meta.env.DEV;

  // عداد تتابعي لإعطاء كل حدث هوية فريدة، وضمان مبدأ "الحدث الأحدث هو الفائز" (latest-event-wins)
  const syncSequenceRef = useRef(0);
  const isMountedRef = useRef(true);

  const clearError = useCallback(() => setError(null), []);

  /**
   * مطابقة جلسة Supabase مع الخادم الخلفي عبر GET /api/v1/auth/me
   */
  const syncWithBackend = useCallback(async (activeSession: Session | null) => {
    if (!isMountedRef.current) return;

    if (!activeSession || !activeSession.access_token) {
      syncSequenceRef.current += 1;
      apiClient.setAccessToken(null);
      setUser(null);
      setSession(null);
      setAuthState(isSupabaseConfigured() ? 'signed_out' : 'config_missing');
      return;
    }

    // التحقق من تاريخ انتهاء صلاحية الجلسة محلياً
    const nowSec = Math.floor(Date.now() / 1000);
    if (activeSession.expires_at && activeSession.expires_at <= nowSec) {
      syncSequenceRef.current += 1;
      apiClient.setAccessToken(null);
      setUser(null);
      setSession(null);
      setAuthState(isSupabaseConfigured() ? 'signed_out' : 'config_missing');
      setError('انتهت صلاحية جلسة الدخول. يرجى تسجيل الدخول مجدداً.');
      return;
    }

    const syncId = ++syncSequenceRef.current;

    try {
      apiClient.setAccessToken(activeSession.access_token);
      const identity = await apiClient.getAuthMe({ token: activeSession.access_token });

      if (!isMountedRef.current || syncId !== syncSequenceRef.current) {
        return;
      }

      apiClient.setAccessToken(activeSession.access_token);
      setUser(identity);
      setSession(activeSession);
      setAuthState('authenticated');
      setError(null);
    } catch (err: unknown) {
      if (!isMountedRef.current || syncId !== syncSequenceRef.current) {
        return;
      }

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
    }
  }, []);

  // استعادة الجلسة الأولية والاستماع لتغيرات حالة المصادقة
  useEffect(() => {
    isMountedRef.current = true;

    // 1. محاولة استعادة جلسة التطوير المحلي إن وُجدت في التخزين المحلي
    let storedDevToken: string | null = null;
    try {
      storedDevToken = localStorage.getItem(LOCAL_DEV_STORAGE_KEY);
    } catch {
      storedDevToken = null;
    }

    if (storedDevToken && storedDevToken.trim()) {
      const syncId = ++syncSequenceRef.current;
      apiClient.setAccessToken(storedDevToken);
      void apiClient
        .getAuthMe({ token: storedDevToken })
        .then((identity) => {
          if (!isMountedRef.current || syncId !== syncSequenceRef.current) return;
          setUser(identity);
          setAuthMode('local_dev');
          setAuthState('authenticated');
          setError(null);
        })
        .catch(() => {
          if (!isMountedRef.current || syncId !== syncSequenceRef.current) return;
          try {
            localStorage.removeItem(LOCAL_DEV_STORAGE_KEY);
          } catch {
            /* no-op */
          }
          apiClient.setAccessToken(null);
          setUser(null);
          setAuthMode('none');
          setAuthState(isSupabaseConfigured() ? 'signed_out' : 'config_missing');
        });
      return;
    }

    // 2. إذا لم توجد جلسة محلية، المتابعة مع Supabase إن كان مهيأً
    if (!isSupabaseConfigured() || !supabase) {
      setAuthState('config_missing');
      return;
    }

    const initialSeq = syncSequenceRef.current;

    // فحص الجلسة المحفوظة أولياً
    void supabase.auth.getSession().then(({ data: { session: initialSession }, error: sessionError }) => {
      if (!isMountedRef.current || syncSequenceRef.current !== initialSeq) return;
      if (sessionError) {
        syncSequenceRef.current += 1;
        apiClient.setAccessToken(null);
        setUser(null);
        setSession(null);
        setAuthState(isSupabaseConfigured() ? 'signed_out' : 'config_missing');
        setError('تعذر استعادة الجلسة السابقة.');
        return;
      }
      if (initialSession) {
        void syncWithBackend(initialSession);
      } else {
        syncSequenceRef.current += 1;
        setAuthState(isSupabaseConfigured() ? 'signed_out' : 'config_missing');
      }
    });

    // الاستماع لأحداث الدخول والخروج وتجديد التوكن
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, newSession) => {
      if (!isMountedRef.current) return;

      if (event === 'SIGNED_OUT') {
        syncSequenceRef.current += 1;
        apiClient.setAccessToken(null);
        setUser(null);
        setSession(null);
        setAuthState(isSupabaseConfigured() ? 'signed_out' : 'config_missing');
        setError(null);
      } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
        if (newSession) {
          void syncWithBackend(newSession);
        } else {
          syncSequenceRef.current += 1;
          apiClient.setAccessToken(null);
          setUser(null);
          setSession(null);
          setAuthState(isSupabaseConfigured() ? 'signed_out' : 'config_missing');
        }
      }
    });

    return () => {
      isMountedRef.current = false;
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

    // إبطال أي تحقق قيد التنفيذ فور بدء محاولة تسجيل الدخول
    const signInSeq = ++syncSequenceRef.current;
    setError(null);
    setAuthState('loading');

    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (!isMountedRef.current || syncSequenceRef.current !== signInSeq) {
      return;
    }

    if (signInError) {
      syncSequenceRef.current += 1;
      setAuthState(isSupabaseConfigured() ? 'signed_out' : 'config_missing');
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
   * تسجيل الدخول كمطور محلي (بيئة التطوير فقط بدون اعتماد على Supabase)
   */
  const signInLocalDev = useCallback(async () => {
    setError(null);
    setAuthState('loading');

    try {
      const resp = await apiClient.localLogin();
      try {
        localStorage.setItem(LOCAL_DEV_STORAGE_KEY, resp.access_token);
      } catch {
        /* no-op */
      }
      apiClient.setAccessToken(resp.access_token);
      setUser(resp.user);
      setSession(null);
      setAuthState('authenticated');
      setAuthMode('local_dev');
      setError(null);
    } catch (err: unknown) {
      try {
        localStorage.removeItem(LOCAL_DEV_STORAGE_KEY);
      } catch {
        /* no-op */
      }
      apiClient.setAccessToken(null);
      setUser(null);
      setSession(null);
      setAuthMode('none');
      setAuthState('config_missing');
      const msg = err instanceof ApiError ? err.message : 'تعذر تسجيل الدخول كمطور محلي.';
      setError(msg);
      throw new Error(msg);
    }
  }, []);

  /**
   * تسجيل الخروج وضمان مسح التوكن والهوية محلياً حتى لو فشل طلب Supabase
   */
  const signOut = useCallback(async () => {
    // 1. مسار الخروج لجلسة المطور المحلي
    if (authMode === 'local_dev') {
      try {
        localStorage.removeItem(LOCAL_DEV_STORAGE_KEY);
      } catch {
        /* no-op */
      }
      syncSequenceRef.current += 1;
      apiClient.setAccessToken(null);
      setUser(null);
      setSession(null);
      setAuthMode('none');
      setAuthState(isSupabaseConfigured() ? 'signed_out' : 'config_missing');
      setError(null);
      return;
    }

    // 2. مسار الخروج لجلسة Supabase
    syncSequenceRef.current += 1;
    apiClient.setAccessToken(null);
    setUser(null);
    setSession(null);
    setAuthState(isSupabaseConfigured() ? 'signed_out' : 'config_missing');
    setError(null);

    try {
      if (supabase) {
        await supabase.auth.signOut();
      }
    } catch {
      // نتجاهل خطأ الشبكة لضمان الإخلاء المحلي التام
    } finally {
      syncSequenceRef.current += 1;
      apiClient.setAccessToken(null);
      setUser(null);
      setSession(null);
      setAuthState(isSupabaseConfigured() ? 'signed_out' : 'config_missing');
      setError(null);
    }
  }, [authMode]);

  const value: AuthContextValue = {
    authState,
    authMode,
    user,
    session,
    error,
    isConfigured: isSupabaseConfigured(),
    isDevAuthAvailable,
    signIn,
    signInLocalDev,
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
