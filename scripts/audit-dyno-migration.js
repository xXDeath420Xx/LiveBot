/**
 * Audit Dyno setup for migration to Flying Sharks Utility
 */
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import dotenv from 'dotenv';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

dotenv.config({ path: '/home/death/CertiFriedUtility/.env' });

const GUILD_ID = '1307517872301670480';
const DYNO_BOT_ID = '155149108183695360';

async function getCustomBotToken(botId) {
    const [bots] = await pool.execute(
        'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
        [botId]
    );
    if (bots.length === 0) throw new Error('Bot not found');
    return encryption.decrypt(JSON.parse(bots[0].bot_token));
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions
    ]
});

client.once('ready', async () => {
    console.log('='.repeat(80));
    console.log('DYNO MIGRATION AUDIT - Flying Sharks Server');
    console.log('='.repeat(80));

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) {
        console.log('ERROR: Bot not in guild');
        process.exit(1);
    }

    const audit = {
        dynoMessages: [],
        reactionRoles: [],
        loggingChannels: [],
        embeds: []
    };

    // Fetch all channels
    await guild.channels.fetch();
    const textChannels = guild.channels.cache.filter(c => 
        c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement
    );

    console.log(`\nScanning ${textChannels.size} text channels for Dyno messages...\n`);

    for (const [channelId, channel] of textChannels) {
        try {
            // Fetch recent messages (up to 100)
            const messages = await channel.messages.fetch({ limit: 100 });
            
            for (const [msgId, msg] of messages) {
                // Check if from Dyno
                if (msg.author.id === DYNO_BOT_ID) {
                    const msgData = {
                        channelId: channel.id,
                        channelName: channel.name,
                        messageId: msg.id,
                        content: msg.content,
                        embeds: msg.embeds.map(e => ({
                            title: e.title,
                            description: e.description,
                            color: e.color,
                            fields: e.fields,
                            footer: e.footer,
                            thumbnail: e.thumbnail,
                            image: e.image,
                            author: e.author
                        })),
                        components: msg.components.map(row => ({
                            type: row.type,
                            components: row.components.map(c => ({
                                type: c.type,
                                customId: c.customId,
                                label: c.label,
                                emoji: c.emoji,
                                style: c.style
                            }))
                        })),
                        reactions: [],
                        timestamp: msg.createdTimestamp
                    };

                    // Get reactions
                    if (msg.reactions.cache.size > 0) {
                        for (const [emoji, reaction] of msg.reactions.cache) {
                            msgData.reactions.push({
                                emoji: reaction.emoji.name,
                                emojiId: reaction.emoji.id,
                                count: reaction.count
                            });
                        }
                    }

                    audit.dynoMessages.push(msgData);

                    // Check if likely a reaction role message
                    if (msgData.reactions.length > 0 || msgData.components.length > 0) {
                        audit.reactionRoles.push(msgData);
                    }

                    if (msgData.embeds.length > 0) {
                        audit.embeds.push(msgData);
                    }
                }
            }
        } catch (e) {
            console.log(`  Could not scan #${channel.name}: ${e.message}`);
        }
    }

    // Identify logging channels by name
    const loggingPatterns = ['log', 'audit', 'mod-log', 'modlog'];
    for (const [channelId, channel] of textChannels) {
        if (loggingPatterns.some(p => channel.name.toLowerCase().includes(p))) {
            audit.loggingChannels.push({
                id: channel.id,
                name: channel.name,
                parentName: channel.parent?.name || 'No Category'
            });
        }
    }

    // Output results
    console.log('='.repeat(80));
    console.log('AUDIT RESULTS');
    console.log('='.repeat(80));

    console.log(`\n📊 SUMMARY:`);
    console.log(`   Total Dyno messages found: ${audit.dynoMessages.length}`);
    console.log(`   Messages with reactions/buttons: ${audit.reactionRoles.length}`);
    console.log(`   Messages with embeds: ${audit.embeds.length}`);
    console.log(`   Logging channels identified: ${audit.loggingChannels.length}`);

    console.log(`\n📝 LOGGING CHANNELS:`);
    audit.loggingChannels.forEach(ch => {
        console.log(`   #${ch.name} (${ch.id}) in [${ch.parentName}]`);
    });

    console.log(`\n🎭 REACTION ROLE MESSAGES:`);
    audit.reactionRoles.forEach(msg => {
        console.log(`\n   Channel: #${msg.channelName}`);
        console.log(`   Message ID: ${msg.messageId}`);
        if (msg.embeds.length > 0) {
            console.log(`   Embed Title: ${msg.embeds[0].title || '(no title)'}`);
            console.log(`   Embed Description: ${msg.embeds[0].description?.substring(0, 100) || '(no desc)'}...`);
        }
        if (msg.reactions.length > 0) {
            console.log(`   Reactions: ${msg.reactions.map(r => r.emoji).join(', ')}`);
        }
        if (msg.components.length > 0) {
            console.log(`   Has ${msg.components.length} component row(s) (buttons/selects)`);
            msg.components.forEach((row, i) => {
                row.components.forEach(c => {
                    console.log(`     - ${c.label || c.customId} ${c.emoji ? '(' + (c.emoji.name || c.emoji.id) + ')' : ''}`);
                });
            });
        }
    });

    console.log(`\n📋 ALL DYNO EMBEDS:`);
    audit.embeds.forEach(msg => {
        console.log(`\n   Channel: #${msg.channelName} (${msg.messageId})`);
        msg.embeds.forEach((embed, i) => {
            console.log(`   Embed ${i + 1}:`);
            console.log(`     Title: ${embed.title || '(none)'}`);
            console.log(`     Color: ${embed.color ? '#' + embed.color.toString(16) : '(none)'}`);
            if (embed.description) {
                console.log(`     Description: ${embed.description.substring(0, 150)}${embed.description.length > 150 ? '...' : ''}`);
            }
            if (embed.fields && embed.fields.length > 0) {
                console.log(`     Fields: ${embed.fields.length}`);
                embed.fields.forEach(f => console.log(`       - ${f.name}`));
            }
        });
    });

    // Save full audit to JSON for processing
    const fs = await import('fs');
    fs.writeFileSync('/home/death/CertiFriedUtility/scripts/dyno-audit-result.json', 
        JSON.stringify(audit, null, 2));
    console.log(`\n✅ Full audit saved to scripts/dyno-audit-result.json`);

    console.log('\n' + '='.repeat(80));
    await pool.end();
    client.destroy();
    process.exit(0);
});

// Login with custom bot
(async () => {
    const token = await getCustomBotToken('1462813232409612447');
    client.login(token);
})();
