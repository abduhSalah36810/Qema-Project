/**
 * سياق المصادقة وإدارة الجلسات (Authentication Context)
 * ─────────────────────────────────────────────────────────────────────────────
 * يربط بين:
 * 1. عميل Supabase Auth لإدارة تسجيل الدخول والجلسات في المتصفح.
 * 2. خادم FastAPI عبر GET /api/v1/auth/me الذي يعيد الهوية والأدوار والصلاحيات الفعلية.
 * 3. تزويد عميل API بتوكن الوصول (Bearer Token) بنطاق محمي لخادم المصنع حصراً.
 * 4. التعامل الصارم مع انتهاء الصلاحية، إلغاء الجلسات، فشل التجديد، وتعطل الخادم.
 *
 * الصلاحيات تُقرأ من استجابة الخادم فقط (مصدر الحقيقة الوحيد)، ولا تُشتق من التوكن
 * أو من user_metadata أو من خريطة أدوار منسوخة في الواجهة. أثناء التحميل أو عند الفشل
 * تُعامل الجلسة بلا أي صلاحية (Fail closed).
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

/** حالة تحميل الصلاحيات الخادمية من GET /api/v1/auth/me */
export type PermissionsStatus = 'idle' | 'loading' | 'ready' | 'error';

export const LOCAL_DEV_STORAGE_KEY = 'qemma_local_dev_token';

interface AuthorizationState {
  roles: string[];
  permissions: string[];
  status: PermissionsStatus;
  error: string | null;
}

const EMPTY_AUTHZ: AuthorizationState = { roles: [], permissions: [], status: 'idle', error: null };
const LOADING_AUTHZ: AuthorizationState = { roles: [], permissions: [], status: 'loading', error: null };

function toStringList(value: unknown, lowerCase = false): string[] {
  if (!Array.isArray(value)) return [];
  const out = value
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => (lowerCase ? v.trim().toLowerCase() : v.trim()));
  return Array.from(new Set(out));
}

function authzFromIdentity(identity: UserIdentity): AuthorizationState {
  return {
    roles: toStringList(identity.roles, true),
    permissions: toStringList(identity.permissions),
    status: 'ready',
    error: null,
  };
}

function describeAuthMeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'رفض خادم الـ API توكن الدخول (غير صالح أو منتهي الصلاحية).';
    if (err.isNetworkError || err.isTimeout) return 'تعذر الاتصال بخادم الـ API للتحقق من هوية المستخدم.';
    return err.message;
  }
  return 'تعذر التحقق من هوية المستخدم مع الخادم الخلفي.';
}

interface AuthContextValue {
  authState: AuthState;
  authMode: AuthMode;
  user: UserIdentity | null;
  session: Session | null;
  /** الأدوار المعتمدة خادمياً (فارغة أثناء التحميل أو عند الفشل) */
  roles: string[];
  /** الصلاحيات الفعلية من الخادم (فارغة أثناء التحميل أو عند الفشل) */
  permissions: string[];
  permissionsStatus: PermissionsStatus;
  permissionsError: string | null;
  hasPermission: (permission: string) => boolean;
  hasRole: (role: string) => boolean;
  error: string | null;
  isConfigured: boolean;
  isDevAuthAvailable: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signInLocalDev: (role?: string) => Promise<void>;
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
  const [authz, setAuthz] = useState<AuthorizationState>(EMPTY_AUTHZ);
  const [error, setError] = useState<string | null>(null);
  const isDevAuthAvailable = !isSupabaseConfigured() && import.meta.env.DEV;

  // عداد تتابعي لإعطاء كل حدث هوية فريدة، وضمان مبدأ "الحدث الأحدث هو الفائز" (latest-event-wins)
  const syncSequenceRef = useRef(0);
  const isMountedRef = useRef(true);

  const clearError = useCallback(() => setError(null), []);

  /** إخلاء كامل للهوية والتوكن والصلاحيات محلياً */
  const clearLocalIdentity = useCallback(() => {
    apiClient.setAccessToken(null);
    setUser(null);
    setSession(null);
    setAuthz(EMPTY_AUTHZ);
  }, []);

