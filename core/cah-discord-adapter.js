/**
 * Translates CAHGame events into Discord channel messages + per-player
 * ephemeral interactions. One adapter per game, attached on game creation.
 *
 * Event → Discord mapping:
 *   gameStarted     → edit main lobby message into "Round 1 starting"
 *   roundStarted    → edit main message to black-card embed with "View My Hand" + "Scoreboard" buttons
 *   handDealt       → no-op (hand is pulled on demand when player clicks View My Hand)
 *   judgingStarted  → edit main message to numbered anonymized submissions + judge buttons (czar only)
 *   roundWon        → channel post with winner + winning cards
 *   gameEnded       → channel post with final scoreboard
 *
 * Player flow:
 *   Click "View My Hand" → ephemeral reply with their hand as a select menu
 *   Pick N cards (matching black.pick) → submit; if any blanks selected, prompt for text via modal
 */
import {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder
} from 'discord.js';
import logger from '../utils/logger.js';

const adapterState = new Map();   // gameId -> { clientId, channelId, mainMessageId, lastSubmissions, lastBlack }

function fmtBlack(text) {
    return text.replace(/_____/g, '`______`');
}

function scoreboardLines(players) {
    return players
        .slice()
        .sort((a, b) => b.points - a.points)
        .map(p => `${p.isCzar ? '👑' : '•'} <@${p.userId}> — **${p.points}** pt${p.points === 1 ? '' : 's'}${p.hasSubmitted ? ' ✅' : ''}`)
        .join('\n');
}

