// Alert channels for the keyword watchlist, configured via .env (both optional):
//
//   ALERT_WEBHOOK_URL  — POST a JSON payload here on a match (works with
//                        ntfy.sh, Discord/Slack webhooks, or your own service).
//   ALERT_WHATSAPP_TO  — a phone/JID to receive the alert as a WhatsApp message
//                        (reuses the send path → needs ENABLE_SEND + whitelist).
//
// The WhatsApp send mechanism differs per backend (extension enqueues, baileys
// sends directly), so the caller injects a `sendWhatsApp(jid, text)` function.
import { recordAlert, getChat } from './store.js';
import { matchKeywords, watchEnabled } from './watchlist.js';

// Only alert on reasonably fresh messages, so a backfill of old history (which
// re-ingests through the same path) doesn't fire a storm of stale alerts.
const MAX_AGE_MS = Number(process.env.ALERT_MAX_AGE_MS) || 15 * 60 * 1000;

function normalizeJid(entry) {
  const e = String(entry ?? '').trim();
  if (!e) return '';
  if (e.includes('@')) return e.toLowerCase();
  const digits = e.replace(/\D/g, '');
  return digits ? `${digits}@s.whatsapp.net` : '';
}

const cfg = {
  webhookUrl: (process.env.ALERT_WEBHOOK_URL ?? '').trim(),
  whatsappTo: normalizeJid(process.env.ALERT_WHATSAPP_TO),
};

export function alertChannels() {
  const ch = [];
  if (cfg.webhookUrl) ch.push('webhook');
  if (cfg.whatsappTo) ch.push(`whatsapp:${cfg.whatsappTo}`);
  return ch;
}
export const alertsConfigured = () => !!(cfg.webhookUrl || cfg.whatsappTo);
export const alertWhatsappTarget = () => cfg.whatsappTo;

function buildText({ keywords, chatName, chatId, body }) {
  const where = chatName || chatId || 'desconhecido';
  const kw = (keywords || []).join(', ');
  const snippet = String(body || '').replace(/\s+/g, ' ').slice(0, 300);
  return `🔔 Watchlist "${kw}" em ${where}:\n${snippet}`;
}

async function postWebhook(alert) {
  const text = buildText(alert);
  // Generic JSON payload. `message`/`title` make it work out-of-the-box with
  // ntfy.sh's JSON publishing; the raw fields serve custom consumers.
  const payload = {
    title: 'WhatsApp watchlist',
    message: text,
    keywords: alert.keywords,
    chatId: alert.chatId,
    chatName: alert.chatName,
    body: alert.body,
    timestamp: alert.timestamp,
  };
  const res = await fetch(cfg.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`webhook ${res.status}`);
}

// Fire all configured channels. Best-effort: never throws (a failing alert must
// not break ingest); failures are logged.
export async function fireAlert(alert, { sendWhatsApp } = {}) {
  const tasks = [];
  if (cfg.webhookUrl) tasks.push(postWebhook(alert));
  if (cfg.whatsappTo && sendWhatsApp) tasks.push(Promise.resolve(sendWhatsApp(cfg.whatsappTo, buildText(alert))));
  const results = await Promise.allSettled(tasks);
  for (const r of results) {
    if (r.status === 'rejected') console.warn('[alerts] channel failed:', r.reason?.message ?? r.reason);
  }
}

// Scan freshly ingested inbound messages against the watchlist. Always records a
// hit (so `wa alerts` works even with no channels), and fires the configured
// channels once per (message, keyword). Shared by the extension (/ingest) and
// baileys paths; the caller injects how to send a WhatsApp message.
export async function processAlerts(messages, { sendWhatsApp } = {}) {
  if (!watchEnabled() || !Array.isArray(messages)) return;
  const now = Date.now();
  for (const m of messages) {
    if (!m || m.fromMe || !m.body) continue;
    if (now - Number(m.timestamp || 0) > MAX_AGE_MS) continue; // skip backfilled/old
    const kws = matchKeywords(m.body);
    if (!kws.length) continue;
    const fresh = kws.filter((k) =>
      recordAlert({ msgId: m.id, chatId: m.chatId, keyword: k, body: m.body, at: now }));
    if (!fresh.length) continue; // already alerted on this message
    if (!alertsConfigured()) continue; // recorded only (no push channel set)
    const chatName = getChat(m.chatId)?.name ?? m.chatName ?? null;
    await fireAlert(
      { keywords: fresh, chatId: m.chatId, chatName, body: m.body, timestamp: m.timestamp },
      { sendWhatsApp }
    );
  }
}
