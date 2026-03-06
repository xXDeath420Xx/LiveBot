import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import PollsManager from '../../core/polls-manager.js';
import logger from '../../utils/logger.js';
import { parseTime } from '../../utils/timeParser.js';

let pollsManager = null;

function getManager(client) {
    if (!pollsManager) {
        pollsManager = new PollsManager(client);
    }
    return pollsManager;
}

export async function handleCreate(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const mgr = getManager(interaction.client);
    const question = interaction.options.getString('question');
    const optionsStr = interaction.options.getString('options');
    const durationStr = interaction.options.getString('duration');
    const allowMultiple = interaction.options.getBoolean('multiple-choice') || false;
    const anonymous = interaction.options.getBoolean('anonymous') || false;
    const allowWriteIn = interaction.options.getBoolean('allow-write-in') || false;

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
            allowWriteIn
        );

        const embed = new EmbedBuilder()
            .setColor('#57F287')
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

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error('[Poll] Failed to create poll', {
            error: error.message,
            user: interaction.user.tag
        });
        await interaction.editReply('❌ Failed to create poll. Please try again.');
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

        const success = await mgr.endPoll(poll.id, 'Ended by moderator');

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
        const poll = await mgr.getActivePoll(messageId);

        if (!poll) {
            return await interaction.editReply('❌ No poll found with that message ID.');
        }

        const options = JSON.parse(poll.options);
        const votes = poll.votes ? JSON.parse(poll.votes) : {};
        const voteCounts = mgr.calculateVoteCounts(options.length, votes);
        const totalVotes = Object.keys(votes).length;

        const embed = new EmbedBuilder()
            .setColor('#5865F2')
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

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error('[Poll] Failed to get poll results', {
            error: error.message,
            user: interaction.user.tag
        });
        await interaction.editReply('❌ Failed to get poll results. Please try again.');
    }
}
