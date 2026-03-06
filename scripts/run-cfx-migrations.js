#!/usr/bin/env node
/**
 * Run CertiFried Extension migrations (029, 030)
 */

import pool from '../utils/db.js';
import logger from '../utils/logger.js';

async function runCFXMigrations() {
    const connection = await pool.getConnection();

    try {
        logger.info('[CFX Migrations] Starting...');

        // Ensure migrations table exists
        await connection.execute(`
            CREATE TABLE IF NOT EXISTS migrations (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(255) NOT NULL UNIQUE,
                executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
        `);

        // Check what's already run
        const [executedRows] = await connection.execute('SELECT name FROM migrations');
        const executed = new Set(executedRows.map(r => r.name));

        // Run 029 if needed
        if (!executed.has('029_certifried_extension')) {
            logger.info('[CFX Migrations] Running 029_certifried_extension...');
            const m029 = await import('../migrations/029_certifried_extension.js');
            await m029.up(connection);
            await connection.execute('INSERT INTO migrations (name) VALUES (?)', ['029_certifried_extension']);
            logger.info('[CFX Migrations] ✓ 029_certifried_extension completed');
        } else {
            logger.info('[CFX Migrations] Skipping 029_certifried_extension (already run)');
        }

        // Run 030 if needed
        if (!executed.has('030_cfx_bot_integration')) {
            logger.info('[CFX Migrations] Running 030_cfx_bot_integration...');
            const m030 = await import('../migrations/030_cfx_bot_integration.js');
            await m030.up(connection);
            await connection.execute('INSERT INTO migrations (name) VALUES (?)', ['030_cfx_bot_integration']);
            logger.info('[CFX Migrations] ✓ 030_cfx_bot_integration completed');
        } else {
            logger.info('[CFX Migrations] Skipping 030_cfx_bot_integration (already run)');
        }

        logger.info('[CFX Migrations] All CFX migrations complete!');

    } catch (error) {
        logger.error('[CFX Migrations] Failed', { error: error.message, stack: error.stack });
        throw error;
    } finally {
        connection.release();
        await pool.end();
    }
}

runCFXMigrations().catch(e => {
    console.error(e);
    process.exit(1);
});
