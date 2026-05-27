import express from 'express';
import {
  listChats, getMessages, searchMessages, markChatRead, stats,
  searchContacts, getContact, searchChatsByName, getChat,
  saveMessage, upsertContact, markDeleted, applyEdit, lastMessageTimestamp,
  updateChatName, getMessageById,
  enqueueSend, claimPending, markSendResult, getSend,
  getUnreadDigest, getPendingReplies, listAlerts, getMentions,
  getChatMemories, listRecentMemories,
} from './store.js';
import { status, getQR, sendText, sendMedia } from './whatsapp.js';
import { isAllowed, listAllowed } from './whitelist.js';
import { resolveAlias, listAliases, addAlias, removeAlias } from './aliases.js';
import { getMediaConfig } from './media/index.js';
import { processMedia, mediaFileAbsPath } from './media/process.js';
import { summarize, summaryEnabled, summaryProvider } from './ai.js';
import { buildMemoryForChat, buildMemoryForAll, memoryConfig } from './memory.js';
import { processAlerts, alertChannels } from './alerts.js';
import { listKeywords } from './watchlist.js';
import { getUpdateStatus, getPendingCommits, checkForUpdates } from './updates.js';
import fs from 'node:fs';
import path from 'node:path';

// How long /chats/:id/messages waits for the extension to confirm a queued send
// before returning "still pending". With SSE push the tab usually confirms in
// 1-2s even in the background.
const SEND_WAIT_MS = 8000;
const SEND_POLL_MS = 250;

// How long /chats/:id/backfill waits for the tab to finish re-fetching history
// before returning "still running". Backfill of a long chat can take a while,
// so this is generous.
const BACKFILL_WAIT_MS = 25000;
const BACKFILL_DEFAULT_MAX = 2000; // safety cap on messages pulled per backfill
const AUTO_BACKFILL_COOLDOWN_MS = 60000; // debounce auto-backfill on reconnect
const MEDIA_FETCH_WAIT_MS = 25000; // how long /messages/:id/fetch-media waits for the tab

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Staged outbound media (downloaded from a URL) lives here until the send is
// confirmed, then it's cleaned up. Files sent from a disk path are never touched.
const OUTBOUND_MEDIA_DIR = path.resolve('data', 'outbound_media');

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4',
  '.wav': 'audio/wav', '.pdf': 'application/pdf', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip', '.txt': 'text/plain', '.csv': 'text/csv',
};
const EXT_BY_MIME = Object.fromEntries(Object.entries(MIME_BY_EXT).map(([e, m]) => [m, e]));
const mimeFromName = (name) => MIME_BY_EXT[path.extname(name).toLowerCase()] || 'application/octet-stream';
const extFromMime = (mime) => EXT_BY_MIME[mime] || '.bin';

