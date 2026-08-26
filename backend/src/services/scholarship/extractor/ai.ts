import axios from 'axios';
import { env } from '../../../config/env';
import { logger } from '../../../config/logger';
import { validateAiOutput, type AiExtraction } from './schema';

/**
 * AI extraction (§20, §21, §53).
 *
 * The AI is an extraction/classification *layer*. It never crawls, never
 * decides what to fetch, and never writes to the database directly. It reads
 * text that the deterministic pipeline already fetched, and returns JSON that
 * must survive schema validation before anything touches Mongo.
 *
 * Cost control is structural, not advisory: callers only reach this module
 * after cheap rule-based classification has already decided the page is a
 * plausible scholarship, and a per-run call budget caps the blast radius of a
 * misconfigured crawl.
 */

// ── §21: the anti-hallucination contract ────────────────────────────────────

export const EXTRACTION_SYSTEM_PROMPT = `You are a precise information extraction system for university scholarship pages.

ABSOLUTE RULES — these override any instinct to be helpful:

1. Only extract information explicitly supported by the supplied source text.
2. Do not guess. Do not infer. Do not use outside knowledge about the institution.
3. If a field is absent from the source, return null — never a plausible default.
4. "Unknown" and "false" are DIFFERENT. If the page never mentions IELTS, return
   required: null. Only return required: false if the page explicitly says no
   English test is required or that it is waived.
5. Never convert vague language into precise values. "may be eligible" is not
   "eligible". "generous funding" is not a stipend amount. "covers most costs"
   is not fully funded.
6. Preserve original wording in the evidence field, verbatim, exactly as written.
7. Every non-null assertion MUST carry an evidence string quoting the source
   sentence it came from. An assertion with no evidence is invalid output.
8. Return a confidence score (0-1) and a certainty label for each field:
   - CONFIRMED: the page states it directly and unambiguously
   - PROBABLE:  the page implies it, or hedges ("may", "typically", "usually")
   - UNKNOWN:   the page does not address it
   - NEGATIVE:  the page explicitly denies/excludes it
9. "International students" means applicants who are not domestic. It does NOT
   mean all countries. Only populate eligibility.countries when the page names
   specific countries. Use ISO-3166 alpha-2 codes.
10. Dates must be returned as ISO-8601 (YYYY-MM-DD) or null. Never a natural
    language date. Do not assume a timezone that is not stated.
11. Never fabricate an application URL. Return null if the page does not link one.

OUTPUT FORMAT:
Return a single JSON object and nothing else. No markdown fences, no preamble,
no explanation. Every key in the schema must be present. Unknown values are
null, empty arrays, or "UNKNOWN" as appropriate for the field type.`;

export function buildExtractionPrompt(input: {
  url: string;
  title?: string;
  universityName?: string;
  countryCode?: string | null;
  text: string;
}): string {
  // Hard cap the text sent to the model — cost is linear in input tokens and
  // scholarship detail is almost always in the first several thousand chars.
  const body = input.text.slice(0, 14_000);
  return `Extract scholarship information from the following university page.

SOURCE URL: ${input.url}
PAGE TITLE: ${input.title ?? '(none)'}
INSTITUTION: ${input.universityName ?? '(unknown)'}
INSTITUTION COUNTRY: ${input.countryCode ?? '(unknown)'}

--- BEGIN SOURCE TEXT ---
${body}
--- END SOURCE TEXT ---

Return the JSON object described in your instructions. Required top-level keys:
isScholarship, classificationConfidence, classificationReasons, title, provider,
description, degreeLevels, degreeEvidence, fieldsOfStudy, studyMode, attendance,
deliveryMode, modeEvidence, funding, eligibility, requirements, deadline,
applicationUrl, academicYear, intake, duration.

If this page is not an actual scholarship or funding opportunity (for example a
fee payment page, a donation appeal, a news article about a past award, or
general financial advice), set isScholarship to false and explain why in
classificationReasons. Still return every other key, using nulls.`;
}

