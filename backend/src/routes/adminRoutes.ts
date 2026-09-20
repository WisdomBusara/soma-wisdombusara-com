import { Router } from 'express';
import { nanoid } from 'nanoid';
import { isValidObjectId } from 'mongoose';
import { z } from 'zod';

import { requireAuth } from '../middleware/requireAuth';
import { requireCsrf } from '../middleware/requireCsrf';
import { AdminUserModel } from '../models/AdminUser';
import { BotModel } from '../models/Bot';
import { ContentModel } from '../models/Content';
import { PaymentModel } from '../models/Payment';
import { PlanModel } from '../models/Plan';
import { QueryModel } from '../models/Query';
import { SubscriptionModel } from '../models/Subscription';
import { TelegramUserModel } from '../models/TelegramUser';
import { decryptString, encryptString } from '../utils/encryption';
import { hashPassword } from '../utils/password';
import { sendMessage } from '../services/telegramApi';
import { logger } from '../config/logger';
import { env } from '../config/env';
import { WhatsAppBotModel } from '../models/WhatsAppBot';
import { getSessionStatus as getWahaSessionStatus, startSession as startWahaSession, getQR as getWahaQR, configureWebhook as configureWahaWebhook, sendMessage as wahaSendMessage, phoneToJid } from '../services/waha';
import type { BotRunner } from '../services/botRunner';
import { runJobReport, getJobRunStatus } from '../services/jobScheduler';
import { scrapeAllBanks, seedSourcesIfEmpty } from '../services/jobScraper';
import { ScrapeSourceModel } from '../models/ScrapeSource';
import { PremiumUserModel } from '../models/PremiumUser';
import { scholarshipAdminRouter } from './scholarshipAdminRoutes';

