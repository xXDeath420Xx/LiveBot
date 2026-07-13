import dotenv from 'dotenv';
dotenv.config();
import { Client, GatewayIntentBits, PermissionsBitField } from 'discord.js';
import mysql from 'mysql2/promise';
// Lazy-load encryption after dotenv has set the env vars
const { default: encryption } = await import('../utils/encryption.js');

const GUILD_ID = '880656752297783347';
const BOT_ID = '1486198184047808542';

async function main() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST, user: process.env.DB_USER,
        password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    });

    // Get bot token
    const [bots] = await pool.execute('SELECT * FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
    if (!bots.length) { console.log('Bot not found'); process.exit(1); }
    const token = encryption.decrypt(JSON.parse(bots[0].bot_token));

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildIntegrations,
            GatewayIntentBits.GuildPresences,
            GatewayIntentBits.MessageContent,
        ],
    });

    await client.login(token);
    await new Promise(resolve => client.once('ready', resolve));
    console.log(`Logged in as ${client.user.tag}`);

    const guild = client.guilds.cache.get(GUILD_ID);
    if (!guild) { console.log('Guild not found'); process.exit(1); }

    console.log('\n═══════════════════════════════════════════');
    console.log(`SERVER: ${guild.name} (${guild.id})`);
    console.log(`Owner: ${guild.ownerId}`);
    console.log(`Members: ${guild.memberCount}`);
    console.log(`Boost Level: ${guild.premiumTier} (${guild.premiumSubscriptionCount} boosts)`);
    console.log(`Created: ${guild.createdAt.toISOString().split('T')[0]}`);
    console.log(`Verification: ${guild.verificationLevel}`);
    console.log(`Features: ${guild.features.join(', ') || 'none'}`);
    console.log('═══════════════════════════════════════════\n');

    console.log(`Approx Members: ${guild.memberCount} (privileged intents not enabled — using approximation)`);

    // ═══ ROLES ═══
    console.log('\n── ROLES ──');
    const roles = guild.roles.cache.sort((a, b) => b.position - a.position);
    roles.forEach(r => {
        const perms = [];
        if (r.permissions.has(PermissionsBitField.Flags.Administrator)) perms.push('ADMIN');
        if (r.permissions.has(PermissionsBitField.Flags.ManageGuild)) perms.push('MANAGE_GUILD');
        if (r.permissions.has(PermissionsBitField.Flags.ManageChannels)) perms.push('MANAGE_CHANNELS');
        if (r.permissions.has(PermissionsBitField.Flags.ManageRoles)) perms.push('MANAGE_ROLES');
        if (r.permissions.has(PermissionsBitField.Flags.BanMembers)) perms.push('BAN');
        if (r.permissions.has(PermissionsBitField.Flags.KickMembers)) perms.push('KICK');
        if (r.permissions.has(PermissionsBitField.Flags.ManageMessages)) perms.push('MANAGE_MSGS');
        const flags = [];
        if (r.managed) flags.push('BOT');
        if (r.hoist) flags.push('HOISTED');
        if (r.mentionable) flags.push('MENTIONABLE');
        console.log(`  [${r.position.toString().padStart(2)}] ${r.name} (${r.id}) — color: ${r.hexColor}${perms.length ? ' — ' + perms.join(', ') : ''}${flags.length ? ' [' + flags.join(', ') + ']' : ''}`);
    });

    // ═══ CHANNELS ═══
    console.log('\n── CHANNELS ──');
    const channels = guild.channels.cache.sort((a, b) => a.rawPosition - b.rawPosition);
    const categories = channels.filter(c => c.type === 4);
    const uncategorized = channels.filter(c => c.type !== 4 && !c.parentId);

    if (uncategorized.size > 0) {
        console.log('  [No Category]');
        uncategorized.forEach(c => {
            const type = c.type === 0 ? '#' : c.type === 2 ? '🔊' : c.type === 5 ? '📢' : c.type === 13 ? '🎭' : c.type === 15 ? '💬' : '?';
            console.log(`    ${type} ${c.name} (${c.id}) — pos:${c.rawPosition}`);
        });
    }

    categories.forEach(cat => {
        console.log(`  📁 ${cat.name} (${cat.id})`);
        const children = channels.filter(c => c.parentId === cat.id).sort((a, b) => a.rawPosition - b.rawPosition);
        children.forEach(c => {
            const type = c.type === 0 ? '#' : c.type === 2 ? '🔊' : c.type === 5 ? '📢' : c.type === 13 ? '🎭' : c.type === 15 ? '💬' : '?';
            console.log(`    ${type} ${c.name} (${c.id})`);
        });
    });

    // ═══ BOTS ═══
    console.log('\n── BOTS IN SERVER (from integrations) ──');

    // ═══ INTEGRATIONS ═══
    console.log('\n── INTEGRATIONS ──');
    try {
        const integrations = await guild.fetchIntegrations();
        integrations.forEach(i => {
            console.log(`  ${i.name} (${i.type}) — enabled: ${i.enabled}, id: ${i.id}`);
        });
        if (integrations.size === 0) console.log('  (none)');
    } catch (e) {
        console.log('  (cannot fetch — missing permission)');
    }

    // ═══ AUTOMOD RULES ═══
    console.log('\n── AUTOMOD RULES ──');
    try {
        const rules = await guild.autoModerationRules.fetch();
        rules.forEach(r => {
            console.log(`  ${r.name} (${r.id}) — enabled: ${r.enabled}, trigger: ${r.triggerType}, creator: ${r.creatorId}`);
        });
        if (rules.size === 0) console.log('  (none)');
    } catch (e) {
        console.log('  (cannot fetch — ' + e.message + ')');
    }

    // ═══ WEBHOOKS ═══
    console.log('\n── WEBHOOKS ──');
    try {
        const webhooks = await guild.fetchWebhooks();
        webhooks.forEach(w => {
            console.log(`  ${w.name} (${w.id}) — channel: ${w.channelId}, creator: ${w.owner?.tag || w.owner?.id || 'unknown'}`);
        });
        if (webhooks.size === 0) console.log('  (none)');
    } catch (e) {
        console.log('  (cannot fetch — ' + e.message + ')');
    }

    // ═══ EMOJIS ═══
    console.log('\n── EMOJIS ──');
    console.log(`  Total: ${guild.emojis.cache.size} (${guild.emojis.cache.filter(e => e.animated).size} animated)`);

    // ═══ STICKERS ═══
    console.log('\n── STICKERS ──');
    console.log(`  Total: ${guild.stickers.cache.size}`);

    // ═══ SCHEDULED EVENTS ═══
    console.log('\n── SCHEDULED EVENTS ──');
    try {
        const events = await guild.scheduledEvents.fetch();
        events.forEach(e => {
            console.log(`  ${e.name} — ${e.status} — ${e.scheduledStartAt?.toISOString() || 'N/A'}`);
        });
        if (events.size === 0) console.log('  (none)');
    } catch (e) {
        console.log('  (cannot fetch)');
    }

    // ═══ INVITES ═══
    console.log('\n── ACTIVE INVITES ──');
    try {
        const invites = await guild.invites.fetch();
        invites.forEach(i => {
            console.log(`  ${i.code} — ${i.uses} uses — by ${i.inviter?.tag || 'unknown'} — channel: ${i.channel?.name || i.channelId}`);
        });
        if (invites.size === 0) console.log('  (none)');
    } catch (e) {
        console.log('  (cannot fetch — ' + e.message + ')');
    }

    // ═══ OWNER ═══
    console.log('\n── OWNER ──');
    console.log(`  Owner ID: ${guild.ownerId}`);

    console.log('\n═══════════════════════════════════════════');
    console.log('AUDIT COMPLETE');
    console.log('═══════════════════════════════════════════');

    client.destroy();
    await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
