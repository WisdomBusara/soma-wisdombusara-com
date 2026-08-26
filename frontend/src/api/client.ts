function getCookie(name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.DEV ? '/api' : '/api');

let refreshInFlight: Promise<void> | null = null;

async function doFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = `${API_BASE_URL}${path}`;
  const headers = new Headers(init.headers ?? {});
  if (!headers.has('Content-Type') && init.body) headers.set('Content-Type', 'application/json');
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const csrf = getCookie('wraith_csrf');
    if (csrf) headers.set('X-CSRF-Token', csrf);
  }
  return fetch(url, { ...init, headers, credentials: 'include' });
}

async function ensureFreshSession(): Promise<void> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      const res = await doFetch('/auth/refresh', { method: 'POST' });
      if (!res.ok) throw new Error('Refresh failed');
    })().finally(() => { refreshInFlight = null; });
  }
  await refreshInFlight;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await doFetch(path, init);
  if (res.status === 401 && path !== '/auth/login' && path !== '/auth/logout' && path !== '/auth/refresh') {
    try {
      await ensureFreshSession();
      res = await doFetch(path, init);
    } catch { }
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data as T;
}
