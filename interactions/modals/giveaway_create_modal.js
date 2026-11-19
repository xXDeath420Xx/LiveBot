import GiveawayManager from '../../core/giveaway-manager.js';
import logger from '../../utils/logger.js';
import { parseTimeToSeconds, formatDuration } from '../../utils/timeParser.js';
import { memberMayHostGiveaways } from '../buttons/giveaway_create.js';

const MIN_SECONDS = 10;
const MAX_SECONDS = 15552000; // 6 months — same ceiling the dashboard API enforces

// Same per-client rule as the slash handler: GiveawayManager resolves guilds via
// `this.client.guilds.cache`, so it must be the client that actually serves this guild.
const managers = new WeakMap();
function getManager(client) {
    if (client.giveawayManager) return client.giveawayManager;
    if (!managers.has(client)) managers.set(client, new GiveawayManager(client));
    return managers.get(client);
}

export async function handleGiveawayCreateModal(interaction) {
    try {
        // Re-check the gate on submit — a role can be removed between opening the
        // modal and sending it, and the modal itself carries no permission of its own.
        if (!await memberMayHostGiveaways(interaction.member)) {
            return interaction.reply({
                content: "You don't have permission to start giveaways here.",
                ephemeral: true,
            });
        }

        await interaction.deferReply({ ephemeral: true });

        const prize = interaction.fields.getTextInputValue('prize').trim();
        const winnersRaw = interaction.fields.getTextInputValue('winners').trim();
        const durationRaw = interaction.fields.getTextInputValue('duration').trim();

        const winners = parseInt(winnersRaw, 10);
        if (!Number.isInteger(winners) || winners < 1 || winners > 100) {
            return interaction.editReply('❌ Number of winners must be a whole number between 1 and 100.');
        }

        const seconds = parseTimeToSeconds(durationRaw);
        if (seconds === null) {
            return interaction.editReply(`❌ I couldn't read "${durationRaw}" as a duration. Try things like \`30m\`, \`12h\`, \`3d\`, \`1w\`, or \`1d 12h\`.`);
        }
        if (seconds < MIN_SECONDS) {
            return interaction.editReply('❌ A giveaway has to run for at least 10 seconds.');
        }
        if (seconds > MAX_SECONDS) {
            return interaction.editReply('❌ A giveaway can run for at most 6 months.');
        }

        const mgr = getManager(interaction.client);
        const result = await mgr.createGiveaway(
            interaction.guild.id,
            interaction.channel.id,
            interaction.user.id,
            prize,
            winners,
            seconds
        );

        await interaction.editReply(
            `✅ Giveaway posted — **${prize}**, ${winners} winner(s), ending in ${formatDuration(seconds)}.\n` +
            `Members enter by reacting 🎉. To end it early or reroll: \`/manage giveaway end\` / \`reroll\` with message ID \`${result.messageId}\`.`
        );
    } catch (err) {
        logger.error('[giveaway_create_modal] error', { err: err.message, stack: err.stack });
        const msg = '❌ Failed to create the giveaway. Check that I can post and add reactions in this channel.';
        if (interaction.deferred) await interaction.editReply(msg).catch(() => {});
        else if (!interaction.replied) await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
}

export default handleGiveawayCreateModal;
