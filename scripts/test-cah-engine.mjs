#!/usr/bin/env node
/**
 * Engine smoke test — exercises the CAHGame state machine end-to-end without
 * touching the database. Stubs pool.execute on the shared db module so the
 * engine queries return controlled fixtures.
 *
 * Run: node scripts/test-cah-engine.mjs   (exits 1 on any assertion failure)
 */

const dbMod = await import('../utils/db.js');
const pool = dbMod.default;

// Stub pool.execute BEFORE importing the engine — first SELECT lands during loadDecks.
const fixtures = {
    whites: Array.from({ length: 200 }, (_, i) => ({ id: i + 1, text: `White card ${i + 1}` })),
    blacks: [
        { id: 1, text: 'Why am I sad? _____.',                   pick: 1, draw: 0 },
        { id: 2, text: 'Best thing ever: _____.',                pick: 1, draw: 0 },
        { id: 3, text: '_____ + _____ = disaster.',              pick: 2, draw: 0 },
        { id: 4, text: 'My weekend: _____, _____, and _____.',  pick: 3, draw: 2 },
        { id: 5, text: 'Top story: _____.',                       pick: 1, draw: 0 }
    ],
    nsfwResults: []
};

pool.execute = async (sql, params) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    // The new sampling-based loader does WHERE id IN (...) as a second query;
    // map those back to the fixture rows.
    if (/FROM cah_white_cards WHERE id IN/i.test(s)) {
        const ids = new Set(params || []);
        return [fixtures.whites.filter(c => ids.has(c.id)), []];
    }
    if (/FROM cah_black_cards WHERE id IN/i.test(s)) {
        const ids = new Set(params || []);
        return [fixtures.blacks.filter(c => ids.has(c.id)), []];
    }
    if (/FROM cah_white_cards WHERE deck_id IN/i.test(s)) return [fixtures.whites, []];
    if (/FROM cah_black_cards WHERE deck_id IN/i.test(s)) return [fixtures.blacks, []];
    if (/FROM cah_decks WHERE id IN.*nsfw = 1/i.test(s))  return [fixtures.nsfwResults, []];
    if (/FROM cah_guild_config WHERE guild_id/i.test(s))  return [[], []];
    if (/^INSERT|^UPDATE|^DELETE/i.test(s))                return [{ affectedRows: 1, insertId: 1 }, []];
    return [[], []];
};

const mgr = await import('../core/cah-manager.js');
const { STATES } = mgr;

