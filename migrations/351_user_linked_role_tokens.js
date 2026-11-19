/**
 * Migration 351 — Discord Linked Role user tokens.
 *
 * Stores the Discord OAuth2 access + refresh tokens that each user grants us
 * via the Linked Role flow (role_connections.write scope). Tokens let us PUSH
 * their metadata without them having to click again.
 *
 * Tokens are encrypted via utils/encryption.js (BOT_ENCRYPTION_KEY).
 *
 * Idempotent.
 */
async function hasTable(db, table) {
    const [rows] = await db.execute(
        'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
    return rows.length > 0;
}

export async function up(db) {
    if (!(await hasTable(db, 'user_linked_role_tokens'))) {
        await db.execute(`
            CREATE TABLE user_linked_role_tokens (
                discord_user_id    VARCHAR(20) NOT NULL,
                access_token_enc   TEXT        NOT NULL,
                refresh_token_enc  TEXT        NOT NULL,
                scopes             VARCHAR(255) NULL,
                expires_at         TIMESTAMP   NULL,
                last_pushed_at     TIMESTAMP   NULL,
                connected_at       TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at         TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                PRIMARY KEY (discord_user_id),
                KEY idx_expires (expires_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`);
        console.log('[migrate 351] created user_linked_role_tokens');
    }
}
