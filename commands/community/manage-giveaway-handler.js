import { EmbedBuilder } from 'discord.js';
import GiveawayManager from '../../core/giveaway-manager.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { formatDuration } from '../../utils/timeParser.js';

let giveawayManager = null;

function getManager(client) {
    if (!giveawayManager) {
        giveawayManager = new GiveawayManager(client);
    }
    return giveawayManager;
}

export async function handleStart(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const mgr = getManager(interaction.client);
    const prize = interaction.options.getString('prize');
    const winners = interaction.options.getInteger('winners');

    const months = interaction.options.getInteger('months') || 0;
    const weeks = interaction.options.getInteger('weeks') || 0;
    const days = interaction.options.getInteger('days') || 0;
    const hours = interaction.options.getInteger('hours') || 0;
    const minutes = interaction.options.getInteger('minutes') || 0;
    const seconds = interaction.options.getInteger('seconds') || 0;

    const duration = (months * 2592000) + (weeks * 604800) + (days * 86400) + (hours * 3600) + (minutes * 60) + seconds;

    if (duration < 10) {
        return await interaction.editReply('❌ Duration must be at least 10 seconds. Set at least one time field.');
    }

    try {
        const result = await mgr.createGiveaway(
            interaction.guild.id,
            interaction.channel.id,
            interaction.user.id,
            prize,
            winners,
            duration
        );

        const embed = new EmbedBuilder()
            .setColor('#57F287')
            .setTitle('✅ Giveaway Started')
            .setDescription(`Your giveaway has been created successfully!`)
            .addFields(
                { name: 'Prize', value: prize, inline: false },
                { name: 'Winners', value: winners.toString(), inline: true },
                { name: 'Duration', value: formatDuration(duration), inline: true }
            )
            .setFooter({ text: `Giveaway ID: ${result.giveawayId}` })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error('[Giveaway] Failed to start giveaway', {
            error: error.message,
            user: interaction.user.tag
        });
        await interaction.editReply('❌ Failed to start giveaway. Please try again.');
    }
}

export async function handleEnd(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const mgr = getManager(interaction.client);
    const messageId = interaction.options.getString('message-id');

    try {
        const giveaway = await mgr.getGiveawayByMessageId(messageId);

        if (!giveaway) {
            return await interaction.editReply('❌ No giveaway found with that message ID.');
        }

        if (giveaway.guild_id !== interaction.guild.id) {
            return await interaction.editReply('❌ This giveaway is not in this server.');
        }

        if (giveaway.is_active !== 1) {
            return await interaction.editReply('❌ This giveaway has already ended.');
        }

        await mgr.endGiveaway(giveaway, false);
        await interaction.editReply('✅ Giveaway ended successfully!');
    } catch (error) {
        logger.error('[Giveaway] Failed to end giveaway', {
            error: error.message,
            user: interaction.user.tag
        });
        await interaction.editReply('❌ Failed to end giveaway. Please try again.');
    }
}

export async function handleReroll(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const mgr = getManager(interaction.client);
    const messageId = interaction.options.getString('message-id');

    try {
        const giveaway = await mgr.getGiveawayByMessageId(messageId);

        if (!giveaway) {
            return await interaction.editReply('❌ No giveaway found with that message ID.');
        }

        if (giveaway.guild_id !== interaction.guild.id) {
            return await interaction.editReply('❌ This giveaway is not in this server.');
        }

        await mgr.endGiveaway(giveaway, true);
        await interaction.editReply('✅ Giveaway rerolled!');
    } catch (error) {
        logger.error('[Giveaway] Failed to reroll giveaway', {
            error: error.message,
            user: interaction.user.tag
        });
        await interaction.editReply('❌ Failed to reroll giveaway. Please try again.');
    }
}

export async function handleListGiveaways(interaction) {
    await interaction.deferReply();

    const mgr = getManager(interaction.client);

    try {
        const giveaways = await mgr.getActiveGiveaways(interaction.guild.id);

        if (giveaways.length === 0) {
            return await interaction.editReply('There are no active giveaways on this server.');
        }

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
            .setTitle('🎉 Active Giveaways')
            .setDescription(
                giveaways.map(g =>
                    `**${g.prize}**\nWinners: ${g.winner_count}\nEnds: <t:${Math.floor(new Date(g.ends_at).getTime() / 1000)}:R>\n[Jump to Message](https://discord.com/channels/${interaction.guild.id}/${g.channel_id}/${g.message_id})`
                ).join('\n\n')
            )
            .setFooter({ text: `${giveaways.length} active giveaway(s)` })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error('[Giveaway] Failed to list giveaways', {
            error: error.message,
            user: interaction.user.tag
        });
        await interaction.editReply('❌ Failed to list giveaways. Please try again.');
    }
}

export async function handleCancel(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const mgr = getManager(interaction.client);
    const messageId = interaction.options.getString('message-id');

    try {
        const giveaway = await mgr.getGiveawayByMessageId(messageId);

        if (!giveaway) {
            return await interaction.editReply('❌ No giveaway found with that message ID.');
        }

        if (giveaway.guild_id !== interaction.guild.id) {
            return await interaction.editReply('❌ This giveaway is not in this server.');
        }

        if (giveaway.is_active !== 1) {
            return await interaction.editReply('❌ This giveaway has already ended.');
        }

        const success = await mgr.cancelGiveaway(giveaway.id);

        if (success) {
            await interaction.editReply('✅ Giveaway cancelled.');
        } else {
            await interaction.editReply('❌ Failed to cancel giveaway. Please try again.');
        }
    } catch (error) {
        logger.error('[Giveaway] Failed to cancel giveaway', {
            error: error.message,
            user: interaction.user.tag
        });
        await interaction.editReply('❌ Failed to cancel giveaway. Please try again.');
    }
}

export async function handleDelete(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const mgr = getManager(interaction.client);
    const messageId = interaction.options.getString('message-id');

    try {
        const giveaway = await mgr.getGiveawayByMessageId(messageId);

        if (!giveaway) {
            return await interaction.editReply('❌ No giveaway found with that message ID.');
        }

        if (giveaway.guild_id !== interaction.guild.id) {
            return await interaction.editReply('❌ This giveaway is not in this server.');
        }

        // Delete the Discord message
        try {
            const channel = await interaction.guild.channels.fetch(giveaway.channel_id).catch(() => null);
            if (channel) {
                const msg = await channel.messages.fetch(giveaway.message_id).catch(() => null);
                if (msg) await msg.delete();
            }
        } catch (discordErr) {
            logger.warn(`[Giveaway] Could not delete Discord message for giveaway ${giveaway.id}:`, discordErr.message);
        }

        // Delete the DB row
        await pool.execute('DELETE FROM giveaways WHERE id = ?', [giveaway.id]);

        await interaction.editReply('✅ Giveaway deleted and message removed.');
    } catch (error) {
        logger.error('[Giveaway] Failed to delete giveaway', {
            error: error.message,
            user: interaction.user.tag
        });
        await interaction.editReply('❌ Failed to delete giveaway. Please try again.');
    }
}
