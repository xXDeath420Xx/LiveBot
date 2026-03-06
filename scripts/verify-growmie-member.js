/**
 * Manually verify a member and fix reaction state
 */

import { Client, GatewayIntentBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';
const BOT_ID = '1452969400620683276';
const MEMBER_ID = '842881525434679336';
const RULES_CHANNEL_ID = '1452977946217418826';
const VERIFY_MESSAGE_ID = '1452982511327121531';

async function main() {
    console.log('🔧 Verifying member and checking reactions...\n');

    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [BOT_ID]
    );

    const decryptedToken = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessageReactions
        ]
    });

    client.once('ready', async () => {
        console.log(`✅ Logged in as ${client.user.tag}\n`);

        const guild = client.guilds.cache.get(GUILD_ID);

        // Get the member
        const member = await guild.members.fetch(MEMBER_ID);
        console.log(`👤 Member: ${member.user.tag}`);
        console.log(`   Current roles: ${member.roles.cache.map(r => r.name).join(', ')}`);

        // Get verified role
        const verifiedRole = guild.roles.cache.find(r => r.name.includes('Verified Growmie'));
        console.log(`\n🌱 Verified role: ${verifiedRole?.name}`);

        // Check if member has verified role
        if (member.roles.cache.has(verifiedRole?.id)) {
            console.log('✅ Member already has Verified Growmie role');
        } else {
            // Add the role
            await member.roles.add(verifiedRole, 'Manual verification');
            console.log('✅ Added Verified Growmie role to member');
        }

        // Check the verification message and its reactions
        const rulesChannel = guild.channels.cache.get(RULES_CHANNEL_ID);
        const verifyMessage = await rulesChannel.messages.fetch(VERIFY_MESSAGE_ID);

        console.log(`\n📬 Verify message reactions:`);
        for (const [emoji, reaction] of verifyMessage.reactions.cache) {
            const users = await reaction.users.fetch();
            console.log(`   ${emoji}: ${reaction.count} reactions`);
            console.log(`      Users: ${users.map(u => u.tag).join(', ')}`);

            // Check if our member reacted
            if (users.has(MEMBER_ID)) {
                console.log(`      ✅ Member ${member.user.tag} has reacted with ${emoji}`);
            }
        }

        // Check all panels and their current state
        console.log('\n📋 Database panels for this guild:');
        const [panels] = await pool.execute(
            'SELECT * FROM reaction_role_panels WHERE guild_id = ?',
            [GUILD_ID]
        );
        for (const panel of panels) {
            console.log(`   Panel ${panel.id}: ${panel.panel_name}`);
            console.log(`      Channel: ${panel.channel_id}`);
            console.log(`      Message: ${panel.message_id}`);
            console.log(`      Type: ${panel.interaction_type}`);

            const [mappings] = await pool.execute(
                'SELECT * FROM reaction_role_mappings WHERE panel_id = ?',
                [panel.id]
            );
            console.log(`      Mappings:`);
            for (const m of mappings) {
                const role = guild.roles.cache.get(m.role_id);
                console.log(`         ${m.emoji_id} -> ${role?.name || 'NOT FOUND'}`);
            }
        }

        console.log('\n🎉 Done!');
        client.destroy();
        process.exit(0);
    });

    await client.login(decryptedToken);
}

main().catch(console.error);
