/**
 * Cards Against Humanity game engine.
 *
 * One CAHGame instance per active game. Pure state machine + event emitter —
 * knows nothing about Discord or Socket.io. Adapters in commands/fun/cah.js
 * and dashboard/socket/handlers/cah.js subscribe to events and translate
 * them into Discord embeds / WebSocket frames.
 *
 * State machine:
 *   LOBBY -> DEALING -> SUBMITTING -> JUDGING -> SCORING -> (DEALING | GAME_END)
 *
 * Events emitted (all carry { gameId } plus event-specific fields):
 *   playerJoined, playerLeft, gameStarted, roundStarted, handDealt (per-player),
 *   cardsSubmitted, allSubmissionsIn, judgingStarted, roundWon, gameEnded,
 *   playerTimeout, stateChanged
 */

import { EventEmitter } from 'events';
import { randomUUID, createHash } from 'crypto';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

function hashPassword(plain, gameId) {
    // SHA-256(plain + ':' + gameId). The gameId is a UUID — unique per game —
    // so a stolen DB still requires per-game brute force. Game-lobby passwords
    // are low-value, so we skip bcrypt's compute cost.
    if (!plain) return null;
    return createHash('sha256').update(plain + ':' + gameId).digest('hex');
}

const HAND_SIZE = 10;
const BLANK_CARD_PREFIX = -1;       // Blank card ids are negative (-1, -2, ...) to distinguish from DB ids
const DEFAULT_SETTINGS = Object.freeze({
    pointsToWin: 7,
    maxRounds: 20,
    czarRotation: 'rotate',         // 'rotate' | 'random' | 'previous_winner'
    timeoutEnabled: true,
    timeoutSeconds: 90,
    timeoutPolicy: 'skip',          // 'skip' | 'auto_random' | 'strike_kick'
    handSize: HAND_SIZE,
    deckIds: [],
    visibility: 'guild_only',       // 'private' | 'guild_only' | 'public'
    blankCardCount: 0,              // N blank white cards mixed into the deck; player fills in text on play
    nsfw: false,                    // Host opt-in. Guild config must also permit nsfw_allowed.
    randoCount: 0,                  // 0-3 "Rando Cardrissian" AI players — auto-play random card each round
    joinPassword: null,             // string|null — players must supply matching password to addPlayer
    aceRuleEnabled: true            // Players can "burn hand" for -1 pt to get a fresh 10 cards
});

const STATES = Object.freeze({
    LOBBY: 'LOBBY',
    DEALING: 'DEALING',
    SUBMITTING: 'SUBMITTING',
    JUDGING: 'JUDGING',
    SCORING: 'SCORING',
    ROUND_END: 'ROUND_END',
    GAME_END: 'GAME_END',
    ABANDONED: 'ABANDONED'
});

const activeGames = new Map();           // gameId -> CAHGame
const channelGameIndex = new Map();      // channelId -> gameId (at most one live game per channel)

// Manager-level events let adapters auto-attach to games as they're created
// without cah-manager needing to import them (avoids a circular dep with the
// dashboard, which may or may not be running).
export const managerEvents = new EventEmitter();
managerEvents.setMaxListeners(50);

function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/**
 * Sample cards from the selected decks instead of loading the entire deck pool.
 * A typical game uses ~150-700 cards; loading the full 600k+ Mega Pack into
 * memory OOMs the process. With sampling, the per-game memory cost stays
 * proportional to game size, not deck size.
 *
 * If `sampleHint` is null, returns ALL cards (small decks / smoke tests).
 * Otherwise: { whiteNeeded, blackNeeded } chooses random subsets.
 *
 * ORDER BY RAND() LIMIT N on a 600k table takes ~1-3 seconds (full scan + sort).
 * Acceptable cost for the one-time game-start step.
 */
/**
 * Two-phase load: first fetch ID lists (cheap — even 600k INTs is ~5MB), then
 * shuffle in memory and SELECT texts for just the chosen subset. Much faster
 * than `ORDER BY RAND()` which forces a full scan + sort on the large table.
 *
 * Benchmarks on the Mega Pack (603k white):
 *   - SELECT id ... → ~200ms
 *   - in-memory Fisher-Yates shuffle → ~50ms
 *   - SELECT id, text WHERE id IN (1500 ids) → ~30ms
 *   Total: ~280ms instead of ~3s with ORDER BY RAND.
 */
async function loadDeckCards(deckIds, sampleHint = null) {
    if (!deckIds.length) return { white: [], black: [] };
    const placeholders = deckIds.map(() => '?').join(',');

    if (!sampleHint) {
        const [whiteRows] = await pool.execute(
            `SELECT id, text FROM cah_white_cards WHERE deck_id IN (${placeholders})`,
            deckIds
        );
        const [blackRows] = await pool.execute(
            `SELECT id, text, pick, draw FROM cah_black_cards WHERE deck_id IN (${placeholders})`,
            deckIds
        );
        return { white: whiteRows, black: blackRows };
    }

    const { whiteNeeded, blackNeeded } = sampleHint;

    // Phase 1: pull just the IDs (lean column, fast even on 600k rows)
    const [whiteIdRows] = await pool.execute(
        `SELECT id FROM cah_white_cards WHERE deck_id IN (${placeholders})`,
        deckIds
    );
    const [blackIdRows] = await pool.execute(
        `SELECT id FROM cah_black_cards WHERE deck_id IN (${placeholders})`,
        deckIds
    );

    // Phase 2: shuffle, take first N, fetch their full rows
    const whiteIds = whiteIdRows.map(r => r.id);
    const blackIds = blackIdRows.map(r => r.id);
    const pickWhite = shuffle(whiteIds).slice(0, Math.min(whiteNeeded, whiteIds.length));
    const pickBlack = shuffle(blackIds).slice(0, Math.min(blackNeeded, blackIds.length));

    const fetchByIds = async (table, cols, ids) => {
        if (!ids.length) return [];
        // Batch in chunks to keep query size sane (MySQL packet limits at very large IN lists)
        const CHUNK = 2000;
        const out = [];
        for (let i = 0; i < ids.length; i += CHUNK) {
            const slice = ids.slice(i, i + CHUNK);
            const ph = slice.map(() => '?').join(',');
            const [rows] = await pool.execute(
                `SELECT ${cols} FROM ${table} WHERE id IN (${ph})`,
                slice
            );
            out.push(...rows);
        }
        return out;
    };

    const [whiteRows, blackRows] = await Promise.all([
        fetchByIds('cah_white_cards', 'id, text', pickWhite),
        fetchByIds('cah_black_cards', 'id, text, pick, draw', pickBlack)
    ]);
    return { white: whiteRows, black: blackRows };
}

