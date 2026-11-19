/**
 * /livecheck — admin-only: force a Twitch live-check for every tracked streamer in this guild.
 *
 * Fires when there's reason to suspect the live-notification system missed something
 * (an EventSub subscription was created after the streamer went live, Helix flaked for
 * a cycle, etc.). Runs the same check pipeline as the scheduled sweep but scoped to
 * this guild's streamers only, and reports what newly fired.
 */
import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { rescanGuildStreamers } from '../../core/stream-manager.js';

const data = new SlashCommandBuilder()
    .setName('livecheck')
    .setDescription('Force a Twitch / Kick / YouTube live-check for every tracked streamer in this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addBooleanOption(o => o.setName('force')
        .setDescription('Bypass cached offline state (default: on). Turn off to only re-check uncached streamers.')
        .setRequired(false));

async function execute(interaction) {
    await interaction.deferReply({ flags: 64 });
    const forceLive = interaction.options.getBoolean('force') ?? true;
    try {
        const result = await rescanGuildStreamers(interaction.guildId, { forceLive });
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
        await interaction.editReply({ embeds: [embed] });
    } catch (err) {
        await interaction.editReply({
            content: `Rescan failed: ${err.message}`,
        });
    }
}

export default { category: 'admin', data, execute };
