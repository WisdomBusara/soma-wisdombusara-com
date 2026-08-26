/**
 * Test environment bootstrap.
 *
 * Several scholarship services import config/env, which validates the full
 * production schema at module load. Rather than weakening that schema (it is
 * doing exactly its job — refusing to boot half-configured), tests supply
 * throwaway placeholder values here.
 *
 * These are NOT secrets. They are syntactically valid nonsense that exists only
 * so the zod schema resolves inside a unit test. Nothing here is used to reach
 * a real service: MONGO_URI points at a non-existent local database and no test
 * in this suite opens a connection.
 */

const TEST_DEFAULTS: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '8080',
  MONGO_URI: 'mongodb://127.0.0.1:27017/scholarship-test',
  CORS_ORIGIN: 'http://localhost:5173',
  COOKIE_SECURE: 'false',
  COOKIE_SAMESITE: 'LAX',
  JWT_ACCESS_SECRET: 'test-only-access-secret-not-a-real-key-000000',
  JWT_REFRESH_SECRET: 'test-only-refresh-secret-not-a-real-key-00000',
  JWT_ISSUER: 'wraith-backend-test',
  ENCRYPTION_KEY_BASE64: 'dGVzdC1vbmx5LWtleS0zMi1ieXRlcy0wMDAwMDAwMA==',
  INITIAL_ADMIN_EMAIL: 'test@example.com',
  INITIAL_ADMIN_PASSWORD: 'test-password-not-real',
  PAYSTACK_SECRET_KEY: 'sk_test_placeholder',

  // Engine defaults for deterministic assertions
  SCHOLARSHIP_CLOSING_SOON_DAYS: '14',
  SCHOLARSHIP_MIN_CONFIDENCE: '0.45',
  SCHOLARSHIP_CRAWLER_ENABLED: 'false',
  AI_EXTRACTION_ENABLED: 'false',
  PLAYWRIGHT_ENABLED: 'false',
  UNIVERSITY_DISCOVERY_ENABLED: 'false'
};

for (const [key, value] of Object.entries(TEST_DEFAULTS)) {
  // Never clobber a value the developer set deliberately
  if (process.env[key] === undefined) process.env[key] = value;
}