class CAHGame extends EventEmitter {
    constructor({ id, guildId, channelId, hostUserId, settings }) {
        super();
        this.id = id;
        this.guildId = guildId || null;
        this.channelId = channelId || null;
        this.hostUserId = hostUserId;
        this.settings = { ...DEFAULT_SETTINGS, ...settings };
        // Hash the plaintext password ONCE on construction, then drop it from
        // settings. settings_json persists '***' as a sentinel (see createGame),
        // so on rehydrate the constructor sees that sentinel — recognise it and
        // leave passwordHash null here; _hydrateGameRow restores the real hash
        // from the password_hash column afterwards.
        const pw = this.settings.joinPassword;
        this.passwordHash = (pw && pw !== '***') ? hashPassword(pw, this.id) : null;
        this.settings.joinPassword = null;
        this.state = STATES.LOBBY;
        this.round = 0;
        this.czarUserId = null;
        this.czarRotationIndex = -1;
        this.lastRoundWinnerId = null;
        this.players = new Map();        // userId -> { platform, displayName, points, hand: [cardId], strikes, isCzar }
        this.whiteDraw = [];
        this.whiteDiscard = [];
        this.blackDraw = [];
        this.blackDiscard = [];
        this.whiteCards = new Map();     // cardId -> { id, text }
        this.blackCards = new Map();     // cardId -> { id, text, pick, draw }
        this.currentBlack = null;
        this.submissions = new Map();    // userId -> [cardId, ...]
        this.timeoutHandle = null;
    }

    async loadDecks() {
        // Calculate how many cards we actually need for this game's lifetime.
        // Formula: enough white cards to fill every player's hand + draw N
        // replacements per round across the max rounds + a healthy buffer for
        // pick-2/3 black cards and reshuffles. Black cards: max rounds + small
        // buffer. Bounded sample = bounded memory regardless of deck size.
        const playerCount = Math.max(this.players.size, 3);
        const handSize = this.settings.handSize || HAND_SIZE;
        const maxRounds = this.settings.maxRounds || 25;
        // 3x buffer accounts for pick-2/3 draws, dedup losses, and slack
        const whiteNeeded = (playerCount * handSize) + (maxRounds * playerCount * 3);
        const blackNeeded = maxRounds + 10;
        // Always sample. For decks smaller than the sample size the shuffle just
        // returns everything (no harm done). For huge decks like the Mega Pack
        // (600k+) we save ~99% of the memory + persistence cost.
        const { white, black } = await loadDeckCards(this.settings.deckIds, { whiteNeeded, blackNeeded });
        // Belt-and-suspenders text-level language filter — beefed up after
        // foreign cards kept slipping through. Three layers of rejection:
        //   1. Non-Latin characters (Cyrillic, Greek, Arabic, CJK, etc.)
        //   2. Latin accented characters that strongly suggest a non-EN language
        //      (more than 2 of them in a card)
        //   3. Non-EN stopwords with no English signal
        const NON_LATIN = /[Ѐ-ӿͰ-Ͽ؀-ۿ一-鿿぀-ヿ가-힯]/;
        const ACCENTED = /[àáâãäåèéêëìíîïòóôõöùúûüñçßẞœæğşıİťłżźńĳ]/gi;
        const NON_EN = /\b(che|della|degli|gli|nella|sulla|però|sono|questo|questa|questi|queste|niente|wszystko|już|jeszcze|kiedy|sind|nicht|alles|nichts|que|esta|estos|estas|todo|nada|siempre|une|deux|trois|quelque|quoi|comme|dans|avec|pour|sur|onko|kun|jossa|ihminen|menino|menina|gente|coisa|fazer|tudo|nada|nunca|sempre|porque|kein|keine|aber|noch|schon|sehr|nur|viel|gut|gjør|skal|fortelle|hvor|hvordan|hvorfor|når|hvem|hva|tylko|jeszcze|tak|nie|jest|być|kiedy|jak|dlaczego|gdzie|kto|co|maar|niet|wel|wat|wie|hoe|waarom|wanneer|waar|och|inte|var|hur|när|varför|vem|vad|és|nem|igen|hogy|mikor|hol|miért|hogyan|aki|ami|amely|olyan|csak|sehol|sosem)\b/i;
        const EN_HINT = /\b(the|and|of|to|in|that|is|was|with|for|on|you|are|this|have|but|not|or|by|from|as|at|be|been|has|had|will|would|do|did|so|if|out|up|all|any|just|like|what|who|how|why|when|where)\b/i;
        function looksNonEnglish(text) {
            const t = String(text || '');
            if (!t.trim()) return true;
            if (NON_LATIN.test(t)) return true;                           // any Cyrillic/CJK/etc → reject
            const accents = (t.match(ACCENTED) || []).length;
            if (accents > 2) return true;                                 // lots of accents → likely non-EN
            if (NON_EN.test(t) && !EN_HINT.test(t)) return true;          // non-EN word with no EN signal
            return false;
        }
        const whiteFiltered = white.filter(c => !looksNonEnglish(c.text));
        const blackFiltered = black.filter(c => !looksNonEnglish(c.text));
        // Deduplicate by normalized text — when multiple decks are selected the
        // same card (e.g. "Justin Bieber") often appears in dozens of packs.
        // Without this, that card would draw N times more often than a unique
        // one. We keep the first occurrence's id so we still have valid FKs.
        const seenWhite = new Map();
        for (const c of whiteFiltered) {
            const key = (c.text || '').trim().toLowerCase();
            if (!key) continue;
            if (!seenWhite.has(key)) seenWhite.set(key, c);
        }
        const seenBlack = new Map();
        for (const c of blackFiltered) {
            // Black-card identity = text + pick — a "_____ ?" with pick=1 is a
            // different play than the same text re-mastered as pick=2.
            const key = `${(c.text || '').trim().toLowerCase()}|p${c.pick}`;
            if (!key) continue;
            if (!seenBlack.has(key)) seenBlack.set(key, c);
        }
        const whiteUnique = Array.from(seenWhite.values());
        const blackUnique = Array.from(seenBlack.values());
        for (const c of whiteUnique) this.whiteCards.set(c.id, c);
        for (const c of blackUnique) this.blackCards.set(c.id, c);
        const whiteIds = whiteUnique.map(c => c.id);
        // Inject blank cards as negative-id sentinels mixed into the draw pile
        for (let i = 0; i < this.settings.blankCardCount; i++) {
            const blankId = BLANK_CARD_PREFIX - i;
            this.whiteCards.set(blankId, { id: blankId, text: '[BLANK]', isBlank: true });
            whiteIds.push(blankId);
        }
        this.whiteDraw = shuffle(whiteIds);
        this.blackDraw = shuffle(blackUnique.map(c => c.id));
        const dupesWhite = white.length - whiteUnique.length;
        const dupesBlack = black.length - blackUnique.length;
        logger.info(`[cah ${this.id}] loaded ${whiteUnique.length} white + ${blackUnique.length} black unique cards from ${this.settings.deckIds.length} decks (deduped ${dupesWhite}+${dupesBlack}, + ${this.settings.blankCardCount} blanks)`);
    }

    addPlayer({ userId, platform, displayName, password = null }) {
        if (this.players.has(userId)) return { ok: false, reason: 'already_joined' };
        if (this.state !== STATES.LOBBY) return { ok: false, reason: 'game_in_progress' };
        // Password gate — host bypasses (they set it). Anyone else must supply
        // the right one. Compare against the stored hash so rehydrated games
        // (memory wiped, only password_hash recoverable) still validate joins.
        if (this.passwordHash && userId !== this.hostUserId) {
            const supplied = hashPassword(password || '', this.id);
            if (supplied !== this.passwordHash) return { ok: false, reason: 'wrong_password', needsPassword: true };
        }
        this.players.set(userId, {
            userId, platform, displayName,
            points: 0, hand: [], strikes: 0, isCzar: false,
            joinedAt: Date.now()
        });
        this._emit('playerJoined', { userId, platform, displayName });
        // Persist roster changes — otherwise a PM2 restart wipes the host out
        // of their own lobby because state_json only gets written on STATE
        // transitions (LOBBY→DEALING etc.), and addPlayer is a same-state op.
        this._persist().catch(err => logger.error(`[cah ${this.id}] addPlayer persist failed: ${err.message}`));
        return { ok: true };
    }

