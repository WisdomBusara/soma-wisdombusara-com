import axios from 'axios';
import { logger } from '../config/logger';
import { env } from '../config/env';
import { JobModel } from '../models/Job';
import { JobRunStateModel } from '../models/JobRunState';

// LLM job categorization (premium feature).
//
// Phase 1 (now): zero-shot classification via the Hugging Face Inference API
// (BART-MNLI). No training needed, works from day one on title + JD text.
// Phase 2 (later): every categorization + admin corrections in the portal
// accumulate labeled data — fine-tune a small model on the user's HF account
// and swap HF_MODEL to it. Same API shape, better accuracy.

export const JOB_CATEGORIES = [
  'IT & Software',
  'Engineering',
  'Finance & Accounting',
  'Human Resources',
  'Legal & Compliance',
  'Sales & Marketing',
  'Customer Service',
  'Operations & Administration',
  'Insurance & Actuarial',
  'Management & Strategy',
] as const;

const HF_MODEL = env.HF_MODEL ?? 'facebook/bart-large-mnli';
const HF_URL = `https://api-inference.huggingface.co/models/${HF_MODEL}`;

// Below this confidence the model is guessing — file as "Other" instead of
// polluting a real category with a wrong label.
const MIN_CATEGORY_CONFIDENCE = 0.4;
export const OTHER_CATEGORY = 'Other';

export function categorizerEnabled(): boolean {
  return Boolean(env.HF_SPACE_URL || env.HF_TOKEN);
}

