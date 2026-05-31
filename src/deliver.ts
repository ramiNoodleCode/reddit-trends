import { evaluateAlerts, configFromEnv, type Alert, type AlertConfig } from './alerts';
import { sendTelegram, telegramFromEnv } from './notify';

// Shared alert delivery: evaluate spikes, format them, post to Telegram.
// Used by both the standalone `alert.js` entrypoint and the `watch.js` watcher.

const CONFIRM_ICON: Record<Alert['confirm'], string> = {
  confirmed: '✅',
  divergent: '⚠️',
  unconfirmed: '◽',
};
const CONFIRM_LABEL: Record<Alert['confirm'], string> = {
  confirmed: 'price/volume confirms',
  divergent: 'hype up, price falling',
  unconfirmed: 'chatter only',
};

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmt(a: Alert): string {
  const sign = (n: number) => (n >= 0 ? `+${n}` : `${n}`);
  const lines = [
    `🚨 <b>$${esc(a.ticker)}</b> · ${esc(a.filter)}`,
    `Mentions ${a.mentionsPrev} → ${a.mentionsNow} (${sign(a.pctJump)}%) · ~${a.velocity}/hr · z ${a.z}`,
  ];
  const conf: string[] = [];
  if (a.priceChangePct != null) conf.push(`price ${sign(a.priceChangePct)}%`);
  if (a.volRatio != null) conf.push(`vol ${a.volRatio}×`);
  conf.push(`${CONFIRM_ICON[a.confirm]} ${CONFIRM_LABEL[a.confirm]}`);
  lines.push(conf.join(' · '));
  const base = a.type === 'crypto' ? 'crypto' : 'stocks';
  lines.push(`https://apewisdom.io/${base}/${encodeURIComponent(a.ticker)}/`);
  return lines.join('\n');
}

// Evaluate + deliver. Returns a short summary line for logging.
export async function deliverAlerts(now: number = Date.now(), cfg: AlertConfig = configFromEnv()): Promise<string> {
  const stamp = new Date(now).toISOString();
  const alerts = evaluateAlerts(now, cfg);
  if (alerts.length === 0) return `[${stamp}] no spikes`;

  const tg = telegramFromEnv();
  if (!tg) {
    return `[${stamp}] ${alerts.length} spike(s) but TELEGRAM_BOT_TOKEN/CHAT_ID unset: ` + alerts.map((a) => `${a.ticker}(z${a.z})`).join(', ');
  }

  const header = alerts.length === 1 ? '' : `<b>${alerts.length} spikes</b>\n\n`;
  const text = header + alerts.map(fmt).join('\n\n');
  await sendTelegram(text, tg);
  return `[${stamp}] sent ${alerts.length} alert(s): ${alerts.map((a) => a.ticker).join(', ')}`;
}
