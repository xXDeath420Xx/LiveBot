/**
 * One-off script to onboard the Mee6-replacement bot into CertiFried's multi-bot system.
 *
 * Bot ID:  1345684217438273577
 * Guild:   961514092848382043
 *
 * Steps:
 *   1. Test token by logging in briefly
 *   2. Encrypt token with AES-256-GCM
 *   3. Insert into custom_bots table
 *   4. Insert into guild_bot_mapping table
 *
 * Usage: node scripts/onboard-mee6-replacement.js
 */
import dotenv from 'dotenv';
dotenv.config();

import { Client, GatewayIntentBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const BOT_TOKEN = process.env.YYZ_BOT_TOKEN; // was hardcoded — use env var
const BOT_ID = '1345684217438273577';
const GUILD_ID = '961514092848382043';
const OWNER_ID = process.env.BOT_OWNER_ID;

async function onboard() {
    if (!OWNER_ID) {
        console.error('BOT_OWNER_ID not set in .env');
        process.exit(1);
    }

    // Step 1: Test the token
    console.log('=== STEP 1: Testing bot token ===');
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });

    let botName;
    try {
        await client.login(BOT_TOKEN);
        await new Promise(resolve => client.once('ready', resolve));
        botName = client.user.username;
        console.log(`Token valid! Bot: ${client.user.tag} (${client.user.id})`);

        if (client.user.id !== BOT_ID) {
            console.error(`WARNING: Bot ID mismatch! Expected ${BOT_ID}, got ${client.user.id}`);
        }

        client.destroy();
    } catch (err) {
        console.error('Token test FAILED:', err.message);
        process.exit(1);
    }

    // Step 2: Encrypt the token
    console.log('\n=== STEP 2: Encrypting token ===');
    const encryptedToken = encryption.encrypt(BOT_TOKEN);
    const tokenJson = JSON.stringify(encryptedToken);
    console.log('Token encrypted successfully (AES-256-GCM)');

    // Step 3: Insert into custom_bots
    console.log('\n=== STEP 3: Inserting into custom_bots ===');
    try {
        await pool.execute(`
            INSERT INTO custom_bots (bot_id, bot_name, bot_token, client_id, owner_user_id, enabled, approved)
            VALUES (?, ?, ?, ?, ?, 1, 1)
            ON DUPLICATE KEY UPDATE
                bot_name = VALUES(bot_name),
                bot_token = VALUES(bot_token),
                enabled = 1,
                approved = 1
        `, [BOT_ID, botName, tokenJson, BOT_ID, OWNER_ID]);
        console.log(`Inserted bot "${botName}" (${BOT_ID}) — enabled & approved`);
    } catch (err) {
        console.error('DB insert failed:', err.message);
        process.exit(1);
    }

    // Step 4: Insert into guild_bot_mapping
    console.log('\n=== STEP 4: Mapping bot to guild ===');
    try {
        await pool.execute(`
            INSERT INTO guild_bot_mapping (guild_id, bot_id, assigned_by)
            VALUES (?, ?, ?)
            ON DUPLICATE KEY UPDATE bot_id = VALUES(bot_id), assigned_by = VALUES(assigned_by)
        `, [GUILD_ID, BOT_ID, OWNER_ID]);
        console.log(`Guild ${GUILD_ID} -> Bot ${BOT_ID}`);
    } catch (err) {
        console.error('Guild mapping failed:', err.message);
        process.exit(1);
    }

    // Done
    console.log('\n========================================');
    console.log('ONBOARDING COMPLETE');
    console.log('========================================');
    console.log(`Bot: ${botName} (${BOT_ID})`);
    console.log(`Guild: ${GUILD_ID}`);
    console.log(`Owner: ${OWNER_ID}`);
    console.log('');
    console.log('Next steps:');
    console.log('  node scripts/deploy-commands-to-bot.js 1345684217438273577');
    console.log('  pm2 restart CertiFriedUtility');

    await pool.end();
    process.exit(0);
}

onboard().catch(err => {
    console.error('Onboarding failed:', err);
    process.exit(1);
});
