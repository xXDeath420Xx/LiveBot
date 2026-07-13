import 'dotenv/config';
import pool from '../utils/db.js';

try {
    // Remove cdn.discordapp.com from phishing domains
    const [result] = await pool.execute(
        "DELETE FROM phishing_domains WHERE domain = 'cdn.discordapp.com'"
    );
    console.log('Removed cdn.discordapp.com from phishing_domains:', result.affectedRows, 'row(s)');

    // Also remove other legit Discord domains that shouldn't be flagged
    const safeDomains = [
        'discord.com',
        'discordapp.com',
        'cdn.discordapp.com',
        'cdn.discord.com',
        'media.discordapp.net',
        'images-ext-1.discordapp.net',
        'images-ext-2.discordapp.net',
    ];

    for (const domain of safeDomains) {
        const [r] = await pool.execute('DELETE FROM phishing_domains WHERE domain = ?', [domain]);
        if (r.affectedRows > 0) {
            console.log(`  Also removed: ${domain}`);
        }
    }

    console.log('\nDone.');
} catch (err) {
    console.error('Error:', err.message);
}
process.exit(0);
