// NOTE: Stop PM2 before running this script:
//   pm2 stop CertiFriedUtility && node scripts/setup-guild-1099732505243959407.js [--apply-role] ; pm2 restart CertiFriedUtility
// (The assistant wraps this automatically when running on your behalf.)

import dotenv from 'dotenv';
dotenv.config();
import { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType } from 'discord.js';
import mysql from 'mysql2/promise';

const GUILD_ID = '1099732505243959407';
const BOT_ID = '1409904443125665875';
const TARGET_USER_ID = '365905620060340224';
const TARGET_ROLE_NAME = 'Bot Manager';

const APPLY_ROLE = process.argv.includes('--apply-role');

function hr(label) {
    console.log(`\n═══ ${label} ${'═'.repeat(Math.max(0, 60 - label.length))}`);
}

function sub(label) {
    console.log(`\n── ${label} ──`);
}

function channelTypeIcon(t) {
    switch (t) {
        case ChannelType.GuildText: return '#';
        case ChannelType.GuildVoice: return '🔊';
        case ChannelType.GuildCategory: return '📁';
        case ChannelType.GuildAnnouncement: return '📢';
        case ChannelType.AnnouncementThread: return '📢🧵';
        case ChannelType.PublicThread: return '🧵';
        case ChannelType.PrivateThread: return '🔒🧵';
        case ChannelType.GuildStageVoice: return '🎭';
        case ChannelType.GuildForum: return '💬';
        case ChannelType.GuildMedia: return '🖼️';
        default: return `?(${t})`;
    }
}

const NOTABLE_PERMS = [
    ['Administrator', PermissionFlagsBits.Administrator],
    ['ManageGuild', PermissionFlagsBits.ManageGuild],
    ['ManageRoles', PermissionFlagsBits.ManageRoles],
    ['ManageChannels', PermissionFlagsBits.ManageChannels],
    ['ManageMessages', PermissionFlagsBits.ManageMessages],
    ['ManageWebhooks', PermissionFlagsBits.ManageWebhooks],
    ['BanMembers', PermissionFlagsBits.BanMembers],
    ['KickMembers', PermissionFlagsBits.KickMembers],
    ['ModerateMembers', PermissionFlagsBits.ModerateMembers],
    ['ViewAuditLog', PermissionFlagsBits.ViewAuditLog],
    ['MentionEveryone', PermissionFlagsBits.MentionEveryone],
];

function summarizePerms(bits) {
    const hits = [];
    for (const [name, flag] of NOTABLE_PERMS) {
        if ((bits & flag) === flag) hits.push(name);
    }
    return hits;
}

async function fetchOne(pool, sql, params) {
    try {
        const [rows] = await pool.execute(sql, params);
        return rows[0] || null;
    } catch (e) {
        return { __error: e.code || e.message };
    }
}

async function fetchAll(pool, sql, params) {
    try {
        const [rows] = await pool.execute(sql, params);
        return rows;
    } catch (e) {
        return { __error: e.code || e.message };
    }
}

function describe(result, emptyMsg = '(none)') {
    if (result == null) return emptyMsg;
    if (result.__error) return `(query error: ${result.__error})`;
    if (Array.isArray(result)) return result.length ? JSON.stringify(result, null, 2) : emptyMsg;
    return JSON.stringify(result, null, 2);
}

