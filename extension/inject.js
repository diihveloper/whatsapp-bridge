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

  function handleNewMessage(msg) {
    try {
      const { message, contact } = normalize(msg);
      if (!message.id || !message.chatId) return;
      post({ kind: 'ingest', message, contact });
    } catch (e) {
      console.warn('[wab] normalize failed', e);
    }
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

  // Commands from bridge.js (ISOLATED world).
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d[TAG] !== true || d.kind !== 'sendCommand') return;
    handleSendCommand(d);
  });

  function start() {
    if (window.__wabStarted) return;
    window.__wabStarted = true;
    window.WPP.on('chat.new_message', handleNewMessage);
    post({ kind: 'ready' });
    console.log('[wab] connected to WPP, streaming messages to the bridge');
  }

  function waitForWPP() {
    const t = setInterval(() => {
      if (window.WPP && window.WPP.isFullReady) {
        clearInterval(t);
        start();
      }
    }, 500);
  }

  waitForWPP();
})();
