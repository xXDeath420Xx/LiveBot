// Phases A + B + C — prep cleanup, role creation, channel scaffolding.
// Idempotent. Stop PM2 before running.
import { PermissionFlagsBits, ChannelType } from 'discord.js';
import { GUILD_ID, createPool, connectClient, getGuild, log, CHANNELS_EXISTING } from './shared.js';

const NEW_ROLES = [
    { name: 'Announcements',    color: 0xE67E22, hoist: false, mentionable: true,  reason: 'Pac migration: opt-in notification role' },
    { name: 'Shoutout Eligible',color: 0x9B59B6, hoist: false, mentionable: false, reason: 'Pac migration: level-3 auto-role gating stream shoutouts' },
    { name: 'Music',            color: 0x1ABC9C, hoist: false, mentionable: false, reason: 'Pac migration: opt-in access to #music' },
    { name: 'Arc Raiders',      color: 0x2ECC71, hoist: false, mentionable: true,  reason: 'Pac migration: game role' },
    { name: 'Call of Duty',     color: 0x2ECC71, hoist: false, mentionable: true,  reason: 'Pac migration: game role' },
    { name: 'Horror Games',     color: 0x2ECC71, hoist: false, mentionable: true,  reason: 'Pac migration: game role' },
    { name: 'Marvel',           color: 0x2ECC71, hoist: false, mentionable: true,  reason: 'Pac migration: game role' },
    { name: 'World of Warcraft',color: 0x2ECC71, hoist: false, mentionable: true,  reason: 'Pac migration: game role' },
    { name: 'Fortnite',         color: 0x2ECC71, hoist: false, mentionable: true,  reason: 'Pac migration: game role' },
];

const NEW_CHANNELS_UNCATEGORIZED = [
    { name: 'welcome-and-rules', type: ChannelType.GuildText, key: 'welcomeAndRules' },
];

const NEW_CHANNELS_IN_PACS_PARTY = [
    { name: 'live-streams',   type: ChannelType.GuildText, key: 'liveStreams',  topic: 'Auto-shoutouts for Pac streamers who are level 3+. Sign up in #stream-signup.' },
    { name: 'stream-signup',  type: ChannelType.GuildText, key: 'streamSignup', topic: 'Register your stream link here. Requires level 3+ to activate.' },
    { name: 'music',          type: ChannelType.GuildText, key: 'music',        topic: 'Music playback controls. Pick up the @Music role in #roles.' },
    { name: 'self-promo',     type: ChannelType.GuildText, key: 'selfPromo',    topic: 'Post your stream / social links here. Links posted in other channels will be removed.' },
];

const ADMIN_LOG_CHANNELS = [
    { name: 'member-log',  type: ChannelType.GuildText, key: 'memberLog',  topic: 'Joins and leaves.' },
    { name: 'message-log', type: ChannelType.GuildText, key: 'messageLog', topic: 'Message edits and deletions.' },
    { name: 'mod-log',     type: ChannelType.GuildText, key: 'modLog',     topic: 'Moderator actions and protection alerts.' },
    { name: 'voice-log',   type: ChannelType.GuildText, key: 'voiceLog',   topic: 'Voice channel activity.' },
    { name: 'channel-log', type: ChannelType.GuildText, key: 'channelLog', topic: 'Channel create / delete / update.' },
    { name: 'role-log',    type: ChannelType.GuildText, key: 'roleLog',    topic: 'Role create / delete / update.' },
];

const TICKET_CATEGORY_NAME = 'Support Tickets';
const NEW_TICKETS_CHANNEL = { name: 'open-a-ticket', type: ChannelType.GuildText, key: 'ticketsPanel', topic: 'Open a support ticket — click the button below.' };

const ADMIN_LOGS_CATEGORY_NAME = 'Admin Logs';

async function phaseA(ctx) {
    log('A', 'Starting cleanup');

    // Nuke the Dyno webhook in #discord-updates so its stale /dyno-updates spam dies.
    try {
        const webhooks = await ctx.guild.fetchWebhooks();
        for (const w of webhooks.values()) {
            if (w.name && /dyno/i.test(w.name)) {
                log('A', `Deleting Dyno webhook "${w.name}" (${w.id}) in <#${w.channelId}>`);
                await w.delete('Pac migration: removing Dyno remnants').catch(e => log('A', `  delete failed: ${e.message}`));
            }
        }
    } catch (e) {
        log('A', `webhooks fetch error: ${e.message}`);
    }

    // Ensure guild is registered in `guilds` table (it is — just bump last_seen).
    await ctx.pool.execute(
        `UPDATE guilds SET last_seen = NOW() WHERE guild_id = ?`,
        [GUILD_ID],
    );
    log('A', 'cleanup done');
}

async function phaseB(ctx) {
    log('B', 'Starting role creation');
    const created = {};
    const existing = {};
    for (const def of NEW_ROLES) {
        const found = ctx.guild.roles.cache.find(r => r.name === def.name);
        if (found) {
            existing[def.name] = found.id;
            log('B', `exists: ${def.name} (${found.id}) pos=${found.position}`);
            continue;
        }
        const role = await ctx.guild.roles.create({
            name: def.name,
            color: def.color,
            hoist: def.hoist,
            mentionable: def.mentionable,
            reason: def.reason,
        });
        created[def.name] = role.id;
        log('B', `created: ${def.name} (${role.id}) pos=${role.position}`);
    }
    ctx.newRoleIds = { ...existing, ...created };
    log('B', `role ids: ${JSON.stringify(ctx.newRoleIds)}`);
}

