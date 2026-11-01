/**
 * وحدة العميل البرمجي المركزي (API Client)
 * ─────────────────────────────────────────────────────────────────────────────
 * توفر طبقة اتصال مركزية موحدة بين واجهة React وخادم FastAPI.
 * تقرأ عنوان الخادم من VITE_API_BASE_URL، وتعتمد المسار النسبي كبديل للتوافق
 * مع وكيل التطوير (Vite Dev Proxy).
 * ─────────────────────────────────────────────────────────────────────────────
 */

export interface HealthResponse {
  status: string;
  app: string;
  version: string;
}

export class ApiError extends Error {
  public readonly status?: number;
  public readonly isTimeout: boolean;
  public readonly isNetworkError: boolean;

  constructor(
    message: string,
    options: {
      status?: number;
      isTimeout?: boolean;
      isNetworkError?: boolean;
      cause?: unknown;
    } = {}
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status;
    this.isTimeout = options.isTimeout ?? false;
    this.isNetworkError = options.isNetworkError ?? false;
  }
}

/**
 * تحديد عنوان الأساس للـ API:
 * - إذا كان VITE_API_BASE_URL محددًا وغير فارغ، يُستخدم مباشرة بعد إزالة الشرطات الزائدة.
 * - إذا كان غير محدد، يُستخدم مسار نسبي فارغ ليتم توجيه /api عبر Vite proxy.
 */
function getApiBaseUrl(): string {
  const envUrl = import.meta.env.VITE_API_BASE_URL;
  if (typeof envUrl === 'string' && envUrl.trim().length > 0) {
    return envUrl.trim().replace(/\/+$/, '');
  }
  return '';
}

export const API_BASE_URL = getApiBaseUrl();

/**
 * بناء الرابط الكامل للمسار المطلوب
 */
export function buildApiUrl(path: string): string {
  if (path.startsWith('http://') || path.startsWith('https://')) {
    return path;
  }
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return API_BASE_URL ? `${API_BASE_URL}${cleanPath}` : cleanPath;
}

/**
 * التحقق من صحة هيكل استجابة فحص الصحة (Health Response Type Guard)
 */
export function isHealthResponse(data: unknown): data is HealthResponse {
  if (!data || typeof data !== 'object') {
    return false;
  }
  const obj = data as Record<string, unknown>;
  return (
    typeof obj.status === 'string' &&
    typeof obj.app === 'string' &&
    typeof obj.version === 'string'
  );
}

export interface RequestOptions extends RequestInit {
  timeoutMs?: number;
}

let activeAccessToken: string | null = null;

/**
 * ضبط توكن الوصول (Access Token) الصادر من Supabase لاستخدامه تلقائياً في الترويسات
 */
export function setAccessToken(token: string | null): void {
  activeAccessToken = token;
}

/**
 * استرجاع توكن الوصول الحالي
 */
export function getAccessToken(): string | null {
  return activeAccessToken;
}

export interface UserIdentity {
  id: string;
  email: string | null;
}

/**
 * التحقق الأمني من أن الرابط المستهدف يتبع نطاق الـ API المعتمد حصراً
 * لمنع تسريب توكن الوصول إلى أي روابط خارجية أو نطاقات أخرى
 */
export function isApiTarget(targetUrl: string): boolean {
  if (targetUrl.startsWith('/') && !targetUrl.startsWith('//')) {
    return true;
  }
  try {
    const originFallback = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';
    const parsedTarget = new URL(targetUrl, originFallback);
    const configuredApiOrigin = API_BASE_URL
      ? new URL(API_BASE_URL, originFallback).origin
      : originFallback;
    return parsedTarget.origin === configuredApiOrigin;
  } catch {
    return false;
  }
}

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * دالة الاستدعاء الشبكي المركزية مع دعم المهلة والتحقق من الأخطاء وتضمين التوكن المحمي
 */
export async function apiRequest<T = unknown>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, headers, ...restOptions } = options;
  const url = buildApiUrl(path);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  // إرفاق التوكن حصراً للطلبات الموجهة لخادم الـ API المعتمد
  const authHeaders: Record<string, string> = {};
  if (activeAccessToken && isApiTarget(url)) {
    authHeaders['Authorization'] = `Bearer ${activeAccessToken}`;
  }

  try {
    const response = await fetch(url, {
      ...restOptions,
      headers: {
        Accept: 'application/json',
        ...authHeaders,
        ...headers,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      let errorMessage = `استجاب الخادم برمز خطأ (${response.status})`;
      try {
        const errorData = (await response.json()) as Record<string, unknown>;
        if (errorData && typeof errorData === 'object') {
          if (typeof errorData.detail === 'string' && errorData.detail.trim().length > 0) {
            errorMessage = errorData.detail;
          } else if (typeof errorData.message === 'string' && errorData.message.trim().length > 0) {
            errorMessage = errorData.message;
          }
        }
      } catch {
        // استجابة الخطأ ليست JSON صالحاً، يُعتمد النص الافتراضي
      }

      throw new ApiError(errorMessage, {
        status: response.status,
      });
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new ApiError('استجابة الخادم ليست بصيغة JSON صالحة.');
    }

    return (await response.json()) as T;
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      throw err;
    }

    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError('انتهت مهلة الاتصال بالخادم دون استجابة.', {
        isTimeout: true,
      });
    }

    if (err instanceof TypeError) {
      // أخطاء فشل الشبكة في المتصفح مثل انقطاع الاتصال أو تعذر الوصول
      throw new ApiError('تعذر الاتصال بالخادم الخلفي. يرجى التحقق من تشغيل الخدمة.', {
        isNetworkError: true,
        cause: err,
      });
    }

    throw new ApiError(
      err instanceof Error ? err.message : 'حدث خطأ غير متوقع أثناء الاتصال بالخادم.',
      { cause: err }
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * استدعاء مسار فحص صحة الخادم GET /api/v1/health
 */
export async function getHealth(options?: { timeoutMs?: number }): Promise<HealthResponse> {
  const data = await apiRequest<unknown>('/api/v1/health', {
    method: 'GET',
    timeoutMs: options?.timeoutMs,
  });

  if (!isHealthResponse(data)) {
    throw new ApiError('استجابة فحص الصحة من الخادم لا تطابق الهيكل المعتمد.');
  }

  return data;
}

/**
 * استدعاء مسار استرجاع الهوية الأدنى GET /api/v1/auth/me
 */
export async function getAuthMe(options?: { token?: string; timeoutMs?: number }): Promise<UserIdentity> {
  const customHeaders: Record<string, string> = {};
  if (options?.token) {
    customHeaders['Authorization'] = `Bearer ${options.token}`;
  }

  return apiRequest<UserIdentity>('/api/v1/auth/me', {
    method: 'GET',
    headers: customHeaders,
    timeoutMs: options?.timeoutMs,
  });
}

export interface LocalLoginResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  user: UserIdentity;
}

/**
 * استدعاء مسار تسجيل الدخول المحلي للتطوير POST /api/v1/auth/local-login
 */
export async function localLogin(options?: { timeoutMs?: number }): Promise<LocalLoginResponse> {
  return apiRequest<LocalLoginResponse>('/api/v1/auth/local-login', {
    method: 'POST',
    timeoutMs: options?.timeoutMs,
  });
}

export const apiClient = {
  getHealth,
  getAuthMe,
  localLogin,
  setAccessToken,
  getAccessToken,
  isApiTarget,
  request: apiRequest,
  getBaseUrl: () => API_BASE_URL,
};

