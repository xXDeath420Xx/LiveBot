// Phase B — channel scaffolding + DB config rows.
// Principle: use existing Lair channels where they exist, create only infra that's missing.
import 'dotenv/config';
import fs from 'fs';
import mysql from 'mysql2/promise';

const GUILD = '1216126780767731722';
const token = process.env.DISCORD_TOKEN;
const H = { Authorization: 'Bot ' + token, 'Content-Type': 'application/json' };
const pool = mysql.createPool({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });

const roleIds = JSON.parse(fs.readFileSync('/home/death/CertiFriedUtility/scripts/lair/role-ids.json', 'utf8'));
const recon = JSON.parse(fs.readFileSync('/home/death/CertiFriedUtility/scripts/lair/recon.json', 'utf8'));

// ── Existing channels we're binding to (from recon) ──
const CH = {
    rules:          '1216603920542208000', // #welcome-and-rules-channel
    newFamily:      '1216126782131142657', // #lair-bear-waves-n-welcomes
    birthdays:      '1276691164598370346', // #bearthday-channel
    announcements:  '1219872594120020018', // #sleuth-announcements
    mainChat:       '1216612880829513758', // #lair-bear-chitchat
    nsfwMamaBear:   '1445876475546046494', // #🐻hey-mama-bear🐻 (NSFW)
    nsfwLgbtqia:    '1269894299420463146', // #lgbtqia-chat-and-discussion (NSFW)
    nsfwJoke:       '1366149462132527176', // #tell-us-a-joke-nsfw (NSFW)
    nsfwVoiceCave2: '1216126782131142661', // Voice Cave 2 (NSFW)
    mamaBearLive:   '1457561921585942588', // #🐻mama-bear-is-live — MamaBear's personal shoutout channel
    whosLiveNow:    '1457540221452423271', // #🎮whos-streaming-now — general stream channel
    selfPromoAff:   '1457541374424387768', // #self-promotion-and-shoutouts — affiliates
    selfPromoNonAff:'1457561697857568900', // #reaching-for-affiliate-streamers — non-affiliates
    musicJamz:      '1235687674300338178', // #music-jamz
    suggestionBox:  '1220217633857732779', // #the-suggestion-box
    newGameSugg:    '1266862595051356274', // #new-game-suggestions
    streamTechHelp: '1232726253237178399', // #stream-tech-help
    modbearChat:    '1228385140346982451', // #modbear-chat
    modbearServerActivity: '1367953814694662184', // #server-activity-channel-modbears-only (MEE6 was posting here)
    modbearHelp:    '1367984616035713065', // #mama-and-the-modbears-help
    bulletinBoard:  '1222217013888417902', // #mama-bears-bulletin-board
};

async function rest(method, url, body) {
    const r = await fetch(url, { method, headers: H, body: body && JSON.stringify(body) });
    if (!r.ok) { const txt = await r.text(); throw new Error(`${method} ${url}: ${r.status} ${txt}`); }
    return r.status === 204 ? null : r.json();
}

// ─────────── STEP 1: Create Admin Logs category + 6 log channels (staff-only) ───────────
console.log('\n== Admin Logs category + 6 log channels ==');
const MODBEARS = roleIds['ModBears'];
const BOT_MANAGER = roleIds['Bot Manager'];
const MAMA = roleIds['Mama Bear'];
const COOWNER = roleIds['Co-Owner/Admin'];
const LEAD = roleIds['Lead ModBear'];
const VIEW = 1n << 10n;
const READ_HIST = 1n << 16n;
const STAFF_OVERWRITES = [
    { id: GUILD,        type: 0, allow: '0',                           deny: String(VIEW) },
    { id: MODBEARS,     type: 0, allow: String(VIEW | READ_HIST),      deny: '0' },
    { id: LEAD,         type: 0, allow: String(VIEW | READ_HIST),      deny: '0' },
    { id: COOWNER,      type: 0, allow: String(VIEW | READ_HIST),      deny: '0' },
    { id: MAMA,         type: 0, allow: String(VIEW | READ_HIST),      deny: '0' },
    { id: BOT_MANAGER,  type: 0, allow: String(VIEW | READ_HIST),      deny: '0' },
];

