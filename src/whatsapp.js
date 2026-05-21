import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import path from 'node:path';
import fs from 'node:fs';
import { saveMessage, updateChatName, upsertContact } from './store.js';

const AUTH_DIR = path.resolve('auth_data');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? 'warn' });

let sock = null;
let connected = false;
let currentQR = null;

function isIgnoredJid(jid) {
  return !jid || jid.endsWith('@newsletter') || jid === 'status@broadcast';
}

function extractBody(message) {
  let m = message?.message;
  if (!m) return { body: '', type: 'unknown' };

  // unwrap wrappers (ephemeral / view-once / edited / document-with-caption)
  for (let i = 0; i < 3; i++) {
    if (m.ephemeralMessage?.message) { m = m.ephemeralMessage.message; continue; }
    if (m.viewOnceMessage?.message) { m = m.viewOnceMessage.message; continue; }
    if (m.viewOnceMessageV2?.message) { m = m.viewOnceMessageV2.message; continue; }
    if (m.editedMessage?.message) { m = m.editedMessage.message; continue; }
    if (m.documentWithCaptionMessage?.message) { m = m.documentWithCaptionMessage.message; continue; }
    break;
  }

  if (m.conversation) return { body: m.conversation, type: 'text' };
  if (m.extendedTextMessage?.text) return { body: m.extendedTextMessage.text, type: 'text' };
  if (m.imageMessage) return { body: m.imageMessage.caption ?? '[image]', type: 'image' };
  if (m.videoMessage) return { body: m.videoMessage.caption ?? '[video]', type: 'video' };
  if (m.audioMessage) return { body: '[audio]', type: 'audio' };
  if (m.documentMessage) return { body: m.documentMessage.caption ?? m.documentMessage.fileName ?? '[document]', type: 'document' };
  if (m.stickerMessage) return { body: '[sticker]', type: 'sticker' };
  if (m.reactionMessage) return { body: m.reactionMessage.text ?? '', type: 'reaction' };
  if (m.locationMessage) {
    const lm = m.locationMessage;
    const tag = lm.name ? ` ${lm.name}` : '';
    return { body: `[location ${lm.degreesLatitude},${lm.degreesLongitude}]${tag}`, type: 'location' };
  }
  if (m.liveLocationMessage) return { body: '[live location]', type: 'location' };
  if (m.contactMessage) return { body: `[contact] ${m.contactMessage.displayName ?? ''}`.trim(), type: 'contact' };
  if (m.contactsArrayMessage) return { body: `[contacts: ${m.contactsArrayMessage.contacts?.length ?? 0}]`, type: 'contact' };

  // Cloud API interactive types
  if (m.buttonsMessage) {
    const b = m.buttonsMessage;
    const text = b.contentText ?? b.headerText ?? '';
    const labels = (b.buttons ?? []).map((x) => x.buttonText?.displayText).filter(Boolean);
    const buttonsTag = labels.length ? ` [buttons: ${labels.join(' | ')}]` : ' [buttons]';
    return { body: `${text}${buttonsTag}`.trim(), type: 'buttons' };
  }
  if (m.buttonsResponseMessage) {
    const r = m.buttonsResponseMessage;
    return { body: r.selectedDisplayText ?? r.selectedButtonId ?? '[button click]', type: 'buttonsResponse' };
  }
  if (m.listMessage) {
    const l = m.listMessage;
    return { body: l.description ?? l.title ?? '[list]', type: 'list' };
  }
  if (m.listResponseMessage) {
    const r = m.listResponseMessage;
    return { body: r.title ?? r.singleSelectReply?.selectedRowId ?? '[list selection]', type: 'listResponse' };
  }
  if (m.templateMessage) {
    const t = m.templateMessage.hydratedTemplate ?? m.templateMessage.fourRowTemplate ?? {};
    return { body: t.hydratedContentText ?? t.hydratedTitleText ?? '[template]', type: 'template' };
  }
  if (m.templateButtonReplyMessage) {
    const r = m.templateButtonReplyMessage;
    return { body: r.selectedDisplayText ?? r.selectedId ?? '[template reply]', type: 'templateReply' };
  }
  if (m.interactiveMessage) {
    const i = m.interactiveMessage;
    return { body: i.body?.text ?? i.header?.title ?? '[interactive]', type: 'interactive' };
  }
  if (m.interactiveResponseMessage) {
    const r = m.interactiveResponseMessage;
    return { body: r.body?.text ?? '[interactive reply]', type: 'interactiveResponse' };
  }

  // polls
  if (m.pollCreationMessage) {
    const p = m.pollCreationMessage;
    return { body: `[poll] ${p.name ?? ''}`.trim(), type: 'poll' };
  }
  if (m.pollUpdateMessage) return { body: '[poll vote]', type: 'pollUpdate' };

  // protocol/system — intentionally empty body, kept for trace
  if (m.protocolMessage) return { body: '', type: 'protocolMessage' };
  if (m.senderKeyDistributionMessage) return { body: '', type: 'senderKeyDistribution' };

  return { body: '', type: Object.keys(m)[0] ?? 'unknown' };
}

export async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: baileysLogger,
    browser: ['whatsapp-bridge', 'Chrome', '1.0.0'],
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      currentQR = qr;
      console.log('\nScan the QR below with WhatsApp > Linked Devices:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      connected = true;
      currentQR = null;
      console.log('WhatsApp connection open');
    }
    if (connection === 'close') {
      connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.warn(`Connection closed (code ${code}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) setTimeout(() => startWhatsApp().catch((e) => console.error(e)), 2000);
      else console.error('Logged out. Delete auth_data/ and restart to re-pair.');
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify' && type !== 'append') return;
    for (const message of messages) {
      const chatId = message.key?.remoteJid;
      if (!message.key?.id || isIgnoredJid(chatId)) continue;
      const isGroup = chatId.endsWith('@g.us');
      const fromMe = !!message.key.fromMe;
      const senderJid = isGroup ? message.key.participant : chatId;
      const ts = Number(message.messageTimestamp) * 1000;
      const { body, type: msgType } = extractBody(message);

      saveMessage({
        id: message.key.id,
        chatId,
        sender: senderJid ?? chatId,
        body,
        timestamp: ts,
        fromMe,
        type: msgType,
        // pushName is the *sender*'s display name. Skip when fromMe (it's *our*
        // name, would pollute the chat's name) and for groups (would overwrite
        // the real group title).
        chatName: (isGroup || fromMe) ? null : (message.pushName ?? null),
      });

      if (!fromMe && senderJid && message.pushName) {
        upsertContact({ jid: senderJid, pushName: message.pushName, lastSeenAt: ts });
      }
    }
  });

  sock.ev.on('contacts.update', (updates) => {
    for (const u of updates) {
      if (isIgnoredJid(u.id)) continue;
      // notify = display name from the user's address book; name = verified business name
      upsertContact({ jid: u.id, notifyName: u.notify ?? null, verifiedName: u.name ?? null });
      if (!u.id.endsWith('@g.us') && (u.name || u.notify)) {
        updateChatName(u.id, u.name ?? u.notify);
      }
    }
  });

  sock.ev.on('chats.upsert', (chats) => {
    for (const c of chats) {
      if (isIgnoredJid(c.id)) continue;
      if (c.name) updateChatName(c.id, c.name);
    }
  });

  return sock;
}

export function status() {
  return { connected, hasQR: !!currentQR };
}

export function getQR() {
  return currentQR;
}

export async function sendText(chatId, text) {
  if (!sock || !connected) throw new Error('not connected');
  await sock.sendMessage(chatId, { text });
}
