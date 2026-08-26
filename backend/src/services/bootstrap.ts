import { env } from '../config/env';
import { logger } from '../config/logger';
import { AdminUserModel } from '../models/AdminUser';
import { PlanModel } from '../models/Plan';
import { hashPassword } from '../utils/password';

export async function bootstrap(): Promise<void> {
  const existing = await AdminUserModel.findOne({ email: env.INITIAL_ADMIN_EMAIL.toLowerCase() }).lean();
  if (!existing) {
    const count = await AdminUserModel.estimatedDocumentCount();
    if (count === 0) {
      const passwordHash = await hashPassword(env.INITIAL_ADMIN_PASSWORD);
      await AdminUserModel.create({ email: env.INITIAL_ADMIN_EMAIL.toLowerCase(), passwordHash, role: 'owner', isActive: true });
      logger.warn({ email: env.INITIAL_ADMIN_EMAIL }, 'Initial admin created — change password immediately');
    }
  }

  const planCount = await PlanModel.estimatedDocumentCount();
  if (planCount === 0) {
    await PlanModel.create([
      { name: 'Trial', durationMinutes: 5, amountKobo: 200, currency: 'KES', description: '5 min test', isActive: true },
      { name: 'Starter', durationMinutes: 15, amountKobo: 1000, currency: 'KES', description: '15 min test', isActive: true },
      { name: 'Basic', durationMinutes: 60, amountKobo: 5000, currency: 'KES', description: '1 hour', isActive: true },
      { name: 'Day Pass', durationMinutes: 24 * 60, amountKobo: 20000, currency: 'KES', description: '24 hour access', isActive: true },
      { name: 'Week Pass', durationMinutes: 7 * 24 * 60, amountKobo: 100000, currency: 'KES', description: '7 day access', isActive: true }
    ]);
    logger.warn('Default plans seeded — update videoUrl and prices in dashboard');
  }
}
