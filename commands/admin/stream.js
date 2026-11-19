/**
 * /stream — Twitch Tier B control slash commands.
 *
 * Mirrors the dashboard Stream Controls section so an admin can run moderation + stream
 * management without opening the dashboard. All subcommands delegate to core/twitch-write.js
 * (same code path as the dashboard buttons — same audit log).
 *
 * Admin only. Scoped to the guild's connected broadcaster.
 */
import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import * as tw from '../../core/twitch-write.js';

const EPHEMERAL = { flags: 64 };

const data = new SlashCommandBuilder()
    .setName('stream')
    .setDescription('Live Twitch stream controls (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand(sc => sc.setName('title').setDescription('Change the stream title / category')
        .addStringOption(o => o.setName('title').setDescription('New title').setMaxLength(140))
        .addStringOption(o => o.setName('category_id').setDescription('Twitch game id (not name)')))
    .addSubcommand(sc => sc.setName('shield').setDescription('Toggle Shield Mode on or off')
        .addStringOption(o => o.setName('state').setDescription('on / off').setRequired(true).addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' })))
    .addSubcommand(sc => sc.setName('snooze-ad').setDescription('Snooze the next scheduled ad'))
    .addSubcommand(sc => sc.setName('raid').setDescription('Launch a raid against another channel')
        .addStringOption(o => o.setName('target').setDescription('Target channel username').setRequired(true)))
    .addSubcommand(sc => sc.setName('clip').setDescription('Create a clip of the current moment'))
    .addSubcommand(sc => sc.setName('chatmode').setDescription('Toggle chat modes')
        .addBooleanOption(o => o.setName('follower_only').setDescription('Follower-only chat'))
        .addBooleanOption(o => o.setName('sub_only').setDescription('Sub-only chat'))
        .addBooleanOption(o => o.setName('slow_mode').setDescription('Slow mode on/off'))
        .addIntegerOption(o => o.setName('slow_seconds').setDescription('Slow mode delay (seconds)').setMinValue(3).setMaxValue(120))
        .addBooleanOption(o => o.setName('emote_only').setDescription('Emote-only chat')))
    .addSubcommand(sc => sc.setName('ban').setDescription('Ban or timeout a user in chat')
        .addStringOption(o => o.setName('user').setDescription('Username to ban').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('Reason').setMaxLength(500))
        .addIntegerOption(o => o.setName('duration').setDescription('Duration in seconds (0 = permanent)').setMinValue(0).setMaxValue(1209600)));

async function resolveBroadcaster(guildId) {
    const [[cfg]] = await pool.execute(
        `SELECT broadcaster_twitch_id, broadcaster_twitch_username, tier_b_token IS NOT NULL AS has_tier_b
           FROM twitch_role_sync_config WHERE guild_id = ? AND enabled = 1 LIMIT 1`, [guildId]);
    return cfg || null;
}

async function execute(interaction) {
    await interaction.deferReply(EPHEMERAL);
    const cfg = await resolveBroadcaster(interaction.guild.id);
    if (!cfg) return interaction.editReply({ content: 'No Twitch broadcaster connected for this server.' });
    if (!cfg.has_tier_b) return interaction.editReply({ content: 'Stream Controls not enabled. Open the analytics page → "Grant write permissions".' });

    const actor = { triggeredByDiscordId: interaction.user.id, triggeredByDiscordUsername: interaction.user.username, guildId: interaction.guild.id };
    const bid = cfg.broadcaster_twitch_id;
    const sub = interaction.options.getSubcommand();
    let result;

    if (sub === 'title') {
        const title = interaction.options.getString('title');
        const categoryId = interaction.options.getString('category_id');
        if (!title && !categoryId) return interaction.editReply({ content: 'Need a title or category_id.' });
        result = await tw.updateChannelInfo(bid, { title: title || undefined, categoryId: categoryId || undefined }, actor);
    } else if (sub === 'shield') {
        result = await tw.toggleShieldMode(bid, interaction.options.getString('state') === 'on', actor);
    } else if (sub === 'snooze-ad') {
        result = await tw.snoozeNextAd(bid, actor);
    } else if (sub === 'raid') {
        const target = interaction.options.getString('target').toLowerCase();
        const { getAccessToken } = await import('../../utils/platforms/twitch-api.js');
        const axios = (await import('axios')).default;
        const token = await getAccessToken();
        const r = await axios.get(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(target)}`, {
            headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` },
        });
        const targetId = r.data?.data?.[0]?.id;
        if (!targetId) return interaction.editReply({ content: `Target channel "${target}" not found.` });
        result = await tw.startRaid(bid, targetId, actor);
    } else if (sub === 'clip') {
        result = await tw.createClip(bid, false, actor);
    } else if (sub === 'chatmode') {
        const settings = {};
        const fo = interaction.options.getBoolean('follower_only');
        const so = interaction.options.getBoolean('sub_only');
        const sm = interaction.options.getBoolean('slow_mode');
        const sw = interaction.options.getInteger('slow_seconds');
        const eo = interaction.options.getBoolean('emote_only');
        if (fo !== null) settings.follower_mode = fo;
        if (so !== null) settings.subscriber_mode = so;
        if (sm !== null) settings.slow_mode = sm;
        if (sw !== null) settings.slow_mode_wait_time = sw;
        if (eo !== null) settings.emote_mode = eo;
        if (!Object.keys(settings).length) return interaction.editReply({ content: 'Pass at least one chat-mode option.' });
        result = await tw.updateChatSettings(bid, settings, actor);
    } else if (sub === 'ban') {
        const userLogin = interaction.options.getString('user').toLowerCase();
        const reason = interaction.options.getString('reason') || '';
        const duration = interaction.options.getInteger('duration') || 0;
        const { getAccessToken } = await import('../../utils/platforms/twitch-api.js');
        const axios = (await import('axios')).default;
        const token = await getAccessToken();
        const r = await axios.get(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(userLogin)}`, {
            headers: { 'Client-ID': process.env.TWITCH_CLIENT_ID, 'Authorization': `Bearer ${token}` },
        });
        const targetId = r.data?.data?.[0]?.id;
        if (!targetId) return interaction.editReply({ content: `User "${userLogin}" not found.` });
        result = await tw.banUser(bid, targetId, reason, duration || null, actor);
    }

    const embed = new EmbedBuilder()
        .setTitle(result?.ok ? '✓ Stream action succeeded' : '✗ Stream action failed')
        .setColor(result?.ok ? 0x4ade80 : 0xe35858)
        .setDescription(`\`${sub}\` on **${cfg.broadcaster_twitch_username}**`)
        .addFields(result?.error ? [{ name: 'Error', value: String(result.error).slice(0, 500) }] : [])
        .setFooter({ text: 'Audit-logged. View full history on the dashboard → Audit log.' })
        .setTimestamp();
    return interaction.editReply({ embeds: [embed] });
}

export { data, execute };
export default { category: 'admin', data, execute, guildScoped: false };
