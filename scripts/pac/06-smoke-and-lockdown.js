// Phases Q + D — smoke-test the verify plumbing, then lock the server down.
// IMPORTANT: Q runs first. If Q fails any assertion, D is skipped.
import { PermissionFlagsBits, ChannelType } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GUILD_ID, createPool, connectClient, getGuild, log, ROLES_EXISTING, CHANNELS_EXISTING } from './shared.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(fs.readFileSync(path.join(__dirname, 'pac-state.json'), 'utf8'));

async function phaseQ(ctx) {
    log('Q', 'Smoke-testing verify + lockdown pre-conditions');
    const problems = [];

    // 1. verify_config row exists and is enabled
    const [vc] = await ctx.pool.execute('SELECT * FROM verify_config WHERE guild_id = ?', [GUILD_ID]);
    if (!vc.length || !vc[0].enabled) problems.push('verify_config not enabled');
    else {
        log('Q', `verify_config: verified=${vc[0].verified_role_id}, unverified=${vc[0].unverified_role_id}, gate=${vc[0].gate_channel_id}, msg=${vc[0].gate_message_id}`);
    }

    // 2. Bot's highest role is above Verified role
    const me = await ctx.guild.members.fetchMe();
    const verifiedRole = ctx.guild.roles.cache.get(ROLES_EXISTING.Verified);
    if (!verifiedRole) problems.push(`Verified role ${ROLES_EXISTING.Verified} not found`);
    else if (me.roles.highest.position <= verifiedRole.position) {
        problems.push(`Bot highest (pos ${me.roles.highest.position}) is not above Verified (pos ${verifiedRole.position})`);
    } else {
        log('Q', `role hierarchy OK: bot @ ${me.roles.highest.position}, Verified @ ${verifiedRole.position}`);
    }

    // 3. Bot has Administrator (needed for everything we just configured)
    if (!me.permissions.has(PermissionFlagsBits.Administrator)) problems.push('Bot lacks Administrator');
    else log('Q', 'bot has Administrator ✓');

    // 4. Gate message exists and has a button with customId=verify_accept
    if (vc.length && vc[0].gate_channel_id && vc[0].gate_message_id) {
        try {
            const gate = await ctx.guild.channels.fetch(vc[0].gate_channel_id);
            const msg = await gate.messages.fetch(vc[0].gate_message_id);
            const customIds = [];
            for (const row of msg.components || []) {
                for (const btn of row.components || []) {
                    if (btn.customId) customIds.push(btn.customId);
                }
            }
            if (!customIds.includes('verify_accept')) problems.push(`gate message components lack verify_accept (have: ${customIds.join(',') || 'none'})`);
            else log('Q', `gate message buttons: ${customIds.join(', ')} ✓`);
        } catch (e) {
            problems.push(`gate message fetch failed: ${e.message}`);
        }
    }

    // 5. Check new roles all exist
    for (const [name, id] of Object.entries(state.roles)) {
        const r = ctx.guild.roles.cache.get(id);
        if (!r) problems.push(`role ${name} (${id}) missing`);
    }

    // 6. Check new channels all exist
    for (const [name, id] of Object.entries(state.channels)) {
        const c = ctx.guild.channels.cache.get(id);
        if (!c) problems.push(`channel ${name} (${id}) missing`);
    }

    if (problems.length) {
        log('Q', `FAIL: ${problems.length} problem(s):`);
        for (const p of problems) log('Q', `  - ${p}`);
        throw new Error('Smoke test failed — aborting before lockdown');
    }
    log('Q', 'all checks passed ✓');
}