export function attachDiscordAdapter(game, client) {
    const state = {
        clientId: client.user?.id,
        channelId: game.channelId,
        mainMessageId: game._mainMessageId || null,
        lastBlack: null
    };
    adapterState.set(game.id, state);

    const getChannel = async () => {
        const ch = await client.channels.fetch(game.channelId).catch(() => null);
        return ch;
    };

    const editMain = async (payload) => {
        const ch = await getChannel();
        if (!ch) { logger.warn(`[cah-trace ${game.id}] editMain: channel ${game.channelId} not fetchable`); return null; }
        if (!state.mainMessageId) { logger.warn(`[cah-trace ${game.id}] editMain: no mainMessageId in adapter state (adapter not attached for this message? rehydrated game?)`); return null; }
        try {
            const msg = await ch.messages.fetch(state.mainMessageId);
            return await msg.edit(payload);
        } catch (err) {
            logger.warn(`[cah-discord ${game.id}] couldn't edit main message: ${err.message}`);
            const newMsg = await ch.send(payload);
            state.mainMessageId = newMsg.id;
            return newMsg;
        }
    };

    // ── [cah-trace] Wrap every game-event listener. EventEmitter.emit() invokes
    // these async listeners synchronously and DISCARDS the returned promise, so
    // any throw inside a listener becomes a context-free unhandledRejection
    // (logged at index.js with no game/round/event). This wrapper logs entry and
    // catches + attributes the error to the exact game + event, which is what
    // makes a stalled round ("doesn't move on from round 2") diagnosable.
    const traced = (event, fn) => game.on(event, async (payload) => {
        logger.info(`[cah-trace ${game.id}] adapter:${event} ENTER state=${game.state} round=${game.round}`);
        try {
            await fn(payload);
            logger.info(`[cah-trace ${game.id}] adapter:${event} OK`);
        } catch (err) {
            logger.error(`[cah-trace ${game.id}] adapter:${event} THREW: ${err.message}\n${err.stack}\npayload=${(() => { try { return JSON.stringify(payload); } catch { return '[unserializable]'; } })()}`);
        }
    });

    game.on('playerJoined', async () => {
        if (game.state !== 'LOBBY') return;
        const summary = game._playerSummaries();
        // Always include the web URL — every game is reachable at /cah/<id>
        // regardless of how it was created, so don't strip the link when the
        // embed gets rewritten on each join.
        const webUrl = `https://certifriedmultitool.com/cah/${game.id}`;
        const passwordLine = game.passwordHash ? '\n🔒 **Password required** — ask the host.' : '';
        const lobbyEmbed = new EmbedBuilder()
            .setColor(0xE94B3C)
            .setTitle('🃏 CAH Lobby')
            .setDescription(`**Host:** <@${game.hostUserId}>\n[Open on certifriedmultitool.com](${webUrl})${passwordLine}\n\n**Players (${summary.length}):**\n${summary.map(p => `• <@${p.userId}>`).join('\n')}\n\nClick **Join** to play. Host clicks **Start** when ready (min 3).`)
            .setFooter({ text: `Game id: ${game.id.slice(0, 8)}` });
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`cah_join:${game.id}`).setLabel('Join').setStyle(ButtonStyle.Success).setEmoji('🎴'),
            new ButtonBuilder().setCustomId(`cah_leave:${game.id}`).setLabel('Leave').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`cah_startgame:${game.id}`).setLabel('Start').setStyle(ButtonStyle.Primary).setEmoji('▶️')
        );
        await editMain({ embeds: [lobbyEmbed], components: [row] });
    });

    traced('roundStarted', async ({ round, blackCard, czarUserId }) => {
        state.lastBlack = blackCard;
        const players = game._playerSummaries();
        // DM each Discord player their hand at round start. Falls back silently
        // if their DMs are closed — they can still use the "View My Hand" button.
        for (const p of players) {
            if (p.platform !== 'discord' || p.userId === czarUserId) continue;
            const player = game.players.get(p.userId);
            if (!player) continue;
            try {
                const user = await client.users.fetch(p.userId).catch(() => null);
                if (!user) continue;
                const dm = await user.createDM().catch(() => null);
                if (!dm) continue;
                const handLines = player.hand.map((id, i) => {
                    const c = game.whiteCards.get(id);
                    return `**${i + 1}.** ${c?.isBlank ? '✍️ [BLANK]' : (c?.text || '[?]')}`;
                });
                const embed = new EmbedBuilder()
                    .setColor(0xa78bfa)
                    .setTitle(`🎴 Round ${round} — Your Hand`)
                    .setDescription(`**Prompt:** ${fmtBlack(blackCard.text)}\n_Pick ${blackCard.pick} from your hand and use the buttons in the game channel._\n\n${handLines.join('\n')}`)
                    .setFooter({ text: `Game ${game.id.slice(0, 8)} — DMs let you see your hand without clicking "View My Hand" each round` });
                await dm.send({ embeds: [embed] }).catch(() => {});
            } catch (_) { /* DM closed or other transient — non-fatal */ }
        }
        const embed = new EmbedBuilder()
            .setColor(0x000000)
            .setTitle(`🎴 Round ${round} — Card Czar: <@${czarUserId}>`.replace(/<@[^>]+>/, ''))
            .setDescription(`**Card Czar:** <@${czarUserId}>\n\n**${fmtBlack(blackCard.text)}**\n\n_Pick ${blackCard.pick} card${blackCard.pick === 1 ? '' : 's'} from your hand. Click **View My Hand**._`)
            .addFields({ name: 'Scoreboard', value: scoreboardLines(players) || '_no players_' })
            .setFooter({ text: game.settings.timeoutEnabled ? `⏱️ ${game.settings.timeoutSeconds}s per round` : 'no timeout' });
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`cah_hand:${game.id}`).setLabel('View My Hand').setStyle(ButtonStyle.Primary).setEmoji('🎴'),
            new ButtonBuilder().setCustomId(`cah_status:${game.id}`).setLabel('Refresh').setStyle(ButtonStyle.Secondary).setEmoji('🔄'),
            new ButtonBuilder().setCustomId(`cah_leave:${game.id}`).setLabel('Leave').setStyle(ButtonStyle.Danger)
        );
        await editMain({ embeds: [embed], components: [row] });
    });

    traced('cardsSubmitted', async ({ submittedCount, expectedCount }) => {
        // Light-touch progress update on the same embed
        const ch = await getChannel();
        if (!ch || !state.mainMessageId || !state.lastBlack) return;
        try {
            const msg = await ch.messages.fetch(state.mainMessageId);
            const embed = EmbedBuilder.from(msg.embeds[0]);
            embed.spliceFields(0, 1, { name: 'Submissions', value: `${submittedCount}/${expectedCount} in` });
            await msg.edit({ embeds: [embed], components: msg.components });
        } catch { /* best-effort */ }
    });

    traced('judgingStarted', async ({ czarUserId, blackCard, submissions }) => {
        const lines = submissions.map((s, i) => {
            const filled = blackCard.pick > 1
                ? s.cards.map(c => `**${c.text}**`).join(' / ')
                : `**${s.cards[0].text}**`;
            return `**${i + 1}.** ${filled}`;
        });
        const embed = new EmbedBuilder()
            .setColor(0xFFD700)
            .setTitle('⚖️ Judging Time')
            .setDescription(`**Card Czar:** <@${czarUserId}>\n\n**${fmtBlack(blackCard.text)}**\n\n${lines.join('\n\n')}`)
            .setFooter({ text: `Czar, pick the winning submission` });
        const rows = [];
        let row = new ActionRowBuilder();
        submissions.forEach((s, i) => {
            row.addComponents(
                new ButtonBuilder().setCustomId(`cah_judge:${game.id}:${s.submissionId}`).setLabel(String(i + 1)).setStyle(ButtonStyle.Primary)
            );
            if ((i + 1) % 5 === 0) { rows.push(row); row = new ActionRowBuilder(); }
        });
        if (row.components.length > 0) rows.push(row);
        await editMain({ embeds: [embed], components: rows });
    });

    traced('roundWon', async ({ round, winnerUserId, winningCards, blackCard, scores }) => {
        // [cah-trace] Guard the exact shape that would throw here: winningCards
        // empty/undefined → winningCards[0].text → TypeError (swallowed as an
        // unhandledRejection before this wrapper existed). Log it explicitly.
        if (!Array.isArray(winningCards) || winningCards.length === 0) {
            logger.error(`[cah-trace ${game.id}] adapter:roundWon BAD winningCards=${JSON.stringify(winningCards)} round=${round} winner=${winnerUserId}`);
        }
        const filled = blackCard.pick > 1
            ? winningCards.map(c => `**${c.text}**`).join(' / ')
            : `**${winningCards[0].text}**`;
        const embed = new EmbedBuilder()
            .setColor(0x57F287)
            .setTitle(`🏆 Round ${round} — <@${winnerUserId}> wins`.replace(/<@[^>]+>/, ''))
            .setDescription(`**Winner:** <@${winnerUserId}>\n\n**${fmtBlack(blackCard.text)}**\n→ ${filled}`)
            .addFields({ name: 'Scores', value: scoreboardLines(scores) });
        const ch = await getChannel();
        if (ch) await ch.send({ embeds: [embed] });
    });

    game.on('gameEnded', async ({ reason, winnerUserIds, finalScores, cancelled }) => {
        const embed = cancelled
            ? new EmbedBuilder()
                .setColor(0x95A5A6)
                .setTitle('🛑 Lobby Cancelled')
                .setDescription(`The host cancelled this lobby before it started.\n**Reason:** \`${reason}\``)
            : new EmbedBuilder()
                .setColor(0x9B59B6)
                .setTitle('🎉 Game Over')
                .setDescription(`**Winner${winnerUserIds.length > 1 ? 's' : ''}:** ${winnerUserIds.map(id => `<@${id}>`).join(', ')}\n**Reason:** \`${reason}\``)
                .addFields({ name: 'Final Scores', value: scoreboardLines(finalScores) });
        const ch = await getChannel();
        if (ch) {
            // For cancelled lobbies, also strip the lobby buttons from the main
            // message so stragglers can't click Join on a dead game.
            if (cancelled && state.mainMessageId) {
                await editMain({ embeds: [embed], components: [] }).catch(() => {});
            } else {
                await ch.send({ embeds: [embed] });
            }
        }
        adapterState.delete(game.id);
    });

    game.on('playerTimeout', async ({ userId, phase }) => {
        const ch = await getChannel();
        if (ch) await ch.send({ content: `⏱️ <@${userId}> timed out (${phase}).`, allowedMentions: { users: [userId] } });
    });
}

