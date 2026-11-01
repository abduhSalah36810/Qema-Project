import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import type { Session } from '@supabase/supabase-js';

import { AuthProvider, useAuth } from './AuthContext';
import { apiClient, ApiError, type UserIdentity } from '@/lib/api';
import App from '@/App';

// إعداد كائنات محاكاة لـ Supabase دون استخدام بيانات اعتماد حقيقية
const mockGetSession = vi.fn();
const mockSignOut = vi.fn();
const mockSignInWithPassword = vi.fn();

type AuthChangeCallback = (event: string, session: Session | null) => void;
let authChangeCallbacks: AuthChangeCallback[] = [];

function triggerAuthStateChange(event: string, session: Session | null) {
  for (const cb of [...authChangeCallbacks]) {
    cb(event, session);
  }
}

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: () => true,
  supabase: {
    auth: {
      getSession: () => mockGetSession(),
      onAuthStateChange: (cb: AuthChangeCallback) => {
        authChangeCallbacks.push(cb);
        return {
          data: {
            subscription: {
              unsubscribe: vi.fn(() => {
                authChangeCallbacks = authChangeCallbacks.filter((c) => c !== cb);
              }),
            },
          },
        };
      },
      signInWithPassword: (creds: unknown) => mockSignInWithPassword(creds),
      signOut: () => mockSignOut(),
    },
  },
}));

// مكون اختباري مساعد لقراءة واختبار سياق useAuth
function AuthTestConsumer({
  onRender,
}: {
  onRender?: (auth: ReturnType<typeof useAuth>) => void;
}) {
  const auth = useAuth();
  if (onRender) onRender(auth);

  return (
    <div>
      <div data-testid="auth-state">{auth.authState}</div>
      <div data-testid="auth-mode">{auth.authMode}</div>
      <div data-testid="user-id">{auth.user?.id ?? 'none'}</div>
      <div data-testid="user-email">{auth.user?.email ?? 'none'}</div>
      <div data-testid="auth-error">{auth.error ?? 'none'}</div>
      <button data-testid="sign-out-btn" onClick={() => void auth.signOut()}>
        تسجيل الخروج
      </button>
      <button
        data-testid="retry-btn"
        onClick={() => void auth.retryVerification()}
      >
        إعادة التحقق
      </button>
      <button
        data-testid="sign-in-btn"
        onClick={() => void auth.signIn('worker@qemma.com', 'password123')}
      >
        تسجيل الدخول
      </button>
      <button
        data-testid="local-dev-btn"
        onClick={() => void auth.signInLocalDev()}
      >
        دخول محلي
      </button>
    </div>
  );
}

