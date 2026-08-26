import { env } from '../../../config/env';

/**
 * Rollout configuration (§7).
 *
 * Countries are data, not logic. Nothing in the pipeline branches on a country
 * name — this list only controls *what gets seeded and in what order*. Adding
 * Vietnam is a one-line edit here or an env override, never a code change.
 */

export interface CountryConfig {
  code: string;
  name: string;
  /** Higher = discovered and crawled first */
  priority: number;
  /** Site-search hints used by the link-discovery provider */
  directoryHints?: string[];
}

export const ROLLOUT_COUNTRIES: CountryConfig[] = [
  { code: 'KE', name: 'Kenya', priority: 100 },
  { code: 'GB', name: 'United Kingdom', priority: 95 },
  { code: 'US', name: 'United States', priority: 90 },
  { code: 'CA', name: 'Canada', priority: 85 },
  { code: 'AU', name: 'Australia', priority: 80 },
  { code: 'DE', name: 'Germany', priority: 78 },
  { code: 'NL', name: 'Netherlands', priority: 76 },
  { code: 'IE', name: 'Ireland', priority: 74 },
  { code: 'SE', name: 'Sweden', priority: 72 },
  { code: 'NO', name: 'Norway', priority: 70 },
  { code: 'FI', name: 'Finland', priority: 68 },
  { code: 'DK', name: 'Denmark', priority: 66 },
  { code: 'NZ', name: 'New Zealand', priority: 64 },
  { code: 'JP', name: 'Japan', priority: 62 },
  { code: 'KR', name: 'South Korea', priority: 60 },
  { code: 'CN', name: 'China', priority: 58 },
  { code: 'SG', name: 'Singapore', priority: 56 }
];

/**
 * Active countries for this deployment.
 * `UNIVERSITY_DISCOVERY_COUNTRIES=KE,GB,US` narrows the rollout without a deploy.
 */
export function activeCountries(): CountryConfig[] {
  const override = env.UNIVERSITY_DISCOVERY_COUNTRIES;
  if (!override) return [...ROLLOUT_COUNTRIES].sort((a, b) => b.priority - a.priority);
  const wanted = override.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
  return ROLLOUT_COUNTRIES
    .filter((c) => wanted.includes(c.code))
    .sort((a, b) => b.priority - a.priority);
}
