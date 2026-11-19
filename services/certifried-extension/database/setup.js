/**
 * CertiFried Extension Database Setup
 * Creates tables and seeds initial data
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pool from '../../../utils/db.js';
import logger from '../../../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function runSQLFile(filename) {
    const filePath = path.join(__dirname, filename);
    const sql = fs.readFileSync(filePath, 'utf8');

    // Split by semicolon but handle multi-line statements
    const statements = sql
        .replace(/--.*$/gm, '') // Remove comments
        .split(/;\s*$/m)
        .map(s => s.trim())
        .filter(s => s.length > 0);

    logger.debug(`[CFX Setup] Running ${filename} (${statements.length} statements)`);

    for (const statement of statements) {
        if (statement.length > 0) {
            try {
                await pool.execute(statement);
            } catch (error) {
                // Ignore common idempotency errors
                const ignorableCodes = [
                    'ER_TABLE_EXISTS_ERROR',  // Table already exists
                    'ER_DUP_ENTRY',           // Duplicate entry
                    'ER_DUP_FIELDNAME',       // Duplicate column name
                    'ER_DUP_KEYNAME',         // Duplicate key name
                    'ER_CANT_DROP_FIELD_OR_KEY', // Column doesn't exist (for DROP)
                    'ER_BAD_FIELD_ERROR'      // Unknown column (for UPDATE referencing old column)
                ];

                if (ignorableCodes.includes(error.code)) {
                    logger.debug(`[CFX Setup] Skipping (${error.code}): ${error.message.substring(0, 50)}`);
                    continue;
                }
                logger.error(`[CFX Setup] Error executing statement: ${error.message}`, {
                    statement: statement.substring(0, 100),
                    code: error.code
                });
                throw error;
            }
        }
    }

    logger.debug(`[CFX Setup] Completed ${filename}`);
}

async function runMigrations() {
    const migrationsDir = path.join(__dirname, 'migrations');

    // Check if migrations directory exists
    if (!fs.existsSync(migrationsDir)) {
        logger.debug('[CFX Setup] No migrations directory found');
        return;
    }

    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort(); // Alphabetical order

    logger.debug(`[CFX Setup] Found ${files.length} migration files`);

    for (const file of files) {
        try {
            await runSQLFile(`migrations/${file}`);
        } catch (error) {
            // Log but continue - migrations may have already been applied
            logger.warn(`[CFX Setup] Migration ${file} had errors (may already be applied): ${error.message}`);
        }
    }
}

async function setup() {
    try {
        logger.debug('[CFX Setup] Starting database setup...');

        // Test connection
        const conn = await pool.getConnection();
        await conn.ping();
        conn.release();
        logger.debug('[CFX Setup] Database connection confirmed');

        // Check if cfx_players table exists (indicating DB is already set up)
        const [existingTables] = await pool.execute("SHOW TABLES LIKE 'cfx_players'");

        if (existingTables.length > 0) {
            logger.debug('[CFX Setup] Database already initialized, running migrations only...');
        } else {
            // Run schema only for fresh installs
            await runSQLFile('schema.sql');
            // Run seed data
            await runSQLFile('seed.sql');
        }

        // Run any migrations (always run - they're idempotent)
        await runMigrations();

        // Verify tables exist
        const [tables] = await pool.execute(
            "SHOW TABLES LIKE 'cfx_%'"
        );
        logger.debug(`[CFX Setup] Created ${tables.length} cfx_* tables`);

        // Verify strains
        const [strains] = await pool.execute('SELECT COUNT(*) as count FROM cfx_strains');
        logger.debug(`[CFX Setup] Seeded ${strains[0].count} strains`);

        // Verify skills
        const [skills] = await pool.execute('SELECT COUNT(*) as count FROM cfx_skill_nodes');
        logger.debug(`[CFX Setup] Seeded ${skills[0].count} skill nodes`);

        // Verify quests
        const [quests] = await pool.execute('SELECT COUNT(*) as count FROM cfx_quest_definitions');
        logger.debug(`[CFX Setup] Seeded ${quests[0].count} quest definitions`);

        logger.debug('[CFX Setup] Database setup complete!');

    } catch (error) {
        logger.error('[CFX Setup] Setup failed:', error);
        throw error;
    } finally {
        await pool.end();
    }
}

// Run setup
setup()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('Setup failed:', error.message);
        process.exit(1);
    });
