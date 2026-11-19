/*
 * /member-flag — set/clear Discord's GuildMemberFlags on a specific member.
 *
 * The only writeable flag today is `BypassesVerification` (bit 1 << 2) which
 * lets a trusted member skip verification/screening. The other 2026-era bits
 * (DidRejoin, CompletedOnboarding, etc.) are read-only — Discord sets them
 * itself based on member behaviour, and PATCHing them is a no-op.
 *
 * Guild-only, Manage Guild required. Changes are reflected on
 * `/user profile info` via `buildMemberFlagsLine()`.
 */
import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
    GuildMemberFlags,
    EmbedBuilder,
} from 'discord.js';
import logger from '../../utils/logger.js';

export default {
    category: 'admin',
    data: new SlashCommandBuilder()
        .setName('member-flag')
        .setDescription('Set or clear a writeable GuildMemberFlag on a member.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand(s => s.setName('bypass-verification').setDescription('Grant or revoke the verification-bypass flag.')
            .addUserOption(o => o.setName('member').setDescription('The member to flag').setRequired(true))
            .addBooleanOption(o => o.setName('enabled').setDescription('true grants, false revokes').setRequired(true))
            .addStringOption(o => o.setName('reason').setDescription('Audit-log reason').setMaxLength(400)))
        .addSubcommand(s => s.setName('show').setDescription('List current flags on a member.')
            .addUserOption(o => o.setName('member').setDescription('The member to inspect').setRequired(true))),

    async execute(interaction) {
        if (!interaction.inGuild()) {
            return interaction.reply({ content: 'Server-only.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const sub = interaction.options.getSubcommand();
        const user = interaction.options.getUser('member', true);
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) return interaction.editReply({ content: 'That user is not in this server.' });

        if (sub === 'show') {
            const bits = member.flags?.bitfield ?? 0n;
            const labels = [];
            const probe = (bit, name) => { if ((BigInt(bits) & BigInt(bit)) === BigInt(bit)) labels.push(name); };
            probe(1 << 0, 'DidRejoin');
            probe(1 << 1, 'CompletedOnboarding');
            probe(1 << 2, 'BypassesVerification');
            probe(1 << 3, 'StartedOnboarding');
            probe(1 << 4, 'IsGuest');
            probe(1 << 5, 'StartedHomeActions');
            probe(1 << 6, 'CompletedHomeActions');
            probe(1 << 7, 'AutomodQuarantinedUsername');
            return interaction.editReply({
                embeds: [new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle(`${user.tag} — Guild member flags`)
                    .setDescription(labels.length ? labels.map(l => '• ' + l).join('\n') : '*(no flags set)*')
                    .setFooter({ text: `bitfield = ${bits}` })
                    .setTimestamp()],
            });
        }

        if (sub === 'bypass-verification') {
            const enable = interaction.options.getBoolean('enabled', true);
            const reason = interaction.options.getString('reason') || `Set by ${interaction.user.tag}`;
            try {
                const currentBits = BigInt(member.flags?.bitfield ?? 0);
                const bit = BigInt(GuildMemberFlags.BypassesVerification);
                const nextBits = enable ? (currentBits | bit) : (currentBits & ~bit);
                await member.edit({ flags: Number(nextBits), reason });
                logger.info('[member-flag] bypass-verification', {
                    guildId: interaction.guild.id, memberId: member.id, enable,
                    by: interaction.user.id, from: String(currentBits), to: String(nextBits),
                });
                return interaction.editReply({ content:
                    `${enable ? 'Granted' : 'Cleared'} verification bypass for ${user}.`,
                });
            } catch (err) {
                if (err?.code === 50013) return interaction.editReply({ content: 'Discord refused — bot missing Manage Guild / role too low.' });
                logger.error('[member-flag] write failed', { err: err.message });
                return interaction.editReply({ content: `Failed: ${err.message}` });
            }
        }
    },
};
