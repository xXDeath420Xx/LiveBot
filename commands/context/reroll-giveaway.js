/**
 * "Reroll Giveaway" message-context command. Right-click a bot giveaway message
 * → Apps → Reroll Giveaway. Re-selects winners from existing entries (does NOT
 * re-open the giveaway or extend time). Audit columns on giveaways row track
 * reroll count + who/when.
 */
import { ApplicationCommandType, ContextMenuCommandBuilder, PermissionFlagsBits, EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

const data = new ContextMenuCommandBuilder()
    .setName('Reroll Giveaway')
    .setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false);

function pickWinners(entries, count) {
    const pool = [...entries];
    const picked = [];
    for (let i = 0; i < count && pool.length; i++) {
        const idx = Math.floor(Math.random() * pool.length);
        picked.push(pool.splice(idx, 1)[0]);
    }
    return picked;
}

async function execute(interaction) {
    const target = interaction.targetMessage;
    const guild  = interaction.guild;
    if (!guild) return interaction.reply({ content: 'Server only.', ephemeral: true });

    const [[g]] = await pool.execute(
        `SELECT id, winner_count, winners, is_active FROM giveaways
          WHERE guild_id = ? AND message_id = ?`,
        [guild.id, target.id]);
    if (!g) return interaction.reply({ content: 'That message isn\'t a CertiFried giveaway.', ephemeral: true });
    if (g.is_active) return interaction.reply({ content: 'This giveaway is still running. Wait for it to end first, then reroll.', ephemeral: true });

    // Entries are the 🎉 reactions on the giveaway message (core/giveaway-manager.js); there is no
    // entries table (a query against a never-created giveaway_entries table was removed 2026-11-18).
    let entries = [];
    {
        // Fallback: user reactions on the original message (minus bot).
        try {
            const msg = await target.channel.messages.fetch(target.id);
            for (const reaction of msg.reactions.cache.values()) {
                const users = await reaction.users.fetch();
                for (const u of users.values()) if (!u.bot) entries.push(u.id);
            }
            entries = [...new Set(entries)];
        } catch (err) {
            logger.warn(`[reroll] reactions fetch failed: ${err.message}`);
        }
    }
    if (!entries.length) return interaction.reply({ content: 'No entries to re-roll from.', ephemeral: true });

    const winners = pickWinners(entries, g.winner_count || 1);
    await pool.execute(
        `UPDATE giveaways SET winners = ?, rerolled_count = rerolled_count + 1,
                               last_rerolled_at = NOW(), last_rerolled_by = ?
          WHERE id = ?`,
        [JSON.stringify(winners), interaction.user.id, g.id]);

    const embed = new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle('Giveaway re-rolled')
        .setDescription(winners.map(w => `• <@${w}>`).join('\n') || 'No winners selected.')
        .addFields(
            { name: 'Rerolled by', value: `<@${interaction.user.id}>`, inline: true },
            { name: 'Jump to original', value: `[Message](${target.url})`, inline: true },
        )
        .setFooter({ text: `Reroll #${(g.rerolled_count || 0) + 1}` });
    try {
        await target.channel.send({
            content: `**New winner${winners.length === 1 ? '' : 's'}:** ${winners.map(w => `<@${w}>`).join(', ')} — reroll from ${target.url}`,
            allowedMentions: { users: winners },
        });
    } catch { /* non-fatal */ }
    return interaction.reply({ embeds: [embed], ephemeral: true });
}

export { data, execute };
export default { category: 'context', data, execute };