/** True when text is code/JSON debris, not prose (e.g. Workday SPA redirect stubs). */
function looksLikeGarbage(text: string): boolean {
  if (!text) return true;
  if (/^\s*[{[]/.test(text)) return true;                        // starts as JSON
  if (/"(widget|url|externalSpa|props|__)":/i.test(text)) return true;
  const letters = (text.match(/[a-zA-Z]/g) ?? []).length;
  return letters / Math.max(text.length, 1) < 0.55;              // mostly symbols
}

/** Best-effort fetch of the job description text (~1200 chars, prose only). */
async function fetchJdSnippet(url: string): Promise<string> {
  try {
    const resp = await axios.get(url, {
      timeout: 12_000,
      responseType: 'text',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WraithBot/1.0)' },
      maxContentLength: 2_000_000
    });
    const text = String(resp.data)
      .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    // skip nav boilerplate — start roughly a third in if the page is large,
    // then advance to the next sentence start so we never begin mid-word
    let start = text.length > 4000 ? Math.floor(text.length / 3) : 0;
    if (start > 0) {
      const boundary = text.indexOf('. ', start);
      if (boundary !== -1 && boundary < start + 600) start = boundary + 2;
    }
    const snippet = text.slice(start, start + 1200).trim();
    return looksLikeGarbage(snippet) ? '' : snippet;
  } catch {
    return '';
  }
}

type ClassifyResult = { category: string; score: number; summary?: string };

/** Preferred path: the Wraith LLM Space (summarize → classify pipeline). */
async function classifyViaSpace(title: string, description: string): Promise<ClassifyResult | null> {
  try {
    const resp = await axios.post(
      `${env.HF_SPACE_URL!.replace(/\/$/, '')}/classify`,
      { title, description },
      {
        timeout: 120_000, // free CPU Space + summarizer can be slow, esp. cold
        headers: {
          'Content-Type': 'application/json',
          ...(env.HF_TOKEN ? { Authorization: `Bearer ${env.HF_TOKEN}` } : {})
        }
      }
    );
    const { category, score, summary } = resp.data ?? {};
    if (!category) return null;
    return { category: String(category), score: Number(score ?? 0), summary: summary ? String(summary) : undefined };
  } catch (err: any) {
    logger.warn({ err: err?.response?.status ?? err?.message }, 'HF Space classify failed');
    return null;
  }
}

/** Fallback: serverless Inference API zero-shot on title + raw snippet. */
async function classifyViaInferenceApi(input: string): Promise<ClassifyResult | null> {
  try {
    const resp = await axios.post(
      HF_URL,
      { inputs: input.slice(0, 1800), parameters: { candidate_labels: [...JOB_CATEGORIES], multi_label: false } },
      { timeout: 30_000, headers: { Authorization: `Bearer ${env.HF_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    const labels: string[] = resp.data?.labels ?? [];
    const scores: number[] = resp.data?.scores ?? [];
    if (!labels.length) return null;
    return { category: labels[0], score: scores[0] ?? 0 };
  } catch (err: any) {
    // 503 = model cold-starting on HF; caller retries next run
    logger.warn({ err: err?.response?.status ?? err?.message }, 'HF categorization call failed');
    return null;
  }
}

/**
 * Categorize all stored jobs that don't have a category yet.
 * Runs after each report; safe to re-run (only touches uncategorized docs).
 */
// Progress lives in the JobRunState collection (_id 'categorizer') so the
// dashboard reads it consistently across both machines. Field mapping:
// banksDone = jobs categorized, banksTotal = jobs queued, currentBank = title.
async function setCatStatus(patch: Record<string, unknown>): Promise<void> {
  await JobRunStateModel.updateOne({ _id: 'categorizer' }, { $set: patch }, { upsert: true }).catch(() => {});
}

export async function getCategorizerRun() {
  const doc = await JobRunStateModel.findById('categorizer').lean();
  return {
    state: doc?.state ?? 'idle',
    done: doc?.banksDone ?? 0,
    total: doc?.banksTotal ?? 0,
    current: doc?.currentBank ?? null,
    startedAt: doc?.startedAt?.toISOString() ?? null,
    finishedAt: doc?.finishedAt?.toISOString() ?? null,
    error: doc?.error ?? null
  };
}

export async function categorizeNewJobs(limit = 60): Promise<number> {
  if (!categorizerEnabled()) return 0;
  // refuse overlap — a run already in flight
  const existing = await JobRunStateModel.findById('categorizer').lean();
  if (existing?.state === 'scraping' && existing.startedAt && Date.now() - existing.startedAt.getTime() < 45 * 60 * 1000) {
    logger.warn('Categorization already running — skipping duplicate trigger');
    return 0;
  }
  // self-heal: garbage summaries (SPA/JSON debris) poisoned their categories —
  // strip them so those jobs get re-categorized cleanly below
  await JobModel.updateMany(
    { summary: { $regex: '"(widget|url|externalSpa)":|^\\s*[{\\[]' } },
    { $unset: { category: 1, categoryScore: 1, categorizedAt: 1, summary: 1 } }
  ).catch(() => {});
  // retroactively apply the confidence floor (also covers threshold changes)
  await JobModel.updateMany(
    { category: { $exists: true, $ne: OTHER_CATEGORY }, categoryScore: { $lt: MIN_CATEGORY_CONFIDENCE } },
    { $set: { category: OTHER_CATEGORY } }
  ).catch(() => {});
  const jobs = await JobModel.find({ category: { $exists: false } })
    .sort({ firstSeenAt: -1 })
    .limit(limit)
    .lean();
  await setCatStatus({
    state: 'scraping', startedAt: new Date(), finishedAt: null,
    banksDone: 0, banksTotal: jobs.length, currentBank: null, error: null
  });
  let done = 0;
  let failures = 0;
  for (const job of jobs) {
    await setCatStatus({ currentBank: job.title.slice(0, 60) });
    const jd = await fetchJdSnippet(job.url);
    const result = env.HF_SPACE_URL
      ? await classifyViaSpace(job.title, jd)
      : await classifyViaInferenceApi(jd ? `Job title: ${job.title}. Description: ${jd}` : `Job title: ${job.title}`);
    if (!result) {
      failures += 1;
      // 3 consecutive failures at the start = the model endpoint is down; stop
      if (failures >= 3 && done === 0) {
        await setCatStatus({ state: 'failed', finishedAt: new Date(), error: 'model endpoint unreachable (Space still building?)' });
        return done;
      }
      continue;
    }
    // never store code debris as a "summary"
    const cleanSummary = result.summary && !looksLikeGarbage(result.summary)
      ? result.summary.replace(/^["'\s]+/, '').trim()
      : undefined;
    await JobModel.updateOne(
      { _id: job._id },
      { $set: {
        category: result.score >= MIN_CATEGORY_CONFIDENCE ? result.category : OTHER_CATEGORY,
        categoryScore: result.score,
        categorizedAt: new Date(),
        ...(cleanSummary ? { summary: cleanSummary } : {})
      } }
    );
    done += 1;
    await setCatStatus({ banksDone: done });
    // polite pacing for the free inference tier
    await new Promise((r) => setTimeout(r, 1200));
  }
  await setCatStatus({ state: 'done', finishedAt: new Date(), currentBank: null });
  if (done > 0) logger.info({ done }, 'Jobs categorized via HF');
  return done;
}

/** Category → count of jobs first seen in the last 24h (for the premium bot menu). */
export async function todayCategoryCounts(): Promise<Array<{ category: string; count: number }>> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await JobModel.aggregate([
    { $match: { firstSeenAt: { $gte: since }, category: { $exists: true } } },
    { $group: { _id: '$category', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]);
  const list = rows.map((r) => ({ category: String(r._id), count: r.count }));
  // "Other" always sorts last, whatever its size
  return [...list.filter((c) => c.category !== OTHER_CATEGORY), ...list.filter((c) => c.category === OTHER_CATEGORY)];
}

/** Jobs in one category from the last 24h. */
export async function todayJobsByCategory(category: string, limit = 15) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  return JobModel.find({ firstSeenAt: { $gte: since }, category })
    .sort({ firstSeenAt: -1 })
    .limit(limit)
    .lean();
}
