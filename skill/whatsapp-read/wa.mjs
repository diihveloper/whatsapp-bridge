#!/usr/bin/env node
// wa — a thin CLI over the local whatsapp-bridge HTTP API. It reads the config
// (baseUrl + apiToken), adds auth, composes multi-step flows (resolve name →
// optional backfill → read), and prints model-friendly output. The skill calls
// this instead of building curl commands by hand.
//
// Usage:
//   wa health
//   wa read <name|jid> [--limit N] [--since <ISO|ms>] [--days N] [--backfill] [--json]
//   wa search <text...> [--limit N] [--json]
//   wa chats [--unread] [--limit N] [--json]
//   wa who <name|jid> [--json]
//   wa send <name|jid> <text...> [--json]
//   wa aliases [--json] | wa aliases add <name> <jid> | wa aliases rm <name>
//
// Config: ~/.whatsapp-bridge/config.json (or env WA_BRIDGE_URL / WA_BRIDGE_TOKEN).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Config ────────────────────────────────────────────────────────────────
function loadConfig() {
  let baseUrl = process.env.WA_BRIDGE_URL;
  let token = process.env.WA_BRIDGE_TOKEN;
  if (!baseUrl || !token) {
    const file = path.join(os.homedir(), '.whatsapp-bridge', 'config.json');
    try {
      const c = JSON.parse(fs.readFileSync(file, 'utf8'));
      baseUrl = baseUrl || c.baseUrl;
      token = token || c.apiToken;
    } catch {
      fail(`Could not read ${file}. Is the whatsapp-bridge service set up? Run "npm start" in the repo.`);
    }
  }
  if (!baseUrl || !token) fail('Missing baseUrl/apiToken in config.');
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token };
}

const cfg = loadConfig();

async function api(p, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(cfg.baseUrl + p, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    fail(`Cannot reach the service at ${cfg.baseUrl} (${e.code || e.message}). Is it running? "npm start".`);
  }
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

function fail(msg) { console.error('error: ' + msg); process.exit(1); }

// ── Arg parsing ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const flags = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else pos.push(a);
  }
  return { flags, pos };
}

