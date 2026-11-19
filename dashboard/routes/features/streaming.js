import express from 'express';
import pool from '../../../utils/db.js';
import { ensureAuth, ensureGuildPerms } from '../api.js';
import logger from '../../../utils/logger.js';
import { rescanGuildStreamers } from '../../../core/stream-manager.js';
import { listDeparted } from '../../../core/streamer-departure.js';

const router = express.Router();

// POST /api/guilds/:guildId/streaming/subscriptions/bulk-update - Bulk update streaming subscriptions
router.post('/:guildId/streaming/subscriptions/bulk-update', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const { subscriptionIds, announcement_channel_id, role_to_mention, custom_message } = req.body;

    if (!Array.isArray(subscriptionIds) || subscriptionIds.length === 0) {
      return res.status(400).json({ error: 'subscriptionIds must be a non-empty array' });
    }

    // Validate all subscription IDs belong to this guild
    const placeholders = subscriptionIds.map(() => '?').join(',');
    const [owned] = await pool.execute(
      `SELECT subscription_id FROM subscriptions WHERE subscription_id IN (${placeholders}) AND guild_id = ?`,
      [...subscriptionIds, req.guildId]
    );

    if (owned.length !== subscriptionIds.length) {
      return res.status(403).json({ error: 'Some subscription IDs do not belong to this guild' });
    }

    // Build dynamic update query — only update provided fields
    const updates = [];
    const values = [];

    if (announcement_channel_id !== undefined) {
      updates.push('announcement_channel_id = ?');
      values.push(announcement_channel_id);
    }
    if (role_to_mention !== undefined) {
      // Column is live_role_id in the subscriptions table
      updates.push('live_role_id = ?');
      values.push(role_to_mention);
    }
    if (custom_message !== undefined) {
      updates.push('custom_message = ?');
      values.push(custom_message);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update. Provide at least one of: announcement_channel_id, role_to_mention, custom_message' });
    }

    values.push(...subscriptionIds, req.guildId);
    const [result] = await pool.execute(
      `UPDATE subscriptions SET ${updates.join(', ')} WHERE subscription_id IN (${placeholders}) AND guild_id = ?`,
      values
    );

    res.json({
      success: true,
      message: `Updated ${result.affectedRows} subscription(s)`,
      updatedCount: result.affectedRows
    });
  } catch (error) {
    logger.error('[Streaming] Bulk update subscriptions error', { error: error.message });
    res.status(500).json({ error: 'Failed to bulk update subscriptions' });
  }
});


// POST /api/guilds/:guildId/streaming/rescan — force a Twitch/Kick/YouTube live-check
// for every tracked streamer in this guild. Mirrors the /livecheck slash command.
//
// A rescan can outlast Cloudflare's ~100s proxy timeout, which then hands the browser an HTML
// error page. So the POST only starts the job and returns 202; the page polls the GET below.
// One job per guild: repeat clicks while it runs attach to the running job instead of stacking.
const rescanJobs = new Map(); // guildId -> { status, startedAt, finishedAt, result, error }
const RESCAN_RESULT_TTL_MS = 10 * 60_000;

router.post('/:guildId/streaming/rescan', ensureAuth, ensureGuildPerms, async (req, res) => {
  const guildId = req.guildId;
  const existing = rescanJobs.get(guildId);
  if (existing?.status === 'running') {
    return res.status(202).json({ status: 'running', startedAt: existing.startedAt, alreadyRunning: true });
  }
  const forceLive = req.body?.forceLive !== false;
  const job = { status: 'running', startedAt: Date.now() };
  rescanJobs.set(guildId, job);
  rescanGuildStreamers(guildId, { forceLive })
    .then(result => { job.status = 'done'; job.result = result; })
    .catch(error => {
      job.status = 'error';
      job.error = 'Rescan failed. Try again in a moment.';
      logger.error('[Streaming] rescan error', { error: error.message, guildId });
    })
    .finally(() => {
      job.finishedAt = Date.now();
      setTimeout(() => { if (rescanJobs.get(guildId) === job) rescanJobs.delete(guildId); }, RESCAN_RESULT_TTL_MS).unref?.();
    });
  res.status(202).json({ status: 'running', startedAt: job.startedAt });
});

// GET /api/guilds/:guildId/streaming/rescan — status of this guild's latest rescan job
router.get('/:guildId/streaming/rescan', ensureAuth, ensureGuildPerms, (req, res) => {
  const job = rescanJobs.get(req.guildId);
  if (!job) return res.json({ status: 'idle' });
  res.json({
    status: job.status,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    ...(job.result || {}),
    ...(job.error ? { error: job.error } : {}),
  });
});

// GET /api/guilds/:guildId/streaming/departed — rows for the "Departed subscriptions" panel
router.get('/:guildId/streaming/departed', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const rows = await listDeparted(req.guildId);
    res.json({ departed: rows });
  } catch (error) {
    logger.error('[Streaming] listDeparted error', { error: error.message, guildId: req.guildId });
    res.status(500).json({ error: 'Could not load departed subscriptions.' });
  }
});

