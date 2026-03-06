/**
 * Fix Growmie Reaction Roles - Save the role selection panel to database
 */

import { Client, GatewayIntentBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import 'dotenv/config';

const GUILD_ID = '1452972683867459657';
const BOT_ID = '1452969400620683276';

async function main() {
    console.log('🔧 Fixing Growmie Reaction Roles...\n');

    // Get bot token
    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [BOT_ID]
    );

    if (bots.length === 0) {
        console.error('❌ Bot not found!');
        process.exit(1);
    }

    const decryptedToken = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
    });

    client.once('ready', async () => {
        console.log(`✅ Logged in as ${client.user.tag}`);

        const guild = client.guilds.cache.get(GUILD_ID);
        if (!guild) {
            console.error('❌ Guild not found!');
            process.exit(1);
        }

        // Find the introductions channel with the role selection message
        const introChannel = guild.channels.cache.find(c => c.name.includes('introductions'));
        if (!introChannel) {
            console.error('❌ Introductions channel not found!');
            process.exit(1);
        }

        console.log(`📍 Found channel: ${introChannel.name}`);

        // Get the roles
        const roleMap = {
            '🏠': guild.roles.cache.find(r => r.name === '🏠 Indoor Grower'),
            '☀️': guild.roles.cache.find(r => r.name === '☀️ Outdoor Grower'),
            '💧': guild.roles.cache.find(r => r.name === '💧 Hydro Enthusiast'),
            '🌍': guild.roles.cache.find(r => r.name === '🌍 Soil Squad'),
            '🔬': guild.roles.cache.find(r => r.name === '🔬 Nutrient Nerd'),
            '💡': guild.roles.cache.find(r => r.name === '💡 Light Expert'),
            '🌡️': guild.roles.cache.find(r => r.name === '🌡️ Climate Controller'),
            '📸': guild.roles.cache.find(r => r.name === '📸 Grow Journalist'),
            '📢': guild.roles.cache.find(r => r.name === '📢 Announcements'),
            '🎉': guild.roles.cache.find(r => r.name === '🎉 Events'),
        };

        // Find the role selection message (look for the embed with "Choose Your Growing Style")
        const messages = await introChannel.messages.fetch({ limit: 20 });
        const roleMessage = messages.find(m =>
            m.embeds.length > 0 &&
            m.embeds[0].title?.includes('Growing Style')
        );

        if (!roleMessage) {
            console.error('❌ Role selection message not found!');
            process.exit(1);
        }

        console.log(`📝 Found role selection message: ${roleMessage.id}`);

        // Save the panel to database (using correct column names from migration)
        try {
            const [panelResult] = await pool.execute(
                `INSERT INTO reaction_role_panels
                (guild_id, channel_id, message_id, panel_name, panel_mode, interaction_type)
                VALUES (?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    panel_name = VALUES(panel_name),
                    panel_mode = VALUES(panel_mode)`,
                [
                    GUILD_ID,
                    introChannel.id,
                    roleMessage.id,
                    'Growing Style Roles',
                    'normal',
                    'reaction'
                ]
            );

            // Get the actual panel ID
            const [panels] = await pool.execute(
                'SELECT id FROM reaction_role_panels WHERE message_id = ?',
                [roleMessage.id]
            );
            const actualPanelId = panels[0]?.id;

            if (actualPanelId) {
                // Clear existing mappings
                await pool.execute('DELETE FROM reaction_role_mappings WHERE panel_id = ?', [actualPanelId]);

                // Save role mappings
                for (const [emoji, role] of Object.entries(roleMap)) {
                    if (role) {
                        await pool.execute(
                            `INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id)
                            VALUES (?, ?, ?)`,
                            [actualPanelId, role.id, emoji]
                        );
                        console.log(`   ✅ Mapped ${emoji} -> ${role.name}`);
                    }
                }

                console.log('\n✅ Reaction role panel saved successfully!');
                console.log(`   Panel ID: ${actualPanelId}`);
            }
        } catch (error) {
            console.error('❌ Error saving panel:', error.message);
            console.error(error);
        }

        client.destroy();
        process.exit(0);
    });

    await client.login(decryptedToken);
}

main().catch(console.error);
