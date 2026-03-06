/**
 * Setup script: Enable phishing detection for YYZ Studio
 * Guild: 961514092848382043
 * Alert channel: #all-logs (1345462542713094185)
 * Action: mute (30 min) — deletes message + mutes sender
 *
 * Usage: node scripts/setup-yyz-phishing.js
 */
import dotenv from 'dotenv';
dotenv.config();

import pool from '../utils/db.js';

const GUILD_ID = '961514092848382043';
const ALERT_CHANNEL = '1345462542713094185';

const WHITELIST = JSON.stringify([
    'discord.gg',
    'discord.com',
    'store.steampowered.com',
    'steamcommunity.com',
    'youtube.com',
    'twitch.tv',
    'twitter.com',
    'x.com',
    'github.com',
    'havendock.com'
]);

async function setup() {
    try {
        await pool.execute(
            `INSERT INTO phishing_config (guild_id, enabled, action, mute_duration_minutes, alert_channel_id, whitelist_domains, log_detections)
             VALUES (?, 1, 'mute', 30, ?, ?, 1)
             ON DUPLICATE KEY UPDATE enabled = 1, action = 'mute', mute_duration_minutes = 30, alert_channel_id = VALUES(alert_channel_id), whitelist_domains = VALUES(whitelist_domains)`,
            [GUILD_ID, ALERT_CHANNEL, WHITELIST]
        );

        console.log(`Phishing detection enabled for YYZ Studio (${GUILD_ID})`);
        console.log(`  Action: mute (30 min)`);
        console.log(`  Alert channel: ${ALERT_CHANNEL}`);
        console.log(`  Whitelist: ${WHITELIST}`);
    } catch (error) {
        console.error('Setup failed:', error.message);
    } finally {
        await pool.end();
    }
}

setup();
