/**
 * Wave 376 — twitch_anomaly_alerts.status so false positives / acknowledged / resolved
 * rows don't inflate the primary view. Keeps full audit trail (we never delete).
 */
export async function up(pool) {
    const [exists] = await pool.query(
        `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'twitch_anomaly_alerts' AND COLUMN_NAME = 'status'`);
    if (!exists[0].n) {
        await pool.query(`
            ALTER TABLE twitch_anomaly_alerts
            ADD COLUMN status ENUM('open','acknowledged','superseded','resolved') NOT NULL DEFAULT 'open',
            ADD COLUMN resolved_by_discord_id VARCHAR(20) DEFAULT NULL,
            ADD COLUMN resolved_at DATETIME DEFAULT NULL,
            ADD COLUMN resolution_note VARCHAR(500) DEFAULT NULL,
            ADD KEY idx_broadcaster_status (broadcaster_id, status, created_at)
        `);
    }

    // Retro-populate status from the evidence_json ack fields set in wave 376's earlier pass.
    await pool.query(`
        UPDATE twitch_anomaly_alerts
           SET status = 'superseded',
               resolved_at = COALESCE(resolved_at, created_at),
               resolution_note = JSON_UNQUOTE(JSON_EXTRACT(evidence_json, '$.ack_note'))
         WHERE status = 'open'
           AND JSON_EXTRACT(evidence_json, '$.superseded_by') IS NOT NULL
    `);

    await pool.query(`
        UPDATE twitch_anomaly_alerts
           SET status = 'acknowledged',
               resolved_by_discord_id = JSON_UNQUOTE(JSON_EXTRACT(evidence_json, '$.acknowledged_by')),
               resolved_at = COALESCE(resolved_at, created_at),
               resolution_note = JSON_UNQUOTE(JSON_EXTRACT(evidence_json, '$.ack_note'))
         WHERE status = 'open'
           AND JSON_EXTRACT(evidence_json, '$.acknowledged_by') IS NOT NULL
           AND JSON_EXTRACT(evidence_json, '$.superseded_by') IS NULL
    `);
}

export async function down(pool) {
    try { await pool.query(`ALTER TABLE twitch_anomaly_alerts DROP COLUMN status, DROP COLUMN resolved_by_discord_id, DROP COLUMN resolved_at, DROP COLUMN resolution_note`); } catch {}
}
