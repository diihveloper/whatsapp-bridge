import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..', 'skill', 'whatsapp-assistant');
const DST_ROOT = path.join(os.homedir(), '.claude', 'skills');
const DST = path.join(DST_ROOT, 'whatsapp-assistant');

if (!fs.existsSync(SRC)) {
  console.error(`source skill folder not found at ${SRC}`);
  process.exit(1);
}

fs.mkdirSync(DST_ROOT, { recursive: true });

if (fs.existsSync(DST)) fs.rmSync(DST, { recursive: true, force: true });
fs.cpSync(SRC, DST, { recursive: true });

console.log(`installed skill to ${DST}`);
console.log('Restart Claude Code (or start a new session) to pick it up.');