export function adminRouter(deps?: { botRunner?: BotRunner }) {
  const router = Router();
  router.use(requireAuth());
  router.use(requireCsrf());

  const ensureOwner = async (req: any, res: any, next: any) => {
    const user = await AdminUserModel.findById(req.auth?.userId).lean();
    if (!user || user.role !== 'owner') return res.status(403).json({ error: 'Owner role required' });
    req.ownerUser = user;
    return next();
  };

  const csvEscape = (value: unknown): string => {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const toCsv = (rows: string[][]): string => rows.map((row) => row.map(csvEscape).join(',')).join('\n');

  router.get('/ping', (_req, res) => res.json({ ok: true, scope: 'admin' }));

  // Scholarship Intelligence Engine admin surface. Mounted here so it inherits
  // requireAuth() + requireCsrf() above — no separate auth path.
  router.use('/scholarship', scholarshipAdminRouter());

  // ── Admin users ──────────────────────────────────────────────────────────────

  const adminCreateSchema = z.object({
    email: z.string().email(),
    password: z.string().min(12),
    role: z.enum(['owner', 'admin']).optional().default('admin'),
    isActive: z.boolean().optional().default(true)
  });

  router.get('/admins', ensureOwner, async (_req, res, next) => {
    try {
      const admins = await AdminUserModel.find({}).sort({ createdAt: -1 }).lean();
      return res.json(admins.map((a) => ({ id: String(a._id), email: a.email, role: a.role, isActive: a.isActive, lastLoginAt: a.lastLoginAt, createdAt: a.createdAt })));
    } catch (err) { return next(err); }
  });

  router.post('/admins', ensureOwner, async (req, res, next) => {
    try {
      const body = adminCreateSchema.parse(req.body);
      const passwordHash = await hashPassword(body.password);
      const admin = await AdminUserModel.create({ email: body.email.toLowerCase(), passwordHash, role: body.role, isActive: body.isActive });
      return res.status(201).json({ id: String(admin._id), email: admin.email, role: admin.role, isActive: admin.isActive });
    } catch (err) { return next(err); }
  });

  router.patch('/admins/:id', ensureOwner, async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid id' });
      const patch = z.object({ password: z.string().min(12).optional(), role: z.enum(['owner', 'admin']).optional(), isActive: z.boolean().optional() }).parse(req.body);
      const update: any = {};
      if (patch.password) update.passwordHash = await hashPassword(patch.password);
      if (patch.role) update.role = patch.role;
      if (patch.isActive !== undefined) update.isActive = patch.isActive;
      const currentUserId = String(req.auth?.userId ?? '');
      if (id === currentUserId && patch.isActive === false) return res.status(400).json({ error: 'Cannot deactivate own account' });
      if (patch.role === 'admin' || patch.isActive === false) {
        const ownerCount = await AdminUserModel.countDocuments({ role: 'owner', isActive: true });
        const target = await AdminUserModel.findById(id).lean();
        if (target && target.role === 'owner' && ownerCount <= 1) return res.status(400).json({ error: 'At least one active owner required' });
      }
      const updated = await AdminUserModel.findByIdAndUpdate(id, update, { new: true }).lean();
      if (!updated) return res.status(404).json({ error: 'Not found' });
      return res.json({ id: String(updated._id), email: updated.email, role: updated.role, isActive: updated.isActive });
    } catch (err) { return next(err); }
  });

  // ── Bots ──────────────────────────────────────────────────────────────────────

  const botCreateSchema = z.object({
    name: z.string().min(1).max(100),
    token: z.string().min(30).regex(/^\d+:[A-Za-z0-9_-]{20,}$/i, 'Invalid bot token format'),
    protectedChatId: z.string().min(1).max(64),
    isActive: z.boolean().optional().default(true)
  });

  router.get('/bots', async (_req, res, next) => {
    try {
      const bots = await BotModel.find({}).sort({ createdAt: -1 }).lean();
      return res.json(bots.map((b) => ({ id: String(b._id), name: b.name, tokenLast4: b.tokenLast4, protectedChatId: b.protectedChatId, isActive: b.isActive, createdAt: b.createdAt, updatedAt: b.updatedAt })));
    } catch (err) { return next(err); }
  });

  router.post('/bots', async (req, res, next) => {
    try {
      const body = botCreateSchema.parse(req.body);
      const tokenEnc = encryptString(body.token);
      const tokenLast4 = body.token.slice(-4);
      const webhookSecret = nanoid(32);
      const bot = await BotModel.create({ name: body.name, tokenEnc, tokenLast4, protectedChatId: body.protectedChatId, isActive: body.isActive, webhookSecret });
      if (deps?.botRunner) deps.botRunner.syncBots().catch(() => undefined);
      return res.status(201).json({ id: String(bot._id), name: bot.name, tokenLast4: bot.tokenLast4, protectedChatId: bot.protectedChatId, isActive: bot.isActive });
    } catch (err) { return next(err); }
  });

  router.patch('/bots/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid id' });
      const patch = botCreateSchema.partial().parse(req.body);
      const update: any = { ...patch };
      if (patch.token) { update.tokenEnc = encryptString(patch.token); update.tokenLast4 = patch.token.slice(-4); delete update.token; }
      const bot = await BotModel.findByIdAndUpdate(id, update, { new: true }).lean();
      if (!bot) return res.status(404).json({ error: 'Not found' });
      if (deps?.botRunner) deps.botRunner.syncBots().catch(() => undefined);
      return res.json({ id: String(bot._id), name: bot.name, tokenLast4: bot.tokenLast4, protectedChatId: bot.protectedChatId, isActive: bot.isActive });
    } catch (err) { return next(err); }
  });

  router.delete('/bots/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid id' });
      const deleted = await BotModel.findByIdAndDelete(id);
      if (!deleted) return res.status(404).json({ error: 'Not found' });
      if (deps?.botRunner) deps.botRunner.syncBots().catch(() => undefined);
      return res.json({ ok: true });
    } catch (err) { return next(err); }
  });

  // ── Plans ─────────────────────────────────────────────────────────────────────

  const planCreateSchema = z.object({
    name: z.string().min(1).max(100),
    durationMinutes: z.number().int().positive(),
    amountKobo: z.number().int().nonnegative(),
    currency: z.string().min(3).max(3).optional().default('KES'),
    videoUrl: z.string().url().optional().or(z.literal('')).transform((v) => v === '' ? undefined : v),
    description: z.string().max(200).optional(),
    isActive: z.boolean().optional().default(true),
    isTrial: z.boolean().optional().default(false),
    vertical: z.enum(['scholarships', 'jobs', 'tenders']).optional()
  });

  router.get('/plans', async (_req, res, next) => {
    try {
      const plans = await PlanModel.find({}).sort({ createdAt: -1 }).lean();
      return res.json(plans.map((p) => ({ id: String(p._id), name: p.name, durationMinutes: p.durationMinutes, amountKobo: p.amountKobo, currency: p.currency, videoUrl: p.videoUrl, description: p.description, isActive: p.isActive, isTrial: p.isTrial, vertical: p.vertical ?? 'jobs', createdAt: p.createdAt, updatedAt: p.updatedAt })));
    } catch (err) { return next(err); }
  });

  router.post('/plans', async (req, res, next) => {
    try {
      const body = planCreateSchema.parse(req.body);
      const plan = await PlanModel.create(body);
      return res.status(201).json({ id: String(plan._id), name: plan.name, durationMinutes: plan.durationMinutes, amountKobo: plan.amountKobo, currency: plan.currency, videoUrl: plan.videoUrl, description: plan.description, isActive: plan.isActive, isTrial: plan.isTrial, vertical: plan.vertical ?? 'jobs' });
    } catch (err) { return next(err); }
  });

  router.patch('/plans/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid id' });
      const patch = planCreateSchema.partial().parse(req.body);
      const plan = await PlanModel.findByIdAndUpdate(id, patch, { new: true }).lean();
      if (!plan) return res.status(404).json({ error: 'Not found' });
      return res.json({ id: String(plan._id), name: plan.name, durationMinutes: plan.durationMinutes, amountKobo: plan.amountKobo, currency: plan.currency, videoUrl: plan.videoUrl, description: plan.description, isActive: plan.isActive, isTrial: plan.isTrial, vertical: plan.vertical ?? 'jobs', createdAt: plan.createdAt, updatedAt: plan.updatedAt });
    } catch (err) { return next(err); }
  });

  router.delete('/plans/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid id' });
      const deleted = await PlanModel.findByIdAndDelete(id);
      if (!deleted) return res.status(404).json({ error: 'Not found' });
      return res.json({ ok: true });
    } catch (err) { return next(err); }
  });

  // ── Scrape sources (career pages, grouped by industry) ───────────────────────

  const sourceSchema = z.object({
    name: z.string().min(2).max(120),
    industry: z.string().min(2).max(60).transform((s) => s.trim().toLowerCase()),
    vertical: z.enum(['jobs', 'tenders']).optional(),
    kind: z.enum(['html', 'oracle', 'workday']).default('html'),
    homepage: z.string().url(),
    url: z.string().url().optional(),
    jobSelector: z.string().max(300).optional(),
    dynamic: z.boolean().optional(),
    urlFilter: z.string().max(200).optional(),
    tenant: z.string().max(60).optional(),
    siteNumber: z.string().max(60).optional(),
    locationId: z.number().optional(),
    domain: z.string().max(200).optional(),
    isActive: z.boolean().optional().default(true)
  });

  const sourceJson = (s: any) => ({
    id: String(s._id), name: s.name, industry: s.industry, vertical: s.vertical ?? 'jobs', kind: s.kind,
    homepage: s.homepage, url: s.url, jobSelector: s.jobSelector, dynamic: s.dynamic, urlFilter: s.urlFilter,
    tenant: s.tenant, siteNumber: s.siteNumber, locationId: s.locationId, domain: s.domain,
    isActive: s.isActive, createdAt: s.createdAt, updatedAt: s.updatedAt
  });

  router.get('/sources', async (req, res, next) => {
    try {
      await seedSourcesIfEmpty();
      const vertical = String(req.query.vertical ?? '').trim();
      const q = vertical === 'jobs' ? { $or: [{ vertical: 'jobs' }, { vertical: { $exists: false } }] } : vertical === 'tenders' ? { vertical: 'tenders' } : {};
      const sources = await ScrapeSourceModel.find(q).sort({ industry: 1, name: 1 }).lean();
      return res.json(sources.map(sourceJson));
    } catch (err) { return next(err); }
  });

  router.post('/sources', async (req, res, next) => {
    try {
      const body = sourceSchema.parse(req.body);
      if ((body.kind === 'html' || body.kind === 'workday') && !body.url) return res.status(400).json({ error: 'url is required for html/workday sources' });
      if (body.kind === 'oracle' && (!body.tenant || !body.siteNumber)) return res.status(400).json({ error: 'tenant and siteNumber are required for oracle sources' });
      const source = await ScrapeSourceModel.create(body);
      return res.status(201).json(sourceJson(source));
    } catch (err) { return next(err); }
  });

  router.patch('/sources/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid id' });
      const patch = sourceSchema.partial().parse(req.body);
      const source = await ScrapeSourceModel.findByIdAndUpdate(id, patch, { new: true }).lean();
      if (!source) return res.status(404).json({ error: 'Not found' });
      return res.json(sourceJson(source));
    } catch (err) { return next(err); }
  });

  router.delete('/sources/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid id' });
      const deleted = await ScrapeSourceModel.findByIdAndDelete(id);
      if (!deleted) return res.status(404).json({ error: 'Not found' });
      return res.json({ ok: true });
    } catch (err) { return next(err); }
  });

  /**
   * POST /admin/sources/:id/test — scrape ONE source and DM the result to the
   * admin test number (never the group). For checking which links still work.
   */
  const TEST_REPORT_PHONE = '254737327387';
  router.post('/sources/:id/test', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid id' });
      const source = await ScrapeSourceModel.findById(id).lean();
      if (!source) return res.status(404).json({ error: 'Not found' });

      const results = await scrapeAllBanks({ sourceId: id, debug: true, vertical: (source as any).vertical === 'tenders' ? 'tenders' : 'jobs' });
      const r = results[0];
      const jobs = r?.jobs ?? [];
      const rejectedCount = r?.rejected?.length ?? 0;

      const vlabel = (source as any).vertical === 'tenders' ? 'tender' : 'job';
      let msg = `🧪 *Source test — ${source.name}* (${source.industry} · ${vlabel}s)\n`;
      msg += `${source.kind === 'oracle' ? `Oracle: ${source.tenant}/${source.siteNumber}` : source.url}\n\n`;
      if (r?.error) {
        msg += `❌ *FAILED:* ${r.error}\n_This link is likely broken or blocked._`;
      } else if (jobs.length === 0) {
        msg += `⚠️ *0 ${vlabel}s found* (${rejectedCount} links seen but rejected as non-jobs).\n_Page loads but no postings detected — may be empty, JavaScript-rendered, or the URL points to the wrong page._`;
      } else {
        msg += `✅ *${jobs.length} ${vlabel}${jobs.length !== 1 ? 's' : ''} found:*\n\n`;
        for (const j of jobs.slice(0, 10)) msg += `• ${j.title}\n  ${j.url}\n`;
        if (jobs.length > 10) msg += `_…and ${jobs.length - 10} more_\n`;
      }

      const waBot = await WhatsAppBotModel.findOne({ isActive: true }).lean();
      if (waBot) {
        const apiKey = waBot.wahaApiKeyEnc ? decryptString(waBot.wahaApiKeyEnc) : undefined;
        await wahaSendMessage(waBot.wahaUrl, waBot.wahaSessionName, phoneToJid(TEST_REPORT_PHONE), msg, apiKey);
      }

      return res.json({
        ok: true,
        name: source.name,
        vertical: (source as any).vertical ?? 'jobs',
        jobs: jobs.length,
        rejected: rejectedCount,
        error: r?.error ?? null,
        sentTo: waBot ? `+${TEST_REPORT_PHONE}` : null
      });
    } catch (err) { return next(err); }
  });

  // ── Subscriptions ─────────────────────────────────────────────────────────────

  router.get('/subscriptions', async (req, res, next) => {
    try {
      const botId = req.query.botId ? String(req.query.botId) : undefined;
      const status = req.query.status ? String(req.query.status) : undefined;
      const filter: any = {};
      if (botId) { if (!isValidObjectId(botId)) return res.status(400).json({ error: 'Invalid botId' }); filter.botId = botId; }
      if (status) filter.status = status;
      const subs = await SubscriptionModel.find(filter).sort({ createdAt: -1 }).limit(500).lean();
      return res.json(subs.map((s) => ({ id: String(s._id), botId: String(s.botId), planId: String(s.planId), telegramUserId: s.telegramUserId, startsAt: s.startsAt, endsAt: s.endsAt, status: s.status, revokedAt: s.revokedAt, paystackReference: s.paystackReference, createdAt: s.createdAt })));
    } catch (err) { return next(err); }
  });

  // Manual subscription grant
  const grantSchema = z.object({
    botId: z.string().min(1),
    planId: z.string().min(1),
    telegramUserId: z.number().int(),
    durationMinutes: z.number().int().positive().optional()
  });

  router.post('/subscriptions/grant', async (req, res, next) => {
    try {
      const body = grantSchema.parse(req.body);
      if (!isValidObjectId(body.botId)) return res.status(400).json({ error: 'Invalid botId' });
      if (!isValidObjectId(body.planId)) return res.status(400).json({ error: 'Invalid planId' });
      const plan = await PlanModel.findById(body.planId).lean();
      if (!plan) return res.status(404).json({ error: 'Plan not found' });
      const bot = await BotModel.findById(body.botId).lean();
      if (!bot) return res.status(404).json({ error: 'Bot not found' });

      const durationMinutes = body.durationMinutes ?? plan.durationMinutes;
      const now = new Date();
      const durationMs = durationMinutes * 60_000;

      const existing = await SubscriptionModel.findOne({ botId: body.botId, telegramUserId: body.telegramUserId, status: 'active', endsAt: { $gt: now } }).sort({ endsAt: -1 });
      let sub;
      if (existing) {
        existing.endsAt = new Date(existing.endsAt.getTime() + durationMs);
        await existing.save();
        sub = existing;
      } else {
        sub = await SubscriptionModel.create({ botId: body.botId, planId: body.planId, telegramUserId: body.telegramUserId, startsAt: now, endsAt: new Date(now.getTime() + durationMs), status: 'active' });
      }

      // Notify user via bot
      try {
        const token = decryptString(bot.tokenEnc);
        let msg = `Access granted manually by admin!\n\nPlan: ${plan.name}\nExpires: ${new Date(sub.endsAt).toUTCString()}`;
        if (plan.videoUrl) msg += `\n\nYour video link:\n${plan.videoUrl}`;
        await sendMessage(token, body.telegramUserId, msg);
      } catch (err) {
        logger.warn({ err }, 'Could not notify user of manual grant');
      }

      return res.status(201).json({ id: String(sub._id), botId: String(sub.botId), telegramUserId: sub.telegramUserId, endsAt: sub.endsAt, status: sub.status });
    } catch (err) { return next(err); }
  });

  // ── Payments ──────────────────────────────────────────────────────────────────

  router.get('/payments', async (req, res, next) => {
    try {
      const status = req.query.status ? String(req.query.status) : undefined;
      const filter: any = {};
      if (status) filter.status = status;
      const payments = await PaymentModel.find(filter).sort({ createdAt: -1 }).limit(500).lean();
      return res.json(payments.map((p) => ({ id: String(p._id), reference: p.reference, botId: String(p.botId), planId: String(p.planId), telegramUserId: p.telegramUserId, email: p.email, amountKobo: p.amountKobo, currency: p.currency, status: p.status, createdAt: p.createdAt })));
    } catch (err) { return next(err); }
  });

  // ── Content ───────────────────────────────────────────────────────────────────

  const contentCreateSchema = z.object({
    botId: z.string().min(1),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(10000),
    isActive: z.boolean().optional().default(true)
  });

  const sendContentToChat = async (token: string, chatId: string, title: string, body: string) => {
    const text = `${title}\n\n${body}`.trim();
    const chunkSize = 3800;
    for (let i = 0; i < text.length; i += chunkSize) {
      await sendMessage(token, chatId, text.slice(i, i + chunkSize));
    }
  };

  router.get('/content', async (req, res, next) => {
    try {
      const botId = req.query.botId ? String(req.query.botId) : undefined;
      const filter: any = {};
      if (botId) { if (!isValidObjectId(botId)) return res.status(400).json({ error: 'Invalid botId' }); filter.botId = botId; }
      const items = await ContentModel.find(filter).sort({ createdAt: -1 }).limit(500).lean();
      return res.json(items.map((c) => ({ id: String(c._id), botId: String(c.botId), title: c.title, body: c.body, isActive: c.isActive, createdAt: c.createdAt, updatedAt: c.updatedAt })));
    } catch (err) { return next(err); }
  });

  router.post('/content', async (req, res, next) => {
    try {
      const body = contentCreateSchema.parse(req.body);
      if (!isValidObjectId(body.botId)) return res.status(400).json({ error: 'Invalid botId' });
      const bot = await BotModel.findById(body.botId).lean();
      if (!bot) return res.status(404).json({ error: 'Bot not found' });
      const created = await ContentModel.create({ botId: body.botId, title: body.title, body: body.body, isActive: body.isActive });
      if (body.isActive) {
        try {
          const token = decryptString(bot.tokenEnc);
          await sendContentToChat(token, bot.protectedChatId, body.title, body.body);
          logger.info({ botId: body.botId, contentId: String(created._id) }, 'Content broadcasted');
        } catch (err) { logger.error({ err, botId: body.botId }, 'Failed to broadcast'); }
      }
      return res.status(201).json({ id: String(created._id), botId: String(created.botId), title: created.title, body: created.body, isActive: created.isActive });
    } catch (err) { return next(err); }
  });

  router.patch('/content/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid id' });
      const patch = z.object({ title: z.string().min(1).max(200).optional(), body: z.string().min(1).max(10000).optional(), isActive: z.boolean().optional() }).parse(req.body);
      const updated = await ContentModel.findByIdAndUpdate(id, patch, { new: true }).lean();
      if (!updated) return res.status(404).json({ error: 'Not found' });
      return res.json({ id: String(updated._id), botId: String(updated.botId), title: updated.title, body: updated.body, isActive: updated.isActive, createdAt: updated.createdAt, updatedAt: updated.updatedAt });
    } catch (err) { return next(err); }
  });

  router.delete('/content/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid id' });
      const deleted = await ContentModel.findByIdAndDelete(id);
      if (!deleted) return res.status(404).json({ error: 'Not found' });
      return res.json({ ok: true });
    } catch (err) { return next(err); }
  });

  // ── Queries ───────────────────────────────────────────────────────────────────

  router.get('/queries', async (req, res, next) => {
    try {
      const filter: any = {};
      if (req.query.botId) { if (!isValidObjectId(String(req.query.botId))) return res.status(400).json({ error: 'Invalid botId' }); filter.botId = String(req.query.botId); }
      if (req.query.status) filter.status = String(req.query.status);
      const items = await QueryModel.find(filter).sort({ createdAt: -1 }).limit(500).lean();
      return res.json(items.map((q) => ({ id: String(q._id), botId: String(q.botId), telegramUserId: q.telegramUserId, text: q.text, status: q.status, createdAt: q.createdAt, updatedAt: q.updatedAt })));
    } catch (err) { return next(err); }
  });

  router.patch('/queries/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid id' });
      const patch = z.object({ status: z.enum(['open', 'closed']).optional() }).parse(req.body);
      const updated = await QueryModel.findByIdAndUpdate(id, patch, { new: true }).lean();
      if (!updated) return res.status(404).json({ error: 'Not found' });
      return res.json({ id: String(updated._id), botId: String(updated.botId), telegramUserId: updated.telegramUserId, text: updated.text, status: updated.status, createdAt: updated.createdAt, updatedAt: updated.updatedAt });
    } catch (err) { return next(err); }
  });

  // ── Telegram Users ────────────────────────────────────────────────────────────

  router.get('/telegram-users', async (req, res, next) => {
    try {
      const q = req.query.q ? String(req.query.q).trim() : '';
      const filter: any = q ? { $or: [{ username: new RegExp(q, 'i') }, { email: new RegExp(q, 'i') }, { firstName: new RegExp(q, 'i') }, { lastName: new RegExp(q, 'i') }] } : {};
      const users = await TelegramUserModel.find(filter).sort({ lastSeenAt: -1 }).limit(500).lean();
      return res.json(users.map((u) => ({ id: String(u._id), telegramUserId: u.telegramUserId, username: u.username, firstName: u.firstName, lastName: u.lastName, email: u.email, lastSeenAt: u.lastSeenAt, createdAt: u.createdAt })));
    } catch (err) { return next(err); }
  });

  // ── Reports ───────────────────────────────────────────────────────────────────

  router.get('/reports/summary', async (_req, res, next) => {
    try {
      const [botCount, planCount, subCount, activeSubs, expiredSubs, openQueries, paidPayments, totalUsers] = await Promise.all([
        BotModel.countDocuments({}),
        PlanModel.countDocuments({}),
        SubscriptionModel.countDocuments({}),
        SubscriptionModel.countDocuments({ status: 'active' }),
        SubscriptionModel.countDocuments({ status: 'expired' }),
        QueryModel.countDocuments({ status: 'open' }),
        PaymentModel.find({ status: 'paid' }).lean(),
        TelegramUserModel.countDocuments({})
      ]);
      const revenueKobo = paidPayments.reduce((sum, p) => sum + (p.amountKobo || 0), 0);
      // Use the most common currency from paid payments, default to KES
      const currencyCounts: Record<string, number> = {};
      for (const p of paidPayments) { const c = String(p.currency || 'KES'); currencyCounts[c] = (currencyCounts[c] ?? 0) + 1; }
      const revenueCurrency = Object.entries(currencyCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'KES';
      return res.json({ bots: botCount, plans: planCount, subscriptions: subCount, subscriptionsActive: activeSubs, subscriptionsExpired: expiredSubs, openQueries, revenueKobo, revenueCurrency, paidPayments: paidPayments.length, totalUsers });
    } catch (err) { return next(err); }
  });

  // ── Exports ───────────────────────────────────────────────────────────────────

  router.get('/exports/:type', async (req, res, next) => {
    try {
      const type = String(req.params.type);
      if (type === 'subscriptions') {
        const subs = await SubscriptionModel.find({}).sort({ createdAt: -1 }).limit(5000).lean();
        const rows = [['subscriptionId', 'botId', 'planId', 'telegramUserId', 'startsAt', 'endsAt', 'status', 'paystackReference']];
        subs.forEach((s) => rows.push([String(s._id), String(s.botId), String(s.planId), String(s.telegramUserId), String(s.startsAt), String(s.endsAt), String(s.status), String(s.paystackReference ?? '')]));
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="subscriptions.csv"');
        return res.status(200).send(toCsv(rows));
      }
      if (type === 'payments') {
        const payments = await PaymentModel.find({}).sort({ createdAt: -1 }).limit(5000).lean();
        const rows = [['reference', 'botId', 'planId', 'telegramUserId', 'email', 'amountKobo', 'currency', 'status', 'createdAt']];
        payments.forEach((p) => rows.push([String(p.reference), String(p.botId), String(p.planId), String(p.telegramUserId), String(p.email), String(p.amountKobo), String(p.currency), String(p.status), String(p.createdAt)]));
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="payments.csv"');
        return res.status(200).send(toCsv(rows));
      }
      return res.status(400).json({ error: 'Unknown export type' });
    } catch (err) { return next(err); }
  });

  // ── WhatsApp Bots ──────────────────────────────────────────
  router.get('/wa-bots', async (_req, res, next) => {
    try {
      const bots = await WhatsAppBotModel.find({}).sort({ createdAt: -1 }).lean();
      return res.json(bots.map((b) => ({ ...b, wahaApiKeyEnc: undefined })));
    } catch (err) { return next(err); }
  });

  router.post('/wa-bots', async (req, res, next) => {
    try {
      const { name, wahaUrl, wahaSessionName, wahaApiKey, groupId } = req.body;
      if (!name || !wahaUrl || !wahaSessionName || !groupId) return res.status(400).json({ error: 'name, wahaUrl, wahaSessionName, groupId are required' });
      const wahaApiKeyEnc = wahaApiKey ? encryptString(String(wahaApiKey)) : undefined;
      const bot = await WhatsAppBotModel.create({ name, wahaUrl, wahaSessionName, wahaApiKeyEnc, groupId, isActive: true });
      return res.status(201).json({ ...bot.toObject(), wahaApiKeyEnc: undefined });
    } catch (err) { return next(err); }
  });

  router.patch('/wa-bots/:id', async (req, res, next) => {
    try {
      const { name, wahaUrl, wahaSessionName, wahaApiKey, groupId, jobReportGroupId, tendersGroupId, scholarshipGroupId, isActive } = req.body;
      const update: any = {};
      if (name !== undefined) update.name = name;
      if (wahaUrl !== undefined) update.wahaUrl = wahaUrl;
      if (wahaSessionName !== undefined) update.wahaSessionName = wahaSessionName;
      if (wahaApiKey !== undefined) update.wahaApiKeyEnc = encryptString(String(wahaApiKey));
      if (groupId !== undefined) update.groupId = groupId;
      if (jobReportGroupId !== undefined) update.jobReportGroupId = jobReportGroupId;
      if (tendersGroupId !== undefined) update.tendersGroupId = tendersGroupId;
      if (scholarshipGroupId !== undefined) update.scholarshipGroupId = scholarshipGroupId;
      if (isActive !== undefined) update.isActive = Boolean(isActive);
      logger.info({ botId: req.params.id, update: { ...update, wahaApiKeyEnc: update.wahaApiKeyEnc ? '[encrypted]' : undefined } }, 'PATCH wa-bot');
      const bot = await WhatsAppBotModel.findByIdAndUpdate(req.params.id, { $set: update }, { new: true }).lean();
      if (!bot) return res.status(404).json({ error: 'Not found' });
      const resp: any = { ...bot, wahaApiKeyEnc: undefined };
      logger.info({ botId: req.params.id, savedJobReportGroupId: resp.jobReportGroupId ?? null }, 'PATCH wa-bot saved');
      return res.json(resp);
    } catch (err) { return next(err); }
  });

  router.delete('/wa-bots/:id', async (req, res, next) => {
    try {
      await WhatsAppBotModel.findByIdAndDelete(req.params.id);
      return res.json({ ok: true });
    } catch (err) { return next(err); }
  });

  /** GET /admin/wa-bots/:id/qr — return WAHA QR code as base64 PNG */
  router.get('/wa-bots/:id/qr', async (req, res, next) => {
    try {
      const bot = await WhatsAppBotModel.findById(req.params.id).lean();
      if (!bot) return res.status(404).json({ error: 'Not found' });
      const apiKey = bot.wahaApiKeyEnc ? decryptString(bot.wahaApiKeyEnc) : undefined;
      const qr = await getWahaQR(bot.wahaUrl, bot.wahaSessionName, apiKey);
      return res.json({ qr });
    } catch (err) { return next(err); }
  });

  /** GET /admin/wa-bots/:id/status — check WAHA session status */
  router.get('/wa-bots/:id/status', async (req, res, next) => {
    try {
      const bot = await WhatsAppBotModel.findById(req.params.id).lean();
      if (!bot) return res.status(404).json({ error: 'Not found' });
      const apiKey = bot.wahaApiKeyEnc ? decryptString(bot.wahaApiKeyEnc) : undefined;
      const { status } = await getWahaSessionStatus(bot.wahaUrl, bot.wahaSessionName, apiKey);
      return res.json({ status });
    } catch (err) { return next(err); }
  });

  /** POST /admin/wa-bots/:id/start — start WAHA session */
  router.post('/wa-bots/:id/start', async (req, res, next) => {
    try {
      const bot = await WhatsAppBotModel.findById(req.params.id).lean();
      if (!bot) return res.status(404).json({ error: 'Not found' });
      const apiKey = bot.wahaApiKeyEnc ? decryptString(bot.wahaApiKeyEnc) : undefined;
      await startWahaSession(bot.wahaUrl, bot.wahaSessionName, apiKey);
      return res.json({ ok: true });
    } catch (err) { return next(err); }
  });

  /** POST /admin/wa-bots/:id/configure-webhook — tells WAHA to send webhooks to this backend */
  router.post('/wa-bots/:id/configure-webhook', async (req, res, next) => {
    try {
      const bot = await WhatsAppBotModel.findById(req.params.id).lean();
      if (!bot) return res.status(404).json({ error: 'Not found' });
      const apiKey = bot.wahaApiKeyEnc ? decryptString(bot.wahaApiKeyEnc) : undefined;
      const base = String((env as any).TELEGRAM_WEBHOOK_BASE_URL ?? '').replace(/\/$/, '');
      const webhookUrl = `${base}/whatsapp/inbound/${String(bot._id)}/${bot.webhookSecret}`;
      await configureWahaWebhook(bot.wahaUrl, bot.wahaSessionName, webhookUrl, apiKey);
      return res.json({ ok: true, webhookUrl });
    } catch (err) { return next(err); }
  });

  /** GET /admin/wa-bots/:id/groups — list WhatsApp groups the session is a member of */
  router.get('/wa-bots/:id/groups', async (req, res, next) => {
    try {
      const bot = await WhatsAppBotModel.findById(req.params.id).lean();
      if (!bot) return res.status(404).json({ error: 'Not found' });
      const apiKey = bot.wahaApiKeyEnc ? decryptString(bot.wahaApiKeyEnc) : undefined;
      const axios = (await import('axios')).default;
      const resp = await axios.get(
        `${bot.wahaUrl.replace(/\/$/, '')}/api/${encodeURIComponent(bot.wahaSessionName)}/groups`,
        { headers: apiKey ? { 'X-Api-Key': apiKey } : {}, timeout: 10_000 }
      );
      const groups = (resp.data ?? []).map((g: any) => ({
        // WEBJS returns id as a nested { server, user, _serialized } object,
        // not a string — check g.id._serialized before the bare g.id, or
        // String(g.id) silently becomes the literal "[object Object]".
        // GOWS uses JID/Name/Participants instead.
        id: String(g.JID ?? g.id?._serialized ?? g.id ?? g._serialized ?? ''),
        name: String(g.Name ?? g.subject ?? g.name ?? ''),
        size: Number(g.ParticipantCount ?? g.Participants?.length ?? g.size ?? g.participantsCount ?? 0)
      }));
      return res.json(groups);
    } catch (err: any) {
      return res.status(502).json({ error: `Could not fetch groups from WAHA: ${err?.message ?? err}` });
    }
  });

  /** POST /admin/wa/send-test — send a text to any number via the active bot (debug/verification) */
  router.post('/wa/send-test', async (req, res, next) => {
    try {
      const body = z.object({ phone: z.string().min(9).max(15), text: z.string().min(1).max(1000) }).parse(req.body);
      const waBot = await WhatsAppBotModel.findOne({ isActive: true }).lean();
      if (!waBot) return res.status(404).json({ error: 'No active WhatsApp bot' });
      const apiKey = waBot.wahaApiKeyEnc ? decryptString(waBot.wahaApiKeyEnc) : undefined;
      const jid = phoneToJid(body.phone);
      await wahaSendMessage(waBot.wahaUrl, waBot.wahaSessionName, jid, body.text, apiKey);
      return res.json({ ok: true, to: jid });
    } catch (err) { return next(err); }
  });

  // ── Premium users (LLM-categorized feed access) ───────────────────────────────

  const premiumSchema = z.object({
    phone: z.string().min(6).max(20).transform((s) => s.replace(/\D/g, '')),
    name: z.string().max(80).optional(),
    email: z.string().email().optional(),
    notes: z.string().max(300).optional(),
    isActive: z.boolean().optional().default(true),
    expiresAt: z.string().datetime().optional().nullable()
  });

  const premiumJson = (u: any) => ({
    id: String(u._id), phone: u.phone, name: u.name, email: u.email, notes: u.notes,
    isActive: u.isActive, expiresAt: u.expiresAt, createdAt: u.createdAt, updatedAt: u.updatedAt
  });

  router.get('/premium-users', async (_req, res, next) => {
    try {
      const users = await PremiumUserModel.find({}).sort({ createdAt: -1 }).lean();
      return res.json(users.map(premiumJson));
    } catch (err) { return next(err); }
  });

  router.post('/premium-users', async (req, res, next) => {
    try {
      const body = premiumSchema.parse(req.body);
      const user = await PremiumUserModel.create(body);
      return res.status(201).json(premiumJson(user));
    } catch (err: any) {
      if (err?.code === 11000) return res.status(409).json({ error: 'Phone already registered as premium' });
      return next(err);
    }
  });

  router.patch('/premium-users/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid id' });
      const patch = premiumSchema.partial().parse(req.body);
      const user = await PremiumUserModel.findByIdAndUpdate(id, patch, { new: true }).lean();
      if (!user) return res.status(404).json({ error: 'Not found' });
      return res.json(premiumJson(user));
    } catch (err) { return next(err); }
  });

  router.delete('/premium-users/:id', async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (!isValidObjectId(id)) return res.status(400).json({ error: 'Invalid id' });
      const deleted = await PremiumUserModel.findByIdAndDelete(id);
      if (!deleted) return res.status(404).json({ error: 'Not found' });
      return res.json({ ok: true });
    } catch (err) { return next(err); }
  });

  /** GET /admin/llm/status — categorizer health + coverage for the Premium tab */
  router.get('/llm/status', async (_req, res, next) => {
    try {
      const { categorizerEnabled, JOB_CATEGORIES, todayCategoryCounts, getCategorizerRun } = await import('../services/jobCategorizer');
      const { JobModel } = await import('../models/Job');
      const [total, categorized, counts, run] = await Promise.all([
        JobModel.estimatedDocumentCount(),
        JobModel.countDocuments({ category: { $exists: true } }),
        todayCategoryCounts(),
        getCategorizerRun()
      ]);
      return res.json({
        enabled: categorizerEnabled(),
        model: process.env.HF_SPACE_URL ?? process.env.HF_MODEL ?? 'facebook/bart-large-mnli',
        categories: JOB_CATEGORIES,
        jobsTotal: total,
        jobsCategorized: categorized,
        today: counts,
        run
      });
    } catch (err) { return next(err); }
  });

  /** POST /admin/llm/categorize — manually run categorization now */
  router.post('/llm/categorize', async (_req, res, next) => {
    try {
      const { categorizeNewJobs, categorizerEnabled } = await import('../services/jobCategorizer');
      if (!categorizerEnabled()) return res.status(400).json({ error: 'HF_TOKEN not set — add it via fly secrets' });
      categorizeNewJobs().catch((err) => logger.error({ err }, 'Manual categorization failed'));
      return res.json({ ok: true, message: 'Categorization started in background' });
    } catch (err) { return next(err); }
  });

  /** GET /admin/jobs/status — live progress of the current/last report run */
  router.get('/jobs/status', async (req, res, next) => {
    try {
      const v = String(req.query.vertical ?? 'jobs') === 'tenders' ? 'tenders' : 'jobs';
      return res.json(await getJobRunStatus(v));
    } catch (err) { return next(err); }
  });

  /** POST /admin/jobs/run — manually trigger job report now */
  router.post('/jobs/run', async (req, res, next) => {
    try {
      const v = String(req.query.vertical ?? 'jobs') === 'tenders' ? 'tenders' : 'jobs';
      runJobReport(v).catch((err) => logger.error({ err, v }, 'Manual report failed'));
      return res.json({ ok: true, message: `${v} report started — check the group in ~60 seconds` });
    } catch (err) { return next(err); }
  });

  /** POST /admin/jobs/reset-and-run — clear all scraped job records then re-run report */
  router.post('/jobs/reset-and-run', async (req, res, next) => {
    try {
      const v = String(req.query.vertical ?? 'jobs') === 'tenders' ? 'tenders' : 'jobs';
      const { JobModel } = await import('../models/Job');
      const q = v === 'jobs' ? { $or: [{ vertical: 'jobs' }, { vertical: { $exists: false } }] } : { vertical: 'tenders' };
      const { deletedCount } = await JobModel.deleteMany(q);
      logger.info({ deletedCount, v }, 'Records cleared for reset');
      runJobReport(v).catch((err) => logger.error({ err, v }, 'Reset report failed'));
      return res.json({ ok: true, message: `Cleared ${deletedCount} ${v} records — fresh report starting now` });
    } catch (err) { return next(err); }
  });

  /** GET /admin/jobs/config — show what groupJid the job report would use */
  router.get('/jobs/config', async (_req, res, next) => {
    try {
      const bots = await WhatsAppBotModel.find({ isActive: true }).lean();
      return res.json(bots.map((b) => ({
        id: String(b._id),
        name: b.name,
        groupId: b.groupId,
        jobReportGroupId: (b as any).jobReportGroupId ?? null,
        tendersGroupId: (b as any).tendersGroupId ?? null,
        isActive: b.isActive,
      })));
    } catch (err) { return next(err); }
  });

  /**
   * GET /admin/jobs/debug?bank=ncba
   * Scrapes a single bank and returns every candidate with its score and reasons,
   * so you can tune the classifier when a bank's markup is unusual.
   */
  router.get('/jobs/debug', async (req, res, next) => {
    try {
      const bank = String(req.query.bank ?? '').trim();
      if (!bank) return res.status(400).json({ error: 'Pass ?bank=<name substring> — e.g. ?bank=ncba' });
      const results = await scrapeAllBanks({ debug: true, only: bank });
      if (results.length === 0) return res.status(404).json({ error: `No bank matched "${bank}"` });
      return res.json(results);
    } catch (err) { return next(err); }
  });

  /** GET /admin/wa-bots/:id/webhook-url — returns the URL to paste into WAHA config */
  router.get('/wa-bots/:id/webhook-url', async (req, res, next) => {
    try {
      const bot = await WhatsAppBotModel.findById(req.params.id).lean();
      if (!bot) return res.status(404).json({ error: 'Not found' });
      const base = (env as any).TELEGRAM_WEBHOOK_BASE_URL?.replace(/\/$/, '') ?? '';
      const url = `${base}/whatsapp/inbound/${String(bot._id)}/${bot.webhookSecret}`;
      return res.json({ webhookUrl: url });
    } catch (err) { return next(err); }
  });

  return router;
}
