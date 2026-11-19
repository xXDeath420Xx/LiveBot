/*
 * Confirm / cancel for /privacy delete (commands/tools/privacy.js).
 *
 * custom id: `privdel:<yes|no>:<userId>:<issuedAtSeconds>` — everything the handler needs rides
 * in the id, so the prompt still works after a restart. Only the member who asked can press it,
 * and only within PROMPT_TTL_SECONDS.
 */

import { EmbedBuilder } from 'discord.js';
import logger from '../../utils/logger.js';
import { themeColor } from '../../core/guild-theme.js';
import { deleteUserData, secondsSinceLast, DELETE_COOLDOWN_SECONDS } from '../../core/privacy-manager.js';

const PROMPT_TTL_SECONDS = 10 * 60;
const inProgress = new Set();

export async function handlePrivacyDeleteButton(interaction) {
    const [, action, userId, issuedRaw] = interaction.customId.split(':');

    if (interaction.user.id !== userId) {
        return interaction.reply({ content: 'This confirmation belongs to someone else.', ephemeral: true });
    }
    if (action === 'no') {
        return interaction.update({ content: 'Cancelled — nothing was deleted.', embeds: [], components: [] });
    }
    if (action !== 'yes') return false;

    const issued = Number(issuedRaw);
    if (!Number.isFinite(issued) || Date.now() / 1000 - issued > PROMPT_TTL_SECONDS) {
        return interaction.update({ content: 'This confirmation has expired. Run `/privacy delete` again.', embeds: [], components: [] });
    }
    if (inProgress.has(userId)) {
        return interaction.reply({ content: 'Your deletion is already running.', ephemeral: true });
    }
    const ago = await secondsSinceLast(userId, 'delete');
    if (ago !== null && ago < DELETE_COOLDOWN_SECONDS && ago < Date.now() / 1000 - issued) {
        // Already done since this prompt was shown (e.g. a second prompt was confirmed first).
        return interaction.update({ content: 'Your data has already been deleted.', embeds: [], components: [] });
    }

    inProgress.add(userId);
    try {
        await interaction.update({ content: '⏳ Deleting your data…', embeds: [], components: [] });
        const result = await deleteUserData(userId);

        const tables = Object.keys(result.deleted).length + Object.keys(result.anonymised).length;
        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, result.failed.length ? 'warning' : 'success'))
            .setTitle(result.failed.length ? 'Deletion finished with problems' : '✅ Your data was deleted')
            .setDescription(result.rows
                ? `Removed or anonymised ${result.rows} row(s) across ${tables} table(s).`
                : 'There was nothing to delete.')
            .setFooter({ text: 'New activity is recorded again as you use the bot. /privacy opt-out stops message logging.' })
            .setTimestamp();
        if (result.failed.length) {
            embed.addFields({
                name: 'Not completed',
                value: `Some data could not be removed (${result.failed.length} table(s)). This has been logged; run \`/privacy delete\` again later or contact support.`,
            });
        }
        await interaction.editReply({ content: '', embeds: [embed], components: [] });
    } catch (error) {
        logger.error('[Privacy] Deletion failed', { userId, error: error.message, stack: error.stack });
        await interaction.editReply({ content: 'The deletion failed part-way. It has been logged; please try again later.', embeds: [], components: [] }).catch(() => {});
    } finally {
        inProgress.delete(userId);
    }
    return true;
}

export default handlePrivacyDeleteButton;
