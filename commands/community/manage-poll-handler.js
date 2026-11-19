import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import PollsManager from '../../core/polls-manager.js';
import logger from '../../utils/logger.js';
import { parseTime } from '../../utils/timeParser.js';
import { themeColor } from '../../core/guild-theme.js';
import pool from '../../utils/db.js';
import { getEconomyConfig, formatMoney } from '../../core/economy-manager.js';

let pollsManager = null;

function getManager(client) {
    // The bot's own manager (index.js) when there is one, so polls are served by the right client.
    if (client?.pollsManager) return client.pollsManager;
    if (!pollsManager) {
        pollsManager = new PollsManager(client);
    }
    return pollsManager;
}

// Betting defaults when /manage poll create enables betting without limits.
const DEFAULT_MIN_BET = 10;
const DEFAULT_MAX_BET = 1000;

export async function handleCreate(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const mgr = getManager(interaction.client);
    const question = interaction.options.getString('question');
    const optionsStr = interaction.options.getString('options');
    const durationStr = interaction.options.getString('duration');
    const allowMultiple = interaction.options.getBoolean('multiple-choice') || false;
    const anonymous = interaction.options.getBoolean('anonymous') || false;
    const hideResults = interaction.options.getBoolean('hide-results') || false;
    const allowWriteIn = interaction.options.getBoolean('allow-write-in') || false;
    // Betting: members stake coins from their economy wallet on an option; winners split the pot.
    const bettingEnabled = interaction.options.getBoolean?.('betting') || false;
    const minBet = interaction.options.getInteger?.('min-bet') ?? DEFAULT_MIN_BET;
    const maxBet = interaction.options.getInteger?.('max-bet') ?? Math.max(DEFAULT_MAX_BET, minBet);

    if (bettingEnabled && allowMultiple) {
        return await interaction.editReply('❌ Betting only works on single-choice polls — turn off multiple-choice.');
    }
    if (bettingEnabled && maxBet < minBet) {
        return await interaction.editReply('❌ The maximum bet must be at least the minimum bet.');
    }

    const options = optionsStr.split(';').map(opt => opt.trim()).filter(opt => opt.length > 0);

    if (options.length < 2) {
        return await interaction.editReply('❌ You must provide at least 2 options.');
    }

    if (options.length > 10) {
        return await interaction.editReply('❌ You can only have up to 10 options.');
    }

    let duration = null;
    if (durationStr) {
        duration = parseTime(durationStr);
        if (!duration) {
            return await interaction.editReply('❌ Invalid duration format. Use formats like `30m`, `2h`, `1d`.');
        }
    }

    try {
        const result = await mgr.createPoll(
            interaction.guild.id,
            interaction.channel.id,
            interaction.user.id,
            question,
            options,
            duration,
            allowMultiple,
            anonymous,
            allowWriteIn,
            bettingEnabled,
            minBet,
            maxBet,
            hideResults
        );

        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'success'))
            .setTitle('✅ Poll Created')
            .setDescription(`Your poll has been created successfully!`)
            .addFields(
                { name: 'Question', value: question, inline: false },
                { name: 'Options', value: options.length.toString(), inline: true },
                { name: 'Type', value: allowMultiple ? 'Multiple Choice' : 'Single Choice', inline: true }
            )
            .setFooter({ text: `Poll ID: ${result.pollId}` })
            .setTimestamp();

        if (duration) {
            embed.addFields({
                name: 'Duration',
                value: `${durationStr}`,
                inline: true
            });
        }

        if (bettingEnabled) {
            const config = await getEconomyConfig(interaction.guild.id);
            embed.addFields({
                name: 'Betting',
                value: `${formatMoney(minBet, config)} – ${formatMoney(maxBet, config)} per bet`,
                inline: true
            });
        }

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error('[Poll] Failed to create poll', {
            error: error.message,
            user: interaction.user.tag
        });
        // Rule violations from the manager (betting with the economy off, bad limits) are worth showing.
        const known = /betting|bet limits|economy|between 2 and 10/i.test(error.message);
        await interaction.editReply(known ? `❌ ${error.message}.` : '❌ Failed to create poll. Please try again.');
    }
}

export async function handleEnd(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const mgr = getManager(interaction.client);
    const messageId = interaction.options.getString('message-id');

    try {
        const poll = await mgr.getActivePoll(messageId);

        if (!poll) {
            return await interaction.editReply('❌ No active poll found with that message ID.');
        }

        const hasPermission = poll.creator_id === interaction.user.id ||
            interaction.member.permissions.has(PermissionFlagsBits.ManageMessages);

        if (!hasPermission) {
            return await interaction.editReply('❌ You can only end polls that you created.');
        }

        const success = await mgr.endPoll(poll.id, 'Ended by moderator', interaction.user);

        if (success) {
            await interaction.editReply('✅ Poll ended successfully!');
        } else {
            await interaction.editReply('❌ Failed to end poll. Please try again.');
        }
    } catch (error) {
        logger.error('[Poll] Failed to end poll', {
            error: error.message,
            user: interaction.user.tag
        });
        await interaction.editReply('❌ Failed to end poll. Please try again.');
    }
}

