/**
 * User-authored CAH deck CRUD. Decks live in `cah_decks` with source='custom',
 * `owner_user_id` set to the Discord OAuth id, and a generated 5-char share
 * code stored in `cast_id`. Public decks (is_public=1) appear in everyone's
 * picker; private decks only show to the owner OR anyone the owner shares the
 * share code with.
 *
 * Black-card format: the user writes plain text with `_____` (5 underscores)
 * wherever they want a blank. We count blanks to derive `pick` (min 1) and
 * compute `draw = pick - 1` if pick >= 3, matching official CAH rules. The
 * stored text keeps `_____` markers so the runtime renderer can replace them
 * with the played white card text when displaying judging submissions.
 */

import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const SHARE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I/O/0/1 to dodge ambiguity
const SHARE_CODE_LENGTH = 5;

function generateShareCode() {
    let s = '';
    for (let i = 0; i < SHARE_CODE_LENGTH; i++) {
        s += SHARE_CODE_ALPHABET[Math.floor(Math.random() * SHARE_CODE_ALPHABET.length)];
    }
    return s;
}

async function uniqueShareCode() {
    // Up to 5 attempts to find an unused code. Collision probability is
    // effectively zero at our scale (32^5 = 33M codes), so retry is mostly
    // belt-and-suspenders for the composite (source, cast_id) unique key.
    for (let i = 0; i < 5; i++) {
        const code = generateShareCode();
        const [rows] = await pool.execute(
            `SELECT 1 FROM cah_decks WHERE source = 'custom' AND cast_id = ? LIMIT 1`, [code]
        );
        if (rows.length === 0) return code;
    }
    throw new Error('Could not generate unique share code');
}

/** Count blanks in a black-card text. `_____` (5 underscores) = one blank. */
export function countBlanks(text) {
    if (!text) return 0;
    return (text.match(/_{5,}/g) || []).length;
}

export function inferPick(text) {
    return Math.max(1, countBlanks(text));
}

export function inferDraw(pick) {
    return pick >= 3 ? pick - 1 : 0;
}

/**
 * Create an empty deck owned by the given user. Returns the new deck id +
 * share code. The deck has no cards yet — caller adds them via addWhiteCard /
 * addBlackCard.
 */
export async function createDeck({ ownerUserId, name, description = '', isPublic = false, nsfw = false }) {
    if (!ownerUserId) return { ok: false, reason: 'no_owner' };
    const cleanName = String(name || '').trim().slice(0, 255);
    if (!cleanName) return { ok: false, reason: 'name_required' };
    const code = await uniqueShareCode();
    const [r] = await pool.execute(
        `INSERT INTO cah_decks (cast_id, name, description, source, nsfw, is_public, owner_user_id, imported_by_user_id)
         VALUES (?, ?, ?, 'custom', ?, ?, ?, ?)`,
        [code, cleanName, String(description || '').slice(0, 1000), nsfw ? 1 : 0, isPublic ? 1 : 0, ownerUserId, ownerUserId]
    );
    logger.info(`[cah-authoring] deck #${r.insertId} (${code}) created by ${ownerUserId}`);
    return { ok: true, deckId: r.insertId, shareCode: code };
}

async function assertOwner(deckId, userId) {
    const [rows] = await pool.execute(
        `SELECT id, owner_user_id, source FROM cah_decks WHERE id = ?`, [deckId]
    );
    if (rows.length === 0) return { ok: false, reason: 'deck_not_found' };
    if (rows[0].source !== 'custom') return { ok: false, reason: 'not_a_custom_deck' };
    if (rows[0].owner_user_id !== userId) return { ok: false, reason: 'not_owner' };
    return { ok: true, deck: rows[0] };
}

export async function updateDeckMeta(deckId, userId, { name, description, isPublic, nsfw } = {}) {
    const own = await assertOwner(deckId, userId);
    if (!own.ok) return own;
    const sets = []; const params = [];
    if (name !== undefined) { sets.push('name = ?'); params.push(String(name).trim().slice(0, 255)); }
    if (description !== undefined) { sets.push('description = ?'); params.push(String(description).slice(0, 1000)); }
    if (isPublic !== undefined) { sets.push('is_public = ?'); params.push(isPublic ? 1 : 0); }
    if (nsfw !== undefined) { sets.push('nsfw = ?'); params.push(nsfw ? 1 : 0); }
    if (!sets.length) return { ok: false, reason: 'no_fields' };
    params.push(deckId);
    await pool.execute(`UPDATE cah_decks SET ${sets.join(', ')} WHERE id = ?`, params);
    return { ok: true };
}

