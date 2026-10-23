import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import type { Session } from '@supabase/supabase-js';

import { AuthProvider, useAuth } from './AuthContext';
import { apiClient, ApiError } from '@/lib/api';
import App from '@/App';

// إعداد كائنات محاكاة لـ Supabase دون استخدام بيانات اعتماد حقيقية
const mockGetSession = vi.fn();
const mockSignOut = vi.fn();
const mockSignInWithPassword = vi.fn();

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: () => true,
  supabase: {
    auth: {
      getSession: () => mockGetSession(),
      onAuthStateChange: () => ({
        data: {
          subscription: {
            unsubscribe: vi.fn(),
          },
        },
      }),
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
    </div>
  );
}

describe('Supabase Auth Integration & Token Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
