/**
 * Master deck builder. Produces:
 *   - A "🌿 420 / Cannabis" pack of original cards (idempotent — skips if a
 *     marijuana-themed pack already exists)
 *   - A "🔥 CertiFried Mega Pack" containing every UNIQUE card text across
 *     every other deck in the DB, plus everything from the 420 pack
 *
 * Both are stored as source='builtin' so users can't accidentally delete
 * them via the user-deck CRUD. Rebuild is idempotent — re-running wipes the
 * mega pack's cards and re-aggregates, picking up any new imports since
 * last build.
 *
 * Dedup key: lowercase-trimmed text. Black cards also key on pick count so
 * a pick-1 and pick-2 variant of the same prompt are both kept.
 */

import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const FOUR_TWENTY_NAME = '🌿 420 / Cannabis Pack';
const MEGA_NAME = '🔥 CertiFried Mega Pack';

// Curated 420 cards — original, written for this build. Mix of cannabis culture,
// shared with the weed-themed community this bot serves. Black cards use _____
// as the blank marker (same convention as the rest of the engine).
const FOUR_TWENTY_WHITE = [
    'A perfectly rolled joint.',
    'Couch lock.',
    'The munchies at 3am.',
    'A budtender who actually knows their strains.',
    'Forgetting what you were just saying mid-sentence.',
    'A bowl of GG#4.',
    'Live resin.',
    'A clogged bong.',
    'Realizing you\'re too high in public.',
    'A dispensary deal too good to be true.',
    'The first hit of the day.',
    'Cottonmouth so bad you could drink a lake.',
    'Trying to play it cool around your parents.',
    'A bong rip that makes you cough for ten minutes.',
    'Eating a whole pizza by yourself.',
    'Forgetting where you put your lighter.',
    'A grinder so sticky it stops working.',
    'Pretending to remember the conversation.',
    'A vape pen with a dead battery.',
    'Snoop Dogg\'s personal stash.',
    'A perfectly cured nug.',
    'Wax dabs at noon.',
    'Edibles that hit way too hard.',
    'A 5g blunt.',
    'The friend who never has their own weed.',
    'A clogged carb on your favorite piece.',
    'Trichomes thick enough to ski on.',
    'A dab rig setup that costs more than your car.',
    'Hash that tastes like the 90s.',
    'Falling asleep mid-conversation.',
    'A scale that lies to you on purpose.',
    'Getting too high to leave the couch.',
    'Mystery brownies at a party.',
    'The smell of a freshly cracked jar.',
    'A two-hour Wikipedia rabbit hole.',
    'That one strain you keep meaning to try.',
    'The plug who\'s always 45 minutes away.',
    'Cross-faded at a wedding.',
    'A whole bag of Doritos.',
    'A grinder full of kief.'
];

const FOUR_TWENTY_BLACK = [
    { text: 'What does this bud smell like? _____.', pick: 1 },
    { text: 'My dealer just hit me up about _____.', pick: 1 },
    { text: 'I would smoke _____ if it got me high.', pick: 1 },
    { text: 'You know you\'re too high when _____.', pick: 1 },
    { text: 'The new strain at the dispensary is called "_____".', pick: 1 },
    { text: 'I lost my _____ last sesh.', pick: 1 },
    { text: 'Step 1: _____. Step 2: _____. Step 3: 420.', pick: 2 },
    { text: 'My greenhouse is full of _____ and _____.', pick: 2 },
    { text: 'After my edibles kicked in, I _____.', pick: 1 },
    { text: 'The munchies hit and I ate _____.', pick: 1 },
    { text: 'What\'s in this blunt? _____.', pick: 1 },
    { text: 'I rolled a joint so big it had _____ in it.', pick: 1 },
    { text: 'I would never trade my weed for _____.', pick: 1 },
    { text: 'My favorite stoner movie features _____, _____, and _____.', pick: 3 },
    { text: 'Snoop Dogg\'s next album is called "_____".', pick: 1 },
    { text: 'I dab _____ for breakfast.', pick: 1 }
];

async function findExistingMarijuanaPack() {
    // Tight regex: actual weed-specific terms. Skip "dank" (overloaded with
    // dank memes) and "kush" (often used as a name). Want a real cannabis pack.
    const [rows] = await pool.execute(
        `SELECT id, name FROM cah_decks
         WHERE LOWER(name) REGEXP '(^|[^a-z])(420|weed|marijuana|cannabis|ganja|pothead)([^a-z]|$)'
         ORDER BY (SELECT COUNT(*) FROM cah_white_cards w WHERE w.deck_id = cah_decks.id) DESC
         LIMIT 1`
    );
    return rows[0] || null;
}

/**
 * Seed the curated 420 pack. By default skips if a marijuana-themed pack
 * already exists. Pass { force: true } to always seed regardless (useful when
 * you want our branded CertiFried 420 pack alongside any community ones).
 */
