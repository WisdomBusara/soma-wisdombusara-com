import { nanoid } from 'nanoid';
import { Types } from 'mongoose';

import { env } from '../config/env';
import { logger } from '../config/logger';
import { WhatsAppBotModel } from '../models/WhatsAppBot';
import { PendingConvoModel } from '../models/PendingConvo';
import { PremiumUserModel } from '../models/PremiumUser';
import { todayCategoryCounts, todayJobsByCategory, categorizerEnabled } from './jobCategorizer';
import { PaymentModel } from '../models/Payment';
import { PlanModel } from '../models/Plan';
import { JobModel } from '../models/Job';
import { SubscriptionModel } from '../models/Subscription';
import { QueryModel } from '../models/Query';
import { decryptString } from '../utils/encryption';
import { initializeTransaction, chargeMpesa } from './paystack';
import { sendMessage as wahaSend, lidToPhone } from './waha';
import { grantWhatsAppAccess } from './waFulfillment';

type Vertical = 'jobs' | 'tenders';
type PendingState =
  | { kind: 'awaitVertical'; waBotId: string }
  | { kind: 'awaitPlanSelection'; waBotId: string; planIds: string[]; vertical: Vertical }
  | { kind: 'awaitPaymentMethod'; waBotId: string; planId: string; vertical: Vertical }
  | { kind: 'awaitPhone'; waBotId: string; planId: string; vertical: Vertical }
  | { kind: 'awaitSupport'; waBotId: string }
  | { kind: 'awaitPremiumChoice'; waBotId: string }
  | { kind: 'awaitCategorySelection'; waBotId: string; categories: string[] };

function fmt(amountMinor: number, currency: string): string {
  const code = (currency || '').toUpperCase();
  const sym = code === 'KES' ? 'KSh ' : code === 'NGN' ? '₦' : code === 'USD' ? '$' : `${code} `;
  return `${sym}${(amountMinor / 100).toFixed(2)}`;
}

function normaliseKenyanPhone(raw: string): string | null {
  const d = raw.replace(/\D/g, '');
  if (d.startsWith('254') && d.length === 12) return d;
  if (d.startsWith('0') && d.length === 10) return `254${d.slice(1)}`;
  if (d.length === 9) return `254${d}`;
  return null;
}

function placeholderEmail(phone: string): string {
  return `wa${phone.replace(/\D/g, '')}@wraith.pay`;
}

