import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import sharp from 'sharp';
import { config } from './config.js';

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 4, fields: 20, fieldSize: 64 * 1024 },
  fileFilter(_req, file, cb) {
    if (!/^image\//.test(file.mimetype)) return cb(new HttpError(400, 'Only image files can be uploaded.'));
    cb(null, true);
  },
});

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const ALLOWED = new Set(['jpeg', 'png', 'webp', 'gif', 'avif', 'heif']);
const FILE_RE = /^[a-f0-9]{32}\.(webp|gif)$/;

async function save(buffer, ext) {
  const name = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  await fs.writeFile(path.join(config.uploadDir, name), buffer);
  return name;
}

async function open(buffer, opts) {
  try {
    const img = sharp(buffer, { failOn: 'error', ...opts });
    const meta = await img.metadata();
    if (!ALLOWED.has(meta.format)) throw new Error('unsupported format');
    return { img, meta };
  } catch {
    throw new HttpError(400, "That image couldn't be read. Try a JPEG, PNG, WebP or GIF.");
  }
}

/** Square avatar, 256px, EXIF-stripped WebP. */
export async function processAvatar(buffer) {
  const { img } = await open(buffer);
  const out = await img.rotate().resize(256, 256, { fit: 'cover' }).webp({ quality: 85 }).toBuffer();
  return save(out, 'webp');
}

/**
 * Chat image. Animated GIFs are kept as-is; everything else is auto-rotated,
 * downscaled to 1600px, stripped of EXIF (including GPS) and stored as WebP.
 */
export async function processChatImage(buffer) {
  const { img, meta } = await open(buffer, { animated: true });
  if (meta.format === 'gif' && (meta.pages || 1) > 1) {
    return { file: await save(buffer, 'gif'), w: meta.width, h: meta.pageHeight || meta.height };
  }
  const { data, info } = await img
    .rotate()
    .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true });
  return { file: await save(data, 'webp'), w: info.width, h: info.height };
}

export function isMediaName(name) {
  return FILE_RE.test(name);
}

export async function deleteMedia(names) {
  await Promise.all(
    names.filter(isMediaName).map((n) => fs.unlink(path.join(config.uploadDir, n)).catch(() => {})),
  );
}
