/**
 * /modreason — manage per-guild moderation reason aliases.
 *
 * Admins register short tokens that /ban and the /admin mod commands (warn, mute, kick, ban and the rest that
 * take a reason, also typed as !warn, !kick...) expand before persisting (core/moderation-aliases.js reasonOption).
 * See core/moderation-aliases.js for the storage + expand logic.
 */
import { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import { list, add, remove } from '../../core/moderation-aliases.js';

const data = new SlashCommandBuilder()
    .setName('modreason')
    .setDescription('Manage moderation reason aliases (e.g. `gh` → "guideline hopper").')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .addSubcommand(sub => sub
        .setName('add')
        .setDescription('Create or update an alias.')
        .addStringOption(o => o.setName('alias').setDescription('Short token (letters, numbers, . _ -).').setRequired(true).setMaxLength(32))
        .addStringOption(o => o.setName('reason').setDescription('Full reason text to expand to.').setRequired(true).setMaxLength(900)))
    .addSubcommand(sub => sub
        .setName('remove')
        .setDescription('Delete an alias.')
        .addStringOption(o => o.setName('alias').setDescription('Alias to remove.').setRequired(true).setAutocomplete(true)))
    .addSubcommand(sub => sub
        .setName('list')
        .setDescription('List this server’s aliases.'));

async function execute(interaction) {
    if (!interaction.inGuild()) {
        return interaction.reply({ content: 'This command only works in a server.', ephemeral: true });
    }
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'add') {
        await interaction.deferReply({ ephemeral: true });
        const alias = interaction.options.getString('alias');
        const reason = interaction.options.getString('reason');
        const out = await add(guildId, alias, reason, interaction.user.id);
        if (!out.ok) return interaction.editReply({ content: out.error });
        return interaction.editReply({
            content: `✓ Saved. \`${out.row.alias}\` now expands to:\n> ${out.row.full_reason.slice(0, 600)}\nType it as the whole reason in \`/ban\` or \`/admin mod\` warn, mute, kick or ban.`,
        });
    }

    if (sub === 'remove') {
        await interaction.deferReply({ ephemeral: true });
        const alias = interaction.options.getString('alias');
        const out = await remove(guildId, alias);
        if (!out.ok) return interaction.editReply({ content: 'Database error. Try again.' });
        return interaction.editReply({ content: out.removed ? `✓ Removed \`${alias}\`.` : `No alias \`${alias}\` to remove.` });
    }

    if (sub === 'list') {
        await interaction.deferReply({ ephemeral: true });
        const rows = await list(guildId);
        if (!rows.length) {
            return interaction.editReply({
                content: 'No reason aliases yet. Create one with `/modreason add alias:gh reason:guideline hopper (repeat offender)`.',
            });
        }
        const embed = new EmbedBuilder()
            .setTitle('Moderation reason aliases')
            .setDescription(rows.slice(0, 25).map(r => {
                const used = Number(r.uses) || 0;
                const usedStr = used ? ` · ${used} use${used === 1 ? '' : 's'}` : '';
                return `**\`${r.alias}\`**${usedStr}\n> ${String(r.full_reason).slice(0, 180)}`;
            }).join('\n\n'))
            .setFooter({ text: rows.length > 25 ? `Showing first 25 of ${rows.length}` : `${rows.length} alias${rows.length === 1 ? '' : 'es'}` });
        return interaction.editReply({ embeds: [embed] });
    }
}

async function autocomplete(interaction) {
    const focused = interaction.options.getFocused();
    const q = String(focused || '').toLowerCase();
    const rows = await list(interaction.guildId);
    const matching = rows
        .filter(r => !q || r.alias.includes(q) || String(r.full_reason).toLowerCase().includes(q))
        .slice(0, 25)
        .map(r => ({ name: `${r.alias} — ${String(r.full_reason).slice(0, 60)}`.slice(0, 100), value: r.alias }));
    return interaction.respond(matching).catch(() => {});
}

export { data, execute, autocomplete };
export default { category: 'admin', guildScoped: true, data, execute, autocomplete };
