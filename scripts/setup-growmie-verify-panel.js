/**
 * Set up verification reaction role panel for Growmie server
 */

import { Client, GatewayIntentBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';
const BOT_ID = '1452969400620683276';
const RULES_CHANNEL_ID = '1452977946217418826';

async function main() {
    console.log('🔧 Setting up verification reaction role panel...\n');

    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [BOT_ID]
    );

    const decryptedToken = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers]
    });

    client.once('ready', async () => {
        console.log(`✅ Logged in as ${client.user.tag}\n`);

        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) {
            console.error('❌ Guild not found!');
            process.exit(1);
        }

        // Find the rules channel
        const rulesChannel = guild.channels.cache.get(RULES_CHANNEL_ID);
        if (!rulesChannel) {
            console.error('❌ Rules channel not found!');
            process.exit(1);
        }
        console.log(`📜 Rules channel: ${rulesChannel.name}`);

        // Find the Verified Growmie role
        const verifiedRole = guild.roles.cache.find(r => r.name.includes('Verified Growmie'));
        if (!verifiedRole) {
            console.error('❌ Verified Growmie role not found!');
            console.log('Available roles:');
            guild.roles.cache.forEach(r => console.log(`  - ${r.name} (${r.id})`));
            process.exit(1);
        }
        console.log(`✅ Verified role: ${verifiedRole.name} (${verifiedRole.id})`);

        // Fetch messages in rules channel to find the verify message
        const messages = await rulesChannel.messages.fetch({ limit: 10 });
        console.log(`\n📬 Found ${messages.size} messages in rules channel:`);

        let verifyMessage = null;
        for (const [id, msg] of messages) {
            console.log(`  - ${id}: ${msg.content.substring(0, 50)}...`);
            // Look for the message with the verification instructions
            if (msg.content.includes('✅') || msg.content.includes('verify') || msg.content.toLowerCase().includes('react')) {
                verifyMessage = msg;
                console.log(`    ^ This looks like the verify message!`);
            }
        }

        if (!verifyMessage) {
            console.error('\n❌ Could not find verification message!');
            console.log('Looking for embeds...');

            for (const [id, msg] of messages) {
                if (msg.embeds.length > 0) {
                    for (const embed of msg.embeds) {
                        console.log(`  Embed in ${id}: ${embed.title || embed.description?.substring(0, 50)}`);
                        if (embed.description?.includes('✅') || embed.description?.toLowerCase().includes('verify')) {
                            verifyMessage = msg;
                            console.log(`    ^ This is the verify message!`);
                        }
                    }
                }
            }
        }

        if (!verifyMessage) {
            console.error('\n❌ Still could not find verification message!');
            process.exit(1);
        }

        console.log(`\n📌 Using message ID: ${verifyMessage.id}`);

        // Check if panel already exists
        const [existingPanels] = await pool.execute(
            'SELECT * FROM reaction_role_panels WHERE message_id = ?',
            [verifyMessage.id]
        );

        if (existingPanels.length > 0) {
            console.log('⚠️  Panel already exists for this message. Updating...');
            await pool.execute('DELETE FROM reaction_role_mappings WHERE panel_id = ?', [existingPanels[0].id]);
            await pool.execute('DELETE FROM reaction_role_panels WHERE id = ?', [existingPanels[0].id]);
        }

        // Create the reaction role panel
        const [panelResult] = await pool.execute(`
            INSERT INTO reaction_role_panels
            (guild_id, channel_id, message_id, panel_name, panel_mode, interaction_type)
            VALUES (?, ?, ?, ?, ?, ?)
        `, [GUILD_ID, RULES_CHANNEL_ID, verifyMessage.id, 'Verification', 'normal', 'reaction']);

        const panelId = panelResult.insertId;
        console.log(`✅ Created panel with ID: ${panelId}`);

        // Add the role mapping
        await pool.execute(`
            INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id)
            VALUES (?, ?, ?)
        `, [panelId, verifiedRole.id, '✅']);

        console.log(`✅ Added mapping: ✅ -> ${verifiedRole.name}`);

        // Add the reaction to the message if not already there
        const hasReaction = verifyMessage.reactions.cache.has('✅');
        if (!hasReaction) {
            await verifyMessage.react('✅');
            console.log('✅ Added ✅ reaction to message');
        } else {
            console.log('ℹ️  ✅ reaction already exists on message');
        }

        // Verify setup
        console.log('\n📊 Verification complete. Checking setup...');

        const [panels] = await pool.execute(
            'SELECT * FROM reaction_role_panels WHERE guild_id = ?',
            [GUILD_ID]
        );
        console.log(`Found ${panels.length} panel(s) for this guild`);

        const [mappings] = await pool.execute(
            'SELECT * FROM reaction_role_mappings WHERE panel_id = ?',
            [panelId]
        );
        console.log(`Found ${mappings.length} mapping(s) for verify panel`);

        console.log('\n🎉 Done! Users can now react with ✅ to get the Verified Growmie role.');

        client.destroy();
        process.exit(0);
    });

    await client.login(decryptedToken);
}

main().catch(console.error);
