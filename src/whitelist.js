import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve('send_whitelist.txt');
let allowed = new Set();
let reloadTimer = null;

function normalize(entry) {
  const e = entry.trim();
  if (!e) return null;
  if (e.includes('@')) return e.toLowerCase();
  const digits = e.replace(/\D/g, '');
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
}

function load() {
  const next = new Set();
  if (fs.existsSync(FILE)) {
    const lines = fs.readFileSync(FILE, 'utf8').split(/\r?\n/);
    for (const raw of lines) {
      const beforeComment = raw.split('#')[0];
      const norm = normalize(beforeComment);
      if (norm) next.add(norm);
    }
  }
  allowed = next;
}

load();

try {
  fs.watch(path.dirname(FILE), { persistent: false }, (_event, filename) => {
    if (filename !== path.basename(FILE)) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 100);
  });
} catch {
  // fs.watch unsupported on some filesystems — silently skip; manual restart needed
}

export function isAllowed(jid) {
  return allowed.has(String(jid).toLowerCase());
}

export function listAllowed() {
  return [...allowed];
}

export function whitelistPath() {
  return FILE;
}
