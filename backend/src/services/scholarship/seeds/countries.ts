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
  // Top priority: Major English-speaking & developed nations
  { code: 'KE', name: 'Kenya', priority: 100 },
  { code: 'GB', name: 'United Kingdom', priority: 99 },
  { code: 'US', name: 'United States', priority: 98 },
  { code: 'CA', name: 'Canada', priority: 97 },
  { code: 'AU', name: 'Australia', priority: 96 },
  { code: 'NZ', name: 'New Zealand', priority: 95 },
  { code: 'IE', name: 'Ireland', priority: 94 },
  { code: 'ZA', name: 'South Africa', priority: 93 },

  // Western Europe
  { code: 'DE', name: 'Germany', priority: 92 },
  { code: 'FR', name: 'France', priority: 91 },
  { code: 'NL', name: 'Netherlands', priority: 90 },
  { code: 'BE', name: 'Belgium', priority: 89 },
  { code: 'SE', name: 'Sweden', priority: 88 },
  { code: 'NO', name: 'Norway', priority: 87 },
  { code: 'DK', name: 'Denmark', priority: 86 },
  { code: 'FI', name: 'Finland', priority: 85 },
  { code: 'AT', name: 'Austria', priority: 84 },
  { code: 'CH', name: 'Switzerland', priority: 83 },
  { code: 'ES', name: 'Spain', priority: 82 },
  { code: 'IT', name: 'Italy', priority: 81 },
  { code: 'PT', name: 'Portugal', priority: 80 },
  { code: 'GR', name: 'Greece', priority: 79 },
  { code: 'CZ', name: 'Czech Republic', priority: 78 },
  { code: 'PL', name: 'Poland', priority: 77 },
  { code: 'HU', name: 'Hungary', priority: 76 },
  { code: 'RO', name: 'Romania', priority: 75 },
  { code: 'LU', name: 'Luxembourg', priority: 74 },

  // Asia-Pacific
  { code: 'JP', name: 'Japan', priority: 73 },
  { code: 'KR', name: 'South Korea', priority: 72 },
  { code: 'SG', name: 'Singapore', priority: 71 },
  { code: 'HK', name: 'Hong Kong', priority: 70 },
  { code: 'CN', name: 'China', priority: 69 },
  { code: 'IN', name: 'India', priority: 68 },
  { code: 'MY', name: 'Malaysia', priority: 67 },
  { code: 'TH', name: 'Thailand', priority: 66 },
  { code: 'ID', name: 'Indonesia', priority: 65 },
  { code: 'PH', name: 'Philippines', priority: 64 },
  { code: 'VN', name: 'Vietnam', priority: 63 },
  { code: 'TW', name: 'Taiwan', priority: 62 },
  { code: 'PK', name: 'Pakistan', priority: 61 },
  { code: 'BD', name: 'Bangladesh', priority: 60 },
  { code: 'LK', name: 'Sri Lanka', priority: 59 },
  { code: 'NP', name: 'Nepal', priority: 58 },
  { code: 'BT', name: 'Bhutan', priority: 57 },
  { code: 'MV', name: 'Maldives', priority: 56 },

  // Middle East & Central Asia
  { code: 'AE', name: 'United Arab Emirates', priority: 55 },
  { code: 'SA', name: 'Saudi Arabia', priority: 54 },
  { code: 'QA', name: 'Qatar', priority: 53 },
  { code: 'BH', name: 'Bahrain', priority: 52 },
  { code: 'KW', name: 'Kuwait', priority: 51 },
  { code: 'OM', name: 'Oman', priority: 50 },
  { code: 'JO', name: 'Jordan', priority: 49 },
  { code: 'LB', name: 'Lebanon', priority: 48 },
  { code: 'IL', name: 'Israel', priority: 47 },
  { code: 'TR', name: 'Turkey', priority: 46 },
  { code: 'IR', name: 'Iran', priority: 45 },
  { code: 'IQ', name: 'Iraq', priority: 44 },
  { code: 'KZ', name: 'Kazakhstan', priority: 43 },
  { code: 'UZ', name: 'Uzbekistan', priority: 42 },
  { code: 'TJ', name: 'Tajikistan', priority: 41 },
  { code: 'KG', name: 'Kyrgyzstan', priority: 40 },

  // Africa
  { code: 'NG', name: 'Nigeria', priority: 39 },
  { code: 'ET', name: 'Ethiopia', priority: 38 },
  { code: 'EG', name: 'Egypt', priority: 37 },
  { code: 'GH', name: 'Ghana', priority: 36 },
  { code: 'UG', name: 'Uganda', priority: 35 },
  { code: 'TZ', name: 'Tanzania', priority: 34 },
  { code: 'RW', name: 'Rwanda', priority: 33 },
  { code: 'CM', name: 'Cameroon', priority: 32 },
  { code: 'SN', name: 'Senegal', priority: 31 },
  { code: 'MA', name: 'Morocco', priority: 30 },
  { code: 'TN', name: 'Tunisia', priority: 29 },
  { code: 'DZ', name: 'Algeria', priority: 28 },
  { code: 'CI', name: 'Côte d\'Ivoire', priority: 27 },
  { code: 'MZ', name: 'Mozambique', priority: 26 },
  { code: 'MW', name: 'Malawi', priority: 25 },
  { code: 'ZM', name: 'Zambia', priority: 24 },
  { code: 'ZW', name: 'Zimbabwe', priority: 23 },
  { code: 'BW', name: 'Botswana', priority: 22 },
  { code: 'NA', name: 'Namibia', priority: 21 },
  { code: 'GA', name: 'Gabon', priority: 20 },
  { code: 'KE', name: 'Kenya', priority: 19 },

  // Latin America & Caribbean
  { code: 'BR', name: 'Brazil', priority: 18 },
  { code: 'MX', name: 'Mexico', priority: 17 },
  { code: 'AR', name: 'Argentina', priority: 16 },
  { code: 'CL', name: 'Chile', priority: 15 },
  { code: 'CO', name: 'Colombia', priority: 14 },
  { code: 'PE', name: 'Peru', priority: 13 },
  { code: 'VE', name: 'Venezuela', priority: 12 },
  { code: 'EC', name: 'Ecuador', priority: 11 },
  { code: 'BO', name: 'Bolivia', priority: 10 },
  { code: 'PY', name: 'Paraguay', priority: 9 },
  { code: 'UY', name: 'Uruguay', priority: 8 },
  { code: 'CR', name: 'Costa Rica', priority: 7 },
  { code: 'PA', name: 'Panama', priority: 6 },
  { code: 'CU', name: 'Cuba', priority: 5 },
  { code: 'DO', name: 'Dominican Republic', priority: 4 },
  { code: 'JM', name: 'Jamaica', priority: 3 },
  { code: 'TT', name: 'Trinidad and Tobago', priority: 2 },

  // Eastern Europe & Russia
  { code: 'RU', name: 'Russia', priority: 1 },
  { code: 'UA', name: 'Ukraine', priority: 1 },
  { code: 'BY', name: 'Belarus', priority: 1 },
  { code: 'RS', name: 'Serbia', priority: 1 },
  { code: 'HR', name: 'Croatia', priority: 1 },
  { code: 'BA', name: 'Bosnia and Herzegovina', priority: 1 },
  { code: 'BG', name: 'Bulgaria', priority: 1 },
  { code: 'SK', name: 'Slovakia', priority: 1 },
  { code: 'SI', name: 'Slovenia', priority: 1 }
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
