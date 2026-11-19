import { EmbedBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import logger from '../../utils/logger.js';
import { themeColor } from '../../core/guild-theme.js';
import { getSettings, updateSettings } from '../../core/bgames-settings.js';
import * as hunts from '../../core/emoji-hunt-manager.js';
import { parseEmoji, formatDuration } from '../../core/emoji-hunt-logic.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

function isHuntStaff(member) {
    return member.permissions.has(PermissionFlagsBits.ManageGuild) || member.permissions.has(PermissionFlagsBits.ManageEvents);
}

async function denyStaff(interaction) {
    await interaction.reply({ content: '❌ You need **Manage Server** or **Manage Events** to run emoji hunts.', ...EPHEMERAL });
}

async function ensureEnabled(interaction) {
    const s = await getSettings('emojihunt', interaction.guildId);
    if (s.enabled) return s;
    const msg = '❌ Emoji hunts are turned off in this server.';
    if (interaction.deferred) await interaction.editReply({ content: msg });
    else await interaction.reply({ content: msg, ...EPHEMERAL });
    return null;
}

/** Channel ids out of "#a #b" / "<#1> <#2>" / "123 456". */
function parseChannelList(text, guild) {
    const ids = [...String(text || '').matchAll(/(\d{15,25})/g)].map(m => m[1]);
    return [...new Set(ids)].filter(id => guild.channels.cache.get(id)?.isTextBased?.());
}

export async function handleStart(interaction) {
    if (!isHuntStaff(interaction.member)) return denyStaff(interaction);
    await interaction.deferReply(EPHEMERAL);
    if (!(await ensureEnabled(interaction))) return;
    const channel = interaction.options.getChannel('channel');
    try {
        const res = await hunts.startHunt({
            guild: interaction.guild,
            client: interaction.client,
            hostId: interaction.user.id,
            emoji: interaction.options.getString('emoji'),
            count: interaction.options.getInteger('count'),
            durationMinutes: interaction.options.getInteger('minutes'),
            channelIds: channel ? [channel.id] : null,
            fallbackChannelId: interaction.channelId,
            trigger: 'manual',
        });
        if (!res.ok) return interaction.editReply({ content: `❌ ${res.error}` });
        const h = res.hunt;
        return interaction.editReply({
            content: `✅ Hunt #${h.hunt_count} started: **${h.total_emojis}** × ${h.target_emoji}, ending <t:${Math.floor(Number(h.ends_ms) / 1000)}:R>. `
                + `The first one appears within a minute. Use \`/arcade emojihunt status\` to watch it.`,
        });
    } catch (err) {
        logger.error('[EmojiHunt] /start failed', { guildId: interaction.guildId, error: err.message, stack: err.stack });
        return interaction.editReply({ content: '❌ Something went wrong starting the hunt.' });
    }
}

export async function handleStop(interaction) {
    if (!isHuntStaff(interaction.member)) return denyStaff(interaction);
    await interaction.deferReply(EPHEMERAL);
    try {
        const ended = await hunts.endHunt(interaction.guild, interaction.client, 'completed', `Ended early by ${interaction.user}.`);
        return interaction.editReply({ content: ended ? '✅ Hunt ended — results have been posted.' : 'There is no hunt running.' });
    } catch (err) {
        logger.error('[EmojiHunt] /stop failed', { guildId: interaction.guildId, error: err.message });
        return interaction.editReply({ content: '❌ Something went wrong ending the hunt.' });
    }
}

export async function handleStatus(interaction) {
    await interaction.deferReply();
    if (!(await ensureEnabled(interaction))) return;
    try {
        const hunt = await hunts.getHunt(interaction.guildId);
        if (!hunt) return interaction.editReply({ content: 'No emoji hunt has run here yet. Staff can start one with `/arcade emojihunt start`.' });
        return interaction.editReply({ embeds: [hunts.statusEmbed(interaction.guild, hunt)], allowedMentions: { parse: [] } });
    } catch (err) {
        logger.error('[EmojiHunt] /status failed', { guildId: interaction.guildId, error: err.message });
        return interaction.editReply({ content: '❌ Could not load the hunt.' });
    }
}

export async function handleLeaderboard(interaction) {
    await interaction.deferReply();
    if (!(await ensureEnabled(interaction))) return;
    try {
        const rows = await hunts.leaderboard(interaction.guildId, 10);
        if (!rows.length) return interaction.editReply({ content: 'Nobody has found a hidden emoji here yet.' });
        const medals = ['🥇', '🥈', '🥉'];
        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'warning'))
            .setTitle('🔎 Emoji Hunt — all-time leaderboard')
            .setDescription(rows.map((r, i) =>
                `${medals[i] || `**${i + 1}.**`} <@${r.user_id}> — **${Number(r.total_points).toLocaleString()}** pts · `
                + `${r.total_finds} found · ${r.hunts_completed} hunts · fastest ${formatDuration(r.fastest_find_ms)}`).join('\n'))
            .setTimestamp();
        return interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (err) {
        logger.error('[EmojiHunt] /leaderboard failed', { guildId: interaction.guildId, error: err.message });
        return interaction.editReply({ content: '❌ Could not load the leaderboard.' });
    }
}