async function analyze(pool, guild) {
    hr('SERVER');
    console.log(`Name: ${guild.name}`);
    console.log(`ID: ${guild.id}`);
    console.log(`Owner: ${guild.ownerId}`);
    console.log(`Members: ${guild.memberCount}`);
    console.log(`Created: ${guild.createdAt.toISOString().split('T')[0]}`);
    console.log(`Verification: level ${guild.verificationLevel}`);
    console.log(`ExplicitFilter: ${guild.explicitContentFilter}`);
    console.log(`MFALevel: ${guild.mfaLevel}`);
    console.log(`PremiumTier: ${guild.premiumTier} (${guild.premiumSubscriptionCount ?? 0} boosts)`);
    console.log(`Features: ${guild.features.join(', ') || '(none)'}`);
    console.log(`Icon: ${guild.iconURL() || '(none)'}`);
    console.log(`Banner: ${guild.bannerURL() || '(none)'}`);
    console.log(`Splash: ${guild.splashURL() || '(none)'}`);

    hr('BOT SELF-CHECK');
    const me = await guild.members.fetchMe();
    console.log(`Bot: ${me.user.tag} (${me.id})`);
    console.log(`Highest role: ${me.roles.highest.name} [pos ${me.roles.highest.position}, id ${me.roles.highest.id}]`);
    const needed = ['Administrator', 'ManageRoles', 'ManageChannels', 'ManageWebhooks', 'BanMembers', 'KickMembers', 'ManageMessages'];
    for (const p of needed) {
        const has = me.permissions.has(PermissionFlagsBits[p]);
        console.log(`  ${has ? '✓' : '✗'} ${p}`);
    }

    hr('ROLES');
    const roles = guild.roles.cache.sort((a, b) => b.position - a.position);
    console.log(`Total: ${roles.size}`);
    roles.forEach(r => {
        const permHits = summarizePerms(r.permissions.bitfield);
        const flags = [];
        if (r.managed) flags.push('BOT');
        if (r.hoist) flags.push('HOIST');
        if (r.mentionable) flags.push('MENTIONABLE');
        if (r.id === guild.id) flags.push('@everyone');
        const padPos = r.position.toString().padStart(3);
        console.log(`  [${padPos}] ${r.name} (${r.id}) color:${r.hexColor}` +
            (permHits.length ? ` perms:{${permHits.join(',')}}` : '') +
            (flags.length ? ` [${flags.join(',')}]` : ''));
    });

    hr('CATEGORIES & CHANNELS');
    const allChans = guild.channels.cache.sort((a, b) => a.rawPosition - b.rawPosition);
    const categories = allChans.filter(c => c.type === ChannelType.GuildCategory);
    const uncategorized = allChans.filter(c => c.type !== ChannelType.GuildCategory && !c.parentId);
    console.log(`Channels total: ${allChans.size} (${categories.size} categories)`);

    const renderChannel = (c) => `    ${channelTypeIcon(c.type)} ${c.name} (${c.id})` +
        (c.topic ? ` — topic: ${String(c.topic).slice(0, 60)}` : '') +
        (c.nsfw ? ' [NSFW]' : '') +
        (c.rateLimitPerUser ? ` [slow:${c.rateLimitPerUser}s]` : '') +
        ` [ow:${c.permissionOverwrites?.cache.size ?? 0}]`;

    if (uncategorized.size > 0) {
        console.log('\n  [No Category]');
        uncategorized.forEach(c => console.log(renderChannel(c)));
    }

    categories.forEach(cat => {
        const catOw = cat.permissionOverwrites?.cache.size ?? 0;
        console.log(`\n  📁 ${cat.name} (${cat.id}) [ow:${catOw}]`);
        const children = allChans.filter(c => c.parentId === cat.id).sort((a, b) => a.rawPosition - b.rawPosition);
        children.forEach(c => console.log(renderChannel(c)));
    });

    hr('NOTABLE CHANNEL PERMISSION OVERWRITES');
    let flaggedCount = 0;
    allChans.forEach(c => {
        if (!c.permissionOverwrites?.cache?.size) return;
        const flagged = [];
        c.permissionOverwrites.cache.forEach(o => {
            const allowPerms = summarizePerms(o.allow.bitfield);
            const denyPerms = summarizePerms(o.deny.bitfield);
            const everyoneBlocksView = o.id === guild.id &&
                (o.deny.bitfield & PermissionFlagsBits.ViewChannel) === PermissionFlagsBits.ViewChannel;
            if (allowPerms.length || denyPerms.length || everyoneBlocksView) {
                flagged.push({ target: o.id, type: o.type, allow: allowPerms, deny: denyPerms, everyoneBlocksView });
            }
        });
        if (flagged.length) {
            flaggedCount++;
            console.log(`\n  ${channelTypeIcon(c.type)} ${c.name} (${c.id})` + (c.parent ? ` [in ${c.parent.name}]` : ''));
            flagged.forEach(f => {
                const tgt = f.type === 0 ? `role:${f.target}` : `member:${f.target}`;
                const parts = [];
                if (f.everyoneBlocksView) parts.push('HIDDEN-FROM-@EVERYONE');
                if (f.allow.length) parts.push(`allow:{${f.allow.join(',')}}`);
                if (f.deny.length) parts.push(`deny:{${f.deny.join(',')}}`);
                console.log(`    • ${tgt} — ${parts.join(' ')}`);
            });
        }
    });
    if (!flaggedCount) console.log('  (no channels have notable overwrites)');

    hr('WEBHOOKS');
    try {
        const webhooks = await guild.fetchWebhooks();
        if (webhooks.size === 0) console.log('  (none)');
        else webhooks.forEach(w => console.log(`  ${w.name} (${w.id}) channel:${w.channelId} owner:${w.owner?.tag || w.owner?.id || '?'}`));
    } catch (e) {
        console.log('  (cannot fetch — ' + e.message + ')');
    }

    hr('INTEGRATIONS');
    try {
        const integrations = await guild.fetchIntegrations();
        if (integrations.size === 0) console.log('  (none)');
        else integrations.forEach(i => console.log(`  ${i.name} (${i.type}) enabled:${i.enabled} id:${i.id}`));
    } catch (e) {
        console.log('  (cannot fetch — ' + e.message + ')');
    }

    hr('AUTOMOD RULES (native Discord)');
    try {
        const rules = await guild.autoModerationRules.fetch();
        if (rules.size === 0) console.log('  (none)');
        else rules.forEach(r => console.log(`  ${r.name} (${r.id}) enabled:${r.enabled} trigger:${r.triggerType} actions:${r.actions.length}`));
    } catch (e) {
        console.log('  (cannot fetch — ' + e.message + ')');
    }

    hr('EMOJIS & STICKERS');
    console.log(`  Emojis: ${guild.emojis.cache.size} (${guild.emojis.cache.filter(e => e.animated).size} animated)`);
    console.log(`  Stickers: ${guild.stickers.cache.size}`);

    hr('SCHEDULED EVENTS');
    try {
        const events = await guild.scheduledEvents.fetch();
        if (events.size === 0) console.log('  (none)');
        else events.forEach(e => console.log(`  ${e.name} — ${e.status} — starts ${e.scheduledStartAt?.toISOString() || '?'}`));
    } catch (e) {
        console.log('  (cannot fetch)');
    }

    hr('DB — GUILD REGISTRATION');
    sub('guilds');
    console.log(describe(await fetchOne(pool, 'SELECT * FROM guilds WHERE guild_id = ?', [GUILD_ID]), '(not registered)'));
    sub('guild_bot_mapping');
    console.log(describe(await fetchAll(pool, 'SELECT * FROM guild_bot_mapping WHERE guild_id = ?', [GUILD_ID]), '(no custom-bot mapping — default bot serves this guild)'));
    sub('guild_config');
    console.log(describe(await fetchOne(pool, 'SELECT * FROM guild_config WHERE guild_id = ?', [GUILD_ID])));
    sub('guild_settings');
    console.log(describe(await fetchOne(pool, 'SELECT * FROM guild_settings WHERE guild_id = ?', [GUILD_ID])));

    hr('DB — LOGGING');
    sub('logging_config');
    console.log(describe(await fetchOne(pool, 'SELECT * FROM logging_config WHERE guild_id = ?', [GUILD_ID]), '(none configured)'));
    sub('log_event_config');
    console.log(describe(await fetchAll(pool, 'SELECT event_type, enabled, log_channel_id, embed_color FROM log_event_config WHERE guild_id = ? ORDER BY event_type', [GUILD_ID]), '(no per-event overrides)'));
    sub('log_channel_routing');
    console.log(describe(await fetchAll(pool, 'SELECT * FROM log_channel_routing WHERE guild_id = ?', [GUILD_ID])));

    hr('DB — REACTION ROLES');
    const panels = await fetchAll(pool, 'SELECT * FROM reaction_role_panels WHERE guild_id = ?', [GUILD_ID]);
    if (panels && panels.__error) console.log(`(query error: ${panels.__error})`);
    else if (!panels.length) console.log('  (no panels)');
    else {
        for (const p of panels) {
            console.log(`\n  Panel #${p.id}: ${p.panel_name || '(unnamed)'} channel:${p.channel_id} message:${p.message_id} type:${p.interaction_type || '?'}`);
            const mappings = await fetchAll(pool, 'SELECT * FROM reaction_role_mappings WHERE panel_id = ?', [p.id]);
            if (mappings && mappings.__error) console.log(`    (query error: ${mappings.__error})`);
            else if (!mappings.length) console.log('    (empty panel)');
            else mappings.forEach(m => console.log(`    → role:${m.role_id} emoji:${m.emoji_id || m.emoji || '?'} label:${m.label || ''}`));
        }
    }

    hr('DB — TICKETS');
    sub('ticket_panels');
    console.log(describe(await fetchAll(pool, 'SELECT * FROM ticket_panels WHERE guild_id = ?', [GUILD_ID]), '(no ticket panels)'));
    sub('ticket_config');
    console.log(describe(await fetchOne(pool, 'SELECT * FROM ticket_config WHERE guild_id = ?', [GUILD_ID])));

    hr('DB — PROTECTION / SECURITY');
    sub('anti_nuke_config');
    console.log(describe(await fetchOne(pool, 'SELECT * FROM anti_nuke_config WHERE guild_id = ?', [GUILD_ID]), '(none configured)'));
    sub('anti_nuke_whitelist');
    console.log(describe(await fetchAll(pool, 'SELECT * FROM anti_nuke_whitelist WHERE guild_id = ?', [GUILD_ID]), '(empty)'));
    sub('phishing_config');
    console.log(describe(await fetchOne(pool, 'SELECT * FROM phishing_config WHERE guild_id = ?', [GUILD_ID]), '(none configured)'));
    sub('raid_detection_config');
    console.log(describe(await fetchOne(pool, 'SELECT * FROM raid_detection_config WHERE guild_id = ?', [GUILD_ID]), '(none configured)'));
    sub('raid_protection_config');
    console.log(describe(await fetchOne(pool, 'SELECT * FROM raid_protection_config WHERE guild_id = ?', [GUILD_ID]), '(none configured)'));
    sub('anti_raid_config');
    console.log(describe(await fetchOne(pool, 'SELECT * FROM anti_raid_config WHERE guild_id = ?', [GUILD_ID]), '(none configured)'));
    sub('selfbot_detection_config');
    console.log(describe(await fetchOne(pool, 'SELECT * FROM selfbot_detection_config WHERE guild_id = ?', [GUILD_ID]), '(none configured)'));
    sub('adaptive_spam_config');
    console.log(describe(await fetchOne(pool, 'SELECT * FROM adaptive_spam_config WHERE guild_id = ?', [GUILD_ID]), '(none configured)'));
    sub('automod_spam_config');
    console.log(describe(await fetchOne(pool, 'SELECT * FROM automod_spam_config WHERE guild_id = ?', [GUILD_ID]), '(none configured)'));

    hr('DB — MISC FEATURE CONFIGS');
    sub('welcome_settings');
    console.log(describe(await fetchOne(pool, 'SELECT * FROM welcome_settings WHERE guild_id = ?', [GUILD_ID]), '(none configured)'));
    sub('stat_display_channels');
    console.log(describe(await fetchAll(pool, 'SELECT * FROM stat_display_channels WHERE guild_id = ?', [GUILD_ID])));
    sub('birthday_config');
    console.log(describe(await fetchOne(pool, 'SELECT * FROM birthday_config WHERE guild_id = ?', [GUILD_ID]), '(none configured)'));
    sub('auto_responses');
    console.log(describe(await fetchAll(pool, 'SELECT id, trigger_type, trigger_pattern, enabled FROM auto_responses WHERE guild_id = ?', [GUILD_ID])));
    sub('self_promo_config');
    console.log(describe(await fetchOne(pool, 'SELECT * FROM self_promo_config WHERE guild_id = ?', [GUILD_ID]), '(none configured)'));
    sub('giveaways (active)');
    console.log(describe(await fetchAll(pool, 'SELECT id, prize, winners, end_time, ended FROM giveaways WHERE guild_id = ? AND ended = 0', [GUILD_ID]), '(none active)'));

    hr('DB — EMBEDS');
    sub('custom_embeds');
    const ce = await fetchAll(pool, 'SELECT * FROM custom_embeds WHERE guild_id = ?', [GUILD_ID]);
    if (Array.isArray(ce)) {
        if (!ce.length) console.log('(none)');
        else console.log(ce.map(r => ({ id: r.id, channel_id: r.channel_id, message_id: r.message_id, name: r.embed_name || r.name || r.title || null })));
    } else console.log(describe(ce));
    sub('saved_embeds');
    console.log(describe(await fetchAll(pool, 'SELECT * FROM saved_embeds WHERE guild_id = ?', [GUILD_ID])));

    hr('DB — STREAMING / SUBSCRIPTIONS');
    const subs = await fetchAll(pool, 'SELECT * FROM subscriptions WHERE guild_id = ?', [GUILD_ID]);
    if (Array.isArray(subs)) {
        if (!subs.length) console.log('  (no stream subscriptions)');
        else {
            console.log(`  total: ${subs.length}`);
            const byPlatform = {};
            subs.forEach(s => { byPlatform[s.platform || '?'] = (byPlatform[s.platform || '?'] || 0) + 1; });
            console.log('  by platform:', byPlatform);
            console.log(JSON.stringify(subs.slice(0, 20), null, 2));
            if (subs.length > 20) console.log(`  ... and ${subs.length - 20} more`);
        }
    } else console.log(describe(subs));

    hr('DB — COMMAND RESTRICTIONS');
    const restr = await fetchAll(pool, 'SELECT * FROM guild_command_restrictions WHERE guild_id = ?', [GUILD_ID]);
    if (Array.isArray(restr)) {
        if (!restr.length) console.log('  (no command-level restrictions — all commands default)');
        else {
            const byType = {};
            restr.forEach(r => { (byType[r.restriction_type || r.mode || '?'] ||= []).push(r.command_name); });
            for (const [type, names] of Object.entries(byType)) {
                console.log(`  ${type} (${names.length}): ${names.join(', ')}`);
            }
        }
    } else console.log(describe(restr));

    hr('ANALYSIS COMPLETE');
}

