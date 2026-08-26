import axios from 'axios';

const TELEGRAM_API_BASE = 'https://api.telegram.org';

function botUrl(token: string, method: string): string {
  return `${TELEGRAM_API_BASE}/bot${token}/${method}`;
}

export async function sendMessage(
  token: string,
  chatId: number | string,
  text: string,
  extra?: Record<string, unknown>
): Promise<void> {
  await axios.post(
    botUrl(token, 'sendMessage'),
    { chat_id: chatId, text, ...extra },
    { timeout: 10_000 }
  );
}

/**
 * Creates a single-use invite link (member_limit: 1).
 * Once one person uses it, the link is consumed and cannot be reused.
 */
export async function createSingleUseInviteLink(
  token: string,
  chatId: string,
  expireSeconds: number
): Promise<string> {
  const expireDate = Math.floor(Date.now() / 1000) + expireSeconds;
  const resp = await axios.post<any>(
    botUrl(token, 'createChatInviteLink'),
    {
      chat_id: chatId,
      member_limit: 1,
      expire_date: expireDate
    },
    { timeout: 10_000 }
  );
  const link = resp.data?.result?.invite_link;
  if (!link) throw Object.assign(new Error('Failed to create invite link'), { status: 502 });
  return String(link);
}

export async function unbanIfBanned(
  token: string,
  chatId: string,
  userId: number
): Promise<void> {
  try {
    await axios.post(
      botUrl(token, 'unbanChatMember'),
      { chat_id: chatId, user_id: userId, only_if_banned: true },
      { timeout: 10_000 }
    );
  } catch {
    // Ignore — user may not have been banned
  }
}

export async function kickChatMember(
  token: string,
  chatId: string,
  userId: number
): Promise<void> {
  await axios.post(
    botUrl(token, 'banChatMember'),
    { chat_id: chatId, user_id: userId, revoke_messages: false },
    { timeout: 10_000 }
  );
}
