import dotenv from 'dotenv';
dotenv.config();
import pool from '../utils/db.js';
const V = '902393911958470717';
const MOD_LOG = '903151629770039306';
try {
    // 1. Add anti-spam automod rule (same as ReeferRealm: 3 msgs in 5s = delete)
    await pool.execute(
        `INSERT INTO automod_rules (guild_id, filter_type, is_enabled, config, action)
         VALUES (?, 'anti_spam', 1, ?, 'delete')
         ON DUPLICATE KEY UPDATE is_enabled = 1, config = VALUES(config)`,
        [V, JSON.stringify({ message_limit: 3, time_period: 5 })]
    );
    console.log('automod_rules: anti_spam rule created');

    // 2. Add adaptive spam config (same as ReeferRealm but alert to mod-logs)
    await pool.execute(
        `INSERT INTO adaptive_spam_config (guild_id, enabled, cross_channel_threshold, cross_channel_timeframe_minutes, deviation_multiplier, new_account_multiplier_7d, new_account_multiplier_24h, action, alert_channel_id)
         VALUES (?, 1, 3, 1, 2.00, 1.50, 2.00, 'mute', ?)
         ON DUPLICATE KEY UPDATE enabled = 1, alert_channel_id = VALUES(alert_channel_id)`,
        [V, MOD_LOG]
    );
    console.log('adaptive_spam_config: created with mute action, alerts to #mod-logs');

    // Verify
    const [rules] = await pool.execute('SELECT * FROM automod_rules WHERE guild_id = ?', [V]);
    console.log('Verified rules:', rules.length);
    const [spam] = await pool.execute('SELECT * FROM adaptive_spam_config WHERE guild_id = ?', [V]);
    console.log('Verified adaptive spam:', spam.length > 0 ? 'enabled' : 'MISSING');
} catch(e) { console.error('ERR:', e.message); }
await pool.end();
process.exit(0);
