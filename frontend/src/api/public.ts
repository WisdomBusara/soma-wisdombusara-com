/**
 * Client for the /public marketing API — plans and aggregate stats for
 * products that don't have their own dedicated site section (e.g. Jobs and
 * Tenders, which are WhatsApp-first and don't need a paywalled API client
 * like api/scholarships.ts has).
 *
 * No credentials: this is a read-only, CORS-open, unauthenticated surface.
 */

const PUBLIC_BASE =
  (import.meta.env.VITE_PUBLIC_MARKETING_BASE_URL as string | undefined) ?? '/public';

export async function publicMarketingFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${PUBLIC_BASE}${path}`);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(data?.message ?? data?.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export interface PublicPlan {
  id: string;
  name: string;
  description: string;
  amount: number;
  currency: string;
  durationMinutes: number;
  isTrial: boolean;
  vertical: 'scholarships' | 'jobs' | 'tenders';
}

export interface JobsOverview {
  jobs: { sourceCount: number; itemCount: number };
  tenders: { sourceCount: number; itemCount: number };
}

export function durationLabel(mins: number): string {
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  if (mins < 60 * 24) {
    const hours = Math.round(mins / 60);
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const days = Math.round(mins / (60 * 24));
  return `${days} day${days === 1 ? '' : 's'}`;
}
