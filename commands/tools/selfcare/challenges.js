import { EmbedBuilder } from 'discord.js';
import * as challengeManager from '../../../core/daily-challenges-manager.js';

export async function execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
        case 'view':
            return handleView(interaction);
        case 'stats':
            return handleStats(interaction);
        case 'claim':
            return handleClaim(interaction);
    }
}

function createProgressBar(current, max, length = 10) {
    const percentage = Math.min(current / max, 1);
    const filled = Math.round(length * percentage);
    const empty = length - filled;

    return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
}

async function handleView(interaction) {
    await interaction.deferReply();

    const challenges = await challengeManager.getUserChallenges(
        interaction.guild.id,
        interaction.user.id
    );

    if (challenges.length === 0) {
        return interaction.editReply({
            content: '❌ No challenges available. Please try again later.'
        });
    }

    const embed = new EmbedBuilder()
        .setColor('#3498DB')
        .setTitle('📋 Your Daily Challenges')
        .setDescription('Complete challenges to earn XP and currency!')
        .setThumbnail(interaction.user.displayAvatarURL())
        .setTimestamp();

    challenges.forEach((challenge, index) => {
        const emoji = challengeManager.getDifficultyEmoji(challenge.difficulty);
        const progressBar = createProgressBar(challenge.progress, challenge.requirement_count);
        const percentage = Math.round((challenge.progress / challenge.requirement_count) * 100);

        const status = challenge.claimed
            ? '✅ Claimed'
            : challenge.completed
            ? '🎁 Ready to Claim!'
            : `${progressBar} ${percentage}%`;

        embed.addFields({
            name: `${emoji} ${index + 1}. ${challenge.challenge_name} [${challenge.difficulty.toUpperCase()}]`,
            value: `${challenge.challenge_description}\n**Progress:** ${challenge.progress}/${challenge.requirement_count}\n${status}\n**Rewards:** ${challenge.xp_reward} XP, ${challenge.currency_reward} coins`,
            inline: false
        });
    });

    // Add claim instructions
    const unclaimedCount = challenges.filter(c => c.completed && !c.claimed).length;
    if (unclaimedCount > 0) {
        embed.setFooter({ text: '💡 Use /selfcare challenges claim <number> to claim your rewards!' });
    } else {
        embed.setFooter({ text: '💡 New challenges available tomorrow!' });
    }

    return interaction.editReply({ embeds: [embed] });
}

async function handleStats(interaction) {
    const targetUser = interaction.options.getUser('user') || interaction.user;
    await interaction.deferReply();

    const stats = await challengeManager.getStats(interaction.guild.id, targetUser.id);

    if (!stats) {
        return interaction.editReply({
            content: `❌ ${targetUser.id === interaction.user.id ? 'You haven\'t' : `${targetUser.username} hasn't`} started any challenges yet!`
        });
    }

    const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle(`📊 Challenge Statistics - ${targetUser.username}`)
        .setThumbnail(targetUser.displayAvatarURL())
        .addFields(
            {
                name: '✅ Total Completed',
                value: `${stats.totalCompleted}`,
                inline: true
            },
            {
                name: '🎁 Total Claimed',
                value: `${stats.totalClaimed}`,
                inline: true
            },
            {
                name: '📈 Completion Rate',
                value: `${stats.completionRate}%`,
                inline: true
            },
            {
                name: '🔥 Current Streak',
                value: `${stats.currentStreak} day${stats.currentStreak !== 1 ? 's' : ''}`,
                inline: true
            },
            {
                name: '📋 Total Assigned',
                value: `${stats.totalAssigned}`,
                inline: true
            },
            {
                name: '⏳ Unclaimed',
                value: `${stats.totalCompleted - stats.totalClaimed}`,
                inline: true
            }
        )
        .setTimestamp();

    // Add motivational message based on stats
    if (stats.currentStreak >= 7) {
        embed.setDescription('🌟 **Amazing dedication!** Keep up the great work!');
    } else if (stats.currentStreak >= 3) {
        embed.setDescription('🔥 **On fire!** You\'re on a roll!');
    } else if (stats.completionRate >= 80) {
        embed.setDescription('⭐ **Excellent completion rate!** You\'re crushing it!');
    } else {
        embed.setDescription('💪 **Keep pushing!** Complete challenges daily to build your streak!');
    }

    return interaction.editReply({ embeds: [embed] });
}

async function handleClaim(interaction) {
    const challengeNumber = interaction.options.getInteger('challenge');
    await interaction.deferReply();

    // Get user's challenges
    const challenges = await challengeManager.getUserChallenges(
        interaction.guild.id,
        interaction.user.id
    );

    if (challengeNumber > challenges.length) {
        return interaction.editReply({
            content: '❌ Invalid challenge number. Use `/selfcare challenges view` to see your challenges.'
        });
    }

    const challenge = challenges[challengeNumber - 1];

    if (challenge.claimed) {
        return interaction.editReply({
            content: '❌ You\'ve already claimed rewards for this challenge!'
        });
    }

    if (!challenge.completed) {
        const remaining = challenge.requirement_count - challenge.progress;
        return interaction.editReply({
            content: `❌ Challenge not completed yet! You need ${remaining} more to complete "${challenge.challenge_name}".`
        });
    }

    // Claim rewards
    const result = await challengeManager.claimRewards(
        interaction.guild.id,
        interaction.user.id,
        challenge.challenge_id
    );

    if (!result.success) {
        return interaction.editReply({
            content: `❌ ${result.message}`
        });
    }

    const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('🎉 Rewards Claimed!')
        .setDescription(`You've successfully claimed rewards for:\n**${result.challenge}**`)
        .addFields(
            {
                name: '⭐ XP Earned',
                value: `+${result.xpReward.toLocaleString()}`,
                inline: true
            },
            {
                name: '🪙 Coins Earned',
                value: `+${result.currencyReward.toLocaleString()}`,
                inline: true
            }
        )
        .setFooter({ text: 'Keep completing challenges to earn more rewards!' })
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}
