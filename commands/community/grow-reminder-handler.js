import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

const REMINDER_TYPES = {
    water: { emoji: '', name: 'Water', color: '#3498DB' },
    feed: { emoji: '', name: 'Feed/Nutrients', color: '#27AE60' },
    check: { emoji: '', name: 'Check Plants', color: '#9B59B6' },
    defoliate: { emoji: '', name: 'Defoliate', color: '#2ECC71' },
    train: { emoji: '', name: 'Training (LST/HST)', color: '#E67E22' },
    flip: { emoji: '', name: 'Flip to Flower', color: '#FF69B4' },
    harvest: { emoji: '', name: 'Harvest Check', color: '#F1C40F' },
    custom: { emoji: '', name: 'Custom', color: '#95A5A6' }
};

function parseTime(timeStr) {
    const now = new Date();
    let totalMs = 0;

    const hourMatch = timeStr.match(/(\d+)\s*h(our)?s?/i);
    const dayMatch = timeStr.match(/(\d+)\s*d(ay)?s?/i);
    const minMatch = timeStr.match(/(\d+)\s*m(in(ute)?)?s?/i);

    if (hourMatch) totalMs += parseInt(hourMatch[1]) * 60 * 60 * 1000;
    if (dayMatch) totalMs += parseInt(dayMatch[1]) * 24 * 60 * 60 * 1000;
    if (minMatch) totalMs += parseInt(minMatch[1]) * 60 * 1000;

    if (timeStr.toLowerCase().includes('tomorrow')) {
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const timeMatch = timeStr.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
        if (timeMatch) {
            let hours = parseInt(timeMatch[1]);
            const minutes = parseInt(timeMatch[2] || 0);
            const period = timeMatch[3]?.toLowerCase();

            if (period === 'pm' && hours < 12) hours += 12;
            if (period === 'am' && hours === 12) hours = 0;

            tomorrow.setHours(hours, minutes, 0, 0);
        } else {
            tomorrow.setHours(9, 0, 0, 0);
        }

        return tomorrow;
    }

    if (totalMs > 0) {
        return new Date(now.getTime() + totalMs);
    }

    return new Date(now.getTime() + 60 * 60 * 1000);
}

