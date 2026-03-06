/**
 * Kick Dyno, Lurker.tv, and Streamcord from VognarFam guild
 */
import dotenv from 'dotenv';
dotenv.config();

import { Client, GatewayIntentBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '902393911958470717';
const BOT_ID = '1476040458680406214';

const BOTS_TO_KICK = ['dyno', 'lurker', 'streamcord', 'livebot'];

async function run() {
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]
    });

    await client.login(token);
    await new Promise(r => client.once('ready', r));
    console.log(`Logged in as ${client.user.tag}`);

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) { console.error('Guild not found'); process.exit(1); }

    // Fetch all members to find the bots
    console.log('\nFetching guild members...');
    await guild.members.fetch();

    const botMembers = guild.members.cache.filter(m => m.user.bot);
    console.log(`Found ${botMembers.size} bots in the server:\n`);

    for (const [, member] of botMembers) {
        const nameLC = member.user.username.toLowerCase();
        const match = BOTS_TO_KICK.some(b => nameLC.includes(b));
        const tag = match ? ' <<< TARGET' : '';
        console.log(`  ${member.user.username}#${member.user.discriminator} (${member.id})${tag}`);
    }

    // Kick the targets
    console.log('\n=== KICKING BOTS ===');
    for (const [, member] of botMembers) {
        const nameLC = member.user.username.toLowerCase();
        const isTarget = BOTS_TO_KICK.some(b => nameLC.includes(b));
        if (!isTarget) continue;

        try {
            await member.kick('Replaced by VognarFam custom bot - all features migrated');
            console.log(`  KICKED: ${member.user.username} (${member.id})`);
        } catch (e) {
            console.log(`  FAILED: ${member.user.username} (${member.id}) - ${e.message}`);
        }
    }

    console.log('\nDone.');
    client.destroy();
    await pool.end();
    process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
