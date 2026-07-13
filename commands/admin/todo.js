import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

/**
 * Build the task list embed from DB data
 */
async function buildTodoEmbed(listId, title) {
    const [items] = await pool.execute(
        'SELECT id, task, completed, added_by, completed_by, position FROM todo_items WHERE list_id = ? ORDER BY position ASC',
        [listId]
    );

    const embed = new EmbedBuilder()
        .setTitle(title || 'Task List')
        .setColor(items.some(i => !i.completed) ? 0xFBBF24 : 0x23F56B)
        .setTimestamp();

    if (items.length === 0) {
        embed.setDescription('*No tasks yet. Use `/todo add` to create one.*');
    } else {
        const lines = items.map((item, idx) => {
            const emoji = item.completed ? '✅' : '⏳';
            const text = item.completed ? `~~${item.task}~~` : item.task;
            return `${idx + 1}. ${emoji} ${text}`;
        });
        embed.setDescription(lines.join('\n'));

        const completed = items.filter(i => i.completed).length;
        const total = items.length;
        embed.setFooter({ text: `${completed}/${total} completed` });
    }

    return embed;
}

/**
 * Update the persistent embed message in the channel
 */
async function updateTodoMessage(client, list) {
    try {
        const embed = await buildTodoEmbed(list.id, list.title);
        const channel = await client.channels.fetch(list.channel_id).catch(() => null);
        if (!channel) return;

        if (list.message_id) {
            try {
                const msg = await channel.messages.fetch(list.message_id);
                await msg.edit({ embeds: [embed] });
                return;
            } catch {
                // Message deleted — will re-send below
            }
        }

        // Send new message and save ID
        const newMsg = await channel.send({ embeds: [embed] });
        await pool.execute('UPDATE todo_lists SET message_id = ? WHERE id = ?', [newMsg.id, list.id]);
        list.message_id = newMsg.id;
    } catch (err) {
        logger.error('[Todo] Failed to update embed:', { error: err.message, listId: list.id });
    }
}

