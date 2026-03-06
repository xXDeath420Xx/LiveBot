import dotenv from 'dotenv';
dotenv.config();

import mysql from 'mysql2/promise';

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

async function check() {
    const guildId = '1404239197987930114';

    console.log('Checking RPG characters for guild:', guildId);
    console.log('---');

    // Check all characters in this guild
    const [chars] = await pool.execute(
        'SELECT user_id, guild_id, character_name, class, level FROM dnd_characters WHERE guild_id = ?',
        [guildId]
    );

    console.log('Characters found with exact guild_id match:', chars.length);
    if (chars.length > 0) {
        console.log(chars);
    }

    // Check if guild_id might be stored differently
    const [allChars] = await pool.execute(
        'SELECT user_id, guild_id, character_name, class, level FROM dnd_characters LIMIT 20'
    );

    console.log('\n--- Sample of all characters in DB ---');
    console.log('Total sample:', allChars.length);
    for (const c of allChars.slice(0, 10)) {
        console.log(`  ${c.character_name} (${c.class} L${c.level}) - guild: ${c.guild_id}`);
    }

    // Check unique guild_ids
    const [guilds] = await pool.execute(
        'SELECT DISTINCT guild_id, COUNT(*) as count FROM dnd_characters GROUP BY guild_id'
    );
    console.log('\n--- Unique guild_ids with character counts ---');
    console.log(guilds);

    await pool.end();
}

check().catch(console.error);