async function ensureCategory(ctx, name) {
    let cat = ctx.guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === name);
    if (cat) {
        log('C', `category exists: ${name} (${cat.id})`);
        return cat;
    }
    cat = await ctx.guild.channels.create({ name, type: ChannelType.GuildCategory, reason: 'Pac migration' });
    log('C', `created category: ${name} (${cat.id})`);
    return cat;
}

async function ensureChannel(ctx, def, parentId = null) {
    const existing = ctx.guild.channels.cache.find(c => c.name === def.name && c.parentId === parentId && c.type === def.type);
    if (existing) {
        log('C', `channel exists: ${def.name} (${existing.id})`);
        return existing;
    }
    const channel = await ctx.guild.channels.create({
        name: def.name,
        type: def.type,
        parent: parentId || undefined,
        topic: def.topic,
        reason: 'Pac migration',
    });
    log('C', `created channel: ${def.name} (${channel.id})${parentId ? ` in ${parentId}` : ''}`);
    return channel;
}

async function phaseC(ctx) {
    log('C', 'Starting channel scaffolding');
    const created = {};

    // 1. Delete old stream split channels (keeping wolf-live for Wolf specifically per user direction)
    const toDelete = [CHANNELS_EXISTING.twitchLive, CHANNELS_EXISTING.adminModLive];
    for (const id of toDelete) {
        const ch = ctx.guild.channels.cache.get(id);
        if (!ch) { log('C', `skip delete (already gone): ${id}`); continue; }
        log('C', `deleting stream channel: ${ch.name} (${ch.id})`);
        await ch.delete('Pac migration: consolidating stream channels').catch(e => log('C', `  delete failed: ${e.message}`));
    }

    // 2. Delete the split welcome/verification/rules channels — will be replaced by single #welcome-and-rules
    for (const id of [CHANNELS_EXISTING.welcome, CHANNELS_EXISTING.verification, CHANNELS_EXISTING.pacRules]) {
        const ch = ctx.guild.channels.cache.get(id);
        if (!ch) { log('C', `skip delete (already gone): ${id}`); continue; }
        log('C', `deleting legacy gate channel: ${ch.name} (${ch.id})`);
        await ch.delete('Pac migration: merging into #welcome-and-rules').catch(e => log('C', `  delete failed: ${e.message}`));
    }

    // 3. Create #welcome-and-rules (uncategorized, will become the gate)
    for (const def of NEW_CHANNELS_UNCATEGORIZED) {
        const c = await ensureChannel(ctx, def, null);
        created[def.key] = c.id;
    }

    // 4. Create new channels under Pacs Party category
    for (const def of NEW_CHANNELS_IN_PACS_PARTY) {
        const c = await ensureChannel(ctx, def, CHANNELS_EXISTING.pacsPartyCategory);
        created[def.key] = c.id;
    }

    // 5. Admin Logs category + child channels (positioned at bottom to keep staff eyes out of the way)
    const adminLogsCat = await ensureCategory(ctx, ADMIN_LOGS_CATEGORY_NAME);
    created.adminLogsCategory = adminLogsCat.id;
    for (const def of ADMIN_LOG_CHANNELS) {
        const c = await ensureChannel(ctx, def, adminLogsCat.id);
        created[def.key] = c.id;
    }

    // 6. Support Tickets category + single panel channel (tickets open as child channels)
    const ticketCat = await ensureCategory(ctx, TICKET_CATEGORY_NAME);
    created.ticketCategory = ticketCat.id;
    const ticketsPanel = await ensureChannel(ctx, NEW_TICKETS_CHANNEL, ticketCat.id);
    created.ticketsPanel = ticketsPanel.id;

    ctx.newChannelIds = created;
    log('C', `channel ids: ${JSON.stringify(created)}`);

    // 7. Persist the new IDs to a config row for later phases + external reference.
    //    Use a jsonish blob in guild_settings.backup_restore_data would be wrong — just print for now.
    //    External: the script output is the source of truth.
}

async function main() {
    const client = await connectClient();
    const pool = createPool();
    const guild = await getGuild(client);
    const ctx = { client, pool, guild };

    log('main', `logged in as ${client.user.tag}, guild ${guild.name}`);

    const phases = process.argv.slice(2).length
        ? process.argv.slice(2)
        : ['A', 'B', 'C'];

    const handlers = { A: phaseA, B: phaseB, C: phaseC };
    try {
        for (const p of phases) {
            const fn = handlers[p.toUpperCase()];
            if (!fn) { log('main', `unknown phase: ${p}`); continue; }
            await fn(ctx);
        }
    } finally {
        try { await client.destroy(); } catch (_) {}
        try { await pool.end(); } catch (_) {}
    }
}

main().catch(err => {
    console.error('FATAL', err?.stack || err);
    process.exit(1);
});
