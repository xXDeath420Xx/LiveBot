import { Client, GatewayIntentBits } from 'discord.js';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config({ path: '/root/discord_bots/CertiFriedUtility/.env' });

const GUILD_ID = '985116833193553930';
const ROLE_ID = '1447019344281342153';

// Colors for gradient: #1591fd to #baddff
const PRIMARY_COLOR = 0x1591fd;
const SECONDARY_COLOR = 0xbaddff;

// Encrypted token from database
const encryptedTokenJson = '{"iv":"cf1d943b9e34ac44a7ec817e2b85f4c6","encryptedData":"03e8c76b9374dabe2d4d2ce60d4913e6105ee4db7b69e0762b989aa89d0cd888220a8469e7128530c35fdbb333c65bf2da4b3540446496bb5cbd7cbe268b8fbf4c00fd3355f913fd","authTag":"9a830598dbbefe3baa65834c6320c9f6"}';

// Decrypt function for GCM mode
function decrypt(encryptedJson) {
    const key = process.env.BOT_ENCRYPTION_KEY;
    if (!key) throw new Error('BOT_ENCRYPTION_KEY not set');

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
    console.log('Decrypting bot token...');
    const token = decrypt(encryptedTokenJson);
    console.log('Token decrypted successfully');

    // Connect to Discord
    const client = new Client({
        intents: [GatewayIntentBits.Guilds]
    });

    client.once('ready', async () => {
        console.log(`Logged in as ${client.user.tag}`);

        try {
            const guild = await client.guilds.fetch(GUILD_ID);
            console.log(`Found guild: ${guild.name}`);

            const role = await guild.roles.fetch(ROLE_ID);
            if (!role) {
                console.log('Role not found');
                client.destroy();
                process.exit(1);
            }

            console.log(`Found role: ${role.name}`);
            console.log(`Current color: ${role.hexColor}`);

            // Set gradient colors using the REST API directly
            // The colors object is the newer API format for gradients
            const response = await client.rest.patch(`/guilds/${GUILD_ID}/roles/${ROLE_ID}`, {
                body: {
                    colors: {
                        primary_color: PRIMARY_COLOR,
                        secondary_color: SECONDARY_COLOR
                    }
                }
            });

            console.log('Role updated with gradient colors!');
            console.log(`Primary: #${PRIMARY_COLOR.toString(16).padStart(6, '0')}`);
            console.log(`Secondary: #${SECONDARY_COLOR.toString(16).padStart(6, '0')}`);

        } catch (err) {
            console.error('Error:', err.message);
            if (err.rawError) console.error('Raw error:', JSON.stringify(err.rawError, null, 2));
            if (err.code) console.error('Error code:', err.code);
        }

        client.destroy();
        process.exit(0);
    });

    client.login(token);
}

main().catch(console.error);