// ── Provider abstraction ────────────────────────────────────────────────────

export interface AiCallResult {
  ok: boolean;
  raw?: string;
  error?: string;
  provider: string;
  model: string;
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  timedOut?: boolean;
}

async function callAnthropic(prompt: string): Promise<AiCallResult> {
  const started = Date.now();
  const base = env.AI_BASE_URL ?? 'https://api.anthropic.com';
  try {
    const res = await axios.post(
      `${base}/v1/messages`,
      {
        model: env.AI_MODEL,
        max_tokens: 4096,
        system: EXTRACTION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }]
      },
      {
        timeout: env.AI_TIMEOUT,
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.AI_API_KEY ?? '',
          'anthropic-version': '2023-06-01'
        }
      }
    );
    const raw = (res.data?.content ?? [])
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
    return {
      ok: true, raw, provider: 'anthropic', model: env.AI_MODEL,
      durationMs: Date.now() - started,
      promptTokens: res.data?.usage?.input_tokens,
      completionTokens: res.data?.usage?.output_tokens
    };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.response?.data?.error?.message ?? err?.message ?? 'request failed',
      provider: 'anthropic', model: env.AI_MODEL,
      durationMs: Date.now() - started,
      timedOut: err?.code === 'ECONNABORTED'
    };
  }
}

