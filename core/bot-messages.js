/**
 * bot_messages registry — Sapphire-style universal message editor backing store.
 *
 * recordBotMessage() is called at known template-send chokepoints (log-manager,
 * welcome-manager, stream-live announcer, etc.). listBotMessages() + editBotMessage()
 * power the dashboard /messages page.
 *
 * Writes are fire-and-forget: a failed registry write must never block the
 * actual Discord send. Reads are DB-bound only.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

/**
 * Record a successfully-sent bot message. All params required except sourceJson.
 * @param {{guildId: string, channelId: string, messageId: string, templateKey: string,
 *         feature?: string, sourceJson?: object}} opts
 */
export function recordBotMessage(opts) {
    const guildId    = opts?.guildId     && String(opts.guildId);
    const channelId  = opts?.channelId   && String(opts.channelId);
    const messageId  = opts?.messageId   && String(opts.messageId);
    const templateKey = opts?.templateKey && String(opts.templateKey);
    if (!guildId || !channelId || !messageId || !templateKey) return;
    const feature = opts.feature ? String(opts.feature) : null;
    const srcJson = opts.sourceJson ? JSON.stringify(opts.sourceJson).slice(0, 60_000) : null;
    pool.execute(
        `INSERT INTO bot_messages (guild_id, channel_id, message_id, template_key, feature, source_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE template_key = VALUES(template_key), feature = VALUES(feature), source_json = VALUES(source_json)`,
        [guildId, channelId, messageId, templateKey, feature, srcJson],
    ).catch(err => logger.debug(`[bot-messages] record failed: ${err.message}`));
}

/** List recent bot messages for a guild. */
export async function listBotMessages(guildId, { limit = 50, offset = 0, feature = null } = {}) {
    const where = ['guild_id = ?'];
    const args = [String(guildId)];
    if (feature) { where.push('feature = ?'); args.push(String(feature)); }
    const [rows] = await pool.execute(
        `SELECT id, channel_id, message_id, template_key, feature, source_json,
                last_edited_by, last_edited_at, created_at
           FROM bot_messages
          WHERE ${where.join(' AND ')}
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?`,
        [...args, Math.min(200, Math.max(1, Number(limit) || 50)), Math.max(0, Number(offset) || 0)]);
    return rows;
}

/** Count rows for a guild (dashboard pagination). */
export async function countBotMessages(guildId, { feature = null } = {}) {
    const where = ['guild_id = ?'];
    const args = [String(guildId)];
    if (feature) { where.push('feature = ?'); args.push(String(feature)); }
    const [[row]] = await pool.execute(
        `SELECT COUNT(*) AS n FROM bot_messages WHERE ${where.join(' AND ')}`, args);
    return Number(row?.n || 0);
}

/** Get one record by id (dashboard edit flow). */
export async function getBotMessage(guildId, botMessagesId) {
    const [[row]] = await pool.execute(
        `SELECT id, guild_id, channel_id, message_id, template_key, feature, source_json,
                last_edited_by, last_edited_at, created_at
           FROM bot_messages WHERE id = ? AND guild_id = ?`,
        [Number(botMessagesId), String(guildId)]);
    return row || null;
}

/** Mark edited after a successful Discord-side edit. */
export async function markEdited(botMessagesId, editorUserId) {
    await pool.execute(
        'UPDATE bot_messages SET last_edited_by = ?, last_edited_at = NOW() WHERE id = ?',
        [String(editorUserId), Number(botMessagesId)]);
}

/** Distinct feature list (for the filter dropdown). */
export async function listFeatures(guildId) {
    const [rows] = await pool.execute(
        `SELECT feature, COUNT(*) AS n FROM bot_messages WHERE guild_id = ? AND feature IS NOT NULL
          GROUP BY feature ORDER BY n DESC`, [String(guildId)]);
    return rows;
}
