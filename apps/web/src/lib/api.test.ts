import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  apiRequest,
  setAccessToken,
  getAccessToken,
  isApiTarget,
  API_BASE_URL,
} from './api';

describe('API Client Token Handling & Origin Scoping', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    setAccessToken(null);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setAccessToken(null);
    vi.restoreAllMocks();
  });

  it('1. attaches Bearer token to requests targeting the configured API origin', async () => {
    setAccessToken('valid-access-token-123');
    expect(getAccessToken()).toBe('valid-access-token-123');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ status: 'ok' }),
    });
    globalThis.fetch = fetchMock;

    await apiRequest('/api/v1/health');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0];
    const headers = requestInit?.headers as Record<string, string>;

    expect(headers).toBeDefined();
    expect(headers['Authorization']).toBe('Bearer valid-access-token-123');
    expect(headers['Accept']).toBe('application/json');
  });

  it('2. does not attach Bearer token to requests targeting external / third-party origins', async () => {
    setAccessToken('sensitive-jwt-token-456');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: async () => ({ external: true }),
    });
    globalThis.fetch = fetchMock;

    // استدعاء رابط خارجي اعتباطي
    await apiRequest('https://external-service.example.com/api/data');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, requestInit] = fetchMock.mock.calls[0];
    const headers = requestInit?.headers as Record<string, string>;

    expect(headers).toBeDefined();
    expect(headers['Authorization']).toBeUndefined();
  });

  it('3. isApiTarget accurately identifies API origin vs foreign origins', () => {
    // المسارات النسبية تتبع دائماً خادم الـ API عبر Vite proxy
    expect(isApiTarget('/api/v1/auth/me')).toBe(true);
    expect(isApiTarget('/api/v1/health')).toBe(true);

    // الروابط المسبوقة بنفس عنوان الـ API المعتمد
    if (API_BASE_URL) {
      expect(isApiTarget(`${API_BASE_URL}/api/v1/ready`)).toBe(true);
    }

    // النطاقات الخارجية المنفصلة لا تعتبر تابعة للـ API لمنع تسريب التوكن
    expect(isApiTarget('https://external-attacker.com/leak')).toBe(false);
    expect(isApiTarget('https://supabase.co/auth/v1')).toBe(false);
    expect(isApiTarget('http://malicious.org')).toBe(false);
  });
});
