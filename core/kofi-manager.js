/*
 * Ko-fi integration — supporter roles driven by Ko-fi's webhook.
 *
 * Ko-fi POSTs `application/x-www-form-urlencoded` with one field, `data`, holding a JSON
 * string. There is NO signature header: the only proof of authenticity is the
 * `verification_token` inside the payload, so we compare it in constant time against an
 * encrypted copy, and the URL carries an unguessable per-guild token as a second factor.
 *
 * Identity: the reference bot (miffens/kofi-discord-bot, MIT) pulls the Discord id out of
 * the donation message, which silently breaks on renewals — Ko-fi sends those with a blank
 * message. We key on `email`, which is present on every payment including renewals, and use
 * a one-time claim code in the message purely to bind that email to a Discord user once.
 */
import crypto from 'crypto';
import { PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import encryption from '../utils/encryption.js';

export const DEFAULT_DURATION_DAYS = 31;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1

/** Emails are only ever compared for equality; never store the address itself. */
export function hashEmail(email) {
  return crypto.createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex');
}

/** Timing-safe compare that tolerates different lengths. */
export function tokensMatch(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ── Payload ──────────────────────────────────────────────────────────────────

/**
 * Normalise Ko-fi's `data` JSON. Amounts arrive as strings ("3.00"); booleans are real
 * booleans but some proxies stringify them, so coerce defensively.
 * @returns {object|null} null when the payload is unusable.
 */
export function parsePayload(raw) {
  let d;
  try { d = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!d || typeof d !== 'object') return null;
  if (!d.message_id) return null;

  const bool = v => v === true || v === 'true' || v === 1 || v === '1';
  const amount = Number.parseFloat(d.amount);

  return {
    messageId: String(d.message_id),
    txnId: d.kofi_transaction_id ? String(d.kofi_transaction_id) : null,
    verificationToken: d.verification_token ?? null,
    type: d.type ?? null,                       // Donation | Subscription | Commission | Shop Order
    fromName: d.from_name ? String(d.from_name).slice(0, 120) : null,
    message: d.message ? String(d.message).slice(0, 1000) : null,
    amount: Number.isFinite(amount) ? amount : 0,
    currency: d.currency ? String(d.currency).slice(0, 8) : null,
    email: d.email ? String(d.email) : null,
    tierName: d.tier_name ? String(d.tier_name).slice(0, 100) : null,
    isSubscription: bool(d.is_subscription_payment),
    isFirst: bool(d.is_first_subscription_payment),
    isPublic: bool(d.is_public),
    url: d.url ?? null,
  };
}

/**
 * Choose the role a payment earns.
 * A tier with a `tier_name` wins on an exact (case-insensitive) name match — that is what
 * Ko-fi memberships send. Otherwise fall back to the most expensive amount threshold the
 * payment clears, so a $20 donation gets the $20 role rather than the $1 one.
 * @returns {object|null} the matching tier row.
 */
export function matchTier(tiers, { tierName, amount }) {
  if (!tiers?.length) return null;

  if (tierName) {
    const want = tierName.trim().toLowerCase();
    const named = tiers.find(t => t.tier_name && t.tier_name.trim().toLowerCase() === want);
    if (named) return named;
  }

  const byAmount = tiers
    .filter(t => Number(t.min_amount) > 0 && amount >= Number(t.min_amount))
    .sort((a, b) => Number(b.min_amount) - Number(a.min_amount));
  return byAmount[0] ?? null;
}

/** `CF-XXXXXX` — the code a supporter pastes into their Ko-fi message. */
export function generateCode(rng = () => crypto.randomInt(CODE_ALPHABET.length)) {
  let body = '';
  for (let i = 0; i < 6; i++) body += CODE_ALPHABET[rng()];
  return `CF-${body}`;
}

/** Find a claim code anywhere in a Ko-fi message. */
export function extractCode(message) {
  const m = /\bCF-([A-Z2-9]{6})\b/i.exec(String(message || ''));
  return m ? `CF-${m[1].toUpperCase()}` : null;
}

// ── Config ───────────────────────────────────────────────────────────────────

export async function getConfig(guildId) {
  const [[row]] = await pool.execute('SELECT * FROM kofi_config WHERE guild_id = ?', [guildId]);
  return row || null;
}

export async function getConfigByToken(webhookToken) {
  const [[row]] = await pool.execute('SELECT * FROM kofi_config WHERE webhook_token = ?', [webhookToken]);
  return row || null;
}

/** Decrypt the stored Ko-fi verification token. Null when the guild never set one. */
export function decryptVerificationToken(row) {
  if (!row?.verification_token) return null;
  try {
    return encryption.decrypt(JSON.parse(row.verification_token));
  } catch (err) {
    logger.error(`[Kofi] verification token decrypt failed for ${row.guild_id}: ${err.message}`);
    return null;
  }
}

export async function setup(guildId, { verificationToken, announceChannelId, durationDays } = {}) {
  const webhookToken = crypto.randomBytes(24).toString('base64url');
  const enc = verificationToken ? JSON.stringify(encryption.encrypt(verificationToken)) : null;

  await pool.execute(
    `INSERT INTO kofi_config (guild_id, webhook_token, verification_token, announce_channel_id, role_duration_days)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       verification_token = COALESCE(VALUES(verification_token), verification_token),
       announce_channel_id = COALESCE(VALUES(announce_channel_id), announce_channel_id),
       role_duration_days = VALUES(role_duration_days),
       enabled = 1`,
    [guildId, webhookToken, enc, announceChannelId ?? null, durationDays ?? DEFAULT_DURATION_DAYS]);

  // On an update the existing token is kept; return whatever is actually stored.
  return getConfig(guildId);
}

export async function getTiers(guildId) {
  const [rows] = await pool.execute(
    'SELECT * FROM kofi_tiers WHERE guild_id = ? ORDER BY min_amount DESC', [guildId]);
  return rows;
}

export async function addTier(guildId, { roleId, tierName = null, minAmount = 0 }) {
  await pool.execute(
    `INSERT INTO kofi_tiers (guild_id, tier_name, min_amount, role_id) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE tier_name = VALUES(tier_name), min_amount = VALUES(min_amount)`,
    [guildId, tierName, minAmount, roleId]);
}

export async function removeTier(guildId, roleId) {
  const [r] = await pool.execute('DELETE FROM kofi_tiers WHERE guild_id = ? AND role_id = ?', [guildId, roleId]);
  return r.affectedRows > 0;
}

// ── Linking ──────────────────────────────────────────────────────────────────

/** Issue (or reuse) a claim code for a user. */
export async function issueCode(guildId, userId) {
  const [[existing]] = await pool.execute(
    'SELECT code FROM kofi_claim_codes WHERE guild_id = ? AND user_id = ? AND used_at IS NULL LIMIT 1',
    [guildId, userId]);
  if (existing) return existing.code;

  // Retry on the (vanishingly unlikely) primary-key collision rather than throwing.
  for (let i = 0; i < 5; i++) {
    const code = generateCode();
    try {
      await pool.execute('INSERT INTO kofi_claim_codes (code, guild_id, user_id) VALUES (?, ?, ?)',
        [code, guildId, userId]);
      return code;
    } catch (err) {
      if (err.code !== 'ER_DUP_ENTRY') throw err;
    }
  }
  throw new Error('could not allocate a claim code');
}

/**
 * Consume a claim code and bind the email to that user.
 * @returns {Promise<string|null>} the Discord user id, or null if the code is unknown/used.
 */
export async function redeemCode(guildId, code, emailHash) {
  const [r] = await pool.execute(
    'UPDATE kofi_claim_codes SET used_at = NOW() WHERE code = ? AND guild_id = ? AND used_at IS NULL',
    [code, guildId]);
  if (r.affectedRows !== 1) return null;

  const [[row]] = await pool.execute('SELECT user_id FROM kofi_claim_codes WHERE code = ?', [code]);
  if (!row) return null;

  await pool.execute(
    `INSERT INTO kofi_links (guild_id, email_hash, user_id) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
    [guildId, emailHash, row.user_id]);
  return row.user_id;
}

export async function findLinkedUser(guildId, emailHash) {
  const [[row]] = await pool.execute(
    'SELECT user_id FROM kofi_links WHERE guild_id = ? AND email_hash = ?', [guildId, emailHash]);
  return row?.user_id ?? null;
}

export async function unlink(guildId, userId) {
  const [r] = await pool.execute('DELETE FROM kofi_links WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  await pool.execute('UPDATE kofi_supporters SET user_id = NULL WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  return r.affectedRows > 0;
}

// ── Payment processing ───────────────────────────────────────────────────────

/**
 * Record a payment and grant the earned role.
 * Idempotent on `message_id`: Ko-fi retries any non-2xx, and a retry must not pay twice.
 *
 * @returns {Promise<{status:string, ...}>} status is one of:
 *   duplicate | recorded | granted | unlinked | no-tier | disabled
 */
export async function processPayment(guildId, payload, client) {
  const config = await getConfig(guildId);
  if (!config?.enabled) return { status: 'disabled' };

  const emailHash = payload.email ? hashEmail(payload.email) : null;

  // Claim the message id first — this is the whole idempotency guard.
  try {
    await pool.execute(
      `INSERT INTO kofi_transactions
         (message_id, guild_id, kofi_txn_id, email_hash, from_name, type, amount, currency,
          tier_name, is_subscription, is_first, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [payload.messageId, guildId, payload.txnId, emailHash, payload.fromName, payload.type,
        payload.amount, payload.currency, payload.tierName,
        payload.isSubscription ? 1 : 0, payload.isFirst ? 1 : 0, payload.message]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return { status: 'duplicate', messageId: payload.messageId };
    throw err;
  }

  if (!emailHash) return { status: 'recorded', reason: 'no email in payload' };

  // A claim code in the message binds this email to a Discord user, once.
  const code = extractCode(payload.message);
  let userId = await findLinkedUser(guildId, emailHash);
  if (!userId && code) userId = await redeemCode(guildId, code, emailHash);

  const tiers = await getTiers(guildId);
  const tier = matchTier(tiers, payload);

  const days = Number(config.role_duration_days) || DEFAULT_DURATION_DAYS;
  // Only recurring support expires. A one-off donation's perk lasts the same window, which
  // is what the reference bot does, but a non-subscription payment never *revokes* early.
  await pool.execute(
    `INSERT INTO kofi_supporters
       (guild_id, email_hash, user_id, from_name, tier_name, role_id, last_amount, currency,
        lifetime_amount, is_subscription, last_payment_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY))
     ON DUPLICATE KEY UPDATE
       user_id = COALESCE(VALUES(user_id), user_id),
       from_name = VALUES(from_name),
       tier_name = COALESCE(VALUES(tier_name), tier_name),
       role_id = COALESCE(VALUES(role_id), role_id),
       last_amount = VALUES(last_amount),
       currency = VALUES(currency),
       lifetime_amount = lifetime_amount + VALUES(last_amount),
       is_subscription = VALUES(is_subscription),
       last_payment_at = NOW(),
       expires_at = GREATEST(COALESCE(expires_at, NOW()), NOW()) + INTERVAL ? DAY`,
    [guildId, emailHash, userId, payload.fromName, payload.tierName, tier?.role_id ?? null,
      payload.amount, payload.currency, payload.amount, payload.isSubscription ? 1 : 0, days, days]);

  if (userId) {
    await pool.execute('UPDATE kofi_transactions SET user_id = ? WHERE message_id = ?', [userId, payload.messageId]);
  }

  if (!userId) return { status: 'unlinked', emailHash, tier };
  if (!tier) return { status: 'no-tier', userId };

  const granted = await grantRole(guildId, userId, tier.role_id, client,
    `Ko-fi ${payload.type || 'payment'}${payload.tierName ? ` (${payload.tierName})` : ''}`);
  return { status: granted ? 'granted' : 'no-tier', userId, tier, granted };
}

function resolveClient(guildId, client) {
  return client || global.botManager?.getClientForGuild?.(guildId) || global.client || null;
}

/** Add a role, checking we actually can before we try. */
export async function grantRole(guildId, userId, roleId, client, reason = 'Ko-fi supporter') {
  const c = resolveClient(guildId, client);
  const guild = await c?.guilds?.fetch(guildId).catch(() => null);
  if (!guild) return false;

  const [member, role] = await Promise.all([
    guild.members.fetch(userId).catch(() => null),
    guild.roles.fetch(roleId).catch(() => null),
  ]);
  if (!member || !role) return false;
  if (member.roles.cache.has(roleId)) return true;

  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles) || role.position >= me.roles.highest.position) {
    logger.warn(`[Kofi] cannot grant ${role.name} in ${guildId} — role is above me or I lack Manage Roles`);
    return false;
  }

  // X-Audit-Log-Reason must be ASCII.
  try {
    await member.roles.add(role, reason.replace(/[^\x20-\x7E]/g, ''));
    return true;
  } catch (err) {
    logger.error(`[Kofi] role add failed in ${guildId}: ${err.message}`);
    return false;
  }
}

export async function revokeRole(guildId, userId, roleId, client, reason = 'Ko-fi support lapsed') {
  const c = resolveClient(guildId, client);
  const guild = await c?.guilds?.fetch(guildId).catch(() => null);
  if (!guild) return false;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member?.roles.cache.has(roleId)) return false;
  await member.roles.remove(roleId, reason.replace(/[^\x20-\x7E]/g, '')).catch(() => {});
  return true;
}