    removePlayer(userId) {
        const p = this.players.get(userId);
        if (!p) return { ok: false, reason: 'not_in_game' };
        // Return their hand to discard pile
        this.whiteDiscard.push(...p.hand);
        const wasHost = userId === this.hostUserId;
        this.players.delete(userId);
        this._emit('playerLeft', { userId });
        // Host transfer: if the leaving player was the host AND there are still
        // human players, promote the next longest-tenured non-rando. Randos
        // can't be host. The dashboard "Start" button is gated on hostUserId so
        // we don't want a dead handle.
        if (wasHost) {
            const humans = Array.from(this.players.values())
                .filter(p => p.platform !== 'rando')
                .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
            if (humans.length > 0) {
                this.hostUserId = humans[0].userId;
                this._emit('hostTransferred', { newHostUserId: this.hostUserId, oldHostUserId: userId });
            }
        }
        const humanCount = Array.from(this.players.values()).filter(p => p.platform !== 'rando').length;
        if (humanCount < 3 && this.state !== STATES.LOBBY && this.state !== STATES.GAME_END) {
            return this.endGame('insufficient_players');
        }
        if (userId === this.czarUserId && this.state === STATES.SUBMITTING) {
            // Czar bailed mid-round — abandon round, start next
            return this._startRound();
        }
        // Same persistence reason as addPlayer — keep state_json in sync with roster
        this._persist().catch(err => logger.error(`[cah ${this.id}] removePlayer persist failed: ${err.message}`));
        return { ok: true };
    }

    async startGame() {
        if (this.state !== STATES.LOBBY) return { ok: false, reason: 'not_in_lobby' };
        const humanCount = Array.from(this.players.values()).filter(p => p.platform !== 'rando').length;
        const randos = Math.min(3, this.settings.randoCount || 0);
        const total = humanCount + randos;
        // Need at least the host (1 human) AND total seats (humans + randos) >= 3.
        // Solo-with-randos is a valid play pattern; rando-only is not.
        if (humanCount < 1) return { ok: false, reason: 'need_host' };
        if (total < 3) return { ok: false, reason: 'need_3_players', current: humanCount, randos, neededMore: 3 - total };
        try { await this.loadDecks(); }
        catch (err) { return { ok: false, reason: 'load_failed', message: err.message }; }
        // Add Rando Cardrissian(s) — AI players that auto-play random cards.
        for (let i = 1; i <= Math.min(3, this.settings.randoCount || 0); i++) {
            const userId = `rando:${i}`;
            this.players.set(userId, {
                userId, platform: 'rando',
                displayName: `Rando Cardrissian${this.settings.randoCount > 1 ? ' #' + i : ''}`,
                points: 0, hand: [], strikes: 0, isCzar: false
            });
        }
        const totalPlayers = this.players.size;
        if (this.blackDraw.length === 0 || this.whiteDraw.length < totalPlayers * this.settings.handSize) {
            return { ok: false, reason: 'insufficient_cards' };
        }
        this._dealInitialHands();
        this._setState(STATES.DEALING);
        this._emit('gameStarted', { players: this._playerSummaries() });
        return this._startRound();
    }

    _dealInitialHands() {
        for (const p of this.players.values()) {
            while (p.hand.length < this.settings.handSize && this.whiteDraw.length > 0) {
                p.hand.push(this._drawWhite());
            }
            this._emit('handDealt', { userId: p.userId, hand: this._handPayload(p) });
        }
    }

    _drawWhite() {
        if (this.whiteDraw.length === 0) {
            if (this.whiteDiscard.length === 0) return null;
            this.whiteDraw = shuffle(this.whiteDiscard);
            this.whiteDiscard = [];
        }
        return this.whiteDraw.pop();
    }

    _drawBlack() {
        if (this.blackDraw.length === 0) {
            if (this.blackDiscard.length === 0) return null;
            this.blackDraw = shuffle(this.blackDiscard);
            this.blackDiscard = [];
        }
        return this.blackDraw.pop();
    }

    async _startRound() {
        this.round += 1;
        this.submissions.clear();
        const blackId = this._drawBlack();
        if (!blackId) return this.endGame('out_of_black_cards');
        this.currentBlack = this.blackCards.get(blackId);
        if (this.currentBlack.draw > 0) {
            for (const p of this.players.values()) {
                for (let i = 0; i < this.currentBlack.draw; i++) {
                    const id = this._drawWhite();
                    if (id != null) p.hand.push(id);
                }
            }
        }
        this.czarUserId = selectNextCzar(this);
        for (const p of this.players.values()) p.isCzar = (p.userId === this.czarUserId);
        this._setState(STATES.SUBMITTING);
        this._emit('roundStarted', {
            round: this.round,
            blackCard: { id: this.currentBlack.id, text: this.currentBlack.text, pick: this.currentBlack.pick },
            czarUserId: this.czarUserId,
            players: this._playerSummaries(),
            timeoutSeconds: this.settings.timeoutEnabled ? this.settings.timeoutSeconds : 0
        });
        // Push fresh hand payloads (some players gained draw cards)
        for (const p of this.players.values()) {
            if (p.userId === this.czarUserId) continue;
            this._emit('handDealt', { userId: p.userId, hand: this._handPayload(p) });
        }
        this._armTimeout();
        await this._persist();
        // Rando(s) submit immediately after round starts. Run on microtask so
        // the roundStarted listeners fire first (adapters draw the embed
        // before the "Rando submitted" updates trickle in).
        queueMicrotask(() => this._autoSubmitRandos());
        return { ok: true };
    }

    _autoSubmitRandos() {
        if (this.state !== STATES.SUBMITTING) return;
        for (const p of this.players.values()) {
            if (p.platform !== 'rando' || p.userId === this.czarUserId) continue;
            if (this.submissions.has(p.userId)) continue;
            const nonBlank = p.hand.filter(id => id >= 0);
            if (nonBlank.length < this.currentBlack.pick) continue;
            const picks = shuffle(nonBlank).slice(0, this.currentBlack.pick);
            this.submitCards(p.userId, picks);
        }
    }

