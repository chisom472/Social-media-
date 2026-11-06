const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { db } = require('./db');
const { UPLOAD_DIR, sha256File, mediaKind } = require('./utils');

const PRIVATE_DIR = path.join(UPLOAD_DIR, 'private');
fs.mkdirSync(PRIVATE_DIR, { recursive: true });

const ALLOWED_PUBLIC = /^(image\/(jpeg|png|gif|webp|avif)|video\/(mp4|webm|quicktime|ogg)|audio\/(mpeg|mp3|ogg|wav|webm|mp4|aac|x-m4a|m4a))$/;

function safeExt(name) {
  const e = path.extname(name || '').toLowerCase().replace(/[^.a-z0-9]/g, '');
  return e.slice(0, 8);
}

const publicStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + safeExt(file.originalname))
});
const privateStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, PRIVATE_DIR),
  filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + safeExt(file.originalname))
});

// public media (pictures, videos, songs) - 200 MB limit
const uploadMedia = multer({
  storage: publicStorage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_PUBLIC.test(file.mimetype)) return cb(null, true);
    cb(new Error('Only images, videos and audio files are allowed here.'));
  }
});

// digital product files (any type, kept private, only buyers can download) - 500 MB
const uploadProduct = multer({ storage: privateStorage, limits: { fileSize: 500 * 1024 * 1024 } });

// chat attachments (images, video, audio, documents)
const BLOCKED_CHAT = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/javascript|application\/javascript|application\/x-httpd-php)/;
const uploadChat = multer({
  storage: publicStorage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (BLOCKED_CHAT.test(file.mimetype) || /\.(html?|svg|js|php|xhtml)$/i.test(file.originalname)) return cb(new Error('This file type is not allowed in chat.'));
    cb(null, true);
  }
});

// Check the real bytes of an upload, not the type the browser claims.
const SIGS = {
  image: [[0xFF, 0xD8, 0xFF], [0x89, 0x50, 0x4E, 0x47], [0x47, 0x49, 0x46, 0x38]],
  riff: [[0x52, 0x49, 0x46, 0x46]],
  ftyp: 'ftyp', ogg: [[0x4F, 0x67, 0x67, 0x53]], ebml: [[0x1A, 0x45, 0xDF, 0xA3]], id3: [[0x49, 0x44, 0x33]]
};
function looksReal(file) {
  try {
    const fd = fs.openSync(file.path, 'r'); const b = Buffer.alloc(16); fs.readSync(fd, b, 0, 16, 0); fs.closeSync(fd);
    const starts = a => a.some(sig => sig.every((v, i) => b[i] === v));
    const m = file.mimetype || '';
    if (/^image\//.test(m)) return starts(SIGS.image) || starts(SIGS.riff) || b.toString('latin1', 4, 12).startsWith('ftyp');
    if (/^video\//.test(m)) return b.toString('latin1', 4, 8) === 'ftyp' || starts(SIGS.ebml) || starts(SIGS.ogg) || starts(SIGS.riff);
    if (/^audio\//.test(m)) return starts(SIGS.id3) || starts(SIGS.ogg) || starts(SIGS.riff) || starts(SIGS.ebml) || b.toString('latin1', 4, 8) === 'ftyp' || (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) || b.toString('latin1', 0, 4) === 'fLaC';
    return true;
  } catch (e) { return false; }
}

function removeFile(file) {
  try { fs.unlinkSync(file.path); } catch (e) { /* ignore */ }
}

/**
 * Registers a public upload against its content hash.
 * - If another user already registered the same bytes, the new file is deleted
 *   and an error describing the real owner is thrown.
 * - If this user already owns it, the original stored file is reused.
 * Returns { url, hash, kind }.
 */
async function claimMedia(file, userId) {
  if (!looksReal(file)) { removeFile(file); const e = new Error('That file does not look like a real image, video or audio file.'); e.status = 400; throw e; }
  const hash = await sha256File(file.path);
  const existing = db.prepare('SELECT r.*, u.username FROM media_registry r JOIN users u ON u.id=r.owner_id WHERE r.hash=?').get(hash);
  if (existing && existing.owner_id !== userId) {
    removeFile(file);
    const err = new Error('This file has already been published by @' + existing.username + ' and cannot be used by another account. Please upload your own original content.');
    err.status = 409;
    err.owner = existing.username;
    throw err;
  }
  if (existing && existing.owner_id === userId) {
    if (existing.file !== file.filename) removeFile(file);
    return { url: '/uploads/' + existing.file, hash, kind: existing.kind };
  }
  const kind = mediaKind(file.mimetype);
  db.prepare('INSERT INTO media_registry(hash,owner_id,kind,original_name,file) VALUES(?,?,?,?,?)')
    .run(hash, userId, kind, file.originalname, file.filename);
  return { url: '/uploads/' + file.filename, hash, kind };
}

module.exports = { uploadMedia, uploadProduct, uploadChat, claimMedia, removeFile, PRIVATE_DIR };
