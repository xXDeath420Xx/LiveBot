/**
 * Create Bot Developer role and assign to user
 * One-time script
 */

import dotenv from 'dotenv';
dotenv.config({ path: '/home/death/CertiFriedUtility/.env' });

const GUILD_ID = '1307517872301670480';
const USER_ID = '365905620060340224';
const BOT_TOKEN = process.env.DISCORD_TOKEN;
const API_BASE = 'https://discord.com/api/v10';

async function fetchDiscord(endpoint, method = 'GET', body = null) {
    const options = {
        method,
        headers: {
            'Authorization': `Bot ${BOT_TOKEN}`,
            'Content-Type': 'application/json'
        }
    };

    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(`${API_BASE}${endpoint}`, options);

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Discord API error ${response.status}: ${error}`);
    }

    if (response.status === 204) {
        return null;
    }

    return response.json();
}

async function main() {
    console.log('Creating Bot Developer role...');

    // Create the role
    // Permission 0x8 = Administrator
    const role = await fetchDiscord(`/guilds/${GUILD_ID}/roles`, 'POST', {
        name: 'Bot Developer',
        permissions: '8',  // Administrator
        color: 0,          // No color
        hoist: false,      // Don't show separately in online list
        mentionable: false
    });

    console.log(`Created role: ${role.name} (${role.id})`);

    // Assign the role to the user
    console.log(`Assigning role to user ${USER_ID}...`);

    await fetchDiscord(`/guilds/${GUILD_ID}/members/${USER_ID}/roles/${role.id}`, 'PUT');

    console.log('Done! Role created and assigned successfully.');
    console.log(`Role ID: ${role.id}`);
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