let adminLogsCat = recon.channels.find(c => c.type === 4 && c.name.toLowerCase().includes('admin log'));
if (!adminLogsCat) {
    adminLogsCat = await rest('POST', `https://discord.com/api/v10/guilds/${GUILD}/channels`, {
        name: '✦ ━━━  ADMIN LOGS  ━━━ ✦', type: 4, permission_overwrites: STAFF_OVERWRITES,
    });
    console.log('  created category:', adminLogsCat.id);
} else {
    console.log('  admin logs category already exists:', adminLogsCat.id);
}
const LOG_CHANNELS = [
    { name: '👥┃member-log',  key: 'memberLog' },
    { name: '✉️┃message-log', key: 'messageLog' },
    { name: '⚖️┃mod-log',     key: 'modLog' },
    { name: '🎙️┃voice-log',   key: 'voiceLog' },
    { name: '📁┃channel-log', key: 'channelLog' },
    { name: '🔖┃role-log',    key: 'roleLog' },
];
const logCh = {};
for (const c of LOG_CHANNELS) {
    const existing = recon.channels.find(x => x.type === 0 && x.name === c.name && x.parent_id === adminLogsCat.id);
    if (existing) { logCh[c.key] = existing.id; console.log(`  exists: ${c.name}`); continue; }
    const newCh = await rest('POST', `https://discord.com/api/v10/guilds/${GUILD}/channels`, {
        name: c.name, type: 0, parent_id: adminLogsCat.id,
    });
    logCh[c.key] = newCh.id;
    console.log(`  created: ${c.name} → ${newCh.id}`);
}

// ─────────── STEP 2: Create #stream-signup (above existing stream channels) ───────────
console.log('\n== #stream-signup ==');
const streamCat = recon.channels.find(c => c.type === 4 && /stream/i.test(c.name));
let streamSignup = recon.channels.find(c => c.name.includes('stream-signup'));
if (!streamSignup && streamCat) {
    streamSignup = await rest('POST', `https://discord.com/api/v10/guilds/${GUILD}/channels`, {
        name: '📡┃stream-signup', type: 0, parent_id: streamCat.id,
        topic: 'Reach level 3 then paste your stream URL here — auto-signs up for shoutouts.',
    });
    console.log('  created stream-signup:', streamSignup.id);
} else {
    console.log('  exists or skipped:', streamSignup?.id || 'no stream category found');
}

// ─────────── STEP 3: Create #roles self-assignment channel ───────────
console.log('\n== #roles ==');
const entranceCat = recon.channels.find(c => c.type === 4 && /entrance|welcome/i.test(c.name)) || recon.channels.find(c => c.type === 4);
let rolesCh = recon.channels.find(c => c.name === '🎭┃roles' || c.name === 'roles');
if (!rolesCh && entranceCat) {
    rolesCh = await rest('POST', `https://discord.com/api/v10/guilds/${GUILD}/channels`, {
        name: '🎭┃roles', type: 0, parent_id: entranceCat.id, topic: 'Pick up your color, game, and notification roles here.',
    });
    console.log('  created roles channel:', rolesCh.id);
} else {
    console.log('  roles channel exists:', rolesCh?.id);
}

// ─────────── STEP 4: Create Lair-branded #music if music-jamz insufficient ───────────
console.log('\n== #music ==');
let musicCh = recon.channels.find(c => c.name === '🎵┃music');
if (!musicCh) {
    // Reuse music-jamz but also create a dedicated #music for the panel (keeps chatter separate)
    const mainLair = recon.channels.find(c => c.type === 4 && c.name === 'The Main Lair');
    musicCh = await rest('POST', `https://discord.com/api/v10/guilds/${GUILD}/channels`, {
        name: '🎵┃music', type: 0, parent_id: mainLair?.id, topic: 'Music playback panel. Pick up the Music role in #roles to get here.',
    });
    console.log('  created music channel:', musicCh.id);
} else {
    console.log('  music channel exists:', musicCh.id);
}

// Write state file
const state = {
    channels: {
        rules: CH.rules, newFamily: CH.newFamily, birthdays: CH.birthdays, announcements: CH.announcements,
        streamSignup: streamSignup?.id, rolesCh: rolesCh?.id, music: musicCh?.id, bulletinBoard: CH.bulletinBoard,
        mamaBearLive: CH.mamaBearLive, whosLiveNow: CH.whosLiveNow,
        selfPromoAff: CH.selfPromoAff, selfPromoNonAff: CH.selfPromoNonAff,
        suggestionBox: CH.suggestionBox, modbearHelp: CH.modbearHelp,
        adminLogsCategory: adminLogsCat.id, ...logCh,
    },
    roles: roleIds,
};
fs.writeFileSync('/home/death/CertiFriedUtility/scripts/lair/state.json', JSON.stringify(state, null, 2));
console.log('\nwrote state.json');