/** Trim an LLM summary for chat: prose only, ≤180 chars, cut at a word boundary. */
function cleanSummaryForChat(raw: unknown): string | null {
  if (!raw) return null;
  const s = String(raw).replace(/\s+/g, ' ').trim();
  if (/^[{[]/.test(s) || /"(widget|url|externalSpa)":/i.test(s)) return null; // code debris
  if (s.length < 25) return null;
  if (s.length <= 180) return s;
  const cut = s.slice(0, 180);
  return cut.slice(0, cut.lastIndexOf(' ')) + '…';
}

export class WhatsAppBotRunner {
  private bots = new Map<string, any>();
  private syncTimer: NodeJS.Timeout | null = null;

  // Conversation state lives in Mongo (30-min TTL) so deploys/restarts don't
  // dump users mid-signup, and multiple backend machines see the same state.
  private async getPending(key: string): Promise<PendingState | null> {
    const doc = await PendingConvoModel.findOne({ key }).lean();
    return (doc?.state as PendingState) ?? null;
  }

  private async setPending(key: string, state: PendingState): Promise<void> {
    await PendingConvoModel.updateOne(
      { key },
      { $set: { state, updatedAt: new Date() } },
      { upsert: true }
    );
  }

  private async clearPending(key: string): Promise<void> {
    await PendingConvoModel.deleteOne({ key });
  }

  async start(): Promise<void> {
    await this.syncBots();
    this.syncTimer = setInterval(() => {
      this.syncBots().catch((err) => logger.error({ err }, 'WA bot sync failed'));
    }, 60_000);
  }

  stop(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    this.bots.clear();
  }

  async syncBots(): Promise<void> {
    const active = await WhatsAppBotModel.find({ isActive: true }).lean();
    this.bots.clear();
    for (const b of active) this.bots.set(String(b._id), b);
    logger.info({ count: this.bots.size }, 'WhatsApp bots synced');
  }

  getBot(waBotId: string): any | null {
    return this.bots.get(waBotId) ?? null;
  }

  async handleMessageBySession(sessionName: string, from: string, text: string): Promise<void> {
    const knownSessions = [...this.bots.values()].map((b) => b.wahaSessionName);
    const entry = [...this.bots.entries()].find(([, b]) => b.wahaSessionName === sessionName);
    if (!entry) {
      logger.warn({ sessionName, knownSessions, botCount: this.bots.size }, 'No WA bot found for session name');
      return;
    }
    return this.handleMessage(entry[0], from, text);
  }

  async handleMessage(waBotId: string, from: string, text: string): Promise<void> {
    // Block group/broadcast messages; allow DMs (@c.us WEBJS, @lid GOWS)
    if (from.endsWith('@g.us') || from.endsWith('@newsletter') || from.endsWith('@broadcast')) return;

    const bot = this.bots.get(waBotId);
    if (!bot) return;

    // Strip JID suffix — phone for @c.us, opaque LID for @lid (used as conversation key)
    const phone = from.replace(/@c\.us$|@lid$|@s\.whatsapp\.net$/, '');
    const key = `${waBotId}:${phone}`;
    const pending = await this.getPending(key);
    const body = text.trim();

    const apiKey = bot.wahaApiKeyEnc ? decryptString(bot.wahaApiKeyEnc) : undefined;
    const send = (msg: string) => wahaSend(bot.wahaUrl, bot.wahaSessionName, from, msg, apiKey);

    // Accept both bare words and slash-commands (/bye, /menu, …)
    const lc = body.toLowerCase().trim().replace(/^\//, '');

    // Global commands — work at any point in the conversation
    if (['stop', 'cancel', 'exit', 'quit', 'bye', 'end'].some((w) => lc === w)) {
      await this.clearPending(key);
      await send('👋 Chat ended. Send *hi* whenever you\'re ready to subscribe!');
      return;
    }

    if (['restart', 'reset', 'menu', 'back', 'main menu'].some((w) => lc === w)) {
      await this.clearPending(key);
      const premium = await this.findPremium(bot, phone, from);
      if (premium) await this.showPremiumChoice(bot, waBotId, phone, premium.name ?? null, send);
      else await this.showVerticalChoice(waBotId, phone, send);
      return;
    }

    if (!pending) {
      if (['hi', 'hello', 'hey', 'start', 'plans', 'subscribe'].some((w) => lc.startsWith(w))) {
        // premium: choose jobs categories or tender feed; standard: pick a vertical to subscribe to
        const premium = await this.findPremium(bot, phone, from);
        if (premium) {
          await this.showPremiumChoice(bot, waBotId, phone, premium.name ?? null, send);
        } else {
          await this.showVerticalChoice(waBotId, phone, send);
        }
      } else {
        await send('👋 Send *hi* to see our plans.\n\n_Commands: */menu* — start over · */bye* — end chat_');
      }
      return;
    }

    if (pending.kind === 'awaitVertical') {
      const choice = body.trim();
      if (choice === '1' || /job/i.test(choice)) {
        await this.showPlans(bot, waBotId, phone, from, send, 'jobs');
      } else if (choice === '2' || /tender/i.test(choice)) {
        await this.showPlans(bot, waBotId, phone, from, send, 'tenders');
      } else {
        await send('Please reply *1* for Jobs or *2* for Tenders.');
      }
      return;
    }

    if (pending.kind === 'awaitPremiumChoice') {
      const choice = body.trim();
      if (choice === '1' || /job/i.test(choice)) {
        if (categorizerEnabled()) await this.showCategories(bot, waBotId, phone, null, send);
        else await send('⭐ Job categories are momentarily offline. Try again shortly!');
      } else if (choice === '2' || /tender/i.test(choice)) {
        await this.clearPending(key);
        await this.sendRecentTenders(send);
      } else {
        await send('Please reply *1* for Jobs or *2* for Tenders.');
      }
      return;
    }

    if (pending.kind === 'awaitCategorySelection') {
      const num = parseInt(body, 10);
      if (isNaN(num) || num < 1 || num > pending.categories.length) {
        await send(`Please reply with a number between 1 and ${pending.categories.length}.`);
        return;
      }
      const category = pending.categories[num - 1];
      const jobs = await todayJobsByCategory(category);
      if (jobs.length === 0) {
        await send(`No *${category}* roles in the last 24 hours. Reply */menu* to pick another category — new jobs land daily at 07:00. 🗞️`);
        return;
      }
      let msg = `🎯 *${category}* — ${jobs.length} role${jobs.length !== 1 ? 's' : ''} in the last 24 hours\n`;
      jobs.forEach((j, i) => {
        msg += `\n*${i + 1}. ${j.title}*\n`;
        msg += `🏢 ${j.bankName}${j.location ? ` · 📍 ${j.location}` : ''}\n`;
        const s = cleanSummaryForChat((j as any).summary);
        if (s) msg += `_${s}_\n`;
        msg += `🔗 ${j.url}\n`;
      });
      msg += `\n_Reply */menu* for more categories · */bye* to end_`;
      await this.clearPending(key);
      await send(msg.trim());
      return;
    }

    if (pending.kind === 'awaitPlanSelection') {
      const num = parseInt(body, 10);
      if (isNaN(num) || num < 1 || num > pending.planIds.length) {
        await send(`Please reply with a number between 1 and ${pending.planIds.length}.`);
        return;
      }
      const planId = pending.planIds[num - 1];
      const plan = await PlanModel.findById(planId).lean();
      if (!plan || !plan.isActive) { await send('That plan is no longer available. Send *hi* to see current plans.'); return; }

      // Trial plans are once per number — ever
      if (/trial/i.test(plan.name)) {
        const used = await SubscriptionModel.exists({
          platform: 'whatsapp', waBotId: bot._id, whatsappPhone: phone, planId: plan._id
        });
        if (used) {
          await send(`You've already used the *${plan.name}* — it's once per number. 😊\n\nReply */menu* to pick one of our regular plans!`);
          return;
        }
      }

      // Free plans skip payment — instant activation
      if (plan.amountKobo === 0) {
        await this.clearPending(key);
        await this.startFreeTrial(bot, plan, phone, from, send, pending.vertical);
        return;
      }

      await this.setPending(key, { kind: 'awaitPaymentMethod', waBotId, planId, vertical: pending.vertical });
      await send(
        `You selected *${plan.name}* — ${fmt(plan.amountKobo, plan.currency)}.\n\nHow would you like to pay?\n\n*1.* 📱 M-Pesa\n*2.* 💳 Card / Bank\n\nReply *1* or *2*:`
      );
      return;
    }

    if (pending.kind === 'awaitPaymentMethod') {
      const choice = body;
      if (choice === '1' || /mpesa/i.test(choice)) {
        await this.setPending(key, { kind: 'awaitPhone', waBotId, planId: pending.planId, vertical: pending.vertical });
        await send('Enter your Kenyan mobile number (e.g. 0712345678 or +254712345678):');
      } else if (choice === '2' || /card|bank/i.test(choice)) {
        await this.clearPending(key);
        await this.startCardFlow(bot, waBotId, pending.planId, phone, from, send, pending.vertical);
      } else {
        await send('Please reply *1* for M-Pesa or *2* for Card/Bank.');
      }
      return;
    }

    if (pending.kind === 'awaitPhone') {
      const normalized = normaliseKenyanPhone(body);
      if (!normalized) {
        await send('That doesn\'t look like a valid Kenyan number. Try again (e.g. 0712345678):');
        return;
      }
      await this.clearPending(key);
      await this.startMpesaFlow(bot, waBotId, pending.planId, phone, from, normalized, send, pending.vertical);
      return;
    }

    if (pending.kind === 'awaitSupport') {
      if (body.length < 5) { await send('Please add more detail to your message.'); return; }
      await QueryModel.create({ botId: null, telegramUserId: null, text: `[WhatsApp:${phone}] ${body}`, status: 'open' });
      await this.clearPending(key);
      await send('✅ Got it! Support will reach out soon.');
      return;
    }
  }

  // LID → phone cache (GOWS contacts arrive as opaque LIDs; premium is
  // managed by real numbers in the portal)
  private lidCache = new Map<string, string | null>();

  /** Find an active premium record for this sender — by raw key or resolved phone. */
  private async findPremium(bot: any, phone: string, from: string): Promise<any | null> {
    const candidates = [phone];
    if (from.endsWith('@lid')) {
      if (!this.lidCache.has(phone)) {
        const apiKey = bot.wahaApiKeyEnc ? decryptString(bot.wahaApiKeyEnc) : undefined;
        this.lidCache.set(phone, await lidToPhone(bot.wahaUrl, bot.wahaSessionName, from, apiKey));
      }
      const resolved = this.lidCache.get(phone);
      if (resolved) candidates.push(resolved);
    }
    return PremiumUserModel.findOne({
      phone: { $in: candidates }, isActive: true,
      $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }]
    }).lean();
  }

  /** Standard users: pick which feed to subscribe to. */
  private async showVerticalChoice(waBotId: string, phone: string, send: (m: string) => Promise<void>): Promise<void> {
    await this.setPending(`${waBotId}:${phone}`, { kind: 'awaitVertical', waBotId });
    await send(
      '👋 *Welcome to Wisdom Busara!*\n\nWhat are you looking for?\n\n' +
      '*1.* 💼 Job alerts\n*2.* 📋 Tender alerts\n\n' +
      'Reply *1* or *2*.\n\n_⭐ Premium members get both._'
    );
  }

  /** Premium members: pick jobs (categorized) or tenders. */
  private async showPremiumChoice(bot: any, waBotId: string, phone: string, name: string | null, send: (m: string) => Promise<void>): Promise<void> {
    await this.setPending(`${waBotId}:${phone}`, { kind: 'awaitPremiumChoice', waBotId });
    const hi = name ? `⭐ Hi *${name}*` : '⭐ Welcome back';
    await send(
      `${hi} — you're on *Wisdom Busara Premium* 🎯\n\nWhat would you like today?\n\n` +
      '*1.* 💼 Jobs (by category)\n*2.* 📋 Tenders (last 24h)\n\n' +
      'Reply *1* or *2*.\n\n_Commands: */menu* · */bye*_'
    );
  }

  /** Premium tender feed — last 24h, grouped by source. */
  private async sendRecentTenders(send: (m: string) => Promise<void>): Promise<void> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const tenders = await JobModel.find({ vertical: 'tenders', firstSeenAt: { $gte: since } })
      .sort({ bankName: 1 }).limit(40).lean();
    if (tenders.length === 0) {
      await send('📋 No new tenders in the last 24 hours. The daily scan lands at 07:20 EAT — check back then! Reply */menu* for jobs.');
      return;
    }
    const bySource: Record<string, typeof tenders> = {};
    for (const t of tenders) (bySource[t.bankName] ??= []).push(t);
    let msg = `📋 *Tenders — last 24 hours* (${tenders.length})\n`;
    for (const [source, list] of Object.entries(bySource)) {
      msg += `\n━━ *${source}* ━━\n`;
      for (const t of list) {
        msg += `\n📋 *${t.title}*\n`;
        if ((t as any).deadline) msg += `📅 Closing: ${(t as any).deadline}\n`;
        if ((t as any).description) msg += `📝 ${(t as any).description}\n`;
        msg += `📄 Details & how to apply:\n${t.url}\n`;
      }
    }
    msg += `\n_Reply */menu* to switch to jobs._`;
    await send(msg.trim());
  }

  /** Premium members: category menu with today's counts. */
  private async showCategories(bot: any, waBotId: string, phone: string, name: string | null, send: (m: string) => Promise<void>): Promise<void> {
    const counts = await todayCategoryCounts();
    const greeting = name ? `👋 Hi *${name}*` : '👋 Welcome back';
    if (counts.length === 0) {
      await send(`${greeting} — you're on *Wisdom Busara Premium*.\n\nNo categorized jobs in the last 24 hours yet. The daily scan lands at 07:00 EAT — check back then! 🗞️`);
      return;
    }
    let msg = `${greeting} — *Wisdom Busara Premium* 🎯\n\nJob categories from the last 24 hours:\n\n`;
    counts.forEach((c, i) => {
      msg += `*${i + 1}.* ${c.category} (${c.count})\n`;
    });
    msg += '\nReply with a number to get those jobs.\n\n_Commands: */menu* — categories · */bye* — end chat_';
    await this.setPending(`${waBotId}:${phone}`, {
      kind: 'awaitCategorySelection', waBotId,
      categories: counts.map((c) => c.category)
    });
    await send(msg);
  }

  private async showPlans(bot: any, waBotId: string, phone: string, from: string, send: (m: string) => Promise<void>, vertical: Vertical = 'jobs'): Promise<void> {
    const plans = await PlanModel.find({ isActive: true, $or: [{ vertical }, ...(vertical === 'jobs' ? [{ vertical: { $exists: false } }] : [])] }).sort({ amountKobo: 1 }).lean();
    if (plans.length === 0) { await send(`No ${vertical} plans available right now. Check back soon!`); return; }

    let msg = `${vertical === 'tenders' ? '📋' : '💼'} *${vertical === 'tenders' ? 'Tender' : 'Job'} alerts — choose a plan:*\n\n`;
    plans.forEach((p, i) => {
      const desc = p.description ? ` — ${p.description}` : '';
      msg += `*${i + 1}.* ${p.name} (${p.amountKobo === 0 ? '🎁 FREE TRIAL' : fmt(p.amountKobo, p.currency)})${desc}\n`;
    });
    msg += '\nReply with the plan number to subscribe.\n\n_Commands: */menu* — start over · */bye* — end chat_';

    await this.setPending(`${waBotId}:${phone}`, {
      kind: 'awaitPlanSelection',
      waBotId, vertical,
      planIds: plans.map((p) => String(p._id))
    });

    await send(msg);
  }

  private async startFreeTrial(bot: any, plan: any, phone: string, from: string, send: (m: string) => Promise<void>, vertical: Vertical = 'jobs'): Promise<void> {
    // One trial per number — any prior subscription on this plan disqualifies
    const used = await SubscriptionModel.exists({
      platform: 'whatsapp', waBotId: bot._id, whatsappPhone: phone, planId: plan._id
    });
    if (used) {
      await send(`You've already used the *${plan.name}* trial. Send *hi* to pick a paid plan — your next digest is waiting! 🗞️`);
      return;
    }

    await send(`🎁 Activating your free *${plan.name}* trial…`);

    const reference = `wraith_trial_${String(bot._id)}_${phone}_${nanoid(8)}`;
    const { addedDirectly, inviteLink } = await grantWhatsAppAccess({
      waBot: bot, plan, phone, chatId: from, reference, vertical
    });

    let msg = `✅ *Free trial active!* You have *${plan.name}* access.\n\n`;
    if (addedDirectly) msg += `You've been added to *Wisdom Busara* group! 🎉`;
    else if (inviteLink) msg += `👇 Join the group with this link — *it expires in 5 minutes*:\n${inviteLink}`;
    else msg += `Please ask an admin to add you to the group.`;
    await send(msg);
  }

  private async startCardFlow(bot: any, waBotId: string, planId: string, phone: string, from: string, send: (m: string) => Promise<void>, vertical: Vertical = 'jobs'): Promise<void> {
    const plan = await PlanModel.findById(planId).lean();
    if (!plan || !plan.isActive) { await send('That plan is no longer available. Send *hi* to see current plans.'); return; }

    const email = placeholderEmail(phone);
    const reference = `wraith_wa_${waBotId}_${phone}_${nanoid(8)}`;
    const callbackUrl = env.PAYSTACK_CALLBACK_BASE_URL
      ? `${env.PAYSTACK_CALLBACK_BASE_URL.replace(/\/$/, '')}/paystack/callback`
      : undefined;

    const { authorizationUrl } = await initializeTransaction({
      amountKobo: plan.amountKobo,
      email,
      reference,
      currency: plan.currency,
      callbackUrl,
      metadata: { project: 'wraith-api', platform: 'whatsapp', waBotId, planId, whatsappPhone: phone }
    });

    await PaymentModel.create({
      reference,
      botId: new Types.ObjectId('000000000000000000000000'), // placeholder
      planId: plan._id,
      telegramUserId: 0,
      email,
      amountKobo: plan.amountKobo,
      currency: plan.currency,
      authorizationUrl,
      status: 'initialized',
      platform: 'whatsapp',
      vertical,
      waBotId: bot._id,
      whatsappPhone: phone,
      whatsappChatId: from  // full JID (e.g. 54675453780183@lid or 254712345678@c.us)
    });

    await send(
      `💳 Click the link below to pay *${fmt(plan.amountKobo, plan.currency)}* for *${plan.name}*:\n\n${authorizationUrl}\n\nYou'll be added to the group automatically after payment! ✅`
    );
  }

  private async startMpesaFlow(bot: any, waBotId: string, planId: string, phone: string, from: string, mpesaPhone: string, send: (m: string) => Promise<void>, vertical: Vertical = 'jobs'): Promise<void> {
    const plan = await PlanModel.findById(planId).lean();
    if (!plan || !plan.isActive) { await send('That plan is no longer available. Send *hi* to see current plans.'); return; }

    const email = placeholderEmail(phone);
    const reference = `wraith_wa_${waBotId}_${phone}_${nanoid(8)}`;

    await send(`📲 Sending M-Pesa prompt to +${mpesaPhone}…`);

    try {
      await chargeMpesa({
        amountKobo: plan.amountKobo,
        email,
        phone: `+${mpesaPhone}`,
        reference,
        metadata: { project: 'wraith-api', platform: 'whatsapp', waBotId, planId, whatsappPhone: phone }
      });
    } catch (err: any) {
      logger.error({ err, phone: mpesaPhone }, 'WA M-Pesa charge failed');
      await send('❌ Could not send M-Pesa prompt. Please check your number and try again. Send *hi* to restart.');
      return;
    }

    await PaymentModel.create({
      reference,
      botId: new Types.ObjectId('000000000000000000000000'),
      planId: plan._id,
      telegramUserId: 0,
      email,
      amountKobo: plan.amountKobo,
      currency: 'KES',
      status: 'initialized',
      platform: 'whatsapp',
      vertical,
      waBotId: bot._id,
      whatsappPhone: phone,
      whatsappChatId: from  // full JID (e.g. 54675453780183@lid or 254712345678@c.us)
    });

    await send(
      `📱 Check your phone! Enter your M-Pesa PIN to pay *${fmt(plan.amountKobo, 'KES')}* for *${plan.name}*.\n\nYou'll be added to the group automatically once payment is confirmed! ✅`
    );
  }
}
