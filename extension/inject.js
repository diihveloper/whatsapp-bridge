// Runs in the MAIN world of web.whatsapp.com, so it shares `window` with the
// page and can use @wppconnect/wa-js (window.WPP), which exposes WhatsApp Web's
// internal Store as a stable API. It does NOT do any HTTP — it only talks to
// bridge.js (ISOLATED world) over window.postMessage. bridge.js does the fetches.
(function () {
  'use strict';
  const TAG = '__wab__';

  // Idempotency guard: if this script somehow runs twice in the same page
  // context, don't subscribe to chat.new_message twice (would double-ingest).
  if (window.__wabInjected) return;
  window.__wabInjected = true;

  // Reload detector: sessionStorage survives reloads of the same tab, so a
  // climbing counter here is proof the WhatsApp Web tab is reloading in a loop
  // (the usual reason the "ready"/"connected" logs repeat constantly).
  try {
    const n = (Number(sessionStorage.getItem('wab_loads')) || 0) + 1;
    sessionStorage.setItem('wab_loads', String(n));
    console.log('[wab] content script load #' + n);
  } catch (_) { /* sessionStorage may be unavailable pre-app */ }

  // WhatsApp Web uses @c.us for users; the bridge DB/skill use @s.whatsapp.net.
  // Groups (@g.us) and the modern @lid identifiers pass through unchanged.
  function toBridgeJid(wid) {
    const s = wid == null ? '' : String(wid?._serialized ?? wid);
    return s.replace(/@c\.us$/, '@s.whatsapp.net');
  }
  // Reverse, for sending: the queue stores @s.whatsapp.net, WPP wants @c.us.
  function toWaJid(jid) {
    return String(jid).replace(/@s\.whatsapp\.net$/, '@c.us');
  }

  const TYPE_MAP = {
    chat: 'text',
    ptt: 'audio',
    audio: 'audio',
    image: 'image',
    video: 'video',
    document: 'document',
    sticker: 'sticker',
    location: 'location',
    vcard: 'contact',
    revoked: 'protocolMessage',
  };

  function normalize(msg) {
    const fromMe = !!(msg.id?.fromMe ?? msg.fromMe);
    const chatWid = msg.id?.remote ?? msg.from;
    const chatId = toBridgeJid(chatWid);
    const isGroup = chatId.endsWith('@g.us');
    const type = TYPE_MAP[msg.type] ?? msg.type ?? 'unknown';

    let body = msg.body ?? msg.caption ?? '';
    if (!body && type !== 'text') body = `[${type}]`;

    const sender = isGroup ? toBridgeJid(msg.author ?? msg.sender) : chatId;
    const ts = (Number(msg.t) || Math.floor(Date.now() / 1000)) * 1000;

    return {
      message: {
        id: msg.id?._serialized ?? String(msg.id),
        chatId,
        sender,
        body,
        timestamp: ts,
        fromMe,
        type,
        // pushName is the *sender*'s name — only safe as a chat name for inbound DMs.
        chatName: (isGroup || fromMe) ? null : (msg.notifyName ?? msg.senderObj?.pushname ?? null),
      },
      contact: (!fromMe && sender && msg.notifyName)
        ? { jid: sender, pushName: msg.notifyName, lastSeenAt: ts }
        : null,
    };
  }

  function post(payload) {
    window.postMessage({ [TAG]: true, ...payload }, '*');
  }

  // The real group title — never the sender (that was the historical bug). Read
  // live from the chat model so renames are tracked. Tries the sync store first,
  // falls back to the public async getter.
  async function resolveGroupTitle(chatWid) {
    try {
      const chat = window.WPP.whatsapp?.ChatStore?.get?.(chatWid) ?? await window.WPP.chat.get(chatWid);
      return chat?.formattedTitle ?? chat?.groupMetadata?.subject ?? chat?.name ?? null;
    } catch (_) {
      return null;
    }
  }

  async function handleNewMessage(msg) {
    try {
      const { message, contact } = normalize(msg);
      if (!message.id || !message.chatId) return;
      // normalize() leaves group chatName null on purpose; fill it with the real
      // group title here (resolved from the chat, not from pushName).
      if (message.chatId.endsWith('@g.us')) {
        message.chatName = await resolveGroupTitle(msg.id?.remote ?? msg.from);
      }
      post({ kind: 'ingest', message, contact });
    } catch (e) {
      console.warn('[wab] normalize failed', e);
    }
  }

  // One-shot correction of every group's name (catches quiet groups and stale
  // wrong names from the old bug). Pushed as chat-name metadata, not messages.
  async function syncGroupTitles() {
    try {
      const groups = await window.WPP.chat.list({ onlyGroups: true });
      const chatNames = [];
      for (const g of groups || []) {
        const id = toBridgeJid(g?.id?._serialized ?? g?.id?.toString?.());
        const name = g?.formattedTitle ?? g?.groupMetadata?.subject ?? g?.name ?? null;
        if (id && name) chatNames.push({ id, name });
      }
      if (chatNames.length) post({ kind: 'chatMeta', chatNames });
    } catch (e) {
      console.warn('[wab] group title sync failed', e);
    }
  }

  // "Delete for everyone": payload.refId is the MsgKey of the original message
  // (WPP gives it as protocolMessageKey). We keep the body and just flag it.
  function handleRevoke(ev) {
    try {
      const key = ev?.refId;
      const id = key?._serialized ?? key?.toString?.() ?? (key != null ? String(key) : null);
      if (id) post({ kind: 'revoke', id });
    } catch (e) {
      console.warn('[wab] revoke handler failed', e);
    }
  }

  // Edited message: payload.id is the serialized MsgKey (same id as the stored
  // original) and payload.msg is the updated model carrying the new body.
  function handleEdit(ev) {
    try {
      const id = ev?.id != null ? String(ev.id) : null;
      const m = ev?.msg;
      const body = m?.body ?? m?.caption ?? '';
      const ts = (Number(m?.t) || Math.floor(Date.now() / 1000)) * 1000;
      if (id) post({ kind: 'edit', id, body, timestamp: ts });
    } catch (e) {
      console.warn('[wab] edit handler failed', e);
    }
  }

  // Reactions ride the normal ingest path as their own message row (type
  // 'reaction', body = emoji), mirroring how the Baileys backend stores them.
  // r.id = the reaction's own MsgKey, r.msgId = the reacted-to message, r.sender
  // = the reactor, r.reactionText = the emoji ('' when a reaction is removed).
  function handleReaction(r) {
    try {
      const key = r?.id;
      const id = key?._serialized ?? key?.toString?.() ?? null;
      const chatWid = key?.remote ?? r?.msgId?.remote;
      const chatId = toBridgeJid(chatWid);
      if (!id || !chatId) return;
      const fromMe = !!key?.fromMe;
      const sender = fromMe ? chatId : toBridgeJid(r?.sender ?? chatWid);
      const ts = (Number(r?.timestamp ?? r?.t) || Math.floor(Date.now() / 1000)) * 1000;
      post({
        kind: 'ingest',
        message: {
          id, chatId, sender, body: r?.reactionText ?? '',
          timestamp: ts, fromMe, type: 'reaction', chatName: null,
        },
        contact: null,
      });
    } catch (e) {
      console.warn('[wab] reaction handler failed', e);
    }
  }

  function emitStatus(state) {
    post({ kind: 'status', state });
  }

  async function handleSendCommand({ id, chatId, text }) {
    try {
      const result = await window.WPP.chat.sendTextMessage(toWaJid(chatId), text, { createChat: true });
      const waMsgId = result?.id?._serialized ?? result?.id ?? null;
      post({ kind: 'sendResult', id, ok: true, waMsgId: waMsgId ? String(waMsgId) : null });
    } catch (e) {
      post({ kind: 'sendResult', id, ok: false, error: String(e?.message ?? e) });
    }
  }

  // Pull a chat's history back through WPP.chat.getMessages, paging with
  // direction 'before' until we pass `since` (ms), run out, or hit `cap`. Each
  // message is normalized and re-ingested (the server dedups by id).
  async function backfillChat(waChatId, since, cap) {
    let ingested = 0;
    let cursor = null;
    const PAGE = 50;
    // Resolve the group title once and stamp it on every backfilled message, so
    // re-fetched history carries the real name (not null / a sender's name).
    const isGroup = String(waChatId).endsWith('@g.us');
    const groupTitle = isGroup ? await resolveGroupTitle(waChatId) : null;
    for (let guard = 0; guard < 400 && ingested < cap; guard++) {
      const opts = { count: Math.min(PAGE, cap - ingested), direction: 'before' };
      if (cursor) opts.id = cursor;
      let msgs;
      try {
        msgs = await window.WPP.chat.getMessages(waChatId, opts);
      } catch (e) {
        console.warn('[wab] getMessages failed', e);
        break;
      }
      if (!Array.isArray(msgs) || msgs.length === 0) break;

      let oldest = msgs[0];
      let reachedSince = false;
      for (const m of msgs) {
        if ((Number(m?.t) || 0) < (Number(oldest?.t) || 0)) oldest = m;
        const ts = (Number(m?.t) || 0) * 1000;
        if (since && ts < since) { reachedSince = true; continue; }
        const { message, contact } = normalize(m);
        if (!message.id || !message.chatId) continue;
        if (isGroup) message.chatName = groupTitle;
        post({ kind: 'ingest', message, contact });
        ingested++;
      }
      const next = oldest?.id?._serialized ?? oldest?.id?.toString?.() ?? null;
      if (reachedSince || !next || next === cursor || msgs.length < opts.count) break;
      cursor = next;
    }
    return ingested;
  }

  async function handleBackfill({ reqId, chatId, since, max }) {
    const cap = Number(max) || 2000;
    const sinceMs = Number(since) || 0;
    let ingested = 0;
    try {
      if (chatId === '*') {
        // Auto-backfill: refill chats with unread messages (catches threads that
        // got activity while we were offline, including brand-new ones).
        let chats = [];
        try { chats = await window.WPP.chat.list({ onlyWithUnread: true }); } catch (_) { /* */ }
        for (const c of chats || []) {
          if (ingested >= cap) break;
          const waId = c?.id?._serialized ?? c?.id?.toString?.();
          if (waId) ingested += await backfillChat(waId, sinceMs, cap - ingested);
        }
      } else {
        ingested = await backfillChat(toWaJid(chatId), sinceMs, cap);
      }
    } catch (e) {
      console.warn('[wab] backfill failed', e);
    }
    post({ kind: 'backfillResult', reqId, ingested });
  }

  // Commands from bridge.js (ISOLATED world).
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d[TAG] !== true) return;
    if (d.kind === 'sendCommand') handleSendCommand(d);
    else if (d.kind === 'backfillCommand') handleBackfill(d);
  });

  function start() {
    if (window.__wabStarted) return;
    window.__wabStarted = true;
    const WPP = window.WPP;
    WPP.on('chat.new_message', handleNewMessage);
    WPP.on('chat.msg_revoke', handleRevoke);
    WPP.on('chat.msg_edited', handleEdit);
    WPP.on('chat.new_reaction', handleReaction);

    // Connection state → so the bridge's /health can tell whether this tab is
    // actually live (vs. logged out / showing the QR) instead of guessing.
    WPP.on('conn.main_ready', () => { emitStatus('connected'); syncGroupTitles(); });
    WPP.on('conn.require_auth', () => emitStatus('needs_auth'));
    WPP.on('conn.logout', () => emitStatus('logged_out'));
    emitStatus(WPP.conn?.isMainReady ? 'connected' : 'needs_auth');
    if (WPP.conn?.isMainReady) syncGroupTitles();

    post({ kind: 'ready' });
    console.log('[wab] connected to WPP, streaming messages to the bridge');
  }

  // Prefer wa-js's own ready hook over a forever-polling interval; fall back to
  // polling only if the hook isn't present in this build.
  function whenReady(cb) {
    const WPP = window.WPP;
    if (WPP?.webpack?.onFullReady) return WPP.webpack.onFullReady(cb);
    if (WPP?.isFullReady) return cb();
    const t = setInterval(() => {
      if (window.WPP && window.WPP.isFullReady) { clearInterval(t); cb(); }
    }, 500);
  }

  whenReady(start);
})();
