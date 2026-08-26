import axios from 'axios';
import { env } from '../config/env';

const paystack = axios.create({
  baseURL: 'https://api.paystack.co',
  timeout: 15_000,
  headers: {
    Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
    'Content-Type': 'application/json'
  }
});

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

  const resp = await paystack.post('/transaction/initialize', body);
  const data = resp.data;
  if (!data?.status || !data?.data?.authorization_url) {
    throw Object.assign(new Error('Paystack initialize failed'), { status: 502 });
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
  const body: any = {
    amount: params.amountKobo,
    email: params.email,
    currency: 'KES',
    reference: params.reference,
    mobile_money: {
      phone: params.phone,
      provider: 'mpesa'
    }
  };
  if (params.metadata) body.metadata = params.metadata;

  const resp = await paystack.post('/charge', body);
  const data = resp.data;
  if (!data?.status) throw Object.assign(new Error('Paystack M-Pesa charge failed'), { status: 502 });
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
  const resp = await paystack.get(`/transaction/verify/${encodeURIComponent(reference)}`);
  const data = resp.data;
  if (!data?.status || !data?.data) throw Object.assign(new Error('Paystack verify failed'), { status: 502 });
  return {
    status: String(data.data.status),
    amountKobo: Number(data.data.amount ?? 0),
    currency: String(data.data.currency ?? 'NGN'),
    customerEmail: data.data.customer?.email ? String(data.data.customer.email) : undefined
  };
}