  /**
   * مطابقة جلسة Supabase مع الخادم الخلفي عبر GET /api/v1/auth/me
   */
  const syncWithBackend = useCallback(async (activeSession: Session | null) => {
    if (!isMountedRef.current) return;

    if (!activeSession || !activeSession.access_token) {
      syncSequenceRef.current += 1;
      clearLocalIdentity();
      setAuthState(isSupabaseConfigured() ? 'signed_out' : 'config_missing');
      return;
    }

    // التحقق من تاريخ انتهاء صلاحية الجلسة محلياً
    const nowSec = Math.floor(Date.now() / 1000);
    if (activeSession.expires_at && activeSession.expires_at <= nowSec) {
      syncSequenceRef.current += 1;
      clearLocalIdentity();
      setAuthState(isSupabaseConfigured() ? 'signed_out' : 'config_missing');
      setError('انتهت صلاحية جلسة الدخول. يرجى تسجيل الدخول مجدداً.');
      return;
    }

    const syncId = ++syncSequenceRef.current;
    // Fail closed: لا صلاحيات حتى تصل استجابة الخادم
    setAuthz(LOADING_AUTHZ);

    try {
      apiClient.setAccessToken(activeSession.access_token);
      const identity = await apiClient.getAuthMe({ token: activeSession.access_token });

      if (!isMountedRef.current || syncId !== syncSequenceRef.current) {
        return;
      }

      apiClient.setAccessToken(activeSession.access_token);
      setUser(identity);
      setSession(activeSession);
      setAuthz(authzFromIdentity(identity));
      setAuthMode('supabase');
      setAuthState('authenticated');
      setError(null);
    } catch (err: unknown) {
      if (!isMountedRef.current || syncId !== syncSequenceRef.current) {
        return;
      }

      // إخلاء التوكن المعتمد وعدم إبقاء الواجهة في حالة توثيق زائف
      const errorMsg = describeAuthMeError(err);
      apiClient.setAccessToken(null);
      setUser(null);
      setSession(activeSession);
      setAuthz({ roles: [], permissions: [], status: 'error', error: errorMsg });
      setAuthState('unverified');
      setError(errorMsg);
    }
  }, [clearLocalIdentity]);

