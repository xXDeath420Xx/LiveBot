import { EmbedBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import logger from '../../utils/logger.js';
import { themeColor } from '../../core/guild-theme.js';
import { getSettings, updateSettings } from '../../core/bgames-settings.js';
import * as loyalty from '../../core/loyalty-manager.js';
import { REWARD_TYPES } from '../../core/loyalty-logic.js';
import { formatCoins } from '../../core/bgames-rewards.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

const isAdmin = member => member.permissions.has(PermissionFlagsBits.ManageGuild);

async function denyAdmin(interaction) {
    return interaction.reply({ content: '❌ You need **Manage Server** for that.', ...EPHEMERAL });
}

/** Settings if loyalty is on; otherwise replies and returns null. */
async function enabledOrReply(interaction) {
    const s = await getSettings('loyalty', interaction.guildId);
    if (s.enabled) return s;
    const msg = '❌ Loyalty points aren\'t switched on in this server.'
        + (isAdmin(interaction.member) ? ' Turn them on with `/level loyalty config enabled:True`.' : '');
    if (interaction.deferred) await interaction.editReply({ content: msg });
    else await interaction.reply({ content: msg, ...EPHEMERAL });
    return null;
}

export async function handleBalance(interaction) {
    await interaction.deferReply();
    const s = await enabledOrReply(interaction);
    if (!s) return;
    const user = interaction.options.getUser('user') || interaction.user;
    try {
        const a = await loyalty.getAccount(interaction.guildId, user.id);
        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'accent'))
            .setAuthor({ name: user.username, iconURL: user.displayAvatarURL() })
            .setTitle(`💎 ${s.points_name}`)
            .addFields(
                { name: 'Balance', value: `**${a.points.toLocaleString()}**`, inline: true },
                { name: 'Earned all-time', value: a.lifetime_points.toLocaleString(), inline: true },
                { name: 'Rank', value: a.rank ? `#${a.rank}` : '—', inline: true },
                { name: 'Streak', value: `${a.streak} day${a.streak === 1 ? '' : 's'} (best ${a.best_streak})`, inline: true },
            )
            .setFooter({ text: 'Points are added once a day for the previous day\'s activity.' });
        return interaction.editReply({ embeds: [embed] });
    } catch (err) {
        logger.error('[Loyalty] /balance failed', { guildId: interaction.guildId, error: err.message });
        return interaction.editReply({ content: '❌ Could not load that balance.' });
    }
}

export async function handleLeaderboard(interaction) {
    await interaction.deferReply();
    const s = await enabledOrReply(interaction);
    if (!s) return;
    const by = interaction.options.getString('by') || 'points';
    try {
        const rows = await loyalty.leaderboard(interaction.guildId, by, 10);
        if (!rows.length) return interaction.editReply({ content: 'Nobody has earned any yet — points arrive the day after activity.' });
        const medals = ['🥇', '🥈', '🥉'];
        const val = r => by === 'lifetime' ? `${Number(r.lifetime_points).toLocaleString()} earned`
            : by === 'streak' ? `${r.best_streak}-day best streak` : `${Number(r.points).toLocaleString()}`;
        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'warning'))
            .setTitle(`🏅 ${s.points_name} — ${by === 'lifetime' ? 'all-time' : by === 'streak' ? 'streaks' : 'balances'}`)
            .setDescription(rows.map((r, i) => `${medals[i] || `**${i + 1}.**`} <@${r.user_id}> — **${val(r)}**`).join('\n'))
            .setTimestamp();
        return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (err) {
        logger.error('[Loyalty] /leaderboard failed', { guildId: interaction.guildId, error: err.message });
        return interaction.editReply({ content: '❌ Could not load the leaderboard.' });
    }
}

