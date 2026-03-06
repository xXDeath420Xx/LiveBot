import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../../utils/db.js';

export default {
    category: 'tools',
    data: new SlashCommandBuilder()
        .setName('notes')
        .setDescription('Reminders, sticky messages & time capsules')

        // ── Remind Group ──
        .addSubcommandGroup(group =>
            group.setName('remind')
                .setDescription('Set and manage reminders')
                .addSubcommand(sub =>
                    sub.setName('me')
                        .setDescription('Set a reminder for yourself')
                        .addStringOption(opt => opt.setName('time').setDescription('When to remind you (e.g., 5m, 2h, 1d, 1w)').setRequired(true))
                        .addStringOption(opt => opt.setName('message').setDescription('What to remind you about').setRequired(true))
                        .addBooleanOption(opt => opt.setName('dm').setDescription('Send reminder via DM instead of in this channel')))
                .addSubcommand(sub =>
                    sub.setName('list')
                        .setDescription('List all your active reminders'))
                .addSubcommand(sub =>
                    sub.setName('delete')
                        .setDescription('Delete a reminder')
                        .addIntegerOption(opt => opt.setName('id').setDescription('The ID of the reminder to delete').setRequired(true))))

        // ── Sticky Group ──
        .addSubcommandGroup(group =>
            group.setName('sticky')
                .setDescription('Manage sticky messages')
                .addSubcommand(sub =>
                    sub.setName('set')
                        .setDescription('Set a sticky message for this channel')
                        .addStringOption(opt => opt.setName('message').setDescription('Message to sticky').setRequired(true).setMaxLength(2000)))
                .addSubcommand(sub =>
                    sub.setName('remove')
                        .setDescription('Remove sticky message from this channel')))

        // ── Time Capsule Group ──
        .addSubcommandGroup(group =>
            group.setName('timecapsule')
                .setDescription('Create messages that reveal in the future')
                .addSubcommand(sub =>
                    sub.setName('create')
                        .setDescription('Create a time capsule')
                        .addStringOption(opt => opt.setName('message').setDescription('Message to reveal in the future').setRequired(true).setMaxLength(1000))
                        .addStringOption(opt => opt.setName('duration').setDescription('When to reveal').setRequired(true)
                            .addChoices(
                                { name: '1 Day', value: '1d' },
                                { name: '1 Week', value: '1w' },
                                { name: '1 Month', value: '1mo' },
                                { name: '3 Months', value: '3mo' },
                                { name: '6 Months', value: '6mo' },
                                { name: '1 Year', value: '1y' })))
                .addSubcommand(sub =>
                    sub.setName('list')
                        .setDescription('View upcoming time capsules'))),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();

        try {
            if (group === 'remind') {
                return await handleRemind(interaction, subcommand);
            } else if (group === 'sticky') {
                // Permission check — sticky requires ManageMessages
                if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
                    return interaction.reply({ content: '❌ You need the **Manage Messages** permission to use sticky messages.', ephemeral: true });
                }
                return await handleSticky(interaction, subcommand);
            } else if (group === 'timecapsule') {
                return await handleTimeCapsule(interaction, subcommand);
            }
        } catch (error) {
            console.error('[Notes Command Error]', error);
            const method = interaction.deferred || interaction.replied ? 'editReply' : 'reply';
            return interaction[method]({ content: '❌ An error occurred.', ephemeral: true });
        }
    }
};

// ═══════════════════════════════════════════
// Remind Handlers
// ═══════════════════════════════════════════
async function handleRemind(interaction, subcommand) {
    const reminderManager = interaction.client.reminderManager;

    if (!reminderManager) {
        return interaction.reply({ content: 'Reminder system is not available.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    if (subcommand === 'me') {
        const timeStr = interaction.options.getString('time', true);
        const message = interaction.options.getString('message', true);
        const isDm = interaction.options.getBoolean('dm') || false;

        const duration = reminderManager.parseTime(timeStr);

        if (!duration) {
            return interaction.editReply({
                content: 'Invalid time format. Use formats like `5m`, `2h`, `1d`, `1w`.\n\nExamples:\n\u2022 `5m` = 5 minutes\n\u2022 `2h` = 2 hours\n\u2022 `1d` = 1 day\n\u2022 `1w` = 1 week'
            });
        }

        if (duration < 60000) {
            return interaction.editReply({ content: 'Reminder duration must be at least 1 minute.' });
        }

        if (duration > 365 * 24 * 60 * 60 * 1000) {
            return interaction.editReply({ content: 'Reminder duration cannot exceed 1 year.' });
        }

        const result = await reminderManager.createReminder(
            interaction.user.id,
            interaction.guild.id,
            interaction.channel.id,
            message,
            duration,
            isDm
        );

        if (result.success) {
            const embed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle('\u2705 Reminder Set')
                .setDescription(`I'll remind you about:\n\n*${message}*`)
                .addFields(
                    { name: 'When', value: `<t:${Math.floor(result.remindAt.getTime() / 1000)}:R>`, inline: true },
                    { name: 'Location', value: isDm ? 'Direct Message' : 'This Channel', inline: true },
                    { name: 'Reminder ID', value: `#${result.reminderId}`, inline: true }
                )
                .setFooter({ text: 'Use /notes remind list to see all your reminders' })
                .setTimestamp();

            return interaction.editReply({ embeds: [embed] });
        } else {
            return interaction.editReply({ content: `Failed to create reminder: ${result.error}` });
        }

    } else if (subcommand === 'list') {
        const reminders = await reminderManager.getUserReminders(interaction.user.id, interaction.guild.id);

        if (reminders.length === 0) {
            return interaction.editReply({ content: 'You have no active reminders in this server.' });
        }

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('\ud83d\udccb Your Active Reminders')
            .setDescription(reminders.map(r => {
                const timestamp = Math.floor(new Date(r.remind_at).getTime() / 1000);
                const location = r.is_dm ? '\ud83d\udcec DM' : '\ud83d\udcac Channel';
                return `**#${r.id}** - ${location}\n${r.reminder_text}\n\u23f0 <t:${timestamp}:R> (<t:${timestamp}:f>)`;
            }).join('\n\n'))
            .setFooter({ text: `You have ${reminders.length} active reminder${reminders.length !== 1 ? 's' : ''}` })
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });

    } else if (subcommand === 'delete') {
        const reminderId = interaction.options.getInteger('id', true);

        const result = await reminderManager.deleteReminder(reminderId, interaction.user.id);

        if (result.success) {
            return interaction.editReply({ content: `\u2705 Reminder #${reminderId} has been deleted.` });
        } else {
            return interaction.editReply({ content: `\u274c ${result.error}` });
        }
    }
}