    /**
     * Submit cards for the current round.
     * @param {string} userId
     * @param {Array<number|{id:number, text?:string}>} picks - ordered picks.
     *        For blank cards (id < 0), provide {id, text} with the player's custom answer.
     */
    submitCards(userId, picks) {
        if (this.state !== STATES.SUBMITTING) return { ok: false, reason: 'not_submitting' };
        if (userId === this.czarUserId) return { ok: false, reason: 'czar_cannot_submit' };
        const p = this.players.get(userId);
        if (!p) return { ok: false, reason: 'not_in_game' };
        if (this.submissions.has(userId)) return { ok: false, reason: 'already_submitted' };
        if (!Array.isArray(picks) || picks.length !== this.currentBlack.pick) {
            return { ok: false, reason: 'wrong_pick_count' };
        }
        // Normalize: every pick becomes { id, text? }
        const normalized = picks.map(pk => typeof pk === 'number' ? { id: pk } : { id: pk.id, text: pk.text });
        const ids = normalized.map(p => p.id);
        if (new Set(ids).size !== ids.length) return { ok: false, reason: 'duplicate_cards' };
        for (const pick of normalized) {
            if (!p.hand.includes(pick.id)) return { ok: false, reason: 'card_not_in_hand' };
            if (pick.id < 0) {
                if (typeof pick.text !== 'string' || !pick.text.trim()) return { ok: false, reason: 'blank_needs_text' };
                if (pick.text.length > 200) return { ok: false, reason: 'blank_too_long' };
            } else if (pick.text !== undefined) {
                return { ok: false, reason: 'custom_text_only_on_blanks' };
            }
        }
        this.submissions.set(userId, normalized);
        const idSet = new Set(ids);
        p.hand = p.hand.filter(c => !idSet.has(c));
        this._emit('cardsSubmitted', { userId, submittedCount: this.submissions.size, expectedCount: this._expectedSubmitters() });
        // Persist after each submission so a PM2 restart mid-round doesn't lose
        // the player's hand-after-submit + the partial submission set. _setState
        // only runs on phase transitions, which is too coarse for resilience.
        this._persist().catch(err => logger.error(`[cah ${this.id}] submitCards persist failed: ${err.message}`));
        if (this.submissions.size >= this._expectedSubmitters()) {
            this._beginJudging();
        }
        return { ok: true };
    }

    _expectedSubmitters() {
        let n = 0;
        for (const p of this.players.values()) {
            if (p.userId !== this.czarUserId && p.strikes < 3) n++;
        }
        return n;
    }

    _beginJudging() {
        this._clearTimeout();
        // Defensive: a rehydrated game can land here with currentBlack unset if
        // the persisted black-card row was deleted from the DB. Rather than
        // crash and abandon the game, fall back to the most recent
        // black-discard entry, then to a placeholder. The round will still
        // resolve and the next _startRound draws a fresh prompt.
        if (!this.currentBlack) {
            const fallbackId = this.blackDiscard.at(-1);
            const fallback = fallbackId != null ? this.blackCards.get(fallbackId) : null;
            this.currentBlack = fallback || { id: -1, text: '[prompt missing — round will resolve]', pick: 1, draw: 0 };
            logger.warn(`[cah ${this.id}] _beginJudging fell back: currentBlack was null, using ${fallback ? 'last discard' : 'placeholder'}`);
        }
        this._setState(STATES.JUDGING);
        const entries = Array.from(this.submissions.entries()).map(([userId, picks]) => ({
            userId,
            cards: picks.map(pk => ({
                id: pk.id,
                text: pk.id < 0 ? pk.text : (this.whiteCards.get(pk.id)?.text || '[missing card]')
            }))
        }));
        const shuffled = shuffle(entries).map((e, i) => ({ submissionId: i, userId: e.userId, cards: e.cards }));
        this._judgingOrder = shuffled;
        this._emit('judgingStarted', {
            czarUserId: this.czarUserId,
            blackCard: { id: this.currentBlack.id, text: this.currentBlack.text, pick: this.currentBlack.pick },
            submissions: shuffled.map(s => ({ submissionId: s.submissionId, cards: s.cards })),
            timeoutSeconds: this.settings.timeoutEnabled ? this.settings.timeoutSeconds : 0
        });
        this._armTimeout();
        // If the czar is a Rando, auto-pick a winner after a short delay so
        // humans can actually SEE the submissions before the round resolves.
        const czarPlayer = this.players.get(this.czarUserId);
        if (czarPlayer?.platform === 'rando' && shuffled.length > 0) {
            const pick = shuffled[Math.floor(Math.random() * shuffled.length)];
            setTimeout(() => {
                if (this.state === STATES.JUDGING) {
                    this.pickWinner(this.czarUserId, pick.submissionId).catch(err =>
                        logger.error(`[cah ${this.id}] rando czar pick failed: ${err.message}`)
                    );
                }
            }, 3500);
        }
    }

    async pickWinner(czarUserId, submissionId) {
        // ── [cah-trace] Investigative logging for the round-resolution boundary.
        // The czar's "pick winner" click lands here, then synchronously emits
        // roundWon + roundStarted to the (unawaited, async) adapter listeners.
        // We log every decision point so a stalled/looping round shows EXACTLY
        // how far the engine got before the render boundary swallowed an error.
        logger.info(`[cah-trace ${this.id}] pickWinner ENTER round=${this.round} state=${this.state} czarArg=${czarUserId} czarActual=${this.czarUserId} submissionId=${submissionId} judgingOrder=${Array.isArray(this._judgingOrder) ? this._judgingOrder.length : `MISSING(${typeof this._judgingOrder})`} submissions=${this.submissions.size} players=${this.players.size}`);
        if (this.state !== STATES.JUDGING) { logger.warn(`[cah-trace ${this.id}] pickWinner REJECT not_judging (state=${this.state})`); return { ok: false, reason: 'not_judging' }; }
        if (czarUserId !== this.czarUserId) { logger.warn(`[cah-trace ${this.id}] pickWinner REJECT not_czar (arg=${czarUserId} actual=${this.czarUserId})`); return { ok: false, reason: 'not_czar' }; }
        if (!Array.isArray(this._judgingOrder)) {
            // Defensive trace: a rehydrated game that skipped _beginJudging would
            // land here with _judgingOrder undefined → .find() would throw an
            // uncaught TypeError. Surface it loudly instead.
            logger.error(`[cah-trace ${this.id}] pickWinner FATAL _judgingOrder is ${typeof this._judgingOrder} (not an array) — round cannot resolve. round=${this.round}`);
            return { ok: false, reason: 'judging_order_missing' };
        }
        const entry = this._judgingOrder.find(s => s.submissionId === submissionId);
        if (!entry) { logger.warn(`[cah-trace ${this.id}] pickWinner REJECT bad_submission id=${submissionId} available=[${this._judgingOrder.map(s => s.submissionId).join(',')}]`); return { ok: false, reason: 'bad_submission' }; }
        const winner = this.players.get(entry.userId);
        if (!winner) { logger.warn(`[cah-trace ${this.id}] pickWinner REJECT winner_left userId=${entry.userId}`); return { ok: false, reason: 'winner_left' }; }
        logger.info(`[cah-trace ${this.id}] pickWinner WINNER userId=${winner.userId} cards=${JSON.stringify(entry.cards?.map(c => ({ id: c.id, text: (c.text ?? '').slice(0, 30) })))} pointsBefore=${winner.points}`);
        winner.points += 1;
        this.lastRoundWinnerId = winner.userId;
        // Discard submitted cards
        for (const s of this._judgingOrder) this.whiteDiscard.push(...s.cards.map(c => c.id));
        this.blackDiscard.push(this.currentBlack.id);
        this._clearTimeout();
        this._setState(STATES.SCORING);
        logger.info(`[cah-trace ${this.id}] pickWinner EMIT roundWon (state now ${this.state}); currentBlack=${this.currentBlack ? `id=${this.currentBlack.id} pick=${this.currentBlack.pick}` : 'NULL'} winningCards.len=${entry.cards?.length}`);
        this._emit('roundWon', {
            round: this.round,
            winnerUserId: winner.userId,
            winningCards: entry.cards,
            blackCard: { text: this.currentBlack.text, pick: this.currentBlack.pick },
            scores: this._playerSummaries()
        });
        // Reactions are per-round only — clear on round-end so next round starts fresh.
        this._reactions = new Map();
        // Burn-hand is once-per-round per player; clear flags
        for (const pl of this.players.values()) pl._burnedThisRound = false;
        // Refill hands
        for (const p of this.players.values()) {
            while (p.hand.length < this.settings.handSize) {
                const id = this._drawWhite();
                if (id == null) break;
                p.hand.push(id);
            }
            if (p.userId !== this.czarUserId) {
                this._emit('handDealt', { userId: p.userId, hand: this._handPayload(p) });
            }
        }
        const result = checkWinCondition(this);
        logger.info(`[cah-trace ${this.id}] pickWinner winCheck gameOver=${result.gameOver}${result.gameOver ? ` reason=${result.reason}` : ''} round=${this.round}/${this.settings.maxRounds} pointsToWin=${this.settings.pointsToWin}`);
        if (result.gameOver) return this.endGame(result.reason, result.winnerUserIds);
        const sr = await this._startRound();
        logger.info(`[cah-trace ${this.id}] pickWinner -> _startRound returned ${JSON.stringify(sr)}; now round=${this.round} state=${this.state} czar=${this.czarUserId} black=${this.currentBlack ? this.currentBlack.id : 'NULL'}`);
        return sr;
    }

