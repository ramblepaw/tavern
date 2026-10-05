import crypto from 'node:crypto';
import express from 'express';
import { config } from './config.js';
import { db, tx, userCount, isMember, memberIds } from './db.js';
import {
  hashPassword, verifyPassword, createSession, destroySession, destroyOtherSessions,
  setSessionCookie, clearSessionCookie, requireAuth, requireAdmin, rateLimit,
} from './auth.js';
import { upload, processAvatar, processChatImage, deleteMedia, HttpError } from './media.js';
import { toChat, toUsers } from './realtime.js';
import { publicKey, validEndpoint, saveSubscription, removeSubscription, notifyMessage, notifyTest } from './push.js';

export const api = express.Router();

// ---------------------------------------------------------------- helpers

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,24}$/;

const clean = (v, max) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').trim().slice(0, max) : '');
const toId = (v) => (/^\d+$/.test(String(v)) ? Number(v) : NaN);

function color(v, fallback) {
  return typeof v === 'string' && COLOR_RE.test(v) ? v.toLowerCase() : fallback;
}

const pubUser = (u) => ({
  id: u.id, username: u.username, displayName: u.display_name, bio: u.bio,
  pronouns: u.pronouns, avatar: u.avatar, color: u.color,
});
const meUser = (u) => ({ ...pubUser(u), isAdmin: !!u.is_admin });
const pubChar = (c) => ({ id: c.id, userId: c.user_id, name: c.name, bio: c.bio, avatar: c.avatar, color: c.color });

function parseImages(json) {
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

const MSG_SELECT = `
  SELECT m.*, u.username, u.display_name, u.avatar AS user_avatar, u.color AS user_color
  FROM messages m JOIN users u ON u.id = m.user_id`;

function serializeMessage(r) {
  return {
    id: r.id,
    chatId: r.chat_id,
    body: r.body,
    images: parseImages(r.images),
    createdAt: r.created_at,
    editedAt: r.edited_at,
    author: {
      id: r.user_id, username: r.username, displayName: r.display_name,
      avatar: r.user_avatar, color: r.user_color,
    },
    character: r.char_name ? { name: r.char_name, avatar: r.char_avatar, color: r.char_color } : null,
  };
}

function getMessage(id) {
  const row = db.prepare(`${MSG_SELECT} WHERE m.id = ?`).get(id);
  return row ? serializeMessage(row) : null;
}

function chatSummary(chatId, userId) {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  if (!chat) return null;
  const members = db
    .prepare(
      `SELECT u.id, u.username, u.display_name, u.avatar, u.color FROM chat_members cm
       JOIN users u ON u.id = cm.user_id WHERE cm.chat_id = ? ORDER BY cm.joined_at, u.id`,
    )
    .all(chatId)
    .map((u) => ({ id: u.id, username: u.username, displayName: u.display_name, avatar: u.avatar, color: u.color }));
  const mine = db.prepare('SELECT last_read_id FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId);
  const unread = db
    .prepare('SELECT COUNT(*) AS c FROM messages WHERE chat_id = ? AND id > ? AND user_id != ?')
    .get(chatId, mine?.last_read_id ?? 0, userId).c;
  const last = db
    .prepare(
      `SELECT m.id, m.body, m.images, m.created_at, m.char_name, u.display_name FROM messages m
       JOIN users u ON u.id = m.user_id WHERE m.chat_id = ? ORDER BY m.id DESC LIMIT 1`,
    )
    .get(chatId);
  return {
    id: chat.id,
    name: chat.name,
    description: chat.description,
    isDm: !!chat.is_dm,
    ownerId: chat.owner_id,
    createdAt: chat.created_at,
    updatedAt: chat.updated_at,
    members,
    unread,
    last: last
      ? {
          id: last.id,
          author: last.char_name || last.display_name,
          text: last.body.slice(0, 200),
          hasImage: parseImages(last.images).length > 0,
          createdAt: last.created_at,
        }
      : null,
  };
}

function usersByNames(names) {
  const found = [];
  for (const raw of names) {
    const name = clean(raw, 40).replace(/^@/, '');
    if (!name) continue;
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(name);
    if (!u) throw new HttpError(404, `There's no user named "${name}".`);
    found.push(u);
  }
  return found;
}

/** Delete an avatar file once nothing references it any more. */
async function releaseAvatar(file) {
  if (!file) return;
  const used =
    db.prepare('SELECT 1 FROM users WHERE avatar = ?').get(file) ||
    db.prepare('SELECT 1 FROM characters WHERE avatar = ?').get(file) ||
    db.prepare('SELECT 1 FROM messages WHERE char_avatar = ?').get(file);
  if (!used) await deleteMedia([file]);
}

function chatImageFiles(chatId) {
  return db
    .prepare('SELECT images FROM messages WHERE chat_id = ?')
    .all(chatId)
    .flatMap((r) => parseImages(r.images).map((i) => i.file));
}

async function destroyChat(chatId) {
  const files = chatImageFiles(chatId);
  db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
  await deleteMedia(files);
}

function chatParam(req, res, next) {
  const id = toId(req.params.id);
  if (!Number.isInteger(id) || !isMember(id, req.user.id)) return res.status(404).json({ error: 'Chat not found.' });
  req.chatId = id;
  req.chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  next();
}

const ownerOnly = (req, res, next) =>
  req.chat.owner_id === req.user.id ? next() : res.status(403).json({ error: 'Only the chat owner can do that.' });

// ---------------------------------------------------------------- session & auth

api.get('/session', (req, res) => {
  res.json({
    user: req.user ? meUser(req.user) : null,
    needsSetup: userCount() === 0,
    openRegistration: config.openRegistration,
  });
});

const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: 20 });

