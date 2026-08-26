import type { DeadlineKind, Certainty } from '../../../models/scholarship/types';

/**
 * Deadline parsing (§57).
 *
 * Design notes worth knowing before changing anything here:
 *
 *  • The original wording is ALWAYS preserved. "Applications close at 23:59
 *    GMT on 15 January 2027" carries information a Date cannot.
 *  • Timezone is never assumed. If the page does not state one, `timezoneStated`
 *    is null and the Date is constructed in UTC at end-of-day — a deliberate,
 *    documented convention rather than a silent guess at the reader's zone.
 *  • Numeric dates like 05/01/2027 are genuinely ambiguous. We resolve using
 *    the country of the source (US → MM/DD, everywhere else → DD/MM) and drop
 *    confidence to reflect that it was a resolution, not a reading.
 *  • ROLLING and UNKNOWN are first-class results, not parse failures.
 */

export interface DeadlineResult {
  kind: DeadlineKind;
  date: Date | null;
  additionalDates: Date[];
  originalText: string | null;
  timezoneStated: string | null;
  confidence: number;
  certainty: Certainty;
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11
};

const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

// "15 January 2027" / "15th Jan 2027"
const DMY_RE = new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(${MONTH_ALT})\.?,?\s+(\d{4})\b`, 'i');
// "January 15, 2027" / "Jan 15 2027"
const MDY_RE = new RegExp(String.raw`\b(${MONTH_ALT})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b`, 'i');
// ISO "2027-01-15"
const ISO_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
// Numeric "15/01/2027" or "15.01.2027"
const NUM_RE = /\b(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})\b/;

const TZ_RE = /\b(GMT|UTC|BST|CET|CEST|EST|EDT|PST|PDT|EAT|IST|JST|KST|AEST|AEDT|NZST|SGT|CST)\b/;
const TIME_RE = /\b(\d{1,2})[:.](\d{2})\s*(am|pm|hrs|hours)?\b/i;

const ROLLING_RE = /\b(rolling\s+(?:basis|admission|deadline|application)|no\s+(?:fixed|specific|set)\s+deadline|applications?\s+(?:are\s+)?(?:accepted|open)\s+(?:all\s+year|year[-\s]round|continuously|throughout\s+the\s+year)|open\s+until\s+filled|until\s+(?:all\s+)?(?:places|positions)\s+are\s+filled|ongoing\s+(?:intake|recruitment))\b/i;

const MULTI_ROUND_RE = /\b(round\s+[123one two three]|first\s+round|second\s+round|third\s+round|deadline\s+\d\b|application\s+rounds?|multiple\s+(?:deadlines|rounds)|intake\s+[12]\b)\b/i;

const DEADLINE_CUE_RE = /\b(deadline|closing\s+date|clos(?:es|ing|e)|applications?\s+(?:close|must\s+be\s+(?:received|submitted)|due)|apply\s+(?:by|before)|submit\s+by|due\s+(?:by|date)|final\s+date|last\s+date|no\s+later\s+than|on\s+or\s+before|open\s+until)\b/i;

function sentences(text: string): string[] {
  return String(text || '')
    .split(/(?<=[.!?;])\s+|\n+|(?:\s[•·▪‣–—]\s)/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 3 && s.length < 500);
}

function mkDate(y: number, m: number, d: number): Date | null {
  if (y < 1990 || y > 2100) return null;
  if (m < 0 || m > 11) return null;
  if (d < 1 || d > 31) return null;
  // End of day UTC — documented convention when no timezone is stated
  const dt = new Date(Date.UTC(y, m, d, 23, 59, 59, 999));
  if (dt.getUTCMonth() !== m || dt.getUTCDate() !== d) return null; // 31 Feb etc.
  return dt;
}

interface ParsedDate {
  date: Date;
  confidence: number;
  ambiguous: boolean;
}

/**
 * Parse the first date in a string.
 * `countryCode` disambiguates numeric formats only; it never invents a date.
 */
export function parseDateString(text: string, countryCode?: string | null): ParsedDate | null {
  const s = String(text || '');

  let m = DMY_RE.exec(s);
  if (m) {
    const d = mkDate(Number(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1]));
    if (d) return { date: d, confidence: 0.95, ambiguous: false };
  }

  m = MDY_RE.exec(s);
  if (m) {
    const d = mkDate(Number(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2]));
    if (d) return { date: d, confidence: 0.95, ambiguous: false };
  }

  m = ISO_RE.exec(s);
  if (m) {
    const d = mkDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (d) return { date: d, confidence: 0.95, ambiguous: false };
  }

  m = NUM_RE.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    let year = Number(m[3]);
    if (year < 100) year += year < 50 ? 2000 : 1900;

    // Unambiguous cases first
    if (a > 12 && b <= 12) {
      const d = mkDate(year, b - 1, a);
      if (d) return { date: d, confidence: 0.9, ambiguous: false };
    }
    if (b > 12 && a <= 12) {
      const d = mkDate(year, a - 1, b);
      if (d) return { date: d, confidence: 0.9, ambiguous: false };
    }
    // Genuinely ambiguous — fall back to source locale, flag it, cut confidence
    const usStyle = String(countryCode || '').toUpperCase() === 'US';
    const d = usStyle ? mkDate(year, a - 1, b) : mkDate(year, b - 1, a);
    if (d) return { date: d, confidence: 0.55, ambiguous: true };
  }

  return null;
}

const unknown = (): DeadlineResult => ({
  kind: 'UNKNOWN', date: null, additionalDates: [], originalText: null,
  timezoneStated: null, confidence: 0, certainty: 'UNKNOWN'
});

/**
 * Extract the application deadline from page text.
 *
 * Strategy: prefer sentences that contain an explicit deadline cue. Only fall
 * back to "any date on the page" if none exist — and then at much lower
 * confidence, because a bare date is as likely to be a start date, a term date
 * or a news timestamp.
 */
export function extractDeadline(
  text: string | null | undefined,
  opts: { countryCode?: string | null; now?: Date } = {}
): DeadlineResult {
  const haystack = String(text || '');
  if (!haystack.trim()) return unknown();

  const cueSentences = sentences(haystack).filter((s) => DEADLINE_CUE_RE.test(s));

  // Rolling must be checked against deadline-cue context so that unrelated
  // prose ("rolling admissions for our MBA") doesn't hijack a fixed date.
  const rollingHit = cueSentences.find((s) => ROLLING_RE.test(s))
    ?? (ROLLING_RE.test(haystack) ? sentences(haystack).find((s) => ROLLING_RE.test(s)) : undefined);

  const dated: { date: Date; text: string; confidence: number; ambiguous: boolean }[] = [];
  for (const s of cueSentences) {
    const p = parseDateString(s, opts.countryCode);
    if (p) dated.push({ date: p.date, text: s, confidence: p.confidence, ambiguous: p.ambiguous });
  }

  if (dated.length === 0) {
    if (rollingHit) {
      return {
        kind: 'ROLLING', date: null, additionalDates: [], originalText: rollingHit,
        timezoneStated: null, confidence: 0.8, certainty: 'CONFIRMED'
      };
    }
    // Last resort: a date anywhere, but say so with low confidence
    const anySentence = sentences(haystack).find((s) => parseDateString(s, opts.countryCode));
    if (anySentence) {
      const p = parseDateString(anySentence, opts.countryCode)!;
      return {
        kind: 'FIXED', date: p.date, additionalDates: [], originalText: anySentence,
        timezoneStated: TZ_RE.exec(anySentence)?.[1] ?? null,
        confidence: Math.min(0.4, p.confidence), certainty: 'PROBABLE'
      };
    }
    return unknown();
  }

  // Multiple distinct dates behind deadline cues → application rounds
  const unique = dated.filter(
    (d, i, arr) => arr.findIndex((o) => o.date.getTime() === d.date.getTime()) === i
  );
  unique.sort((a, b) => a.date.getTime() - b.date.getTime());

  const multiRound = unique.length > 1 && MULTI_ROUND_RE.test(haystack);
  const now = opts.now ?? new Date();

  // The operative deadline is the next one that has not passed; if all have
  // passed, the last one (so CLOSED status computes correctly).
  const future = unique.filter((d) => d.date.getTime() >= now.getTime());
  const primary = future.length > 0 ? future[0] : unique[unique.length - 1];

  const tz = TZ_RE.exec(primary.text)?.[1] ?? null;
  const time = TIME_RE.exec(primary.text);
  let date = primary.date;
  if (time) {
    let hh = Number(time[1]);
    const mm = Number(time[2]);
    const ap = time[3]?.toLowerCase();
    if (ap === 'pm' && hh < 12) hh += 12;
    if (ap === 'am' && hh === 12) hh = 0;
    if (hh <= 23 && mm <= 59) {
      date = new Date(Date.UTC(
        primary.date.getUTCFullYear(), primary.date.getUTCMonth(), primary.date.getUTCDate(), hh, mm, 0, 0
      ));
    }
  }

  return {
    kind: multiRound ? 'MULTIPLE_ROUNDS' : rollingHit ? 'ROLLING' : 'FIXED',
    date,
    additionalDates: unique.filter((d) => d !== primary).map((d) => d.date),
    originalText: primary.text,
    timezoneStated: tz,
    confidence: primary.ambiguous ? Math.min(primary.confidence, 0.55) : primary.confidence,
    certainty: primary.ambiguous ? 'PROBABLE' : 'CONFIRMED'
  };
}
