/**
 * Setup missing game features - market, rotation, upgrades, territories
 */

import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
    const pool = await mysql.createPool({
        host: process.env.DB_HOST || 'localhost',
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'certifried'
    });

    console.log('=== FIXING MARKET SYSTEM ===');

    // Add missing columns to cfx_strains
    try {
        await pool.execute('ALTER TABLE cfx_strains ADD COLUMN demand_weight DECIMAL(5,2) DEFAULT 1.0');
        console.log('Added demand_weight to cfx_strains');
    } catch(e) {
        if (!e.message.includes('Duplicate')) throw e;
        else console.log('demand_weight exists');
    }

    // Add missing columns to cfx_market_prices
    const marketCols = [
        ['previous_price', 'DECIMAL(10,2)'],
        ['price_change_pct', 'DECIMAL(8,3) DEFAULT 0'],
        ['demand_score', 'DECIMAL(8,3) DEFAULT 100'],
        ['supply_volume', 'INT DEFAULT 0'],
        ['volume_24h', 'INT DEFAULT 0'],
        ['high_24h', 'DECIMAL(10,2)'],
        ['low_24h', 'DECIMAL(10,2)'],
        ['trend', "ENUM('rising','falling','stable') DEFAULT 'stable'"],
        ['volatility', 'DECIMAL(5,3) DEFAULT 0.05']
    ];

    for (const [col, type] of marketCols) {
        try {
            await pool.execute(`ALTER TABLE cfx_market_prices ADD COLUMN ${col} ${type}`);
            console.log('Added', col, 'to cfx_market_prices');
        } catch(e) {
            if (!e.message.includes('Duplicate')) throw e;
        }
    }

    // Initialize market prices for all strains that don't have them
    await pool.execute(`
        INSERT IGNORE INTO cfx_market_prices (strain_id, current_price, previous_price, demand_score, high_24h, low_24h, npc_base_price)
        SELECT id, base_price, base_price, 100, FLOOR(base_price * 1.1), FLOOR(base_price * 0.9), base_price
        FROM cfx_strains
    `);
    console.log('Initialized market prices');

    // Set random demand weights for strains (some more popular than others)
    await pool.execute(`
        UPDATE cfx_strains SET demand_weight =
            CASE rarity
                WHEN 'common' THEN 0.8 + (RAND() * 0.4)
                WHEN 'uncommon' THEN 0.9 + (RAND() * 0.4)
                WHEN 'rare' THEN 1.0 + (RAND() * 0.5)
                WHEN 'epic' THEN 1.2 + (RAND() * 0.6)
                WHEN 'legendary' THEN 1.5 + (RAND() * 0.8)
                ELSE 1.0
            END
    `);
    console.log('Set demand weights by rarity');

    console.log('\n=== CREATING SHOP ROTATION SYSTEM ===');

    // Create shop rotation table
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS cfx_shop_rotation (
            id INT AUTO_INCREMENT PRIMARY KEY,
            rotation_type ENUM('daily_deal', 'weekly_special', 'flash_sale', 'seasonal') NOT NULL,
            strain_id INT UNSIGNED NOT NULL,
            discount_percent DECIMAL(5,2) DEFAULT 0,
            bonus_seeds INT DEFAULT 0,
            starts_at DATETIME NOT NULL,
            ends_at DATETIME NOT NULL,
            max_purchases INT DEFAULT NULL,
            current_purchases INT DEFAULT 0,
            is_active BOOLEAN DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (strain_id) REFERENCES cfx_strains(id),
            INDEX idx_active_rotation (is_active, starts_at, ends_at)
        )
    `);
    console.log('Created cfx_shop_rotation table');

    // Create initial daily deals
    const [strains] = await pool.execute('SELECT id, name, rarity FROM cfx_strains ORDER BY RAND()');
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24*60*60*1000);
    const nextWeek = new Date(now.getTime() + 7*24*60*60*1000);

    // Clear old rotations and add new ones
    await pool.execute('DELETE FROM cfx_shop_rotation WHERE ends_at < NOW()');

    if (strains.length > 0) {
        await pool.execute(`
            INSERT INTO cfx_shop_rotation (rotation_type, strain_id, discount_percent, bonus_seeds, starts_at, ends_at)
            VALUES ('daily_deal', ?, 20, 1, ?, ?)
        `, [strains[0].id, now, tomorrow]);
        console.log('Created daily deal:', strains[0].name);
    }

    if (strains.length > 1) {
        await pool.execute(`
            INSERT INTO cfx_shop_rotation (rotation_type, strain_id, discount_percent, bonus_seeds, starts_at, ends_at)
            VALUES ('weekly_special', ?, 30, 2, ?, ?)
        `, [strains[1].id, now, nextWeek]);
        console.log('Created weekly special:', strains[1].name);
    }

    console.log('\n=== ADDING MORE UPGRADES ===');

    // Create facility upgrade types table if missing
    await pool.execute(`
        CREATE TABLE IF NOT EXISTS cfx_facility_upgrade_types (
            id INT AUTO_INCREMENT PRIMARY KEY,
            upgrade_key VARCHAR(50) UNIQUE NOT NULL,
            name VARCHAR(100) NOT NULL,
            description TEXT,
            effect_type VARCHAR(50) NOT NULL,
            effect_per_level DECIMAL(8,4) NOT NULL,
            base_cost INT NOT NULL,
            cost_multiplier DECIMAL(5,2) DEFAULT 1.5,
            max_level INT DEFAULT 10,
            unlock_research_key VARCHAR(50) DEFAULT NULL,
            is_active BOOLEAN DEFAULT TRUE
        )
    `);

    // Add facility upgrades
    const facilityUpgrades = [
        ['genetics_lab', 'Genetics Lab', 'Unlocks advanced breeding options', 'breeding_bonus', 0.05, 25000, 2.0, 5],
        ['drying_room', 'Drying Room', 'Increases quality of harvested product', 'quality_bonus', 0.03, 15000, 1.8, 10],
        ['packaging_station', 'Packaging Station', 'Increases sale prices', 'sale_bonus', 0.04, 20000, 1.9, 8],
        ['security_cameras', 'Security Cameras', 'Reduces raid chance', 'raid_reduction', 0.08, 30000, 2.2, 5],
        ['climate_control', 'Climate Control', 'Reduces plant wither time', 'wither_resist', 0.10, 18000, 1.7, 6],
        ['hydroponic_system', 'Hydroponic System', 'Increases yield', 'yield_bonus', 0.05, 35000, 2.1, 5],
        ['led_panels', 'LED Grow Panels', 'Increases growth speed', 'speed_bonus', 0.04, 22000, 1.85, 8],
        ['co2_injector', 'CO2 Injection System', 'Boosts all plant stats', 'all_bonus', 0.02, 50000, 2.5, 3]
    ];

    for (const [key, name, desc, effect, value, cost, mult, maxLvl] of facilityUpgrades) {
        await pool.execute(`
            INSERT INTO cfx_facility_upgrade_types (upgrade_key, name, description, effect_type, effect_per_level, base_cost, cost_multiplier, max_level)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description)
        `, [key, name, desc, effect, value, cost, mult, maxLvl]);
    }
    console.log('Added', facilityUpgrades.length, 'facility upgrade types');

    console.log('\n=== ADDING CARTEL UPGRADES ===');

    // Add more cartel upgrades
    const cartelUpgrades = [
        ['war_bunker', 'War Bunker', 'Increases defense during territory wars', 'war_defense', 0.10, 100000, 2.0, 5],
        ['supply_network', 'Supply Network', 'Reduces cost of all purchases for members', 'purchase_discount', 0.03, 75000, 1.8, 8],
        ['intel_network', 'Intelligence Network', 'Shows enemy cartel info during wars', 'war_intel', 1, 50000, 1.5, 3],
        ['training_facility', 'Training Facility', 'Increases XP gain for all members', 'xp_bonus', 0.05, 80000, 1.9, 6],
        ['smuggling_routes', 'Smuggling Routes', 'Reduces heat gain from sales', 'heat_reduction', 0.08, 90000, 2.1, 5],
        ['territory_flags', 'Territory Flags', 'Increases control point gain', 'control_bonus', 0.10, 120000, 2.2, 4],
        ['cartel_vault', 'Cartel Vault', 'Increases max bank storage', 'bank_limit', 100000, 60000, 1.6, 10],
        ['recruitment_office', 'Recruitment Office', 'Increases max member slots', 'member_slots', 5, 40000, 1.7, 6]
    ];

    for (const [key, name, desc, effect, value, cost, mult, maxLvl] of cartelUpgrades) {
        await pool.execute(`
            INSERT INTO cfx_cartel_upgrades (upgrade_key, name, description, effect_type, effect_value_per_level, base_cost, cost_multiplier, max_level)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description)
        `, [key, name, desc, effect, value, cost, mult, maxLvl]);
    }
    console.log('Added', cartelUpgrades.length, 'cartel upgrades');

    console.log('\n=== SETTING UP TERRITORIES ===');

    // Check and update territories
    const [[{tc}]] = await pool.execute('SELECT COUNT(*) as tc FROM cfx_territories');

    if (tc < 8) {
        // Add more territories
        const territories = [
            ['Downtown Market', 'downtown', 'Prime location for selling to high-end clients', 'sale_bonus', 0.08, 1000],
            ['Warehouse District', 'industrial', 'Massive storage capacity available', 'storage_bonus', 100, 800],
            ['University Area', 'suburbs', 'Endless customer base of students', 'customer_bonus', 0.10, 600],
            ['Harbor Port', 'industrial', 'International trade connections', 'trade_bonus', 0.12, 1200],
            ['North Suburbs', 'suburbs', 'Low police presence', 'heat_reduction', 0.15, 500],
            ['Nightclub District', 'downtown', 'Premium prices after dark', 'premium_bonus', 0.10, 900],
            ['Tech Park', 'suburbs', 'Access to research facilities', 'research_bonus', 0.08, 700],
            ['Hidden Valley', 'rural', 'Perfect growing conditions', 'grow_speed', 0.05, 400],
            ['Industrial Zone', 'industrial', 'Large-scale operations', 'yield_bonus', 0.08, 850],
            ['Financial District', 'downtown', 'Money laundering opportunities', 'cash_bonus', 0.12, 1500]
        ];

        for (const [name, region, desc, bonus, value, points] of territories) {
            await pool.execute(`
                INSERT INTO cfx_territories (name, region, description, bonus_type, bonus_value, control_points_required)
                VALUES (?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE description = VALUES(description)
            `, [name, region, desc, bonus, value, points]);
        }
        console.log('Added territories');
    }

    const [[{tc2}]] = await pool.execute('SELECT COUNT(*) as tc2 FROM cfx_territories');
    console.log('Total territories:', tc2);

    const [[{cuc}]] = await pool.execute('SELECT COUNT(*) as cuc FROM cfx_cartel_upgrades');
    console.log('Total cartel upgrades:', cuc);

    await pool.end();
    console.log('\n=== DATABASE SETUP COMPLETE ===');
}

run().catch(e => { console.error(e); process.exit(1); });
