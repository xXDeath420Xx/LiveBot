/**
 * Analyze Insomniac Crew server structure, roles, channels
 * and fetch specific messages for reaction role replacement
 */
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const encryptionModule = await import('../utils/encryption.js');
const encryptionService = encryptionModule.default;

const GUILD_ID = '538201414367707137';
const BOT_ID = '1469972857701273716';

let pool, client;

async function main() {
    pool = mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        charset: 'utf8mb4',
        waitForConnections: true,
        connectionLimit: 5,
        timezone: '+00:00'
    });

    const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    const tokenData = typeof bots[0].bot_token === 'string' ? JSON.parse(bots[0].bot_token) : bots[0].bot_token;
    const token = encryptionService.decrypt(tokenData);

    client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent
        ]
    });

    await client.login(token);
    await new Promise(r => { if (client.isReady()) r(); else client.once('ready', r); });
    console.log(`Logged in as ${client.user.tag}\n`);

    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.channels.fetch();
    await guild.roles.fetch();
    await guild.members.fetch();

    // ─── Server Overview ──────────────────────────────────────────
    console.log('='.repeat(70));
    console.log('  SERVER ANALYSIS: ' + guild.name);
    console.log('='.repeat(70));
    console.log(`  Members: ${guild.memberCount}`);
    console.log(`  Channels: ${guild.channels.cache.size}`);
    console.log(`  Roles: ${guild.roles.cache.size}`);
    console.log(`  Boosts: Level ${guild.premiumTier} (${guild.premiumSubscriptionCount} boosts)`);

    // ─── Categories & Channels ────────────────────────────────────
    console.log('\n' + '─'.repeat(70));
    console.log('  CHANNEL STRUCTURE');
    console.log('─'.repeat(70));

    const categories = guild.channels.cache
        .filter(c => c.type === ChannelType.GuildCategory)
        .sort((a, b) => a.position - b.position);

    for (const [, cat] of categories) {
        const children = guild.channels.cache
            .filter(c => c.parentId === cat.id)
            .sort((a, b) => a.position - b.position);
        console.log(`\n  📁 ${cat.name} (${cat.id})`);
        for (const [, ch] of children) {
            const typeLabel = ch.type === ChannelType.GuildText ? '#' :
                             ch.type === ChannelType.GuildVoice ? '🔊' :
                             ch.type === ChannelType.GuildForum ? '📋' :
                             ch.type === ChannelType.GuildStageVoice ? '🎙️' : '?';
            console.log(`    ${typeLabel} ${ch.name} (${ch.id})`);
        }
    }

    // Uncategorized channels
    const uncategorized = guild.channels.cache
        .filter(c => !c.parentId && c.type !== ChannelType.GuildCategory)
        .sort((a, b) => a.position - b.position);
    if (uncategorized.size > 0) {
        console.log('\n  📁 [No Category]');
        for (const [, ch] of uncategorized) {
            console.log(`    # ${ch.name} (${ch.id})`);
        }
    }

    // ─── All Roles ────────────────────────────────────────────────
    console.log('\n' + '─'.repeat(70));
    console.log('  ALL ROLES (by position, highest first)');
    console.log('─'.repeat(70));

    const roles = guild.roles.cache.sort((a, b) => b.position - a.position);
    for (const [, role] of roles) {
        const memberCount = role.members.size;
        const flags = [];
        if (role.managed) flags.push('BOT');
        if (role.id === guild.id) flags.push('@everyone');
        if (role.hoist) flags.push('HOISTED');
        if (role.mentionable) flags.push('MENTIONABLE');
        const flagStr = flags.length ? ` [${flags.join(', ')}]` : '';
        console.log(`  ${role.hexColor} ${role.name} (${role.id}) - ${memberCount} members${flagStr}`);
    }

    // ─── Fetch Target Messages ────────────────────────────────────
    console.log('\n' + '─'.repeat(70));
    console.log('  TARGET MESSAGES TO REPLACE');
    console.log('─'.repeat(70));

    // Message 1: Carl bot reaction role in 868256979343274014
    try {
        const ch1 = await guild.channels.fetch('868256979343274014');
        const msg1 = await ch1.messages.fetch('875775883359698974');
        console.log(`\n  Channel: #${ch1.name} (${ch1.id})`);
        console.log(`  Message: ${msg1.id} by ${msg1.author.tag}`);
        console.log(`  Content: ${msg1.content || '(empty)'}`);
        if (msg1.embeds.length > 0) {
            for (const embed of msg1.embeds) {
                console.log(`  Embed Title: ${embed.title || '(none)'}`);
                console.log(`  Embed Desc: ${embed.description || '(none)'}`);
                if (embed.fields?.length) {
                    for (const f of embed.fields) console.log(`    Field: ${f.name} = ${f.value}`);
                }
            }
        }
        if (msg1.reactions.cache.size > 0) {
            console.log(`  Reactions:`);
            for (const [, r] of msg1.reactions.cache) {
                console.log(`    ${r.emoji.name} (${r.emoji.id || 'unicode'}) - ${r.count} reactions`);
            }
        }
    } catch (err) {
        console.log(`  ERROR fetching message 875775883359698974: ${err.message}`);
    }

    // Messages 2-4: In channel 1407625323377590272
    try {
        const ch2 = await guild.channels.fetch('1407625323377590272');
        console.log(`\n  Channel: #${ch2.name} (${ch2.id})`);

        const msgIds = ['1418500284879212606', '1418501228530368583', '1418513103879929970'];
        for (const msgId of msgIds) {
            try {
                const msg = await ch2.messages.fetch(msgId);
                console.log(`\n  --- Message ${msg.id} by ${msg.author.tag} ---`);
                console.log(`  Content: ${msg.content?.substring(0, 500) || '(empty)'}`);
                if (msg.embeds.length > 0) {
                    for (const embed of msg.embeds) {
                        console.log(`  Embed Title: ${embed.title || '(none)'}`);
                        console.log(`  Embed Desc: ${embed.description?.substring(0, 500) || '(none)'}`);
                        console.log(`  Embed Color: ${embed.color}`);
                        if (embed.fields?.length) {
                            for (const f of embed.fields) console.log(`    Field: ${f.name} = ${f.value}`);
                        }
                        if (embed.image) console.log(`  Embed Image: ${embed.image.url}`);
                        if (embed.thumbnail) console.log(`  Embed Thumb: ${embed.thumbnail.url}`);
                    }
                }
                if (msg.components?.length > 0) {
                    console.log(`  Components: ${msg.components.length} action rows`);
                    for (const row of msg.components) {
                        for (const comp of row.components) {
                            console.log(`    ${comp.type}: ${comp.customId || comp.label || comp.placeholder}`);
                        }
                    }
                }
                if (msg.reactions.cache.size > 0) {
                    console.log(`  Reactions:`);
                    for (const [, r] of msg.reactions.cache) {
                        console.log(`    ${r.emoji.name} (${r.emoji.id || 'unicode'}) - ${r.count} reactions`);
                    }
                }
            } catch (err) {
                console.log(`  ERROR fetching message ${msgId}: ${err.message}`);
            }
        }
    } catch (err) {
        console.log(`  ERROR fetching channel 1407625323377590272: ${err.message}`);
    }

    // ─── Existing Reaction Role Panels ────────────────────────────
    console.log('\n' + '─'.repeat(70));
    console.log('  EXISTING REACTION ROLE PANELS');
    console.log('─'.repeat(70));

    const [panels] = await pool.execute(
        'SELECT * FROM reaction_role_panels WHERE guild_id = ?',
        [GUILD_ID]
    );
    if (panels.length === 0) {
        console.log('  None found in database');
    } else {
        for (const p of panels) {
            console.log(`\n  Panel: ${p.panel_name} (${p.id})`);
            console.log(`    Channel: ${p.channel_id}, Message: ${p.message_id}`);
            console.log(`    Mode: ${p.panel_mode}, Type: ${p.interaction_type}`);
            const [mappings] = await pool.execute(
                'SELECT * FROM reaction_role_mappings WHERE panel_id = ?',
                [p.id]
            );
            for (const m of mappings) {
                console.log(`    Role: ${m.role_id}, Emoji: ${m.emoji_id}, Desc: ${m.description}`);
            }
        }
    }

    console.log('\n');
    client.destroy();
    await pool.end();
}

main().catch(err => {
    console.error('FATAL:', err);
    if (client) client.destroy();
    if (pool) pool.end();
    process.exit(1);
});
