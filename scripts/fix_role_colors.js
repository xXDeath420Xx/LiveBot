import { Client, GatewayIntentBits } from 'discord.js';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config({ path: '/root/discord_bots/CertiFriedUtility/.env' });

const GUILD_ID = '985116833193553930';

// Permission roles that should have NO color (so display roles show instead)
const PERMISSION_ROLES_TO_CLEAR = [
    '1347134428664827966',  // Administration
    '1447009043053940856',  // Head Moderator (permissions)
    '1063272196878901390'   // MODERATORS (permissions)
];

const encryptedTokenJson = '{"iv":"cf1d943b9e34ac44a7ec817e2b85f4c6","encryptedData":"03e8c76b9374dabe2d4d2ce60d4913e6105ee4db7b69e0762b989aa89d0cd888220a8469e7128530c35fdbb333c65bf2da4b3540446496bb5cbd7cbe268b8fbf4c00fd3355f913fd","authTag":"9a830598dbbefe3baa65834c6320c9f6"}';

function decrypt(encryptedJson) {
    const key = process.env.BOT_ENCRYPTION_KEY;
    const data = JSON.parse(encryptedJson);
    const iv = Buffer.from(data.iv, 'hex');
    const encryptedData = Buffer.from(data.encryptedData, 'hex');
    const authTag = Buffer.from(data.authTag, 'hex');
    const keyBuffer = Buffer.from(key, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedData);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
}

async function main() {
    const token = decrypt(encryptedTokenJson);

    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

    client.once('ready', async () => {
        console.log(`Logged in as ${client.user.tag}\n`);

        try {
            const guild = await client.guilds.fetch(GUILD_ID);
            console.log(`Guild: ${guild.name}\n`);

            for (const roleId of PERMISSION_ROLES_TO_CLEAR) {
                const role = await guild.roles.fetch(roleId);

                if (!role) {
                    console.log(`Role ${roleId} not found, skipping`);
                    continue;
                }

                console.log(`${role.name}: ${role.hexColor} -> clearing color...`);

                // Set color to 0 (default/no color) and clear any gradient
                await client.rest.patch(`/guilds/${GUILD_ID}/roles/${roleId}`, {
                    body: {
                        color: 0,
                        colors: null  // Remove any gradient
                    }
                });

                console.log(`  Done - color cleared`);
            }

            console.log('\nAll permission roles now have no color.');
            console.log('Users will display the color of their display roles instead.');

        } catch (err) {
            console.error('Error:', err.message);
            if (err.rawError) console.error('Raw error:', JSON.stringify(err.rawError, null, 2));
        }

        client.destroy();
        process.exit(0);
    });

    client.login(token);
}

main().catch(console.error);
