/**
 * Wave 381 — subscriptions.departed_reason gains 'manual' so admin-triggered
 * removals can be tracked separately from auto-pauses (leave/kick/ban/sweep).
 * `/subs restore except-manual` relies on this flag.
 */
export async function up(pool) {
    await pool.query(`
        ALTER TABLE subscriptions
        MODIFY COLUMN departed_reason ENUM('leave','kick','ban','sweep','manual') DEFAULT NULL
    `);
}
export async function down(pool) {
    await pool.query(`
        ALTER TABLE subscriptions
        MODIFY COLUMN departed_reason ENUM('leave','kick','ban','sweep') DEFAULT NULL
    `);
}
