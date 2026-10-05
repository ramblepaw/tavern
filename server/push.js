import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { config } from './config.js';
import { db, memberIds } from './db.js';
import { isViewing } from './realtime.js';

// VAPID keys identify this server to the browsers' push services. Generated once, kept in the data folder.
const keyFile = path.join(config.dataDir, 'vapid.json');
let keys;
try {
  keys = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
} catch {
  keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(keyFile, JSON.stringify(keys), { mode: 0o600 });
}
webpush.setVapidDetails(config.vapidSubject, keys.publicKey, keys.privateKey);

export const publicKey = keys.publicKey;

// The server POSTs to whatever endpoint a client registers, so only accept the real browser push services.
const PUSH_HOSTS = ['googleapis.com', 'push.apple.com', 'mozilla.com', 'windows.com'];

export function validEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

export function saveSubscription(userId, { endpoint, keys: k }) {
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
  ).run(endpoint, userId, k.p256dh, k.auth, Date.now());
  // Keep the newest 10 devices per person.
  db.prepare(
    `DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint NOT IN
       (SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 10)`,
  ).run(userId, userId);
}

export function removeSubscription(userId, endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, userId);
}

const plain = (s) => s.replace(/[*_~|]/g, '').replace(/\s+/g, ' ').trim();

/** Push a test notification to all of a user's devices. Resolves with how many were accepted / failed. */
export async function notifyTest(userId) {
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
  const payload = JSON.stringify({ title: 'Tavern', body: 'Notifications are working!', chatId: null, unread: 0 });
  let sent = 0;
  let failed = 0;
  await Promise.all(
    subs.map((s) =>
      webpush
        .sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 300 })
        .then(() => sent++)
        .catch((err) => {
          failed++;
          if (err.statusCode === 404 || err.statusCode === 410) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(s.endpoint);
        }),
    ),
  );
  return { sent, failed };
}

/** Send a push notification about a new message to every other member's devices. Fire-and-forget. */
export function notifyMessage(message) {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(message.chatId);
  if (!chat) return;
  const senderId = message.author.id;
  const author = message.character?.name || message.author.displayName;
  const text = plain(message.body).slice(0, 140) || (message.images.length ? 'Sent a picture' : '');
  const body = chat.is_dm && !message.character ? text : `${author}: ${text}`;
  const title = chat.is_dm ? message.author.displayName : chat.name;

  for (const userId of memberIds(message.chatId)) {
    if (userId === senderId || isViewing(userId, message.chatId)) continue;
    const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId);
    if (!subs.length) continue;
    const { c: unread } = db
      .prepare(
        `SELECT COUNT(*) AS c FROM messages m JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
         WHERE m.id > cm.last_read_id AND m.user_id != ?`,
      )
      .get(userId, userId);
    const payload = JSON.stringify({ title, body, chatId: message.chatId, messageId: message.id, unread });
    for (const s of subs) {
      webpush
        .sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 86400 })
        .catch((err) => {
          if (err.statusCode === 404 || err.statusCode === 410) {
            db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(s.endpoint);
          } else console.warn(`Push failed (${err.statusCode || err.code || err.message})`);
        });
    }
  }
}