    _armTimeout() {
        this._clearTimeout();
        if (!this.settings.timeoutEnabled) return;
        const ms = this.settings.timeoutSeconds * 1000;
        // Schedule a soft warning 10s before the hard kick. This lets the UI
        // show a "hurry up!" banner without changing the kick deadline.
        if (ms > 12_000) {
            this._warnHandle = setTimeout(() => {
                this._emit('timeoutWarning', { secondsLeft: 10, phase: this.state });
            }, ms - 10_000);
        }
        this.timeoutHandle = setTimeout(() => this._handleTimeout(), ms);
    }

    _clearTimeout() {
        if (this.timeoutHandle) { clearTimeout(this.timeoutHandle); this.timeoutHandle = null; }
        if (this._warnHandle)   { clearTimeout(this._warnHandle);   this._warnHandle = null; }
    }

    _handleTimeout() {
        if (this.state === STATES.SUBMITTING) {
            for (const p of this.players.values()) {
                if (p.userId === this.czarUserId) continue;
                if (this.submissions.has(p.userId)) continue;
                p.strikes += 1;
                this._emit('playerTimeout', { userId: p.userId, phase: 'submitting', strikes: p.strikes });
                if (this.settings.timeoutPolicy === 'auto_random' && p.hand.length >= this.currentBlack.pick) {
                    // Skip blanks on auto-random — engine can't invent the player's answer for them
                    const nonBlank = p.hand.filter(id => id >= 0);
                    if (nonBlank.length >= this.currentBlack.pick) {
                        const picks = shuffle(nonBlank).slice(0, this.currentBlack.pick);
                        this.submitCards(p.userId, picks);
                    }
                } else if (this.settings.timeoutPolicy === 'strike_kick' && p.strikes >= 3) {
                    this.removePlayer(p.userId);
                }
            }
            if (this.submissions.size >= this._expectedSubmitters() && this.state === STATES.SUBMITTING) {
                this._beginJudging();
            } else if (this.submissions.size > 0) {
                this._beginJudging();
            } else {
                // No one submitted — abandon round
                this._startRound();
            }
        } else if (this.state === STATES.JUDGING) {
            // Czar timeout — pick random submission
            if (this._judgingOrder.length > 0) {
                const random = this._judgingOrder[Math.floor(Math.random() * this._judgingOrder.length)];
                this._emit('playerTimeout', { userId: this.czarUserId, phase: 'judging' });
                // Fire-and-forget — engine logic already handled, async work is just persistence + next round
                this.pickWinner(this.czarUserId, random.submissionId).catch(err =>
                    logger.error(`[cah ${this.id}] timeout pickWinner failed: ${err.message}`)
                );
            }
        }
    }

    endGame(reason, winnerUserIds = null) {
        this._clearTimeout();
        // Cancelling an unstarted lobby is conceptually different from a
        // finished game — there are no winners, just an aborted setup. Mark it
        // ABANDONED so the leaderboard ignores it and adapters can render a
        // "lobby cancelled" message instead of a fake "Game Over".
        const cancelled = this.state === STATES.LOBBY;
        if (cancelled) {
            winnerUserIds = [];
        } else if (!winnerUserIds) {
            const max = Math.max(0, ...Array.from(this.players.values()).map(p => p.points));
            winnerUserIds = Array.from(this.players.values()).filter(p => p.points === max).map(p => p.userId);
        }
        this._winnerUserIds = winnerUserIds;
        this._setState(cancelled ? STATES.ABANDONED : STATES.GAME_END);
        this._emit('gameEnded', {
            reason,
            winnerUserIds,
            cancelled,
            finalScores: this._playerSummaries()
        });
        activeGames.delete(this.id);
        if (this.channelId) channelGameIndex.delete(this.channelId);
        // Persist final winner list + ended_at for the leaderboard query.
        // Cancelled lobbies skip the winner array entirely (NULL) so leaderboard
        // queries that match on winner_user_ids IS NOT NULL skip them.
        pool.execute(
            `UPDATE cah_games SET winner_user_ids = ?, ended_at = NOW() WHERE id = ?`,
            [cancelled ? null : JSON.stringify(winnerUserIds), this.id]
        ).catch(err => logger.error(`[cah ${this.id}] winner persist failed: ${err.message}`));
        this._persist().catch(err => logger.error(`[cah ${this.id}] persist on end failed: ${err.message}`));
        return { ok: true, winnerUserIds, cancelled };
    }

    _playerSummaries() {
        return Array.from(this.players.values()).map(p => ({
            userId: p.userId,
            platform: p.platform,
            displayName: p.displayName,
            points: p.points,
            isCzar: p.isCzar,
            handSize: p.hand.length,
            hasSubmitted: this.submissions.has(p.userId),
            strikes: p.strikes
        }));
    }

    _handPayload(p) {
        return p.hand.map(id => {
            const c = this.whiteCards.get(id);
            return { id, text: c?.text || '[missing]', isBlank: id < 0 };
        });
    }

    _setState(s) {
        const prev = this.state;
        this.state = s;
        this._emit('stateChanged', { from: prev, to: s });
        // Persist every transition so JUDGING-state crashes recover correctly.
        // Fire-and-forget — engine logic doesn't block on the DB write.
        this._persist().catch(err => logger.error(`[cah ${this.id}] _setState persist failed: ${err.message}`));
    }

    _emit(event, payload) {
        this.emit(event, { gameId: this.id, ...payload });
    }

    async _persist() {
        try {
            await pool.execute(
                `UPDATE cah_games SET state=?, current_round=?, current_black_card_id=?, current_czar_user_id=?, state_json=? WHERE id=?`,
                [
                    this.state, this.round,
                    this.currentBlack?.id || null,
                    this.czarUserId,
                    JSON.stringify({
                        whiteDraw: this.whiteDraw, whiteDiscard: this.whiteDiscard,
                        blackDraw: this.blackDraw, blackDiscard: this.blackDiscard,
                        submissions: Array.from(this.submissions.entries()),
                        players: Array.from(this.players.values())
                    }),
                    this.id
                ]
            );
        } catch (err) {
            logger.error(`[cah ${this.id}] persist failed: ${err.message}`);
        }
    }

