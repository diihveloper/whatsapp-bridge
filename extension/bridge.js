// Runs in the ISOLATED world of web.whatsapp.com. It owns the HTTP link to the
// local whatsapp-bridge service: it POSTs ingested messages to /ingest, and
// receives queued sends pushed over an SSE stream (/outbound/stream), handing
// each to inject.js (MAIN world) and reporting the result to /outbound/:id/result.
//
// Why SSE instead of polling: Chrome heavily throttles a backgrounded tab's
// timers (down to ~once/minute), which would stall a setInterval poll. But the
// tab still reacts to incoming network events, so an SSE push — and flushing
// ingest straight from the inbound message event — keeps working in the
// background without any audio/keep-alive hack. Slow timers remain only as a
// backstop in case the stream drops.
(function () {
  'use strict';
  const TAG = '__wab__';
  const MAX_BATCH = 100;
  const BACKSTOP_FLUSH_MS = 5000;   // safety flush in case an event flush failed
  const BACKSTOP_POLL_MS = 30000;   // safety poll in case the SSE stream dropped

  let cfg = { baseUrl: 'http://127.0.0.1:4477', token: '' };
  let readyLogged = false;
  let es = null;
  let flushScheduled = false;
  const ingestBuffer = { messages: [], contacts: [] };

  function loadConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['baseUrl', 'token'], (v) => {
        if (v.baseUrl) cfg.baseUrl = v.baseUrl.replace(/\/+$/, '');
        if (v.token) cfg.token = v.token;
        resolve();
      });
    });
  }
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.baseUrl) cfg.baseUrl = String(changes.baseUrl.newValue || '').replace(/\/+$/, '');
    if (changes.token) cfg.token = changes.token.newValue || '';
    connectStream(); // reconnect with the new config
  });

  async function api(path, { method = 'GET', body } = {}) {
    if (!cfg.token) return null; // not configured yet
    const res = await fetch(cfg.baseUrl + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}`);
    return res.json().catch(() => ({}));
  }

  // ── Receive from inject.js (MAIN world) ─────────────────────────────────────
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d[TAG] !== true) return;
    if (d.kind === 'ingest') {
      if (d.message) ingestBuffer.messages.push(d.message);
      if (d.contact) ingestBuffer.contacts.push(d.contact);
      scheduleFlush(); // event-driven, so it works even in a background tab
    } else if (d.kind === 'sendResult') {
      reportResult(d);
    } else if (d.kind === 'ready') {
      if (!readyLogged) { console.log('[wab] inject ready'); readyLogged = true; }
    }
  });

  // Flush on a microtask rather than a timer: microtasks aren't throttled in
  // background tabs, and this still batches everything buffered in one task.
  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    Promise.resolve().then(() => { flushScheduled = false; flush(); });
  }

  async function flush() {
    if (!ingestBuffer.messages.length && !ingestBuffer.contacts.length) return;
    const batch = {
      messages: ingestBuffer.messages.splice(0, MAX_BATCH),
      contacts: ingestBuffer.contacts.splice(0, MAX_BATCH),
    };
    try {
      await api('/ingest', { method: 'POST', body: batch });
      if (ingestBuffer.messages.length || ingestBuffer.contacts.length) scheduleFlush();
    } catch (e) {
      // put it back to retry on the next tick / backstop
      ingestBuffer.messages.unshift(...batch.messages);
      ingestBuffer.contacts.unshift(...batch.contacts);
      console.warn('[wab] ingest failed, will retry', e.message);
    }
  }

  // ── Outbound: SSE push (primary) + slow poll (backstop) ─────────────────────
  function dispatchSend(send) {
    window.postMessage({ [TAG]: true, kind: 'sendCommand', id: send.id, chatId: send.chatId, text: send.text }, '*');
  }

  function connectStream() {
    if (es) { es.close(); es = null; }
    if (!cfg.token) return;
    // EventSource can't set an Authorization header, so the token rides in the
    // query string (loopback only).
    es = new EventSource(`${cfg.baseUrl}/outbound/stream?token=${encodeURIComponent(cfg.token)}`);
    es.onopen = () => console.log('[wab] outbound stream connected');
    es.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (d?.sends?.length) for (const s of d.sends) dispatchSend(s);
      } catch (_) { /* ignore non-JSON keepalive */ }
    };
    es.onerror = () => { /* EventSource reconnects on its own; server re-sends pending on connect */ };
  }

  async function reportResult({ id, ok, waMsgId, error }) {
    try {
      await api(`/outbound/${id}/result`, { method: 'POST', body: { ok, waMsgId, error } });
    } catch (e) {
      console.warn('[wab] failed to report send result', e.message);
    }
  }

  async function pollOutbound() {
    try {
      const r = await api('/outbound');
      if (r?.sends?.length) for (const s of r.sends) dispatchSend(s);
    } catch (e) {
      // bridge offline; quiet retry
    }
  }

  (async function main() {
    await loadConfig();
    if (!cfg.token) {
      console.warn('[wab] no API token set — open the extension options and paste the token from ~/.whatsapp-bridge/config.json');
    }
    connectStream();
    setInterval(flush, BACKSTOP_FLUSH_MS);
    setInterval(pollOutbound, BACKSTOP_POLL_MS);
    console.log('[wab] bridge link active ->', cfg.baseUrl);
  })();
})();