export function getAdapterState(gameId) {
    return adapterState.get(gameId);
}

// ─── Interaction helpers used by the button/modal handlers ─────────────────────

export function buildHandSelectMenu(gameId, hand, pick) {
    // Discord StringSelectMenu preserves selection order in values[] — perfect for pick-N where order matters.
    const options = hand.slice(0, 25).map(c => ({
        label: (c.text || '[card]').slice(0, 100),
        value: String(c.id),
        emoji: c.isBlank ? '✍️' : undefined,
        description: c.isBlank ? 'Write your own answer' : undefined
    }));
    return new StringSelectMenuBuilder()
        .setCustomId(`cah_pick:${gameId}`)
        .setPlaceholder(`Pick ${pick} card${pick === 1 ? '' : 's'} (in order)`)
        .setMinValues(pick)
        .setMaxValues(pick)
        .addOptions(options);
}

export function buildHandEmbed(gameId, hand, blackCard, pick) {
    const handLines = hand.map((c, i) => `**${i + 1}.** ${c.isBlank ? '✍️ _[BLANK — write your own]_' : c.text}`);
    return new EmbedBuilder()
        .setColor(0xFFFFFF)
        .setTitle('🎴 Your Hand')
        .setDescription(`**Prompt:** ${fmtBlack(blackCard.text)}\n_Pick ${pick} card${pick === 1 ? '' : 's'}._\n\n${handLines.join('\n')}`)
        .setFooter({ text: `Game ${gameId.slice(0, 8)}` });
}
