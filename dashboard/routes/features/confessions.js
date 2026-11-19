import express from 'express';
import { PermissionFlagsBits } from 'discord.js';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

const router = express.Router();

/*
 * Confession senders (confession_senders, migration 431) are shown only to server admins: the
 * owner, members with Administrator, and bot super-admins. Manage Server and bot-manager roles
 * can run the page but not reveal. Rows older than 30 days are ignored here even if the nightly
 * retention sweep has not removed them yet.
 */
const SENDER_DAYS = 30;
let senderTable = null; // true once confession_senders exists (cached; false is re-checked)

async function senderTableReady() {
  if (senderTable) return true;
  const [rows] = await pool.execute(
    "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'confession_senders'");
  senderTable = rows.length > 0;
  return senderTable;
}

export async function isServerAdmin(req, guildId) {
  if (req.isSuperAdmin) return true;
  const guild = req.guildObject || global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId);
  if (!guild || !req.user?.id) return false;
  if (guild.ownerId === req.user.id) return true;
  const member = await guild.members.fetch(req.user.id).catch(() => null);
  return !!member?.permissions?.has(PermissionFlagsBits.Administrator);
}

/** Confession rows for the page, with sender_available (never the sender) when the table exists. */
async function listConfessions(where, params, tail) {
  if (await senderTableReady()) {
    const [rows] = await pool.execute(
      `SELECT c.*, (s.confession_id IS NOT NULL) AS sender_available
         FROM confessions c
         LEFT JOIN confession_senders s
           ON s.confession_id = c.id AND s.created_at > NOW() - INTERVAL ${SENDER_DAYS} DAY
        WHERE ${where} ${tail}`, params);
    return rows;
  }
  const [rows] = await pool.execute(`SELECT c.* FROM confessions c WHERE ${where} ${tail}`, params);
  return rows;
}

