import pool from '../utils/db.js';

async function checkTables() {
    try {
        // Check if grow_journals table exists
        const [journalTables] = await pool.execute(
            "SHOW TABLES LIKE 'grow_journals'"
        );

        if (journalTables.length === 0) {
            console.log('Creating grow_journals table...');
            await pool.execute(`
                CREATE TABLE grow_journals (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    guild_id VARCHAR(32) NOT NULL,
                    user_id VARCHAR(32) NOT NULL,
                    title VARCHAR(256) NOT NULL,
                    strain_name VARCHAR(128),
                    breeder VARCHAR(128),
                    grow_medium ENUM('soil', 'coco', 'hydro', 'dwc', 'aero', 'other') DEFAULT 'soil',
                    grow_type ENUM('indoor', 'outdoor', 'greenhouse') DEFAULT 'indoor',
                    light_type VARCHAR(128),
                    pot_size VARCHAR(64),
                    nutrients VARCHAR(256),
                    start_date DATE,
                    current_stage ENUM('germination', 'seedling', 'vegetative', 'transition', 'flowering', 'harvest', 'cure', 'complete') DEFAULT 'germination',
                    is_public BOOLEAN DEFAULT TRUE,
                    is_active BOOLEAN DEFAULT TRUE,
                    cover_image_url VARCHAR(512),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_guild_user (guild_id, user_id),
                    INDEX idx_active (is_active)
                )
            `);
            console.log('grow_journals table created!');
        } else {
            console.log('grow_journals table already exists');
        }

        // Check if journal_entries table exists
        const [entryTables] = await pool.execute(
            "SHOW TABLES LIKE 'journal_entries'"
        );

        if (entryTables.length === 0) {
            console.log('Creating journal_entries table...');
            await pool.execute(`
                CREATE TABLE journal_entries (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    journal_id INT NOT NULL,
                    day_number INT,
                    entry_date DATE NOT NULL,
                    stage ENUM('germination', 'seedling', 'vegetative', 'transition', 'flowering', 'harvest', 'cure') DEFAULT 'vegetative',
                    title VARCHAR(256),
                    notes TEXT,
                    temp_high DECIMAL(5,2),
                    temp_low DECIMAL(5,2),
                    humidity_high DECIMAL(5,2),
                    humidity_low DECIMAL(5,2),
                    vpd DECIMAL(4,2),
                    ph_value DECIMAL(3,1),
                    ec_value DECIMAL(4,2),
                    ppm_value INT,
                    water_amount VARCHAR(64),
                    nutrients_used TEXT,
                    height_cm DECIMAL(6,2),
                    training_done VARCHAR(256),
                    issues TEXT,
                    photo_urls JSON,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_journal (journal_id),
                    INDEX idx_date (entry_date),
                    FOREIGN KEY (journal_id) REFERENCES grow_journals(id) ON DELETE CASCADE
                )
            `);
            console.log('journal_entries table created!');
        } else {
            console.log('journal_entries table already exists');
        }

        // Check if grow_milestones table exists
        const [milestoneTables] = await pool.execute(
            "SHOW TABLES LIKE 'grow_milestones'"
        );

        if (milestoneTables.length === 0) {
            console.log('Creating grow_milestones table...');
            await pool.execute(`
                CREATE TABLE grow_milestones (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    journal_id INT NOT NULL,
                    milestone_type ENUM('germination', 'first_leaves', 'transplant', 'topped', 'lst_started', 'flip_to_flower', 'first_pistils', 'trichomes_cloudy', 'harvest', 'dry_complete', 'cure_start') NOT NULL,
                    milestone_date DATE NOT NULL,
                    notes VARCHAR(512),
                    photo_url VARCHAR(512),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_journal (journal_id),
                    FOREIGN KEY (journal_id) REFERENCES grow_journals(id) ON DELETE CASCADE
                )
            `);
            console.log('grow_milestones table created!');
        } else {
            console.log('grow_milestones table already exists');
        }

        console.log('All journal tables verified!');
        process.exit(0);
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

checkTables();
