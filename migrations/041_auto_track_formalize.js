/**
 * Migration 041: Formalize guild_streamer_auto_track table
 *
 * Existing table has: composite PK (guild_id, role_id), role_id NOT NULL,
 * announcement_channel_id, enabled, created_at.
 *
 * This migration:
 * 1. Creates table if missing (fresh installs get final schema)
 * 2. For existing installs: drops composite PK, adds auto_id as new PK,
 *    makes role_id nullable, adds updated_at, adds UNIQUE(guild_id, role_id)
 */
export async function up(pool) {
    // Check if table exists
    const [tables] = await pool.execute(
        `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'guild_streamer_auto_track'`
    );

    if (tables.length === 0) {
        // Fresh install — create with final schema
        await pool.execute(`
            CREATE TABLE guild_streamer_auto_track (
                auto_id INT AUTO_INCREMENT PRIMARY KEY,
                guild_id VARCHAR(20) NOT NULL,
                role_id VARCHAR(20) DEFAULT NULL,
                announcement_channel_id VARCHAR(20) NOT NULL,
                enabled TINYINT(1) DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uq_guild_role (guild_id, role_id)
            )
        `);
        return;
    }

    // Existing table — migrate incrementally
    const [columns] = await pool.execute('SHOW COLUMNS FROM guild_streamer_auto_track');
    const columnNames = columns.map(c => c.Field);

    // Add auto_id if missing: need to drop existing PK first, then add auto_id as new PK
    if (!columnNames.includes('auto_id')) {
        // Drop composite primary key
        await pool.execute('ALTER TABLE guild_streamer_auto_track DROP PRIMARY KEY');
        // Add auto_id as auto-increment primary key
        await pool.execute('ALTER TABLE guild_streamer_auto_track ADD COLUMN auto_id INT AUTO_INCREMENT PRIMARY KEY FIRST');
        // Add unique constraint on (guild_id, role_id)
        await pool.execute('ALTER TABLE guild_streamer_auto_track ADD UNIQUE KEY uq_guild_role (guild_id, role_id)').catch(() => {
            // May already exist or conflict — not fatal
        });
    }

    // Add missing columns
    if (!columnNames.includes('enabled')) {
        await pool.execute('ALTER TABLE guild_streamer_auto_track ADD COLUMN enabled TINYINT(1) DEFAULT 1');
    }

    if (!columnNames.includes('created_at')) {
        await pool.execute('ALTER TABLE guild_streamer_auto_track ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
    }

    if (!columnNames.includes('updated_at')) {
        await pool.execute('ALTER TABLE guild_streamer_auto_track ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
    }

    // Make role_id nullable (was NOT NULL in manual creation)
    await pool.execute('ALTER TABLE guild_streamer_auto_track MODIFY COLUMN role_id VARCHAR(20) DEFAULT NULL');
}

export async function down(pool) {
    // Revert to original schema shape
    const [columns] = await pool.execute('SHOW COLUMNS FROM guild_streamer_auto_track');
    const columnNames = columns.map(c => c.Field);

    if (columnNames.includes('updated_at')) {
        await pool.execute('ALTER TABLE guild_streamer_auto_track DROP COLUMN updated_at');
    }

    if (columnNames.includes('auto_id')) {
        // Drop unique key, drop auto_id, restore composite PK
        await pool.execute('ALTER TABLE guild_streamer_auto_track DROP INDEX uq_guild_role').catch(() => {});
        await pool.execute('ALTER TABLE guild_streamer_auto_track DROP COLUMN auto_id');
        await pool.execute('ALTER TABLE guild_streamer_auto_track MODIFY COLUMN role_id VARCHAR(20) NOT NULL');
        await pool.execute('ALTER TABLE guild_streamer_auto_track ADD PRIMARY KEY (guild_id, role_id)').catch(() => {});
    }
}
