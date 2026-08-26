import type {
  StudyMode,
  AttendanceMode,
  DeliveryMode
} from '../../../models/scholarship/types';

/**
 * Study mode / attendance / delivery (§14).
 *
 * The governing rule: *never infer*. A campus university is not evidence that
 * a given scholarship is on-campus — plenty of them fund distance learners.
 * If the page does not say, the answer is UNKNOWN and stays UNKNOWN.
 *
 * Each extractor therefore returns UNKNOWN unless it matched actual wording,
 * and hands back the matched sentence as evidence.
 */

export interface ModeMatch<T> {
  values: T[];
  evidence: string[];
  confidence: number;
}

function empty<T>(fallback: T): ModeMatch<T> {
  return { values: [fallback], evidence: [], confidence: 0 };
}

function snippet(text: string, index: number, len: number): string {
  const s = Math.max(0, index - 80);
  const e = Math.min(text.length, index + len + 80);
  return text.slice(s, e).replace(/\s+/g, ' ').trim();
}

function scan<T>(
  text: string,
  rules: { value: T; pattern: RegExp }[]
): { values: T[]; evidence: string[] } {
  const values: T[] = [];
  const evidence: string[] = [];
  for (const { value, pattern } of rules) {
    const m = pattern.exec(text);
    if (m && !values.includes(value)) {
      values.push(value);
      evidence.push(snippet(text, m.index, m[0].length));
    }
  }
  return { values, evidence };
}

// ── Study mode ──────────────────────────────────────────────────────────────

const STUDY_RULES: { value: StudyMode; pattern: RegExp }[] = [
  { value: 'HYBRID', pattern: /\b(hybrid|blended\s+(?:learning|delivery|mode)|mixed\s+mode)\b/i },
  { value: 'DISTANCE', pattern: /\b(distance\s+learning|distance\s+education|by\s+distance|correspondence)\b/i },
  { value: 'ONLINE', pattern: /\b(online|fully\s+online|e-?learning|virtual\s+(?:study|delivery|classroom)|remote\s+(?:study|learning))\b/i },
  { value: 'ON_CAMPUS', pattern: /\b(on[-\s]?campus|in[-\s]?person\s+(?:study|attendance)|campus[-\s]based|face[-\s]to[-\s]face|attend\s+in\s+person)\b/i }
];

export function extractStudyMode(text: string | null | undefined): ModeMatch<StudyMode> {
  if (!text) return empty<StudyMode>('UNKNOWN');
  const { values, evidence } = scan<StudyMode>(String(text), STUDY_RULES);
  if (values.length === 0) return empty<StudyMode>('UNKNOWN');
  return { values, evidence, confidence: 0.85 };
}

// ── Attendance ──────────────────────────────────────────────────────────────

const ATTENDANCE_RULES: { value: AttendanceMode; pattern: RegExp }[] = [
  // "full-time or part-time" / "full and part time" collapses to BOTH
  { value: 'BOTH', pattern: /\bfull[-\s]?time\s*(?:\/|,|\bor\b|\band\b)\s*part[-\s]?time\b|\bpart[-\s]?time\s*(?:\/|,|\bor\b|\band\b)\s*full[-\s]?time\b|\bfull\s+and\s+part[-\s]?time\b/i },
  { value: 'FULL_TIME', pattern: /\bfull[-\s]?time\b/i },
  { value: 'PART_TIME', pattern: /\bpart[-\s]?time\b/i }
];

export function extractAttendance(text: string | null | undefined): ModeMatch<AttendanceMode> {
  if (!text) return empty<AttendanceMode>('UNKNOWN');
  const haystack = String(text);
  const both = ATTENDANCE_RULES[0].pattern.exec(haystack);
  if (both) {
    return { values: ['BOTH'], evidence: [snippet(haystack, both.index, both[0].length)], confidence: 0.9 };
  }
  const { values, evidence } = scan<AttendanceMode>(haystack, ATTENDANCE_RULES.slice(1));
  if (values.length === 0) return empty<AttendanceMode>('UNKNOWN');
  // Both matched separately in different sentences — still BOTH, lower confidence
  if (values.length === 2) return { values: ['BOTH'], evidence, confidence: 0.65 };
  return { values, evidence, confidence: 0.85 };
}

// ── Delivery ────────────────────────────────────────────────────────────────

const DELIVERY_RULES: { value: DeliveryMode; pattern: RegExp }[] = [
  { value: 'MIXED', pattern: /\b(hybrid|blended|mixed\s+mode)\b/i },
  { value: 'REMOTE', pattern: /\b(remote(?:ly)?|online|virtual|distance)\b/i },
  { value: 'IN_PERSON', pattern: /\b(in[-\s]?person|on[-\s]?campus|face[-\s]to[-\s]face)\b/i }
];

export function extractDeliveryMode(text: string | null | undefined): ModeMatch<DeliveryMode> {
  if (!text) return empty<DeliveryMode>('UNKNOWN');
  const { values, evidence } = scan<DeliveryMode>(String(text), DELIVERY_RULES);
  if (values.length === 0) return empty<DeliveryMode>('UNKNOWN');
  return { values, evidence, confidence: 0.8 };
}

export function studyModeLabel(m: StudyMode): string {
  return { ON_CAMPUS: 'On campus', ONLINE: 'Online', HYBRID: 'Hybrid', DISTANCE: 'Distance', UNKNOWN: 'Not stated' }[m];
}
export function attendanceLabel(m: AttendanceMode): string {
  return { FULL_TIME: 'Full-time', PART_TIME: 'Part-time', BOTH: 'Full or part-time', UNKNOWN: 'Not stated' }[m];
}
