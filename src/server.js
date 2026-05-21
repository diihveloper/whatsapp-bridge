import express from 'express';
import {
  listChats, getMessages, searchMessages, markChatRead, stats,
  searchContacts, getContact,
  saveMessage, upsertContact,
  enqueueSend, claimPending, markSendResult, getSend,
} from './store.js';
import { status, getQR, sendText } from './whatsapp.js';
import { isAllowed, listAllowed } from './whitelist.js';
import { resolveAlias, listAliases } from './aliases.js';

// How long /chats/:id/messages waits for the extension to confirm a queued send
// before returning "still pending". With SSE push the tab usually confirms in
// 1-2s even in the background.
const SEND_WAIT_MS = 8000;
const SEND_POLL_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createServer({ apiToken, sendEnabled, mode = 'baileys' }) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));

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
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
    res.json({ ok: true, mode, ...status(), sendEnabled, ...stats() });
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

  app.get('/search', (req, res) => {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'missing q' });
    const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 200);
    res.json(searchMessages(String(q), { limit }));
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

  // ── Ingest: the extension pushes observed messages/contacts here ────────────
  // Body: { messages?: [...], contacts?: [...] }. Each message uses the same
  // normalized shape store.saveMessage() expects (see skill/whatsapp-read).
  app.post('/ingest', (req, res) => {
    const { messages = [], contacts = [] } = req.body ?? {};
    if (!Array.isArray(messages) || !Array.isArray(contacts)) {
      return res.status(400).json({ error: 'messages and contacts must be arrays' });
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
    res.json({ ok: true, messages: savedMsgs, contacts: savedContacts });
  });

  // ── Outbound queue (extension mode): extension drains pending sends ─────────
  // SSE push is the primary path: a background browser tab throttles its timers
  // (so polling stalls), but it still reacts to network/SSE events immediately.
  // /outbound (polling) stays as a backstop. A single active tab is assumed, so
  // we push each send to one client to avoid double-sending.
  const sseClients = new Set();
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
    writeSends(res, claimPending({ limit: 100 }));
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(heartbeat); sseClients.delete(res); });
  });

  app.get('/outbound', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit ?? '20', 10), 100);
    res.json({ sends: claimPending({ limit }) });
  });

  app.post('/outbound/:id/result', (req, res) => {
    const id = Number(req.params.id);
    const { ok, error, waMsgId } = req.body ?? {};
    if (!getSend(id)) return res.status(404).json({ error: 'unknown send id' });
    markSendResult(id, { ok: !!ok, error, waMsgId });
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
    const text = req.body?.text;
    if (!text || typeof text !== 'string') return res.status(400).json({ error: 'body.text required' });

    if (mode === 'baileys') {
      try {
        await sendText(req.params.id, text);
        return res.json({ ok: true });
      } catch (err) {
        return res.status(500).json({ error: String(err.message ?? err) });
      }
    }

    // extension mode: enqueue, push to the connected tab via SSE, then wait
    // briefly for it to confirm.
    const id = enqueueSend({ chatId: req.params.id, text });
    if (sseClients.size) pushSends(claimPending({ limit: 50 }));
    const deadline = Date.now() + SEND_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(SEND_POLL_MS);
      const row = getSend(id);
      if (row?.status === 'sent') return res.json({ ok: true, id, waMsgId: row.waMsgId });
      if (row?.status === 'error') return res.status(502).json({ error: row.error || 'send failed', id });
    }
    res.status(202).json({
      ok: true, queued: true, pending: true, id,
      note: 'queued; the WhatsApp Web tab did not confirm in time. Ensure the extension/tab is open.',
    });
  });

  return app;
}
