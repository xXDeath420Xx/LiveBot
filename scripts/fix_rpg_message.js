import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
// Load .env first before importing encryption which needs BOT_ENCRYPTION_KEY
dotenv.config({ path: '/root/discord_bots/CertiFriedUtility/.env' });

const { default: encryption } = await import('../utils/encryption.js');

const MESSAGE_ID = '1445236756206325804';
const CHANNEL_ID = '1439268163320811600';
const GUILD_ID = '1404239197987930114';
const CUSTOM_BOT_ID = '1439236669088727111';

async function main() {
    // Get custom bot token from database
    const pool = await mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME
    });

    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [CUSTOM_BOT_ID]
    );

    if (bots.length === 0) {
        console.log('Custom bot not found');
        await pool.end();
        return;
    }

    // Decrypt the token
    const encryptedToken = JSON.parse(bots[0].bot_token);
    const token = encryption.decrypt(encryptedToken);
    console.log('Found and decrypted bot token');

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
    });

    client.once('ready', async () => {
        console.log('Bot logged in as', client.user.tag);

        try {
            const channel = await client.channels.fetch(CHANNEL_ID);
            const message = await channel.messages.fetch(MESSAGE_ID);

            console.log('Found message');
            console.log('Embed count:', message.embeds.length);

            if (message.embeds.length > 0) {
                const embed = message.embeds[0];
                console.log('Original description:\n', embed.description);
                console.log('\n--- Looking for broken tags ---');

                let fixedDescription = embed.description;

                // Fix ALL broken tag patterns - handle missing closing braces

                // ADD_ITEM: {{ADD_ITEM:name:qty:rarity?}}
                fixedDescription = fixedDescription.replace(
                    /\{\{ADD_ITEM:([^:}]+):(\d+)(?::(\w+))?\}?\}?/gi,
                    (match, item, qty, rarity) => {
                        console.log('Found ADD_ITEM:', match);
                        const quantity = parseInt(qty) || 1;
                        let result = '🎁 **' + item.trim() + '**';
                        if (quantity > 1) result += ' x' + quantity;
                        if (rarity) result += ' (' + rarity + ')';
                        return result;
                    }
                );

                // GOLD: {{GOLD:amount}}
                fixedDescription = fixedDescription.replace(
                    /\{\{GOLD:(\d+)\}?\}?/gi,
                    (match, amount) => {
                        console.log('Found GOLD:', match);
                        return '💰 **' + amount + ' gold**';
                    }
                );

                // Malformed GOLD tag with literal "amount" word - remove it
                fixedDescription = fixedDescription.replace(
                    /\{\{GOLD:amount\}?\}?/gi,
                    (match) => {
                        console.log('Found malformed GOLD tag:', match);
                        return '';
                    }
                );

                // XP: {{XP:amount}}
                fixedDescription = fixedDescription.replace(
                    /\{\{XP:(\d+)\}?\}?/gi,
                    (match, amount) => {
                        console.log('Found XP:', match);
                        return '✨ **' + amount + ' XP**';
                    }
                );

                // DAMAGE: {{DAMAGE:target:amount}} or {{DAMAGE:amount}}
                fixedDescription = fixedDescription.replace(
                    /\{\{DAMAGE:([^:}]+):(\d+)\}?\}?/gi,
                    (match, target, amount) => {
                        console.log('Found DAMAGE:', match);
                        return '💔 **' + target.trim() + ' takes ' + amount + ' damage!**';
                    }
                );
                fixedDescription = fixedDescription.replace(
                    /\{\{DAMAGE:(\d+)\}?\}?/gi,
                    (match, amount) => {
                        console.log('Found DAMAGE (old):', match);
                        return '💔 **-' + amount + ' HP**';
                    }
                );

                // HEAL: {{HEAL:target:amount}} or {{HEAL:amount}}
                fixedDescription = fixedDescription.replace(
                    /\{\{HEAL:([^:}]+):(\d+)\}?\}?/gi,
                    (match, target, amount) => {
                        console.log('Found HEAL:', match);
                        return '💚 **' + target.trim() + ' heals ' + amount + ' HP!**';
                    }
                );
                fixedDescription = fixedDescription.replace(
                    /\{\{HEAL:(\d+)\}?\}?/gi,
                    (match, amount) => {
                        console.log('Found HEAL (old):', match);
                        return '💚 **+' + amount + ' HP**';
                    }
                );

                // ENEMY: {{ENEMY:name:hp:ac}}
                fixedDescription = fixedDescription.replace(
                    /\{\{ENEMY:([^:}]+):(\d+):(\d+)\}?\}?/gi,
                    (match, name, hp, ac) => {
                        console.log('Found ENEMY:', match);
                        return '**' + name.trim() + '** *(HP: ' + hp + ', AC: ' + ac + ')*';
                    }
                );

                // ENEMY_DAMAGE: {{ENEMY_DAMAGE:name:amount}}
                fixedDescription = fixedDescription.replace(
                    /\{\{ENEMY_DAMAGE:([^:}]+):(\d+)\}?\}?/gi,
                    (match, name, amount) => {
                        console.log('Found ENEMY_DAMAGE:', match);
                        return '⚔️ **' + name.trim() + '** takes **' + amount + '** damage';
                    }
                );

                // ENEMY_DEAD: {{ENEMY_DEAD:name}}
                fixedDescription = fixedDescription.replace(
                    /\{\{ENEMY_DEAD:([^}\s]+)\}?\}?/gi,
                    (match, name) => {
                        console.log('Found ENEMY_DEAD:', match);
                        return '💀 **' + name.trim() + '** is defeated!';
                    }
                );

                // USE_ITEM: {{USE_ITEM:name}}
                fixedDescription = fixedDescription.replace(
                    /\{\{USE_ITEM:([^}\s]+)\}?\}?/gi,
                    (match, item) => {
                        console.log('Found USE_ITEM:', match);
                        return '📦 *Used ' + item.trim() + '*';
                    }
                );

                // LOOT: {{LOOT:item:qty}}
                fixedDescription = fixedDescription.replace(
                    /\{\{LOOT:([^:}]+):?(\d+)?\}?\}?/gi,
                    (match, item, qty) => {
                        console.log('Found LOOT:', match);
                        const quantity = parseInt(qty) || 1;
                        let result = '🎁 **' + item.trim() + '**';
                        if (quantity > 1) result += ' x' + quantity;
                        return result;
                    }
                );

                // LOCATION: {{LOCATION:name}}
                fixedDescription = fixedDescription.replace(
                    /\{\{LOCATION:([^}]+?)\}?\}?(?=\s|$|[.,!?])/gi,
                    (match, location) => {
                        console.log('Found LOCATION:', match);
                        return '📍 **' + location.trim() + '**';
                    }
                );

                // NPC: {{NPC:name:description}}
                fixedDescription = fixedDescription.replace(
                    /\{\{NPC:([^:}]+):([^}]+?)\}?\}?(?=\s|$|[.,!?])/gi,
                    (match, name, desc) => {
                        console.log('Found NPC:', match);
                        return '**' + name.trim() + '** *(' + desc.trim() + ')*';
                    }
                );

                console.log('\n--- Fixed description ---\n', fixedDescription);

                // Create new embed with fixed description
                const newEmbed = EmbedBuilder.from(embed)
                    .setDescription(fixedDescription);

                await message.edit({ embeds: [newEmbed] });
                console.log('\n✅ Message updated successfully!');
            }
        } catch (error) {
            console.error('Error:', error.message);
        }

        await pool.end();
        client.destroy();
        process.exit(0);
    });

    await client.login(token);
}

main().catch(console.error);
