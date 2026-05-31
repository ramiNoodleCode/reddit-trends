import https from 'https';

// Minimal Telegram Bot API sender. Config comes from the environment so no
// secrets live in the repo:
//   TELEGRAM_BOT_TOKEN   bot token (reused from the existing bot)
//   TELEGRAM_CHAT_ID     target chat / supergroup id
//   TELEGRAM_THREAD_ID   optional forum topic (message_thread_id)

export interface TelegramConfig {
  token: string;
  chatId: string;
  threadId?: string;
}

export function telegramFromEnv(): TelegramConfig | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null;
  return { token, chatId, threadId: process.env.TELEGRAM_THREAD_ID || undefined };
}

export function sendTelegram(text: string, cfg: TelegramConfig): Promise<void> {
  const payload: Record<string, unknown> = {
    chat_id: cfg.chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (cfg.threadId) payload.message_thread_id = Number(cfg.threadId);
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        method: 'POST',
        hostname: 'api.telegram.org',
        path: `/bot${cfg.token}/sendMessage`,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        let resp = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (resp += c));
        res.on('end', () => {
          if (res.statusCode === 200) return resolve();
          reject(new Error(`Telegram HTTP ${res.statusCode}: ${resp}`));
        });
      }
    );
    req.setTimeout(12000, () => req.destroy(new Error('Telegram request timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