    serialize() {
        // Never leak joinPassword over the wire — only signal "needs password"
        const { joinPassword, ...safeSettings } = this.settings;
        return {
            id: this.id, guildId: this.guildId, channelId: this.channelId,
            hostUserId: this.hostUserId, state: this.state, round: this.round,
            czarUserId: this.czarUserId,
            settings: { ...safeSettings, hasPassword: !!this.passwordHash },
            blackCard: this.currentBlack ? { text: this.currentBlack.text, pick: this.currentBlack.pick } : null,
            players: this._playerSummaries()
        };
    }
}

// ─── Pluggable rules — your design choices live here ───────────────────────────

/**
 * Decide who judges the next round.
 *
 * TODO(host): three modes are exposed via settings.czarRotation. Fill in the
 * logic for each. The current game state you can use:
 *   - game.players       : Map of userId -> { points, ... }
 *   - game.czarUserId    : who judged the last round (null on round 1)
 *   - game.lastRoundWinnerId : winner of the last round (null on round 1)
 *   - game.czarRotationIndex : monotonic counter you can mutate for strict rotation
 *   - game.settings.czarRotation : 'rotate' | 'random' | 'previous_winner'
 *
 * Return a userId string. Don't return null.
 */
function selectNextCzar(game) {
    // Randos CAN czar — otherwise a 1-human + N-randos game has the human as
    // permanent czar (who can't submit), making the game unplayable.
    // Auto-pick fires from _beginJudging when a rando is czar.
    const allIds = Array.from(game.players.keys());
    const humanIds = Array.from(game.players.entries())
        .filter(([, p]) => p.platform !== 'rando')
        .map(([id]) => id);
    // Solo-with-randos special case: prefer rotating away from the single human
    // so they actually get to PLAY cards instead of judging every round.
    const ids = (humanIds.length === 1 && allIds.length > 1) ? allIds : (humanIds.length > 0 ? humanIds : allIds);
    const mode = game.settings.czarRotation;
    if (mode === 'random') {
        return ids[Math.floor(Math.random() * ids.length)];
    }
    if (mode === 'previous_winner' && game.lastRoundWinnerId && ids.includes(game.lastRoundWinnerId)) {
        return game.lastRoundWinnerId;
    }
    game.czarRotationIndex = (game.czarRotationIndex + 1) % ids.length;
    return ids[game.czarRotationIndex];
}

/**
 * Decide whether the game is over.
 *
 * Game ends when either limit is hit, whichever comes first. On a round-limit
 * tie, all top-scorers are winners (co-victors). On a point-limit hit, the
 * player who reached it first is the sole winner.
 */
function checkWinCondition(game) {
    const players = Array.from(game.players.values());
    const pointLeader = players.find(p => p.points >= game.settings.pointsToWin);
    if (pointLeader) {
        return { gameOver: true, reason: 'points_reached', winnerUserIds: [pointLeader.userId] };
    }
    if (game.round >= game.settings.maxRounds) {
        const max = Math.max(0, ...players.map(p => p.points));
        const winners = players.filter(p => p.points === max).map(p => p.userId);
        return { gameOver: true, reason: 'round_limit', winnerUserIds: winners };
    }
    return { gameOver: false };
}

// ─── Public manager API ────────────────────────────────────────────────────────

export async function createGame({ guildId, channelId, hostUserId, settings = {} }) {
    if (channelId && channelGameIndex.has(channelId)) {
        return { ok: false, reason: 'channel_has_game' };
    }
    // Enforce per-guild policy
    if (guildId) {
        const cfg = await getGuildConfig(guildId);
        if (settings.nsfw && !cfg.nsfw_allowed) return { ok: false, reason: 'nsfw_not_allowed_in_guild' };
        if (settings.blankCardCount > 0 && !cfg.blank_cards_allowed) return { ok: false, reason: 'blanks_not_allowed_in_guild' };
        if (settings.blankCardCount > cfg.max_blank_cards) return { ok: false, reason: 'too_many_blanks' };
    }
    // NSFW deck gate: even if guild allows it, host must opt in via settings.nsfw.
    // Without the opt-in we reject any selected deck flagged nsfw=1, so a careless
    // host doesn't accidentally drop adult cards in a "kid-friendly" lobby.
    if (!settings.nsfw && settings.deckIds && settings.deckIds.length > 0) {
        const placeholders = settings.deckIds.map(() => '?').join(',');
        const [nsfwRows] = await pool.execute(
            `SELECT id, name FROM cah_decks WHERE id IN (${placeholders}) AND nsfw = 1`,
            settings.deckIds
        );
        if (nsfwRows.length > 0) {
            return { ok: false, reason: 'nsfw_deck_requires_opt_in', nsfwDeckNames: nsfwRows.map(r => r.name) };
        }
    }
    // Also short-circuit if the DB already has a live game in this channel —
    // covers the rehydrate-only case where the in-memory channelGameIndex is
    // empty but a row still says LOBBY/SUBMITTING/etc. The DB unique index
    // (migration 111) catches anything that slips through this check too.
    if (channelId) {
        const [busy] = await pool.execute(
            `SELECT id FROM cah_games WHERE active_channel_id = ? LIMIT 1`,
            [channelId]
        );
        if (busy.length > 0) return { ok: false, reason: 'channel_has_game', existingGameId: busy[0].id };
    }

    const id = randomUUID();
    const game = new CAHGame({ id, guildId, channelId, hostUserId, settings });
    activeGames.set(id, game);
    if (channelId) channelGameIndex.set(channelId, id);

    try {
        await pool.execute(
            `INSERT INTO cah_games (id, guild_id, channel_id, host_user_id, visibility, state, settings_json, password_hash) VALUES (?, ?, ?, ?, ?, 'LOBBY', ?, ?)`,
            [
                id, guildId || null, channelId || null, hostUserId,
                game.settings.visibility,
                // Don't write the plaintext password into settings_json — only the hash on the row.
                // The '***' sentinel signals "had a password" so rehydrate can re-populate from password_hash.
                JSON.stringify({ ...game.settings, joinPassword: game.passwordHash ? '***' : null }),
                game.passwordHash
            ]
        );
    } catch (err) {
        // The DB unique constraint on active_channel_id (migration 111) fires
        // ER_DUP_ENTRY if another game already owns this channel. Roll back
        // the in-memory state and surface a clean reason to the caller.
        activeGames.delete(id);
        if (channelId) channelGameIndex.delete(channelId);
        if (err.code === 'ER_DUP_ENTRY' && /uniq_active_channel/i.test(err.message)) {
            return { ok: false, reason: 'channel_has_game' };
        }
        logger.error(`[cah] createGame insert failed: ${err.message}`);
        return { ok: false, reason: 'insert_failed', error: err.message };
    }
    for (const deckId of game.settings.deckIds) {
        await pool.execute(
            `INSERT IGNORE INTO cah_game_decks (game_id, deck_id) VALUES (?, ?)`,
            [id, deckId]
        );
    }
    managerEvents.emit('gameCreated', game);
    return { ok: true, game };
}

export function getGame(gameId) {
    return activeGames.get(gameId);
}

export function getGameByChannel(channelId) {
    const id = channelGameIndex.get(channelId);
    return id ? activeGames.get(id) : null;
}

export function listActiveGames({ guildId } = {}) {
    const games = Array.from(activeGames.values());
    return guildId ? games.filter(g => g.guildId === guildId) : games;
}

/**
 * Public lobby — games anyone with a dashboard account can browse + join.
 * Queries DB rather than in-memory map so it works across PM2 instances.
 */
