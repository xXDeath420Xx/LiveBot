import { Client, GatewayIntentBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '985116833193553930';
const BOT_APP_ID = '1438889625388060723';
const SOURCE_ROLES = ['1063272196878901390', '1347151146875097161']; // MODERATORS roles
const TARGET_ROLES = ['1447009043053940856', '1447009011302928404']; // Head Moderator roles

async function main() {
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE client_id = ?', [BOT_APP_ID]);
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

    client.once('ready', async () => {
        console.log('Logged in as ' + client.user.tag);
        try {
            const guild = await client.guilds.fetch(GUILD_ID);
            const channels = await guild.channels.fetch();

            let updatedCount = 0;

            for (const [channelId, channel] of channels) {
                if (!channel.permissionOverwrites) continue;

                for (const sourceRoleId of SOURCE_ROLES) {
                    const sourceOverwrite = channel.permissionOverwrites.cache.get(sourceRoleId);
                    if (!sourceOverwrite) continue;

                    // Copy permissions to target roles
                    for (const targetRoleId of TARGET_ROLES) {
                        const existingOverwrite = channel.permissionOverwrites.cache.get(targetRoleId);

                        // Merge permissions (combine allow/deny with existing)
                        const newAllow = existingOverwrite
                            ? existingOverwrite.allow.bitfield | sourceOverwrite.allow.bitfield
                            : sourceOverwrite.allow.bitfield;
                        const newDeny = existingOverwrite
                            ? existingOverwrite.deny.bitfield | sourceOverwrite.deny.bitfield
                            : sourceOverwrite.deny.bitfield;

                        await channel.permissionOverwrites.edit(targetRoleId, {
                            allow: BigInt(newAllow),
                            deny: BigInt(newDeny)
                        });
                        console.log(`  Updated #${channel.name} for role ${targetRoleId}`);
                        updatedCount++;
                    }
                }
            }

            console.log('\n✅ Updated ' + updatedCount + ' permission overwrites');
        } catch (e) {
            console.error('Error:', e.message);
        }
        client.destroy();
        process.exit(0);
    });

    await client.login(token);
}

main().catch(console.error);
