/**
 * Migration 350 — encrypted ticket transcripts.
 *
 * TicketsBot sells "encrypted cloud transcripts" as premium. Ours ship free.
 * On ticket/modmail close we build a JSON transcript (every message + metadata),
 * encrypt with AES-256-GCM using BOT_ENCRYPTION_KEY, and store the blob.
 * Access via /transcripts/:guildId/:kind/:id with mod perm — decrypts on view.
 *
 * Indefinite retention by design (TicketsBot sells 30-day free vs indefinite
 * premium; we don't tier so give everyone indefinite). Still cap by storage
 * sanity: 1 MB per transcript hard cap after encryption.
 *
 * Idempotent.
 */
async function hasTable(db, table) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
    return rows.length > 0;
}

export async function up(db) {
    if (!(await hasTable(db, 'ticket_transcripts'))) {
        await db.execute(`
            CREATE TABLE ticket_transcripts (
                id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                guild_id       VARCHAR(20)     NOT NULL,
                kind           ENUM('ticket','modmail') NOT NULL,
                source_id      BIGINT UNSIGNED NOT NULL,   -- tickets.id or modmail_threads.id
                channel_id     VARCHAR(20)     NOT NULL,
                user_id        VARCHAR(20)     NOT NULL,   -- opener
                message_count  INT UNSIGNED    NOT NULL,
                encrypted_blob MEDIUMBLOB      NOT NULL,
                iv             VARBINARY(16)   NOT NULL,
                auth_tag       VARBINARY(16)   NOT NULL,
                size_bytes     INT UNSIGNED    NOT NULL,
                created_at     TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (id),
                UNIQUE KEY uq_source (guild_id, kind, source_id),
                KEY idx_guild_created (guild_id, created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
        console.log('[migrate 350] created ticket_transcripts');
    }
    // No retention row — indefinite by design.
}