export async function listPublicLobbies() {
    const [rows] = await pool.execute(
        `SELECT id, host_user_id, guild_id, settings_json, password_hash, created_at
         FROM cah_games
         WHERE visibility = 'public' AND state = 'LOBBY'
         ORDER BY created_at DESC LIMIT 50`
    );
    return rows.map(r => {
        const s = typeof r.settings_json === 'string' ? JSON.parse(r.settings_json) : r.settings_json;
        return {
            id: r.id,
            hostUserId: r.host_user_id,
            guildId: r.guild_id,
            settings: { ...s, hasPassword: !!r.password_hash, joinPassword: undefined },
            createdAt: r.created_at,
            playerCount: activeGames.get(r.id)?.players.size ?? 0
        };
    });
}

const guildConfigCache = new Map();
const GUILD_CONFIG_TTL = 5 * 60 * 1000;

export async function getGuildConfig(guildId) {
    const cached = guildConfigCache.get(guildId);
    if (cached && Date.now() - cached.ts < GUILD_CONFIG_TTL) return cached.data;
    const [rows] = await pool.execute(
        'SELECT * FROM cah_guild_config WHERE guild_id = ?',
        [guildId]
    );
    const cfg = rows[0] || {
        guild_id: guildId,
        nsfw_allowed: 0,
        blank_cards_allowed: 1,
        max_blank_cards: 5,
        allow_public_imports: 1,
        default_points: 7,
        default_max_rounds: 20,
        default_timeout_secs: 90
    };
    guildConfigCache.set(guildId, { data: cfg, ts: Date.now() });
    return cfg;
}

/**
 * Boot-time rehydrate: load every game still in a non-terminal state and
 * reconstruct the in-memory CAHGame instance from `state_json`. Discord
 * adapters re-attach via `client` if the bot is back online; web adapters
 * auto-attach on the next managerEvents emission so we manually emit
 * gameCreated here too.
 *
 * Games in SUBMITTING/JUDGING get their timer re-armed. Games stuck >24h are
 * marked ABANDONED rather than rehydrated.
 */
// Hydrate one CAHGame from a cah_games row + insert into the activeGames map.
// Returns the game on success, throws on failure. Used both by the boot-time
// bulk rehydrate and by the socket handler when a game isn't in memory.
//
// Re-entrancy guard: with N custom bots all calling rehydrateActiveGames in
// parallel during boot, two callers could pass the `activeGames.has` check at
// the same time and both run loadDecks → both overwrite activeGames + arm
// duplicate timers. That produced "limbo" games where ghost timeouts fired
// against stale CAHGame instances. The in-flight Map dedupes by game id so
// only ONE hydrate actually runs; everyone else awaits the same promise.
const hydratingNow = new Map();
async function _hydrateGameRow(row) {
    if (activeGames.has(row.id)) return activeGames.get(row.id);
    const pending = hydratingNow.get(row.id);
    if (pending) return pending;
    const promise = _doHydrateRow(row);
    hydratingNow.set(row.id, promise);
    try {
        return await promise;
    } finally {
        hydratingNow.delete(row.id);
    }
}

async function _doHydrateRow(row) {
    const settings = typeof row.settings_json === 'string' ? JSON.parse(row.settings_json) : row.settings_json;
    const state = row.state_json ? (typeof row.state_json === 'string' ? JSON.parse(row.state_json) : row.state_json) : null;
    const game = new CAHGame({
        id: row.id, guildId: row.guild_id, channelId: row.channel_id,
        hostUserId: row.host_user_id, settings
    });
    // settings_json holds '***' as a sentinel — the real hash lives in the
    // password_hash column. Restore it here so password joins still validate
    // after a PM2 restart.
    if (row.password_hash) game.passwordHash = row.password_hash;
    await game.loadDecks();
    if (state) {
        game.whiteDraw    = state.whiteDraw || [];
        game.whiteDiscard = state.whiteDiscard || [];
        game.blackDraw    = state.blackDraw || [];
        game.blackDiscard = state.blackDiscard || [];
        if (state.players) for (const p of state.players) game.players.set(p.userId, p);
        if (state.submissions) for (const [uid, picks] of state.submissions) game.submissions.set(uid, picks);
    }
    // loadDecks() samples a random subset of cards per call. So the sample on
    // rehydrate is NOT the same one used when the game was created — any card
    // that ended up in someone's hand, in the draw/discard pile, in an existing
    // submission, or that was the current black card may be missing from
    // whiteCards/blackCards. That leaves currentBlack=null and "missing card"
    // texts in submissions, which previously crashed _beginJudging with
    // "Cannot read properties of null (reading 'id')" and abandoned the game.
    // Fix: explicitly fetch every card referenced by the saved state and merge
    // it into the maps before wiring state up.
    await _backfillCardsFromState(game, row, state);
    game.state = row.state;
    game.round = row.current_round;
    game.czarUserId = row.current_czar_user_id;
    if (row.current_black_card_id) game.currentBlack = game.blackCards.get(row.current_black_card_id) || null;
    activeGames.set(game.id, game);
    if (game.channelId) channelGameIndex.set(game.channelId, game.id);
    if (game.state === STATES.SUBMITTING) game._armTimeout();
    else if (game.state === STATES.JUDGING && game.submissions.size > 0) game._beginJudging();
    managerEvents.emit('gameCreated', game);
    return game;
}

/**
 * Pull every card referenced by the persisted game state directly from the DB
 * and merge them into game.whiteCards / game.blackCards. Idempotent — cards
 * already present from the sample are skipped. Negative ids (blank cards) are
 * regenerated locally rather than fetched.
 */