export async function seed420PackIfMissing({ force = false } = {}) {
    if (!force) {
        const existing = await findExistingMarijuanaPack();
        if (existing) {
            logger.info(`[certifried-builder] marijuana pack already exists: #${existing.id} "${existing.name}" — skipping seed (pass force=true to add ours anyway)`);
            return { ok: true, deckId: existing.id, seeded: false, reusedExisting: existing.name };
        }
    }
    // Don't re-seed our own if we already added it before
    const [ours] = await pool.execute(
        `SELECT id FROM cah_decks WHERE source = 'builtin' AND name = ? LIMIT 1`,
        [FOUR_TWENTY_NAME]
    );
    if (ours.length > 0) {
        return { ok: true, deckId: ours[0].id, seeded: false, reason: 'already_seeded' };
    }
    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();
        const [ins] = await conn.execute(
            `INSERT INTO cah_decks (cast_id, name, description, source, nsfw, is_public)
             VALUES (NULL, ?, ?, 'builtin', 1, 1)`,
            [FOUR_TWENTY_NAME, 'Original 420 / cannabis cards for CertiFriedMultitool. Auto-seeded.']
        );
        const deckId = ins.insertId;
        const ph = FOUR_TWENTY_WHITE.map(() => '(?, ?)').join(', ');
        await conn.execute(
            `INSERT INTO cah_white_cards (deck_id, text) VALUES ${ph}`,
            FOUR_TWENTY_WHITE.flatMap(t => [deckId, t])
        );
        const bph = FOUR_TWENTY_BLACK.map(() => '(?, ?, ?, ?)').join(', ');
        await conn.execute(
            `INSERT INTO cah_black_cards (deck_id, text, pick, draw) VALUES ${bph}`,
            FOUR_TWENTY_BLACK.flatMap(c => [deckId, c.text, c.pick, c.pick >= 3 ? c.pick - 1 : 0])
        );
        await conn.commit();
        logger.info(`[certifried-builder] seeded 420 pack #${deckId} (${FOUR_TWENTY_WHITE.length} white, ${FOUR_TWENTY_BLACK.length} black)`);
        return { ok: true, deckId, seeded: true };
    } catch (err) {
        await conn.rollback();
        logger.error(`[certifried-builder] 420 seed failed: ${err.message}`);
        return { ok: false, reason: 'seed_error', error: err.message };
    } finally {
        conn.release();
    }
}

/**
 * Build (or rebuild) the CertiFried Mega Pack from every other deck in the DB.
 * Dedupes by normalized text. Returns counts.
 */
export async function buildCertiFriedMegaPack() {
    // Ensure 420 pack exists first so its cards roll into the mega
    await seed420PackIfMissing();

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // Find or create the mega deck
        const [existing] = await conn.execute(
            `SELECT id FROM cah_decks WHERE source = 'builtin' AND name = ? LIMIT 1`,
            [MEGA_NAME]
        );
        let megaId;
        if (existing.length > 0) {
            megaId = existing[0].id;
            await conn.execute(`DELETE FROM cah_white_cards WHERE deck_id = ?`, [megaId]);
            await conn.execute(`DELETE FROM cah_black_cards WHERE deck_id = ?`, [megaId]);
        } else {
            const [ins] = await conn.execute(
                `INSERT INTO cah_decks (cast_id, name, description, source, nsfw, is_public)
                 VALUES (NULL, ?, ?, 'builtin', 1, 1)`,
                [MEGA_NAME, 'Every unique card from every deck, combined into one mega pack. Rebuild anytime to pick up new imports.']
            );
            megaId = ins.insertId;
        }

        // STRICTLY English source decks. 'und' is excluded — too many of those
        // were leaking foreign cards. Card-level filter inside the engine
        // (looksNonEnglish + non-Latin char check) is the second line of defense.
        const [whiteRows] = await conn.execute(`
            SELECT MIN(w.text) AS text
            FROM cah_white_cards w
            JOIN cah_decks d ON d.id = w.deck_id
            WHERE w.deck_id != ? AND d.language = 'en'
            GROUP BY LOWER(TRIM(w.text))
            HAVING text IS NOT NULL AND CHAR_LENGTH(MIN(w.text)) <= 500
        `, [megaId]);

        const [blackRows] = await conn.execute(`
            SELECT MIN(b.text) AS text, b.pick, MAX(b.draw) AS draw
            FROM cah_black_cards b
            JOIN cah_decks d ON d.id = b.deck_id
            WHERE b.deck_id != ? AND d.language = 'en'
            GROUP BY LOWER(TRIM(b.text)), b.pick
            HAVING text IS NOT NULL AND CHAR_LENGTH(MIN(b.text)) <= 500
        `, [megaId]);

        // Bulk insert in chunks (MySQL packet size limit ~16MB; 500-row chunks stay safe)
        const CHUNK = 500;
        for (let i = 0; i < whiteRows.length; i += CHUNK) {
            const batch = whiteRows.slice(i, i + CHUNK);
            const ph = batch.map(() => '(?, ?)').join(', ');
            await conn.execute(
                `INSERT INTO cah_white_cards (deck_id, text) VALUES ${ph}`,
                batch.flatMap(r => [megaId, r.text])
            );
        }
        for (let i = 0; i < blackRows.length; i += CHUNK) {
            const batch = blackRows.slice(i, i + CHUNK);
            const ph = batch.map(() => '(?, ?, ?, ?)').join(', ');
            await conn.execute(
                `INSERT INTO cah_black_cards (deck_id, text, pick, draw) VALUES ${ph}`,
                batch.flatMap(r => [megaId, r.text, r.pick, r.draw || 0])
            );
        }

        await conn.commit();
        logger.info(`[certifried-builder] mega pack #${megaId} rebuilt: ${whiteRows.length} white, ${blackRows.length} black`);
        return { ok: true, deckId: megaId, white: whiteRows.length, black: blackRows.length };
    } catch (err) {
        await conn.rollback();
        logger.error(`[certifried-builder] mega build failed: ${err.message}`);
        return { ok: false, reason: 'build_error', error: err.message };
    } finally {
        conn.release();
    }
}
