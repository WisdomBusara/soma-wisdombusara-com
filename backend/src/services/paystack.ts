import axios from 'axios';
import { env } from '../config/env';
import { logger } from '../config/logger';

const paystack = axios.create({
  baseURL: 'https://api.paystack.co',
  timeout: 15_000,
  headers: {
    Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
    'Content-Type': 'application/json'
  }
});

/**
 * Axios throws a generic "Request failed with status code NNN" for any
 * non-2xx response, discarding the body Paystack actually sent — which is
 * where the real reason lives (e.g. "Mobile money is not enabled for this
 * integration"). Unwrap it so callers and logs see that message instead.
 */
function unwrapPaystackError(err: unknown, fallback: string): Error {
  if (axios.isAxiosError(err)) {
    const body = err.response?.data as { message?: string } | undefined;
    const message = body?.message || fallback;
    logger.error({ status: err.response?.status, body: err.response?.data }, 'paystack: request rejected');
    return Object.assign(new Error(message), { status: 502 });
  }
  return Object.assign(new Error(fallback), { status: 502 });
}

export type PaystackInitializeParams = {
  amountKobo: number;
  email: string;
  reference: string;
  callbackUrl?: string;
  currency?: string;
  metadata?: Record<string, unknown>;
};

export async function initializeTransaction(params: PaystackInitializeParams): Promise<{ authorizationUrl: string; reference: string }> {
  const body: any = {
    amount: params.amountKobo,
    email: params.email,
    reference: params.reference
  };
  if (params.callbackUrl) body.callback_url = params.callbackUrl;
  if (params.currency) body.currency = params.currency;
  if (params.metadata) body.metadata = params.metadata;

  let resp;
  try {
    resp = await paystack.post('/transaction/initialize', body);
  } catch (err) {
    throw unwrapPaystackError(err, 'Paystack initialize failed');
  }
  const data = resp.data;
  if (!data?.status || !data?.data?.authorization_url) {
    throw Object.assign(new Error(data?.message || 'Paystack initialize failed'), { status: 502 });
  }
  return { authorizationUrl: String(data.data.authorization_url), reference: String(data.data.reference) };
}

export async function chargeMpesa(params: {
  amountKobo: number;
  email: string;
  phone: string;
  reference: string;
  metadata?: Record<string, unknown>;
}): Promise<{ chargeStatus: string; reference: string }> {
  // Paystack's mobile_money charge rejects both the local "0712…" form and the
  // bare "254712…" form with "Invalid phone number format" — confirmed by
  // direct API testing. Only the E.164 "+254712…" form is accepted.
  const e164Phone = params.phone.startsWith('+') ? params.phone : `+${params.phone.replace(/^0/, '254')}`;

  const body: any = {
    amount: params.amountKobo,
    email: params.email,
    currency: 'KES',
    reference: params.reference,
    mobile_money: {
      phone: e164Phone,
      provider: 'mpesa'
    }
  };
  if (params.metadata) body.metadata = params.metadata;

  let resp;
  try {
    resp = await paystack.post('/charge', body);
  } catch (err) {
    throw unwrapPaystackError(err, 'Paystack M-Pesa charge failed');
  }
  const data = resp.data;
  if (!data?.status) throw Object.assign(new Error(data?.message || 'Paystack M-Pesa charge failed'), { status: 502 });
  return {
    chargeStatus: String(data.data?.status ?? ''),
    reference: String(data.data?.reference ?? params.reference)
  };
}

export async function verifyTransaction(reference: string): Promise<{
  status: 'success' | 'failed' | 'abandoned' | string;
  amountKobo: number;
  currency: string;
  customerEmail?: string;
}> {
  let resp;
  try {
    resp = await paystack.get(`/transaction/verify/${encodeURIComponent(reference)}`);
  } catch (err) {
    throw unwrapPaystackError(err, 'Paystack verify failed');
  }
  const data = resp.data;
  if (!data?.status || !data?.data) throw Object.assign(new Error(data?.message || 'Paystack verify failed'), { status: 502 });
  return {
    status: String(data.data.status),
    amountKobo: Number(data.data.amount ?? 0),
    currency: String(data.data.currency ?? 'NGN'),
    customerEmail: data.data.customer?.email ? String(data.data.customer.email) : undefined
  };
}