async function _backfillCardsFromState(game, row, state) {
    const whiteIdsWanted = new Set();
    const blackIdsWanted = new Set();

    const addWhite = (id) => { if (Number.isInteger(id) && id >= 0 && !game.whiteCards.has(id)) whiteIdsWanted.add(id); };
    const addBlack = (id) => { if (Number.isInteger(id) && id >= 0 && !game.blackCards.has(id)) blackIdsWanted.add(id); };

    if (row.current_black_card_id) addBlack(row.current_black_card_id);
    if (state) {
        for (const id of state.whiteDraw || []) addWhite(id);
        for (const id of state.whiteDiscard || []) addWhite(id);
        for (const id of state.blackDraw || []) addBlack(id);
        for (const id of state.blackDiscard || []) addBlack(id);
        for (const p of state.players || []) {
            for (const id of p.hand || []) addWhite(id);
        }
        for (const [, picks] of state.submissions || []) {
            for (const pk of picks) addWhite(pk.id);
        }
    }

    // Re-register blank-card sentinels (negative ids) so existing hands resolve.
    // The constructor's blank-card injection only runs in loadDecks(), which has
    // already happened — but the blank sentinels there get fresh negative ids
    // that may differ from the persisted hands' blank ids. Walk every hand and
    // ensure each negative id has a sentinel entry.
    const allNegativeIds = new Set();
    if (state) {
        for (const p of state.players || []) for (const id of p.hand || []) if (id < 0) allNegativeIds.add(id);
        for (const id of state.whiteDraw || []) if (id < 0) allNegativeIds.add(id);
        for (const id of state.whiteDiscard || []) if (id < 0) allNegativeIds.add(id);
    }
    for (const id of allNegativeIds) {
        if (!game.whiteCards.has(id)) game.whiteCards.set(id, { id, text: '[BLANK]', isBlank: true });
    }

    if (whiteIdsWanted.size === 0 && blackIdsWanted.size === 0) return;

    const fetchByIds = async (table, cols, ids) => {
        if (!ids.length) return [];
        const CHUNK = 2000;
        const out = [];
        for (let i = 0; i < ids.length; i += CHUNK) {
            const slice = ids.slice(i, i + CHUNK);
            const ph = slice.map(() => '?').join(',');
            const [rows] = await pool.execute(`SELECT ${cols} FROM ${table} WHERE id IN (${ph})`, slice);
            out.push(...rows);
        }
        return out;
    };
    const whiteIds = Array.from(whiteIdsWanted);
    const blackIds = Array.from(blackIdsWanted);
    const [whiteRows, blackRows] = await Promise.all([
        fetchByIds('cah_white_cards', 'id, text', whiteIds),
        fetchByIds('cah_black_cards', 'id, text, pick, draw', blackIds)
    ]);
    for (const c of whiteRows) game.whiteCards.set(c.id, c);
    for (const c of blackRows) game.blackCards.set(c.id, c);
    const missingWhite = whiteIds.length - whiteRows.length;
    const missingBlack = blackIds.length - blackRows.length;
    if (missingWhite || missingBlack) {
        logger.warn(`[cah ${game.id}] rehydrate: ${missingWhite} white + ${missingBlack} black cards no longer in DB — using fallback texts`);
        // Backfill placeholders so lookups don't crash on the missing ones.
        for (const id of whiteIds) if (!game.whiteCards.has(id)) game.whiteCards.set(id, { id, text: '[card removed]' });
        for (const id of blackIds) if (!game.blackCards.has(id)) game.blackCards.set(id, { id, text: '[card removed]', pick: 1, draw: 0 });
    }
    logger.info(`[cah ${game.id}] rehydrate: backfilled ${whiteRows.length} white + ${blackRows.length} black cards from state`);
}

/** Bring one specific game back from DB into the in-memory map. Returns the
 *  game (null if not found, or if it's already in GAME_END/ABANDONED). */
export async function rehydrateOneGame(gameId) {
    if (activeGames.has(gameId)) return activeGames.get(gameId);
    const [rows] = await pool.execute(
        `SELECT * FROM cah_games WHERE id = ? AND state NOT IN ('GAME_END','ABANDONED')`,
        [gameId]
    );
    if (rows.length === 0) return null;
    try { return await _hydrateGameRow(rows[0]); }
    catch (err) { logger.error(`[cah ${gameId}] on-demand rehydrate failed: ${err.message}`); return null; }
}

export async function rehydrateActiveGames(client = null) {
    const [rows] = await pool.execute(
        `SELECT * FROM cah_games
         WHERE state NOT IN ('GAME_END','ABANDONED')
         AND updated_at > (NOW() - INTERVAL 24 HOUR)`
    );
    let rehydrated = 0, skipped = 0, abandoned = 0;
    for (const row of rows) {
        // Skip games already loaded by an earlier bot's init pass. The
        // _hydrateGameRow guard handles this too, but checking here avoids
        // even the (cheap) re-entry into the in-flight Map.
        if (activeGames.has(row.id)) { skipped++; continue; }
        try {
            await _hydrateGameRow(row);
            rehydrated++;
        } catch (err) {
            logger.error(`[cah ${row.id}] rehydrate failed: ${err.message} — marking abandoned`);
            await pool.execute(`UPDATE cah_games SET state='ABANDONED', ended_at=NOW() WHERE id=?`, [row.id]);
            abandoned++;
        }
    }
    // Mark anything older than 24h as abandoned
    const [stale] = await pool.execute(
        `UPDATE cah_games SET state='ABANDONED', ended_at=NOW()
         WHERE state NOT IN ('GAME_END','ABANDONED')
         AND updated_at <= (NOW() - INTERVAL 24 HOUR)`
    );
    logger.info(`[cah] rehydrated ${rehydrated} games (${skipped} already loaded, ${abandoned} failed, ${stale.affectedRows || 0} stale → abandoned)`);
    return { rehydrated, skipped, abandoned, stale: stale.affectedRows || 0 };
}

/**
 * Admin escape hatch — end any game regardless of state, even one stuck without
 * a working timer or with a corrupted state machine. If the game is live in
 * memory, route through endGame() so adapters get clean events. Otherwise nuke
 * the DB row directly so it disappears from the active list.
 */
export async function adminForceEndGame(gameId, reason = 'admin_force_end') {
    const live = activeGames.get(gameId);
    if (live) {
        const result = live.endGame(reason);
        return { ok: true, mode: 'engine', cancelled: !!result.cancelled, winners: result.winnerUserIds };
    }
    // Not in memory — clear the DB row directly so it stops appearing as active.
    const [r] = await pool.execute(
        `UPDATE cah_games SET state='ABANDONED', ended_at=NOW() WHERE id = ? AND state NOT IN ('GAME_END','ABANDONED')`,
        [gameId]
    );
    return { ok: r.affectedRows > 0, mode: 'db_only', affected: r.affectedRows };
}

/**
 * Detailed live snapshot for the admin dashboard. Includes per-player state
 * not exposed by the public serialize() (strikes, hand sizes, submission state,
 * timer info). Returns null if the game isn't in memory.
 */
export function getGameAdminSnapshot(gameId) {
    const g = activeGames.get(gameId);
    if (!g) return null;
    return {
        id: g.id,
        guildId: g.guildId,
        channelId: g.channelId,
        hostUserId: g.hostUserId,
        state: g.state,
        round: g.round,
        czarUserId: g.czarUserId,
        hasPassword: !!g.passwordHash,
        players: Array.from(g.players.values()).map(p => ({
            userId: p.userId,
            platform: p.platform,
            displayName: p.displayName,
            points: p.points,
            handSize: p.hand?.length || 0,
            strikes: p.strikes || 0,
            hasSubmitted: g.submissions.has(p.userId),
            isCzar: p.userId === g.czarUserId
        })),
        deckPoolSize: { white: g.whiteCards.size, black: g.blackCards.size },
        drawPiles: { whiteDraw: g.whiteDraw.length, whiteDiscard: g.whiteDiscard.length, blackDraw: g.blackDraw.length, blackDiscard: g.blackDiscard.length },
        submissions: g.submissions.size,
        currentBlackId: g.currentBlack?.id || null,
        timerArmed: !!g.timeoutHandle,
        listenerCount: g.listenerCount('playerJoined') + g.listenerCount('roundStarted') + g.listenerCount('gameEnded')
    };
}

export async function updateGuildConfig(guildId, patch) {
    const allowed = ['nsfw_allowed', 'blank_cards_allowed', 'max_blank_cards', 'allow_public_imports', 'default_points', 'default_max_rounds', 'default_timeout_secs'];
    const cols = Object.keys(patch).filter(k => allowed.includes(k));
    if (!cols.length) return { ok: false, reason: 'no_valid_fields' };
    const placeholders = cols.map(c => `${c} = ?`).join(', ');
    const values = cols.map(c => patch[c]);
    await pool.execute(
        `INSERT INTO cah_guild_config (guild_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
         ON DUPLICATE KEY UPDATE ${placeholders}`,
        [guildId, ...values, ...values]
    );
    guildConfigCache.delete(guildId);
    return { ok: true };
}

export { STATES, DEFAULT_SETTINGS, BLANK_CARD_PREFIX };
