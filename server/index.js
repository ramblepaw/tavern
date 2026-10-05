import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { authMiddleware, requireAuth, purgeExpiredSessions } from './auth.js';
import { api } from './api.js';
import { attach } from './realtime.js';
import { isMediaName, HttpError } from './media.js';
import { ensureIcons } from './icons.js';

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', config.trustProxy);

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "style-src 'self'",
      "script-src 'self'",
      "connect-src 'self' ws: wss:",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  });
  next();
});

// Basic CSRF defence: reject cross-origin state-changing requests (cookies are also SameSite=Lax).
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || !req.headers.origin) return next();
  try {
    if (new URL(req.headers.origin).host === req.headers.host) return next();
  } catch {}
  res.status(403).json({ error: 'Cross-origin request blocked.' });
});

app.use(authMiddleware);

// Uploaded images are only visible to signed-in users.
app.get('/media/:name', requireAuth, (req, res) => {
  if (!isMediaName(req.params.name)) return res.sendStatus(404);
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(req.params.name, { root: config.uploadDir, dotfiles: 'deny' }, (err) => {
    if (err && !res.headersSent) res.sendStatus(404);
  });
});

app.use('/api', express.json({ limit: '100kb' }), api);

app.use(express.static(config.publicDir, { extensions: ['html'] }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') err = new HttpError(413, `That file is too large (max ${config.maxUploadMb} MB).`);
  else if (err?.name === 'MulterError') err = new HttpError(400, 'Too many files, or an upload problem.');
  else if (err?.type === 'entity.parse.failed') err = new HttpError(400, 'Bad request.');
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server.' : err.message });
});

await ensureIcons();
purgeExpiredSessions();
setInterval(purgeExpiredSessions, 3600_000).unref();

const server = http.createServer(app);
attach(server);

server.listen(config.port, config.host, () => {
  console.log(`\nTavern is running.\n  This computer:  http://localhost:${config.port}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  On your network: http://${a.address}:${config.port}`);
    }
  }
  console.log(`  Data folder:     ${path.relative(process.cwd(), config.dataDir) || '.'}\n`);
});
