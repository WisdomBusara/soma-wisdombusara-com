import pino from 'pino';

export const logger = pino({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      'req.body.token',
      'PAYSTACK_SECRET_KEY',
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET'
    ],
    remove: true
  }
});
