import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import logger from '../../utils/logger.js';
import { setOptOut } from '../../core/event-reminder-manager.js';

/**
 * `evrem_optout:<guildId>` — the "Stop reminders from this server" button on an event reminder
 * DM. Pressed in a DM, so there is no guild context: the guild id rides in the customId.
 */
export async function handleEventReminderOptOut(interaction) {
    const guildId = interaction.customId.split(':')[1];
    if (!/^\d{15,25}$/.test(guildId || '')) {
        return interaction.reply({ content: 'This button is no longer valid.', flags: 64 });
    }

    try {
        await setOptOut(guildId, interaction.user.id, true);
    } catch (err) {
        logger.error(`[EventReminders] Opt-out failed: ${err.message}`, { guildId, userId: interaction.user.id });
        return interaction.reply({ content: 'Could not save that right now — please try again in a moment.', flags: 64 });
    }

    const guildName = interaction.client.guilds.cache.get(guildId)?.name || 'that server';
    const note = `You will not get event reminders from **${guildName}** any more. `
        + 'Run `/schedule discord reminders enabled:True` in the server to turn them back on.';

    // Keep the reminder and its "View event" link, drop the opt-out button so it cannot be pressed again.
    const links = (interaction.message?.components || [])
        .flatMap((row) => row.components || [])
        .filter((c) => c.style === ButtonStyle.Link && c.url)
        .slice(0, 5);
    const components = links.length
        ? [new ActionRowBuilder().addComponents(links.map((c) => ButtonBuilder.from(c)))]
        : [];

    try {
        return await interaction.update({ content: note, components });
    } catch (err) {
        logger.warn(`[EventReminders] Could not edit opt-out DM: ${err.message}`);
        return interaction.reply({ content: note, flags: 64 }).catch(() => {});
    }
}

export default { handleEventReminderOptOut };
