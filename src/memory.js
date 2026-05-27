// Per-chat daily/weekly memory. On-demand only — no scheduler, no background
// work. The caller (HTTP route, CLI) decides when to build, this module turns
// a (chat, period, when) into an LLM-written summary and persists it.
//
// Cumulative: when building a daily memory, the previous daily + latest weekly
// are passed to the LLM as prior context so it can carry facts/decisions
// forward (mirroring Claude Code's session memory behavior). Weekly builds
// fold the week's dailies (or raw messages if dailies don't exist).
//
//   MEMORY_MIN_MESSAGES = 5   (default; a chat needs this many messages in the
//                              period before it's eligible for `--all` builds)
//
// SUMMARY_PROVIDER must be set (groq | openai | claude) — same provider used by
// /digest?summarize=true.

import {
  messagesInRange, listChatsWithActivity, upsertChatMemory,
  getChatMemories, getLatestChatMemory, getChat,
} from './store.js';
import { summarize, summaryEnabled, summaryProvider } from './ai.js';

const DAY_MS = 86_400_000;

export function memoryConfig() {
  return {
    enabled: summaryEnabled(),
    provider: summaryProvider(),
    minMessages: Math.max(1, parseInt(process.env.MEMORY_MIN_MESSAGES ?? '5', 10) || 5),
  };
}

// Local-time bounds (the user thinks in their own calendar, not UTC).
export function dayBounds(when = Date.now()) {
  const d = new Date(when);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
  return { start, end: start + DAY_MS };
}

// ISO week: Monday → next Monday. JS getDay() is 0=Sun..6=Sat, so the days
// since Monday are (day + 6) % 7.
export function weekBounds(when = Date.now()) {
  const d = new Date(when);
  const dow = d.getDay();
  const daysFromMonday = (dow + 6) % 7;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysFromMonday, 0, 0, 0, 0);
  return { start: monday.getTime(), end: monday.getTime() + 7 * DAY_MS };
}

export function boundsFor(period, when) {
  return period === 'weekly' ? weekBounds(when) : dayBounds(when);
}