// ── Expiry + backfill ────────────────────────────────────────────────────────

/** Strip roles whose support window has lapsed. Safe to run repeatedly. */
export async function expireLapsed(client) {
  const [rows] = await pool.execute(
    `SELECT guild_id, email_hash, user_id, role_id FROM kofi_supporters
      WHERE expires_at IS NOT NULL AND expires_at < NOW() AND role_id IS NOT NULL`);

  let removed = 0;
  for (const r of rows) {
    if (r.user_id) {
      const ok = await revokeRole(r.guild_id, r.user_id, r.role_id, client);
      if (ok) removed++;
    }
    await pool.execute(
      'UPDATE kofi_supporters SET role_id = NULL WHERE guild_id = ? AND email_hash = ?',
      [r.guild_id, r.email_hash]);
  }
  if (removed) logger.info(`[Kofi] expired ${removed} supporter role(s)`);
  return removed;
}

/**
 * A supporter who donated before joining (or who left and came back) gets their role on
 * join. Called from guildMemberAdd.
 */
export async function syncMember(member) {
  try {
    const [[row]] = await pool.execute(
      `SELECT role_id FROM kofi_supporters
        WHERE guild_id = ? AND user_id = ? AND role_id IS NOT NULL
          AND (expires_at IS NULL OR expires_at > NOW())`,
      [member.guild.id, member.id]);
    if (!row) return false;
    return grantRole(member.guild.id, member.id, row.role_id, member.client, 'Ko-fi supporter (rejoined)');
  } catch (err) {
    logger.error(`[Kofi] syncMember failed: ${err.message}`);
    return false;
  }
}

export async function getSupporter(guildId, userId) {
  const [[row]] = await pool.execute(
    'SELECT * FROM kofi_supporters WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
  return row || null;
}

export async function listSupporters(guildId, limit = 15) {
  const [rows] = await pool.execute(
    `SELECT user_id, from_name, tier_name, lifetime_amount, currency, expires_at
       FROM kofi_supporters WHERE guild_id = ?
      ORDER BY lifetime_amount DESC LIMIT ?`, [guildId, String(limit)]);
  return rows;
}
