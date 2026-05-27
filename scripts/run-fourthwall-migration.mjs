#!/usr/bin/env node
/**
 * One-shot runner for migration 112 (Fourthwall integration).
 *
 * Idempotent — every statement is CREATE TABLE IF NOT EXISTS.
 * Uses the same mysql2/promise pool the bot uses; DDL does not block reads
 * or writes on unrelated tables, and the bot does not query fourthwall_*
 * tables until /fourthwall setup is invoked.
 *
 * Safe to run while PM2 bot is active. Exits non-zero on failure.
 */
import pool from '../utils/db.js';
import { up } from '../migrations/112_fourthwall_integration.js';

try {
    await up(pool);
    const [rows] = await pool.execute("SHOW TABLES LIKE 'fourthwall_%'");
    console.log(`OK: ${rows.length} fourthwall_* table(s) present`);
    for (const r of rows) console.log(` - ${Object.values(r)[0]}`);
    process.exit(0);
} catch (err) {
    console.error('FAIL:', err.message);
    process.exit(1);
}
