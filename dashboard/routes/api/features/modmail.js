/**
 * Modmail dashboard API — mounted at /api/guilds/:guildId/modmail (routes/api/index.js), behind
 * apiCheckGuildAdmin + botContext like every other guild feature router.
 *
 *   PUT    /config                              save modmail_config (form on the Modmail page)
 *   GET    /threads/:threadId/messages          a thread's messages (open or closed)
 *   GET    /threads/:threadId/transcript        JSON transcript; ?format=txt downloads plain text
 *   POST   /threads/:threadId/close             { reason } — closes exactly as the Close button does
 *   POST   /blocked                             { user_id, reason } — block (closes their open thread)
 *   DELETE /blocked/:userId                     unblock
 *
 * Every thread route checks the thread belongs to :guildId, so one guild's admin cannot read
 * another guild's conversations by guessing ids.
 */
import express from 'express';
import { ChannelType } from 'discord.js';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import { invalidate as invalidateFeatureConfig } from '../../../../core/feature-config.js';
import {
    getThread, getTranscript, closeThread, blockUser, unblockUser,
} from '../../../../core/modmail-manager.js';
import { isSnowflake, parseAttachments } from '../../../../core/modmail-format.js';

const router = express.Router({ mergeParams: true });

function clientFor(req) {
    const { guildId } = req.params;
    if (req.botClient?.guilds?.cache?.has(guildId)) return req.botClient;
    return global.botManager?.getClientForGuild?.(guildId) || req.botClient || null;
}

function actor(req) {
    return { id: req.user?.id || null, tag: req.user ? `${req.user.global_name || req.user.username} (dashboard)` : 'dashboard' };
}

async function threadInGuild(req, res) {
    const id = Number(req.params.threadId);
    if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: 'Invalid thread id' });
        return null;
    }
    const thread = await getThread(id);
    if (!thread || thread.guild_id !== req.params.guildId) {
        res.status(404).json({ error: 'Thread not found' });
        return null;
    }
    return thread;
}

function optionalId(v) {
    if (v === undefined || v === null || v === '') return { ok: true, value: null };
    return isSnowflake(String(v)) ? { ok: true, value: String(v) } : { ok: false };
}

function truthy(v) {
    return v === true || v === 1 || v === '1' || v === 'true' || v === 'on';
}

router.put('/config', async (req, res) => {
    const { guildId } = req.params;
    try {
        const body = req.body || {};
        const category = optionalId(body.category_id);
        const logChannel = optionalId(body.log_channel_id);
        const staffRole = optionalId(body.staff_role_id);
        if (!category.ok || !logChannel.ok || !staffRole.ok) {
            return res.status(400).json({ error: 'Category, log channel and staff role must be picked from the lists.' });
        }

        // Check the picks against the live guild when the bot can see it, so a text channel cannot be
        // saved as the category (threads would silently land at the top level).
        const guild = clientFor(req)?.guilds?.cache?.get(guildId);
        if (guild) {
            if (category.value && guild.channels.cache.get(category.value)?.type !== ChannelType.GuildCategory) {
                return res.status(400).json({ error: 'The thread category must be a category.' });
            }
            if (logChannel.value && !guild.channels.cache.get(logChannel.value)?.isTextBased?.()) {
                return res.status(400).json({ error: 'The log channel must be a text channel.' });
            }
            if (staffRole.value && !guild.roles.cache.has(staffRole.value)) {
                return res.status(400).json({ error: 'That staff role no longer exists.' });
            }
        }

        const greeting = typeof body.greeting_message === 'string' && body.greeting_message.trim()
            ? body.greeting_message.trim().slice(0, 2000) : null;
        const closing = typeof body.close_message === 'string' && body.close_message.trim()
            ? body.close_message.trim().slice(0, 2000) : null;

        await pool.execute(
            `INSERT INTO modmail_config
                (guild_id, enabled, category_id, log_channel_id, staff_role_id, greeting_message, close_message, anonymous_replies)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), category_id = VALUES(category_id),
                log_channel_id = VALUES(log_channel_id), staff_role_id = VALUES(staff_role_id),
                greeting_message = VALUES(greeting_message), close_message = VALUES(close_message),
                anonymous_replies = VALUES(anonymous_replies)`,
            [guildId, truthy(body.enabled) ? 1 : 0, category.value, logChannel.value, staffRole.value,
             greeting, closing, truthy(body.anonymous_replies) ? 1 : 0]
        );
        invalidateFeatureConfig('modmail', guildId);
        res.json({ success: true, message: 'Modmail settings saved' });
    } catch (error) {
        logger.error('[API Modmail] Saving config failed', { guildId, error: error.message });
        res.status(500).json({ error: 'Failed to save modmail settings' });
    }
});

