/**
 * One-shot runner for migration 105 (Cards Against Humanity). Mirrors the
 * pattern of scripts/run-migration-104.js since there is no generic
 * migrations/run.js in this repo (the generic runner has a known bug per
 * project notes — individual scripts are the workaround).
 *
 * After applying, also seeds the built-in starter deck so games are
 * playable immediately without any CAST import.
 */
import dotenv from 'dotenv';
dotenv.config();
import pool from '../utils/db.js';
import { up } from '../migrations/105_cards_against_humanity.js';
import { seedBuiltinDeck } from '../core/cah-deck-importer.js';

const expected = [
    'cah_decks', 'cah_white_cards', 'cah_black_cards',
    'cah_games', 'cah_game_decks', 'cah_game_players',
    'cah_game_submissions', 'cah_guild_config'
];

(async () => {
    try {
        await up(pool);
        const results = await Promise.all(expected.map(async t => {
            const [[r]] = await pool.execute(
                "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
                [t]
            );
            return { table: t, present: r.n === 1 };
        }));
        const missing = results.filter(r => !r.present);
        console.log('\n=== Migration 105 table check ===');
        for (const r of results) console.log(`  ${r.present ? '✓' : '✗'} ${r.table}`);
        if (missing.length > 0) {
            console.error(`\n${missing.length} tables missing — migration incomplete`);
            process.exitCode = 1;
            return;
        }
        console.log('\n=== Seeding built-in starter deck ===');
        const seed = await seedBuiltinDeck();
        if (seed.ok) {
            console.log(`  ${seed.seeded ? '✓ seeded' : '✓ already present'} deck #${seed.deckId}`);
        } else {
            console.error(`  ✗ seed failed: ${seed.reason} ${seed.error || ''}`);
            process.exitCode = 1;
        }
        console.log('\nMigration 105 complete.');
    } catch (err) {
        console.error('Migration failed:', err);
        process.exitCode = 1;
    } finally {
        await pool.end();
    }
})();