export async function handleReminderSet(interaction) {
    const reminderType = interaction.options.getString('type');
    const timeStr = interaction.options.getString('time');
    const repeatHours = parseInt(interaction.options.getString('repeat') || '0');
    const customMessage = interaction.options.getString('message');
    const useDm = interaction.options.getBoolean('dm') || false;
    const journalId = interaction.options.getInteger('journal');

    if (reminderType === 'custom' && !customMessage) {
        return interaction.reply({
            content: 'Custom reminders require a message.',
            ephemeral: true
        });
    }

    const [existing] = await pool.execute(
        'SELECT COUNT(*) as count FROM grow_reminders WHERE user_id = ? AND is_active = TRUE',
        [interaction.user.id]
    );

    if (existing[0].count >= 10) {
        return interaction.reply({
            content: 'You can only have 10 active reminders. Delete some old ones first.',
            ephemeral: true
        });
    }

    const nextReminder = parseTime(timeStr);

    if (nextReminder <= new Date()) {
        return interaction.reply({
            content: 'The reminder time must be in the future.',
            ephemeral: true
        });
    }

    if (journalId) {
        const [journal] = await pool.execute(
            'SELECT id FROM grow_journals WHERE id = ? AND user_id = ?',
            [journalId, interaction.user.id]
        );
        if (journal.length === 0) {
            return interaction.reply({
                content: 'Journal not found or you don\'t own it.',
                ephemeral: true
            });
        }
    }

    const { EmbedBuilder } = await import('discord.js');

    const [result] = await pool.execute(
        `INSERT INTO grow_reminders
        (guild_id, user_id, journal_id, reminder_type, custom_message, next_reminder, repeat_interval_hours, channel_id, use_dm)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            interaction.guild.id,
            interaction.user.id,
            journalId,
            reminderType,
            customMessage,
            nextReminder,
            repeatHours || null,
            useDm ? null : interaction.channelId,
            useDm
        ]
    );

    const reminderId = result.insertId;
    const typeInfo = REMINDER_TYPES[reminderType];

    const embed = new EmbedBuilder()
        .setColor(typeInfo.color)
        .setTitle(`${typeInfo.emoji} Reminder Set!`)
        .setDescription(customMessage || `You'll be reminded to **${typeInfo.name}**`)
        .addFields(
            { name: 'Next Reminder', value: `<t:${Math.floor(nextReminder.getTime() / 1000)}:R>`, inline: true },
            { name: 'Delivery', value: useDm ? 'DM' : `<#${interaction.channelId}>`, inline: true }
        )
        .setFooter({ text: `Reminder ID: ${reminderId}` })
        .setTimestamp();

    if (repeatHours > 0) {
        const repeatText = repeatHours === 24 ? 'Daily' :
                          repeatHours === 168 ? 'Weekly' :
                          `Every ${repeatHours} hours`;
        embed.addFields({ name: 'Repeat', value: repeatText, inline: true });
    }

    await interaction.reply({ embeds: [embed], ephemeral: true });

    logger.info('[GrowReminder] Reminder created', {
        reminderId,
        userId: interaction.user.id,
        type: reminderType,
        nextReminder: nextReminder.toISOString()
    });
}

export async function handleReminderList(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const { EmbedBuilder } = await import('discord.js');

    const [reminders] = await pool.execute(
        `SELECT gr.*, gj.title as journal_title
         FROM grow_reminders gr
         LEFT JOIN grow_journals gj ON gr.journal_id = gj.id
         WHERE gr.user_id = ?
         ORDER BY gr.is_active DESC, gr.next_reminder ASC
         LIMIT 15`,
        [interaction.user.id]
    );

    if (reminders.length === 0) {
        return interaction.editReply({
            content: 'You have no reminders. Use `/grow reminder set` to create one!'
        });
    }

    const embed = new EmbedBuilder()
        .setColor('#27AE60')
        .setTitle(' Your Grow Reminders')
        .setTimestamp();

    let description = '';
    for (const r of reminders) {
        const typeInfo = REMINDER_TYPES[r.reminder_type];
        const status = r.is_active ? '' : '';
        const time = Math.floor(new Date(r.next_reminder).getTime() / 1000);

        description += `${status} **#${r.id}** ${typeInfo.emoji} ${typeInfo.name}\n`;
        description += `Next: <t:${time}:R>`;
        if (r.repeat_interval_hours) {
            description += ` | Repeats: ${r.repeat_interval_hours}h`;
        }
        if (r.journal_title) {
            description += `\nLinked: ${r.journal_title}`;
        }
        if (r.custom_message) {
            description += `\n"${r.custom_message.substring(0, 50)}..."`;
        }
        description += '\n\n';
    }

    embed.setDescription(description);
    embed.setFooter({ text: 'Use /grow reminder delete <id> to remove' });

    await interaction.editReply({ embeds: [embed] });
}

export async function handleReminderDelete(interaction) {
    const reminderId = interaction.options.getInteger('id');

    const [reminder] = await pool.execute(
        'SELECT * FROM grow_reminders WHERE id = ? AND user_id = ?',
        [reminderId, interaction.user.id]
    );

    if (reminder.length === 0) {
        return interaction.reply({
            content: 'Reminder not found or you don\'t own it.',
            ephemeral: true
        });
    }

    await pool.execute('DELETE FROM grow_reminders WHERE id = ?', [reminderId]);

    await interaction.reply({
        content: ` Reminder #${reminderId} deleted.`,
        ephemeral: true
    });

    logger.info('[GrowReminder] Reminder deleted', {
        reminderId,
        userId: interaction.user.id
    });
}

export async function handleReminderPause(interaction) {
    const reminderId = interaction.options.getInteger('id');

    const [reminder] = await pool.execute(
        'SELECT * FROM grow_reminders WHERE id = ? AND user_id = ?',
        [reminderId, interaction.user.id]
    );

    if (reminder.length === 0) {
        return interaction.reply({
            content: 'Reminder not found or you don\'t own it.',
            ephemeral: true
        });
    }

    const newStatus = !reminder[0].is_active;

    await pool.execute(
        'UPDATE grow_reminders SET is_active = ? WHERE id = ?',
        [newStatus, reminderId]
    );

    await interaction.reply({
        content: `Reminder #${reminderId} is now **${newStatus ? 'active' : 'paused'}**.`,
        ephemeral: true
    });
}

export async function handleReminderSnooze(interaction) {
    const reminderId = interaction.options.getInteger('id');
    const hours = parseInt(interaction.options.getString('duration'));

    const [reminder] = await pool.execute(
        'SELECT * FROM grow_reminders WHERE id = ? AND user_id = ?',
        [reminderId, interaction.user.id]
    );

    if (reminder.length === 0) {
        return interaction.reply({
            content: 'Reminder not found or you don\'t own it.',
            ephemeral: true
        });
    }

    const newTime = new Date(Date.now() + hours * 60 * 60 * 1000);

    await pool.execute(
        'UPDATE grow_reminders SET next_reminder = ? WHERE id = ?',
        [newTime, reminderId]
    );

    await interaction.reply({
        content: ` Reminder #${reminderId} snoozed until <t:${Math.floor(newTime.getTime() / 1000)}:R>.`,
        ephemeral: true
    });
}
