// Keyword watchlist for alerts. Mirrors whitelist.js: a plain-text file in the
// project root (one keyword/phrase per line, `#` comments), loaded once and
// reloaded on save via fs.watch (debounced) — no restart needed.
//
// Matching is case-insensitive substring by default. A line wrapped in slashes
// (/.../ or /.../i) is treated as a regular expression, for power users.
import fs from 'node:fs';
import path from 'node:path';

const FILE = path.resolve('watchlist.txt');
let terms = []; // [{ raw, test(body) -> bool }]
let reloadTimer = null;

function compile(entry) {
  const e = entry.trim();
  if (!e) return null;
  const re = e.match(/^\/(.+)\/(i?)$/);
  if (re) {
    try {
      const rx = new RegExp(re[1], re[2] || '');
      return { raw: e, test: (body) => rx.test(body) };
    } catch {
      return null; // invalid regex — skip rather than crash
    }
  }
  const needle = e.toLowerCase();
  return { raw: e, test: (body) => body.toLowerCase().includes(needle) };
}

function load() {
  const next = [];
  if (fs.existsSync(FILE)) {
    for (const raw of fs.readFileSync(FILE, 'utf8').split(/\r?\n/)) {
      const beforeComment = raw.split('#')[0];
      const t = compile(beforeComment);
      if (t) next.push(t);
    }
  }
  terms = next;
}

load();

try {
  fs.watch(path.dirname(FILE), { persistent: false }, (_event, filename) => {
    if (filename !== path.basename(FILE)) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, 100);
  });
} catch {
  // fs.watch unsupported on some filesystems — silently skip; restart to reload
}

export function watchEnabled() {
  return terms.length > 0;
}

// Return the list of watchlist terms a message body matches (empty = no match).
export function matchKeywords(body) {
  if (!body || !terms.length) return [];
  return terms.filter((t) => t.test(body)).map((t) => t.raw);
}

export function listKeywords() {
  return terms.map((t) => t.raw);
}

export function watchlistPath() {
  return FILE;
}