async function phaseD(ctx) {
    log('D', 'Locking down the server');

    const everyone = ctx.guild.roles.everyone;
    const verifiedRole = ctx.guild.roles.cache.get(ROLES_EXISTING.Verified);
    const beta = ctx.guild.roles.cache.get(ROLES_EXISTING.Beta);
    const musicRole = ctx.guild.roles.cache.get(state.roles.Music);
    const shoutoutRole = ctx.guild.roles.cache.get(state.roles.ShoutoutEligible);

    const gateId = state.channels.welcomeAndRules;
    const adminLogsCategoryId = state.channels.adminLogsCategory;
    const ticketCategoryId = state.channels.ticketCategory;
    const musicChId = state.channels.music;
    const streamSignupChId = state.channels.streamSignup;

    // Map game channel ID -> game role ID
    const gameChannelRoles = new Map([
        [CHANNELS_EXISTING.arcRaiders, state.roles.ArcRaiders],
        [CHANNELS_EXISTING.callOfDuty, state.roles.CallOfDuty],
        [CHANNELS_EXISTING.horrorGames, state.roles.HorrorGames],
        [CHANNELS_EXISTING.marvel, state.roles.Marvel],
        [CHANNELS_EXISTING.wow, state.roles.WorldOfWarcraft],
        [CHANNELS_EXISTING.fortnite, state.roles.Fortnite],
    ]);

    // First: try once more to delete legacy #pac-rules now that Community settings have propagated.
    const legacyRules = ctx.guild.channels.cache.get(CHANNELS_EXISTING.pacRules);
    if (legacyRules) {
        try {
            await legacyRules.delete('Pac migration: merged into #welcome-and-rules');
            log('D', 'deleted legacy #pac-rules');
        } catch (e) {
            // Still blocked? Rename + hide so it's invisible.
            await legacyRules.setName('legacy-rules-archive').catch(() => {});
            await legacyRules.permissionOverwrites.edit(everyone, { ViewChannel: false }).catch(() => {});
            await legacyRules.permissionOverwrites.edit(verifiedRole, { ViewChannel: false }).catch(() => {});
            await legacyRules.permissionOverwrites.edit(beta, { ViewChannel: true }).catch(() => {});
            log('D', `could not delete legacy rules (${e.message}); renamed+hidden instead`);
        }
    }

    // Gate channel: @everyone sees it, can NOT send. Verified can't send either — read-only rules.
    await ctx.guild.channels.cache.get(gateId).permissionOverwrites.set([
        { id: everyone.id,        allow: [PermissionFlagsBits.ViewChannel], deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions] },
        { id: verifiedRole.id,    deny:  [PermissionFlagsBits.SendMessages] },
    ], 'Pac lockdown: gate channel read-only');
    log('D', 'gate channel locked read-only for everyone');

    // Walk every channel/category and set the default @everyone deny + Verified allow,
    // except the gate channel and channels that have role-gated overrides below.
    const allChans = Array.from(ctx.guild.channels.cache.values());
    const specialOverrideIds = new Set([
        gateId,
        musicChId,
        adminLogsCategoryId,
        ticketCategoryId,
        ...gameChannelRoles.keys(),
    ]);

    let touched = 0;
    for (const ch of allChans) {
        if (specialOverrideIds.has(ch.id)) continue;
        // Also skip children of admin-logs and tickets — they'll inherit category perms
        if (ch.parentId === adminLogsCategoryId || ch.parentId === ticketCategoryId) continue;

        try {
            await ch.permissionOverwrites.edit(everyone,     { ViewChannel: false }, { reason: 'Pac lockdown baseline' });
            await ch.permissionOverwrites.edit(verifiedRole, { ViewChannel: true  }, { reason: 'Pac lockdown baseline' });
            touched++;
        } catch (e) {
            log('D', `  failed ${ch.name}: ${e.message}`);
        }
    }
    log('D', `applied @everyone deny + Verified allow to ${touched} channels`);

    // Game channels: @everyone deny, Verified deny (override), specific game role allow
    for (const [channelId, gameRoleId] of gameChannelRoles) {
        const ch = ctx.guild.channels.cache.get(channelId);
        if (!ch) continue;
        await ch.permissionOverwrites.edit(everyone,     { ViewChannel: false }, { reason: 'Game channel gate' });
        await ch.permissionOverwrites.edit(verifiedRole, { ViewChannel: false }, { reason: 'Game channel gate' });
        await ch.permissionOverwrites.edit(gameRoleId,   { ViewChannel: true  }, { reason: 'Game channel gate' });
    }
    log('D', `game channels gated (${gameChannelRoles.size})`);

    // Music channel: requires @Music role
    const musicCh = ctx.guild.channels.cache.get(musicChId);
    await musicCh.permissionOverwrites.edit(everyone,     { ViewChannel: false }, { reason: 'Music role gate' });
    await musicCh.permissionOverwrites.edit(verifiedRole, { ViewChannel: false }, { reason: 'Music role gate' });
    await musicCh.permissionOverwrites.edit(musicRole,    { ViewChannel: true  }, { reason: 'Music role gate' });
    log('D', 'music channel gated to @Music');

    // Stream signup channel: visible to all verified; level check enforced by the button handler.
    // (Baseline already applied via the main walk above.)

    // Admin Logs category: deny @everyone + Verified, allow Beta — children inherit sync
    const adminLogsCat = ctx.guild.channels.cache.get(adminLogsCategoryId);
    await adminLogsCat.permissionOverwrites.set([
        { id: everyone.id,     deny:  [PermissionFlagsBits.ViewChannel] },
        { id: verifiedRole.id, deny:  [PermissionFlagsBits.ViewChannel] },
        { id: beta.id,         allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
    ], 'Pac lockdown: admin logs staff-only');
    // Force-sync children to the category perms
    for (const child of allChans.filter(c => c.parentId === adminLogsCategoryId)) {
        await child.lockPermissions().catch(() => {});
    }
    log('D', 'admin logs category gated to @Beta');

    // Support Tickets category: hide from @everyone + Verified; Beta sees the panel channel.
    const ticketCat = ctx.guild.channels.cache.get(ticketCategoryId);
    await ticketCat.permissionOverwrites.set([
        { id: everyone.id,     deny: [PermissionFlagsBits.ViewChannel] },
        { id: verifiedRole.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: beta.id,         allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory] },
    ], 'Pac lockdown: ticket category staff-only');
    // The ticket panel channel itself should be visible to all Verified members so they can click the button.
    const ticketPanelCh = ctx.guild.channels.cache.get(state.channels.ticketsPanel);
    await ticketPanelCh.permissionOverwrites.edit(everyone,     { ViewChannel: false }, { reason: 'Pac lockdown' });
    await ticketPanelCh.permissionOverwrites.edit(verifiedRole, { ViewChannel: true  }, { reason: 'Pac lockdown: let verified see ticket panel' });
    await ticketPanelCh.permissionOverwrites.edit(beta,         { ViewChannel: true  }, { reason: 'Pac lockdown: staff access' });
    log('D', 'ticket category gated; panel channel visible to all verified');

    log('D', 'lockdown complete');
}

async function main() {
    const client = await connectClient();
    const pool = createPool();
    const guild = await getGuild(client);
    const ctx = { client, pool, guild };
    log('main', `logged in as ${client.user.tag}`);
    const phases = process.argv.slice(2).length ? process.argv.slice(2) : ['Q', 'D'];
    const handlers = { Q: phaseQ, D: phaseD };
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

main().catch(err => { console.error('FATAL', err?.stack || err); process.exit(1); });
