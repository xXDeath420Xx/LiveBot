/**
 * Migration 111: Enforce "at most one live CAH game per Discord channel" at the
 * DB layer.
 *
 * Backstory: the engine already keeps an in-memory channelGameIndex Map and
 * refuses createGame() if the channel has an active game. But that check is
 * application-level and racy across concurrent createGame() calls or across
 * multi-process setups. A DB-level constraint is the last line of defense.
 *
 * MySQL doesn't support partial unique indexes natively, so we use the
 * generated-column pattern: `active_channel_id` mirrors `channel_id` for
 * non-terminal states and is NULL for GAME_END/ABANDONED. A UNIQUE index on
 * that column means two non-terminal rows can never share a channel — the
 * second INSERT/UPDATE errors out with ER_DUP_ENTRY.
 *
 * Per-host overlap is left unconstrained on purpose: hosting in multiple
 * channels is a valid pattern (different communities, web vs guild lobbies).
 */
async function columnExists(db, table, column) {
    const [rows] = await db.execute(
        `SELECT COUNT(*) AS n FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
        [table, column]
    );
    return rows[0].n > 0;
}

async function indexExists(db, table, index) {
    const [rows] = await db.execute(
        `SELECT COUNT(*) AS n FROM information_schema.statistics
         WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
        [table, index]
    );
    return rows[0].n > 0;
}

export async function up(db) {
    // Defensive: clear pre-existing dupes before adding the constraint — the
    // ALTER would fail otherwise. Keep only the most recently updated row per
    // (channel_id, non-terminal-state) tuple; mark the rest ABANDONED.
    await db.execute(`
        UPDATE cah_games target
        JOIN (
            SELECT g1.id
            FROM cah_games g1
            JOIN cah_games g2 ON g1.channel_id = g2.channel_id
                AND g2.state NOT IN ('GAME_END','ABANDONED')
                AND g2.channel_id IS NOT NULL
                AND g2.updated_at > g1.updated_at
            WHERE g1.state NOT IN ('GAME_END','ABANDONED')
              AND g1.channel_id IS NOT NULL
        ) dupes ON dupes.id = target.id
        SET target.state = 'ABANDONED', target.ended_at = NOW()
    `);

    if (!(await columnExists(db, 'cah_games', 'active_channel_id'))) {
        await db.execute(`
            ALTER TABLE cah_games
            ADD COLUMN active_channel_id VARCHAR(20)
            GENERATED ALWAYS AS (
                CASE WHEN state IN ('GAME_END','ABANDONED') THEN NULL ELSE channel_id END
            ) STORED AFTER channel_id
        `);
    }
    if (!(await indexExists(db, 'cah_games', 'uniq_active_channel'))) {
        await db.execute(`
            ALTER TABLE cah_games
            ADD UNIQUE INDEX uniq_active_channel (active_channel_id)
        `);
    }
}

export async function down(db) {
    if (await indexExists(db, 'cah_games', 'uniq_active_channel')) {
        await db.execute(`ALTER TABLE cah_games DROP INDEX uniq_active_channel`);
    }
    if (await columnExists(db, 'cah_games', 'active_channel_id')) {
        await db.execute(`ALTER TABLE cah_games DROP COLUMN active_channel_id`);
    }
}