export default {
    data: new SlashCommandBuilder()
        .setName('todo')
        .setDescription('Manage a task list with a live-updating embed')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addSubcommand(sub => sub
            .setName('create')
            .setDescription('Create a new task list in this channel')
            .addStringOption(opt => opt.setName('title').setDescription('Title for the task list').setRequired(false))
        )
        .addSubcommand(sub => sub
            .setName('add')
            .setDescription('Add a task to the list')
            .addStringOption(opt => opt.setName('task').setDescription('The task to add').setRequired(true))
        )
        .addSubcommand(sub => sub
            .setName('done')
            .setDescription('Mark a task as complete')
            .addIntegerOption(opt => opt.setName('number').setDescription('Task number').setRequired(true).setMinValue(1))
        )
        .addSubcommand(sub => sub
            .setName('undo')
            .setDescription('Mark a completed task as incomplete')
            .addIntegerOption(opt => opt.setName('number').setDescription('Task number').setRequired(true).setMinValue(1))
        )
        .addSubcommand(sub => sub
            .setName('remove')
            .setDescription('Remove a task from the list')
            .addIntegerOption(opt => opt.setName('number').setDescription('Task number').setRequired(true).setMinValue(1))
        )
        .addSubcommand(sub => sub
            .setName('clear')
            .setDescription('Clear all completed tasks')
        )
        .addSubcommand(sub => sub
            .setName('reset')
            .setDescription('Delete the entire task list')
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        const guildId = interaction.guildId;
        const channelId = interaction.channelId;
        const userId = interaction.user.id;

        if (sub === 'create') {
            const title = interaction.options.getString('title') || 'Task List';

            // Check if list already exists in this channel
            const [existing] = await pool.execute(
                'SELECT id FROM todo_lists WHERE guild_id = ? AND channel_id = ?', [guildId, channelId]
            );
            if (existing.length > 0) {
                return interaction.reply({ content: 'A task list already exists in this channel. Use `/todo add` to add tasks.', ephemeral: true });
            }

            const [result] = await pool.execute(
                'INSERT INTO todo_lists (guild_id, channel_id, title, created_by) VALUES (?, ?, ?, ?)',
                [guildId, channelId, title, userId]
            );

            const list = { id: result.insertId, guild_id: guildId, channel_id: channelId, title, message_id: null };
            await updateTodoMessage(interaction.client, list);

            return interaction.reply({ content: `Task list **${title}** created!`, ephemeral: true });
        }

        // All other subcommands need an existing list
        const [lists] = await pool.execute(
            'SELECT * FROM todo_lists WHERE guild_id = ? AND channel_id = ?', [guildId, channelId]
        );
        if (lists.length === 0) {
            return interaction.reply({ content: 'No task list in this channel. Use `/todo create` first.', ephemeral: true });
        }
        const list = lists[0];

        if (sub === 'add') {
            const task = interaction.options.getString('task');

            // Get next position
            const [maxPos] = await pool.execute(
                'SELECT COALESCE(MAX(position), 0) + 1 AS next_pos FROM todo_items WHERE list_id = ?', [list.id]
            );

            await pool.execute(
                'INSERT INTO todo_items (list_id, task, position, added_by) VALUES (?, ?, ?, ?)',
                [list.id, task, maxPos[0].next_pos, userId]
            );

            await updateTodoMessage(interaction.client, list);
            return interaction.reply({ content: `Added: **${task}**`, ephemeral: true });
        }

        if (sub === 'done') {
            const num = interaction.options.getInteger('number');
            const [items] = await pool.execute(
                'SELECT id FROM todo_items WHERE list_id = ? ORDER BY position ASC', [list.id]
            );
            if (num > items.length || num < 1) {
                return interaction.reply({ content: `Invalid task number. There are ${items.length} tasks.`, ephemeral: true });
            }

            const item = items[num - 1];
            await pool.execute(
                'UPDATE todo_items SET completed = 1, completed_by = ?, completed_at = NOW() WHERE id = ?',
                [userId, item.id]
            );

            await updateTodoMessage(interaction.client, list);
            return interaction.reply({ content: `Marked task #${num} as complete ✅`, ephemeral: true });
        }

        if (sub === 'undo') {
            const num = interaction.options.getInteger('number');
            const [items] = await pool.execute(
                'SELECT id FROM todo_items WHERE list_id = ? ORDER BY position ASC', [list.id]
            );
            if (num > items.length || num < 1) {
                return interaction.reply({ content: `Invalid task number. There are ${items.length} tasks.`, ephemeral: true });
            }

            const item = items[num - 1];
            await pool.execute(
                'UPDATE todo_items SET completed = 0, completed_by = NULL, completed_at = NULL WHERE id = ?',
                [item.id]
            );

            await updateTodoMessage(interaction.client, list);
            return interaction.reply({ content: `Marked task #${num} as incomplete ⏳`, ephemeral: true });
        }

        if (sub === 'remove') {
            const num = interaction.options.getInteger('number');
            const [items] = await pool.execute(
                'SELECT id, task FROM todo_items WHERE list_id = ? ORDER BY position ASC', [list.id]
            );
            if (num > items.length || num < 1) {
                return interaction.reply({ content: `Invalid task number. There are ${items.length} tasks.`, ephemeral: true });
            }

            const item = items[num - 1];
            await pool.execute('DELETE FROM todo_items WHERE id = ?', [item.id]);

            // Re-number positions
            const [remaining] = await pool.execute(
                'SELECT id FROM todo_items WHERE list_id = ? ORDER BY position ASC', [list.id]
            );
            for (let i = 0; i < remaining.length; i++) {
                await pool.execute('UPDATE todo_items SET position = ? WHERE id = ?', [i + 1, remaining[i].id]);
            }

            await updateTodoMessage(interaction.client, list);
            return interaction.reply({ content: `Removed task: **${item.task}**`, ephemeral: true });
        }

        if (sub === 'clear') {
            const [result] = await pool.execute(
                'DELETE FROM todo_items WHERE list_id = ? AND completed = 1', [list.id]
            );

            // Re-number remaining
            const [remaining] = await pool.execute(
                'SELECT id FROM todo_items WHERE list_id = ? ORDER BY position ASC', [list.id]
            );
            for (let i = 0; i < remaining.length; i++) {
                await pool.execute('UPDATE todo_items SET position = ? WHERE id = ?', [i + 1, remaining[i].id]);
            }

            await updateTodoMessage(interaction.client, list);
            return interaction.reply({ content: `Cleared ${result.affectedRows} completed task(s)`, ephemeral: true });
        }

        if (sub === 'reset') {
            // Delete the embed message
            if (list.message_id) {
                try {
                    const channel = await interaction.client.channels.fetch(list.channel_id);
                    const msg = await channel.messages.fetch(list.message_id);
                    await msg.delete();
                } catch { /* message already gone */ }
            }

            await pool.execute('DELETE FROM todo_lists WHERE id = ?', [list.id]);
            return interaction.reply({ content: 'Task list deleted.', ephemeral: true });
        }
    }
};
