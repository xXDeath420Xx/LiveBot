/**
 * /vision — unified product-shell command for CertiFried's image-intelligence pipeline.
 *
 * Individual stages (OCR / QR decode / scam-text / NSFW / image-text rules / obfuscated URL
 * on text / @everyone / AutoMod escalation) all live inside core/message-threats.js and
 * core/nsfw-protection.js. This command is a read-only overlay so operators can see "is
 * Vision on for this server, and what has it caught" without hunting across four tabs.
 * Hashbot has `/moderation vision usage` + `/moderation vision upgrade`; we don't do tiers so no upgrade.
 *
 * Enable/disable of individual stages still happens via /link-filter threats, /avatarfilter,
 * and the Message Threats / NSFW Protection dashboard pages — we don't duplicate those knobs.
 */
import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../../utils/db.js';

const SOURCE_LABELS = {
    qr: 'QR codes',
    nsfw_image: 'NSFW images',
    image_rule: 'OCR rules',
    scam_text: 'Scam text (AI)',
    obfuscated_url: 'Obfuscated URL',
    automod_escalation: 'AutoMod escalation',
    anti_everyone: '@everyone guard',
};

const data = new SlashCommandBuilder()
    .setName('vision')
    .setDescription('Image intelligence — OCR, QR decode, NSFW, scam text — enablement + usage overview.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand(sub => sub.setName('status').setDescription('Which Vision stages are on for this server + where alerts go.'))
    .addSubcommand(sub => sub.setName('usage').setDescription('Count scans + hits across the Vision pipeline.')
        .addIntegerOption(o => o.setName('days').setDescription('Window in days (1–90, default 7).').setMinValue(1).setMaxValue(90)));

async function readConfig(guildId) {
    const [rows] = await pool.execute(
        `SELECT scan_images, qr_enabled, qr_action,
                everyone_enabled, everyone_webhooks,
                obf_enabled, obf_action,
                ocr_rules_enabled,
                esc_enabled, esc_action,
                nsfw_img_enabled, nsfw_img_action, nsfw_img_daily_cap,
                threat_channel_id, alert_channel_id, report_channel_id
           FROM phishing_config WHERE guild_id = ?`, [String(guildId)]).catch(() => [[]]);
    return rows[0] || {};
}

async function readAvatarNsfwConfig(guildId) {
    const [rows] = await pool.execute(
        `SELECT nsfw_avatar_enabled, nsfw_avatar_action
           FROM join_gate_config WHERE guild_id = ?`, [String(guildId)]).catch(() => [[]]);
    return rows[0] || {};
}

async function readServerStats(guildId) {
    const [rows] = await pool.execute(
        `SELECT nsfw_avatar_scans, nsfw_avatar_hits, nsfw_avatar_reviews,
                nsfw_image_scans, nsfw_image_hits, nsfw_image_reviews
           FROM server_stats WHERE guild_id = ?`, [String(guildId)]).catch(() => [[]]);
    return rows[0] || {};
}

async function statusEmbed(interaction) {
    const guildId = interaction.guildId;
    const [cfg, avatarCfg] = await Promise.all([readConfig(guildId), readAvatarNsfwConfig(guildId)]);

    // Status prefix is plain text (not emoji) — per the "no AI-looking UI" house rule.
    const line = (label, on, extra = '') => `${on ? '`ON `' : '`off`'} **${label}**${extra ? ` — ${extra}` : ''}`;

    const stages = [
        line('OCR + image scan',       !!cfg.scan_images),
        line('QR decode',              !!cfg.qr_enabled,       cfg.qr_action ? `action: ${cfg.qr_action}` : ''),
        line('Obfuscated URL',         !!cfg.obf_enabled,      cfg.obf_action ? `action: ${cfg.obf_action}` : ''),
        line('@everyone guard',        !!cfg.everyone_enabled, cfg.everyone_webhooks ? `webhooks: ${cfg.everyone_webhooks}` : ''),
        line('OCR rules',              !!cfg.ocr_rules_enabled),
        line('AutoMod escalation',     !!cfg.esc_enabled,      cfg.esc_action ? `action: ${cfg.esc_action}` : ''),
        line('NSFW chat-image scan',   !!cfg.nsfw_img_enabled, cfg.nsfw_img_action ? `action: ${cfg.nsfw_img_action}` : ''),
        line('NSFW avatar scan',       !!avatarCfg.nsfw_avatar_enabled, avatarCfg.nsfw_avatar_action ? `action: ${avatarCfg.nsfw_avatar_action}` : ''),
    ].join('\n');

    const threatChannel = cfg.threat_channel_id ? `<#${cfg.threat_channel_id}>` :
                          cfg.alert_channel_id ? `<#${cfg.alert_channel_id}>` :
                          '_(server default log)_';
    const reportChannel = cfg.report_channel_id ? `<#${cfg.report_channel_id}>` : '_(not set)_';

    const dailyCap = Number(cfg.nsfw_img_daily_cap || 0);

    const embed = new EmbedBuilder()
        .setTitle('Vision — status')
        .setDescription(stages)
        .addFields(
            { name: 'Threat alerts', value: threatChannel,                            inline: true },
            { name: 'Scam reports',  value: reportChannel,                            inline: true },
            { name: 'NSFW daily cap',value: dailyCap > 0 ? String(dailyCap) : 'none', inline: true },
        )
        .setFooter({ text: 'Toggle stages via /link-filter threats, /avatarfilter, or the Message Threats / NSFW Protection dashboard pages' });
    return embed;
}

async function usageEmbed(interaction) {
    const days = interaction.options.getInteger('days') ?? 7;
    const guildId = interaction.guildId;

    const [bySource] = await pool.execute(
        `SELECT source, COUNT(*) AS n,
                SUM(CASE WHEN action_taken IN ('ban','timeout','kick','delete') THEN 1 ELSE 0 END) AS acted
           FROM phishing_detections
          WHERE guild_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL ? DAY)
          GROUP BY source
          ORDER BY n DESC`, [String(guildId), days]);

    const stats = await readServerStats(guildId);

    const lines = [];
    for (const r of bySource) {
        const label = SOURCE_LABELS[r.source] || r.source;
        lines.push(`**${label}:** ${r.n} hit${r.n === 1 ? '' : 's'}${Number(r.acted) ? ` · ${r.acted} acted` : ''}`);
    }

    // NSFW counters are maintained on server_stats regardless of detection row writes
    // (quota accounting), so include them even when phishing_detections has no rows for them.
    const nsfwAvatarHits = Number(stats.nsfw_avatar_hits || 0);
    const nsfwImageHits  = Number(stats.nsfw_image_hits  || 0);
    if (nsfwAvatarHits || Number(stats.nsfw_avatar_scans || 0)) {
        lines.push(`**NSFW avatar lifetime:** ${nsfwAvatarHits}/${stats.nsfw_avatar_scans || 0} scanned · ${stats.nsfw_avatar_reviews || 0} queued for review`);
    }
    if (nsfwImageHits || Number(stats.nsfw_image_scans || 0)) {
        lines.push(`**NSFW chat-image lifetime:** ${nsfwImageHits}/${stats.nsfw_image_scans || 0} scanned · ${stats.nsfw_image_reviews || 0} queued for review`);
    }

    if (!lines.length) lines.push('_No Vision hits recorded in the window. Pipeline is either quiet, off, or just enabled._');

    const total = bySource.reduce((a, b) => a + Number(b.n || 0), 0);
    const embed = new EmbedBuilder()
        .setTitle(`Vision — usage (last ${days} day${days === 1 ? '' : 's'})`)
        .setDescription(lines.join('\n'))
        .setFooter({ text: `${total} message-threat event${total === 1 ? '' : 's'} in window · Dashboard → Message Threats for per-row evidence` });
    return embed;
}

async function execute(interaction) {
    const sub = interaction.options.getSubcommand();
    await interaction.deferReply({ ephemeral: true });
    try {
        const embed = sub === 'usage' ? await usageEmbed(interaction) : await statusEmbed(interaction);
        await interaction.editReply({ embeds: [embed] });
    } catch (err) {
        await interaction.editReply(`Vision: ${err.message}`);
    }
}

export { data, execute };
export default { category: 'admin', data, execute };
