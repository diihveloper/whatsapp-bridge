import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'messages.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    name TEXT,
    is_group INTEGER NOT NULL DEFAULT 0,
    last_message_at INTEGER,
    unread INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    sender TEXT,
    body TEXT,
    timestamp INTEGER NOT NULL,
    from_me INTEGER NOT NULL DEFAULT 0,
    type TEXT,
    FOREIGN KEY (chat_id) REFERENCES chats(id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_chat_ts
    ON messages(chat_id, timestamp DESC);

  CREATE INDEX IF NOT EXISTS idx_messages_ts
    ON messages(timestamp DESC);

  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
    USING fts5(body, content='messages', content_rowid='rowid');

  CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, body) VALUES (new.rowid, new.body);
  END;

  CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, body) VALUES('delete', old.rowid, old.body);
  END;

  CREATE TABLE IF NOT EXISTS contacts (
    jid TEXT PRIMARY KEY,
    push_name TEXT,
    notify_name TEXT,
    verified_name TEXT,
    last_seen_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_contacts_last_seen
    ON contacts(last_seen_at DESC);

  -- Outbound send queue. With the extension bridge the WhatsApp connection lives
  -- in the browser, not here, so the server can't push directly: it enqueues and
  -- the extension drains this table via GET /outbound.
  CREATE TABLE IF NOT EXISTS outbound (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     TEXT NOT NULL,
    text        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending', -- pending | sending | sent | error
    error       TEXT,
    wa_msg_id   TEXT,
    created_at  INTEGER NOT NULL,
    claimed_at  INTEGER,
    updated_at  INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_outbound_status
    ON outbound(status, id);
`);

db.prepare(`
  INSERT OR IGNORE INTO contacts (jid, push_name, last_seen_at)
  SELECT id, name, last_message_at FROM chats
  WHERE is_group = 0 AND name IS NOT NULL
`).run();

const upsertChatStmt = db.prepare(`
  INSERT INTO chats (id, name, is_group, last_message_at, unread)
  VALUES (@id, @name, @isGroup, @lastMessageAt, @unread)
  ON CONFLICT(id) DO UPDATE SET
    name = COALESCE(excluded.name, chats.name),
    is_group = excluded.is_group,
    last_message_at = MAX(COALESCE(chats.last_message_at, 0), excluded.last_message_at),
    unread = excluded.unread
`);

const insertMessageStmt = db.prepare(`
  INSERT OR IGNORE INTO messages (id, chat_id, sender, body, timestamp, from_me, type)
  VALUES (@id, @chatId, @sender, @body, @timestamp, @fromMe, @type)
`);

const saveMessageTx = db.transaction((msg) => {
  upsertChatStmt.run({
    id: msg.chatId,
    name: msg.chatName ?? null,
    isGroup: msg.chatId.endsWith('@g.us') ? 1 : 0,
    lastMessageAt: msg.timestamp,
    unread: msg.fromMe ? 0 : 1,
  });
  insertMessageStmt.run({
    id: msg.id,
    chatId: msg.chatId,
    sender: msg.sender ?? null,
    body: msg.body ?? '',
    timestamp: msg.timestamp,
    fromMe: msg.fromMe ? 1 : 0,
    type: msg.type ?? null,
  });
});

export function saveMessage(msg) {
  saveMessageTx(msg);
}

export function updateChatName(chatId, name) {
  upsertChatStmt.run({
    id: chatId,
    name,
    isGroup: chatId.endsWith('@g.us') ? 1 : 0,
    lastMessageAt: 0,
    unread: 0,
  });
}

export function markChatRead(chatId) {
  db.prepare('UPDATE chats SET unread = 0 WHERE id = ?').run(chatId);
}

export function listChats({ limit = 20, onlyUnread = false } = {}) {
  const where = onlyUnread ? 'WHERE unread > 0' : '';
  return db.prepare(`
    SELECT id, name, is_group AS isGroup, last_message_at AS lastMessageAt, unread
    FROM chats
    ${where}
    ORDER BY last_message_at DESC NULLS LAST
    LIMIT ?
  `).all(limit);
}

export function getMessages(chatId, { limit = 50, since } = {}) {
  const params = [chatId];
  let sinceClause = '';
  if (since) {
    sinceClause = 'AND timestamp >= ?';
    params.push(since);
  }
  params.push(limit);
  return db.prepare(`
    SELECT id, chat_id AS chatId, sender, body, timestamp, from_me AS fromMe, type
    FROM messages
    WHERE chat_id = ? ${sinceClause}
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(...params).reverse();
}

export function searchMessages(query, { limit = 20 } = {}) {
  return db.prepare(`
    SELECT m.id, m.chat_id AS chatId, c.name AS chatName, m.sender, m.body,
           m.timestamp, m.from_me AS fromMe
    FROM messages_fts f
    JOIN messages m ON m.rowid = f.rowid
    LEFT JOIN chats c ON c.id = m.chat_id
    WHERE messages_fts MATCH ?
    ORDER BY m.timestamp DESC
    LIMIT ?
  `).all(query, limit);
}

export function stats() {
  const msg = db.prepare('SELECT COUNT(*) AS n FROM messages').get();
  const chat = db.prepare('SELECT COUNT(*) AS n FROM chats').get();
  const contact = db.prepare('SELECT COUNT(*) AS n FROM contacts').get();
  return { messages: msg.n, chats: chat.n, contacts: contact.n };
}

const upsertContactStmt = db.prepare(`
  INSERT INTO contacts (jid, push_name, notify_name, verified_name, last_seen_at)
  VALUES (@jid, @pushName, @notifyName, @verifiedName, @lastSeenAt)
  ON CONFLICT(jid) DO UPDATE SET
    push_name     = COALESCE(excluded.push_name, contacts.push_name),
    notify_name   = COALESCE(excluded.notify_name, contacts.notify_name),
    verified_name = COALESCE(excluded.verified_name, contacts.verified_name),
    last_seen_at  = MAX(COALESCE(contacts.last_seen_at, 0), COALESCE(excluded.last_seen_at, 0))
`);

export function upsertContact({ jid, pushName, notifyName, verifiedName, lastSeenAt }) {
  if (!jid) return;
  upsertContactStmt.run({
    jid,
    pushName: pushName ?? null,
    notifyName: notifyName ?? null,
    verifiedName: verifiedName ?? null,
    lastSeenAt: lastSeenAt ?? null,
  });
}

export function searchContacts(query, { limit = 20 } = {}) {
  const like = `%${String(query).toLowerCase()}%`;
  return db.prepare(`
    SELECT c.jid,
           COALESCE(c.verified_name, c.notify_name, c.push_name) AS name,
           c.push_name     AS pushName,
           c.notify_name   AS notifyName,
           c.verified_name AS verifiedName,
           c.last_seen_at  AS lastSeenAt,
           CASE WHEN EXISTS (
             SELECT 1 FROM chats
             WHERE chats.id = c.jid AND chats.is_group = 0
           ) THEN 1 ELSE 0 END AS hasDm
    FROM contacts c
    WHERE lower(COALESCE(c.push_name, ''))     LIKE ?
       OR lower(COALESCE(c.notify_name, ''))   LIKE ?
       OR lower(COALESCE(c.verified_name, '')) LIKE ?
    ORDER BY c.last_seen_at DESC NULLS LAST
    LIMIT ?
  `).all(like, like, like, limit);
}

const enqueueSendStmt = db.prepare(`
  INSERT INTO outbound (chat_id, text, created_at) VALUES (@chatId, @text, @now)
`);

export function enqueueSend({ chatId, text }) {
  const info = enqueueSendStmt.run({ chatId, text, now: Date.now() });
  return Number(info.lastInsertRowid);
}

// Atomically hand pending rows to the extension and mark them 'sending', so two
// concurrent polls never claim the same send. Stale 'sending' rows (extension
// crashed mid-send) are re-eligible after staleMs.
const claimPendingTx = db.transaction((limit, staleMs) => {
  const cutoff = Date.now() - staleMs;
  const rows = db.prepare(`
    SELECT id, chat_id AS chatId, text FROM outbound
    WHERE status = 'pending'
       OR (status = 'sending' AND COALESCE(claimed_at, 0) < ?)
    ORDER BY id ASC
    LIMIT ?
  `).all(cutoff, limit);
  const mark = db.prepare(`UPDATE outbound SET status = 'sending', claimed_at = ? WHERE id = ?`);
  const now = Date.now();
  for (const r of rows) mark.run(now, r.id);
  return rows;
});

export function claimPending({ limit = 20, staleMs = 60_000 } = {}) {
  return claimPendingTx(limit, staleMs);
}

const markSendResultStmt = db.prepare(`
  UPDATE outbound
  SET status = @status, error = @error, wa_msg_id = @waMsgId, updated_at = @now
  WHERE id = @id
`);

export function markSendResult(id, { ok, error = null, waMsgId = null } = {}) {
  markSendResultStmt.run({
    id,
    status: ok ? 'sent' : 'error',
    error: error ? String(error) : null,
    waMsgId,
    now: Date.now(),
  });
}

export function getSend(id) {
  return db.prepare(`
    SELECT id, chat_id AS chatId, text, status, error, wa_msg_id AS waMsgId,
           created_at AS createdAt, updated_at AS updatedAt
    FROM outbound WHERE id = ?
  `).get(id);
}

export function getContact(jid) {
  return db.prepare(`
    SELECT jid,
           COALESCE(verified_name, notify_name, push_name) AS name,
           push_name AS pushName, notify_name AS notifyName, verified_name AS verifiedName,
           last_seen_at AS lastSeenAt
    FROM contacts WHERE jid = ?
  `).get(jid);
}