async function applyRole(guild) {
    hr('PHASE 2 — APPLY BOT MANAGER ROLE');

    const me = await guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.Administrator)) {
        throw new Error('Bot lacks Administrator in this guild — cannot create a role with Administrator.');
    }
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
        throw new Error('Bot lacks ManageRoles in this guild — cannot create or assign roles.');
    }

    const botHighest = me.roles.highest;
    console.log(`Bot's highest role: ${botHighest.name} (${botHighest.id}) at position ${botHighest.position}`);

    let member;
    try {
        member = await guild.members.fetch(TARGET_USER_ID);
    } catch (e) {
        throw new Error(`User ${TARGET_USER_ID} is not a member of this guild (or cannot be fetched): ${e.message}`);
    }
    console.log(`Target user: ${member.user.tag} (${member.id})`);

    let role = guild.roles.cache.find(r => r.name === TARGET_ROLE_NAME);
    if (role) {
        console.log(`Role '${TARGET_ROLE_NAME}' already exists: ${role.id} at position ${role.position}. Re-asserting position + membership.`);
    } else {
        console.log(`Creating role '${TARGET_ROLE_NAME}' with Administrator…`);
        role = await guild.roles.create({
            name: TARGET_ROLE_NAME,
            permissions: [PermissionFlagsBits.Administrator],
            color: 0x5865F2,
            hoist: false,
            mentionable: false,
            reason: `CertiFried setup: grant bot management access to ${member.user.tag} (${TARGET_USER_ID})`,
        });
        console.log(`✓ Created: ${role.id}`);
    }

    const desiredPosition = Math.max(1, botHighest.position - 1);
    if (role.position !== desiredPosition) {
        console.log(`Repositioning role to ${desiredPosition} (directly below bot's highest role at ${botHighest.position})…`);
        try {
            await role.setPosition(desiredPosition, { reason: 'CertiFried setup: place Bot Manager directly below bot role' });
            console.log('✓ Repositioned');
        } catch (e) {
            console.log(`⚠  Could not reposition: ${e.message}`);
        }
    } else {
        console.log(`Role already at desired position ${desiredPosition}.`);
    }

    if (!member.roles.cache.has(role.id)) {
        console.log(`Assigning role to ${member.user.tag}…`);
        await member.roles.add(role, 'CertiFried setup: Bot Manager access');
        console.log('✓ Assigned');
    } else {
        console.log('User already has the role.');
    }

    const finalRole = await guild.roles.fetch(role.id, { force: true });
    const finalMember = await guild.members.fetch({ user: TARGET_USER_ID, force: true });
    hr('VERIFICATION');
    console.log(`Role name:       ${finalRole.name}`);
    console.log(`Role id:         ${finalRole.id}`);
    console.log(`Role position:   ${finalRole.position} (bot highest at startup: ${botHighest.position})`);
    console.log(`Role has Administrator: ${finalRole.permissions.has(PermissionFlagsBits.Administrator)}`);
    console.log(`User ${TARGET_USER_ID} has role: ${finalMember.roles.cache.has(finalRole.id)}`);
}

