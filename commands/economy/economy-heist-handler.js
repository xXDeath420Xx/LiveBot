import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import economyManager from '../../core/economy-manager.js';
import heistManager, { HeistError } from '../../core/heist-manager.js';
import { TARGETS, maxStake, USER_COOLDOWN_MINUTES, GUILD_COOLDOWN_MINUTES } from '../../core/heist-odds.js';
import { displayNameFor } from '../../utils/display-name.js';
import { themeColor } from '../../core/guild-theme.js';
import logger from '../../utils/logger.js';

function isManager(interaction) {
    return Boolean(interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild));
}

/** Reply with a refusal (HeistError) privately; rethrow anything unexpected. */
async function refuse(interaction, error) {
    if (!(error instanceof HeistError)) throw error;
    const payload = { content: `❌ ${error.message}`, ephemeral: true };
    if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
    return interaction.reply(payload);
}

export async function handleStart(interaction) {
    const targetKey = interaction.options.getString('target');
    const stake = interaction.options.getInteger('stake');
    const crew = interaction.options.getInteger('crew');
    const minutes = interaction.options.getInteger('minutes');

    let result;
    try {
        result = await heistManager.startHeist({
            guildId: interaction.guild.id,
            channelId: interaction.channel.id,
            hostId: interaction.user.id,
            targetKey,
            stake,
            maxCrew: crew,
            windowMinutes: minutes,
        });
    } catch (error) {
        return refuse(interaction, error);
    }

    const { heist, participants } = result;
    await interaction.reply({
        embeds: [await heistManager.heistEmbed(heist, participants)],
        components: heistManager.heistComponents(heist, true),
    });
    try {
        const message = await interaction.fetchReply();
        await heistManager.setHeistMessage(heist.id, message.id);
    } catch (error) {
        logger.warn('[Heist] Could not record the heist message id', { heistId: heist.id, error: error.message });
    }
}

export async function handleJoin(interaction) {
    const stake = interaction.options.getInteger('stake');
    const active = await heistManager.getActiveHeist(interaction.guild.id);
    if (!active || active.status !== 'recruiting') {
        return interaction.reply({ content: '❌ No heist is recruiting right now — start one with `/economy heist start`.', ephemeral: true });
    }
    let result;
    try {
        result = await heistManager.joinHeist({ guildId: interaction.guild.id, heistId: active.id, userId: interaction.user.id, stake });
    } catch (error) {
        return refuse(interaction, error);
    }
    const config = await economyManager.getEconomyConfig(interaction.guild.id);
    await interaction.reply({
        content: `🦹 You're in! ${economyManager.formatMoney(stake, config)} is held for heist #${active.id} until it resolves.`,
        ephemeral: true,
    });
    await heistManager.refreshHeistMessage(result.heist, result.participants, interaction.client);
}

export async function handleStatus(interaction) {
    const active = await heistManager.getActiveHeist(interaction.guild.id);
    if (!active) {
        const wait = await heistManager.guildCooldownLeft(interaction.guild.id);
        const targets = Object.values(TARGETS)
            .map(t => `${t.emoji} **${t.name}** (\`${t.key}\`) — stake ${t.minStake.toLocaleString()}–${maxStake(t).toLocaleString()}, pays x${t.multiplier}`)
            .join('\n');
        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'info'))
            .setTitle('🦹 No heist in progress')
            .setDescription(`${wait > 0 ? `The city is on alert — the next heist can start in ${wait} minute${wait === 1 ? '' : 's'}.` : 'Start one with `/economy heist start`.'}\n\n${targets}`)
            .setFooter({ text: `Cooldowns: ${GUILD_COOLDOWN_MINUTES} min per server, ${USER_COOLDOWN_MINUTES} min per member after each heist` });
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }
    const participants = await heistManager.getParticipants(active.id);
    return interaction.reply({
        embeds: [await heistManager.heistEmbed(active, participants)],
        components: heistManager.heistComponents(active, active.status === 'recruiting'),
        ephemeral: true,
    });
}

export async function handleCancel(interaction) {
    const active = await heistManager.getActiveHeist(interaction.guild.id);
    if (!active) return interaction.reply({ content: '❌ There is no heist to call off.', ephemeral: true });
    let result;
    try {
        result = await heistManager.cancelHeist({
            guildId: interaction.guild.id, heistId: active.id, userId: interaction.user.id, isAdmin: isManager(interaction),
        });
    } catch (error) {
        return refuse(interaction, error);
    }
    await interaction.reply({ content: `🛑 Heist #${active.id} is called off — every stake has been refunded.` });
    await heistManager.refreshHeistMessage(result.heist, result.participants, interaction.client);
}

export async function handleStats(interaction) {
    const user = interaction.options.getUser('user') || interaction.user;
    const config = await economyManager.getEconomyConfig(interaction.guild.id);
    const stats = await heistManager.getStats(interaction.guild.id, user.id);
    if (!stats) {
        return interaction.reply({ content: `${user.id === interaction.user.id ? 'You haven\'t' : `${displayNameFor(user, interaction.guild)} hasn't`} been on a heist yet.`, ephemeral: true });
    }
    const net = Number(stats.total_earned) - Number(stats.total_contributed);
    const wait = await heistManager.userCooldownLeft(interaction.guild.id, user.id);
    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'primary'))
        .setTitle(`🦹 ${displayNameFor(user, interaction.guild)}'s heist record`)
        .addFields(
            { name: 'Heists', value: `${stats.heists_participated}`, inline: true },
            { name: 'Won / Lost', value: `${stats.heists_won} / ${stats.heists_lost}`, inline: true },
            { name: 'Biggest score', value: economyManager.formatMoney(Number(stats.biggest_win) || 0, config), inline: true },
            { name: 'Staked', value: economyManager.formatMoney(Number(stats.total_contributed) || 0, config), inline: true },
            { name: 'Paid out', value: economyManager.formatMoney(Number(stats.total_earned) || 0, config), inline: true },
            { name: 'Net', value: `${net >= 0 ? '+' : ''}${economyManager.formatMoney(net, config)}`, inline: true },
        );
    if (wait > 0) embed.setFooter({ text: `Laying low for ${wait} more minute${wait === 1 ? '' : 's'}` });
    return interaction.reply({ embeds: [embed] });
}

export async function handleLeaderboard(interaction) {
    const config = await economyManager.getEconomyConfig(interaction.guild.id);
    const rows = await heistManager.getLeaderboard(interaction.guild.id, 10);
    if (!rows.length) return interaction.reply({ content: 'No heists have been pulled here yet.', ephemeral: true });
    const lines = rows.map((r, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        const net = Number(r.net_profit) || 0;
        return `${medal} <@${r.user_id}> — ${net >= 0 ? '+' : ''}${economyManager.formatMoney(net, config)} (${r.heists_won}W/${r.heists_lost}L)`;
    });
    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'warning'))
        .setTitle('🦹 Top heisters')
        .setDescription(lines.join('\n'))
        .setFooter({ text: 'Ranked by net profit (payouts minus stakes)' });
    return interaction.reply({ embeds: [embed], allowedMentions: { users: [] } });
}
