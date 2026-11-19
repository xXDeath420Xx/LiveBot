/*
 * Migration 273: Tokes profile preferences on tokes_profiles.
 *
 * The Tokes profile page (views/tokes-bot/profile.ejs) offers "Show on public leaderboards",
 * a bio, a favourite strain and a preferred piece, and PUT /tokes-bot/api/profile
 * (dashboard/routes/tokes-bot.js) saves them — but tokes_profiles never had those columns,
 * so every save failed with "Unknown column 'show_on_leaderboard'".
 *
 *   show_on_leaderboard  1 = listed (default, so every existing profile keeps showing);
 *                        0 = hidden from the public leaderboards (/tokes-bot/leaderboards and
 *                        the chat !fireboard channel/global/streaks/levels boards)
 *   profile_bio          up to 500 chars (utils/input-validation.js MAX_LENGTHS.PROFILE_BIO)
 *   favorite_strain      free text, up to 100 chars (the form's maxlength)
 *   preferred_piece      joint | blunt | bong | pipe | dab | vape (the form's options)
 *   timezone             IANA zone name, validated with Intl
 *
 * Idempotent: each column is added only if information_schema says it is missing.
 */
const COLUMNS = [
    ['show_on_leaderboard', 'TINYINT(1) NOT NULL DEFAULT 1'],
    ['profile_bio', 'VARCHAR(500) NULL DEFAULT NULL'],
    ['favorite_strain', 'VARCHAR(100) NULL DEFAULT NULL'],
    ['preferred_piece', 'VARCHAR(20) NULL DEFAULT NULL'],
    ['timezone', 'VARCHAR(64) NULL DEFAULT NULL'],
];

async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        `SELECT 1 FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]
    );
    return rows.length > 0;
}

export async function up(db) {
    for (const [column, definition] of COLUMNS) {
        if (!(await hasColumn(db, 'tokes_profiles', column))) {
            await db.execute(`ALTER TABLE tokes_profiles ADD COLUMN \`${column}\` ${definition}`);
        }
    }
}

export async function down(db) {
    for (const [column] of [...COLUMNS].reverse()) {
        if (await hasColumn(db, 'tokes_profiles', column)) {
            await db.execute(`ALTER TABLE tokes_profiles DROP COLUMN \`${column}\``);
        }
    }
}
