import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() { return this.store.size; }
  clear() { this.store.clear(); }
  getItem(key: string) { return this.store.get(key) ?? null; }
  key(index: number) { return Array.from(this.store.keys())[index] ?? null; }
  removeItem(key: string) { this.store.delete(key); }
  setItem(key: string, value: string) { this.store.set(key, String(value)); }
}

if (typeof window !== 'undefined' && (!window.localStorage || !window.localStorage.clear)) {
  const mem = new MemoryStorage();
  Object.defineProperty(window, 'localStorage', {
    value: mem,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  cleanup();
});