// Get confession settings
router.get('/manage/:guildId/confessions', async (req, res) => {
  try {
    const { guildId } = req.params;

    // Get confession config
    const [[config]] = await pool.execute(
      'SELECT * FROM confession_config WHERE guild_id = ?',
      [guildId]
    );

    // Get pending confessions if approval is enabled
    let pendingConfessions = [];
    if (config && config.require_approval) {
      pendingConfessions = await listConfessions(
        'c.guild_id = ? AND c.approved = 0 AND c.message_id IS NULL', [guildId], 'ORDER BY c.submitted_at DESC');
    }

    // Recent decisions: approved and rejected
    const recentConfessions = await listConfessions(
      'c.guild_id = ? AND c.approved <> 0', [guildId], 'ORDER BY c.submitted_at DESC LIMIT 20');

    res.json({
      config: config || {
        enabled: false,
        require_approval: true,
        min_length: 10,
        max_length: 1000,
        cooldown_minutes: 5
      },
      pendingConfessions,
      recentConfessions,
      canRevealSender: await isServerAdmin(req, guildId),
      senderDays: SENDER_DAYS
    });
  } catch (error) {
    logger.error('[Dashboard] Error fetching confession settings', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch confession settings' });
  }
});

// Update confession settings
router.post('/manage/:guildId/confessions/config', async (req, res) => {
  try {
    const { guildId } = req.params;
    const body = req.body || {};

    // Partial update: the page only sends channel_id / require_approval / mod_channel_id, so
    // write just the fields that arrived. Omitted ones keep their stored value (or the column
    // default on first insert) instead of binding `undefined`, which mysql2 rejects outright.
    const normalizers = {
      enabled: v => (v ? 1 : 0),
      require_approval: v => (v ? 1 : 0),
      channel_id: v => (v ? String(v) : null),
      mod_channel_id: v => (v ? String(v) : null),
      // Discord's modal limits: at most 4000 characters, and the minimum never above the maximum.
      min_length: v => (v === null || v === '' ? null : Math.min(Math.max(1, Math.round(Number(v)) || 10), 1000, Math.max(10, Math.min(4000, Math.round(Number(body.max_length)) || 4000)))),
      max_length: v => (v === null || v === '' ? null : Math.max(10, Math.min(4000, Math.round(Number(v)) || 1000))),
      // Minutes between one member's confessions; 0 turns the wait off. At most a day.
      cooldown_minutes: v => (v === null || v === '' ? null : Math.min(Math.max(Math.round(Number(v)) || 0, 0), 1440))
    };
    const columns = Object.keys(normalizers).filter(k => body[k] !== undefined);
    if (!columns.length) {
      return res.status(400).json({ error: 'No settings provided' });
    }

    await pool.execute(
      `INSERT INTO confession_config (guild_id, ${columns.join(', ')})
       VALUES (?, ${columns.map(() => '?').join(', ')})
       ON DUPLICATE KEY UPDATE ${columns.map(c => `${c} = VALUES(${c})`).join(', ')}`,
      [guildId, ...columns.map(c => normalizers[c](body[c]))]
    );
    // /confess appears in this server once confessions are on, and goes when they are off.
    import('../../../core/guild-shortcuts.js').then(m => m.refreshSoon(guildId)).catch(() => {});

    res.json({ success: true });
  } catch (error) {
    logger.error('[Dashboard] Error updating confession settings', { error: error.message });
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Approve confession: posts it to the confession channel (the same anonymous post /confess makes
// when no approval is needed) and records the message, so it is not posted twice.
router.post('/manage/:guildId/confessions/:confessionId/approve', async (req, res) => {
  try {
    const { guildId, confessionId } = req.params;

    const [[row]] = await pool.execute('SELECT * FROM confessions WHERE id = ? AND guild_id = ?', [confessionId, guildId]);
    if (!row) return res.status(404).json({ error: 'That confession no longer exists.' });
    if (!row.message_id) {
      const [[config]] = await pool.execute('SELECT channel_id FROM confession_config WHERE guild_id = ?', [guildId]);
      const guild = global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId);
      if (!guild) return res.status(503).json({ error: 'The bot is not connected to this server right now.' });
      const channel = guild.channels.cache.get(config?.channel_id || row.channel_id);
      if (!channel?.isTextBased?.()) return res.status(400).json({ error: 'The confession channel is gone. Choose another one and save first.' });
      const { confessionEmbed } = await import('../../../commands/fun/fun-confess-handler.js');
      const message = await channel.send({ embeds: [confessionEmbed(guildId, row.confession_number, row.content)] });
      await pool.execute('UPDATE confessions SET approved = 1, message_id = ? WHERE id = ? AND guild_id = ?', [message.id, confessionId, guildId]);
    } else {
      await pool.execute('UPDATE confessions SET approved = 1 WHERE id = ? AND guild_id = ?', [confessionId, guildId]);
    }

    res.json({ success: true });
  } catch (error) {
    logger.error('[Dashboard] Error approving confession', { error: error.message });
    res.status(500).json({ error: 'Failed to approve confession' });
  }
});

// Reveal who sent a confession: server admins only, each reveal written to audit_logs first.
// The audit row names the admin and the confession, never the sender, so the sender still
// disappears with the 30-day retention.
router.post('/manage/:guildId/confessions/:confessionId/sender', async (req, res) => {
  try {
    const { guildId, confessionId } = req.params;
    if (!/^\d{1,20}$/.test(String(confessionId))) return res.status(400).json({ error: 'Unknown confession.' });
    if (!(await isServerAdmin(req, guildId))) {
      return res.status(403).json({ error: 'Only server admins can see who sent a confession.' });
    }
    if (!(await senderTableReady())) return res.status(410).json({ error: 'Senders are not recorded yet on this server.' });

    const [[row]] = await pool.execute(
      `SELECT c.id, c.confession_number, s.user_id
         FROM confessions c
         LEFT JOIN confession_senders s
           ON s.confession_id = c.id AND s.created_at > NOW() - INTERVAL ${SENDER_DAYS} DAY
        WHERE c.id = ? AND c.guild_id = ?`,
      [confessionId, guildId]
    );
    if (!row) return res.status(404).json({ error: 'That confession no longer exists.' });
    if (!row.user_id) return res.status(410).json({ error: `The sender is no longer kept (senders are kept for ${SENDER_DAYS} days).` });

    await pool.execute(
      `INSERT INTO audit_logs (guild_id, event_type, user_id, moderator_id, action, reason, metadata)
       VALUES (?, 'confession_sender_revealed', ?, ?, 'Confession sender revealed', ?, ?)`,
      [guildId, req.user.id, req.user.id, `Confession #${row.confession_number} sender viewed on the dashboard`,
       JSON.stringify({ confession_id: Number(row.id), confession_number: row.confession_number, via: 'dashboard' })]
    );

    const guild = req.guildObject || global.botManager?.getClientForGuild?.(guildId)?.guilds.cache.get(guildId);
    const member = guild ? await guild.members.fetch(row.user_id).catch(() => null) : null;
    const name = member ? `${member.displayName} (@${member.user.username})` : null;
    logger.info('[Dashboard] Confession sender revealed', { guildId, confessionId: Number(row.id), adminId: req.user.id });
    res.json({ sender: { id: String(row.user_id), name } });
  } catch (error) {
    logger.error('[Dashboard] Error revealing a confession sender', { error: error.message });
    res.status(500).json({ error: 'Could not look up the sender.' });
  }
});

// Reject confession
router.post('/manage/:guildId/confessions/:confessionId/reject', async (req, res) => {
  try {
    const { guildId, confessionId } = req.params;

    await pool.execute(
      'UPDATE confessions SET approved = -1 WHERE id = ? AND guild_id = ?',
      [confessionId, guildId]
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('[Dashboard] Error rejecting confession', { error: error.message });
    res.status(500).json({ error: 'Failed to reject confession' });
  }
});

export default router;
