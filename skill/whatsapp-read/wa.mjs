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
//   wa digest [--summarize] [--limit N] [--json]
//   wa pending [--hours N] [--dm] [--limit N] [--json]
//   wa alerts [--limit N] [--json]
//   wa mentions [--limit N] [--days N] [--json]
//   wa export <name|jid> [--days N] [--limit N] [--out file.md] [--json]
//   wa media <msgId> [--out file]
//   wa who <name|jid> [--json]
//   wa send <name|jid> <text...> [--file <path|url>] [--caption "..."] [--reply <msgId>] [--prefix "..."] [--no-prefix] [--json]
//   wa aliases [--json] | wa aliases add <name> <jid> | wa aliases rm <name>
//   wa update [--check] [--yes] [--force] [--json]
//
// Config: ~/.whatsapp-bridge/config.json (or env WA_BRIDGE_URL / WA_BRIDGE_TOKEN).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

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

// y/N prompt for `wa update`. Default no on Enter / unknown input.
function confirm(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
}

// Spawn a child, stream its output, resolve with {code, stdout}. capture=true
// also collects stdout for inspection (e.g. `git status --porcelain`). shell=true
// is needed on Windows for `npm` (which lives as npm.cmd).
function run(cmd, args, { cwd, capture = false, shell = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, shell, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
    let out = '';
    if (capture) child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', (e) => resolve({ code: 1, stdout: out, error: e }));
    child.on('close', (code) => resolve({ code: code ?? 0, stdout: out }));
  });
}

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
const EXT_BY_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'video/mp4': '.mp4', 'video/quicktime': '.mov', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'application/pdf': '.pdf', 'application/zip': '.zip' };
const extFromMime = (mime) => EXT_BY_MIME[mime] || '';

function speaker(m, target, isGroup) {
  if (m.fromMe) return 'eu';
  if (m.senderName) return m.senderName;
  if (!isGroup && target?.name) return target.name;
  return jidTail(m.sender);
}

const MEDIA_ICON = { audio: '🎙️', image: '🖼️', video: '🎬', document: '📎', sticker: '🩷' };
const PLACEHOLDER = /^\[(audio|image|video|document|sticker)\]$/i;

function fmtMessage(m, target, isGroup) {
  let body = m.body ?? '';
  const icon = MEDIA_ICON[m.type];
  if (icon) {
    // Audio transcript / image OCR is folded into body; show the icon + text.
    // If still just the placeholder, show only the icon (+ a processing hint).
    body = PLACEHOLDER.test(body.trim()) ? icon : `${icon} ${body}`;
    if (m.mediaStatus === 'pending') body += ' (processando…)';
    else if (m.mediaStatus === 'error') body += ' (falha ao processar)';
  }
  if (m.deletedAt) body = `[apagada] ${body}`.trim();
  let line = `${fmtTime(m.timestamp)}  ${speaker(m, target, isGroup)}: ${body}`;
  if (m.editedAt) line += '  (editada)';
  return line;
}