router.get('/threads/:threadId/messages', async (req, res) => {
    try {
        const thread = await threadInGuild(req, res);
        if (!thread) return;
        const client = clientFor(req);
        const t = await getTranscript(thread.id, { client, guild: client?.guilds?.cache?.get(thread.guild_id) });
        res.json({ success: true, thread: t.thread, messages: t.messages.map(m => shapeMessage(m, client)) });
    } catch (error) {
        logger.error('[API Modmail] Loading messages failed', { guildId: req.params.guildId, threadId: req.params.threadId, error: error.message });
        res.status(500).json({ error: 'Failed to load messages' });
    }
});

router.get('/threads/:threadId/transcript', async (req, res) => {
    try {
        const thread = await threadInGuild(req, res);
        if (!thread) return;
        const client = clientFor(req);
        const t = await getTranscript(thread.id, { client, guild: client?.guilds?.cache?.get(thread.guild_id) });
        if (req.query.format === 'txt') {
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="modmail-${thread.id}.txt"`);
            return res.send(t.text);
        }
        res.json({ success: true, thread_info: t.thread, messages: t.messages.map(m => shapeMessage(m, client)) });
    } catch (error) {
        logger.error('[API Modmail] Loading transcript failed', { guildId: req.params.guildId, threadId: req.params.threadId, error: error.message });
        res.status(500).json({ error: 'Failed to load transcript' });
    }
});

router.post('/threads/:threadId/close', async (req, res) => {
    try {
        const thread = await threadInGuild(req, res);
        if (!thread) return;
        if (thread.status !== 'open') return res.status(409).json({ error: 'This conversation is already closed.' });
        const client = clientFor(req);
        if (!client) return res.status(503).json({ error: 'The bot is not connected right now.' });
        const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 1000) : null;
        const result = await closeThread({ client, thread, closedBy: actor(req), reason: reason || null });
        if (!result.ok) return res.status(409).json({ error: result.error });
        res.json({ success: true, message: 'Conversation closed' });
    } catch (error) {
        logger.error('[API Modmail] Closing thread failed', { guildId: req.params.guildId, threadId: req.params.threadId, error: error.message });
        res.status(500).json({ error: 'Failed to close the conversation' });
    }
});

router.post('/blocked', async (req, res) => {
    const { guildId } = req.params;
    try {
        const userId = String(req.body?.user_id || '').trim();
        if (!isSnowflake(userId)) return res.status(400).json({ error: 'Enter a valid Discord user ID.' });
        const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 1000) : null;
        await blockUser(guildId, userId, req.user?.id || null, reason || null);

        // A block also ends whatever they have open here.
        const [open] = await pool.execute(
            "SELECT id FROM modmail_threads WHERE guild_id = ? AND user_id = ? AND status = 'open'",
            [guildId, userId]
        );
        const client = clientFor(req);
        for (const row of open) {
            const thread = await getThread(row.id);
            if (thread && client) {
                await closeThread({ client, thread, closedBy: actor(req), reason: 'Member blocked from modmail', shareReason: false })
                    .catch(err => logger.error('[API Modmail] Closing a blocked member\'s thread failed', { threadId: row.id, error: err.message }));
            }
        }
        res.json({ success: true, message: 'User blocked from modmail' });
    } catch (error) {
        logger.error('[API Modmail] Blocking failed', { guildId, error: error.message });
        res.status(500).json({ error: 'Failed to block the user' });
    }
});

router.delete('/blocked/:userId', async (req, res) => {
    const { guildId, userId } = req.params;
    try {
        if (!isSnowflake(String(userId))) return res.status(400).json({ error: 'Invalid user id' });
        const removed = await unblockUser(guildId, String(userId));
        if (!removed) return res.status(404).json({ error: 'That user is not blocked' });
        res.json({ success: true, message: 'User unblocked' });
    } catch (error) {
        logger.error('[API Modmail] Unblocking failed', { guildId, error: error.message });
        res.status(500).json({ error: 'Failed to unblock the user' });
    }
});

function shapeMessage(m, client) {
    const user = client?.users?.cache?.get(String(m.author_id));
    return {
        id: m.id,
        author_id: m.author_id,
        author_name: user ? user.tag : null,
        author_type: m.author_type,
        is_internal: !!Number(m.is_internal),
        is_anonymous: !!Number(m.is_anonymous),
        message_content: m.message_content,
        attachments: parseAttachments(m.attachments),
        timestamp: m.timestamp,
    };
}

export default router;
