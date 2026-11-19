/**
 * /subs — admin management for streamer subscriptions in this guild.
 *
 *   list                    — show currently-departed subscriptions (paused + unseen)
 *   restore mode:all        — undo every departure in this guild
 *   restore mode:except-manual — undo everything EXCEPT subscriptions marked
 *                                 departed_reason='manual' (admin-triggered removals)
 *   rescan                  — alias for /livecheck, scoped to this guild
 *
 * Why both all and except-manual: 'all' is the brute-force "I'm resetting
 * everything after a bot swap"; 'except-manual' respects deliberate staff removals.
 * No retroactive marking — only subscriptions departed AFTER migration 381
 * can be flagged 'manual'. Pre-migration subs are indistinguishable from auto-pauses.
 */
import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import { listDeparted } from '../../core/streamer-departure.js';
import { rescanGuildStreamers } from '../../core/stream-manager.js';

const EPHEMERAL = { flags: 64 };

const data = new SlashCommandBuilder()
    .setName('subs')
    .setDescription('Streamer subscription management (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand(sc => sc
        .setName('list')
        .setDescription('List subscriptions currently departed / paused in this server'))
    .addSubcommand(sc => sc
        .setName('restore')
        .setDescription('Restore departed subscriptions')
        .addStringOption(o => o
            .setName('mode').setDescription('Which departed subscriptions to restore').setRequired(true)
            .addChoices(
                { name: 'all — undo every departure', value: 'all' },
                { name: 'except-manual — skip admin-removed subs', value: 'except-manual' },
            )))
    .addSubcommand(sc => sc
        .setName('rescan')
        .setDescription('Force a Twitch/Kick/YouTube live-check for every tracked streamer here'));

async function execute(interaction) {
    const sc = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sc === 'list') {
        await interaction.deferReply(EPHEMERAL);
        const rows = await listDeparted(guildId);
        if (!rows.length) {
            return interaction.editReply({ content: 'No departed subscriptions in this server.' });
        }
        const summary = rows.slice(0, 25).map(r =>
            `• **${r.username}** (${r.platform}) — gone **${r.days_gone}d**, reason: \`${r.departed_reason || '?'}\``,
        ).join('\n');
        const more = rows.length > 25 ? `\n\n*…and ${rows.length - 25} more*` : '';
        const embed = new EmbedBuilder()
            .setColor(0xe2b23a)
            .setTitle(`🧾 Departed subscriptions (${rows.length})`)
            .setDescription(summary + more);
        return interaction.editReply({ embeds: [embed] });
    }

    if (sc === 'restore') {
        await interaction.deferReply(EPHEMERAL);
        const mode = interaction.options.getString('mode');
        const whereManual = mode === 'except-manual'
            ? "AND (departed_reason IS NULL OR departed_reason <> 'manual')"
            : '';
        const [res] = await pool.query(
            `UPDATE subscriptions SET paused = 0, departed_at = NULL, departed_reason = NULL
              WHERE guild_id = ? AND departed_at IS NOT NULL ${whereManual}`,
            [guildId]);
        const embed = new EmbedBuilder()
            .setColor(res.affectedRows ? 0x4fc38a : 0x7aa2f7)
            .setTitle(res.affectedRows ? '✅ Subscriptions restored' : 'ℹ️ No subscriptions matched')
            .setDescription([
                `**Mode:** \`${mode}\``,
                `**Restored:** ${res.affectedRows}`,
                mode === 'except-manual' ? '*Admin-removed (`departed_reason=manual`) subscriptions were left as-is.*' : '',
            ].filter(Boolean).join('\n'));
        return interaction.editReply({ embeds: [embed] });
    }

    if (sc === 'rescan') {
        await interaction.deferReply(EPHEMERAL);
        const result = await rescanGuildStreamers(guildId, { forceLive: true });
        const embed = new EmbedBuilder()
            .setColor(result.announced ? 0x4fc38a : 0x7aa2f7)
            .setTitle(result.announced ? '✅ Rescan complete — found live streamers' : 'ℹ️ Rescan complete — nothing new')
            .setDescription([
                `**${result.scope}** tracked streamer(s) scanned`,
                result.announced ? `**${result.announced}** newly announced` : 'No streamers newly announced.',
                result.errors ? `*${result.errors} error(s) during scan — see logs*` : '',
            ].filter(Boolean).join('\n'));
        if (result.newlyLive?.length) {
            embed.addFields({
                name: 'Just posted',
                value: result.newlyLive.slice(0, 20).map(s => `• **${s.username}** → <#${s.channelId}>`).join('\n'),
            });
        }
        return interaction.editReply({ embeds: [embed] });
    }
}

export default { category: 'admin', data, execute };