export function createServer({ apiToken, sendEnabled, mode = 'baileys', agentPrefix = '' }) {
  // Prepend the agent/automation tag to outbound text/caption so the recipient
  // can tell a message came from a script/skill rather than a human. Behavior:
  //   override === false / ''     → no prefix for this send (escape hatch)
  //   override === <string>       → use this prefix for this send only
  //   override === undefined      → fall back to the server default
  //   default (env) is empty      → no prefix
  // A single space is always inserted between tag and message — dotenv strips
  // trailing whitespace on unquoted values, so making the separator implicit
  // avoids "[Agente]Hello" surprises. Users who want a different separator
  // bake it into the prefix itself (e.g. `[Agente]:` → `[Agente]: Hello`).
  function withAgentTag(text, override) {
    if (typeof text !== 'string' || text.length === 0) return text;
    if (override === false || override === '') return text;
    const prefix = typeof override === 'string' ? override : agentPrefix;
    if (!prefix) return text;
    return /\s$/.test(prefix) ? prefix + text : `${prefix} ${text}`;
  }
  const app = express();
  const media = getMediaConfig();
  // Base64-encoded media inflates ~33%, plus JSON overhead — size the /media
  // body limit off MEDIA_MAX_BYTES (with headroom). Other routes stay at 2mb.
  const mediaJson = express.json({ limit: Math.ceil(media.maxBytes * 1.4) + 1024 });
  app.use((req, res, next) =>
    req.path === '/media' ? mediaJson(req, res, next) : express.json({ limit: '2mb' })(req, res, next));

  // Resolve an outbound media spec ({ path } | { url }) to a local file +
  // metadata, enforcing the size cap. URL downloads are staged under
  // OUTBOUND_MEDIA_DIR (staged:true → cleaned up after send); disk paths are
  // used in place (staged:false → never deleted).
  async function stageOutboundMedia({ path: p, url }) {
    if (p) {
      const abs = path.resolve(String(p));
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`file not found: ${abs}`);
      if (fs.statSync(abs).size > media.maxBytes) throw new Error('file exceeds MEDIA_MAX_BYTES');
      return { path: abs, mime: mimeFromName(abs), filename: path.basename(abs), staged: false };
    }
    if (url) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      let r;
      try { r = await fetch(String(url), { signal: ctrl.signal }); }
      catch (e) { throw new Error(`download failed: ${e.message}`); }
      finally { clearTimeout(timer); }
      if (!r.ok) throw new Error(`download ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > media.maxBytes) throw new Error('download exceeds MEDIA_MAX_BYTES');
      const mime = (r.headers.get('content-type') || '').split(';')[0] || 'application/octet-stream';
      const base = (String(url).split('/').pop() || 'file').split('?')[0] || 'file';
      const ext = path.extname(base) || extFromMime(mime);
      fs.mkdirSync(OUTBOUND_MEDIA_DIR, { recursive: true });
      const file = path.join(OUTBOUND_MEDIA_DIR, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
      fs.writeFileSync(file, buf);
      return { path: file, mime, filename: base.includes('.') ? base : base + ext, staged: true };
    }
    throw new Error('media needs a path or url');
  }

  // Delete a staged (URL-downloaded) file once it's no longer needed. Disk-path
  // originals (outside OUTBOUND_MEDIA_DIR) are left alone.
  function cleanupStaged(mediaPath) {
    if (mediaPath && path.resolve(mediaPath).startsWith(OUTBOUND_MEDIA_DIR)) {
      fs.promises.unlink(mediaPath).catch(() => {});
    }
  }

  // Turn claimed outbound rows into the wire payload for the extension. Media
  // rows are read from disk and base64-inlined here (kept out of the DB/SSE until
  // send time). A missing file fails the send instead of delivering it broken.
  function hydrateSends(rows) {
    const out = [];
    for (const r of rows) {
      if (r.kind === 'media') {
        try {
          const dataB64 = fs.readFileSync(r.mediaPath).toString('base64');
          out.push({ id: r.id, chatId: r.chatId, kind: 'media', mime: r.mime, filename: r.filename, caption: r.caption, quotedMsgId: r.quotedMsgId, dataB64 });
        } catch (e) {
          markSendResult(r.id, { ok: false, error: `media file missing: ${e.message}` });
        }
      } else {
        out.push({ id: r.id, chatId: r.chatId, kind: 'text', text: r.text, quotedMsgId: r.quotedMsgId });
      }
    }
    return out;
  }

  // In extension mode the WhatsApp connection lives in the browser tab, so the
  // service can't observe it directly. The extension reports the tab's stream
  // state here ('connected' | 'needs_auth' | 'logged_out') and /health surfaces
  // it — otherwise a logged-out/closed tab would silently serve stale reads.
  let extStatus = { state: 'unknown', at: null };

  // The one active WhatsApp Web tab drains both outbound sends and backfill
  // commands over the same SSE stream; payloads are tagged by key (`sends` /
  // `backfills`). A single client is assumed (avoids double-execution).
  const sseClients = new Set();
  function pushToClient(payload) {
    const [client] = sseClients;
    if (client) client.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  // Backfill: the tab re-fetches chat history via WPP.chat.getMessages and POSTs
  // it back through /ingest (INSERT OR IGNORE dedups against live messages), so
  // gaps from a closed tab or stopped server can be filled on demand.
  let backfillSeq = 0;
  const backfillWaiters = new Map(); // reqId -> resolve(ingestedCount | null on timeout)
  let lastAutoBackfillAt = 0;

  // Push a backfill command to the tab and resolve with the ingested count
  // (or null if no tab / it didn't finish in time). Shared by the on-demand
  // endpoint and the composite /conversation endpoint.
  function runBackfill(chatId, { since = 0, max = BACKFILL_DEFAULT_MAX } = {}) {
    if (mode !== 'extension' || !sseClients.size) return Promise.resolve(null);
    const reqId = ++backfillSeq;
    return new Promise((resolve) => {
      backfillWaiters.set(reqId, resolve);
      setTimeout(() => { if (backfillWaiters.delete(reqId)) resolve(null); }, BACKFILL_WAIT_MS);
      pushToClient({ backfills: [{ reqId, chatId, since, max }] });
    });
  }

  // On-demand media fetch: ask the tab to download a past message's media now
  // (live ingest and backfill don't fetch media for old messages). The tab
  // re-downloads via WPP.chat.downloadMedia and POSTs it to /media with
  // store:true, so processMedia persists it regardless of STORE_MEDIA. We then
  // poll the row until the file lands (or time out).
  let mediaFetchSeq = 0;
  function requestMediaFetch(chatId, msgId) {
    if (mode !== 'extension' || !sseClients.size) return false;
    pushToClient({ mediaFetches: [{ reqId: ++mediaFetchSeq, chatId, msgId }] });
    return true;
  }

  // Resolve a name/JID → a single chat target, or report ambiguity. Alias wins
  // (explicit user intent), then people (contacts) + chats (so groups resolve).
  function resolveTarget(q) {
    const raw = String(q).trim();
    if (!raw) return { found: false };
    if (raw.includes('@')) {
      const name = getChat(raw)?.name ?? getContact(raw)?.name ?? null;
      return { found: true, target: { jid: raw, name, matchedVia: 'jid' } };
    }
    const aliasJid = resolveAlias(raw);
    if (aliasJid) {
      const name = getChat(aliasJid)?.name ?? getContact(aliasJid)?.name ?? raw;
      return { found: true, target: { jid: aliasJid, name, matchedVia: 'alias' } };
    }
    const cand = new Map();
    for (const c of searchContacts(raw, { limit: 10 })) {
      cand.set(c.jid, { jid: c.jid, name: c.name, matchedVia: 'contact', isGroup: c.jid.endsWith('@g.us') ? 1 : 0, lastSeenAt: c.lastSeenAt });
    }
    for (const ch of searchChatsByName(raw, { limit: 10 })) {
      if (!cand.has(ch.jid)) cand.set(ch.jid, { jid: ch.jid, name: ch.name, matchedVia: 'chat', isGroup: ch.isGroup, lastSeenAt: ch.lastMessageAt });
    }
    const list = [...cand.values()];
    if (list.length === 0) return { found: false };
    if (list.length === 1) return { found: true, target: list[0] };
    return { found: false, ambiguous: true, candidates: list };
  }

  // Auto-backfill on (re)connect: refill everything after our newest stored
  // message, so downtime gaps fill themselves. Only on the transition *into*
  // 'connected', and debounced — conn.main_ready can fire repeatedly.
  function maybeAutoBackfill(prevState, newState) {
    if (newState !== 'connected' || prevState === 'connected') return;
    if (Date.now() - lastAutoBackfillAt < AUTO_BACKFILL_COOLDOWN_MS) return;
    lastAutoBackfillAt = Date.now();
    const hw = lastMessageTimestamp();
    const since = hw != null ? hw - 1000 : Date.now() - 24 * 60 * 60 * 1000;
    pushToClient({ backfills: [{ reqId: ++backfillSeq, chatId: '*', since, max: BACKFILL_DEFAULT_MAX }] });
  }

  // The extension's bridge.js fetches us from a content script. In MV3 those
  // fetches carry the *page* origin (https://web.whatsapp.com), not the
  // chrome-extension:// origin, so we must allow both. The bearer token is the
  // real auth boundary; CORS just unblocks the browser. Loopback only.
  const allowedOrigin = /^(chrome-extension:\/\/|https:\/\/web\.whatsapp\.com$)/;
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && allowedOrigin.test(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.set('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use((req, res, next) => {
    if (req.path === '/health') return next();
    const auth = req.get('authorization') ?? '';
    const [, headerToken] = auth.split(' ');
    // EventSource (SSE) can't set custom headers, so the stream endpoint accepts
    // the token as a query param instead. Loopback-only, so this is acceptable.
    const token = headerToken || (req.path === '/outbound/stream' ? req.query.token : undefined);
    if (token !== apiToken) return res.status(401).json({ error: 'unauthorized' });
    next();
  });

  app.get('/health', (req, res) => {
    // baileys owns the socket → report its live state; extension mode reports
    // the browser tab's last-known state instead (connected only when the tab
    // says its stream is in MAIN/connected).
    const conn = mode === 'extension'
      ? { connected: extStatus.state === 'connected', hasQR: false, extension: extStatus }
      : status();
    res.json({
      ok: true, mode, ...conn, sendEnabled,
      send: { enabled: sendEnabled, agentPrefix },
      media: { transcribe: media.transcribe, ocr: media.ocr, store: media.store, download: media.download },
      summary: { provider: summaryProvider() },
      memory: memoryConfig(),
      watchlist: { keywords: listKeywords().length, channels: alertChannels() },
      update: getUpdateStatus(),
      ...stats(),
    });
  });

  // ── Updates: list the commits HEAD is behind, or force a re-check. The actual
  //    `git pull && npm install` runs from the wa CLI (which shells out locally
  //    in update.repoPath) — keeping it out of the server avoids racing with
  //    node's module cache while the service is live. ────────────────────────
  app.get('/update/commits', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 200);
    res.json({ status: getUpdateStatus(), commits: await getPendingCommits({ limit }) });
  });

  app.post('/update/check', async (req, res) => {
    const status = await checkForUpdates();
    res.json({ status });
  });

  // The extension posts the WhatsApp Web tab's connection state here.
  app.post('/status', (req, res) => {
    const s = req.body?.state;
    if (typeof s === 'string') {
      const prev = extStatus.state;
      extStatus = { state: s, at: Date.now() };
      maybeAutoBackfill(prev, s);
    }
    res.json({ ok: true });
  });

  app.get('/qr', (req, res) => {
    const qr = getQR();
    if (!qr) return res.status(404).json({ error: 'no QR available — either already connected or not initialized' });
    res.json({ qr });
  });

  app.get('/chats', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 200);
    const onlyUnread = req.query.unread === 'true';
    res.json(listChats({ limit, onlyUnread }));
  });

  app.get('/chats/:id/messages', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 500);
    const since = req.query.since ? Number(req.query.since) : undefined;
    res.json(getMessages(req.params.id, { limit, since }));
  });

  app.post('/chats/:id/read', (req, res) => {
    markChatRead(req.params.id);
    res.json({ ok: true });
  });

  // ── Composite: resolve a name/JID and read the conversation in one call ─────
  // ?name=<name|jid> [&limit=N] [&since=<ms>|&days=<n>] [&backfill=true]
  // Collapses the resolve → (backfill) → read flow the skill used to do by hand.
  // On ambiguity returns { found:false, ambiguous:true, candidates:[...] } so
  // the caller can disambiguate instead of guessing.
  app.get('/conversation', async (req, res) => {
    const q = req.query.name ?? req.query.q;
    if (!q) return res.status(400).json({ error: 'missing name (or q)' });
    const r = resolveTarget(q);
    if (!r.found) {
      return res.json({ query: String(q), found: false, ambiguous: !!r.ambiguous, candidates: r.candidates ?? [] });
    }
    const limit = Math.min(parseInt(req.query.limit ?? '100', 10), 500);
    let since = req.query.since ? Number(req.query.since) : undefined;
    if (since === undefined && req.query.days) since = Date.now() - Number(req.query.days) * 86400000;

    let backfilled = null;
    if (req.query.backfill === 'true') backfilled = await runBackfill(r.target.jid, { since: since ?? 0 });

    const messages = getMessages(r.target.jid, { limit, since });
    res.json({ query: String(q), found: true, target: r.target, backfilled, count: messages.length, messages });
  });

  app.get('/search', (req, res) => {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'missing q' });
    const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 200);
    res.json(searchMessages(String(q), { limit }));
  });

  // ── Digest: unread chats grouped with their recent messages ─────────────────
  // Structured by default (the caller — e.g. Claude — summarizes). With
  // ?summarize=true the bridge runs SUMMARY_PROVIDER and returns prose too.
  app.get('/digest', async (req, res) => {
    const chatLimit = Math.min(parseInt(req.query.limit ?? '30', 10), 100);
    const maxPerChat = Math.min(parseInt(req.query.maxPerChat ?? '15', 10), 50);
    const chats = getUnreadDigest({ chatLimit, maxPerChat });
    const out = { generatedAt: Date.now(), totalUnreadChats: chats.length, chats };

    if (req.query.summarize === 'true') {
      if (!summaryEnabled()) {
        out.summary = null;
        out.summaryError = 'SUMMARY_PROVIDER is off; set it (groq|openai|claude) or summarize the structured data yourself.';
      } else if (chats.length === 0) {
        out.summary = 'Nenhuma conversa não lida.';
      } else {
        try {
          out.summary = await summarize({
            system:
              'Você resume conversas de WhatsApp não lidas para o dono da conta. ' +
              'Para cada conversa, escreva 1–2 linhas com o essencial e destaque o que pede ação ou resposta. ' +
              'Seja conciso e objetivo, em português. Use o nome do contato/grupo como título.',
            content: chats.map((c) => {
              const who = c.name || c.jid;
              const lines = c.messages.map((m) => `${m.fromMe ? 'eu' : (m.senderName || 'eles')}: ${m.body}`).join('\n');
              return `### ${who} (${c.unread} não lida(s))\n${lines}`;
            }).join('\n\n'),
          });
        } catch (e) {
          out.summary = null;
          out.summaryError = String(e.message ?? e);
        }
      }
    }
    res.json(out);
  });

  // ── Pending: chats waiting on a reply from us for more than `hours` ─────────
  app.get('/pending', (req, res) => {
    const hours = Number(req.query.hours ?? '3');
    const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 200);
    const includeGroups = req.query.groups !== 'false';
    res.json({ hours, pending: getPendingReplies({ hours, limit, includeGroups }) });
  });

  // ── Memory: per-chat daily/weekly LLM-written notes (on-demand only) ────────
  // Build: POST /memory/build { chatId? | all:true, period:'daily'|'weekly',
  //                             when?:ms, force?:bool, minMessages?:int }
  // Read:  GET  /chats/:id/memory[?period=daily|weekly&limit=N]
  //        GET  /memory[?period=...&limit=N]   (recent across all chats)
  app.post('/memory/build', async (req, res) => {
    const { chatId, all, period = 'daily', when, force = false, minMessages } = req.body ?? {};
    if (period !== 'daily' && period !== 'weekly') {
      return res.status(400).json({ error: 'period must be "daily" or "weekly"' });
    }
    if (!memoryConfig().enabled) {
      return res.status(400).json({ error: 'SUMMARY_PROVIDER is off; set it (groq|openai|claude) in .env to enable memory.' });
    }
    const whenMs = when != null ? Number(when) : Date.now();
    try {
      if (all || !chatId) {
        const out = await buildMemoryForAll({
          period, when: whenMs, force: !!force,
          minMessages: minMessages != null ? Number(minMessages) : undefined,
        });
        return res.json({ ok: true, ...out });
      }
      const out = await buildMemoryForChat(String(chatId), {
        period, when: whenMs, force: !!force,
        minMessages: minMessages != null ? Number(minMessages) : undefined,
      });
      return res.json({ ok: !!out.ok, ...out });
    } catch (e) {
      return res.status(500).json({ error: String(e.message ?? e) });
    }
  });

  app.get('/chats/:id/memory', (req, res) => {
    const period = req.query.period;
    if (period && period !== 'daily' && period !== 'weekly') {
      return res.status(400).json({ error: 'period must be "daily" or "weekly"' });
    }
    const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 200);
    res.json({ chatId: req.params.id, memories: getChatMemories(req.params.id, { period, limit }) });
  });

  app.get('/memory', (req, res) => {
    const period = req.query.period;
    if (period && period !== 'daily' && period !== 'weekly') {
      return res.status(400).json({ error: 'period must be "daily" or "weekly"' });
    }
    const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 200);
    res.json({ memories: listRecentMemories({ period, limit }) });
  });

  // ── Alerts: recent keyword-watchlist hits ───────────────────────────────────
  app.get('/alerts', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit ?? '30', 10), 200);
    res.json({ keywords: listKeywords(), channels: alertChannels(), alerts: listAlerts({ limit }) });
  });

  // ── Mentions: messages that @-mentioned the account owner (groups) ──────────
  app.get('/mentions', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit ?? '30', 10), 200);
    let since = req.query.since ? Number(req.query.since) : undefined;
    if (since === undefined && req.query.days) since = Date.now() - Number(req.query.days) * 86400000;
    res.json({ mentions: getMentions({ limit, since }) });
  });

  app.get('/send/whitelist', (req, res) => {
    res.json({ enabled: sendEnabled, allowed: listAllowed() });
  });

  app.get('/contacts', (req, res) => {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'missing q' });
    const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 200);

    const aliasJid = resolveAlias(q);
    const dbMatches = searchContacts(String(q), { limit });

    const results = [];
    if (aliasJid) {
      const existing = getContact(aliasJid);
      results.push({
        jid: aliasJid,
        name: existing?.name ?? String(q),
        pushName: existing?.pushName ?? null,
        notifyName: existing?.notifyName ?? null,
        verifiedName: existing?.verifiedName ?? null,
        lastSeenAt: existing?.lastSeenAt ?? null,
        hasDm: aliasJid.endsWith('@g.us') ? 0 : 1,
        matchedVia: 'alias',
      });
    }
    for (const c of dbMatches) {
      if (c.jid === aliasJid) continue;
      results.push({ ...c, matchedVia: 'contact' });
    }
    res.json({ query: String(q), results });
  });

  app.get('/contacts/aliases', (req, res) => {
    res.json({ aliases: listAliases() });
  });

  // Aliases are a convenience layer, not a security boundary (that's the
  // whitelist, which stays file-only), so the options page can manage them.
  app.post('/contacts/aliases', (req, res) => {
    const { alias, jid } = req.body ?? {};
    if (!alias || !jid) return res.status(400).json({ error: 'alias and jid are required' });
    try {
      res.json({ ok: true, ...addAlias(alias, jid) });
    } catch (e) {
      res.status(400).json({ error: String(e.message ?? e) });
    }
  });

  app.delete('/contacts/aliases/:alias', (req, res) => {
    res.json({ ok: true, removed: removeAlias(req.params.alias) });
  });

  // Send a message for an internal purpose (keyword alerts). Same security
  // boundary as the public send route: needs ENABLE_SEND and a whitelisted
  // target — otherwise the alert's WhatsApp channel is silently skipped.
  async function deliverWhatsApp(jid, text) {
    if (!sendEnabled || !isAllowed(jid)) return;
    const body = withAgentTag(text);
    if (mode === 'baileys') { await sendText(jid, body); return; }
    enqueueSend({ chatId: jid, text: body });
    if (sseClients.size) pushSends(claimPending({ limit: 50 }));
  }

  // ── Ingest: the extension pushes observed messages/contacts here ────────────
  // Body: { messages?: [...], contacts?: [...] }. Each message uses the same
  // normalized shape store.saveMessage() expects (see skill/whatsapp-assistant).
  app.post('/ingest', (req, res) => {
    const { messages = [], contacts = [], revokes = [], edits = [], chatNames = [] } = req.body ?? {};
    if (![messages, contacts, revokes, edits, chatNames].every(Array.isArray)) {
      return res.status(400).json({ error: 'messages, contacts, revokes, edits and chatNames must be arrays' });
    }
    let savedMsgs = 0;
    for (const m of messages) {
      if (!m?.id || !m?.chatId || typeof m.timestamp !== 'number') continue;
      saveMessage({
        id: String(m.id),
        chatId: String(m.chatId),
        sender: m.sender ?? null,
        body: m.body ?? '',
        timestamp: m.timestamp,
        fromMe: !!m.fromMe,
        type: m.type ?? null,
        chatName: m.chatName ?? null,
        mentionsMe: !!m.mentionsMe,
      });
      savedMsgs++;
    }
    let savedContacts = 0;
    for (const c of contacts) {
      if (!c?.jid) continue;
      upsertContact({
        jid: c.jid,
        pushName: c.pushName ?? null,
        notifyName: c.notifyName ?? null,
        verifiedName: c.verifiedName ?? null,
        lastSeenAt: c.lastSeenAt ?? null,
      });
      savedContacts++;
    }
    // Anti-delete: keep the body, just flag it as deleted. revokes carry the
    // original (revoked) message id.
    let deleted = 0;
    for (const id of revokes) {
      if (!id) continue;
      markDeleted(String(id), { at: Date.now() });
      deleted++;
    }
    // Edits: rewrite the body in place, preserving the original.
    let edited = 0;
    for (const e of edits) {
      if (!e?.id) continue;
      applyEdit({ id: String(e.id), body: e.body ?? '', at: e.timestamp ?? Date.now() });
      edited++;
    }
    // Chat names: real group/DM titles resolved by the extension (never a
    // sender's name). updateChatName overwrites, so renames are picked up.
    let named = 0;
    for (const c of chatNames) {
      if (!c?.id || !c?.name) continue;
      updateChatName(String(c.id), String(c.name));
      named++;
    }
    // Keyword watchlist: scan the freshly ingested inbound messages and fire
    // alerts. Fire-and-forget so ingest stays fast; processAlerts is best-effort.
    processAlerts(messages, { sendWhatsApp: deliverWhatsApp }).catch(() => {});

    res.json({ ok: true, messages: savedMsgs, contacts: savedContacts, deleted, edited, named });
  });

  // ── Media: receive raw bytes, persist (per STORE_MEDIA) + transcribe/OCR ────
  // The extension downloads a message's media (WPP.chat.downloadMedia) and POSTs
  // it here base64-encoded. Processing (transcription / OCR) can take seconds, so
  // we ack immediately and run it in the background through a serial queue (keeps
  // us from firing dozens of parallel API calls and tripping rate limits).
  let mediaChain = Promise.resolve();
  function enqueueMedia(job) {
    mediaChain = mediaChain.then(job, job); // run next regardless of prior outcome
    return mediaChain;
  }

  app.post('/media', (req, res) => {
    const { id, type, mime, filename, dataB64, store } = req.body ?? {};
    if (!id || !dataB64) return res.status(400).json({ error: 'id and dataB64 are required' });
    if (!getMessageById(id)) {
      // The message must be ingested first (we fold text into its body). The
      // extension flushes ingest before media, but guard anyway.
      return res.status(409).json({ error: 'message not found; ingest it before posting media', id });
    }
    let buffer;
    try {
      buffer = Buffer.from(String(dataB64), 'base64');
    } catch (_) {
      return res.status(400).json({ error: 'dataB64 is not valid base64' });
    }
    if (buffer.length > media.maxBytes) {
      return res.status(413).json({ error: `media exceeds MEDIA_MAX_BYTES (${media.maxBytes})`, size: buffer.length });
    }
    enqueueMedia(() => processMedia({ id: String(id), type, buffer, mime, filename, forceStore: !!store }));
    res.status(202).json({ ok: true, queued: true, id });
  });

  // Serve a stored media file (feature: download a document/audio/image that
  // arrived). Only files persisted under data/media/ per STORE_MEDIA are served.
  app.get('/chats/:id/messages/:msgId/media', (req, res) => {
    const row = getMessageById(req.params.msgId);
    if (!row || row.chatId !== req.params.id) return res.status(404).json({ error: 'message not found in this chat' });
    const abs = mediaFileAbsPath(row.mediaPath);
    if (!abs) return res.status(404).json({ error: 'no stored media for this message (check STORE_MEDIA)' });
    res.type(row.mediaMime || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${path.basename(abs)}"`);
    fs.createReadStream(abs).pipe(res);
  });

  // On-demand: re-download a past message's media from WhatsApp and store it.
  // Looks the chat up from the message id, asks the tab to fetch, then waits for
  // the file to land. Use this for media received while STORE_MEDIA was off.
  app.post('/messages/:msgId/fetch-media', async (req, res) => {
    if (mode !== 'extension') return res.status(400).json({ error: 'on-demand media fetch is only available in extension mode' });
    const row = getMessageById(req.params.msgId);
    if (!row) return res.status(404).json({ error: 'message not found' });
    const url = `/messages/${encodeURIComponent(row.id)}/media`;
    if (mediaFileAbsPath(row.mediaPath)) {
      return res.json({ ok: true, alreadyStored: true, msgId: row.id, mime: row.mediaMime, status: row.mediaStatus, url });
    }
    if (!requestMediaFetch(row.chatId, row.id)) {
      return res.status(503).json({ error: 'no WhatsApp Web tab connected; open the tab and retry' });
    }
    const deadline = Date.now() + MEDIA_FETCH_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(SEND_POLL_MS);
      const r = getMessageById(row.id);
      if (mediaFileAbsPath(r?.mediaPath)) {
        return res.json({ ok: true, msgId: r.id, mime: r.mediaMime, status: r.mediaStatus, url });
      }
      if (r?.mediaStatus === 'error') return res.status(502).json({ error: 'media processing failed', msgId: r.id });
    }
    return res.status(202).json({
      ok: true, pending: true, msgId: row.id,
      note: 'fetch requested but media not ready — it may have expired on WhatsApp, or the tab is offline. Open/refresh the WhatsApp Web tab and retry.',
    });
  });

  // Serve a stored media file by message id alone (chat resolved from the row).
  app.get('/messages/:msgId/media', (req, res) => {
    const row = getMessageById(req.params.msgId);
    if (!row) return res.status(404).json({ error: 'message not found' });
    const abs = mediaFileAbsPath(row.mediaPath);
    if (!abs) return res.status(404).json({ error: 'no stored media for this message; POST /messages/:msgId/fetch-media first' });
    res.type(row.mediaMime || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${path.basename(abs)}"`);
    fs.createReadStream(abs).pipe(res);
  });

  // ── Outbound queue (extension mode): extension drains pending sends ─────────
  // SSE push is the primary path: a background browser tab throttles its timers
  // (so polling stalls), but it still reacts to network/SSE events immediately.
  // /outbound (polling) stays as a backstop. A single active tab is assumed, so
  // we push each send to one client to avoid double-sending.
  function writeSends(res, sends) {
    if (sends.length) res.write(`data: ${JSON.stringify({ sends })}\n\n`);
  }
  function pushSends(sends) {
    const [client] = sseClients;
    if (client) writeSends(client, sends);
  }

  app.get('/outbound/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.flushHeaders?.();
    res.write(': connected\n\n');
    sseClients.add(res);
    // Catch-up: deliver anything queued while no client was connected, or since
    // a reconnect.
    writeSends(res, hydrateSends(claimPending({ limit: 100 })));
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
  });

  app.get('/outbound', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 100);
    res.json({ sends: hydrateSends(claimPending({ limit })) });
  });

  app.post('/outbound/:id/result', (req, res) => {
    const id = Number(req.params.id);
    const { ok, error, waMsgId } = req.body ?? {};
    const row = getSend(id);
    if (!row) return res.status(404).json({ error: 'unknown send id' });
    markSendResult(id, { ok: !!ok, error, waMsgId });
    // Send finished (here or after the route's wait timed out) — drop staged media.
    if (row.kind === 'media') cleanupStaged(row.mediaPath);
    res.json({ ok: true });
  });

  // ── Backfill (extension mode): re-fetch a chat's history into the DB ────────
  // The tab pulls older messages via WPP.chat.getMessages and POSTs them through
  // /ingest. Use this before summarizing a conversation that may have arrived
  // while the tab/server were down. `since` (ms) bounds how far back to go; the
  // count is capped by `max`. INSERT OR IGNORE dedups against live messages.
  app.post('/chats/:id/backfill', async (req, res) => {
    if (mode !== 'extension') {
      return res.status(400).json({ error: 'backfill is only available in extension mode' });
    }
    if (!sseClients.size) {
      return res.status(503).json({ error: 'no WhatsApp Web tab connected; open the tab and retry' });
    }
    const since = req.body?.since != null ? Number(req.body.since) : 0;
    const max = req.body?.max != null
      ? Math.min(Math.max(Number(req.body.max), 1), 10000)
      : BACKFILL_DEFAULT_MAX;

    const ingested = await runBackfill(req.params.id, { since, max });

    if (ingested == null) {
      return res.status(202).json({
        ok: true, pending: true, chatId: req.params.id,
        note: 'backfill still running; read /chats/:id/messages again shortly',
      });
    }
    res.json({ ok: true, ingested, chatId: req.params.id });
  });

  // The tab reports how many messages a backfill ingested (resolves the waiter).
  app.post('/backfill/:reqId/result', (req, res) => {
    const reqId = Number(req.params.reqId);
    const resolve = backfillWaiters.get(reqId);
    if (resolve) {
      backfillWaiters.delete(reqId);
      resolve(Number(req.body?.ingested) || 0);
    }
    res.json({ ok: true });
  });

  // ── Send: enqueue, then (extension mode) briefly wait for the extension to
  //    confirm. In baileys mode, push directly through the socket as before. ──
  app.post('/chats/:id/messages', async (req, res) => {
    if (!sendEnabled) return res.status(403).json({ error: 'send disabled. Set ENABLE_SEND=true to enable.' });
    if (!isAllowed(req.params.id)) {
      return res.status(403).json({
        error: 'chat not in send_whitelist.txt. Add the JID or phone number to send_whitelist.txt in the project root — the service reloads automatically.',
        chatId: req.params.id,
      });
    }
    // Body: { text } (plain), { text, quotedMsgId } (reply), or
    // { media: { path | url }, caption?, quotedMsgId? } (image/doc/etc).
    // Optional `agentPrefix` overrides the server default for this one send
    // (string = use this prefix; false = no prefix; omitted = use default).
    const { text, media: mediaSpec, caption, quotedMsgId, agentPrefix: override } = req.body ?? {};
    const chatId = req.params.id;

    let enqArgs;
    let staged = null;
    if (mediaSpec && (mediaSpec.path || mediaSpec.url)) {
      try {
        staged = await stageOutboundMedia(mediaSpec);
      } catch (e) {
        return res.status(400).json({ error: `media: ${e.message}` });
      }
      const rawCaption = caption ?? text ?? null;
      enqArgs = {
        chatId, kind: 'media', mediaPath: staged.path, mime: staged.mime,
        filename: staged.filename, caption: withAgentTag(rawCaption, override), quotedMsgId: quotedMsgId ?? null,
      };
    } else {
      if (!text || typeof text !== 'string') return res.status(400).json({ error: 'body.text or body.media required' });
      enqArgs = { chatId, text: withAgentTag(text, override), kind: 'text', quotedMsgId: quotedMsgId ?? null };
    }

    if (mode === 'baileys') {
      try {
        if (enqArgs.kind === 'media') {
          const buffer = fs.readFileSync(staged.path);
          await sendMedia(chatId, { buffer, mime: staged.mime, filename: staged.filename, caption: enqArgs.caption });
        } else {
          await sendText(chatId, enqArgs.text); // note: quoting isn't supported in baileys mode
        }
        cleanupStaged(staged?.path);
        return res.json({ ok: true });
      } catch (err) {
        cleanupStaged(staged?.path);
        return res.status(500).json({ error: String(err.message ?? err) });
      }
    }

    // extension mode: enqueue, push to the connected tab via SSE, then wait
    // briefly for it to confirm.
    const id = enqueueSend(enqArgs);
    if (sseClients.size) pushSends(hydrateSends(claimPending({ limit: 50 })));
    const deadline = Date.now() + SEND_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(SEND_POLL_MS);
      const row = getSend(id);
      if (row?.status === 'sent') { cleanupStaged(staged?.staged ? staged.path : null); return res.json({ ok: true, id, waMsgId: row.waMsgId }); }
      if (row?.status === 'error') { cleanupStaged(staged?.staged ? staged.path : null); return res.status(502).json({ error: row.error || 'send failed', id }); }
    }
    // Timed out: keep staged media so the poll backstop can still deliver it;
    // the /result handler cleans it up when the tab finally confirms.
    res.status(202).json({
      ok: true, queued: true, pending: true, id,
      note: 'queued; the WhatsApp Web tab did not confirm in time. Ensure the extension/tab is open.',
    });
  });

  return app;
}
