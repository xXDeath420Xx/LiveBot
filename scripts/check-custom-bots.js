/**
 * Check custom bots configuration
 */

import pool from '../utils/db.js';

async function check() {
    try {
        const [bots] = await pool.execute('SELECT * FROM custom_bots');
        console.log('Custom bots:');
        console.table(bots);

        // Check if the Growmie bot exists
        const growmieBot = bots.find(b => b.bot_id === '1452969400620683276');
        if (growmieBot) {
            console.log('\nGrowmie bot found:', growmieBot);
        } else {
            console.log('\nGrowmie bot (1452969400620683276) NOT FOUND');
        }

        process.exit(0);
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
}

check();
