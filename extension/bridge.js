// Runs in the ISOLATED world of web.whatsapp.com. It owns the HTTP link to the
// local whatsapp-bridge service: batches ingested messages to POST /ingest, and
// polls GET /outbound for queued sends, handing each to inject.js (MAIN world)
// and reporting the result back to POST /outbound/:id/result.
(function () {
  'use strict';
  const TAG = '__wab__';
  const FLUSH_MS = 1000;     // batch ingest flush interval
  const POLL_MS = 2000;      // outbound queue poll interval
  const MAX_BATCH = 100;

  let cfg = { baseUrl: 'http://127.0.0.1:4477', token: '' };
  let readyLogged = false;
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
      if (ingestBuffer.messages.length >= MAX_BATCH) flush();
    } else if (d.kind === 'sendResult') {
      reportResult(d);
    } else if (d.kind === 'ready') {
      if (!readyLogged) { console.log('[wab] inject ready'); readyLogged = true; }
    }
  });

  async function flush() {
    if (!ingestBuffer.messages.length && !ingestBuffer.contacts.length) return;
    const batch = {
      messages: ingestBuffer.messages.splice(0, MAX_BATCH),
      contacts: ingestBuffer.contacts.splice(0, MAX_BATCH),
    };
    try {
      await api('/ingest', { method: 'POST', body: batch });
    } catch (e) {
      // put it back to retry on the next tick
      ingestBuffer.messages.unshift(...batch.messages);
      ingestBuffer.contacts.unshift(...batch.contacts);
      console.warn('[wab] ingest failed, will retry', e.message);
    }
  }

  // ── Outbound queue ──────────────────────────────────────────────────────────
  function dispatchSend(send) {
    window.postMessage({ [TAG]: true, kind: 'sendCommand', id: send.id, chatId: send.chatId, text: send.text }, '*');
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
    setInterval(flush, FLUSH_MS);
    setInterval(pollOutbound, POLL_MS);
    console.log('[wab] bridge link active ->', cfg.baseUrl);
  })();
})();
