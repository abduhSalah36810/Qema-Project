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

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * دالة الاستدعاء الشبكي المركزية مع دعم المهلة والتحقق من الأخطاء
 */
export async function apiRequest<T = unknown>(
  path: string,
  options: RequestOptions = {}
): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, headers, ...restOptions } = options;
  const url = buildApiUrl(path);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...restOptions,
      headers: {
        Accept: 'application/json',
        ...headers,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new ApiError(`استجاب الخادم برمز خطأ (${response.status})`, {
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

export const apiClient = {
  getHealth,
  request: apiRequest,
  getBaseUrl: () => API_BASE_URL,
};