let pass = 0, fail = 0;
const t = (name, cond, detail = '') => {
    if (cond) { console.log(`  ✓ ${name}`); pass++; }
    else      { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
};
const section = (title) => console.log(`\n=== ${title} ===`);

section('createGame + lobby');
const cr = await mgr.createGame({
    guildId: null, channelId: null, hostUserId: 'host',
    settings: { deckIds: [1], pointsToWin: 2, maxRounds: 8, randoCount: 1, timeoutEnabled: false }
});
t('createGame ok', cr.ok);
const game = cr.game;
t('starts in LOBBY', game.state === STATES.LOBBY);
['alice', 'bob', 'carol'].forEach(uid =>
    game.addPlayer({ userId: uid, platform: 'discord', displayName: uid })
);
t('3 players joined', game.players.size === 3);
t('duplicate join rejected', !game.addPlayer({ userId: 'alice', platform: 'discord', displayName: 'a' }).ok);

section('startGame → round 1');
const events = [];
['gameStarted', 'roundStarted', 'cardsSubmitted', 'judgingStarted', 'roundWon', 'gameEnded']
    .forEach(ev => game.on(ev, p => events.push({ ev, payload: p })));

const startR = await game.startGame();
t('startGame ok', startR.ok, startR.reason);
t('Rando auto-added', Array.from(game.players.values()).some(p => p.platform === 'rando'));
t('4 total players', game.players.size === 4);
t('state SUBMITTING after start', game.state === STATES.SUBMITTING, `state=${game.state}`);
t('czar assigned', !!game.czarUserId);
t('czar is not rando', !String(game.czarUserId).startsWith('rando:'));

await new Promise(r => setImmediate(r));  // flush microtasks for Rando auto-submit
const randoId = Array.from(game.players.keys()).find(k => k.startsWith('rando:'));
t('Rando submitted automatically', game.submissions.has(randoId));

section('play through to win');
let safety = 100;
while (game.state !== STATES.GAME_END && safety-- > 0) {
    if (game.state === STATES.SUBMITTING) {
        for (const p of game.players.values()) {
            if (p.userId === game.czarUserId || p.platform === 'rando') continue;
            if (game.submissions.has(p.userId)) continue;
            const pick = p.hand.slice(0, game.currentBlack.pick);
            const r = game.submitCards(p.userId, pick);
            if (!r.ok) console.log(`  ! submit ${p.userId}: ${r.reason}`);
        }
    }
    if (game.state === STATES.JUDGING) {
        const r = await game.pickWinner(game.czarUserId, game._judgingOrder[0].submissionId);
        if (!r.ok) { console.log(`  ! pickWinner: ${r.reason}`); break; }
    }
    await new Promise(r => setImmediate(r));
}
t('reached GAME_END', game.state === STATES.GAME_END, `state=${game.state} rounds=${game.round}`);

const ended = events.find(e => e.ev === 'gameEnded');
t('gameEnded fired', !!ended);
if (ended) {
    t('winner has highest score', (() => {
        const top = ended.payload.winnerUserIds[0];
        const topScore = ended.payload.finalScores.find(p => p.userId === top).points;
        return ended.payload.finalScores.every(p => p.points <= topScore);
    })());
    t('reason recorded', ['points_reached', 'round_limit'].includes(ended.payload.reason), ended.payload.reason);
}

section('NSFW filter');
fixtures.nsfwResults = [{ id: 99, name: 'Spicy Deck' }];
const nsfw = await mgr.createGame({
    guildId: null, channelId: null, hostUserId: 'host2',
    settings: { deckIds: [99], nsfw: false }
});
t('NSFW deck blocked without opt-in', !nsfw.ok && nsfw.reason === 'nsfw_deck_requires_opt_in');

section('blank card submission');
fixtures.nsfwResults = [];
// Crank up blanks to 30 so at least one is guaranteed in every hand
const blankCr = await mgr.createGame({
    guildId: null, channelId: null, hostUserId: 'bhost',
    settings: { deckIds: [1], pointsToWin: 1, maxRounds: 3, blankCardCount: 30, timeoutEnabled: false }
});
const bg = blankCr.game;
['p1','p2','p3'].forEach(uid => bg.addPlayer({ userId: uid, platform: 'discord', displayName: uid }));
await bg.startGame();
// Find any non-czar non-rando player with a blank in hand (probabilistic deal)
const playerWithBlank = Array.from(bg.players.values())
    .find(p => p.userId !== bg.czarUserId && p.platform !== 'rando' && p.hand.some(id => id < 0));
t('blank dealt to at least one player', !!playerWithBlank);
if (playerWithBlank) {
    const blankInHand = playerWithBlank.hand.find(id => id < 0);
    const others = playerWithBlank.hand.filter(id => id !== blankInHand && id >= 0);
    const picks = [{ id: blankInHand, text: 'my custom answer' }, ...others.slice(0, bg.currentBlack.pick - 1).map(id => ({ id }))]
        .slice(0, bg.currentBlack.pick);
    const r = bg.submitCards(playerWithBlank.userId, picks);
    t('blank-card submit accepted', r.ok, r.reason);
}
t('blank without text rejected', !bg.submitCards('p1', [{ id: -999 }]).ok);

console.log(`\n${pass}/${pass + fail} passed${fail > 0 ? ' — FAILURES PRESENT' : ' ✓'}`);
process.exit(fail > 0 ? 1 : 0);
