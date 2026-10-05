import { WebSocketServer } from 'ws';
import { tokenFromRequest, userFromToken } from './auth.js';
import { isMember, memberIds } from './db.js';

/** userId -> Set<WebSocket> */
const clients = new Map();

export function toUsers(userIds, event, exceptUserId = null) {
  const data = JSON.stringify(event);
  for (const id of new Set(userIds)) {
    if (id === exceptUserId) continue;
    for (const ws of clients.get(id) || []) if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

export function toChat(chatId, event, exceptUserId = null) {
  toUsers(memberIds(chatId), event, exceptUserId);
}

/** True if one of this user's devices currently has that chat open in the foreground. */
export function isViewing(userId, chatId) {
  for (const ws of clients.get(userId) || []) if (ws.readyState === ws.OPEN && ws.viewing === chatId) return true;
  return false;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export function attach(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  server.on('upgrade', (req, socket, head) => {
    const reject = (line) => {
      socket.write(`HTTP/1.1 ${line}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (new URL(req.url, 'http://x').pathname !== '/ws') return reject('404 Not Found');
    if (!sameOrigin(req)) return reject('403 Forbidden');
    const user = userFromToken(tokenFromRequest(req));
    if (!user) return reject('401 Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.userId = user.id;
      ws.userName = user.display_name;
      ws.alive = true;
      if (!clients.has(user.id)) clients.set(user.id, new Set());
      clients.get(user.id).add(ws);

      ws.on('pong', () => (ws.alive = true));
      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg?.type === 'view') {
          // Which chat is on screen right now (null when hidden / not in a chat); used to skip redundant pushes.
          ws.viewing = Number.isInteger(msg.chatId) ? msg.chatId : null;
        } else if (msg?.type === 'typing' && Number.isInteger(msg.chatId) && isMember(msg.chatId, ws.userId)) {
          toChat(msg.chatId, { type: 'typing', chatId: msg.chatId, userId: ws.userId, name: ws.userName }, ws.userId);
        }
      });
      ws.on('close', () => {
        const set = clients.get(ws.userId);
        set?.delete(ws);
        if (set && !set.size) clients.delete(ws.userId);
      });
      ws.on('error', () => ws.terminate());
      ws.send(JSON.stringify({ type: 'ready' }));
    });
  });

  // Drop dead connections (phones going to sleep, etc).
  setInterval(() => {
    for (const set of clients.values()) {
      for (const ws of set) {
        if (!ws.alive) {
          ws.terminate();
          continue;
        }
        ws.alive = false;
        ws.ping();
      }
    }
  }, 30_000).unref();
}
