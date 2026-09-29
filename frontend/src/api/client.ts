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

async function fetchWithRefresh(path: string, init: RequestInit = {}): Promise<Response> {
  let res = await doFetch(path, init);
  if (res.status === 401 && path !== '/auth/login' && path !== '/auth/logout' && path !== '/auth/refresh') {
    try {
      await ensureFreshSession();
      res = await doFetch(path, init);
    } catch { }
  }
  return res;
}

/**
 * Authenticated file download. Fetched rather than linked with <a href> so
 * the same cookie/refresh handling applies when the API is on another origin.
 */
export async function apiDownload(path: string, filename: string): Promise<void> {
  const res = await fetchWithRefresh(path);
  if (!res.ok) {
    const text = await res.text();
    let message = `Download failed (${res.status})`;
    try { message = JSON.parse(text)?.error ?? message; } catch { }
    throw new Error(message);
  }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetchWithRefresh(path, init);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data as T;
}
