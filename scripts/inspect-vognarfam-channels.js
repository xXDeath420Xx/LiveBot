/**
 * Inspect welcome and roles channels in VognarFam guild
 * Fetch existing messages to understand what Dyno has set up
 */
import dotenv from 'dotenv';
dotenv.config();

import { Client, GatewayIntentBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '902393911958470717';
const BOT_ID = '1476040458680406214';

async function run() {
    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
    });

    await client.login(token);
    await new Promise(r => client.once('ready', r));
    console.log(`Logged in as ${client.user.tag}\n`);

    const guild = client.guilds.cache.get(GUILD_ID);

    // ========== WELCOME CHANNEL ==========
    console.log('=== WELCOME CHANNEL (903154005620953109) ===');
    const welcomeCh = guild.channels.cache.get('903154005620953109');
    if (welcomeCh) {
        // Fetch the specific Dyno message
        try {
            const dynoMsg = await welcomeCh.messages.fetch('1474431740473770189');
            console.log(`\nDyno welcome message (${dynoMsg.id}):`);
            console.log(`  Author: ${dynoMsg.author.tag}`);
            console.log(`  Content: ${dynoMsg.content || '(no content)'}`);
            if (dynoMsg.embeds.length > 0) {
                for (const embed of dynoMsg.embeds) {
                    console.log(`  Embed title: ${embed.title || '(none)'}`);
                    console.log(`  Embed description: ${embed.description || '(none)'}`);
                    console.log(`  Embed color: ${embed.color}`);
                    if (embed.fields.length > 0) {
                        for (const f of embed.fields) {
                            console.log(`  Field: ${f.name} = ${f.value}`);
                        }
                    }
                    if (embed.image) console.log(`  Image: ${embed.image.url}`);
                    if (embed.thumbnail) console.log(`  Thumbnail: ${embed.thumbnail.url}`);
                    if (embed.footer) console.log(`  Footer: ${embed.footer.text}`);
                }
            }
        } catch (e) {
            console.log(`  Could not fetch message 1474431740473770189: ${e.message}`);
        }

        // Also fetch recent messages to see welcome pattern
        console.log('\nRecent messages in welcome channel:');
        const recentMsgs = await welcomeCh.messages.fetch({ limit: 10 });
        for (const [, msg] of recentMsgs.sort((a, b) => a.createdTimestamp - b.createdTimestamp)) {
            const preview = msg.content ? msg.content.substring(0, 100) : (msg.embeds.length > 0 ? `[embed: ${msg.embeds[0].title || msg.embeds[0].description?.substring(0, 80) || 'no title'}]` : '[no content]');
            console.log(`  ${msg.author.tag}: ${preview}`);
        }
    }

    // ========== ROLES CHANNEL ==========
    console.log('\n\n=== ROLES CHANNEL (903160651462107146) ===');
    const rolesCh = guild.channels.cache.get('903160651462107146');
    if (rolesCh) {
        const msgs = await rolesCh.messages.fetch({ limit: 20 });
        for (const [, msg] of msgs.sort((a, b) => a.createdTimestamp - b.createdTimestamp)) {
            console.log(`\nMessage ${msg.id} by ${msg.author.tag}:`);
            if (msg.content) console.log(`  Content: ${msg.content.substring(0, 200)}`);
            if (msg.embeds.length > 0) {
                for (const embed of msg.embeds) {
                    console.log(`  Embed title: ${embed.title || '(none)'}`);
                    console.log(`  Embed desc: ${(embed.description || '(none)').substring(0, 200)}`);
                    if (embed.fields.length > 0) {
                        for (const f of embed.fields) {
                            console.log(`  Field: ${f.name} = ${f.value.substring(0, 100)}`);
                        }
                    }
                }
            }
            if (msg.components.length > 0) {
                for (const row of msg.components) {
                    for (const comp of row.components) {
                        console.log(`  Component: ${comp.type} | customId=${comp.customId || 'N/A'} | label=${comp.label || 'N/A'}`);
                    }
                }
            }
            if (msg.reactions.cache.size > 0) {
                const reacts = [];
                for (const [emoji, reaction] of msg.reactions.cache) {
                    reacts.push(`${emoji} (${reaction.count})`);
                }
                console.log(`  Reactions: ${reacts.join(', ')}`);
            }
        }
    }

    // ========== LIST ALL ROLES ==========
    console.log('\n\n=== GUILD ROLES ===');
    const roles = guild.roles.cache.sort((a, b) => b.rawPosition - a.rawPosition);
    for (const [, role] of roles) {
        if (role.name === '@everyone') continue;
        const managed = role.managed ? ' [BOT/INTEGRATION]' : '';
        const color = role.color ? `#${role.color.toString(16).padStart(6, '0')}` : 'none';
        console.log(`  ${role.name} (${role.id}) - color: ${color} - members: ${role.members.size}${managed}`);
    }

    client.destroy();
    await pool.end();
    process.exit(0);
}

run().catch(err => { console.error(err); process.exit(1); });