export async function handleResults(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const mgr = getManager(interaction.client);
    const messageId = interaction.options.getString('message-id');

    try {
        // Results work for ended polls too (scoped to this server).
        const [[poll]] = await pool.execute(
            'SELECT * FROM polls WHERE message_id = ? AND guild_id = ?',
            [messageId, interaction.guild.id]
        );

        if (!poll) {
            return await interaction.editReply('❌ No poll found with that message ID.');
        }

        // A hidden-results poll that is still active must not reveal through /results —
        // the whole point is nobody sees tallies until the poll ends. Direct them to peek.
        if (poll.hide_results && poll.status === 'active') {
            return await interaction.editReply('🔒 This poll hides its results until it ends. The creator or a server admin can run `/manage poll peek` with the same message ID for an ephemeral preview.');
        }

        const options = JSON.parse(poll.options);
        const votes = poll.votes ? JSON.parse(poll.votes) : {};
        const voteCounts = mgr.calculateVoteCounts(options.length, votes);
        const totalVotes = Object.keys(votes).length;

        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'primary'))
            .setTitle('📊 Poll Results')
            .setDescription(`**${poll.question}**\n\n${mgr.formatPollOptions(options, voteCounts, totalVotes)}`)
            .addFields(
                { name: 'Total Votes', value: totalVotes.toString(), inline: true },
                { name: 'Status', value: poll.status === 'active' ? '🟢 Active' : '🔴 Ended', inline: true }
            )
            .setTimestamp();

        if (poll.ends_at) {
            embed.addFields({
                name: 'Ends',
                value: `<t:${Math.floor(new Date(poll.ends_at).getTime() / 1000)}:R>`,
                inline: true
            });
        }

        if (poll.betting_enabled) {
            const { optionBets } = await mgr.getBettingStats(poll.id);
            const config = await getEconomyConfig(interaction.guild.id);
            const pot = optionBets.reduce((sum, b) => sum + (Number(b.total_on_option) || 0), 0);
            const lines = optionBets
                .sort((a, b) => a.option_index - b.option_index)
                .map(b => `${mgr.optionLabel(poll, b.option_index)}: ${formatMoney(Number(b.total_on_option) || 0, config)} (${b.bet_count} ${Number(b.bet_count) === 1 ? 'bet' : 'bets'})`);
            embed.addFields({
                name: `💰 Pot: ${formatMoney(pot, config)}`,
                value: (lines.join('\n') || 'No bets yet').slice(0, 1024),
                inline: false
            });
        }

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error('[Poll] Failed to get poll results', {
            error: error.message,
            user: interaction.user.tag
        });
        await interaction.editReply('❌ Failed to get poll results. Please try again.');
    }
}

/**
 * /manage poll peek — ephemeral live tally for a hidden-results poll.
 * Open to the poll's creator or any user with the ManageGuild permission.
 * No-op for polls that already show live tallies (direct them to /manage poll results).
 */
export async function handlePeek(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const mgr = getManager(interaction.client);
    const messageId = interaction.options.getString('message-id');

    try {
        const [[poll]] = await pool.execute(
            'SELECT * FROM polls WHERE message_id = ? AND guild_id = ?',
            [messageId, interaction.guild.id]
        );

        if (!poll) {
            return await interaction.editReply('❌ No poll found with that message ID.');
        }

        if (!poll.hide_results) {
            return await interaction.editReply('This poll already shows live tallies — use `/manage poll results` instead.');
        }

        if (poll.status !== 'active') {
            return await interaction.editReply('This poll has ended. Use `/manage poll results` to see the final tally.');
        }

        const isCreator = String(poll.creator_id) === String(interaction.user.id);
        const canManage = interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild);
        if (!isCreator && !canManage) {
            return await interaction.editReply('🔒 Only the poll creator or a server admin can peek at hidden results.');
        }

        const options = JSON.parse(poll.options);
        const writeIns = poll.write_in_answers ? JSON.parse(poll.write_in_answers) : [];
        const votes = poll.votes ? JSON.parse(poll.votes) : {};
        const voteCounts = mgr.calculateVoteCounts(options.length + writeIns.length, votes);
        const totalVotes = Object.keys(votes).length;

        let description = mgr.formatPollOptions(options, voteCounts, totalVotes);
        if (writeIns.length) {
            const lines = writeIns.map((w, i) => {
                const count = voteCounts[options.length + i] || 0;
                const percentage = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
                return `🔹 **${w.answer}**\n${mgr.createProgressBar(percentage)} ${percentage}% (${count} ${count === 1 ? 'vote' : 'votes'})`;
            });
            description += '\n\n**✍️ Write-In Answers:**\n\n' + lines.join('\n\n');
        }

        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'primary'))
            .setTitle('🔒 Hidden poll peek')
            .setDescription(`**${poll.question}**\n\n${description}`.slice(0, 4096))
            .addFields(
                { name: 'Total Votes', value: totalVotes.toString(), inline: true },
                { name: 'Status', value: '🟢 Active (results hidden to viewers)', inline: true }
            )
            .setFooter({ text: 'Only you see this. The public embed still shows no tallies.' })
            .setTimestamp();

        if (poll.ends_at) {
            embed.addFields({
                name: 'Ends',
                value: `<t:${Math.floor(new Date(poll.ends_at).getTime() / 1000)}:R>`,
                inline: true
            });
        }

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error('[Poll] Failed to peek at hidden poll', {
            error: error.message,
            user: interaction.user.tag
        });
        await interaction.editReply('❌ Failed to peek at the poll. Please try again.');
    }
}
