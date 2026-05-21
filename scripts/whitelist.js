import fs from 'node:fs';
import path from 'node:path';
import { checkbox, confirm } from '@inquirer/prompts';
import Database from 'better-sqlite3';

const DB_PATH = path.resolve('data', 'messages.db');
const WL_PATH = path.resolve('send_whitelist.txt');

function fail(msg) {
  console.error(`\n${msg}\n`);
  process.exit(1);
}

if (!fs.existsSync(DB_PATH)) {
  fail('Banco de chats ainda não existe.\nRode `npm start`, escaneie o QR, e troque algumas mensagens primeiro — só aí os chats ficam disponíveis aqui.');
}

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
const chats = db.prepare(`
  SELECT id, name, is_group AS isGroup, last_message_at AS lastMessageAt, unread
  FROM chats
  ORDER BY last_message_at DESC NULLS LAST
`).all();
db.close();

if (chats.length === 0) {
  fail('Nenhum chat registrado ainda no banco.\nPareie a sessão, troque algumas mensagens (ou só receba), e rode esse comando de novo.');
}

function normalize(entry) {
  const e = String(entry).trim();
  if (!e) return null;
  if (e.includes('@')) return e.toLowerCase();
  const digits = e.replace(/\D/g, '');
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
}

function loadCurrent() {
  if (!fs.existsSync(WL_PATH)) return { raw: '', set: new Set() };
  const raw = fs.readFileSync(WL_PATH, 'utf8');
  const set = new Set();
  for (const line of raw.split(/\r?\n/)) {
    const n = normalize(line.split('#')[0]);
    if (n) set.add(n);
  }
  return { raw, set };
}

const current = loadCurrent();

function label(chat) {
  const tag = chat.isGroup ? '[grupo]' : '[dm]   ';
  const fallback = chat.isGroup ? '(grupo sem nome)' : '(sem nome)';
  const name = (chat.name || fallback).slice(0, 38).padEnd(38);
  return `${tag} ${name}  ${chat.id}`;
}

console.log('');
console.log(`Whitelist atual:  ${current.set.size} chat(s) liberado(s)`);
console.log(`Arquivo:          ${WL_PATH}`);
console.log(`Chats no banco:   ${chats.length}`);
console.log('');
console.log('Use as setas para navegar, ESPAÇO para marcar/desmarcar, ENTER para confirmar.');
console.log('Ctrl+C cancela sem salvar.');
console.log('');

let selected;
try {
  selected = await checkbox({
    message: 'Chats permitidos para envio:',
    pageSize: 20,
    loop: false,
    choices: chats.map((c) => ({
      name: label(c),
      value: c.id.toLowerCase(),
      checked: current.set.has(c.id.toLowerCase()),
    })),
  });
} catch {
  console.log('\nCancelado. Nada foi alterado.');
  process.exit(0);
}

const desired = new Set(selected);
const knownIds = new Map(chats.map((c) => [c.id.toLowerCase(), c]));

const toAdd = [];
const toRemove = new Set();
for (const [id, chat] of knownIds) {
  const inWl = current.set.has(id);
  const inSel = desired.has(id);
  if (inSel && !inWl) toAdd.push({ jid: chat.id, name: chat.name || (chat.isGroup ? 'grupo' : 'contato') });
  else if (!inSel && inWl) toRemove.add(id);
}

if (toAdd.length === 0 && toRemove.size === 0) {
  console.log('\nNenhuma mudança. Whitelist permanece como estava.');
  process.exit(0);
}

console.log('\nMudanças:');
for (const { jid, name } of toAdd) console.log(`  + ${name.slice(0, 35).padEnd(35)}  ${jid}`);
for (const id of toRemove)         console.log(`  - ${id}`);

let go = false;
try {
  go = await confirm({ message: 'Aplicar mudanças?', default: true });
} catch {
  go = false;
}
if (!go) {
  console.log('Cancelado.');
  process.exit(0);
}

let output;
if (current.raw) {
  const out = [];
  for (const raw of current.raw.split(/\r?\n/)) {
    const n = normalize(raw.split('#')[0]);
    if (n && toRemove.has(n)) continue;
    out.push(raw);
  }
  output = out.join('\n');
  if (output && !output.endsWith('\n')) output += '\n';
} else {
  output = '# WhatsApp send whitelist\n# Gerenciada por `npm run wl` ou edição manual. Recarrega ao salvar.\n\n';
}

if (toAdd.length) {
  if (output && !output.endsWith('\n\n')) output += '\n';
  output += `# adicionados em ${new Date().toISOString().slice(0, 10)}\n`;
  for (const { jid, name } of toAdd) output += `${jid}    # ${name}\n`;
}

fs.writeFileSync(WL_PATH, output);
console.log(`\nGravado em ${WL_PATH}.`);
console.log('Se o serviço estiver rodando, a mudança já foi aplicada (file watcher recarrega).');
