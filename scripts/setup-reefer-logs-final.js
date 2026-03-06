/**
 * ReeferRealm Logs - Final Routing Fix
 *
 * Routes remaining 9 NULL event types to proper channels,
 * updates moderation_config, and verifies complete routing.
 */

import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const GUILD_ID = '985116833193553930';

const CHANNELS = {
    'member-logs':     '1467848922083889152',
    'moderation-logs': '1467848923015024711',
    'voice-logs':      '1467848923992297574',
    'message-logs':    '1467848925431074937',
    'server-logs':     '1467848926400086058',
    'role-logs':       '1467848927175905353',
    'command-logs':    '1467848928731861013'
};

// Route the 9 previously-NULL event types to their proper channels
const NULL_ROUTES = {
    'giveaway':      CHANNELS['server-logs'],
    'join-gate':     CHANNELS['member-logs'],
    'moderation':    CHANNELS['moderation-logs'],
    'poll':          CHANNELS['server-logs'],
    'starboard':     CHANNELS['message-logs'],
    'sticky-roles':  CHANNELS['role-logs'],
    'system':        CHANNELS['server-logs'],
    'temp-channels': CHANNELS['voice-logs'],
    'xp':            CHANNELS['member-logs']
};

async function run() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        charset: 'utf8mb4',
        waitForConnections: true,
        connectionLimit: 5,
        timezone: '+00:00'
    });

    console.log('\n' + '='.repeat(70));
    console.log('  ReeferRealm Logs - Final Routing Fix');
    console.log('='.repeat(70) + '\n');

    // ── Fix 1: Route 9 NULL event types ──────────────────────────────────
    console.log('[Fix 1] Routing 9 event types with NULL channels...\n');

    for (const [eventType, channelId] of Object.entries(NULL_ROUTES)) {
        const chName = Object.entries(CHANNELS).find(([, v]) => v === channelId)?.[0] || channelId;
        await pool.execute(
            'UPDATE log_event_config SET log_channel_id = ? WHERE guild_id = ? AND event_type = ?',
            [channelId, GUILD_ID, eventType]
        );
        console.log(`  ${eventType} -> #${chName}`);
    }

    // ── Fix 2: Add to enabled_events ─────────────────────────────────────
    console.log('\n[Fix 2] Updating enabled_events...\n');

    const [cfg] = await pool.execute(
        'SELECT enabled_events FROM logging_config WHERE guild_id = ?',
        [GUILD_ID]
    );
    let events = JSON.parse(cfg[0].enabled_events || '[]');
    let added = 0;
    for (const evt of Object.keys(NULL_ROUTES)) {
        if (!events.includes(evt)) {
            events.push(evt);
            added++;
        }
    }
    await pool.execute(
        'UPDATE logging_config SET enabled_events = ? WHERE guild_id = ?',
        [JSON.stringify(events), GUILD_ID]
    );
    console.log(`  Added ${added} new event types to enabled_events`);
    console.log(`  Total enabled: ${events.length}`);

    // ── Fix 3: Update moderation_config ──────────────────────────────────
    console.log('\n[Fix 3] Updating moderation_config...\n');

    await pool.execute(
        'UPDATE moderation_config SET mod_log_channel_id = ? WHERE guild_id = ?',
        [CHANNELS['moderation-logs'], GUILD_ID]
    );
    console.log(`  mod_log_channel_id -> #moderation-logs (${CHANNELS['moderation-logs']})`);

    // ── Verification ─────────────────────────────────────────────────────
    console.log('\n[Verify] Checking for any remaining NULL routes...\n');

    const [nullCheck] = await pool.execute(
        'SELECT event_type FROM log_event_config WHERE guild_id = ? AND log_channel_id IS NULL',
        [GUILD_ID]
    );
    if (nullCheck.length === 0) {
        console.log('  All event types have proper channel routing.');
    } else {
        console.log(`  WARNING: ${nullCheck.length} events still have NULL channels:`);
        nullCheck.forEach(r => console.log(`    - ${r.event_type}`));
    }

    // ── Full Routing Map ─────────────────────────────────────────────────
    const [all] = await pool.execute(
        'SELECT event_type, log_channel_id FROM log_event_config WHERE guild_id = ? ORDER BY log_channel_id, event_type',
        [GUILD_ID]
    );

    const chMap = {};
    for (const [name, id] of Object.entries(CHANNELS)) chMap[id] = name;

    const grouped = {};
    for (const r of all) {
        const name = chMap[r.log_channel_id] || r.log_channel_id;
        if (!grouped[name]) grouped[name] = [];
        grouped[name].push(r.event_type);
    }

    console.log('\n' + '='.repeat(70));
    console.log('  COMPLETE ROUTING MAP');
    console.log('='.repeat(70) + '\n');

    for (const [ch, evts] of Object.entries(grouped).sort()) {
        console.log(`  #${ch} (${evts.length} events):`);
        console.log(`    ${evts.join(', ')}`);
        console.log('');
    }

    const [modCfg] = await pool.execute(
        'SELECT mod_log_channel_id FROM moderation_config WHERE guild_id = ?',
        [GUILD_ID]
    );
    console.log(`  moderation_config.mod_log_channel_id: #moderation-logs (${modCfg[0].mod_log_channel_id})`);
    console.log('');

    await pool.end();
}

run().catch(err => {
    console.error('FATAL:', err);
    process.exit(1);
});
