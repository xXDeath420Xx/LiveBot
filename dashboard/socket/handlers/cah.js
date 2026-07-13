/**
 * Socket.io handler for CAH dashboard players.
 * Clients join the public game room + their personal user room, then receive
 * the same event stream the Discord adapter consumes. Client → server actions
 * call into core/cah-manager.js directly.
 */
import logger from '../../../utils/logger.js';
import { getGame, getGuildConfig, rehydrateOneGame } from '../../../core/cah-manager.js';

function webUserId(socket) {
    // Dashboard auth populates socket.user with the Discord OAuth user — same
    // id space as in-Discord players, so cross-platform play "just works"
    // without name mangling.
    return socket.user?.id || null;
}

export function cahHandler(io, socket) {
    const userId = webUserId(socket);
    if (userId) socket.join(`cah:user:${userId}`);

    socket.on('cah:joinGame', async ({ gameId }) => {
        if (!gameId) return;
        let game = getGame(gameId);
        if (!game) {
            try { game = await rehydrateOneGame(gameId); }
            catch (err) { logger.warn(`[cah-web] rehydrate ${gameId} failed: ${err.message}`); }
        }
        if (!game) return socket.emit('cah:error', { reason: 'no_such_game' });
        socket.join(`cah:game:${gameId}`);
        socket.emit('cah:state', game.serialize());
        // Late-joining clients (page reload, socket reconnect, post-restart
        // rehydrate) need their per-player state pushed too — otherwise the
        // game looks frozen because handDealt fired before they were listening.
        if (userId && game.players.has(userId)) {
            const player = game.players.get(userId);
            socket.emit('cah:hand', { gameId, hand: game._handPayload(player) });
            // If we're mid-judging, push the current submissions so the czar
            // sees them immediately instead of waiting for the next round.
            if (game.state === 'JUDGING' && game._judgingOrder?.length) {
                socket.emit('cah:judgingStarted', {
                    gameId,
                    czarUserId: game.czarUserId,
                    blackCard: { id: game.currentBlack.id, text: game.currentBlack.text, pick: game.currentBlack.pick },
                    submissions: game._judgingOrder.map(s => ({ submissionId: s.submissionId, cards: s.cards }))
                });
            } else if (game.state === 'SUBMITTING' && game.currentBlack) {
                // Make sure the round embed shows up
                socket.emit('cah:roundStarted', {
                    gameId,
                    round: game.round,
                    blackCard: { id: game.currentBlack.id, text: game.currentBlack.text, pick: game.currentBlack.pick },
                    czarUserId: game.czarUserId,
                    players: game._playerSummaries()
                });
            }
        }
    });

    socket.on('cah:leaveRoom', ({ gameId }) => {
        if (gameId) socket.leave(`cah:game:${gameId}`);
    });

    socket.on('cah:joinPlayer', ({ gameId, displayName, password }) => {
        if (!userId) return socket.emit('cah:error', { reason: 'auth_required' });
        const game = getGame(gameId);
        if (!game) return socket.emit('cah:error', { reason: 'no_such_game' });
        const name = (displayName || socket.user?.username || 'Player').slice(0, 64);
        const r = game.addPlayer({ userId, platform: 'web', displayName: name, password });
        if (!r.ok) return socket.emit('cah:error', { reason: r.reason, needsPassword: r.needsPassword });
        socket.emit('cah:joined', { gameId });
    });

    socket.on('cah:leavePlayer', ({ gameId }) => {
        if (!userId) return;
        const game = getGame(gameId);
        if (!game) return;
        game.removePlayer(userId);
    });

    socket.on('cah:start', async ({ gameId }) => {
        if (!userId) return socket.emit('cah:error', { reason: 'auth_required' });
        const game = getGame(gameId);
        if (!game) return socket.emit('cah:error', { reason: 'no_such_game' });
        if (game.hostUserId !== userId) return socket.emit('cah:error', { reason: 'not_host' });
        try {
            const r = await game.startGame();
            if (!r.ok) {
                // Propagate to client so user sees WHY start failed instead of "nothing happened"
                socket.emit('cah:error', { reason: r.reason, neededMore: r.neededMore, current: r.current, randos: r.randos });
            }
        } catch (err) {
            logger.error(`[cah-web] startGame threw: ${err.message}`);
            socket.emit('cah:error', { reason: 'start_threw', message: err.message });
        }
    });

    socket.on('cah:submit', ({ gameId, picks }) => {
        if (!userId) return;
        const game = getGame(gameId);
        if (!game) return;
        const r = game.submitCards(userId, picks);
        if (!r.ok) socket.emit('cah:error', { reason: r.reason });
        else socket.emit('cah:submitAck');
    });

    socket.on('cah:burn', ({ gameId }) => {
        if (!userId) return;
        const game = getGame(gameId);
        if (!game) return;
        const r = game.burnHand(userId);
        if (!r.ok) socket.emit('cah:error', { reason: r.reason });
    });

    socket.on('cah:react', ({ gameId, submissionId, emoji }) => {
        if (!userId) return;
        const game = getGame(gameId);
        if (!game) return;
        const r = game.addReaction(userId, submissionId, emoji);
        if (!r.ok) socket.emit('cah:error', { reason: r.reason });
    });

    socket.on('cah:judge', async ({ gameId, submissionId }) => {
        if (!userId) return;
        const game = getGame(gameId);
        if (!game) return;
        const r = await game.pickWinner(userId, submissionId);
        if (!r.ok) socket.emit('cah:error', { reason: r.reason });
    });

    // Host-only: end the game early
    socket.on('cah:hostEnd', ({ gameId }) => {
        if (!userId) return;
        const game = getGame(gameId);
        if (!game) return;
        if (game.hostUserId !== userId) return socket.emit('cah:error', { reason: 'not_host' });
        game.endGame('ended_by_host');
    });

    // Host-only: kick a player. Same path as removePlayer so all the host-
    // transfer / round-restart logic kicks in correctly.
    socket.on('cah:hostKick', ({ gameId, targetUserId }) => {
        if (!userId) return;
        const game = getGame(gameId);
        if (!game) return;
        if (game.hostUserId !== userId) return socket.emit('cah:error', { reason: 'not_host' });
        if (targetUserId === userId) return socket.emit('cah:error', { reason: 'cant_kick_self' });
        const r = game.removePlayer(targetUserId);
        if (!r.ok) socket.emit('cah:error', { reason: r.reason });
    });

    // In-game chat — ephemeral, broadcast to the room. No persistence; if a
    // spectator joins late they don't see history. Matches PYX's chat shape.
    socket.on('cah:chat:send', ({ gameId, text }) => {
        if (!userId) return;
        const game = getGame(gameId);
        if (!game) return;
        const clean = String(text || '').trim().slice(0, 500);
        if (!clean) return;
        const player = game.players.get(userId);
        const displayName = player?.displayName || socket.user?.username || 'Spectator';
        const isPlayer = !!player;
        io.to(`cah:game:${gameId}`).emit('cah:chat', {
            from: displayName,
            userId,
            isPlayer,
            text: clean,
            ts: Date.now()
        });
    });
}