// POST /api/guilds/:guildId/streaming/restore — body: { mode: 'all' | 'except-manual' }
// Mirrors /subs restore. Returns affectedRows so the UI can show how many were revived.
router.post('/:guildId/streaming/restore', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const mode = req.body?.mode;
    if (mode !== 'all' && mode !== 'except-manual') {
      return res.status(400).json({ error: 'mode must be "all" or "except-manual"' });
    }
    const whereManual = mode === 'except-manual'
      ? "AND (departed_reason IS NULL OR departed_reason <> 'manual')"
      : '';
    const [result] = await pool.query(
      `UPDATE subscriptions SET paused = 0, departed_at = NULL, departed_reason = NULL
        WHERE guild_id = ? AND departed_at IS NOT NULL ${whereManual}`,
      [req.guildId]);
    res.json({ success: true, mode, restored: result.affectedRows });
  } catch (error) {
    logger.error('[Streaming] restore error', { error: error.message, guildId: req.guildId });
    res.status(500).json({ error: 'Restore failed.' });
  }
});


// POST /api/guilds/:guildId/streaming/restore-one — quick-restore a single subscription
// by subscription_id. Mirrors "all" but scoped to one row — needed for the per-row
// Restore button on the "Recently removed" panel.
router.post('/:guildId/streaming/restore-one', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const subscriptionId = Number(req.body?.subscriptionId);
    if (!Number.isInteger(subscriptionId) || subscriptionId <= 0) {
      return res.status(400).json({ error: 'subscriptionId must be a positive integer' });
    }
    const [result] = await pool.query(
      `UPDATE subscriptions SET paused = 0, departed_at = NULL, departed_reason = NULL
        WHERE subscription_id = ? AND guild_id = ? AND departed_at IS NOT NULL`,
      [subscriptionId, req.guildId]);
    res.json({ success: true, restored: result.affectedRows });
  } catch (error) {
    logger.error('[Streaming] restore-one error', { error: error.message, guildId: req.guildId });
    res.status(500).json({ error: 'Restore failed.' });
  }
});


// GET /api/guilds/:guildId/streaming/removed-history — streamers that were EVER
// announced in this guild but have NO current subscription row. Reconstructs
// from the live_announcements ledger: those rows persist after a subscription
// is deleted, so a (guild_id, streamer_id) pair without a matching subscription
// is "once tracked, now gone."
router.get('/:guildId/streaming/removed-history', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT la.streamer_id,
              s.platform, s.username, s.profile_image_url,
              MAX(la.channel_id)      AS last_channel_id,
              MAX(la.stream_started_at) AS last_live_at,
              COUNT(*)                AS announce_count
         FROM live_announcements la
         JOIN streamers s ON s.streamer_id = la.streamer_id
         LEFT JOIN subscriptions sub
                ON sub.streamer_id = la.streamer_id
               AND sub.guild_id = la.guild_id
        WHERE la.guild_id = ?
          AND sub.subscription_id IS NULL
        GROUP BY la.streamer_id, s.platform, s.username, s.profile_image_url
        ORDER BY last_live_at DESC
        LIMIT 200`,
      [req.guildId]);
    res.json({ history: rows });
  } catch (error) {
    logger.error('[Streaming] removed-history error', { error: error.message, guildId: req.guildId });
    res.status(500).json({ error: 'Could not load removed history.' });
  }
});

// POST /api/guilds/:guildId/streaming/resubscribe body: { streamerId, channelId }
// Creates a FRESH subscription from the last-known channel. Custom message / ping
// role / live role are not recovered — only the (guild, streamer, channel) tuple
// is in the ledger; everything else is lost when the subscription row was deleted.
router.post('/:guildId/streaming/resubscribe', ensureAuth, ensureGuildPerms, async (req, res) => {
  try {
    const streamerId = Number(req.body?.streamerId);
    const channelId = String(req.body?.channelId || '').trim();
    if (!Number.isInteger(streamerId) || streamerId <= 0) {
      return res.status(400).json({ error: 'streamerId must be a positive integer' });
    }
    if (!/^\d{15,25}$/.test(channelId)) {
      return res.status(400).json({ error: 'channelId must be a snowflake' });
    }
    // Guard: don't resubscribe if a row already exists.
    const [existing] = await pool.query(
      'SELECT subscription_id FROM subscriptions WHERE guild_id = ? AND streamer_id = ? LIMIT 1',
      [req.guildId, streamerId]);
    if (existing[0]) {
      return res.json({ success: true, resubscribed: 0, note: 'Subscription already exists.' });
    }
    const [result] = await pool.query(
      `INSERT INTO subscriptions (guild_id, streamer_id, announcement_channel_id, delete_on_end, edit_on_end, tracking_origin, permanent)
       VALUES (?, ?, ?, 0, 1, 'external', 0)`,
      [req.guildId, streamerId, channelId]);
    res.json({ success: true, resubscribed: 1, subscriptionId: result.insertId });
  } catch (error) {
    logger.error('[Streaming] resubscribe error', { error: error.message, guildId: req.guildId });
    res.status(500).json({ error: 'Resubscribe failed.' });
  }
});

export default router;
