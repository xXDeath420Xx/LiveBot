import 'dotenv/config';
import pool from '../utils/db.js';

try {
    // Check orientation config
    const [orient] = await pool.execute(
        'SELECT * FROM orientation_config WHERE guild_id = ?', ['902393911958470717']);
    console.log('=== Orientation Config ===');
    console.log(orient[0] || 'NO ORIENTATION CONFIG');

    // Check if there's any record of messages posted to that specific channel
    const [msgs] = await pool.execute(
        'SELECT * FROM orientation_config WHERE channel_id = ?', ['1476147991122284711']);
    console.log('\n=== Orientation for channel 1476147991122284711 ===');
    console.log(msgs[0] || 'NONE');
} catch (err) {
    console.error('Error:', err.message);
}
process.exit(0);
