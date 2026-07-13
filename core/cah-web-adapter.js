/**
 * Web adapter — bridges CAHGame events to Socket.io rooms.
 *
 * Rooms:
 *   `cah:game:<gameId>`   — public broadcast (round embed, scoreboard, judging)
 *   `cah:user:<userId>`   — per-player private (hand, "you submitted" ack)
 *
 * Hand contents are emitted only to the user's personal room, never to the
 * public game room. Same privacy model as Discord's ephemeral pattern.
 *
 * Auto-attaches to every game via managerEvents. Safe to call on boot once.
 */
import { managerEvents } from './cah-manager.js';
import logger from '../utils/logger.js';

let getIO = null;
const attached = new WeakSet();

export function initWebAdapter(getIOFn) {
    getIO = getIOFn;
    managerEvents.on('gameCreated', game => attachWebAdapter(game));
    logger.info('[cah-web] initialized — listening for new games');
}

export function attachWebAdapter(game) {
    if (attached.has(game)) return;
    attached.add(game);

    const broadcastPublic = (event, payload) => {
        const io = getIO?.();
        if (!io) return;
        io.to(`cah:game:${game.id}`).emit(event, payload);
    };
    const broadcastToUser = (userId, event, payload) => {
        const io = getIO?.();
        if (!io) return;
        io.to(`cah:user:${userId}`).emit(event, payload);
    };

    game.on('playerJoined', (p) => broadcastPublic('cah:playerJoined', { ...p, players: game._playerSummaries() }));
    game.on('playerLeft',   (p) => broadcastPublic('cah:playerLeft',   { ...p, players: game._playerSummaries() }));
    game.on('gameStarted',  (p) => broadcastPublic('cah:gameStarted',  p));
    game.on('roundStarted', (p) => broadcastPublic('cah:roundStarted', p));
    // Include current player roster on every submission so spectators see
    // ✅ checkmarks tick on in real time, not just a "N/M submitted" counter.
    game.on('cardsSubmitted', (p) => broadcastPublic('cah:cardsSubmitted', { ...p, players: game._playerSummaries() }));
    game.on('judgingStarted', (p) => broadcastPublic('cah:judgingStarted', p));
    game.on('roundWon',     (p) => broadcastPublic('cah:roundWon',     p));
    game.on('gameEnded',    (p) => broadcastPublic('cah:gameEnded',    p));
    game.on('stateChanged', (p) => broadcastPublic('cah:stateChanged', p));
    game.on('playerTimeout',(p) => broadcastPublic('cah:playerTimeout',p));
    game.on('hostTransferred', (p) => broadcastPublic('cah:hostTransferred', p));
    game.on('timeoutWarning',  (p) => broadcastPublic('cah:timeoutWarning', p));
    game.on('reactionUpdated', (p) => broadcastPublic('cah:reactionUpdated', p));
    game.on('playerBurned',    (p) => broadcastPublic('cah:playerBurned', p));

    // Private: hand goes only to the affected player's personal room
    game.on('handDealt', ({ userId, hand }) => broadcastToUser(userId, 'cah:hand', { gameId: game.id, hand }));
}