export async function handleRewards(interaction) {
    await interaction.deferReply();
    const s = await enabledOrReply(interaction);
    if (!s) return;
    try {
        const rows = await loyalty.listRewards(interaction.guildId);
        if (!rows.length) {
            return interaction.editReply({ content: 'No rewards set up yet.' + (isAdmin(interaction.member) ? ' Add one with `/level loyalty reward-add`.' : '') });
        }
        const lines = [];
        for (const r of rows) {
            const coins = r.reward_type === 'coins' ? await formatCoins(interaction.guildId, r.amount) : null;
            lines.push(`**#${r.id} ${r.name}** — ${Number(r.cost).toLocaleString()} pts → ${loyalty.describeReward(r, coins)}`
                + `${r.stock !== null ? ` · ${r.stock} left` : ''}${r.description ? `\n> ${String(r.description).slice(0, 150)}` : ''}`);
        }
        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'accent'))
            .setTitle(`🎁 Spend your ${s.points_name}`)
            .setDescription(lines.join('\n').slice(0, 4000))
            .setFooter({ text: 'Redeem with /loyalty redeem' });
        return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (err) {
        logger.error('[Loyalty] /rewards failed', { guildId: interaction.guildId, error: err.message });
        return interaction.editReply({ content: '❌ Could not load rewards.' });
    }
}

export async function handleRedeem(interaction) {
    await interaction.deferReply(EPHEMERAL);
    if (!(await enabledOrReply(interaction))) return;
    try {
        const res = await loyalty.redeem(interaction.guild, interaction.member, interaction.options.getInteger('reward'));
        return interaction.editReply({ content: res.ok ? res.message : `❌ ${res.error}`, allowedMentions: { parse: [] } });
    } catch (err) {
        logger.error('[Loyalty] /redeem failed', { guildId: interaction.guildId, userId: interaction.user.id, error: err.message, stack: err.stack });
        return interaction.editReply({ content: '❌ Something went wrong. If points were taken, staff can check the redemption log.' });
    }
}

export async function handleRewardAdd(interaction) {
    if (!isAdmin(interaction.member)) return denyAdmin(interaction);
    await interaction.deferReply(EPHEMERAL);
    const o = interaction.options;
    try {
        const res = await loyalty.addReward(interaction.guild, {
            name: o.getString('name'),
            description: o.getString('description'),
            cost: o.getInteger('cost'),
            type: o.getString('type'),
            roleId: o.getRole('role')?.id || null,
            amount: o.getInteger('amount') || 0,
            stock: o.getInteger('stock'),
            createdBy: interaction.user.id,
        });
        if (!res.ok) return interaction.editReply({ content: `❌ ${res.error}` });
        const r = res.reward;
        const coins = r.reward_type === 'coins' ? await formatCoins(interaction.guildId, r.amount) : null;
        return interaction.editReply({
            content: `✅ Added reward **#${r.id} ${r.name}** — ${r.cost} pts → ${loyalty.describeReward(r, coins)}.`,
            allowedMentions: { parse: [] },
        });
    } catch (err) {
        logger.error('[Loyalty] /reward-add failed', { guildId: interaction.guildId, error: err.message });
        return interaction.editReply({ content: '❌ Could not add the reward.' });
    }
}

export async function handleRewardRemove(interaction) {
    if (!isAdmin(interaction.member)) return denyAdmin(interaction);
    await interaction.deferReply(EPHEMERAL);
    try {
        const ok = await loyalty.removeReward(interaction.guildId, interaction.options.getInteger('reward'));
        return interaction.editReply({ content: ok ? '✅ Reward removed from the list.' : '❌ No active reward with that number.' });
    } catch (err) {
        logger.error('[Loyalty] /reward-remove failed', { guildId: interaction.guildId, error: err.message });
        return interaction.editReply({ content: '❌ Could not remove the reward.' });
    }
}

