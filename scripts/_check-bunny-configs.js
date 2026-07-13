import dotenv from 'dotenv';
dotenv.config({ path: '/home/death/CertiFriedUtility/.env' });
import pool from '../utils/db.js';

const G = '869577842088878130';

const [ws] = await pool.execute('SELECT * FROM welcome_settings WHERE guild_id = ?', [G]);
console.log('welcome_settings:', ws[0] || 'NOT CONFIGURED');

const [lc] = await pool.execute('SELECT * FROM level_config WHERE guild_id = ?', [G]);
console.log('level_config:', lc[0] || 'NOT CONFIGURED');

const [lr] = await pool.execute('SELECT * FROM level_role_rewards WHERE guild_id = ?', [G]);
console.log('level_role_rewards:', lr.length, 'rows');

const [tc] = await pool.execute('SELECT * FROM ticket_config WHERE guild_id = ?', [G]);
console.log('ticket_config:', tc[0] || 'NOT CONFIGURED');

const [sc] = await pool.execute('SELECT * FROM starboard_config WHERE guild_id = ?', [G]);
console.log('starboard_config:', sc[0] || 'NOT CONFIGURED');

// Check log event routes breakdown
const [events] = await pool.execute('SELECT event_type, log_channel_id FROM log_event_config WHERE guild_id = ? ORDER BY event_type', [G]);
console.log('\nLog event routes (' + events.length + '):');
const channels = {};
events.forEach(e => {
    if (!channels[e.log_channel_id]) channels[e.log_channel_id] = [];
    channels[e.log_channel_id].push(e.event_type);
});
for (const [ch, evts] of Object.entries(channels)) {
    console.log('  Channel ' + ch + ': ' + evts.join(', '));
}

await pool.end();