// ── Formatting ─────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
function fmtTime(ms) {
  const d = new Date(Number(ms));
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const jidTail = (jid) => String(jid || '').split('@')[0];

function speaker(m, target, isGroup) {
  if (m.fromMe) return 'eu';
  if (m.senderName) return m.senderName;
  if (!isGroup && target?.name) return target.name;
  return jidTail(m.sender);
}

function fmtMessage(m, target, isGroup) {
  let body = m.body ?? '';
  if (m.deletedAt) body = `[apagada] ${body}`.trim();
  let line = `${fmtTime(m.timestamp)}  ${speaker(m, target, isGroup)}: ${body}`;
  if (m.editedAt) line += '  (editada)';
  return line;
}

function printConversation(d, { json }) {
  if (json) return console.log(JSON.stringify(d, null, 2));
  if (!d.found) {
    if (d.ambiguous) {
      console.log(`Ambiguous "${d.query}" — ${d.candidates.length} matches:`);
      for (const c of d.candidates) {
        console.log(`  • ${c.name || jidTail(c.jid)}  (${c.jid})  ${c.isGroup ? '[group]' : ''}`);
      }
      console.log('Re-run with the exact JID.');
    } else {
      console.log(`No chat/contact matched "${d.query}".`);
    }
    return;
  }
  const t = d.target;
  const isGroup = String(t.jid).endsWith('@g.us');
  console.log(`${t.name || jidTail(t.jid)}  (${t.jid})  [matched via ${t.matchedVia}]`);
  if (d.backfilled != null) console.log(`(backfilled ${d.backfilled} message(s))`);
  console.log(`── ${d.count} message(s) ──`);
  for (const m of d.messages) console.log(fmtMessage(m, t, isGroup));
}

// ── Commands ────────────────────────────────────────────────────────────────
const commands = {
  async health({ flags }) {
    const { data } = await api('/health');
    if (flags.json) return console.log(JSON.stringify(data, null, 2));
    const conn = data.connected ? 'connected' : 'disconnected';
    const ext = data.extension ? ` (tab: ${data.extension.state})` : '';
    console.log(`mode: ${data.mode} | ${conn}${ext} | sending: ${data.sendEnabled ? 'ON' : 'off'}`);
    console.log(`messages: ${data.messages} | chats: ${data.chats} | contacts: ${data.contacts}`);
  },

  async read({ flags, pos }) {
    const name = pos.join(' ').trim();
    if (!name) fail('usage: wa read <name|jid> [--limit N] [--since <ISO|ms>] [--days N] [--backfill]');
    const qs = new URLSearchParams({ name });
    if (flags.limit) qs.set('limit', flags.limit);
    if (flags.days) qs.set('days', flags.days);
    if (flags.since) {
      const ms = /^\d+$/.test(flags.since) ? Number(flags.since) : Date.parse(flags.since);
      if (!Number.isNaN(ms)) qs.set('since', String(ms));
    }
    if (flags.backfill) qs.set('backfill', 'true');
    const { data } = await api('/conversation?' + qs.toString());
    printConversation(data, { json: !!flags.json });
  },

  async search({ flags, pos }) {
    const q = pos.join(' ').trim();
    if (!q) fail('usage: wa search <text...> [--limit N]');
    const qs = new URLSearchParams({ q });
    if (flags.limit) qs.set('limit', flags.limit);
    const { data } = await api('/search?' + qs.toString());
    if (flags.json) return console.log(JSON.stringify(data, null, 2));
    if (!data.length) return console.log(`No matches for "${q}".`);
    for (const m of data) {
      const who = m.fromMe ? 'eu' : (m.chatName || jidTail(m.sender));
      console.log(`${fmtTime(m.timestamp)}  [${who}] ${m.body}`);
    }
  },

  async chats({ flags }) {
    const qs = new URLSearchParams();
    if (flags.unread) qs.set('unread', 'true');
    if (flags.limit) qs.set('limit', flags.limit);
    const { data } = await api('/chats?' + qs.toString());
    if (flags.json) return console.log(JSON.stringify(data, null, 2));
    if (!data.length) return console.log('No chats.');
    for (const c of data) {
      const unread = c.unread ? ` (${c.unread} unread)` : '';
      const when = c.lastMessageAt ? fmtTime(c.lastMessageAt) : '—';
      console.log(`${when}  ${c.name || jidTail(c.id)}${c.isGroup ? ' [group]' : ''}${unread}  ${c.id}`);
    }
  },

  async who({ flags, pos }) {
    const name = pos.join(' ').trim();
    if (!name) fail('usage: wa who <name|jid>');
    const { data } = await api('/conversation?limit=1&name=' + encodeURIComponent(name));
    if (flags.json) return console.log(JSON.stringify(data, null, 2));
    if (data.found) console.log(`${data.target.name || jidTail(data.target.jid)}  (${data.target.jid})  [via ${data.target.matchedVia}]`);
    else if (data.ambiguous) { console.log(`Ambiguous — ${data.candidates.length} matches:`); for (const c of data.candidates) console.log(`  • ${c.name || jidTail(c.jid)}  (${c.jid})`); }
    else console.log(`No match for "${name}".`);
  },

  async send({ flags, pos }) {
    const name = pos.shift();
    const text = pos.join(' ').trim();
    if (!name || !text) fail('usage: wa send <name|jid> <text...>');
    // resolve first so we send to the right chat (and fail loudly on ambiguity)
    const { data: r } = await api('/conversation?limit=1&name=' + encodeURIComponent(name));
    if (!r.found) {
      if (r.ambiguous) { console.log(`Ambiguous "${name}" — specify the exact JID:`); for (const c of r.candidates) console.log(`  • ${c.name || jidTail(c.jid)}  (${c.jid})`); }
      else console.log(`No chat matched "${name}".`);
      process.exit(1);
    }
    const jid = r.target.jid;
    const { status, data } = await api('/chats/' + encodeURIComponent(jid) + '/messages', { method: 'POST', body: { text } });
    if (flags.json) return console.log(JSON.stringify({ jid, status, ...data }, null, 2));
    if (status === 200) console.log(`Sent to ${r.target.name || jidTail(jid)} (${jid}).`);
    else if (status === 202) console.log(`Queued for ${jid}; the WhatsApp Web tab didn't confirm yet. Make sure it's open.`);
    else console.log(`Not sent (${status}): ${data.error || 'unknown error'}`);
  },

  async aliases({ flags, pos }) {
    const sub = pos.shift();
    if (sub === 'add') {
      const [alias, jid] = pos;
      if (!alias || !jid) fail('usage: wa aliases add <name> <jid>');
      const { ok, data } = await api('/contacts/aliases', { method: 'POST', body: { alias, jid } });
      console.log(ok ? `Added: ${data.alias} → ${data.jid}` : `Failed: ${data.error}`);
    } else if (sub === 'rm' || sub === 'remove') {
      const alias = pos[0];
      if (!alias) fail('usage: wa aliases rm <name>');
      const { data } = await api('/contacts/aliases/' + encodeURIComponent(alias), { method: 'DELETE' });
      console.log(data.removed ? `Removed ${alias}.` : `No alias named ${alias}.`);
    } else {
      const { data } = await api('/contacts/aliases');
      if (flags.json) return console.log(JSON.stringify(data, null, 2));
      if (!data.aliases?.length) return console.log('No aliases.');
      for (const a of data.aliases) console.log(`${a.alias} → ${a.jid}`);
    }
  },
};

// ── Dispatch ────────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);
const handler = commands[cmd];
if (!handler) {
  console.log('wa — whatsapp-bridge CLI\n');
  console.log('commands: health | read | search | chats | who | send | aliases');
  console.log('run "wa <command>" with --help-style usage shown on missing args.');
  process.exit(cmd ? 1 : 0);
}
handler(parseArgs(rest)).catch((e) => fail(e.message));