export async function deleteDeck(deckId, userId) {
    const own = await assertOwner(deckId, userId);
    if (!own.ok) return own;
    // FK CASCADE wipes cards + game_decks rows automatically
    await pool.execute(`DELETE FROM cah_decks WHERE id = ?`, [deckId]);
    return { ok: true };
}

export async function addWhiteCard(deckId, userId, text) {
    const own = await assertOwner(deckId, userId);
    if (!own.ok) return own;
    const clean = String(text || '').trim();
    if (!clean) return { ok: false, reason: 'empty' };
    if (clean.length > 500) return { ok: false, reason: 'too_long' };
    const [r] = await pool.execute(
        `INSERT INTO cah_white_cards (deck_id, text) VALUES (?, ?)`, [deckId, clean]
    );
    return { ok: true, cardId: r.insertId };
}

export async function addBlackCard(deckId, userId, text) {
    const own = await assertOwner(deckId, userId);
    if (!own.ok) return own;
    const clean = String(text || '').trim();
    if (!clean) return { ok: false, reason: 'empty' };
    if (clean.length > 500) return { ok: false, reason: 'too_long' };
    const pick = inferPick(clean);
    if (pick > 5) return { ok: false, reason: 'too_many_blanks' };
    // Ensure the text actually contains a blank for pick>=1 (auto-append if missing)
    const finalText = countBlanks(clean) > 0 ? clean : `${clean} _____`;
    const [r] = await pool.execute(
        `INSERT INTO cah_black_cards (deck_id, text, pick, draw) VALUES (?, ?, ?, ?)`,
        [deckId, finalText, pick, inferDraw(pick)]
    );
    return { ok: true, cardId: r.insertId, pick, draw: inferDraw(pick) };
}

export async function deleteWhiteCard(deckId, userId, cardId) {
    const own = await assertOwner(deckId, userId);
    if (!own.ok) return own;
    const [r] = await pool.execute(`DELETE FROM cah_white_cards WHERE deck_id = ? AND id = ?`, [deckId, cardId]);
    return { ok: r.affectedRows > 0, reason: r.affectedRows ? undefined : 'card_not_found' };
}

export async function deleteBlackCard(deckId, userId, cardId) {
    const own = await assertOwner(deckId, userId);
    if (!own.ok) return own;
    const [r] = await pool.execute(`DELETE FROM cah_black_cards WHERE deck_id = ? AND id = ?`, [deckId, cardId]);
    return { ok: r.affectedRows > 0, reason: r.affectedRows ? undefined : 'card_not_found' };
}

export async function listMyDecks(userId) {
    const [rows] = await pool.execute(
        `SELECT d.id, d.cast_id AS share_code, d.name, d.description, d.is_public, d.nsfw, d.imported_at,
                (SELECT COUNT(*) FROM cah_white_cards w WHERE w.deck_id = d.id) AS white_count,
                (SELECT COUNT(*) FROM cah_black_cards b WHERE b.deck_id = d.id) AS black_count
         FROM cah_decks d
         WHERE d.source = 'custom' AND d.owner_user_id = ?
         ORDER BY d.imported_at DESC`,
        [userId]
    );
    return rows;
}

export async function getDeck(deckId, userId = null) {
    // Returns deck + cards. If the deck is private and userId isn't the owner,
    // returns null (treats as not-found from caller's perspective).
    const [decks] = await pool.execute(
        `SELECT id, cast_id AS share_code, name, description, is_public, nsfw, owner_user_id, source FROM cah_decks WHERE id = ?`,
        [deckId]
    );
    if (decks.length === 0) return null;
    const d = decks[0];
    if (d.source === 'custom' && !d.is_public && d.owner_user_id !== userId) return null;
    const [white] = await pool.execute(`SELECT id, text FROM cah_white_cards WHERE deck_id = ? ORDER BY id`, [deckId]);
    const [black] = await pool.execute(`SELECT id, text, pick, draw FROM cah_black_cards WHERE deck_id = ? ORDER BY id`, [deckId]);
    return { ...d, whiteCards: white, blackCards: black };
}

/** Find a custom deck by share code (lets users add others' decks to their games via code). */
export async function findByShareCode(code) {
    const c = String(code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{3,8}$/.test(c)) return null;
    const [rows] = await pool.execute(
        `SELECT id, cast_id AS share_code, name, is_public, owner_user_id FROM cah_decks WHERE source = 'custom' AND cast_id = ?`,
        [c]
    );
    return rows[0] || null;
}
