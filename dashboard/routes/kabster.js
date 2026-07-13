/*
 * The takeover questionnaire, for a server owner who has no dashboard account and never will.
 *
 * SECURITY POSTURE — read this before changing anything here.
 *
 * These routes are deliberately UNAUTHENTICATED, because the person they exist for cannot log in.
 * Access is a capability URL: /kabster/<43-char random token>. Knowing the link is the permission.
 * That is a real and appropriate model for a private form sent to one person, but it only holds if
 * everything below stays true:
 *
 *   • The token is the ONLY way in. There is no /kabster/ index, no guild-id route, no enumeration.
 *   • An unknown or revoked token is a flat 404 — never "wrong token", which would confirm the
 *     route exists and invite guessing.
 *   • The token names the guild. The client NEVER sends a guild id; it cannot write to another
 *     server's answers even by trying.
 *   • Writes are whitelisted by core/takeover-questions.js. A key we did not author, or a value
 *     that is not one of the options we offered, is rejected. The only free text is `note`, which
 *     is length-capped and stored as text — never interpreted, never executed, escaped on render.
 *   • Nothing here applies anything. These are her stated intentions; a human still runs each step.
 */
import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { QUESTIONS, CATALOGUE, validateAnswer, MAX_NOTE } from '../../core/takeover-questions.js';

const router = express.Router();
const PRIVATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'private');

/** Cheap in-process throttle. The form autosaves, so it is chatty by design — this only stops abuse. */
const hits = new Map();
function tooFast(token) {
  const now = Date.now();
  const bucket = (hits.get(token) ?? []).filter(t => now - t < 10_000);
  bucket.push(now);
  hits.set(token, bucket);
  if (hits.size > 500) hits.clear(); // never let this grow unbounded
  return bucket.length > 40; // 40 saves per 10s is far above human typing, far below a flood
}

/** Resolve a token to its guild, or null. A revoked link is indistinguishable from a wrong one. */
async function resolveToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [[row]] = await pool.execute(
    'SELECT guild_id FROM takeover_questionnaire_links WHERE token = ? AND revoked = 0', [token]);
  return row?.guild_id ?? null;
}

// The page itself.
//
// It lives in dashboard/private/, NOT dashboard/public/. express.static is mounted at the app root
// and would happily serve /kabster/index.html to anyone who typed it — no token, no check, the whole
// capability model bypassed by a path guess. Keeping the file outside the static root means this
// route is the only door.
router.get('/:token', async (req, res) => {
  const guildId = await resolveToken(req.params.token);
  if (!guildId) return res.status(404).send('Not found');
  res.sendFile(path.join(PRIVATE_DIR, 'kabster.html'));
});

/** Everything she has answered so far, so a reopened tab is never a blank form. */
router.get('/:token/answers', async (req, res) => {
  const guildId = await resolveToken(req.params.token);
  if (!guildId) return res.status(404).json({ error: 'not found' });

  const [rows] = await pool.execute(
    'SELECT item_key, value, note, updated_at FROM takeover_questionnaire WHERE guild_id = ?', [guildId]);

  const answers = {};
  for (const r of rows) answers[r.item_key] = { value: r.value, note: r.note, updatedAt: r.updated_at };
  res.json({ questions: QUESTIONS, catalogue: CATALOGUE, answers, maxNote: MAX_NOTE });
});

/** Autosave. One question at a time — a half-finished form is a first-class state, not an error. */
router.post('/:token/save', async (req, res) => {
  const guildId = await resolveToken(req.params.token);
  if (!guildId) return res.status(404).json({ error: 'not found' });
  if (tooFast(req.params.token)) return res.status(429).json({ error: 'slow down' });

  const { key, value = null, note = null } = req.body ?? {};

  const problem = validateAnswer(key, value, note);
  if (problem) {
    logger.warn(`[kabster] rejected a write to "${key}" on guild ${guildId}: ${problem}`);
    return res.status(400).json({ error: problem });
  }

  await pool.execute(
    `INSERT INTO takeover_questionnaire (guild_id, item_key, value, note) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value), note = VALUES(note)`,
    [guildId, key, value || null, note || null]);

  logger.info(`[kabster] ${guildId} answered "${key}" = ${value ?? '(note only)'}`);
  res.json({ ok: true, savedAt: new Date().toISOString() });
});

/**
 * Mint a link. NOT a route — there is deliberately no HTTP way to create one, because an endpoint
 * that hands out capability URLs is a public key-cutting machine. Call it from a script.
 */
export async function createLink(guildId, label = null) {
  const token = crypto.randomBytes(32).toString('base64url'); // 43 chars, 256 bits
  await pool.execute(
    'INSERT INTO takeover_questionnaire_links (token, guild_id, label) VALUES (?, ?, ?)',
    [token, guildId, label]);
  return token;
}

export default router;
