import type { FundingType, Certainty } from '../../../models/scholarship/types';

/**
 * Funding extraction (§15, §16).
 *
 * Three rules drive the design:
 *
 *  1. Absent ≠ false. A page that never mentions accommodation yields `null`,
 *     not `false`. Only an explicit negation ("does not cover accommodation")
 *     yields `false`.
 *  2. No currency conversion, ever. Amount + currency + the original wording
 *     are stored side by side and left alone.
 *  3. FULLY_FUNDED is only asserted when the page says so or when tuition AND
 *     a living stipend are both explicitly covered. Two out of three is
 *     PARTIALLY_FUNDED.
 */

export interface FundingFlag {
  value: boolean | null;
  certainty: Certainty;
  confidence: number;
  sourceText?: string;
}

export interface MoneyValue {
  amount: number | null;
  currency: string | null;
  period: string | null;
  originalText: string | null;
  confidence: number;
  certainty: Certainty;
}

export interface FundingExtraction {
  types: FundingType[];
  primaryType: FundingType;
  primaryTypeCertainty: Certainty;
  tuitionCovered: FundingFlag;
  tuitionPercentage: { value: number | null; sourceText?: string; confidence: number };
  livingStipend: FundingFlag;
  stipendAmount: MoneyValue;
  travelCovered: FundingFlag;
  airfareCovered: FundingFlag;
  accommodationCovered: FundingFlag;
  healthInsurance: FundingFlag;
  researchAllowance: FundingFlag;
  booksAllowance: FundingFlag;
  equipmentAllowance: FundingFlag;
  applicationFeeWaiver: FundingFlag;
  visaSupport: FundingFlag;
  awardCount: { value: number | null; sourceText?: string; confidence: number };
  rawFundingText: string[];
}

const NEG = String.raw`(?:not?\b|does\s+not|doesn'?t|will\s+not|won'?t|no\b|excluded|excludes|without|are\s+not|is\s+not)`;

/** Sentence-splitting that tolerates the bullet soup universities publish. */
function sentences(text: string): string[] {
  return String(text || '')
    .split(/(?<=[.!?;:])\s+|\n+|(?:\s[•·▪‣–—]\s)/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 2 && s.length < 600);
}

const unknownFlag = (): FundingFlag => ({ value: null, certainty: 'UNKNOWN', confidence: 0 });

/**
 * Look for `pattern` and decide positive vs negative from local context.
 *
 * Negation is checked only within the same sentence and only *before* the
 * match (or immediately after, for "X is not covered"). Scanning the whole
 * document for "not" would flip almost every flag on a long page.
 */
function detectFlag(text: string, pattern: RegExp): FundingFlag {
  for (const s of sentences(text)) {
    const m = pattern.exec(s);
    if (!m) continue;

    const before = s.slice(0, m.index);
    const after = s.slice(m.index + m[0].length);
    const negBefore = new RegExp(`${NEG}\\s+(?:\\w+\\s+){0,3}$`, 'i').test(before);
    const negAfter = new RegExp(`^\\s*(?:\\w+\\s+){0,3}(?:is|are|will\\s+be)?\\s*${NEG}`, 'i').test(after);

    if (negBefore || negAfter) {
      return { value: false, certainty: 'NEGATIVE', confidence: 0.8, sourceText: s };
    }
    // Hedged language stays PROBABLE — "may include a stipend" is not a promise
    const hedged = /\b(may|might|could|possibly|potentially|in\s+some\s+cases|where\s+applicable|subject\s+to)\b/i.test(s);
    return {
      value: true,
      certainty: hedged ? 'PROBABLE' : 'CONFIRMED',
      confidence: hedged ? 0.55 : 0.9,
      sourceText: s
    };
  }
  return unknownFlag();
}

// ── Money ───────────────────────────────────────────────────────────────────

const CURRENCY_SYMBOLS: Record<string, string> = {
  '£': 'GBP', '$': 'USD', '€': 'EUR', '¥': 'JPY', '₹': 'INR', 'KSh': 'KES', 'R': 'ZAR'
};
const CURRENCY_CODES = /\b(GBP|USD|EUR|CAD|AUD|NZD|JPY|CNY|KRW|SGD|SEK|NOK|DKK|CHF|KES|ZAR|NGN|INR)\b/;

const PERIOD_RE = /\b(per\s+(?:year|annum|month|week|semester|term)|p\.?a\.?|annually|monthly|yearly|each\s+year|per\s+academic\s+year)\b/i;

