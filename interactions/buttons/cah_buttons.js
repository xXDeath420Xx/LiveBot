/**
 * Button handlers for CAH. Custom-id format: `cah_<action>:<gameId>[:<arg>]`.
 *
 *   cah_join         — join lobby
 *   cah_leave        — leave game
 *   cah_startgame    — host starts the game
 *   cah_hand         — player requests their ephemeral hand
 *   cah_status       — refresh main embed
 *   cah_judge:N      — czar picks winning submission N
 */
import {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits,
    ModalBuilder, TextInputBuilder, TextInputStyle
} from 'discord.js';
import { getGame, STATES } from '../../core/cah-manager.js';
import { buildHandSelectMenu, buildHandEmbed } from '../../core/cah-discord-adapter.js';
import logger from '../../utils/logger.js';

function gameFromId(customId) {
    const parts = customId.split(':');
    return { action: parts[0], gameId: parts[1], arg: parts[2] };
}

export async function handleCahJoin(interaction) {
    const { gameId } = gameFromId(interaction.customId);
    const game = getGame(gameId);
    if (!game) return interaction.reply({ content: '❌ Game no longer exists.', ephemeral: true });
    if (game.state !== STATES.LOBBY) return interaction.reply({ content: '⚠️ Game already in progress.', ephemeral: true });

    // Password-protected? Pop a modal to collect it. The modal handler
    // (cah_pwjoin) will retry the join with the supplied password.
    if (game.passwordHash && interaction.user.id !== game.hostUserId) {
        const modal = new ModalBuilder()
            .setCustomId(`cah_pwjoin:${gameId}`)
            .setTitle('🔒 Password required')
            .addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('password')
                    .setLabel('Lobby password')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMinLength(1)
                    .setMaxLength(64)
            ));
        return interaction.showModal(modal);
    }
    const r = game.addPlayer({ userId: interaction.user.id, platform: 'discord', displayName: interaction.user.displayName || interaction.user.username });
    if (!r.ok) return interaction.reply({ content: `❌ \`${r.reason}\``, ephemeral: true });
    return interaction.reply({ content: `✅ Joined.`, ephemeral: true });
}

export async function handleCahLeave(interaction) {
    const { gameId } = gameFromId(interaction.customId);
    const game = getGame(gameId);
    if (!game) return interaction.reply({ content: '❌ Game no longer exists.', ephemeral: true });
    game.removePlayer(interaction.user.id);
    return interaction.reply({ content: '👋 Left.', ephemeral: true });
}

export async function handleCahStart(interaction) {
    const { gameId } = gameFromId(interaction.customId);
    const game = getGame(gameId);
    if (!game) return interaction.reply({ content: '❌ Game no longer exists.', ephemeral: true });
    if (game.hostUserId !== interaction.user.id) {
        const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
        if (!isAdmin) return interaction.reply({ content: '❌ Only the host can start.', ephemeral: true });
    }
    await interaction.deferUpdate();
    const r = await game.startGame();
    if (!r.ok) {
        return interaction.followUp({ content: `❌ Couldn't start: \`${r.reason}\``, ephemeral: true });
    }
}

export async function handleCahHand(interaction) {
    const { gameId } = gameFromId(interaction.customId);
    const game = getGame(gameId);
    if (!game) return interaction.reply({ content: '❌ Game no longer exists.', ephemeral: true });
    if (game.state !== STATES.SUBMITTING) return interaction.reply({ content: '⏳ Not in submission phase right now.', ephemeral: true });
    if (interaction.user.id === game.czarUserId) {
        return interaction.reply({ content: '👑 You\'re the Card Czar this round — sit tight, no submissions for you.', ephemeral: true });
    }
    const player = game.players.get(interaction.user.id);
    if (!player) return interaction.reply({ content: '❌ You\'re not in this game. Wait for the next lobby.', ephemeral: true });
    if (game.submissions.has(interaction.user.id)) {
        return interaction.reply({ content: '✅ You already submitted. Waiting on others.', ephemeral: true });
    }
    const hand = game._handPayload(player);
    const black = game.currentBlack;
    const embed = buildHandEmbed(gameId, hand, black, black.pick);
    const select = buildHandSelectMenu(gameId, hand, black.pick);
    const row = new ActionRowBuilder().addComponents(select);
    return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

export async function handleCahStatus(interaction) {
    const { gameId } = gameFromId(interaction.customId);
    const game = getGame(gameId);
    if (!game) return interaction.reply({ content: '❌ Game no longer exists.', ephemeral: true });
    const s = game.serialize();
    return interaction.reply({
        content: `**State:** ${s.state} • **Round:** ${s.round}\n**Players:** ${s.players.length} • **Submitted:** ${s.players.filter(p => p.hasSubmitted).length}/${s.players.length - 1}`,
        ephemeral: true
    });
}

export async function handleCahJudge(interaction) {
    const { gameId, arg } = gameFromId(interaction.customId);
    const game = getGame(gameId);
    if (!game) return interaction.reply({ content: '❌ Game no longer exists.', ephemeral: true });
    const submissionId = parseInt(arg, 10);
    if (!Number.isInteger(submissionId)) return interaction.reply({ content: '❌ Bad submission.', ephemeral: true });
    if (interaction.user.id !== game.czarUserId) {
        return interaction.reply({ content: '❌ Only the Card Czar can judge.', ephemeral: true });
    }
    // ── [cah-trace] Button → engine boundary. Log the click and capture any
    // throw out of pickWinner with full context — previously a thrown engine
    // error would bubble uncaught into the interaction router with no game id.
    logger.info(`[cah-trace ${gameId}] handleCahJudge CLICK czar=${interaction.user.id} submissionId=${submissionId} round=${game.round} state=${game.state}`);
    await interaction.deferUpdate();
    let r;
    try {
        r = await game.pickWinner(interaction.user.id, submissionId);
    } catch (err) {
        logger.error(`[cah-trace ${gameId}] handleCahJudge pickWinner THREW: ${err.message}\n${err.stack}`);
        return interaction.followUp({ content: `❌ The round hit an error resolving. (logged: \`${err.message}\`)`, ephemeral: true }).catch(() => {});
    }
    logger.info(`[cah-trace ${gameId}] handleCahJudge pickWinner result=${JSON.stringify(r)}`);
    if (!r.ok) return interaction.followUp({ content: `❌ \`${r.reason}\``, ephemeral: true });
}