  /**
   * جلب الصلاحيات الخادمية لجلسة التطوير المحلي بعد الحصول على التوكن.
   * عند الفشل يبقى المستخدم مسجلاً لكن بلا صلاحيات مع إظهار الخطأ.
   */
  const loadLocalDevPermissions = useCallback(async (token: string, syncId: number) => {
    setAuthz(LOADING_AUTHZ);
    try {
      const identity = await apiClient.getAuthMe({ token });
      if (!isMountedRef.current || syncId !== syncSequenceRef.current) return;
      setUser(identity);
      setAuthz(authzFromIdentity(identity));
      setError(null);
    } catch (err: unknown) {
      if (!isMountedRef.current || syncId !== syncSequenceRef.current) return;
      const msg = `تم تسجيل الدخول لكن تعذر تحميل الصلاحيات من الخادم: ${describeAuthMeError(err)}`;
      setAuthz({ roles: [], permissions: [], status: 'error', error: msg });
      setError(msg);
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
      const token = storedDevToken;
      apiClient.setAccessToken(token);
      setAuthz(LOADING_AUTHZ);
      void apiClient
        .getAuthMe({ token })
        .then((identity) => {
          if (!isMountedRef.current || syncId !== syncSequenceRef.current) return;
          setUser(identity);
          setAuthz(authzFromIdentity(identity));
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
          clearLocalIdentity();
          setAuthMode('none');
          setAuthState(isSupabaseConfigured() ? 'signed_out' : 'config_missing');
        });
      return () => {
        isMountedRef.current = false;
      };
    }

    // 2. إذا لم توجد جلسة محلية، المتابعة مع Supabase إن كان مهيأً
    if (!isSupabaseConfigured() || !supabase) {
      setAuthState('config_missing');
      return () => {
        isMountedRef.current = false;
      };
    }

    const initialSeq = syncSequenceRef.current;

    // فحص الجلسة المحفوظة أولياً
    void supabase.auth.getSession().then(({ data: { session: initialSession }, error: sessionError }) => {
      if (!isMountedRef.current || syncSequenceRef.current !== initialSeq) return;
      if (sessionError) {
        syncSequenceRef.current += 1;
        clearLocalIdentity();
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
        clearLocalIdentity();
        setAuthState(isSupabaseConfigured() ? 'signed_out' : 'config_missing');
        setError(null);
      } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
        if (newSession) {
          void syncWithBackend(newSession);
        } else {
          syncSequenceRef.current += 1;
          clearLocalIdentity();
          setAuthState(isSupabaseConfigured() ? 'signed_out' : 'config_missing');
        }
      }
    });

    return () => {
      isMountedRef.current = false;
      subscription.unsubscribe();
    };
  }, [syncWithBackend, clearLocalIdentity]);

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
   * إعادة محاولة التحقق وجلب الصلاحيات من الخادم الخلفي
   */
  const retryVerification = useCallback(async () => {
    if (authMode === 'local_dev') {
      const token = apiClient.getAccessToken();
      if (token) {
        setError(null);
        await loadLocalDevPermissions(token, syncSequenceRef.current);
      }
      return;
    }
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
  }, [authMode, session, syncWithBackend, loadLocalDevPermissions]);

  /**
   * تسجيل الدخول كمطور محلي مع اختيار الدور المصرح به (بيئة التطوير والاختبار فقط).
   * الدور المختار يحدد التوكن فقط؛ الصلاحيات الفعلية تأتي من GET /api/v1/auth/me.
   */
  const signInLocalDev = useCallback(async (selectedRole?: string) => {
    const syncId = ++syncSequenceRef.current;
    setError(null);
    setAuthState('loading');

    // إخلاء التوكن وحالة الجلسة السابقة بالكامل لمنع الاحتفاظ بأي صلاحيات قديمة
    clearLocalIdentity();
    try {
      localStorage.removeItem(LOCAL_DEV_STORAGE_KEY);
    } catch {
      /* no-op */
    }

    let accessToken: string;
    try {
      const resp = await apiClient.localLogin({ role: selectedRole });
      if (!isMountedRef.current || syncId !== syncSequenceRef.current) return;
      accessToken = resp.access_token;
      try {
        localStorage.setItem(LOCAL_DEV_STORAGE_KEY, accessToken);
      } catch {
        /* no-op */
      }
      apiClient.setAccessToken(accessToken);
      setUser(resp.user);
      setSession(null);
      setAuthz(LOADING_AUTHZ);
      setAuthState('authenticated');
      setAuthMode('local_dev');
    } catch (err: unknown) {
      if (!isMountedRef.current || syncId !== syncSequenceRef.current) return;
      try {
        localStorage.removeItem(LOCAL_DEV_STORAGE_KEY);
      } catch {
        /* no-op */
      }
      clearLocalIdentity();
      setAuthMode('none');
      setAuthState('config_missing');
      const msg = err instanceof ApiError ? err.message : 'تعذر تسجيل الدخول كمطور محلي.';
      setError(msg);
      throw new Error(msg);
    }

    await loadLocalDevPermissions(accessToken, syncId);
  }, [clearLocalIdentity, loadLocalDevPermissions]);

  /**
   * تسجيل الخروج وضمان مسح التوكن والهوية والصلاحيات محلياً حتى لو فشل طلب Supabase
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
      clearLocalIdentity();
      setAuthMode('none');
      setAuthState(isSupabaseConfigured() ? 'signed_out' : 'config_missing');
      setError(null);
      return;
    }

    // 2. مسار الخروج لجلسة Supabase
    syncSequenceRef.current += 1;
    clearLocalIdentity();
    setAuthMode('none');
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
      clearLocalIdentity();
      setAuthState(isSupabaseConfigured() ? 'signed_out' : 'config_missing');
      setError(null);
    }
  }, [authMode, clearLocalIdentity]);

  // الصلاحيات سارية فقط لمستخدم موثق اكتمل تحميل صلاحياته من الخادم (Fail closed)
  const isAuthorized = authState === 'authenticated' && user !== null && authz.status === 'ready';
  const roles = React.useMemo(() => (isAuthorized ? authz.roles : []), [isAuthorized, authz.roles]);
  const permissions = React.useMemo(
    () => (isAuthorized ? authz.permissions : []),
    [isAuthorized, authz.permissions]
  );
  const permissionSet = React.useMemo(() => new Set(permissions), [permissions]);

  const hasRole = useCallback((role: string) => roles.includes(role.toLowerCase()), [roles]);
  const hasPermission = useCallback((permission: string) => permissionSet.has(permission), [permissionSet]);

  const value: AuthContextValue = {
    authState,
    authMode,
    user,
    session,
    roles,
    permissions,
    permissionsStatus: user ? authz.status : 'idle',
    permissionsError: authz.error,
    hasPermission,
    hasRole,
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

const FALLBACK_AUTH_CONTEXT: AuthContextValue = {
  authState: 'signed_out',
  authMode: 'none',
  user: null,
  session: null,
  roles: [],
  permissions: [],
  permissionsStatus: 'idle',
  permissionsError: null,
  hasPermission: () => false,
  hasRole: () => false,
  error: null,
  isConfigured: true,
  isDevAuthAvailable: true,
  signIn: async () => {},
  signInLocalDev: async () => {},
  signOut: async () => {},
  retryVerification: async () => {},
  clearError: () => {},
};

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  return context ?? FALLBACK_AUTH_CONTEXT;
}
