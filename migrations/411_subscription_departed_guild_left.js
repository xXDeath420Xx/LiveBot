/**
 * Wave 411 — 'guild_left' departure reason.
 *
 * The departure sweeper only ever asked "is this member still in the server?", and skipped every
 * server no running bot could see. So a deleted server, or one whose bot was removed from our
 * system, kept its subscriptions active forever (found 2026-11-09: DabFam Lounge, WildWolf's
 * deleted server, and others). Those are now paused with reason 'guild_left' and restored
 * automatically if a bot is back in the server.
 */
export async function up(pool) {
    const [[col]] = await pool.query("SHOW COLUMNS FROM subscriptions LIKE 'departed_reason'");
    if (col.Type.includes("'guild_left'")) return;
    await pool.query(
        `ALTER TABLE subscriptions MODIFY departed_reason
           ENUM('leave','kick','ban','sweep','manual','guild_left') ${col.Null === 'YES' ? 'NULL' : 'NOT NULL'} DEFAULT NULL`);
}

export async function down(pool) {
    await pool.query("UPDATE subscriptions SET departed_reason = 'manual' WHERE departed_reason = 'guild_left'");
    await pool.query(
        "ALTER TABLE subscriptions MODIFY departed_reason ENUM('leave','kick','ban','sweep','manual') NULL DEFAULT NULL");
}