async function callOpenAi(prompt: string): Promise<AiCallResult> {
  const started = Date.now();
  const base = env.AI_BASE_URL ?? 'https://api.openai.com';
  try {
    const res = await axios.post(
      `${base}/v1/chat/completions`,
      {
        model: env.AI_MODEL,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
          { role: 'user', content: prompt }
        ]
      },
      {
        timeout: env.AI_TIMEOUT,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${env.AI_API_KEY ?? ''}` }
      }
    );
    return {
      ok: true,
      raw: res.data?.choices?.[0]?.message?.content ?? '',
      provider: 'openai', model: env.AI_MODEL,
      durationMs: Date.now() - started,
      promptTokens: res.data?.usage?.prompt_tokens,
      completionTokens: res.data?.usage?.completion_tokens
    };
  } catch (err: any) {
    return {
      ok: false,
      error: err?.response?.data?.error?.message ?? err?.message ?? 'request failed',
      provider: 'openai', model: env.AI_MODEL,
      durationMs: Date.now() - started,
      timedOut: err?.code === 'ECONNABORTED'
    };
  }
}

/**
 * Hugging Face path reuses the HF_SPACE_URL convention the existing
 * jobCategorizer already established, so an operator who has HF configured for
 * job categorization does not need a second provider account.
 */
async function callHuggingFace(prompt: string): Promise<AiCallResult> {
  const started = Date.now();
  const url = env.AI_BASE_URL ?? env.HF_SPACE_URL;
  if (!url) {
    return { ok: false, error: 'AI_BASE_URL/HF_SPACE_URL not set', provider: 'huggingface', model: env.AI_MODEL, durationMs: 0 };
  }
  try {
    const res = await axios.post(
      url,
      { inputs: `${EXTRACTION_SYSTEM_PROMPT}\n\n${prompt}`, parameters: { max_new_tokens: 3000, return_full_text: false } },
      {
        timeout: env.AI_TIMEOUT,
        headers: {
          'content-type': 'application/json',
          ...(env.AI_API_KEY || env.HF_TOKEN ? { authorization: `Bearer ${env.AI_API_KEY ?? env.HF_TOKEN}` } : {})
        }
      }
    );
    const data = res.data;
    const raw = Array.isArray(data)
      ? String(data[0]?.generated_text ?? '')
      : String(data?.generated_text ?? data?.output ?? JSON.stringify(data));
    return { ok: true, raw, provider: 'huggingface', model: env.AI_MODEL, durationMs: Date.now() - started };
  } catch (err: any) {
    return {
      ok: false, error: err?.message ?? 'request failed',
      provider: 'huggingface', model: env.AI_MODEL, durationMs: Date.now() - started,
      timedOut: err?.code === 'ECONNABORTED'
    };
  }
}

// ── Budget (§53) ────────────────────────────────────────────────────────────

let callsThisRun = 0;
export function resetAiBudget(): void { callsThisRun = 0; }
export function aiCallsUsed(): number { return callsThisRun; }
export function aiBudgetRemaining(): number {
  return Math.max(0, env.AI_MAX_CALLS_PER_RUN - callsThisRun);
}

export function isAiEnabled(): boolean {
  return env.AI_EXTRACTION_ENABLED && env.AI_PROVIDER !== 'none';
}

// ── Entry point ─────────────────────────────────────────────────────────────

export interface AiExtractionResult {
  state: 'SUCCESS' | 'VALIDATION_FAILED' | 'PROVIDER_FAILED' | 'TIMEOUT' | 'SKIPPED';
  data?: AiExtraction;
  raw?: string;
  errors: string[];
  provider: string;
  model: string;
  durationMs: number;
  promptTokens?: number;
  completionTokens?: number;
  attempts: number;
}

/**
 * Run AI extraction with one bounded retry.
 *
 * The retry is *only* for malformed output, and it appends a corrective note
 * rather than resending the identical prompt — resending unchanged input to a
 * deterministic-ish model mostly reproduces the same failure. Provider errors
 * are not retried here; the crawl scheduler retries the whole target later.
 */
export async function extractWithAi(input: {
  url: string;
  title?: string;
  universityName?: string;
  countryCode?: string | null;
  text: string;
}): Promise<AiExtractionResult> {
  const base = {
    provider: env.AI_PROVIDER, model: env.AI_MODEL, durationMs: 0, errors: [] as string[], attempts: 0
  };

  if (!isAiEnabled()) return { ...base, state: 'SKIPPED', errors: ['AI extraction disabled'] };
  if (aiBudgetRemaining() <= 0) return { ...base, state: 'SKIPPED', errors: ['AI call budget exhausted for this run'] };

  const call =
    env.AI_PROVIDER === 'anthropic' ? callAnthropic
    : env.AI_PROVIDER === 'openai' ? callOpenAi
    : callHuggingFace;

  let prompt = buildExtractionPrompt(input);
  let totalDuration = 0;
  let lastRaw: string | undefined;
  let lastErrors: string[] = [];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    callsThisRun += 1;
    const res = await call(prompt);
    totalDuration += res.durationMs;

    if (!res.ok) {
      return {
        ...base,
        state: res.timedOut ? 'TIMEOUT' : 'PROVIDER_FAILED',
        errors: [res.error ?? 'provider failed'],
        durationMs: totalDuration,
        attempts: attempt
      };
    }

    lastRaw = res.raw;
    const validated = validateAiOutput(res.raw ?? '');
    if (validated.ok && validated.data) {
      return {
        state: 'SUCCESS',
        data: validated.data,
        raw: res.raw,
        errors: [],
        provider: res.provider,
        model: res.model,
        durationMs: totalDuration,
        promptTokens: res.promptTokens,
        completionTokens: res.completionTokens,
        attempts: attempt
      };
    }

    lastErrors = validated.errors;
    logger.warn({ url: input.url, attempt, errors: validated.errors.slice(0, 5) }, 'scholarship: AI output failed validation');

    if (attempt === 1 && aiBudgetRemaining() > 0) {
      prompt = `${buildExtractionPrompt(input)}

YOUR PREVIOUS RESPONSE WAS REJECTED. Validation errors:
${validated.errors.slice(0, 10).map((e) => `- ${e}`).join('\n')}

Return corrected JSON only. No markdown fences, no commentary. Remember: every
non-null assertion needs an evidence string, dates are ISO-8601, country codes
are two uppercase letters, and absent information is null — not a guess.`;
    }
  }

  return {
    ...base,
    state: 'VALIDATION_FAILED',
    raw: lastRaw,
    errors: lastErrors,
    durationMs: totalDuration,
    attempts: 2
  };
}
