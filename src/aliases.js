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
