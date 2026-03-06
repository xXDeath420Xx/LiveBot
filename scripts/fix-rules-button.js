import dotenv from 'dotenv';
dotenv.config();

import { Client, GatewayIntentBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '902393911958470717';
const BOT_ID = '1476040458680406214';
const RULES_MSG_ID = '1476141871217770518';
const RULES_CHANNEL = '903149773987667979';
const VERIFIED_ROLE = '1476143521365884984';

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
    const botMember = guild.members.cache.get(client.user.id);

    console.log('\n=== BOT PERMISSIONS ===');
    console.log('ManageRoles:', botMember.permissions.has('ManageRoles'));
    console.log('ManageGuild:', botMember.permissions.has('ManageGuild'));
    console.log('Administrator:', botMember.permissions.has('Administrator'));
    console.log('Bot highest role position:', botMember.roles.highest.position, botMember.roles.highest.name);

    const verifiedRole = guild.roles.cache.get(VERIFIED_ROLE);
    if (verifiedRole) {
        console.log('\n=== VERIFIED ROLE ===');
        console.log('Name:', verifiedRole.name);
        console.log('Position:', verifiedRole.position);
        console.log('Bot can manage it:', botMember.roles.highest.position > verifiedRole.position);
    } else {
        console.log('\nVerified role NOT FOUND in cache!');
    }

    // Check if the rules message still exists and has the button
    const channel = guild.channels.cache.get(RULES_CHANNEL);
    if (channel) {
        try {
            const msg = await channel.messages.fetch(RULES_MSG_ID);
            console.log('\n=== RULES MESSAGE ===');
            console.log('Found:', !!msg);
            console.log('Components:', msg.components.length);
            if (msg.components.length > 0) {
                for (const row of msg.components) {
                    for (const comp of row.components) {
                        console.log('  Button customId:', comp.customId, 'label:', comp.label);
                    }
                }
            }
            console.log('Author:', msg.author.tag, msg.author.id);
            console.log('Author is this bot:', msg.author.id === client.user.id);
        } catch (e) {
            console.log('Could not fetch rules message:', e.message);
        }
    }

    // Check reactionRoleManager
    console.log('\n=== REACTION ROLE MANAGER ===');
    console.log('Has manager:', !!client.reactionRoleManager);

    client.destroy();
    await pool.end();
    process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
