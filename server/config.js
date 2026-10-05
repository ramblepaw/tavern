import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));

export const config = {
  root,
  publicDir: path.join(root, 'public'),
  dataDir,
  uploadDir: path.join(dataDir, 'uploads'),
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || '0.0.0.0',
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB) || 15,
  // Set TRUST_PROXY=1 when running behind a reverse proxy / tunnel that terminates HTTPS.
  trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY : false,
  // Anyone can sign up without an invite code. Off by default.
  openRegistration: process.env.OPEN_REGISTRATION === 'true',
  // Contact for the push services ("mailto:you@example.com" or an https URL). Apple rejects bogus ones, so set your own.
  vapidSubject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  sessionDays: 30,
  maxMessageLength: 8000,
};
