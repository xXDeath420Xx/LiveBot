import 'dotenv/config';
import pool from '../utils/db.js';

try {
    // Check if discord CDN domains are in the phishing list
    const [rows] = await pool.execute(
        "SELECT domain FROM phishing_domains WHERE domain LIKE '%discordapp%' OR domain LIKE '%discord.com%' OR domain LIKE '%discord%'"
    );
    console.log('=== Discord-related domains in phishing_domains ===');
    console.log('Count:', rows.length);
    for (const r of rows) {
        console.log('  ' + r.domain);
    }

    // Check what was detected for these messages
    const [detections] = await pool.execute(
        "SELECT * FROM phishing_detections WHERE guild_id = '1404239197987930114' ORDER BY id DESC LIMIT 10"
    );
    console.log('\n=== Recent detections for this guild ===');
    for (const d of detections) {
        console.log(`  [${d.id}] user:${d.user_id} domain:${d.matched_domain} url:${(d.matched_url || '').substring(0, 80)} action:${d.action_taken}`);
    }
} catch (err) {
    console.error('Error:', err.message);
}
process.exit(0);
