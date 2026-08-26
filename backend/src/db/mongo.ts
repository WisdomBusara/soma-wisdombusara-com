import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../config/logger';

export async function connectMongo(): Promise<void> {
  mongoose.set('strictQuery', true);
  await mongoose.connect(env.MONGO_URI, {
    autoIndex: env.NODE_ENV !== 'production'
  });
  logger.info({ mongo: mongoose.connection.name }, 'MongoDB connected');
}