async function main() {
    const pool = mysql.createPool({
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    let client;
    try {
        const token = process.env.DISCORD_TOKEN;
        if (!token) throw new Error('DISCORD_TOKEN missing in env');

        client = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMembers,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.GuildIntegrations,
                GatewayIntentBits.GuildModeration,
                GatewayIntentBits.GuildWebhooks,
                GatewayIntentBits.GuildEmojisAndStickers,
                GatewayIntentBits.GuildScheduledEvents,
            ],
        });

        await client.login(token);
        await new Promise(r => client.once('ready', r));
        console.log(`Logged in as ${client.user.tag} (${client.user.id})`);

        if (client.user.id !== BOT_ID) {
            console.log(`⚠  Logged-in bot id ${client.user.id} does not match expected ${BOT_ID}. Verify DISCORD_TOKEN is for the intended default bot.`);
        }

        const guild = await client.guilds.fetch(GUILD_ID);
        await guild.roles.fetch();
        await guild.channels.fetch();

        await analyze(pool, guild);

        if (APPLY_ROLE) {
            await applyRole(guild);
        } else {
            hr('NEXT STEP');
            console.log('Analysis only (no role changes). Re-run with --apply-role to create/position/assign the Bot Manager role.');
        }
    } finally {
        if (client) {
            try { await client.destroy(); } catch (_) {}
        }
        try { await pool.end(); } catch (_) {}
    }
}

main().catch(err => {
    console.error('\nFATAL:', err && err.stack ? err.stack : err);
    process.exit(1);
});