api.post('/register', authLimiter, async (req, res) => {
  const username = clean(req.body.username, 24);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const displayName = clean(req.body.displayName, 32) || username;
  const inviteCode = clean(req.body.invite, 40).toLowerCase();

  if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Usernames are 3–24 letters, numbers, dots, dashes or underscores.');
  if (password.length < 8 || password.length > 200) throw new HttpError(400, 'Password must be at least 8 characters.');

  const first = userCount() === 0;
  const invite = !first && !config.openRegistration ? db.prepare('SELECT * FROM invites WHERE code = ? AND used_by IS NULL').get(inviteCode) : null;
  if (!first && !config.openRegistration && !invite) throw new HttpError(403, 'That invite code is invalid or already used.');

  const passwordHash = await hashPassword(password);
  const user = tx(() => {
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is taken.');
    const id = db
      .prepare('INSERT INTO users (username, password_hash, display_name, is_admin, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(username, passwordHash, displayName, first ? 1 : 0, Date.now()).lastInsertRowid;
    if (invite) db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?').run(id, Date.now(), invite.code);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  });

  setSessionCookie(req, res, createSession(user.id));
  res.json({ user: meUser(user) });
});

api.post('/login', authLimiter, async (req, res) => {
  const username = clean(req.body.username, 24);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    throw new HttpError(401, 'Wrong username or password.');
  }
  setSessionCookie(req, res, createSession(user.id));
  res.json({ user: meUser(user) });
});

api.post('/logout', (req, res) => {
  destroySession(req.token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Everything below needs a signed-in user.
api.use(requireAuth);

// ---------------------------------------------------------------- my profile

api.patch('/me', upload.single('avatar'), async (req, res) => {
  const u = req.user;
  const displayName = clean(req.body.displayName, 32) || u.display_name;
  const bio = req.body.bio === undefined ? u.bio : clean(req.body.bio, 1000);
  const pronouns = req.body.pronouns === undefined ? u.pronouns : clean(req.body.pronouns, 40);
  const col = color(req.body.color, u.color);
  let avatar = u.avatar;
  if (req.file) avatar = await processAvatar(req.file.buffer);
  else if (req.body.removeAvatar === '1') avatar = null;

  db.prepare('UPDATE users SET display_name = ?, bio = ?, pronouns = ?, color = ?, avatar = ? WHERE id = ?')
    .run(displayName, bio, pronouns, col, avatar, u.id);
  if (avatar !== u.avatar) await releaseAvatar(u.avatar);

  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
  res.json({ user: meUser(fresh) });
});

api.post('/me/password', rateLimit({ windowMs: 15 * 60_000, max: 10 }), async (req, res) => {
  const next = typeof req.body.next === 'string' ? req.body.next : '';
  if (!(await verifyPassword(String(req.body.current ?? ''), req.user.password_hash))) throw new HttpError(403, 'Current password is wrong.');
  if (next.length < 8 || next.length > 200) throw new HttpError(400, 'New password must be at least 8 characters.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(next), req.user.id);
  destroyOtherSessions(req.user.id, req.token);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- users

api.get('/users', (req, res) => {
  const q = clean(req.query.q, 40).replace(/^@/, '').replace(/[\\%_]/g, '\\$&');
  if (!q) return res.json({ users: [] });
  const rows = db
    .prepare(
      `SELECT * FROM users WHERE id != ? AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
       ORDER BY username LIMIT 12`,
    )
    .all(req.user.id, `${q}%`, `%${q}%`);
  res.json({ users: rows.map(pubUser) });
});

api.get('/users/:id', (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(toId(req.params.id));
  if (!u) throw new HttpError(404, 'User not found.');
  const characters = db.prepare('SELECT * FROM characters WHERE user_id = ? ORDER BY name COLLATE NOCASE').all(u.id);
  res.json({ user: pubUser(u), characters: characters.map(pubChar) });
});

// ---------------------------------------------------------------- characters

api.get('/characters', (req, res) => {
  const rows = db.prepare('SELECT * FROM characters WHERE user_id = ? ORDER BY name COLLATE NOCASE').all(req.user.id);
  res.json({ characters: rows.map(pubChar) });
});

api.post('/characters', upload.single('avatar'), async (req, res) => {
  const name = clean(req.body.name, 40);
  if (!name) throw new HttpError(400, 'Your character needs a name.');
  if (db.prepare('SELECT COUNT(*) AS c FROM characters WHERE user_id = ?').get(req.user.id).c >= 100) {
    throw new HttpError(400, 'That is a lot of characters! Delete some first.');
  }
  const avatar = req.file ? await processAvatar(req.file.buffer) : null;
  const id = db
    .prepare('INSERT INTO characters (user_id, name, bio, avatar, color, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, name, clean(req.body.bio, 1000), avatar, color(req.body.color, '#8b7cf6'), Date.now()).lastInsertRowid;
  res.json({ character: pubChar(db.prepare('SELECT * FROM characters WHERE id = ?').get(id)) });
});

api.patch('/characters/:id', upload.single('avatar'), async (req, res) => {
  const c = db.prepare('SELECT * FROM characters WHERE id = ? AND user_id = ?').get(toId(req.params.id), req.user.id);
  if (!c) throw new HttpError(404, 'Character not found.');
  let avatar = c.avatar;
  if (req.file) avatar = await processAvatar(req.file.buffer);
  else if (req.body.removeAvatar === '1') avatar = null;
  db.prepare('UPDATE characters SET name = ?, bio = ?, color = ?, avatar = ? WHERE id = ?').run(
    clean(req.body.name, 40) || c.name,
    req.body.bio === undefined ? c.bio : clean(req.body.bio, 1000),
    color(req.body.color, c.color),
    avatar,
    c.id,
  );
  if (avatar !== c.avatar) await releaseAvatar(c.avatar);
  res.json({ character: pubChar(db.prepare('SELECT * FROM characters WHERE id = ?').get(c.id)) });
});

api.delete('/characters/:id', async (req, res) => {
  const c = db.prepare('SELECT * FROM characters WHERE id = ? AND user_id = ?').get(toId(req.params.id), req.user.id);
  if (!c) throw new HttpError(404, 'Character not found.');
  db.prepare('DELETE FROM characters WHERE id = ?').run(c.id);
  await releaseAvatar(c.avatar);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- chats

api.get('/chats', (req, res) => {
  const ids = db
    .prepare('SELECT c.id FROM chats c JOIN chat_members cm ON cm.chat_id = c.id WHERE cm.user_id = ? ORDER BY c.updated_at DESC')
    .all(req.user.id);
  res.json({ chats: ids.map((r) => chatSummary(r.id, req.user.id)) });
});

api.post('/chats', (req, res) => {
  const name = clean(req.body.name, 60);
  const description = clean(req.body.description, 500);
  const names = Array.isArray(req.body.members) ? req.body.members.slice(0, 50) : [];
  const others = [...new Map(usersByNames(names).filter((u) => u.id !== req.user.id).map((u) => [u.id, u])).values()];
  if (!others.length) throw new HttpError(400, 'Add at least one other person.');

  const isDm = others.length === 1 && !name;
  if (!isDm && !name) throw new HttpError(400, 'Give your group chat a name.');

  if (isDm) {
    const existing = db
      .prepare(
        `SELECT c.id FROM chats c WHERE c.is_dm = 1
           AND (SELECT COUNT(*) FROM chat_members WHERE chat_id = c.id) = 2
           AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id = c.id AND user_id = ?)
           AND EXISTS (SELECT 1 FROM chat_members WHERE chat_id = c.id AND user_id = ?)`,
      )
      .get(req.user.id, others[0].id);
    if (existing) return res.json({ chat: chatSummary(existing.id, req.user.id) });
  }

  const now = Date.now();
  const chatId = tx(() => {
    const id = db
      .prepare('INSERT INTO chats (name, description, is_dm, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, description, isDm ? 1 : 0, req.user.id, now, now).lastInsertRowid;
    for (const u of [req.user, ...others]) {
      db.prepare('INSERT INTO chat_members (chat_id, user_id, joined_at) VALUES (?, ?, ?)').run(id, u.id, now);
    }
    return Number(id);
  });
  toUsers(others.map((u) => u.id), { type: 'chat:changed', chatId });
  res.json({ chat: chatSummary(chatId, req.user.id) });
});

api.get('/chats/:id', chatParam, (req, res) => {
  res.json({ chat: chatSummary(req.chatId, req.user.id) });
});

api.patch('/chats/:id', chatParam, ownerOnly, (req, res) => {
  const c = req.chat;
  if (c.is_dm) throw new HttpError(400, 'Direct messages cannot be renamed.');
  const name = req.body.name === undefined ? c.name : clean(req.body.name, 60);
  if (!name) throw new HttpError(400, 'Give your chat a name.');
  const description = req.body.description === undefined ? c.description : clean(req.body.description, 500);
  db.prepare('UPDATE chats SET name = ?, description = ? WHERE id = ?').run(name, description, c.id);
  toChat(c.id, { type: 'chat:changed', chatId: c.id });
  res.json({ chat: chatSummary(c.id, req.user.id) });
});

api.post('/chats/:id/members', chatParam, ownerOnly, (req, res) => {
  if (req.chat.is_dm) throw new HttpError(400, "Direct messages can't have more people. Create a group chat instead.");
  const [user] = usersByNames([req.body.username]);
  if (!user) throw new HttpError(400, 'Who do you want to add?');
  if (!isMember(req.chatId, user.id)) {
    db.prepare('INSERT INTO chat_members (chat_id, user_id, joined_at, last_read_id) VALUES (?, ?, ?, ?)').run(
      req.chatId, user.id, Date.now(),
      db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages WHERE chat_id = ?').get(req.chatId).m,
    );
  }
  toChat(req.chatId, { type: 'chat:changed', chatId: req.chatId });
  res.json({ chat: chatSummary(req.chatId, req.user.id) });
});

api.delete('/chats/:id/members/:userId', chatParam, async (req, res) => {
  const targetId = toId(req.params.userId);
  const self = targetId === req.user.id;
  if (!self && req.chat.owner_id !== req.user.id) throw new HttpError(403, 'Only the chat owner can remove people.');
  if (!isMember(req.chatId, targetId)) throw new HttpError(404, 'They are not in this chat.');

  db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(req.chatId, targetId);
  const remaining = memberIds(req.chatId);
  toUsers([targetId], { type: 'chat:removed', chatId: req.chatId });

  if (!remaining.length) {
    await destroyChat(req.chatId);
  } else {
    if (req.chat.owner_id === targetId) {
      db.prepare('UPDATE chats SET owner_id = ? WHERE id = ?').run(
        db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? ORDER BY joined_at, user_id LIMIT 1').get(req.chatId).user_id,
        req.chatId,
      );
    }
    toUsers(remaining, { type: 'chat:changed', chatId: req.chatId });
  }
  res.json({ ok: true });
});

api.delete('/chats/:id', chatParam, ownerOnly, async (req, res) => {
  const members = memberIds(req.chatId);
  await destroyChat(req.chatId);
  toUsers(members, { type: 'chat:removed', chatId: req.chatId });
  res.json({ ok: true });
});

api.post('/chats/:id/read', chatParam, (req, res) => {
  db.prepare(
    `UPDATE chat_members SET last_read_id = (SELECT COALESCE(MAX(id), 0) FROM messages WHERE chat_id = ?)
     WHERE chat_id = ? AND user_id = ?`,
  ).run(req.chatId, req.chatId, req.user.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- messages

api.get('/chats/:id/messages', chatParam, (req, res) => {
  const after = toId(req.query.after);
  const before = toId(req.query.before);
  const around = toId(req.query.around);
  if (Number.isInteger(around)) {
    // A window centred on one message (used to jump to a search result).
    const older = db.prepare(`${MSG_SELECT} WHERE m.chat_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT 26`).all(req.chatId, around);
    const newer = db.prepare(`${MSG_SELECT} WHERE m.chat_id = ? AND m.id >= ? ORDER BY m.id LIMIT 27`).all(req.chatId, around);
    return res.json({
      messages: [...older.slice(0, 25).reverse(), ...newer.slice(0, 26)].map(serializeMessage),
      hasMore: older.length > 25,
      hasNewer: newer.length > 26,
    });
  }
  if (Number.isInteger(after)) {
    const rows = db.prepare(`${MSG_SELECT} WHERE m.chat_id = ? AND m.id > ? ORDER BY m.id LIMIT 200`).all(req.chatId, after);
    return res.json({ messages: rows.map(serializeMessage) });
  }
  const limit = Math.min(Math.max(toId(req.query.limit) || 50, 1), 100);
  const rows = Number.isInteger(before)
    ? db.prepare(`${MSG_SELECT} WHERE m.chat_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`).all(req.chatId, before, limit + 1)
    : db.prepare(`${MSG_SELECT} WHERE m.chat_id = ? ORDER BY m.id DESC LIMIT ?`).all(req.chatId, limit + 1);
  const hasMore = rows.length > limit;
  res.json({ messages: rows.slice(0, limit).reverse().map(serializeMessage), hasMore });
});

api.post('/chats/:id/messages', chatParam, upload.array('images', 4), async (req, res) => {
  const body = clean(req.body.body, config.maxMessageLength + 1);
  if (body.length > config.maxMessageLength) throw new HttpError(400, `Messages can be at most ${config.maxMessageLength} characters.`);
  const files = req.files || [];
  if (!body && !files.length) throw new HttpError(400, 'Write something or attach an image.');

  let character = null;
  if (req.body.characterId) {
    character = db.prepare('SELECT * FROM characters WHERE id = ? AND user_id = ?').get(toId(req.body.characterId), req.user.id);
    if (!character) throw new HttpError(400, 'That character no longer exists.');
  }

  const saved = [];
  try {
    for (const f of files) saved.push(await processChatImage(f.buffer));
  } catch (err) {
    await deleteMedia(saved.map((s) => s.file));
    throw err;
  }

  const now = Date.now();
  const id = tx(() => {
    const msgId = db
      .prepare(
        `INSERT INTO messages (chat_id, user_id, char_name, char_avatar, char_color, body, images, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        req.chatId, req.user.id, character?.name ?? null, character?.avatar ?? null, character?.color ?? null,
        body, JSON.stringify(saved), now,
      ).lastInsertRowid;
    db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(now, req.chatId);
    db.prepare('UPDATE chat_members SET last_read_id = ? WHERE chat_id = ? AND user_id = ?').run(msgId, req.chatId, req.user.id);
    return Number(msgId);
  });

  const message = getMessage(id);
  toChat(req.chatId, { type: 'message:new', message });
  notifyMessage(message);
  res.json({ message });
});

function ownMessage(req) {
  const m = db.prepare('SELECT m.*, c.owner_id FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.id = ?').get(toId(req.params.id));
  if (!m || !isMember(m.chat_id, req.user.id)) throw new HttpError(404, 'Message not found.');
  return m;
}

api.patch('/messages/:id', (req, res) => {
  const m = ownMessage(req);
  if (m.user_id !== req.user.id) throw new HttpError(403, 'You can only edit your own messages.');
  const body = clean(req.body.body, config.maxMessageLength + 1);
  if (body.length > config.maxMessageLength) throw new HttpError(400, `Messages can be at most ${config.maxMessageLength} characters.`);
  if (!body && parseImages(m.images).length === 0) throw new HttpError(400, 'A message cannot be empty.');
  db.prepare('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?').run(body, Date.now(), m.id);
  const message = getMessage(m.id);
  toChat(m.chat_id, { type: 'message:edit', message });
  res.json({ message });
});

api.delete('/messages/:id', async (req, res) => {
  const m = ownMessage(req);
  if (m.user_id !== req.user.id && m.owner_id !== req.user.id) throw new HttpError(403, "You can't delete that message.");
  db.prepare('DELETE FROM messages WHERE id = ?').run(m.id);
  await deleteMedia(parseImages(m.images).map((i) => i.file));
  toChat(m.chat_id, { type: 'message:delete', chatId: m.chat_id, id: m.id });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- search

// Matches the start of each word you type, in any chat you belong to (or just one chat with ?chat=ID).
// Highlights in the snippet are wrapped in \u0001 … \u0002 control characters for the client to style.
api.get('/search', (req, res) => {
  const terms = clean(req.query.q, 100).match(/[\p{L}\p{N}]+/gu) || [];
  if (!terms.length) return res.json({ results: [], hasMore: false });
  const match = terms.slice(0, 8).map((t) => `"${t}"*`).join(' ');

  const params = [match, req.user.id];
  let where = '';
  if (req.query.chat !== undefined) {
    const chatId = toId(req.query.chat);
    if (!Number.isInteger(chatId) || !isMember(chatId, req.user.id)) throw new HttpError(404, 'Chat not found.');
    where += ' AND m.chat_id = ?';
    params.push(chatId);
  }
  const before = toId(req.query.before);
  if (Number.isInteger(before)) {
    where += ' AND m.id < ?';
    params.push(before);
  }
  const rows = db
    .prepare(
      `SELECT m.id, m.chat_id, m.created_at, m.char_name, u.display_name,
              snippet(messages_fts, 0, char(1), char(2), '…', 16) AS snip
       FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       JOIN users u ON u.id = m.user_id
       WHERE messages_fts MATCH ? AND m.chat_id IN (SELECT chat_id FROM chat_members WHERE user_id = ?)${where}
       ORDER BY m.id DESC LIMIT 31`,
    )
    .all(...params);
  res.json({
    results: rows.slice(0, 30).map((r) => ({
      id: r.id, chatId: r.chat_id, createdAt: r.created_at, author: r.char_name || r.display_name, snippet: r.snip,
    })),
    hasMore: rows.length > 30,
  });
});

// ---------------------------------------------------------------- push notifications

api.get('/push/key', (_req, res) => res.json({ key: publicKey }));

api.post('/push/subscribe', (req, res) => {
  const sub = req.body.subscription;
  const ok =
    typeof sub?.endpoint === 'string' && sub.endpoint.length < 1000 && validEndpoint(sub.endpoint) &&
    typeof sub.keys?.p256dh === 'string' && sub.keys.p256dh.length < 200 &&
    typeof sub.keys?.auth === 'string' && sub.keys.auth.length < 100;
  if (!ok) throw new HttpError(400, "That device can't receive notifications.");
  saveSubscription(req.user.id, sub);
  res.json({ ok: true });
});

api.post('/push/test', rateLimit({ windowMs: 10 * 60_000, max: 10 }), async (req, res) => {
  res.json(await notifyTest(req.user.id));
});

api.post('/push/unsubscribe', (req, res) => {
  if (typeof req.body.endpoint === 'string') removeSubscription(req.user.id, req.body.endpoint);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- admin: invites

api.get('/admin/invites', requireAdmin, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT i.code, i.created_at, i.used_at, u.username AS used_by FROM invites i
       LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC LIMIT 100`,
    )
    .all();
  res.json({ invites: rows.map((r) => ({ code: r.code, createdAt: r.created_at, usedAt: r.used_at, usedBy: r.used_by })) });
});

api.post('/admin/invites', requireAdmin, (req, res) => {
  const code = crypto.randomBytes(5).toString('hex');
  db.prepare('INSERT INTO invites (code, created_by, created_at) VALUES (?, ?, ?)').run(code, req.user.id, Date.now());
  res.json({ code });
});

api.delete('/admin/invites/:code', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM invites WHERE code = ?').run(clean(req.params.code, 40));
  res.json({ ok: true });
});

api.use((_req, res) => res.status(404).json({ error: 'Not found.' }));
