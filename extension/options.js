'use strict';
const $ = (id) => document.getElementById(id);

// ── Config ───────────────────────────────────────────────────────────────────
function cfg() {
  return {
    baseUrl: ($('baseUrl').value.trim().replace(/\/+$/, '')) || 'http://127.0.0.1:4477',
    token: $('token').value.trim(),
  };
}

chrome.storage.local.get(['baseUrl', 'token'], (v) => {
  $('baseUrl').value = v.baseUrl || 'http://127.0.0.1:4477';
  $('token').value = v.token || '';
  if (v.token) refreshAll();
});

// ── HTTP helper ──────────────────────────────────────────────────────────────
async function api(path, { method = 'GET', body } = {}) {
  const { baseUrl, token } = cfg();
  if (!token) throw new Error('set the API token first');
  const res = await fetch(baseUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${method} ${path} → ${res.status}`);
  return data;
}

function setStatus(el, msg, kind) {
  el.textContent = msg;
  el.className = 'status' + (kind ? ' ' + kind : '');
  if (kind === 'ok') setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 3000);
}

const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── Save / refresh ───────────────────────────────────────────────────────────
$('save').addEventListener('click', () => {
  const { baseUrl, token } = cfg();
  chrome.storage.local.set({ baseUrl, token }, () => {
    setStatus($('saveStatus'), 'Saved. Reload the WhatsApp Web tab.', 'ok');
    refreshAll();
  });
});
$('refresh').addEventListener('click', refreshAll);

function refreshAll() {
  chatCache = null; // force re-fetch of chats for search
  renderHealth();
  renderAliases();
  renderWhitelist();
}

// ── Status panel ─────────────────────────────────────────────────────────────
async function renderHealth() {
  const el = $('health');
  try {
    const h = await api('/health');
    const conn = h.connected
      ? '<span class="badge on">connected</span>'
      : '<span class="badge off">disconnected</span>';
    const ext = h.extension ? ` (tab: ${esc(h.extension.state)})` : '';
    const send = h.sendEnabled
      ? '<span class="badge on">enabled</span>'
      : '<span class="badge off">disabled</span>';
    el.innerHTML = `<dl class="health">
      <dt>Mode</dt><dd>${esc(h.mode)}</dd>
      <dt>Connection</dt><dd>${conn}${esc(ext)}</dd>
      <dt>Sending</dt><dd>${send}</dd>
      <dt>Messages</dt><dd>${esc(h.messages)}</dd>
      <dt>Chats</dt><dd>${esc(h.chats)}</dd>
      <dt>Contacts</dt><dd>${esc(h.contacts)}</dd>
    </dl>`;
    $('sendBadge').className = 'badge ' + (h.sendEnabled ? 'on' : 'off');
    $('sendBadge').textContent = h.sendEnabled ? 'sending on' : 'sending off';
  } catch (e) {
    el.innerHTML = `<span class="err">${esc(e.message)} — is the service running?</span>`;
  }
}

// ── Shared search (chats + contacts; groups come from chats) ─────────────────
let chatCache = null;
async function getChats() {
  if (!chatCache) {
    const list = await api('/chats?limit=200');
    chatCache = Array.isArray(list) ? list : [];
  }
  return chatCache;
}

async function searchAll(q) {
  const query = q.trim().toLowerCase();
  if (!query) return [];
  const out = new Map(); // jid -> { jid, name, kind }
  try {
    const chats = await getChats();
    for (const c of chats) {
      const name = c.name || c.id;
      if (String(name).toLowerCase().includes(query) || String(c.id).toLowerCase().includes(query)) {
        out.set(c.id, { jid: c.id, name, kind: c.isGroup ? 'group' : 'dm' });
      }
    }
  } catch (_) { /* ignore */ }
  try {
    const { results = [] } = await api('/contacts?q=' + encodeURIComponent(query));
    for (const r of results) if (!out.has(r.jid)) out.set(r.jid, { jid: r.jid, name: r.name || r.jid, kind: 'dm' });
  } catch (_) { /* ignore */ }
  return [...out.values()].slice(0, 30);
}

function renderResults(box, items, onPick) {
  if (!items.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = '';
  for (const it of items) {
    const div = document.createElement('div');
    const tag = it.kind === 'group' ? '👥 ' : '';
    div.innerHTML = `<span>${tag}${esc(it.name)}</span><span class="jid">${esc(it.jid)}</span>`;
    div.addEventListener('click', () => { onPick(it); box.hidden = true; });
    box.appendChild(div);
  }
}

// ── Aliases ──────────────────────────────────────────────────────────────────
async function renderAliases() {
  const ul = $('aliasList');
  try {
    const { aliases = [] } = await api('/contacts/aliases');
    ul.innerHTML = '';
    if (!aliases.length) { ul.innerHTML = '<li class="meta">No aliases yet.</li>'; return; }
    for (const a of aliases) {
      const li = document.createElement('li');
      li.innerHTML = `<span><b>${esc(a.alias)}</b> <span class="meta">→</span> ${esc(a.jid)}</span>`;
      const del = document.createElement('button');
      del.className = 'tiny danger';
      del.textContent = 'remove';
      del.addEventListener('click', async () => {
        try { await api('/contacts/aliases/' + encodeURIComponent(a.alias), { method: 'DELETE' }); renderAliases(); }
        catch (e) { setStatus($('aliasStatus'), e.message, 'err'); }
      });
      li.appendChild(del);
      ul.appendChild(li);
    }
  } catch (e) {
    ul.innerHTML = `<li class="err">${esc(e.message)}</li>`;
  }
}

$('aliasAdd').addEventListener('click', async () => {
  const alias = $('aliasName').value.trim();
  const jid = $('aliasJid').value.trim();
  if (!alias || !jid) return setStatus($('aliasStatus'), 'alias and JID are required', 'err');
  try {
    await api('/contacts/aliases', { method: 'POST', body: { alias, jid } });
    $('aliasName').value = ''; $('aliasJid').value = '';
    setStatus($('aliasStatus'), 'Added.', 'ok');
    renderAliases();
  } catch (e) { setStatus($('aliasStatus'), e.message, 'err'); }
});

$('aliasSearch').addEventListener('input', debounce(async (e) => {
  const items = await searchAll(e.target.value);
  renderResults($('aliasSearchResults'), items, (it) => {
    $('aliasJid').value = it.jid;
    if (!$('aliasName').value.trim()) $('aliasName').value = String(it.name).toLowerCase().split(/\s+/)[0] || '';
    $('aliasSearch').value = '';
  });
}));

// ── Whitelist (read-only) ────────────────────────────────────────────────────
async function renderWhitelist() {
  const ul = $('wlList');
  try {
    const { enabled, allowed = [] } = await api('/send/whitelist');
    $('sendBadge').className = 'badge ' + (enabled ? 'on' : 'off');
    $('sendBadge').textContent = enabled ? 'sending on' : 'sending off';
    ul.innerHTML = '';
    if (!allowed.length) { ul.innerHTML = '<li class="meta">Empty — no chats can be sent to.</li>'; return; }
    for (const jid of allowed) {
      const li = document.createElement('li');
      li.innerHTML = `<span>${esc(jid)}</span>`;
      ul.appendChild(li);
    }
  } catch (e) {
    ul.innerHTML = `<li class="err">${esc(e.message)}</li>`;
  }
}

$('wlSearch').addEventListener('input', debounce(async (e) => {
  const items = await searchAll(e.target.value);
  renderResults($('wlSearchResults'), items, async (it) => {
    $('wlSearch').value = '';
    try { await navigator.clipboard.writeText(it.jid); setStatus($('wlStatus'), `Copied ${it.jid} — paste it into send_whitelist.txt`, 'ok'); }
    catch (_) { setStatus($('wlStatus'), `JID: ${it.jid} (copy it into send_whitelist.txt)`, 'ok'); }
  });
}));

// ── Backfill ─────────────────────────────────────────────────────────────────
$('bfChat').addEventListener('input', debounce(async (e) => {
  const v = e.target.value;
  if (v.includes('@')) { $('bfSearchResults').hidden = true; return; } // looks like a JID already
  const items = await searchAll(v);
  renderResults($('bfSearchResults'), items, (it) => { $('bfChat').value = it.jid; });
}));

$('bfRun').addEventListener('click', async () => {
  const chat = $('bfChat').value.trim();
  if (!chat.includes('@')) return setStatus($('bfStatus'), 'pick a chat or paste a JID', 'err');
  const dateVal = $('bfSince').value;
  const since = dateVal ? new Date(dateVal).getTime() : 0;
  setStatus($('bfStatus'), 'backfilling…', '');
  try {
    const r = await api('/chats/' + encodeURIComponent(chat) + '/backfill', { method: 'POST', body: { since } });
    if (r.pending) setStatus($('bfStatus'), 'started; still running — check messages shortly', 'ok');
    else setStatus($('bfStatus'), `done — ${r.ingested} message(s) ingested`, 'ok');
    renderHealth();
  } catch (e) { setStatus($('bfStatus'), e.message, 'err'); }
});