describe('Supabase Auth Integration & Token Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authChangeCallbacks = [];
    apiClient.setAccessToken(null);
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    mockSignOut.mockResolvedValue({ error: null });
  });

  afterEach(() => {
    apiClient.setAccessToken(null);
    vi.restoreAllMocks();
  });

  it('3a. clears token, user identity, and session after sign-out', async () => {
    // محاكاة مستخدم مسجل دخول مسبقاً
    const validSession = {
      access_token: 'active-token-999',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'usr-1', email: 'worker@qemma.com' },
    } as unknown as Session;

    mockGetSession.mockResolvedValue({ data: { session: validSession }, error: null });
    vi.spyOn(apiClient, 'getAuthMe').mockResolvedValue({
      id: 'usr-1',
      email: 'worker@qemma.com',
    });

    render(
      <AuthProvider>
        <AuthTestConsumer />
      </AuthProvider>
    );

    // انتظار اكتمال التحقق الأولي
    await waitFor(() => {
      expect(screen.getByTestId('auth-state').textContent).toBe('authenticated');
    });
    expect(apiClient.getAccessToken()).toBe('active-token-999');
    expect(screen.getByTestId('user-email').textContent).toBe('worker@qemma.com');

    // تنفيذ تسجيل الخروج
    await act(async () => {
      screen.getByTestId('sign-out-btn').click();
    });

    // التحقق من الإخلاء التام للتوكن والهوية وحالة الجلسة
    await waitFor(() => {
      expect(screen.getByTestId('auth-state').textContent).toBe('signed_out');
    });
    expect(apiClient.getAccessToken()).toBeNull();
    expect(screen.getByTestId('user-id').textContent).toBe('none');
    expect(screen.getByTestId('user-email').textContent).toBe('none');
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('3b. clears token and identity even when the Supabase sign-out call fails', async () => {
    const validSession = {
      access_token: 'active-token-err',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'usr-2', email: 'supervisor@qemma.com' },
    } as unknown as Session;

    mockGetSession.mockResolvedValue({ data: { session: validSession }, error: null });
    vi.spyOn(apiClient, 'getAuthMe').mockResolvedValue({
      id: 'usr-2',
      email: 'supervisor@qemma.com',
    });

    // محاكاة فشل طلب Supabase الخارجي أثناء تسجيل الخروج
    mockSignOut.mockRejectedValueOnce(new Error('Network error during sign out'));

    render(
      <AuthProvider>
        <AuthTestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('auth-state').textContent).toBe('authenticated');
    });
    expect(apiClient.getAccessToken()).toBe('active-token-err');

    // تنفيذ تسجيل الخروج
    await act(async () => {
      screen.getByTestId('sign-out-btn').click();
    });

    // على الرغم من فشل Supabase بالشبكة، يجب أن يضمن finally الإخلاء المحلي التام
    await waitFor(() => {
      expect(screen.getByTestId('auth-state').textContent).toBe('signed_out');
    });
    expect(apiClient.getAccessToken()).toBeNull();
    expect(screen.getByTestId('user-id').textContent).toBe('none');
    expect(screen.getByTestId('user-email').textContent).toBe('none');
  });

  it('4a. shows an unverified state when /api/v1/auth/me rejects the token (401 ApiError)', async () => {
    const rejectedSession = {
      access_token: 'rejected-jwt-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'usr-rejected', email: 'unauthorized@qemma.com' },
    } as unknown as Session;

    mockGetSession.mockResolvedValue({ data: { session: rejectedSession }, error: null });
    // محاكاة رفض الخادم للتوكن برمز 401
    vi.spyOn(apiClient, 'getAuthMe').mockRejectedValueOnce(
      new ApiError('Unauthorized token', { status: 401 })
    );

    render(
      <AuthProvider>
        <AuthTestConsumer />
      </AuthProvider>
    );

    // التحقق من انتقال الحالة إلى unverified ومسح التوكن
    await waitFor(() => {
      expect(screen.getByTestId('auth-state').textContent).toBe('unverified');
    });

    expect(apiClient.getAccessToken()).toBeNull();
    expect(screen.getByTestId('user-id').textContent).toBe('none');
    expect(screen.getByTestId('auth-error').textContent).toContain('رفض خادم الـ API توكن الدخول');
  });

  it('4b. shows an unverified state when /api/v1/auth/me suffers a network failure', async () => {
    const activeSession = {
      access_token: 'network-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'usr-net', email: 'worker2@qemma.com' },
    } as unknown as Session;

    mockGetSession.mockResolvedValue({ data: { session: activeSession }, error: null });
    vi.spyOn(apiClient, 'getAuthMe').mockRejectedValueOnce(
      new ApiError('Network disconnected', { isNetworkError: true })
    );

    render(
      <AuthProvider>
        <AuthTestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('auth-state').textContent).toBe('unverified');
    });

    expect(apiClient.getAccessToken()).toBeNull();
    expect(screen.getByTestId('user-id').textContent).toBe('none');
    expect(screen.getByTestId('auth-error').textContent).toContain('تعذر الاتصال بخادم الـ API');
  });

  it('4c. marks state as signed_out if stored session is already expired', async () => {
    const expiredSession = {
      access_token: 'expired-token',
      expires_at: Math.floor(Date.now() / 1000) - 100, // منتهي قبل 100 ثانية
      user: { id: 'usr-exp', email: 'expired@qemma.com' },
    } as unknown as Session;

    mockGetSession.mockResolvedValue({ data: { session: expiredSession }, error: null });
    const getAuthMeSpy = vi.spyOn(apiClient, 'getAuthMe');

    render(
      <AuthProvider>
        <AuthTestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('auth-state').textContent).toBe('signed_out');
    });

    expect(getAuthMeSpy).not.toHaveBeenCalled();
    expect(apiClient.getAccessToken()).toBeNull();
    expect(screen.getByTestId('auth-error').textContent).toContain('انتهت صلاحية جلسة الدخول');
  });

  it('5. keeps demo mode clearly separate between unauthenticated and authenticated sessions', async () => {
    vi.spyOn(apiClient, 'getHealth').mockResolvedValue({
      status: 'ok',
      app: 'qemma-erp',
      version: '0.1.0',
    });

    // 1. فحص وضع المعاينة التجريبية بدون مصادقة
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });

    const { unmount } = render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/بيئة معاينة تجريبية محلية/)).toBeInTheDocument();
    });
    expect(screen.getByText(/لم يتم تسجيل الدخول/)).toBeInTheDocument();
    expect(screen.getAllByText('تسجيل الدخول').length).toBeGreaterThanOrEqual(1);

    unmount();

    // 2. فحص وضع المعاينة عند وجود مستخدم مصادق عليه
    const authSession = {
      access_token: 'valid-jwt-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'usr-auth-5', email: 'manager@qemma.com' },
    } as unknown as Session;

    mockGetSession.mockResolvedValue({ data: { session: authSession }, error: null });
    vi.spyOn(apiClient, 'getAuthMe').mockResolvedValue({
      id: 'usr-auth-5',
      email: 'manager@qemma.com',
    });

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText(/جلسة عمل موثقة عبر Supabase & API/)).toBeInTheDocument();
    });
    expect(screen.getAllByText('manager@qemma.com').length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(/بيئة معاينة تجريبية محلية — لم يتم تسجيل الدخول/)).not.toBeInTheDocument();
  });

  it('6a. sign-out while /auth/me is pending prevents subsequent success from restoring state', async () => {
    let resolveGetAuthMe!: (value: UserIdentity) => void;
    const pendingGetAuthMePromise = new Promise<UserIdentity>((resolve) => {
      resolveGetAuthMe = resolve;
    });

    const pendingSession = {
      access_token: 'pending-token-1',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'usr-pending', email: 'pending@qemma.com' },
    } as unknown as Session;

    mockGetSession.mockResolvedValue({ data: { session: pendingSession }, error: null });
    vi.spyOn(apiClient, 'getAuthMe').mockReturnValue(pendingGetAuthMePromise);

    render(
      <AuthProvider>
        <AuthTestConsumer />
      </AuthProvider>
    );

    // التحقق من بدء العملية في حالة loading وتمرير التوكن مؤقتاً
    expect(screen.getByTestId('auth-state').textContent).toBe('loading');

    // تسجيل الخروج بينما طلب /auth/me لا يزال معلقاً
    await act(async () => {
      screen.getByTestId('sign-out-btn').click();
    });

    // يجب إخلاء التوكن وحالة المصادقة محلياً فوراً
    expect(screen.getByTestId('auth-state').textContent).toBe('signed_out');
    expect(apiClient.getAccessToken()).toBeNull();
    expect(screen.getByTestId('user-id').textContent).toBe('none');
    expect(screen.getByTestId('user-email').textContent).toBe('none');

    // اكتمال طلب /auth/me المعلق بنجاح بعد تسجيل الخروج
    await act(async () => {
      resolveGetAuthMe({ id: 'usr-pending', email: 'pending@qemma.com' });
    });

    // يجب ألا تتم استعادة حالة التوثيق القديمة نهائياً
    expect(screen.getByTestId('auth-state').textContent).toBe('signed_out');
    expect(apiClient.getAccessToken()).toBeNull();
    expect(screen.getByTestId('user-id').textContent).toBe('none');
    expect(screen.getByTestId('user-email').textContent).toBe('none');
  });

  it('6b. a newer token-refresh session arriving while an older verification is pending is verified and wins', async () => {
    let resolveSession1!: (value: UserIdentity) => void;
    const session1Promise = new Promise<UserIdentity>((resolve) => {
      resolveSession1 = resolve;
    });

    let resolveSession2!: (value: UserIdentity) => void;
    const session2Promise = new Promise<UserIdentity>((resolve) => {
      resolveSession2 = resolve;
    });

    const session1 = {
      access_token: 'token-v1-old',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'usr-1', email: 'worker@qemma.com' },
    } as unknown as Session;

    const session2 = {
      access_token: 'token-v2-refreshed',
      expires_at: Math.floor(Date.now() / 1000) + 7200,
      user: { id: 'usr-1', email: 'worker@qemma.com' },
    } as unknown as Session;

    mockGetSession.mockResolvedValue({ data: { session: session1 }, error: null });

    const getAuthMeSpy = vi.spyOn(apiClient, 'getAuthMe').mockImplementation((options) => {
      if (options?.token === 'token-v1-old') {
        return session1Promise;
      }
      if (options?.token === 'token-v2-refreshed') {
        return session2Promise;
      }
      return Promise.reject(new Error(`Unexpected token: ${options?.token}`));
    });

    render(
      <AuthProvider>
        <AuthTestConsumer />
      </AuthProvider>
    );

    // انتظار استدعاء التحقق للجلسة الأولى
    await waitFor(() => {
      expect(getAuthMeSpy).toHaveBeenCalledWith(expect.objectContaining({ token: 'token-v1-old' }));
    });

    // وصول حدث تجديد التوكن TOKEN_REFRESHED بينما طلب الجلسة الأولى لا يزال قيد التنفيذ
    await act(async () => {
      triggerAuthStateChange('TOKEN_REFRESHED', session2);
    });

    // يجب ألا يتم تجاهل حدث التجديد ويجب أن يبدأ التحقق للتوكن الجديد
    await waitFor(() => {
      expect(getAuthMeSpy).toHaveBeenCalledWith(expect.objectContaining({ token: 'token-v2-refreshed' }));
    });

    // اكتمال الجلسة الأولى القديمة
    await act(async () => {
      resolveSession1({ id: 'usr-1', email: 'old-worker@qemma.com' });
    });

    // اكتمال الجلسة الثانية الأحدث
    await act(async () => {
      resolveSession2({ id: 'usr-1', email: 'worker@qemma.com' });
    });

    // التأكد من اعتماد توكن وحالة الجلسة الأحدث
    await waitFor(() => {
      expect(screen.getByTestId('auth-state').textContent).toBe('authenticated');
    });
    expect(screen.getByTestId('user-email').textContent).toBe('worker@qemma.com');
    expect(apiClient.getAccessToken()).toBe('token-v2-refreshed');
  });

  it('6c. an older verification failing after a newer session has already authenticated does not corrupt state', async () => {
    let rejectSession1!: (reason: unknown) => void;
    const session1Promise = new Promise<UserIdentity>((_, reject) => {
      rejectSession1 = reject;
    });

    const session1 = {
      access_token: 'token-stale-initial',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'usr-stale', email: 'stale@qemma.com' },
    } as unknown as Session;

    const session2 = {
      access_token: 'token-current-valid',
      expires_at: Math.floor(Date.now() / 1000) + 7200,
      user: { id: 'usr-active', email: 'active@qemma.com' },
    } as unknown as Session;

    mockGetSession.mockResolvedValue({ data: { session: session1 }, error: null });

    const getAuthMeSpy = vi.spyOn(apiClient, 'getAuthMe').mockImplementation((options) => {
      if (options?.token === 'token-stale-initial') {
        return session1Promise;
      }
      if (options?.token === 'token-current-valid') {
        return Promise.resolve({ id: 'usr-active', email: 'active@qemma.com' });
      }
      return Promise.reject(new Error(`Unexpected token: ${options?.token}`));
    });

    render(
      <AuthProvider>
        <AuthTestConsumer />
      </AuthProvider>
    );

    // انتظار بدء التحقق من الجلسة القديمة
    await waitFor(() => {
      expect(getAuthMeSpy).toHaveBeenCalledWith(expect.objectContaining({ token: 'token-stale-initial' }));
    });

    // وصول جلسة أحدث واعتمادها بنجاح قبل انتهاء الأولى
    await act(async () => {
      triggerAuthStateChange('SIGNED_IN', session2);
    });

    await waitFor(() => {
      expect(screen.getByTestId('auth-state').textContent).toBe('authenticated');
    });
    expect(screen.getByTestId('user-id').textContent).toBe('usr-active');
    expect(apiClient.getAccessToken()).toBe('token-current-valid');

    // فشل التحقق من الجلسة القديمة برمز خطأ 401
    await act(async () => {
      rejectSession1(new ApiError('Expired or rejected initial token', { status: 401 }));
    });

    // يجب أن تبقى الجلسة الأحدث نشطة وموثقة دون أن يمسها فشل الجلسة القديمة
    expect(screen.getByTestId('auth-state').textContent).toBe('authenticated');
    expect(screen.getByTestId('user-id').textContent).toBe('usr-active');
    expect(screen.getByTestId('user-email').textContent).toBe('active@qemma.com');
    expect(apiClient.getAccessToken()).toBe('token-current-valid');
    expect(screen.getByTestId('auth-error').textContent).toBe('none');
  });

  it('6d. sign-out while signInWithPassword is pending prevents subsequent sign-in completion from restoring session', async () => {
    let resolveSignIn!: (value: {
      data: { session: Session | null; user: unknown };
      error: null;
    }) => void;
    const pendingSignInPromise = new Promise<{
      data: { session: Session | null; user: unknown };
      error: null;
    }>((resolve) => {
      resolveSignIn = resolve;
    });

    const signInSession = {
      access_token: 'late-signin-token',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: { id: 'usr-late', email: 'worker@qemma.com' },
    } as unknown as Session;

    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    mockSignInWithPassword.mockReturnValue(pendingSignInPromise);
    const getAuthMeSpy = vi.spyOn(apiClient, 'getAuthMe');

    render(
      <AuthProvider>
        <AuthTestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('auth-state').textContent).toBe('signed_out');
    });

    // 1. بدء طلب تسجيل الدخول وتركه معلقاً
    await act(async () => {
      screen.getByTestId('sign-in-btn').click();
    });

    expect(screen.getByTestId('auth-state').textContent).toBe('loading');
    expect(mockSignInWithPassword).toHaveBeenCalledTimes(1);

    // 2. تسجيل الخروج بينما طلب تسجيل الدخول لا يزال قيد التنفيذ
    await act(async () => {
      screen.getByTestId('sign-out-btn').click();
    });

    expect(screen.getByTestId('auth-state').textContent).toBe('signed_out');
    expect(apiClient.getAccessToken()).toBeNull();
    expect(screen.getByTestId('user-id').textContent).toBe('none');

    // 3. اكتمال طلب تسجيل الدخول المعلق بنجاح لاحقاً
    await act(async () => {
      resolveSignIn({
        data: { session: signInSession, user: signInSession.user },
        error: null,
      });
    });

    // 4. التأكد من عدم بدء التحقق الخلفي وبقاء الحالة مسجلاً للخروج وبدون توكن
    expect(getAuthMeSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('auth-state').textContent).toBe('signed_out');
    expect(apiClient.getAccessToken()).toBeNull();
    expect(screen.getByTestId('user-id').textContent).toBe('none');
    expect(screen.getByTestId('user-email').textContent).toBe('none');
  });

  describe('Local Development Authentication Flow', () => {
    beforeEach(() => {
      localStorage.clear();
      apiClient.setAccessToken(null);
    });

    afterEach(() => {
      localStorage.clear();
      vi.restoreAllMocks();
    });

    it('successfully logs in via local dev auth and updates session', async () => {
      mockGetSession.mockResolvedValue({ data: { session: null }, error: null });

      const localLoginSpy = vi.spyOn(apiClient, 'localLogin').mockResolvedValue({
        access_token: 'local-test-jwt-token-12345',
        token_type: 'bearer',
        expires_in: 28800,
        user: { id: 'dev-user-00000000-0000-0000-0000-000000000001', email: 'dev@qemma.local' },
      });

      render(
        <AuthProvider>
          <AuthTestConsumer />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('auth-state').textContent).toBe('signed_out');
      });

      await act(async () => {
        screen.getByTestId('local-dev-btn').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('auth-state').textContent).toBe('authenticated');
        expect(screen.getByTestId('auth-mode').textContent).toBe('local_dev');
        expect(screen.getByTestId('user-id').textContent).toBe('dev-user-00000000-0000-0000-0000-000000000001');
        expect(screen.getByTestId('user-email').textContent).toBe('dev@qemma.local');
      });

      expect(localStorage.getItem('qemma_local_dev_token')).toBe('local-test-jwt-token-12345');
      expect(apiClient.getAccessToken()).toBe('local-test-jwt-token-12345');
      expect(localLoginSpy).toHaveBeenCalledTimes(1);
    });

    it('restores local dev session from localStorage on mount', async () => {
      localStorage.setItem('qemma_local_dev_token', 'saved-local-token-999');

      vi.spyOn(apiClient, 'getAuthMe').mockResolvedValue({
        id: 'dev-user-00000000-0000-0000-0000-000000000001',
        email: 'dev@qemma.local',
      });

      render(
        <AuthProvider>
          <AuthTestConsumer />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('auth-state').textContent).toBe('authenticated');
        expect(screen.getByTestId('auth-mode').textContent).toBe('local_dev');
        expect(screen.getByTestId('user-id').textContent).toBe('dev-user-00000000-0000-0000-0000-000000000001');
      });

      expect(apiClient.getAccessToken()).toBe('saved-local-token-999');
    });

    it('clears local dev session on signOut', async () => {
      localStorage.setItem('qemma_local_dev_token', 'token-to-be-cleared');

      vi.spyOn(apiClient, 'getAuthMe').mockResolvedValue({
        id: 'dev-user-00000000-0000-0000-0000-000000000001',
        email: 'dev@qemma.local',
      });

      render(
        <AuthProvider>
          <AuthTestConsumer />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('auth-state').textContent).toBe('authenticated');
      });

      await act(async () => {
        screen.getByTestId('sign-out-btn').click();
      });

      await waitFor(() => {
        expect(screen.getByTestId('auth-mode').textContent).toBe('none');
        expect(screen.getByTestId('user-id').textContent).toBe('none');
      });

      expect(localStorage.getItem('qemma_local_dev_token')).toBeNull();
      expect(apiClient.getAccessToken()).toBeNull();
    });
  });
});
