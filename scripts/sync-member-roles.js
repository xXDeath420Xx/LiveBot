/**
 * Sync a member's roles based on their reactions
 */

import { Client, GatewayIntentBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';
const BOT_ID = '1452969400620683276';
const MEMBER_ID = '842881525434679336';

async function main() {
    console.log('🔧 Syncing member roles based on reactions...\n');

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
        const member = await guild.members.fetch(MEMBER_ID);

        console.log(`👤 Member: ${member.user.tag}`);
        console.log(`   Current roles: ${member.roles.cache.filter(r => r.id !== guild.id).map(r => r.name).join(', ')}`);

        // Get all panels for this guild
        const [panels] = await pool.execute(
            'SELECT * FROM reaction_role_panels WHERE guild_id = ?',
            [GUILD_ID]
        );

        console.log(`\n📋 Found ${panels.length} reaction role panels`);

        for (const panel of panels) {
            console.log(`\n   Panel: ${panel.panel_name}`);

            // Get the message
            const channel = guild.channels.cache.get(panel.channel_id);
            if (!channel) {
                console.log('      ❌ Channel not found');
                continue;
            }

            let message;
            try {
                message = await channel.messages.fetch(panel.message_id);
            } catch (e) {
                console.log(`      ❌ Message not found: ${e.message}`);
                continue;
            }

            // Get mappings for this panel
            const [mappings] = await pool.execute(
                'SELECT * FROM reaction_role_mappings WHERE panel_id = ?',
                [panel.id]
            );

            // Check each reaction
            for (const mapping of mappings) {
                const role = guild.roles.cache.get(mapping.role_id);
                if (!role) {
                    console.log(`      ⚠️  Role ${mapping.role_id} not found`);
                    continue;
                }

                // Check if member has reacted with this emoji
                const reaction = message.reactions.cache.get(mapping.emoji_id);
                if (!reaction) {
                    continue;
                }

                const users = await reaction.users.fetch();
                const hasReacted = users.has(MEMBER_ID);
                const hasRole = member.roles.cache.has(mapping.role_id);

                if (hasReacted && !hasRole) {
                    console.log(`      ⚡ ${mapping.emoji_id}: Has reacted but missing role -> Adding ${role.name}`);
                    await member.roles.add(role, 'Role sync based on reaction');
                } else if (hasReacted && hasRole) {
                    console.log(`      ✅ ${mapping.emoji_id}: Has reacted and has ${role.name}`);
                } else if (!hasReacted && hasRole) {
                    console.log(`      ⚠️  ${mapping.emoji_id}: Has ${role.name} but hasn't reacted (keeping role)`);
                }
            }
        }

        // Show final roles
        const updatedMember = await guild.members.fetch(MEMBER_ID);
        console.log(`\n📋 Final roles: ${updatedMember.roles.cache.filter(r => r.id !== guild.id).map(r => r.name).join(', ')}`);

        console.log('\n🎉 Done!');
        client.destroy();
        process.exit(0);
    });

    await client.login(decryptedToken);
}

main().catch(console.error);