const AMOUNT_RE =
  /(?:(£|\$|€|¥|₹|KSh|R)\s?|\b(GBP|USD|EUR|CAD|AUD|NZD|JPY|CNY|KRW|SGD|SEK|NOK|DKK|CHF|KES|ZAR|NGN|INR)\s+)?(\d{1,3}(?:[,\s]\d{3})+(?:\.\d{1,2})?|\d{4,}(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?\s*(?:k|thousand|million|m)\b)/i;

const noMoney = (): MoneyValue => ({
  amount: null, currency: null, period: null, originalText: null, confidence: 0, certainty: 'UNKNOWN'
});

/**
 * Parse a money amount near a keyword.
 *
 * Currency is only reported when the text actually carried a symbol or code.
 * We never assume "the university is British therefore £".
 */
export function parseMoney(text: string): MoneyValue {
  const m = AMOUNT_RE.exec(text);
  if (!m) return noMoney();

  const [full, symbol, code, rawNumber] = m;
  let amount = Number(rawNumber.replace(/[,\s]/g, '').replace(/(k|thousand|million|m)$/i, ''));
  if (/\b(k|thousand)\b|k$/i.test(rawNumber)) amount *= 1_000;
  if (/\b(million|m)\b|m$/i.test(rawNumber) && !/\bkm\b/i.test(rawNumber)) amount *= 1_000_000;
  if (!Number.isFinite(amount)) return noMoney();

  let currency: string | null = null;
  if (code) currency = code.toUpperCase();
  else if (symbol) currency = CURRENCY_SYMBOLS[symbol] ?? null;
  else {
    const nearby = CURRENCY_CODES.exec(text);
    if (nearby) currency = nearby[1].toUpperCase();
  }

  const periodMatch = PERIOD_RE.exec(text);

  return {
    amount,
    currency,
    period: periodMatch ? periodMatch[0].toLowerCase() : null,
    originalText: text.slice(0, 300).trim(),
    // A bare number with no currency marker is weak evidence
    confidence: currency ? 0.85 : 0.5,
    certainty: currency ? 'CONFIRMED' : 'PROBABLE'
  };
}

/** Find a money amount in the sentence that mentions `keyword`. */
function moneyNear(text: string, keyword: RegExp): MoneyValue {
  for (const s of sentences(text)) {
    if (!keyword.test(s)) continue;
    const money = parseMoney(s);
    if (money.amount !== null) return money;
  }
  return noMoney();
}

// ── Main extractor ──────────────────────────────────────────────────────────

const P = {
  tuition: /\b(tuition|tuition\s+fees?|course\s+fees?|full\s+fees?|fee[s]?\s+(?:are\s+)?(?:covered|paid|waived)|fee\s+waiver)\b/i,
  fullyFunded: /\b(fully[-\s]funded|full\s+scholarship|covers\s+all\s+costs|100%\s+(?:of\s+)?(?:the\s+)?(?:tuition|fees|costs))\b/i,
  partial: /\b(partial(?:ly)?[-\s]funded|partial\s+(?:scholarship|award|funding)|contribution\s+towards)\b/i,
  stipend: /\b(stipend|living\s+(?:allowance|costs?|expenses?|stipend)|maintenance\s+(?:grant|allowance|loan)|monthly\s+allowance|subsistence)\b/i,
  travel: /\b(travel\s+(?:costs?|allowance|grant|expenses?|award)|transport\s+allowance)\b/i,
  airfare: /\b(airfare|air\s+ticket|flight[s]?\s+(?:costs?|are\s+covered|covered)|return\s+(?:flight|airfare))\b/i,
  accommodation: /\b(accommodation|housing\s+(?:allowance|costs?)|hall[s]?\s+of\s+residence|lodging|hostel\s+fees?)\b/i,
  health: /\b(health\s+insurance|medical\s+(?:insurance|cover(?:age)?)|health\s+cover(?:age)?)\b/i,
  research: /\b(research\s+(?:allowance|costs?|grant|training\s+support|expenses?)|bench\s+fees?|RTSG)\b/i,
  books: /\b(book\s+allowance|books?\s+and\s+(?:materials|supplies)|study\s+materials)\b/i,
  equipment: /\b(equipment\s+(?:allowance|grant)|laptop\s+(?:allowance|provided)|computer\s+allowance)\b/i,
  appFee: /\b(application\s+fee\s+(?:waiver|waived|is\s+waived)|no\s+application\s+fee|fee\s+waiver\s+for\s+application)\b/i,
  visa: /\b(visa\s+(?:costs?|fees?|support|application\s+fee)|immigration\s+health\s+surcharge|IHS)\b/i,
  merit: /\b(merit[-\s]based|academic\s+merit|based\s+on\s+(?:academic\s+)?(?:merit|excellence|achievement))\b/i,
  need: /\b(need[-\s]based|financial\s+need|means[-\s]tested|demonstrated\s+need)\b/i,
  sports: /\b(sport(?:s|ing)?\s+scholarship|athletic\s+scholarship)\b/i,
  government: /\b(government\s+(?:scholarship|funded|scheme)|ministry\s+of\s+(?:education|higher)|state[-\s]funded|national\s+scholarship)\b/i,
  fellowship: /\b(fellowship|fellow\b)/i
};

export function extractFunding(text: string | null | undefined, sourceUrl?: string): FundingExtraction {
  const haystack = String(text || '');

  const tuitionCovered = detectFlag(haystack, P.tuition);
  const livingStipend = detectFlag(haystack, P.stipend);
  const travelCovered = detectFlag(haystack, P.travel);
  const airfareCovered = detectFlag(haystack, P.airfare);
  const accommodationCovered = detectFlag(haystack, P.accommodation);
  const healthInsurance = detectFlag(haystack, P.health);
  const researchAllowance = detectFlag(haystack, P.research);
  const booksAllowance = detectFlag(haystack, P.books);
  const equipmentAllowance = detectFlag(haystack, P.equipment);
  const applicationFeeWaiver = detectFlag(haystack, P.appFee);
  const visaSupport = detectFlag(haystack, P.visa);

  const stipendAmount = moneyNear(haystack, P.stipend);

  // Tuition percentage — "covers 50% of tuition fees"
  let tuitionPercentage: FundingExtraction['tuitionPercentage'] = { value: null, confidence: 0 };
  for (const s of sentences(haystack)) {
    if (!P.tuition.test(s)) continue;
    const pm = /(\d{1,3})\s?%/.exec(s);
    if (pm) {
      const pct = Number(pm[1]);
      if (pct >= 1 && pct <= 100) {
        tuitionPercentage = { value: pct, sourceText: s, confidence: 0.85 };
        break;
      }
    }
  }

  // Number of awards — "up to 15 scholarships are available"
  let awardCount: FundingExtraction['awardCount'] = { value: null, confidence: 0 };
  for (const s of sentences(haystack)) {
    const am = /\b(?:up\s+to\s+)?(\d{1,4})\s+(?:scholarships?|awards?|studentships?|places?|fellowships?)\s+(?:are\s+|will\s+be\s+|is\s+)?(?:available|offered|awarded|on\s+offer)/i.exec(s);
    if (am) {
      awardCount = { value: Number(am[1]), sourceText: s, confidence: 0.8 };
      break;
    }
  }

  // ── Type synthesis ────────────────────────────────────────────────────────
  const types = new Set<FundingType>();
  let primaryType: FundingType = 'UNKNOWN';
  let primaryTypeCertainty: Certainty = 'UNKNOWN';

  const saysFullyFunded = P.fullyFunded.test(haystack);
  const saysPartial = P.partial.test(haystack);

  if (saysFullyFunded) {
    types.add('FULLY_FUNDED');
    primaryType = 'FULLY_FUNDED';
    primaryTypeCertainty = 'CONFIRMED';
  } else if (tuitionCovered.value === true && livingStipend.value === true) {
    // Both explicitly covered — a defensible FULLY_FUNDED, but derived, so it
    // is only ever PROBABLE.
    types.add('FULLY_FUNDED');
    types.add('TUITION_PLUS_STIPEND');
    primaryType = 'FULLY_FUNDED';
    primaryTypeCertainty = 'PROBABLE';
  } else if (saysPartial) {
    types.add('PARTIALLY_FUNDED');
    primaryType = 'PARTIALLY_FUNDED';
    primaryTypeCertainty = 'CONFIRMED';
  } else if (tuitionCovered.value === true) {
    types.add('TUITION_ONLY');
    primaryType = 'TUITION_ONLY';
    primaryTypeCertainty = tuitionCovered.certainty;
  } else if (livingStipend.value === true) {
    types.add('LIVING_STIPEND');
    primaryType = 'LIVING_STIPEND';
    primaryTypeCertainty = livingStipend.certainty;
  }

  if (tuitionCovered.value === true && livingStipend.value === true) types.add('TUITION_PLUS_STIPEND');
  if (livingStipend.value === true) types.add('LIVING_STIPEND');
  if (travelCovered.value === true || airfareCovered.value === true) types.add('TRAVEL_GRANT');
  if (accommodationCovered.value === true) types.add('ACCOMMODATION');
  if (applicationFeeWaiver.value === true) types.add('APPLICATION_FEE_WAIVER');
  if (researchAllowance.value === true) types.add('RESEARCH_FUNDING');
  if (P.merit.test(haystack)) types.add('MERIT_BASED');
  if (P.need.test(haystack)) types.add('NEED_BASED');
  if (P.sports.test(haystack)) types.add('SPORTS');
  if (P.government.test(haystack)) types.add('GOVERNMENT');
  if (P.fellowship.test(haystack)) types.add('FELLOWSHIP');

  const rawFundingText = sentences(haystack)
    .filter((s) => P.tuition.test(s) || P.stipend.test(s) || P.fullyFunded.test(s) || P.partial.test(s))
    .slice(0, 12);

  const attach = (f: FundingFlag): FundingFlag => (f.sourceText ? { ...f } : f);

  return {
    types: [...types],
    primaryType,
    primaryTypeCertainty,
    tuitionCovered: attach(tuitionCovered),
    tuitionPercentage,
    livingStipend: attach(livingStipend),
    stipendAmount,
    travelCovered: attach(travelCovered),
    airfareCovered: attach(airfareCovered),
    accommodationCovered: attach(accommodationCovered),
    healthInsurance: attach(healthInsurance),
    researchAllowance: attach(researchAllowance),
    booksAllowance: attach(booksAllowance),
    equipmentAllowance: attach(equipmentAllowance),
    applicationFeeWaiver: attach(applicationFeeWaiver),
    visaSupport: attach(visaSupport),
    awardCount,
    rawFundingText
  };
}

export const _internal = { sentences, detectFlag, moneyNear };
