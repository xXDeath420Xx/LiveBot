/**
 * Live PvP combat action button handler.
 *
 * customId format: `pvp_act:<matchId>:<attack|defend|forfeit>`
 *
 * On click:
 *  - parse matchId + action
 *  - resolve the clicker's active character in this guild
 *  - ensure the clicker is a participant
 *  - attack/defend: enforce turn (offer a timeout-claim if the OTHER side's turn
 *    has expired); forfeit: either participant may forfeit
 *  - call the manager, EDIT the board message in place with the new state
 *    (disabling buttons + showing the winner/ELO when the match ends), and ack
 *    the clicker with an ephemeral confirmation.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import RPGPvPManager from '../../core/rpg-pvp-manager.js';
import { buildPvpBoardEmbed, buildPvpActionRow } from '../../commands/games/rpg/handlers/pvpBoard.js';
import logger from '../../utils/logger.js';

const TURN_TIMEOUT_MS = 600000; // 10 minutes

export async function handlePvpAct(interaction) {
    if (!interaction.isButton?.() || !interaction.customId?.startsWith('pvp_act:')) return false;

    const parts = interaction.customId.split(':');
    const matchId = Number(parts[1]);
    const action = parts[2];

    try {
        const characterManager = interaction.client.rpgCharacterManager;
        if (!characterManager) {
            await interaction.reply({ content: 'RPG system is not available right now.', ephemeral: true });
            return true;
        }

        const character = await characterManager.getActiveCharacter(interaction.user.id, interaction.guild.id);
        if (!character) {
            await interaction.reply({ content: 'You need a character first. Create one with `/rpg character create`.', ephemeral: true });
            return true;
        }

        const match = await RPGPvPManager.getMatch(matchId);
        if (!match || match.status !== 'active') {
            await interaction.reply({ content: 'This match is no longer active.', ephemeral: true });
            return true;
        }

        const myCharId = character.character_id;
        const isParticipant = [Number(match.challenger_id), Number(match.defender_id)].includes(Number(myCharId));
        if (!isParticipant) {
            await interaction.reply({ content: 'You are not a participant in this duel.', ephemeral: true });
            return true;
        }

        // ---- FORFEIT: either participant may forfeit ----
        if (action === 'forfeit') {
            await interaction.deferUpdate();
            const result = await RPGPvPManager.forfeit(matchId, myCharId);
            await renderEnded(interaction, matchId, characterManager, result, `${character.character_name} forfeited.`);
            await interaction.followUp({ content: 'You forfeited the duel.', ephemeral: true }).catch(() => {});
            return true;
        }

        // ---- ATTACK / DEFEND: must be your turn (or claim an expired opponent turn) ----
        if (action !== 'attack' && action !== 'defend') {
            await interaction.reply({ content: 'Unknown action.', ephemeral: true });
            return true;
        }

        const isMyTurn = Number(match.active_turn) === Number(myCharId);
        if (!isMyTurn) {
            // Not my turn — maybe the active side has timed out, letting me claim the win.
            try {
                const result = await RPGPvPManager.claimTimeout(matchId, myCharId, TURN_TIMEOUT_MS);
                await interaction.deferUpdate();
                await renderEnded(interaction, matchId, characterManager, result, 'Opponent ran out of time.');
                await interaction.followUp({ content: 'Opponent timed out — you win!', ephemeral: true }).catch(() => {});
                return true;
            } catch {
                await interaction.reply({ content: "It's not your turn yet.", ephemeral: true });
                return true;
            }
        }

        await interaction.deferUpdate();
        const res = await RPGPvPManager.applyAction(matchId, myCharId, action, characterManager);

        if (res.ended) {
            await renderEnded(interaction, matchId, characterManager, res.result, `${res.winnerName} wins!`);
            await interaction.followUp({ content: `You landed the finishing blow — victory!`, ephemeral: true }).catch(() => {});
            return true;
        }

        // Re-render the live board in place with the new state + active turn.
        await editBoard(interaction, res.state);
        const verb = action === 'attack' ? 'attacked' : 'took a defensive stance';
        await interaction.followUp({ content: `You ${verb}. Waiting for your opponent.`, ephemeral: true }).catch(() => {});
        return true;
    } catch (err) {
        logger.error('[pvp_act] error', { err: err.message, stack: err.stack, customId: interaction.customId });
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.followUp({ content: err.message || 'Something went wrong.', ephemeral: true }).catch(() => {});
            } else {
                await interaction.reply({ content: err.message || 'Something went wrong.', ephemeral: true }).catch(() => {});
            }
        } catch { /* noop */ }
        return true;
    }
}

/**
 * Edit the live board message in place with a fresh state render.
 */
async function editBoard(interaction, state) {
    const embed = buildPvpBoardEmbed(state);
    const row = buildPvpActionRow(state.matchId);
    // The button click came from the board message itself; edit it.
    await interaction.editReply({ embeds: [embed], components: [row] }).catch(async () => {
        // Fallback: the interaction message may differ from the stored board; edit by id.
        await editBoardById(interaction, state, [embed], [row]);
    });
}

/**
 * Render the FINAL (ended) board: full result embed, buttons disabled.
 */
async function renderEnded(interaction, matchId, characterManager, result, headline) {
    const state = await RPGPvPManager.getLiveState(matchId, characterManager);
    const embed = buildPvpBoardEmbed(state, { ended: true, result, headline });
    const row = buildPvpActionRow(matchId, { disabled: true });
    await interaction.editReply({ embeds: [embed], components: [row] }).catch(async () => {
        await editBoardById(interaction, state, [embed], [row]);
    });
}

/**
 * Fallback edit by the stored board_channel_id/board_message_id when the
 * interaction message isn't the board (e.g. action came from a slash command).
 */
async function editBoardById(interaction, state, embeds, components) {
    const chId = state.match.board_channel_id;
    const msgId = state.match.board_message_id;
    if (!chId || !msgId) return;
    try {
        const channel = await interaction.client.channels.fetch(chId);
        const message = await channel.messages.fetch(msgId);
        await message.edit({ embeds, components });
    } catch (err) {
        logger.warn('[pvp_act] board edit-by-id failed', { err: err.message, matchId: state.matchId });
    }
}

export default handlePvpAct;
