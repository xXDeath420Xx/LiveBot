import { Client, GatewayIntentBits } from 'discord.js';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config({ path: '/root/discord_bots/CertiFriedUtility/.env' });

const GUILD_ID = '985116833193553930';

// Role pairs: [permissions role, display role]
const ROLE_PAIRS = [
    ['1347134428664827966', '1408002415034110033'],
    ['1447009043053940856', '1447009011302928404'],
    ['1063272196878901390', '1347151146875097161']
];

// Encrypted token from database
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

            for (const [permRoleId, displayRoleId] of ROLE_PAIRS) {
                const permRole = await guild.roles.fetch(permRoleId);
                const displayRole = await guild.roles.fetch(displayRoleId);

                console.log(`--- Pair ---`);
                console.log(`Permissions Role: ${permRole?.name || 'NOT FOUND'} (${permRoleId})`);
                if (permRole) {
                    console.log(`  Color: ${permRole.hexColor}`);
                    console.log(`  Position: ${permRole.position}`);
                    console.log(`  Hoist (displayed separately): ${permRole.hoist}`);
                }
                console.log(`Display Role: ${displayRole?.name || 'NOT FOUND'} (${displayRoleId})`);
                if (displayRole) {
                    console.log(`  Color: ${displayRole.hexColor}`);
                    console.log(`  Position: ${displayRole.position}`);
                    console.log(`  Hoist (displayed separately): ${displayRole.hoist}`);
                }
                console.log('');
            }

        } catch (err) {
            console.error('Error:', err.message);
        }

        client.destroy();
        process.exit(0);
    });

    client.login(token);
}

main().catch(console.error);