// ═══════════════════════════════════════════
// Sticky Handlers
// ═══════════════════════════════════════════
async function handleSticky(interaction, subcommand) {
    if (subcommand === 'set') {
        const message = interaction.options.getString('message');
        await interaction.deferReply({ ephemeral: true });

        const stickyMsg = await interaction.channel.send(message);

        await pool.execute(
            `INSERT INTO sticky_messages (guild_id, channel_id, message_content, last_message_id, created_by)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE message_content = ?, last_message_id = ?`,
            [interaction.guild.id, interaction.channel.id, message, stickyMsg.id, interaction.user.id, message, stickyMsg.id]
        );

        return interaction.editReply({ content: '\u2705 Sticky message set! It will be reposted when new messages are sent.' });

    } else if (subcommand === 'remove') {
        await interaction.deferReply({ ephemeral: true });

        const [result] = await pool.execute(
            'DELETE FROM sticky_messages WHERE guild_id = ? AND channel_id = ?',
            [interaction.guild.id, interaction.channel.id]
        );

        if (result.affectedRows > 0) {
            return interaction.editReply({ content: '\u2705 Sticky message removed from this channel.' });
        } else {
            return interaction.editReply({ content: '\u274c No sticky message set in this channel.' });
        }
    }
}

// ═══════════════════════════════════════════
// Time Capsule Handlers
// ═══════════════════════════════════════════
async function handleTimeCapsule(interaction, subcommand) {
    if (subcommand === 'create') {
        const message = interaction.options.getString('message');
        const duration = interaction.options.getString('duration');

        await interaction.deferReply({ ephemeral: true });

        let revealDate = new Date();
        switch (duration) {
            case '1d': revealDate.setDate(revealDate.getDate() + 1); break;
            case '1w': revealDate.setDate(revealDate.getDate() + 7); break;
            case '1mo': revealDate.setMonth(revealDate.getMonth() + 1); break;
            case '3mo': revealDate.setMonth(revealDate.getMonth() + 3); break;
            case '6mo': revealDate.setMonth(revealDate.getMonth() + 6); break;
            case '1y': revealDate.setFullYear(revealDate.getFullYear() + 1); break;
        }

        await pool.execute(
            `INSERT INTO time_capsules (guild_id, creator_id, channel_id, message_content, reveal_date)
             VALUES (?, ?, ?, ?, ?)`,
            [interaction.guild.id, interaction.user.id, interaction.channel.id, message, revealDate]
        );

        return interaction.editReply({
            content: `\u2705 Time capsule created! It will be revealed <t:${Math.floor(revealDate.getTime() / 1000)}:R>`
        });

    } else if (subcommand === 'list') {
        await interaction.deferReply();

        const [capsules] = await pool.execute(
            `SELECT * FROM time_capsules
             WHERE guild_id = ? AND revealed = FALSE
             ORDER BY reveal_date ASC
             LIMIT 10`,
            [interaction.guild.id]
        );

        if (capsules.length === 0) {
            return interaction.editReply({ content: 'No time capsules scheduled. Create one with `/notes timecapsule create`!' });
        }

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('\u23f0 Upcoming Time Capsules')
            .setTimestamp();

        const capsuleList = await Promise.all(capsules.map(async (capsule) => {
            const creator = await interaction.client.users.fetch(capsule.creator_id).catch(() => null);
            const creatorName = creator ? creator.username : 'Unknown';
            const revealTimestamp = Math.floor(new Date(capsule.reveal_date).getTime() / 1000);
            return `**By ${creatorName}**\nReveals <t:${revealTimestamp}:R>`;
        }));

        embed.setDescription(capsuleList.join('\n\n'));

        return interaction.editReply({ embeds: [embed] });
    }
}
