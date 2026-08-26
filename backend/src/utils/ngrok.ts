import axios from 'axios';
import { env } from '../config/env';
import { logger } from '../config/logger';

export async function getNgrokPublicBaseUrl(): Promise<string | undefined> {
  const apiBase = String(env.NGROK_API_URL ?? '').trim();
  if (!apiBase) return undefined;
  try {
    const url = `${apiBase.replace(/\/$/, '')}/api/tunnels`;
    const resp = await axios.get<any>(url, { timeout: 4_000 });
    const tunnels: any[] = Array.isArray(resp.data?.tunnels) ? resp.data.tunnels : [];
    if (tunnels.length === 0) return undefined;
    let tunnel = env.NGROK_TUNNEL_NAME ? tunnels.find((t) => t.name === env.NGROK_TUNNEL_NAME) : undefined;
    if (!tunnel) tunnel = tunnels.find((t) => String(t.public_url ?? '').startsWith('https://'));
    if (!tunnel) tunnel = tunnels[0];
    const publicUrl = String(tunnel?.public_url ?? '').trim();
    return publicUrl ? publicUrl.replace(/\/$/, '') : undefined;
  } catch (err) {
    logger.warn({ err }, 'Ngrok API not reachable');
    return undefined;
  }
}