export async function handleConfig(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: '❌ You need **Manage Server** to change emoji hunt settings.', ...EPHEMERAL });
    }
    await interaction.deferReply(EPHEMERAL);
    const o = interaction.options;
    const patch = {};
    const problems = [];

    const list = o.getString('hunt-channels');
    if (list !== null) {
        if (/^\s*(none|clear|-)\s*$/i.test(list)) patch.hunt_channels = [];
        else {
            const ids = parseChannelList(list, interaction.guild);
            if (!ids.length) problems.push('hunt-channels: no text channels found — mention them like #general #memes');
            else patch.hunt_channels = ids;
        }
    }
    const emoji = o.getString('emoji');
    if (emoji !== null) {
        const e = parseEmoji(emoji);
        if (!e) problems.push('emoji: not an emoji');
        else if (e.kind === 'custom' && !interaction.client.emojis.cache.has(e.id)) problems.push('emoji: I can only use custom emoji from servers I am in');
        else patch.default_emoji = e.value;
    }
    const map = [
        ['enabled', 'enabled', 'getBoolean'],
        ['announce-channel', 'announce_channel_id', 'getChannel'],
        ['ping-role', 'ping_role_id', 'getRole'],
        ['count', 'default_count', 'getInteger'],
        ['minutes', 'default_duration_minutes', 'getInteger'],
        ['finders', 'finders_per_emoji', 'getInteger'],
        ['points', 'points_per_find', 'getInteger'],
        ['coins', 'coins_per_find', 'getInteger'],
        ['xp', 'xp_per_find', 'getInteger'],
        ['max-age-minutes', 'max_message_age_minutes', 'getInteger'],
        ['cleanup', 'remove_unfound', 'getBoolean'],
        ['auto', 'auto_enabled', 'getBoolean'],
        ['auto-hours', 'auto_interval_hours', 'getInteger'],
    ];
    for (const [opt, key, getter] of map) {
        const v = o[getter](opt);
        if (v === null) continue;
        patch[key] = (getter === 'getChannel' || getter === 'getRole') ? v.id : v;
    }
    if (o.getBoolean('clear-ping-role')) patch.ping_role_id = '';

    if (problems.length) return interaction.editReply({ content: `❌ Nothing saved:\n• ${problems.join('\n• ')}` });

    try {
        const s = Object.keys(patch).length
            ? await updateSettings('emojihunt', interaction.guildId, patch, interaction.user.id)
            : await getSettings('emojihunt', interaction.guildId);
        if (patch.auto_enabled && !s.hunt_channels.length) {
            problems.push('Auto hunts need hunt channels — set `hunt-channels` too.');
        }
        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'info'))
            .setTitle(`⚙️ Emoji hunt settings${Object.keys(patch).length ? ' — saved' : ''}`)
            .setDescription([
                `**Enabled:** ${s.enabled ? 'yes' : 'no'}`,
                `**Hunt channels:** ${s.hunt_channels.length ? s.hunt_channels.map(id => `<#${id}>`).join(', ') : '_the channel /start is run in_'}`,
                `**Announcements:** ${s.announce_channel_id ? `<#${s.announce_channel_id}>` : '_same as above_'}`
                    + `${s.ping_role_id ? ` · pings <@&${s.ping_role_id}>` : ''}`,
                `**Default hunt:** ${s.default_count} × ${s.default_emoji} over ${s.default_duration_minutes} min`,
                `**Each spot:** first ${s.finders_per_emoji} finder(s) · ${s.points_per_find} pts`
                    + `${s.coins_per_find ? ` · ${s.coins_per_find} coins` : ''}${s.xp_per_find ? ` · ${s.xp_per_find} XP` : ''}`,
                `**Uses messages newer than:** ${s.max_message_age_minutes} min · **remove unfound at end:** ${s.remove_unfound ? 'yes' : 'no'}`,
                `**Automatic hunts:** ${s.auto_enabled ? `every ${s.auto_interval_hours} h` : 'off'}`,
            ].join('\n'))
            .setFooter({ text: 'Changes apply to the next hunt.' });
        return interaction.editReply({
            content: problems.length ? `⚠️ ${problems.join(' ')}` : undefined,
            embeds: [embed],
            allowedMentions: { parse: [] },
        });
    } catch (err) {
        logger.error('[EmojiHunt] /config failed', { guildId: interaction.guildId, error: err.message });
        return interaction.editReply({ content: '❌ Could not save the settings.' });
    }
}
