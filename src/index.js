import 'dotenv/config';
import { loadOrCreateConfig, writeRuntimeInfo, configPath } from './config.js';
import { startWhatsApp } from './whatsapp.js';
import { createServer } from './server.js';
import { listAllowed, whitelistPath } from './whitelist.js';

const PORT = Number(process.env.PORT ?? 4477);
const HOST = process.env.HOST ?? '127.0.0.1';
const sendEnabled = process.env.ENABLE_SEND === 'true';
// 'extension' (default) = the WhatsApp connection lives in a browser tab via the
// Chrome extension, which feeds /ingest and drains /outbound; no Baileys device
// (lower ban risk). 'baileys' = built-in socket; opt in explicitly.
const mode = process.env.BRIDGE_MODE === 'baileys' ? 'baileys' : 'extension';
// Optional prefix prepended to outbound text/caption so recipients can tell
// the message was sent by an agent/skill/automation rather than a human. Empty
// = off (default). Trailing space is preserved exactly as written in .env.
const agentPrefix = process.env.SEND_AGENT_PREFIX ?? '';

const config = loadOrCreateConfig();
writeRuntimeInfo({ baseUrl: `http://${HOST}:${PORT}`, sendEnabled });

console.log('whatsapp-bridge starting');
console.log(`  config file: ${configPath()}`);
console.log(`  http:        http://${HOST}:${PORT}`);
console.log(`  mode:        ${mode}${mode === 'extension' ? ' (no Baileys device — feed via Chrome extension)' : ''}`);
console.log(`  send:        ${sendEnabled ? 'ENABLED' : 'disabled (read-only)'}`);
if (sendEnabled) {
  const n = listAllowed().length;
  const tail = n === 0 ? ` — sends will be rejected until you add entries to ${whitelistPath()}` : '';
  console.log(`  whitelist:   ${n} chat(s) allowed${tail}`);
  if (agentPrefix) console.log(`  agent tag:   outbound text prefixed with ${JSON.stringify(agentPrefix)}`);
}

if (mode === 'baileys') {
  await startWhatsApp();
} else {
  console.log('  extension mode: waiting for the WhatsApp Web tab to push messages to /ingest');
}

const app = createServer({ apiToken: config.apiToken, sendEnabled, mode, agentPrefix });
app.listen(PORT, HOST, () => {
  console.log(`HTTP listening on http://${HOST}:${PORT}`);
});
