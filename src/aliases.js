import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve('contacts_aliases.txt');
let aliases = new Map();
let reloadTimer = null;

function load() {
  const next = new Map();
  if (fs.existsSync(FILE)) {
    const lines = fs.readFileSync(FILE, 'utf8').split(/\r?\n/);
    for (const raw of lines) {
      const stripped = raw.split('#')[0];
      const eq = stripped.indexOf('=');
      if (eq < 0) continue;
      const alias = stripped.slice(0, eq).trim().toLowerCase();
      const jid = stripped.slice(eq + 1).trim();
      if (alias && jid) next.set(alias, jid);
    }
  }
  aliases = next;
}

load();

try {
  fs.watch(path.dirname(FILE), { persistent: false }, (_event, filename) => {
    if (filename !== path.basename(FILE)) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 100);
  });
} catch {
  // fs.watch unsupported on some filesystems — manual restart needed
}

export function resolveAlias(text) {
  return aliases.get(String(text).toLowerCase()) ?? null;
}

export function listAliases() {
  return [...aliases.entries()].map(([alias, jid]) => ({ alias, jid }));
}

export function aliasesPath() {
  return FILE;
}

// Aliases are a convenience layer (NOT a security control — that's the
// whitelist), so the options page may write them over HTTP. Rewrites preserve
// comments and manual formatting, mirroring scripts/whitelist.js.
function normalizeJid(raw) {
  const j = String(raw).trim();
  if (!j) return null;
  if (j.includes('@')) return j;
  const digits = j.replace(/\D/g, '');
  return digits ? `${digits}@s.whatsapp.net` : null;
}

function readLines() {
  if (!fs.existsSync(FILE)) return [];
  return fs.readFileSync(FILE, 'utf8').split(/\r?\n/);
}

function aliasOnLine(raw) {
  const stripped = raw.split('#')[0];
  const eq = stripped.indexOf('=');
  if (eq < 0) return null;
  return stripped.slice(0, eq).trim().toLowerCase();
}

export function addAlias(alias, jid) {
  const a = String(alias).trim().toLowerCase();
  const j = normalizeJid(jid);
  if (!a || !j) throw new Error('alias and jid are required');
  if (a.includes('=') || a.includes('#')) throw new Error('alias cannot contain "=" or "#"');

  const lines = readLines();
  let replaced = false;
  const out = lines.map((raw) => {
    if (aliasOnLine(raw) === a) { replaced = true; return `${a} = ${j}`; }
    return raw;
  });
  if (!replaced) {
    // append after trimming trailing blank lines so the file doesn't grow gaps
    while (out.length && out[out.length - 1].trim() === '') out.pop();
    out.push(`${a} = ${j}`);
  }
  fs.writeFileSync(FILE, out.join('\n') + '\n');
  load();
  return { alias: a, jid: j };
}

export function removeAlias(alias) {
  const a = String(alias).trim().toLowerCase();
  const lines = readLines();
  let removed = false;
  const out = lines.filter((raw) => {
    if (aliasOnLine(raw) === a) { removed = true; return false; }
    return true;
  });
  if (removed) { fs.writeFileSync(FILE, out.join('\n')); load(); }
  return removed;
}
