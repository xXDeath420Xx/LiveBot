import express from 'express';
import pool from '../../../../utils/db.js';
import logger from '../../../../utils/logger.js';
import { EmbedBuilder } from 'discord.js';

const router = express.Router({ mergeParams: true });

/**
 * Build and update the Discord embed for a todo list
 */
async function updateTodoEmbed(guildId, listId) {
    try {
        const [lists] = await pool.execute('SELECT * FROM todo_lists WHERE id = ?', [listId]);
        if (!lists.length) return;
        const list = lists[0];

        const [items] = await pool.execute(
            'SELECT task, completed FROM todo_items WHERE list_id = ? ORDER BY position ASC', [listId]
        );

        const embed = new EmbedBuilder()
            .setTitle(list.title || 'Task List')
            .setColor(items.some(i => !i.completed) ? 0xFBBF24 : 0x23F56B)
            .setTimestamp();

        if (items.length === 0) {
            embed.setDescription('*No tasks yet.*');
        } else {
            const lines = items.map((item, idx) => {
                const emoji = item.completed ? '\u2705' : '\u23F3';
                const text = item.completed ? `~~${item.task}~~` : item.task;
                return `${idx + 1}. ${emoji} ${text}`;
            });
            embed.setDescription(lines.join('\n'));
            const completed = items.filter(i => i.completed).length;
            embed.setFooter({ text: `${completed}/${items.length} completed` });
        }

        const botClient = global.botManager?.getClientForGuild(guildId) || global.botManager?.getDefaultClient();
        if (!botClient) return;

        const channel = await botClient.channels.fetch(list.channel_id).catch(() => null);
        if (!channel) return;

        if (list.message_id) {
            try {
                const msg = await channel.messages.fetch(list.message_id);
                await msg.edit({ embeds: [embed] });
                return;
            } catch { /* message gone */ }
        }

        const newMsg = await channel.send({ embeds: [embed] });
        await pool.execute('UPDATE todo_lists SET message_id = ? WHERE id = ?', [newMsg.id, listId]);
    } catch (err) {
        logger.error('[Todo API] Embed update failed:', { error: err.message, listId });
    }
}

// GET / — list all todo lists for guild
router.get('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const [lists] = await pool.execute('SELECT * FROM todo_lists WHERE guild_id = ? ORDER BY created_at DESC', [guildId]);

        const botClient = global.botManager?.getClientForGuild(guildId) || global.botManager?.getDefaultClient();
        const guild = botClient?.guilds?.cache?.get(guildId);

        for (const list of lists) {
            const [items] = await pool.execute(
                'SELECT id, task, completed, position FROM todo_items WHERE list_id = ? ORDER BY position ASC', [list.id]
            );
            list.items = items;
            list.channel_name = guild?.channels?.cache?.get(list.channel_id)?.name || null;
        }

        res.json({ success: true, lists });
    } catch (err) {
        logger.error('[Todo API] List error:', { error: err.message });
        res.status(500).json({ error: 'Failed to load lists' });
    }
});

// POST / — create a new list
router.post('/', async (req, res) => {
    try {
        const { guildId } = req.params;
        const { title, channel_id } = req.body;
        if (!channel_id) return res.status(400).json({ error: 'Channel required' });

        const [existing] = await pool.execute(
            'SELECT id FROM todo_lists WHERE guild_id = ? AND channel_id = ?', [guildId, channel_id]
        );
        if (existing.length) return res.status(400).json({ error: 'List already exists in that channel' });

        const [result] = await pool.execute(
            'INSERT INTO todo_lists (guild_id, channel_id, title, created_by) VALUES (?, ?, ?, ?)',
            [guildId, channel_id, title || 'Task List', req.user?.id || 'dashboard']
        );

        await updateTodoEmbed(guildId, result.insertId);
        res.json({ success: true, id: result.insertId });
    } catch (err) {
        logger.error('[Todo API] Create error:', { error: err.message });
        res.status(500).json({ error: 'Failed to create list' });
    }
});

// DELETE /:listId — delete a list
router.delete('/:listId', async (req, res) => {
    try {
        const { guildId, listId } = req.params;
        const [lists] = await pool.execute('SELECT * FROM todo_lists WHERE id = ? AND guild_id = ?', [listId, guildId]);
        if (!lists.length) return res.status(404).json({ error: 'List not found' });

        // Delete the embed message
        if (lists[0].message_id) {
            try {
                const botClient = global.botManager?.getClientForGuild(guildId) || global.botManager?.getDefaultClient();
                const channel = await botClient?.channels?.fetch(lists[0].channel_id);
                const msg = await channel?.messages?.fetch(lists[0].message_id);
                await msg?.delete();
            } catch { /* already gone */ }
        }

        await pool.execute('DELETE FROM todo_lists WHERE id = ?', [listId]);
        res.json({ success: true });
    } catch (err) {
        logger.error('[Todo API] Delete error:', { error: err.message });
        res.status(500).json({ error: 'Failed to delete list' });
    }
});

// POST /:listId/items — add an item
router.post('/:listId/items', async (req, res) => {
    try {
        const { guildId, listId } = req.params;
        const { task } = req.body;
        if (!task) return res.status(400).json({ error: 'Task required' });

        const [maxPos] = await pool.execute(
            'SELECT COALESCE(MAX(position), 0) + 1 AS next FROM todo_items WHERE list_id = ?', [listId]
        );
        await pool.execute(
            'INSERT INTO todo_items (list_id, task, position, added_by) VALUES (?, ?, ?, ?)',
            [listId, task, maxPos[0].next, req.user?.id || 'dashboard']
        );

        await updateTodoEmbed(guildId, listId);
        res.json({ success: true });
    } catch (err) {
        logger.error('[Todo API] Add item error:', { error: err.message });
        res.status(500).json({ error: 'Failed to add item' });
    }
});

// PATCH /:listId/items/:itemId — toggle complete
router.patch('/:listId/items/:itemId', async (req, res) => {
    try {
        const { guildId, listId, itemId } = req.params;
        const { completed } = req.body;
        await pool.execute(
            'UPDATE todo_items SET completed = ?, completed_by = ?, completed_at = ? WHERE id = ? AND list_id = ?',
            [completed ? 1 : 0, completed ? (req.user?.id || 'dashboard') : null, completed ? new Date() : null, itemId, listId]
        );

        await updateTodoEmbed(guildId, listId);
        res.json({ success: true });
    } catch (err) {
        logger.error('[Todo API] Toggle error:', { error: err.message });
        res.status(500).json({ error: 'Failed to update item' });
    }
});

// DELETE /:listId/items/:itemId — remove an item
router.delete('/:listId/items/:itemId', async (req, res) => {
    try {
        const { guildId, listId, itemId } = req.params;
        await pool.execute('DELETE FROM todo_items WHERE id = ? AND list_id = ?', [itemId, listId]);

        // Re-number positions
        const [remaining] = await pool.execute(
            'SELECT id FROM todo_items WHERE list_id = ? ORDER BY position ASC', [listId]
        );
        for (let i = 0; i < remaining.length; i++) {
            await pool.execute('UPDATE todo_items SET position = ? WHERE id = ?', [i + 1, remaining[i].id]);
        }

        await updateTodoEmbed(guildId, listId);
        res.json({ success: true });
    } catch (err) {
        logger.error('[Todo API] Remove error:', { error: err.message });
        res.status(500).json({ error: 'Failed to remove item' });
    }
});

export default router;