export async function handleAdjust(interaction, sign) {
    if (!isAdmin(interaction.member)) return denyAdmin(interaction);
    await interaction.deferReply(EPHEMERAL);
    const user = interaction.options.getUser('user');
    const amount = interaction.options.getInteger('amount');
    if (user.bot) return interaction.editReply({ content: '❌ Bots don\'t collect points.' });
    try {
        const a = await loyalty.adjust(interaction.guildId, user.id, sign * amount);
        logger.info('[Loyalty] Staff adjusted points', { guildId: interaction.guildId, staff: interaction.user.id, target: user.id, delta: sign * amount });
        return interaction.editReply({
            content: `✅ ${sign > 0 ? 'Gave' : 'Took'} **${amount.toLocaleString()}** ${sign > 0 ? 'to' : 'from'} ${user}. `
                + `New balance: **${a.points.toLocaleString()}**.`,
            allowedMentions: { parse: [] },
        });
    } catch (err) {
        logger.error('[Loyalty] adjust failed', { guildId: interaction.guildId, error: err.message });
        return interaction.editReply({ content: '❌ Could not change that balance.' });
    }
}

export async function handleConfig(interaction) {
    if (!isAdmin(interaction.member)) return denyAdmin(interaction);
    await interaction.deferReply(EPHEMERAL);
    const o = interaction.options;
    const patch = {};
    const map = [
        ['enabled', 'enabled', 'getBoolean'],
        ['daily-points', 'daily_active_points', 'getInteger'],
        ['min-messages', 'min_daily_messages', 'getInteger'],
        ['min-voice-minutes', 'min_voice_minutes', 'getInteger'],
        ['voice-minutes-per-point', 'voice_minutes_per_point', 'getInteger'],
        ['max-voice-points', 'max_voice_points_per_day', 'getInteger'],
        ['streak-bonus', 'streak_bonus_per_day', 'getInteger'],
        ['max-streak-bonus', 'max_streak_bonus', 'getInteger'],
        ['log-channel', 'redemption_log_channel_id', 'getChannel'],
        ['name', 'points_name', 'getString'],
    ];
    for (const [opt, key, getter] of map) {
        const v = o[getter](opt);
        if (v === null) continue;
        patch[key] = getter === 'getChannel' ? v.id : v;
    }
    try {
        const s = Object.keys(patch).length
            ? await updateSettings('loyalty', interaction.guildId, patch, interaction.user.id)
            : await getSettings('loyalty', interaction.guildId);
        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'info'))
            .setTitle(`⚙️ Loyalty settings${Object.keys(patch).length ? ' — saved' : ''}`)
            .setDescription([
                `**Enabled:** ${s.enabled ? 'yes' : 'no'} · **Called:** ${s.points_name}`,
                `**Active day** (${s.min_daily_messages}+ messages or ${s.min_voice_minutes}+ voice minutes): **${s.daily_active_points}** pts`,
                `**Voice:** 1 pt per ${s.voice_minutes_per_point} min (max ${s.max_voice_points_per_day}/day)`,
                `**Streak bonus:** +${s.streak_bonus_per_day}/day in a row (max +${s.max_streak_bonus})`,
                `**Redemption log:** ${s.redemption_log_channel_id ? `<#${s.redemption_log_channel_id}>` : 'none — custom rewards need one so staff see them'}`,
            ].join('\n'))
            .setFooter({ text: 'Points are settled daily from message and voice activity the bot already tracks.' });
        return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (err) {
        logger.error('[Loyalty] /config failed', { guildId: interaction.guildId, error: err.message });
        return interaction.editReply({ content: '❌ Could not save the settings.' });
    }
}

export async function autocompleteReward(interaction) {
    const focused = String(interaction.options.getFocused() || '').toLowerCase();
    const rows = await loyalty.listRewards(interaction.guildId);
    return interaction.respond(rows
        .filter(r => !focused || `${r.id} ${r.name}`.toLowerCase().includes(focused))
        .slice(0, 25)
        .map(r => ({ name: `#${r.id} ${r.name} — ${r.cost} pts (${REWARD_TYPES[r.reward_type] || r.reward_type})`.slice(0, 100), value: Number(r.id) })));
}
