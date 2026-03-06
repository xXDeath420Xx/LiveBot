/**
 * Audit server 879457883333464114 for ProBot integrations
 * Finds all ProBot messages, embeds, reaction roles, rules, welcome, etc.
 */
import { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits } from 'discord.js';

const BOT_TOKEN = process.env.AUDIT_BOT_TOKEN; // was hardcoded — use env var
const GUILD_ID = '879457883333464114';

// Known ProBot user IDs
const PROBOT_IDS = new Set([
    '282859044593598464',  // ProBot main
    '567703512763334685',  // ProBot#0000 (alt)
]);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
    ]
});

async function main() {
    await client.login(BOT_TOKEN);
    await new Promise(r => { if (client.isReady()) r(); else client.once('ready', r); });
    console.log(`Logged in as ${client.user.tag}\n`);

    const guild = await client.guilds.fetch(GUILD_ID);
    await guild.channels.fetch();
    await guild.roles.fetch();
    await guild.members.fetch();

    // ─── Server Overview ──────────────────────────────────────────
    console.log('='.repeat(80));
    console.log('  SERVER AUDIT: ' + guild.name);
    console.log('='.repeat(80));
    console.log(`  ID: ${guild.id}`);
    console.log(`  Owner: ${(await guild.fetchOwner()).user.tag} (${guild.ownerId})`);
    console.log(`  Members: ${guild.memberCount}`);
    console.log(`  Channels: ${guild.channels.cache.size}`);
    console.log(`  Roles: ${guild.roles.cache.size}`);
    console.log(`  Boosts: Level ${guild.premiumTier} (${guild.premiumSubscriptionCount} boosts)`);

    // ─── Bots in Server ──────────────────────────────────────────
    console.log('\n' + '─'.repeat(80));
    console.log('  BOTS IN SERVER');
    console.log('─'.repeat(80));

    const bots = guild.members.cache.filter(m => m.user.bot);
    for (const [, bot] of bots.sort((a, b) => a.user.username.localeCompare(b.user.username))) {
        const isProBot = PROBOT_IDS.has(bot.id);
        const marker = isProBot ? ' ★ PROBOT' : '';
        console.log(`  ${bot.user.tag} (${bot.id})${marker}`);
        if (isProBot) {
            console.log(`    Roles: ${bot.roles.cache.filter(r => r.id !== guild.id).map(r => r.name).join(', ')}`);
            console.log(`    Permissions: ${bot.permissions.toArray().join(', ')}`);
        }
    }

    // ─── Channel Structure ────────────────────────────────────────
    console.log('\n' + '─'.repeat(80));
    console.log('  CHANNEL STRUCTURE');
    console.log('─'.repeat(80));

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
                             ch.type === ChannelType.GuildStageVoice ? '🎙️' :
                             ch.type === ChannelType.GuildAnnouncement ? '📢' : '?';
            console.log(`    ${typeLabel} ${ch.name} (${ch.id})`);
        }
    }

    // Uncategorized
    const uncategorized = guild.channels.cache
        .filter(c => !c.parentId && c.type !== ChannelType.GuildCategory)
        .sort((a, b) => a.position - b.position);
    if (uncategorized.size > 0) {
        console.log('\n  📁 [No Category]');
        for (const [, ch] of uncategorized) {
            const typeLabel = ch.type === ChannelType.GuildText ? '#' :
                             ch.type === ChannelType.GuildVoice ? '🔊' : '?';
            console.log(`    ${typeLabel} ${ch.name} (${ch.id})`);
        }
    }

    // ─── All Roles ────────────────────────────────────────────────
    console.log('\n' + '─'.repeat(80));
    console.log('  ALL ROLES (by position)');
    console.log('─'.repeat(80));

    const roles = guild.roles.cache.sort((a, b) => b.position - a.position);
    for (const [, role] of roles) {
        const memberCount = role.members.size;
        const flags = [];
        if (role.managed) flags.push('BOT/INTEGRATION');
        if (role.id === guild.id) flags.push('@everyone');
        if (role.hoist) flags.push('HOISTED');
        if (role.mentionable) flags.push('MENTIONABLE');
        const flagStr = flags.length ? ` [${flags.join(', ')}]` : '';
        console.log(`  ${role.hexColor} ${role.name} (${role.id}) - ${memberCount} members${flagStr}`);
    }

    // ─── ProBot Messages Scan ─────────────────────────────────────
    console.log('\n' + '─'.repeat(80));
    console.log('  PROBOT & BOT MESSAGES SCAN');
    console.log('─'.repeat(80));

    const textChannels = guild.channels.cache.filter(
        c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement
    );

    let probotMessages = [];
    let otherBotMessages = [];

    for (const [, channel] of textChannels) {
        try {
            // Check permissions
            const perms = channel.permissionsFor(guild.members.me);
            if (!perms || !perms.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.ReadMessageHistory)) {
                console.log(`  [SKIP] #${channel.name} - No access`);
                continue;
            }

            // Fetch recent messages (up to 100)
            const messages = await channel.messages.fetch({ limit: 100 });

            for (const [, msg] of messages) {
                const isProBot = PROBOT_IDS.has(msg.author.id);
                const isBot = msg.author.bot;

                if (isProBot) {
                    const reactions = [];
                    for (const [, r] of msg.reactions.cache) {
                        reactions.push(`${r.emoji.name}${r.emoji.id ? ':' + r.emoji.id : ''} (${r.count})`);
                    }

                    probotMessages.push({
                        channelId: channel.id,
                        channelName: channel.name,
                        messageId: msg.id,
                        content: msg.content?.substring(0, 300) || '(empty)',
                        embeds: msg.embeds.map(e => ({
                            title: e.title || '(none)',
                            description: e.description?.substring(0, 300) || '(none)',
                            color: e.color,
                            fields: e.fields?.map(f => ({ name: f.name, value: f.value?.substring(0, 200) })) || [],
                            image: e.image?.url || null,
                            thumbnail: e.thumbnail?.url || null,
                            footer: e.footer?.text || null,
                        })),
                        components: msg.components?.length || 0,
                        componentDetails: msg.components?.map(row =>
                            row.components.map(c => ({
                                type: c.type,
                                customId: c.customId,
                                label: c.label,
                                style: c.style,
                                emoji: c.emoji?.name,
                                placeholder: c.placeholder,
                            }))
                        ) || [],
                        reactions,
                        pinned: msg.pinned,
                        createdAt: msg.createdAt.toISOString(),
                    });
                } else if (isBot && msg.embeds.length > 0) {
                    // Track other bot messages with embeds (could be relevant)
                    otherBotMessages.push({
                        channelId: channel.id,
                        channelName: channel.name,
                        messageId: msg.id,
                        author: msg.author.tag + ' (' + msg.author.id + ')',
                        content: msg.content?.substring(0, 100) || '(empty)',
                        embedCount: msg.embeds.length,
                        embedTitles: msg.embeds.map(e => e.title || e.description?.substring(0, 50) || '(no title)'),
                        reactions: msg.reactions.cache.map(r => `${r.emoji.name} (${r.count})`),
                        components: msg.components?.length || 0,
                    });
                }
            }
        } catch (err) {
            console.log(`  [ERROR] #${channel.name}: ${err.message}`);
        }
    }

    // Print ProBot messages
    console.log(`\n  Found ${probotMessages.length} ProBot message(s):\n`);
    for (const msg of probotMessages) {
        console.log(`  ─── #${msg.channelName} (${msg.channelId}) ───`);
        console.log(`  Message ID: ${msg.messageId}`);
        console.log(`  Created: ${msg.createdAt}`);
        console.log(`  Pinned: ${msg.pinned}`);
        if (msg.content && msg.content !== '(empty)') {
            console.log(`  Content: ${msg.content}`);
        }
        if (msg.embeds.length > 0) {
            for (const embed of msg.embeds) {
                console.log(`  Embed Title: ${embed.title}`);
                console.log(`  Embed Desc: ${embed.description}`);
                if (embed.color) console.log(`  Embed Color: #${embed.color.toString(16).padStart(6, '0')}`);
                if (embed.fields.length > 0) {
                    for (const f of embed.fields) {
                        console.log(`    Field: ${f.name} = ${f.value}`);
                    }
                }
                if (embed.image) console.log(`  Embed Image: ${embed.image}`);
                if (embed.thumbnail) console.log(`  Embed Thumb: ${embed.thumbnail}`);
                if (embed.footer) console.log(`  Embed Footer: ${embed.footer}`);
            }
        }
        if (msg.components > 0) {
            console.log(`  Components: ${msg.components} action row(s)`);
            for (const row of msg.componentDetails) {
                for (const comp of row) {
                    console.log(`    ${comp.type}: customId=${comp.customId} label=${comp.label} emoji=${comp.emoji} style=${comp.style}`);
                }
            }
        }
        if (msg.reactions.length > 0) {
            console.log(`  Reactions: ${msg.reactions.join(', ')}`);
        }
        console.log('');
    }

    // Print other notable bot messages
    if (otherBotMessages.length > 0) {
        console.log(`\n  Other bot messages with embeds (${otherBotMessages.length}):\n`);
        for (const msg of otherBotMessages.slice(0, 20)) {
            console.log(`  #${msg.channelName} | ${msg.author} | ${msg.embedTitles.join(', ')} | Reactions: ${msg.reactions.join(', ') || 'none'} | Components: ${msg.components}`);
        }
    }

    // ─── Channels likely used by ProBot ──────────────────────────
    console.log('\n' + '─'.repeat(80));
    console.log('  CHANNELS LIKELY USED BY PROBOT');
    console.log('─'.repeat(80));

    const probotChannelNames = ['rules', 'role', 'welcome', 'verify', 'self-role', 'reaction', 'info', 'announcement', 'log', 'mod-log'];
    for (const [, ch] of textChannels) {
        const nameLC = ch.name.toLowerCase();
        if (probotChannelNames.some(n => nameLC.includes(n))) {
            console.log(`  #${ch.name} (${ch.id}) - Topic: ${ch.topic || '(none)'}`);
        }
    }

    // ─── Server Settings of Interest ─────────────────────────────
    console.log('\n' + '─'.repeat(80));
    console.log('  SERVER SETTINGS');
    console.log('─'.repeat(80));
    console.log(`  System Channel: ${guild.systemChannel?.name || 'none'} (${guild.systemChannelId || 'none'})`);
    console.log(`  Rules Channel: ${guild.rulesChannel?.name || 'none'} (${guild.rulesChannelId || 'none'})`);
    console.log(`  Public Updates: ${guild.publicUpdatesChannel?.name || 'none'} (${guild.publicUpdatesChannelId || 'none'})`);
    console.log(`  Verification Level: ${guild.verificationLevel}`);
    console.log(`  NSFW Level: ${guild.nsfwLevel}`);
    console.log(`  MFA Level: ${guild.mfaLevel}`);
    console.log(`  Features: ${guild.features.join(', ') || 'none'}`);

    console.log('\n' + '='.repeat(80));
    console.log('  AUDIT COMPLETE');
    console.log('='.repeat(80));

    client.destroy();
}

main().catch(err => {
    console.error('FATAL:', err);
    client.destroy();
    process.exit(1);
});