// Markdown transcript for `wa export` — fed to the document skill to render an
// LI-styled .docx/PDF, or used as-is.
function buildExportMarkdown(data, t, isGroup) {
  const msgs = data.messages || [];
  const first = msgs.length ? fmtTime(msgs[0].timestamp) : '—';
  const last = msgs.length ? fmtTime(msgs[msgs.length - 1].timestamp) : '—';
  const out = [
    `# Conversa: ${t.name || jidTail(t.jid)}`, '',
    `- **JID:** ${t.jid}`,
    `- **Tipo:** ${isGroup ? 'Grupo' : 'Conversa individual'}`,
    `- **Mensagens:** ${msgs.length}`,
    `- **Período:** ${first} – ${last}`,
    `- **Exportado em:** ${fmtTime(Date.now())}`,
    '', '---', '',
  ];
  for (const m of msgs) {
    let body = m.body ?? '';
    const icon = MEDIA_ICON[m.type];
    if (icon) body = PLACEHOLDER.test(body.trim()) ? icon : `${icon} ${body}`;
    if (m.deletedAt) body = `[apagada] ${body}`.trim();
    const who = m.fromMe ? 'eu' : (m.senderName || (!isGroup && t.name) || jidTail(m.sender));
    out.push(`**[${fmtTime(m.timestamp)}] ${who}:** ${body}${m.editedAt ? ' _(editada)_' : ''}`, '');
  }
  return out.join('\n');
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
    const tag = data.send?.agentPrefix ? ` | tag: ${JSON.stringify(data.send.agentPrefix)}` : '';
    console.log(`mode: ${data.mode} | ${conn}${ext} | sending: ${data.sendEnabled ? 'ON' : 'off'}${tag}`);
    if (data.media) {
      const md = data.media;
      console.log(`media: transcribe=${md.transcribe} | ocr=${md.ocr} | store=${md.store}`);
    }
    if (data.summary) console.log(`summary: ${data.summary.provider}`);
    if (data.watchlist) {
      const w = data.watchlist;
      console.log(`watchlist: ${w.keywords} palavra(s) | canais: ${w.channels.length ? w.channels.join(', ') : 'nenhum'}`);
    }
    if (data.update) {
      const u = data.update;
      if (u.available) console.log(`update: ${u.commitsBehind} new commit(s) on ${u.upstreamRef} — run "wa update"`);
      else if (u.error) console.log(`update: check failed (${u.error})`);
      else if (u.available === false) console.log(`update: up to date with ${u.upstreamRef}`);
    }
    console.log(`messages: ${data.messages} | chats: ${data.chats} | contacts: ${data.contacts}`);
  },

  async update({ flags }) {
    // Force a fresh check so we don't act on stale state from the last 6h tick.
    const { data: chk } = await api('/update/check', { method: 'POST' });
    const u = chk.status || {};

    // --json (with or without --check) reports status + commits and exits without
    // shelling out — confirmation makes no sense in JSON mode.
    if (flags.json) {
      const { data: log } = u.available ? await api('/update/commits?limit=20') : { data: { commits: [] } };
      return console.log(JSON.stringify({ status: u, commits: log.commits || [] }, null, 2));
    }

    if (u.error) {
      console.log(`Update check failed: ${u.error}`);
      console.log(`(repo: ${u.repoPath || '?'} — make sure git is installed and a remote is configured)`);
      process.exit(1);
    }
    if (!u.available) {
      console.log(`Already up to date with ${u.upstreamRef} (HEAD ${u.current?.slice(0, 7)}).`);
      return;
    }

    const { data: log } = await api('/update/commits?limit=20');
    console.log(`${u.commitsBehind} new commit(s) on ${u.upstreamRef}:`);
    for (const c of (log.commits || [])) {
      const d = c.date ? c.date.slice(0, 10) : '';
      console.log(`  ${c.hash.slice(0, 7)}  ${d}  ${c.subject}  — ${c.author}`);
    }
    if (flags.check) return;

    if (!flags.yes) {
      const ok = await confirm(`\nRun "git pull && npm install" in ${u.repoPath}? [y/N] `);
      if (!ok) { console.log('Aborted.'); return; }
    }

    // Refuse to pull on a dirty tree unless --force; `git pull` would otherwise
    // either fail or merge into uncommitted changes.
    if (!flags.force) {
      const dirty = await run('git', ['status', '--porcelain'], { cwd: u.repoPath, capture: true });
      if (dirty.stdout.trim()) {
        console.log('\nWorking tree has local changes:');
        console.log(dirty.stdout);
        console.log('Commit/stash them, or re-run with --force.');
        process.exit(1);
      }
    }

    console.log('\n→ git pull');
    const pull = await run('git', ['pull', '--ff-only'], { cwd: u.repoPath });
    if (pull.code !== 0) {
      console.log('git pull failed. Resolve and re-run "wa update".');
      process.exit(pull.code || 1);
    }
    console.log('\n→ npm install');
    const install = await run('npm', ['install'], { cwd: u.repoPath, shell: true });
    if (install.code !== 0) {
      console.log('npm install failed. The pull succeeded; fix the install and re-run "npm install".');
      process.exit(install.code || 1);
    }
    console.log('\n✓ Updated. Restart the service (stop "npm start" and run it again) to load the new code.');
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

  async digest({ flags }) {
    const qs = new URLSearchParams();
    if (flags.limit) qs.set('limit', flags.limit);
    if (flags.summarize) qs.set('summarize', 'true');
    const { data } = await api('/digest?' + qs.toString());
    if (flags.json) return console.log(JSON.stringify(data, null, 2));
    if (data.summaryError) console.log(`(resumo server-side indisponível: ${data.summaryError})\n`);
    if (data.summary) return console.log(data.summary);
    if (!data.chats.length) return console.log('Nenhuma conversa não lida. 🎉');
    // No server-side summary: print the grouped data so the caller can summarize.
    for (const c of data.chats) {
      console.log(`\n## ${c.name || jidTail(c.jid)}${c.isGroup ? ' [grupo]' : ''}  (${c.unread} não lida(s))`);
      const isGroup = String(c.jid).endsWith('@g.us');
      for (const m of c.messages) console.log(fmtMessage(m, { name: c.name }, isGroup));
    }
  },

  async pending({ flags }) {
    const qs = new URLSearchParams();
    if (flags.hours) qs.set('hours', flags.hours);
    if (flags.limit) qs.set('limit', flags.limit);
    if (flags.dm) qs.set('groups', 'false');
    const { data } = await api('/pending?' + qs.toString());
    if (flags.json) return console.log(JSON.stringify(data, null, 2));
    if (!data.pending.length) return console.log(`Ninguém esperando resposta há mais de ${data.hours}h. 🎉`);
    console.log(`Esperando resposta há mais de ${data.hours}h (${data.pending.length}):`);
    for (const p of data.pending) {
      const waited = ((Date.now() - p.lastAt) / 3600000).toFixed(1);
      const who = p.name || p.senderName || jidTail(p.jid);
      const snippet = (p.lastBody || '').replace(/\s+/g, ' ').slice(0, 80);
      console.log(`  • ${who}${p.isGroup ? ' [grupo]' : ''} — ${waited}h — "${snippet}"  (${p.jid})`);
    }
  },

  async alerts({ flags }) {
    const qs = new URLSearchParams();
    if (flags.limit) qs.set('limit', flags.limit);
    const { data } = await api('/alerts?' + qs.toString());
    if (flags.json) return console.log(JSON.stringify(data, null, 2));
    console.log(`Watchlist: ${data.keywords.length ? data.keywords.join(', ') : '(vazia — crie watchlist.txt)'}`);
    console.log(`Canais: ${data.channels.length ? data.channels.join(', ') : '(nenhum configurado no .env)'}`);
    if (!data.alerts.length) return console.log('Nenhum alerta registrado.');
    console.log(`\nÚltimos ${data.alerts.length}:`);
    for (const a of data.alerts) {
      const snippet = (a.body || '').replace(/\s+/g, ' ').slice(0, 80);
      console.log(`  ${fmtTime(a.matchedAt)}  [${a.keyword}] ${a.chatName || jidTail(a.chatId)}: ${snippet}`);
    }
  },

  async media({ flags, pos }) {
    const msgId = pos.join(' ').trim();
    if (!msgId) fail('usage: wa media <msgId> [--out file]  (get the msgId from `wa read --json`)');
    // Ask the tab to (re)download the media for this message and store it.
    const { status, data } = await api('/messages/' + encodeURIComponent(msgId) + '/fetch-media', { method: 'POST' });
    if (flags.json) return console.log(JSON.stringify({ status, ...data }, null, 2));
    if (status === 202) return console.log(`Mídia ainda não disponível: ${data.note || 'tente de novo em instantes'}`);
    if (!data.ok) return console.log(`Falha (${status}): ${data.error || 'erro desconhecido'}`);
    // Download the bytes and save.
    const out = flags.out || `media_${msgId.replace(/[^A-Za-z0-9]/g, '_').slice(0, 40)}${extFromMime(data.mime)}`;
    let res;
    try {
      res = await fetch(cfg.baseUrl + '/messages/' + encodeURIComponent(msgId) + '/media', { headers: { Authorization: 'Bearer ' + cfg.token } });
    } catch (e) { fail(`Cannot reach the service (${e.message}).`); }
    if (!res.ok) return console.log(`Mídia registrada, mas não consegui baixar o arquivo (${res.status}).`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(out, buf);
    console.log(`Mídia salva em ${out}  (${data.mime || 'tipo desconhecido'}, ${buf.length} bytes)`);
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
    const file = typeof flags.file === 'string' ? flags.file : null;
    if (!name || (!text && !file)) fail('usage: wa send <name|jid> <text...> [--file <path|url>] [--caption "..."] [--reply <msgId>] [--prefix "..."] [--no-prefix]');
    // resolve first so we send to the right chat (and fail loudly on ambiguity)
    const { data: r } = await api('/conversation?limit=1&name=' + encodeURIComponent(name));
    if (!r.found) {
      if (r.ambiguous) { console.log(`Ambiguous "${name}" — specify the exact JID:`); for (const c of r.candidates) console.log(`  • ${c.name || jidTail(c.jid)}  (${c.jid})`); }
      else console.log(`No chat matched "${name}".`);
      process.exit(1);
    }
    const jid = r.target.jid;
    const body = {};
    if (file) {
      body.media = /^https?:\/\//i.test(file) ? { url: file } : { path: file };
      const cap = typeof flags.caption === 'string' ? flags.caption : text;
      if (cap) body.caption = cap;
    } else {
      body.text = text;
    }
    if (flags.reply) body.quotedMsgId = String(flags.reply);
    // Per-send override of SEND_AGENT_PREFIX. --no-prefix wins if both are passed.
    if (flags['no-prefix']) body.agentPrefix = false;
    else if (typeof flags.prefix === 'string') body.agentPrefix = flags.prefix;
    const { status, data } = await api('/chats/' + encodeURIComponent(jid) + '/messages', { method: 'POST', body });
    if (flags.json) return console.log(JSON.stringify({ jid, status, ...data }, null, 2));
    const what = file ? `file ${file}` : 'message';
    if (status === 200) console.log(`Sent ${what} to ${r.target.name || jidTail(jid)} (${jid}).`);
    else if (status === 202) console.log(`Queued for ${jid}; the WhatsApp Web tab didn't confirm yet. Make sure it's open.`);
    else console.log(`Not sent (${status}): ${data.error || 'unknown error'}`);
  },

  async mentions({ flags }) {
    const qs = new URLSearchParams();
    if (flags.limit) qs.set('limit', flags.limit);
    if (flags.days) qs.set('days', flags.days);
    const { data } = await api('/mentions?' + qs.toString());
    if (flags.json) return console.log(JSON.stringify(data, null, 2));
    if (!data.mentions.length) return console.log('Nenhuma menção a você registrada.');
    console.log(`Você foi mencionado ${data.mentions.length}x:`);
    for (const m of data.mentions) {
      const who = m.senderName || jidTail(m.sender);
      const snippet = (m.body || '').replace(/\s+/g, ' ').slice(0, 100);
      console.log(`  ${fmtTime(m.timestamp)}  ${m.chatName || jidTail(m.chatId)} — ${who}: ${snippet}`);
    }
  },

  async export({ flags, pos }) {
    const name = pos.join(' ').trim();
    if (!name) fail('usage: wa export <name|jid> [--days N] [--limit N] [--out file.md]');
    const qs = new URLSearchParams({ name, limit: flags.limit || '500' });
    if (flags.days) qs.set('days', flags.days);
    const { data } = await api('/conversation?' + qs.toString());
    if (flags.json) return console.log(JSON.stringify(data, null, 2));
    if (!data.found) {
      if (data.ambiguous) { console.log(`Ambíguo "${name}":`); for (const c of data.candidates) console.log(`  • ${c.name || jidTail(c.jid)}  (${c.jid})`); }
      else console.log(`Nenhuma conversa para "${name}".`);
      process.exit(1);
    }
    const t = data.target;
    const isGroup = String(t.jid).endsWith('@g.us');
    const md = buildExportMarkdown(data, t, isGroup);
    if (flags.out) {
      fs.writeFileSync(flags.out, md);
      console.log(`Exportado ${data.count} mensagem(ns) de "${t.name || jidTail(t.jid)}" para ${flags.out}`);
    } else {
      console.log(md);
    }
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
  console.log('commands: health | read | search | chats | digest | pending | alerts | mentions | export | media | who | send | aliases | update');
  console.log('run "wa <command>" with --help-style usage shown on missing args.');
  process.exit(cmd ? 1 : 0);
}
handler(parseArgs(rest)).catch((e) => fail(e.message));
