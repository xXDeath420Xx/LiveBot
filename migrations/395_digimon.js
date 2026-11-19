/**
 * Wave 395 — Digimon: a raise-and-evolve partner game with spawns, battles and a daily
 * "Which Digital Monster are you today?" quiz. Off until a server turns it on (digimon_settings.enabled).
 * The species list comes from digi-api.com through scripts/import-digimon.mjs.
 */
export async function up(pool) {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS digimon_data (
            id INT PRIMARY KEY,
            name VARCHAR(120) NOT NULL,
            level VARCHAR(16) NOT NULL,
            levels JSON NOT NULL,
            attributes JSON NOT NULL,
            fields JSON NOT NULL,
            types JSON NOT NULL,
            skills JSON NOT NULL,
            x_antibody TINYINT(1) NOT NULL DEFAULT 0,
            description TEXT NULL,
            image_url VARCHAR(300) NULL,
            release_year VARCHAR(8) NULL,
            imported_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            KEY idx_level (level),
            KEY idx_name (name)
        )`);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS digimon_evolutions (
            from_id INT NOT NULL,
            to_id INT NOT NULL,
            PRIMARY KEY (from_id, to_id),
            KEY idx_to (to_id)
        )`);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS digimon_settings (
            guild_id VARCHAR(20) PRIMARY KEY,
            enabled TINYINT(1) NOT NULL DEFAULT 0,
            spawns_enabled TINYINT(1) NOT NULL DEFAULT 1,
            spawn_channel_id VARCHAR(20) NULL,
            spawn_chance INT NOT NULL DEFAULT 4,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )`);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_digimon (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id VARCHAR(20) NOT NULL,
            guild_id VARCHAR(20) NOT NULL,
            digimon_id INT NOT NULL,
            nickname VARCHAR(32) NULL,
            level INT NOT NULL DEFAULT 1,
            xp INT NOT NULL DEFAULT 0,
            iv_hp TINYINT NOT NULL DEFAULT 0,
            iv_atk TINYINT NOT NULL DEFAULT 0,
            iv_def TINYINT NOT NULL DEFAULT 0,
            iv_spd TINYINT NOT NULL DEFAULT 0,
            is_partner TINYINT(1) NOT NULL DEFAULT 0,
            hunger TINYINT NOT NULL DEFAULT 4,
            strength TINYINT NOT NULL DEFAULT 2,
            care_mistakes INT NOT NULL DEFAULT 0,
            trainings INT NOT NULL DEFAULT 0,
            battles INT NOT NULL DEFAULT 0,
            wins INT NOT NULL DEFAULT 0,
            hunger_at BIGINT NULL,
            strength_at BIGINT NULL,
            last_trained_at BIGINT NULL,
            obtained_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            KEY idx_owner (guild_id, user_id),
            KEY idx_partner (guild_id, user_id, is_partner)
        )`);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS user_digimon_dex (
            user_id VARCHAR(20) NOT NULL,
            guild_id VARCHAR(20) NOT NULL,
            digimon_id INT NOT NULL,
            times INT NOT NULL DEFAULT 1,
            first_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id, user_id, digimon_id)
        )`);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS digimon_spawns (
            guild_id VARCHAR(20) NOT NULL,
            channel_id VARCHAR(20) NOT NULL,
            digimon_id INT NOT NULL,
            message_id VARCHAR(20) NULL,
            spawned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (guild_id, channel_id)
        )`);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS digimon_inventory (
            user_id VARCHAR(20) NOT NULL,
            guild_id VARCHAR(20) NOT NULL,
            bits INT NOT NULL DEFAULT 0,
            meat INT NOT NULL DEFAULT 0,
            last_daily_at BIGINT NULL,
            last_explore_at BIGINT NULL,
            PRIMARY KEY (guild_id, user_id)
        )`);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS digimon_quiz_results (
            user_id VARCHAR(20) NOT NULL,
            day DATE NOT NULL,
            guild_id VARCHAR(20) NOT NULL,
            digimon_id INT NOT NULL,
            attribute VARCHAR(16) NOT NULL,
            field VARCHAR(32) NOT NULL,
            level VARCHAR(16) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, day),
            KEY idx_guild_day (guild_id, day)
        )`);
}

export async function down(pool) {
    for (const t of ['digimon_quiz_results', 'digimon_inventory', 'digimon_spawns', 'user_digimon_dex',
        'user_digimon', 'digimon_settings', 'digimon_evolutions', 'digimon_data']) {
        await pool.query(`DROP TABLE IF EXISTS ${t}`);
    }
}
