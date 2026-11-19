/**
 * Wave 396 — Digimon trading and market, care counted per stage, and the server switches for both.
 *
 *   user_digimon.stage_battles  battles at the current stage; the care lean compares it with trainings
 *   user_digimon.locked         'market' while listed, so a listed Digimon cannot be traded or released
 *   digimon_trades              a proposed swap between two tamers, settled by buttons
 *   digimon_market              listings for bits
 */
export async function up(pool) {
    const [cols] = await pool.query('SHOW COLUMNS FROM user_digimon');
    const have = new Set(cols.map(c => c.Field));
    if (!have.has('stage_battles')) await pool.query('ALTER TABLE user_digimon ADD COLUMN stage_battles INT NOT NULL DEFAULT 0 AFTER wins');
    if (!have.has('locked')) await pool.query('ALTER TABLE user_digimon ADD COLUMN locked VARCHAR(12) NULL AFTER is_partner');

    const [scols] = await pool.query('SHOW COLUMNS FROM digimon_settings');
    const shave = new Set(scols.map(c => c.Field));
    for (const [name, type] of [
        ['trades_enabled', 'TINYINT(1) NOT NULL DEFAULT 1'],
        ['market_enabled', 'TINYINT(1) NOT NULL DEFAULT 1'],
        ['market_fee_percent', 'INT NOT NULL DEFAULT 5'],
    ]) if (!shave.has(name)) await pool.query(`ALTER TABLE digimon_settings ADD COLUMN ${name} ${type}`);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS digimon_trades (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            from_user VARCHAR(20) NOT NULL,
            to_user VARCHAR(20) NOT NULL,
            give_id INT NOT NULL,
            want_id INT NULL,
            ask_bits INT NOT NULL DEFAULT 0,
            status VARCHAR(12) NOT NULL DEFAULT 'open',
            channel_id VARCHAR(20) NULL,
            message_id VARCHAR(20) NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME NOT NULL,
            finished_at DATETIME NULL,
            KEY idx_guild_status (guild_id, status),
            KEY idx_from (guild_id, from_user),
            KEY idx_to (guild_id, to_user)
        )`);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS digimon_market (
            id INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(20) NOT NULL,
            seller_id VARCHAR(20) NOT NULL,
            user_digimon_id INT NOT NULL,
            digimon_id INT NOT NULL,
            level INT NOT NULL,
            price INT NOT NULL,
            fee INT NOT NULL DEFAULT 0,
            status VARCHAR(12) NOT NULL DEFAULT 'open',
            buyer_id VARCHAR(20) NULL,
            listed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            closed_at DATETIME NULL,
            KEY idx_guild_status (guild_id, status, listed_at),
            KEY idx_seller (guild_id, seller_id),
            KEY idx_ud (user_digimon_id)
        )`);
    // /privacy delete anonymises these (core/privacy-tables.js ANONYMISE_PLAN), so they must allow NULL.
    await pool.query('ALTER TABLE digimon_trades MODIFY from_user VARCHAR(20) NULL, MODIFY to_user VARCHAR(20) NULL');
    await pool.query('ALTER TABLE digimon_market MODIFY seller_id VARCHAR(20) NULL');
}

export async function down(pool) {
    await pool.query('DROP TABLE IF EXISTS digimon_market');
    await pool.query('DROP TABLE IF EXISTS digimon_trades');
    for (const c of ['trades_enabled', 'market_enabled', 'market_fee_percent']) await pool.query(`ALTER TABLE digimon_settings DROP COLUMN ${c}`);
    for (const c of ['stage_battles', 'locked']) await pool.query(`ALTER TABLE user_digimon DROP COLUMN ${c}`);
}