// ─────────── STEP 5: CertiFried DB configs ───────────
console.log('\n== DB: CertiFried configs ==');

// 1. verify_config
await pool.execute(`
    CREATE TABLE IF NOT EXISTS verify_config (
        guild_id VARCHAR(20) PRIMARY KEY, verified_role_id VARCHAR(20) NOT NULL,
        unverified_role_id VARCHAR(20) NULL, gate_channel_id VARCHAR(20) NULL,
        gate_message_id VARCHAR(20) NULL, enabled TINYINT(1) NOT NULL DEFAULT 1,
        unverified_kick_days INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
await pool.execute(`
    INSERT INTO verify_config (guild_id, verified_role_id, unverified_role_id, gate_channel_id, enabled, unverified_kick_days)
    VALUES (?, ?, ?, ?, 1, 7)
    ON DUPLICATE KEY UPDATE verified_role_id = VALUES(verified_role_id), unverified_role_id = VALUES(unverified_role_id),
        gate_channel_id = VALUES(gate_channel_id), enabled = 1, unverified_kick_days = 7`,
    [GUILD, roleIds['Verified'], roleIds['Unverified'], CH.rules]);
console.log('  verify_config ✓');

// 2. welcome_settings
await pool.execute(`
    INSERT INTO welcome_settings (guild_id, channel_id, message, banner_enabled, card_title_text, card_subtitle_text)
    VALUES (?, ?, ?, 1, ?, ?)
    ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), message = VALUES(message), banner_enabled = 1,
        card_title_text = VALUES(card_title_text), card_subtitle_text = VALUES(card_subtitle_text)`,
    [GUILD, CH.newFamily,
     '{mention} — read the rules in <#' + CH.rules + '> and click **I accept the rules** to unlock the Lair.',
     '{user}', 'Member #{memberCount} • Mama Bear\'s Lair']);
console.log('  welcome_settings ✓');

// 3. level_config + role rewards
try { await pool.execute('ALTER TABLE level_config ADD COLUMN monthly_reset_enabled TINYINT(1) NOT NULL DEFAULT 0'); } catch (e) { if (!/Duplicate column/i.test(e.message)) throw e; }
try { await pool.execute('ALTER TABLE level_config ADD COLUMN enabled TINYINT(1) NOT NULL DEFAULT 0'); } catch (e) { if (!/Duplicate column/i.test(e.message)) throw e; }
await pool.execute(`
    INSERT INTO level_config (guild_id, xp_per_message, xp_cooldown_seconds, xp_per_voice_minute,
        voice_xp_enabled, level_up_message, level_up_channel_id, enabled, monthly_reset_enabled)
    VALUES (?, 15, 60, 5, 1, 'Roar! {user} just leveled up to **Level {level}**!', ?, 1, 1)
    ON DUPLICATE KEY UPDATE level_up_channel_id = VALUES(level_up_channel_id), level_up_message = VALUES(level_up_message),
        enabled = 1, monthly_reset_enabled = 1`,
    [GUILD, CH.bulletinBoard]);
const rewards = [
    [1, roleIds['Cubs']], [3, roleIds['Shoutout Eligible']], [5, roleIds['Lair Sentinel']],
    [10, roleIds['Lair Hunter']], [15, roleIds['Lair Warrior']], [20, roleIds['Lair Elder']],
    [25, roleIds['Lair Legend']], [30, roleIds['Lair Legacy']],
];
for (const [level, rid] of rewards) {
    await pool.execute('INSERT INTO level_role_rewards (guild_id, level, role_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE role_id = VALUES(role_id)', [GUILD, level, rid]);
}
console.log('  level_config + 8 role rewards ✓');

// 4. birthday_config — already have data imported; just wire channel
await pool.execute(`
    INSERT INTO birthday_config (guild_id, announcement_channel_id, enabled, message_template, cards_enabled, default_card_type)
    VALUES (?, ?, 1, '🎂 Happy birthday, {mention}! The Lair wishes you a great one.', 1, 'classic')
    ON DUPLICATE KEY UPDATE announcement_channel_id = VALUES(announcement_channel_id), enabled = 1,
        message_template = VALUES(message_template), cards_enabled = 1`,
    [GUILD, CH.birthdays]);
console.log('  birthday_config ✓');

// 5. self_promo_config — point at affiliate stream channel, allow all platforms
await pool.execute(`
    INSERT INTO self_promo_config
        (guild_id, enabled, channel_id, allowed_platforms, auto_subscribe, delete_invalid, dm_on_track, dm_on_already_tracked, announcement_channel_id, same_channel)
    VALUES (?, 1, ?, ?, 0, 1, 1, 0, ?, 0)
    ON DUPLICATE KEY UPDATE enabled = 1, channel_id = VALUES(channel_id), allowed_platforms = VALUES(allowed_platforms),
        delete_invalid = 1, announcement_channel_id = VALUES(announcement_channel_id)`,
    [GUILD, CH.selfPromoAff, JSON.stringify(['twitch','kick','youtube','tiktok','trovo','facebook']), CH.whosLiveNow]);
console.log('  self_promo_config ✓');

// 6. stream_signup_config (gated to level 3)
await pool.execute(`
    CREATE TABLE IF NOT EXISTS stream_signup_config (
        guild_id VARCHAR(20) PRIMARY KEY, stream_signup_channel_id VARCHAR(20) NULL,
        stream_announcement_channel_id VARCHAR(20) NOT NULL, stream_signup_message_id VARCHAR(20) NULL,
        level_gate INT NOT NULL DEFAULT 3, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
if (streamSignup?.id) {
    await pool.execute(`
        INSERT INTO stream_signup_config (guild_id, stream_signup_channel_id, stream_announcement_channel_id, level_gate)
        VALUES (?, ?, ?, 3)
        ON DUPLICATE KEY UPDATE stream_signup_channel_id = VALUES(stream_signup_channel_id),
            stream_announcement_channel_id = VALUES(stream_announcement_channel_id), level_gate = 3`,
        [GUILD, streamSignup.id, CH.whosLiveNow]);
    console.log('  stream_signup_config ✓');
}

// 7. ticket_config — wire to existing Created Tickets category
await pool.execute(`
    INSERT INTO ticket_config (guild_id, panel_channel_id, ticket_category_id, support_role_id, log_channel_id, auto_close_hours, use_threads)
    VALUES (?, ?, ?, ?, ?, 72, 0)
    ON DUPLICATE KEY UPDATE panel_channel_id = VALUES(panel_channel_id), ticket_category_id = VALUES(ticket_category_id),
        support_role_id = VALUES(support_role_id), log_channel_id = VALUES(log_channel_id)`,
    [GUILD, CH.modbearHelp, '1368013867203952743', roleIds['ModBears'], logCh.modLog]);
console.log('  ticket_config ✓');

// 8. logging_config + log_event_config (32 events routed)
const enabledEvents = [
    'memberJoin','memberLeave','memberUpdate','messageDelete','messageUpdate','channelPinsUpdate',
    'ban','unban','memberKick','memberTimeout','automodAction','automodRuleCreate','automodRuleUpdate','automodRuleDelete','inviteCreate','inviteDelete',
    'voiceUpdate','channelCreate','channelDelete','channelUpdate','threadCreate','threadDelete','threadUpdate',
    'stageInstanceCreate','stageInstanceDelete','stageInstanceUpdate','scheduledEventCreate','scheduledEventDelete','scheduledEventUpdate',
    'roleCreate','roleDelete','roleUpdate',
];
await pool.execute(`
    INSERT INTO logging_config (guild_id, log_channel_id, enabled, enabled_events)
    VALUES (?, ?, 1, ?)
    ON DUPLICATE KEY UPDATE log_channel_id = VALUES(log_channel_id), enabled = 1, enabled_events = VALUES(enabled_events)`,
    [GUILD, logCh.modLog, JSON.stringify(enabledEvents)]);
await pool.execute('DELETE FROM log_event_config WHERE guild_id = ?', [GUILD]);
const routes = [
    ['memberJoin',logCh.memberLog,'#43B581'],['memberLeave',logCh.memberLog,'#E67E22'],['memberUpdate',logCh.memberLog,'#3498DB'],
    ['messageDelete',logCh.messageLog,'#E74C3C'],['messageUpdate',logCh.messageLog,'#F1C40F'],['channelPinsUpdate',logCh.messageLog,'#3498DB'],
    ['ban',logCh.modLog,'#8B0000'],['unban',logCh.modLog,'#43B581'],['memberKick',logCh.modLog,'#E74C3C'],['memberTimeout',logCh.modLog,'#E67E22'],
    ['automodAction',logCh.modLog,'#9B59B6'],['automodRuleCreate',logCh.modLog,'#43B581'],['automodRuleUpdate',logCh.modLog,'#3498DB'],['automodRuleDelete',logCh.modLog,'#E74C3C'],
    ['inviteCreate',logCh.modLog,'#3498DB'],['inviteDelete',logCh.modLog,'#E67E22'],
    ['voiceUpdate',logCh.voiceLog,'#9B59B6'],
    ['channelCreate',logCh.channelLog,'#43B581'],['channelDelete',logCh.channelLog,'#E74C3C'],['channelUpdate',logCh.channelLog,'#3498DB'],
    ['threadCreate',logCh.channelLog,'#43B581'],['threadDelete',logCh.channelLog,'#E74C3C'],['threadUpdate',logCh.channelLog,'#3498DB'],
    ['stageInstanceCreate',logCh.channelLog,'#43B581'],['stageInstanceDelete',logCh.channelLog,'#E74C3C'],['stageInstanceUpdate',logCh.channelLog,'#3498DB'],
    ['scheduledEventCreate',logCh.channelLog,'#43B581'],['scheduledEventDelete',logCh.channelLog,'#E74C3C'],['scheduledEventUpdate',logCh.channelLog,'#3498DB'],
    ['roleCreate',logCh.roleLog,'#43B581'],['roleDelete',logCh.roleLog,'#E74C3C'],['roleUpdate',logCh.roleLog,'#3498DB'],
];
for (const [evt, ch, color] of routes) {
    await pool.execute('INSERT INTO log_event_config (guild_id, event_type, enabled, log_channel_id, embed_color) VALUES (?, ?, 1, ?, ?)', [GUILD, evt, ch, color]);
}
console.log('  logging_config + ' + routes.length + ' routes ✓');

// 9. Protection stack + global ban + invite filter
await pool.execute(`INSERT INTO anti_nuke_config (guild_id, enabled, max_channel_deletes, max_role_deletes, max_kick_bans, action_on_trigger, alert_channel_id) VALUES (?, 1, 3, 3, 5, 'strip_roles', ?) ON DUPLICATE KEY UPDATE enabled=1, alert_channel_id=VALUES(alert_channel_id)`, [GUILD, logCh.modLog]);
await pool.execute(`INSERT INTO raid_detection_config (guild_id, enabled, join_threshold, join_timeframe_seconds, new_account_age_hours, new_account_ratio, action, alert_channel_id, mute_duration_minutes, purge_messages) VALUES (?, 1, 10, 30, 24, 0.50, 'mute', ?, 60, 1) ON DUPLICATE KEY UPDATE enabled=1, alert_channel_id=VALUES(alert_channel_id)`, [GUILD, logCh.modLog]);
await pool.execute(`INSERT INTO adaptive_spam_config (guild_id, enabled, cross_channel_threshold, cross_channel_timeframe_minutes, deviation_multiplier, new_account_multiplier_7d, new_account_multiplier_24h, action, alert_channel_id) VALUES (?, 1, 5, 2, 3.00, 1.50, 2.00, 'delete+warn', ?) ON DUPLICATE KEY UPDATE enabled=1, alert_channel_id=VALUES(alert_channel_id)`, [GUILD, logCh.modLog]);
try {
    await pool.execute(`INSERT INTO selfbot_detection_config (guild_id, enabled, min_response_time_ms, message_burst_threshold, message_burst_window_ms, pattern_threshold, action, alert_channel_id, mute_duration_minutes, purge_messages) VALUES (?, 1, 300, 6, 2000, 4, 'mute', ?, 30, 1) ON DUPLICATE KEY UPDATE enabled=1, alert_channel_id=VALUES(alert_channel_id)`, [GUILD, logCh.modLog]);
} catch (e) {
    if (/Unknown column/i.test(e.message)) await pool.execute(`INSERT INTO selfbot_detection_config (guild_id, enabled, min_response_time_ms, message_burst_threshold, message_burst_window_ms, pattern_threshold, action, alert_channel_id) VALUES (?, 1, 300, 6, 2000, 4, 'mute', ?) ON DUPLICATE KEY UPDATE enabled=1, alert_channel_id=VALUES(alert_channel_id)`, [GUILD, logCh.modLog]);
    else throw e;
}
await pool.execute(`INSERT INTO phishing_config (guild_id, enabled, action, mute_duration_minutes, alert_channel_id, log_detections, report_channel_id) VALUES (?, 1, 'delete', 60, ?, 1, ?) ON DUPLICATE KEY UPDATE enabled=1, alert_channel_id=VALUES(alert_channel_id), report_channel_id=VALUES(report_channel_id)`, [GUILD, logCh.modLog, logCh.modLog]);
await pool.execute(`INSERT INTO invite_filter_config (guild_id, enabled, use_whitelist, action, log_channel_id) VALUES (?, 1, 0, 'delete_warn', ?) ON DUPLICATE KEY UPDATE enabled=1, action=VALUES(action), log_channel_id=VALUES(log_channel_id)`, [GUILD, logCh.modLog]);
await pool.execute(`INSERT INTO global_ban_config (guild_id, enabled, action_critical, action_high, action_medium, action_low, alert_channel_id, log_actions, check_on_join, check_on_message, auto_aggregate_opt_in) VALUES (?, 1, 'ban', 'ban', 'kick', 'alert', ?, 1, 1, 0, 1) ON DUPLICATE KEY UPDATE enabled=1, alert_channel_id=VALUES(alert_channel_id), check_on_join=1`, [GUILD, logCh.modLog]);
console.log('  protection + global ban + invite filter ✓');

// 10. Moderation, suggestions, auto publisher
// Ensure Muted role applies channel-level denies
const MUTE_DENY = String((1n << 11n) | (1n << 6n) | (1n << 21n) | (1n << 35n) | (1n << 36n));
let mutedApplied = 0;
const allChans = await rest('GET', `https://discord.com/api/v10/guilds/${GUILD}/channels`);
for (const c of allChans) {
    if (![0, 2, 5, 13, 15].includes(c.type)) continue;
    try {
        await rest('PUT', `https://discord.com/api/v10/channels/${c.id}/permissions/${roleIds['Muted']}`, { type: 0, allow: '0', deny: MUTE_DENY });
        mutedApplied++;
    } catch {}
}
console.log(`  Muted role overrides applied to ${mutedApplied} channels`);

await pool.execute(`INSERT INTO moderation_config (guild_id, mod_log_channel_id, muted_role_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE mod_log_channel_id=VALUES(mod_log_channel_id), muted_role_id=VALUES(muted_role_id)`, [GUILD, logCh.modLog, roleIds['Muted']]);
await pool.execute(`INSERT INTO suggestion_config (guild_id, suggestions_channel_id, staff_review_channel_id, min_votes_for_approval, allow_anonymous, require_approval, enabled) VALUES (?, ?, ?, 10, 0, 1, 1) ON DUPLICATE KEY UPDATE suggestions_channel_id=VALUES(suggestions_channel_id), staff_review_channel_id=VALUES(staff_review_channel_id), enabled=1`, [GUILD, CH.suggestionBox, logCh.modLog]);
await pool.execute(`INSERT INTO auto_publisher_config (guild_id, is_enabled) VALUES (?, 1) ON DUPLICATE KEY UPDATE is_enabled=1`, [GUILD]);
console.log('  moderation_config + suggestion_config + auto_publisher_config ✓');

// ─────────── STEP 6: Gate NSFW channels to NSFW Access role ───────────
console.log('\n== NSFW channel gating ==');
const NSFW_ALLOW = String((1n << 10n) | (1n << 11n) | (1n << 16n) | (1n << 6n) | (1n << 14n) | (1n << 15n) | (1n << 18n) | (1n << 37n) | (1n << 38n));
const nsfwChans = recon.channels.filter(c => c.nsfw);
for (const c of nsfwChans) {
    await rest('PUT', `https://discord.com/api/v10/channels/${c.id}/permissions/${GUILD}`, { type: 0, allow: '0', deny: String(VIEW) });
    await rest('PUT', `https://discord.com/api/v10/channels/${c.id}/permissions/${roleIds['NSFW Access']}`, { type: 0, allow: NSFW_ALLOW, deny: '0' });
    console.log(`  gated: #${c.name}`);
}

// ─────────── STEP 7: Gate #music to Music role ───────────
if (musicCh) {
    await rest('PUT', `https://discord.com/api/v10/channels/${musicCh.id}/permissions/${GUILD}`, { type: 0, allow: '0', deny: String(VIEW) });
    await rest('PUT', `https://discord.com/api/v10/channels/${musicCh.id}/permissions/${roleIds['Music']}`, { type: 0, allow: String(VIEW | READ_HIST | (1n << 11n) | (1n << 14n) | (1n << 6n) | (1n << 18n) | (1n << 15n) | (1n << 20n) | (1n << 21n)), deny: '0' });
    console.log('  #music gated to Music role');
}

await pool.end();
console.log('\nDONE');