const pad = (n) => String(n).padStart(2, '0');
function ymd(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function hm(ms) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Turn raw message rows into a compact transcript for the LLM. We strip noise
// (empty bodies, edits markers fold inline) and label the user as "eu".
function renderTranscript(messages, { isGroup, chatName }) {
  const lines = [];
  for (const m of messages) {
    const body = (m.body ?? '').replace(/\s+/g, ' ').trim();
    if (!body && !m.deletedAt) continue;
    const who = m.fromMe
      ? 'eu'
      : (m.senderName || (!isGroup && chatName) || String(m.sender || '').split('@')[0] || 'eles');
    const flags = [];
    if (m.deletedAt) flags.push('apagada');
    if (m.editedAt) flags.push('editada');
    const tag = flags.length ? ` (${flags.join(', ')})` : '';
    lines.push(`[${hm(m.timestamp)}] ${who}: ${body}${tag}`);
  }
  return lines.join('\n');
}

// Prior memory blocks (latest of each period) so the LLM can carry context.
// We don't load the entire history — the latest of each is enough signal and
// keeps the prompt bounded.
function priorMemoryBlock(chatId, currentPeriod) {
  const blocks = [];
  const lastWeek = getLatestChatMemory(chatId, 'weekly');
  if (lastWeek) {
    blocks.push(`### Memória semanal anterior (${ymd(lastWeek.periodStart)} – ${ymd(lastWeek.periodEnd - 1)}):\n${lastWeek.summary}`);
  }
  // For daily we also surface the latest daily so day-over-day continuity is
  // visible. For weekly builds, the dailies of this week are already in the
  // transcript-equivalent content, so we skip them here.
  if (currentPeriod === 'daily') {
    const lastDay = getLatestChatMemory(chatId, 'daily');
    if (lastDay) {
      blocks.push(`### Memória do dia anterior (${ymd(lastDay.periodStart)}):\n${lastDay.summary}`);
    }
  }
  return blocks.join('\n\n');
}

// Weekly builds prefer the week's own daily memories (cheaper, denser) and
// fall back to raw messages if none exist (or to augment if only some days
// have memories).
function weeklyInputBlock(chatId, start, end, messages, ctx) {
  const dailies = getChatMemories(chatId, { period: 'daily', limit: 50 })
    .filter((m) => m.periodStart >= start && m.periodStart < end)
    .sort((a, b) => a.periodStart - b.periodStart);
  if (dailies.length === 0) {
    return `### Mensagens da semana (${messages.length}):\n${renderTranscript(messages, ctx)}`;
  }
  const out = ['### Memórias diárias desta semana:'];
  for (const d of dailies) out.push(`#### ${ymd(d.periodStart)}\n${d.summary}`);
  if (dailies.length < 7) {
    out.push('\n### Mensagens da semana (referência completa):', renderTranscript(messages, ctx));
  }
  return out.join('\n\n');
}

const SYSTEM_PROMPT = `Você é o sistema de memória do WhatsApp do dono da conta. Para cada conversa, você gera uma "nota de memória" daquele período (dia ou semana) — não uma transcrição.

Estilo da nota:
- Português, objetivo, sem floreio.
- Estruture em seções curtas com cabeçalhos:
  ## Resumo  — 2–4 linhas com o que rolou de mais relevante.
  ## Decisões e combinados  — bullets do que foi acertado (datas, valores, próximos passos).
  ## Pendências e ações  — bullets do que ficou em aberto, quem deve fazer o quê, com prazo se houver.
  ## Fatos pra lembrar  — informações novas sobre a pessoa/grupo/negócio que valem persistir (preferências, contexto pessoal, mudanças).
  ## Tom / clima  — uma linha sobre o clima da conversa (cordial, tenso, animado, frustrado…).
- Omita seções sem conteúdo. Não invente.
- Se existir "memória anterior", incorpore e atualize — não repita o que já estava lá; foque no que mudou ou no que foi reforçado.
- Mensagens marcadas "apagada" foram apagadas pela pessoa: pode mencionar de forma neutra ("X apagou uma mensagem sobre Y") se for relevante.
- Quando a pessoa pediu algo de você e ainda não foi respondido, coloque em "Pendências".`;

function buildUserPrompt({ chat, period, start, end, messages, isGroup }) {
  const ctx = { isGroup, chatName: chat?.name };
  const header = [
    `Conversa: ${chat?.name || chat?.jid || 'desconhecida'}`,
    `Tipo: ${isGroup ? 'Grupo' : 'Conversa individual'}`,
    `Período: ${period === 'weekly' ? 'Semana' : 'Dia'} ${ymd(start)}${period === 'weekly' ? ` – ${ymd(end - 1)}` : ''}`,
    `Total de mensagens no período: ${messages.length}`,
  ].join('\n');

  const prior = priorMemoryBlock(chat.jid, period);
  const body = period === 'weekly'
    ? weeklyInputBlock(chat.jid, start, end, messages, ctx)
    : `### Mensagens (${messages.length}):\n${renderTranscript(messages, ctx)}`;

  const parts = [header];
  if (prior) parts.push(prior);
  parts.push(body);
  parts.push('Gere a nota de memória conforme o estilo descrito no system prompt.');
  return parts.join('\n\n');
}

// Build memory for one chat in one period. Returns { skipped, reason } when
// there's nothing to do, or the persisted memory row on success.
export async function buildMemoryForChat(chatId, { period = 'daily', when = Date.now(), force = false, minMessages } = {}) {
  if (period !== 'daily' && period !== 'weekly') throw new Error(`invalid period "${period}" (expected daily | weekly)`);
  if (!summaryEnabled()) throw new Error('SUMMARY_PROVIDER is off — set it (groq|openai|claude) to enable memory.');

  const cfg = memoryConfig();
  const threshold = Number.isFinite(minMessages) ? minMessages : cfg.minMessages;

  const chat = getChat(chatId);
  if (!chat) return { ok: false, skipped: true, reason: 'chat not found', chatId };
  const isGroup = chat.isGroup === 1 || String(chatId).endsWith('@g.us');

  const { start, end } = boundsFor(period, when);
  const messages = messagesInRange(chatId, start, end);
  if (messages.length < threshold) {
    return {
      ok: false, skipped: true,
      reason: `only ${messages.length} message(s) in ${period} ${ymd(start)} (min ${threshold})`,
      chatId, period, periodStart: start, periodEnd: end, messageCount: messages.length,
    };
  }

  // Idempotent: if a memory for this exact window exists and the message count
  // hasn't changed, skip unless --force.
  const existing = getChatMemories(chatId, { period, limit: 10 }).find((m) => m.periodStart === start);
  if (existing && !force && existing.messageCount === messages.length) {
    return { ok: true, skipped: true, reason: 'already built and unchanged', memory: existing };
  }

  const content = buildUserPrompt({ chat: { ...chat, jid: chatId }, period, start, end, messages, isGroup });
  const summary = await summarize({ system: SYSTEM_PROMPT, content });

  const memory = upsertChatMemory({
    chatId, period, periodStart: start, periodEnd: end,
    messageCount: messages.length, summary,
    model: cfg.provider,
  });
  return { ok: true, memory };
}

// Build memories for every chat with enough activity in the period. Sequential
// (not parallel) so we don't fan out dozens of LLM calls at once and trip rate
// limits. Returns per-chat results so the caller can show what was done.
export async function buildMemoryForAll({ period = 'daily', when = Date.now(), minMessages, force = false } = {}) {
  if (!summaryEnabled()) throw new Error('SUMMARY_PROVIDER is off — set it (groq|openai|claude) to enable memory.');
  const cfg = memoryConfig();
  const threshold = Number.isFinite(minMessages) ? minMessages : cfg.minMessages;
  const { start, end } = boundsFor(period, when);
  const eligible = listChatsWithActivity({ start, end, minMessages: threshold });

  const results = [];
  for (const c of eligible) {
    try {
      const r = await buildMemoryForChat(c.jid, { period, when, force, minMessages: threshold });
      results.push({ chatId: c.jid, name: c.name, messageCount: c.messageCount, ...r });
    } catch (e) {
      results.push({ chatId: c.jid, name: c.name, ok: false, error: String(e.message ?? e) });
    }
  }
  return {
    period, periodStart: start, periodEnd: end, minMessages: threshold,
    eligible: eligible.length,
    built: results.filter((r) => r.ok && !r.skipped).length,
    skipped: results.filter((r) => r.skipped).length,
    failed: results.filter((r) => !r.ok && !r.skipped).length,
    results,
  };
}
