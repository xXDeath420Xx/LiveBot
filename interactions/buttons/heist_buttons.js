/*
 * Heist message buttons and the stake form.
 *   heist:join:<heistId>    opens the stake modal (heist_stake:<heistId>)
 *   heist:cancel:<heistId>  host or Manage Server calls the heist off (every stake refunded)
 *   heist_stake:<heistId>   modal submit: join with the typed stake
 * Everything is keyed by the heist id in the customId, so old messages keep working after a restart.
 */
import { ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle, PermissionFlagsBits } from 'discord.js';
import heistManager, { HeistError } from '../../core/heist-manager.js';
import { getTarget, maxStake } from '../../core/heist-odds.js';
import economyManager from '../../core/economy-manager.js';
import logger from '../../utils/logger.js';

async function fail(interaction, error, context) {
    const message = error instanceof HeistError ? error.message : 'Something went wrong with that heist — try again.';
    if (!(error instanceof HeistError)) logger.error(`[Heist] ${context} failed`, { error: error.message, customId: interaction.customId });
    const payload = { content: `❌ ${message}`, ephemeral: true };
    if (interaction.deferred || interaction.replied) return interaction.followUp(payload).catch(() => {});
    return interaction.reply(payload).catch(() => {});
}

export async function handleHeistButton(interaction) {
    const [, action, rawId] = interaction.customId.split(':');
    const heistId = parseInt(rawId, 10);
    if (!Number.isInteger(heistId) || !interaction.guild) return fail(interaction, new HeistError('That heist button is no longer valid.'), 'button');

    try {
        const heist = await heistManager.getHeist(heistId);
        if (!heist || heist.guild_id !== interaction.guild.id) throw new HeistError('That heist no longer exists.');

        if (action === 'join') {
            if (heist.status !== 'recruiting' || Number(heist.window_closed)) throw new HeistError('The crew for this heist has already left.');
            // Answer the obvious refusals before asking for a stake.
            const crew = await heistManager.getParticipants(heist.id);
            if (crew.some(p => p.user_id === interaction.user.id)) throw new HeistError('You are already in this crew.');
            if (crew.length >= Number(heist.max_crew)) throw new HeistError('This crew is full.');
            const wait = await heistManager.userCooldownLeft(interaction.guild.id, interaction.user.id);
            if (wait > 0) throw new HeistError(`You're laying low after your last heist. Wait ${wait} more minute${wait === 1 ? '' : 's'}.`);
            const target = getTarget(heist.difficulty);
            const modal = new ModalBuilder()
                .setCustomId(`heist_stake:${heist.id}`)
                .setTitle(`Join the ${heist.target_name} heist`.slice(0, 45));
            const input = new TextInputBuilder()
                .setCustomId('stake')
                .setLabel('Your stake')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(12)
                .setValue(String(target?.minStake ?? heist.min_bet))
                .setPlaceholder(target ? `${target.minStake} - ${maxStake(target)}` : 'Amount');
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            return interaction.showModal(modal);
        }

        if (action === 'cancel') {
            const isAdmin = Boolean(interaction.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild));
            const result = await heistManager.cancelHeist({ guildId: interaction.guild.id, heistId, userId: interaction.user.id, isAdmin });
            await interaction.reply({ content: `🛑 Heist #${heistId} is called off — every stake has been refunded.` });
            await heistManager.refreshHeistMessage(result.heist, result.participants, interaction.client);
            return;
        }

        throw new HeistError('Unknown heist action.');
    } catch (error) {
        return fail(interaction, error, `button ${action}`);
    }
}

export async function handleHeistStakeModal(interaction) {
    const heistId = parseInt(interaction.customId.split(':')[1], 10);
    const raw = String(interaction.fields.getTextInputValue('stake') || '').replace(/[,\s]/g, '');
    const stake = /^\d+$/.test(raw) ? parseInt(raw, 10) : NaN;
    try {
        if (!Number.isInteger(heistId) || !interaction.guild) throw new HeistError('That heist form is no longer valid.');
        if (!Number.isSafeInteger(stake)) throw new HeistError('Type your stake as a whole number, e.g. 250.');
        if (await economyManager.economyStatus(interaction.guild.id) === 'disabled') {
            throw new HeistError('The economy is turned off on this server.');
        }
        const result = await heistManager.joinHeist({ guildId: interaction.guild.id, heistId, userId: interaction.user.id, stake });
        const config = await economyManager.getEconomyConfig(interaction.guild.id);
        await interaction.reply({
            content: `🦹 You're in! ${economyManager.formatMoney(stake, config)} is held for heist #${heistId} until it resolves.`,
            ephemeral: true,
        });
        await heistManager.refreshHeistMessage(result.heist, result.participants, interaction.client);
    } catch (error) {
        return fail(interaction, error, 'join modal');
    }
}

export default { handleHeistButton, handleHeistStakeModal };
