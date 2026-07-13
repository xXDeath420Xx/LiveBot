// One-shot orchestrator for tasks #28-#33 in The Bat Cave (Gotham).
// Order is deliberate: anything that grants access runs BEFORE anything that
// removes it.
//
//   1. Backfill Gotham Citizen on every current human  (task #29)
//   2. Security profile — anti-raid + phishing + adaptive spam + anti-nuke  (task #31)
//   3. Logging — moderate (mod/admin/spam/join-leave only)               (task #32)
//   4. Welcome channel + welcome_settings + greeting flow                (task #30)
//   5. Ticket panel in #tech-questions-and-answers                       (task #33)
//   6. Rules reaction-role gate + lock @everyone out of non-public channels  (task #28)
//
// REST-only. Default bot serves this guild.

import 'dotenv/config';
import pool from '../utils/db.js';

const GUILD = '800157336458231848';
const VERIFIED_ROLE = '800252381513777158';        // Gotham Citizen
const RULES_CH      = '800256456997863434';        // #gcpd-handbook-of-rules📖
const CARL_RULES_MSG = '1253544082127585351';      // Carl's old ✅ message
const ANNOUNCE_CH = '1038268111029280778';         // #bats-reccomendations
const TECH_QA_CH  = '1503912714479730799';         // #tech-questions-and-answers
const WELCOME_CATEGORY = '1070157474331623484';
const MOD_RULES_CATEGORY = '800182693945409546';   // 🃏Channel Updates & Mod Rules🃏
const OTHER_CATEGORY = '1034678159418851428';      // 💖 Other Important Channels 💖
const MOD_ROLE = '800180555978506251';             // "The GCPD" — moderator role

const token = process.env.DISCORD_TOKEN;

async function api(method, path, body) {
  await new Promise(r => setTimeout(r, 50));
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method, headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 429) {
    const j = await r.json().catch(() => ({}));
    await new Promise(rs => setTimeout(rs, (j.retry_after || 1) * 1000 + 200));
    return api(method, path, body);
  }
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status}: ${(await r.text()).slice(0, 250)}`);
  return r.status === 204 ? null : r.json();
}

console.log(`=== Gotham full setup ===\n`);

// ─────────────────────────────────────────────────────────────────────────
// 1. BACKFILL GOTHAM CITIZEN ON ALL HUMANS  (task #29)
// ─────────────────────────────────────────────────────────────────────────
console.log('[1/6] Backfilling Gotham Citizen on all current humans…');
let after = '0';
const humans = [];
while (true) {
  const batch = await api('GET', `/guilds/${GUILD}/members?limit=1000&after=${after}`);
  if (!Array.isArray(batch) || batch.length === 0) break;
  for (const m of batch) if (!m.user.bot) humans.push(m);
  if (batch.length < 1000) break;
  after = batch[batch.length - 1].user.id;
}
console.log(`       found ${humans.length} humans`);
let granted = 0, alreadyHad = 0, failed = 0;
for (const m of humans) {
  if (m.roles.includes(VERIFIED_ROLE)) { alreadyHad++; continue; }
  try {
    await api('PUT', `/guilds/${GUILD}/members/${m.user.id}/roles/${VERIFIED_ROLE}`);
    granted++;
  } catch (e) {
    failed++;
    console.log(`         ✗ ${m.user.id} (${m.user.username}): ${e.message.slice(0,100)}`);
  }
}
console.log(`       granted=${granted} alreadyHad=${alreadyHad} failed=${failed}\n`);

// ─────────────────────────────────────────────────────────────────────────
// 2. SECURITY PROFILE  (task #31)
// ─────────────────────────────────────────────────────────────────────────
console.log('[2/6] Applying Twatwaffle-equivalent security profile…');
// We'll need a moderator-alert channel — create #server-logs later in step 3
// and reuse its id. For now, use #mod-chat (1466492477400809493) as alert
// target so security configs are immediately functional.
const ALERT_CH = '1466492477400809493';

// anti_raid_config
await pool.execute(
  `INSERT INTO anti_raid_config (guild_id, is_enabled, join_limit, time_period_seconds, action, alert_channel_id)
   VALUES (?, 1, 10, 20, 'kick', ?)
   ON DUPLICATE KEY UPDATE is_enabled=1, join_limit=VALUES(join_limit), time_period_seconds=VALUES(time_period_seconds), action=VALUES(action), alert_channel_id=VALUES(alert_channel_id)`,
  [GUILD, ALERT_CH]
);
console.log('       anti_raid_config ✓');

// phishing_config
await pool.execute(
  `INSERT INTO phishing_config (guild_id, enabled, action, mute_duration_minutes, alert_channel_id, log_detections, report_channel_id)
   VALUES (?, 1, 'delete', 60, ?, 1, ?)
   ON DUPLICATE KEY UPDATE enabled=1, action=VALUES(action), mute_duration_minutes=VALUES(mute_duration_minutes), alert_channel_id=VALUES(alert_channel_id), log_detections=1, report_channel_id=VALUES(report_channel_id)`,
  [GUILD, ALERT_CH, ALERT_CH]
);
console.log('       phishing_config ✓');

// adaptive_spam_config
await pool.execute(
  `INSERT INTO adaptive_spam_config (guild_id, enabled, cross_channel_threshold, cross_channel_timeframe_minutes, deviation_multiplier, new_account_multiplier_7d, new_account_multiplier_24h, action, alert_channel_id)
   VALUES (?, 1, 5, 2, 3.00, 1.50, 2.00, 'delete+warn', ?)
   ON DUPLICATE KEY UPDATE enabled=1, cross_channel_threshold=VALUES(cross_channel_threshold), cross_channel_timeframe_minutes=VALUES(cross_channel_timeframe_minutes), deviation_multiplier=VALUES(deviation_multiplier), new_account_multiplier_7d=VALUES(new_account_multiplier_7d), new_account_multiplier_24h=VALUES(new_account_multiplier_24h), action=VALUES(action), alert_channel_id=VALUES(alert_channel_id)`,
  [GUILD, ALERT_CH]
);
console.log('       adaptive_spam_config ✓');

// anti_nuke_config
await pool.execute(
  `INSERT INTO anti_nuke_config (guild_id, enabled, max_channel_deletes, max_role_deletes, max_kick_bans, action_on_trigger, alert_channel_id)
   VALUES (?, 1, 3, 3, 5, 'strip_roles', ?)
   ON DUPLICATE KEY UPDATE enabled=1, max_channel_deletes=VALUES(max_channel_deletes), max_role_deletes=VALUES(max_role_deletes), max_kick_bans=VALUES(max_kick_bans), action_on_trigger=VALUES(action_on_trigger), alert_channel_id=VALUES(alert_channel_id)`,
  [GUILD, ALERT_CH]
);
console.log('       anti_nuke_config ✓\n');

// ─────────────────────────────────────────────────────────────────────────
// 3. LOGGING — create #server-logs, configure logging_config            (task #32)
// ─────────────────────────────────────────────────────────────────────────
console.log('[3/6] Creating #server-logs + logging_config…');
const channels = await api('GET', `/guilds/${GUILD}/channels`);
let logsCh = channels.find(c => c.name === 'server-logs' && c.type === 0);
if (!logsCh) {
  logsCh = await api('POST', `/guilds/${GUILD}/channels`, {
    name: 'server-logs',
    type: 0,
    parent_id: MOD_RULES_CATEGORY,
    topic: 'Bot logs — moderation, admin, spam, join/leave. Read by The GCPD.',
    permission_overwrites: [
      { id: GUILD, type: 0, allow: '0', deny: '1024' },       // @everyone deny VIEW
      { id: MOD_ROLE, type: 0, allow: '68608', deny: '0' },   // GCPD allow VIEW + SEND + READ_HISTORY
    ],
  });
  console.log(`       created ${logsCh.id} #server-logs`);
} else {
  console.log(`       reused existing ${logsCh.id} #server-logs`);
}
const LOG_CH = logsCh.id;

// "moderation, admin, spam, join/leave" — explicitly skip channel/role/voice/server/emoji
const MODERATE_EVENTS = JSON.stringify([
  'memberJoin', 'memberLeave', 'memberKick',
  'ban', 'unban', 'memberTimeout', 'memberUpdate',
  'messageDelete', 'messageUpdate',
  // automod / spam (no live tables for automodAction events yet, but harmless)
]);
await pool.execute(
  `INSERT INTO logging_config (guild_id, log_channel_id, enabled_events, enabled)
   VALUES (?, ?, ?, 1)
   ON DUPLICATE KEY UPDATE log_channel_id=VALUES(log_channel_id), enabled_events=VALUES(enabled_events), enabled=1`,
  [GUILD, LOG_CH, MODERATE_EVENTS]
);
console.log(`       logging_config ✓ → #server-logs, events=${JSON.parse(MODERATE_EVENTS).length}\n`);

// ─────────────────────────────────────────────────────────────────────────
// 4. WELCOME CHANNEL + welcome_settings                                (task #30)
// ─────────────────────────────────────────────────────────────────────────
console.log('[4/6] Creating #welcome + welcome_settings…');
let welcomeCh = channels.find(c => c.name === 'welcome' && c.type === 0);
if (!welcomeCh) {
  welcomeCh = await api('POST', `/guilds/${GUILD}/channels`, {
    name: 'welcome',
    type: 0,
    parent_id: WELCOME_CATEGORY,
    topic: 'Welcome aboard! Head to #gcpd-handbook-of-rules to agree to the rules and gain full access.',
    permission_overwrites: [
      // @everyone CAN view + read history but cannot send. (Pre-verified members need to see this.)
      { id: GUILD, type: 0, allow: '66560', deny: '2048' },   // 66560 = VIEW(1024) + READ_HISTORY(65536); deny SEND(2048)
    ],
  });
  console.log(`       created ${welcomeCh.id} #welcome`);
} else {
  console.log(`       reused existing ${welcomeCh.id} #welcome`);
}
const WELCOME_CH = welcomeCh.id;

const WELCOME_MSG = `Welcome to **{server}**, {user}! 🦇\n\nHead over to <#${RULES_CH}> and click **I Agree** to gain full access to the server.\nUntil then you'll see only this channel and the rules.`;
await pool.execute(
  `INSERT INTO welcome_settings (guild_id, channel_id, message, banner_enabled, card_title_text, card_subtitle_text)
   VALUES (?, ?, ?, 1, 'Welcome to {server}!', 'Glad to have you, {user}.')
   ON DUPLICATE KEY UPDATE channel_id=VALUES(channel_id), message=VALUES(message), banner_enabled=1, card_title_text=VALUES(card_title_text), card_subtitle_text=VALUES(card_subtitle_text)`,
  [GUILD, WELCOME_CH, WELCOME_MSG]
);
console.log(`       welcome_settings ✓ → #welcome\n`);

// ─────────────────────────────────────────────────────────────────────────
// 5. TICKET PANEL in #tech-questions-and-answers                       (task #33)
// ─────────────────────────────────────────────────────────────────────────
console.log('[5/6] Creating ticket category + panel in #tech-questions-and-answers…');
let ticketCat = channels.find(c => c.type === 4 && c.name.toLowerCase().includes('ticket'));
if (!ticketCat) {
  ticketCat = await api('POST', `/guilds/${GUILD}/channels`, {
    name: '🎫 Tickets',
    type: 4,
    permission_overwrites: [
      { id: GUILD, type: 0, allow: '0', deny: '1024' },       // @everyone deny VIEW
      { id: MOD_ROLE, type: 0, allow: '378944', deny: '0' },  // GCPD: VIEW + MANAGE_MESSAGES + READ_HISTORY + ATTACH + EMBED
    ],
  });
  console.log(`       created ticket category ${ticketCat.id}`);
} else {
  console.log(`       reused category ${ticketCat.id} (${ticketCat.name})`);
}

const ticketEmbed = {
  type: 'rich',
  title: '🎫 Tech Support',
  description: [
    `Need help? Click **Create Ticket** below and we\'ll spin up a private channel for you and a moderator.`,
    ``,
    `Use this for:`,
    `• Server-related tech help`,
    `• Bug reports`,
    `• Discord / Twitch / streaming setup questions`,
    `• Anything you don\'t want to ask in public chat`,
    ``,
    `A member of **The GCPD** will respond when available.`,
  ].join('\n'),
  color: 0xFEE75C,
};
const ticketButton = {
  type: 1,
  components: [{
    type: 2, style: 1, label: 'Create Ticket',
    emoji: { name: '🎫' },
    custom_id: 'ticket_create',
  }],
};

const [existingPanel] = await pool.execute(
  'SELECT panel_id, panel_message_id FROM ticket_panels WHERE guild_id=? AND panel_channel_id=?',
  [GUILD, TECH_QA_CH]
);
let panelId, panelMsgId;
if (existingPanel.length && existingPanel[0].panel_message_id) {
  panelId = existingPanel[0].panel_id;
  panelMsgId = existingPanel[0].panel_message_id;
  await api('PATCH', `/channels/${TECH_QA_CH}/messages/${panelMsgId}`, {
    embeds: [ticketEmbed],
    components: [ticketButton],
  });
  console.log(`       patched existing panel ${panelId} message ${panelMsgId}`);
} else {
  const msg = await api('POST', `/channels/${TECH_QA_CH}/messages`, {
    embeds: [ticketEmbed],
    components: [ticketButton],
  });
  panelMsgId = msg.id;
  if (existingPanel.length) {
    panelId = existingPanel[0].panel_id;
    await pool.execute(
      `UPDATE ticket_panels SET panel_message_id=?, ticket_category_id=?, support_role_id=?, log_channel_id=?, alert_channel_id=?, embed_title=?, embed_description=?, embed_color=?, button_text=?, button_emoji=?, is_active=1 WHERE panel_id=?`,
      [panelMsgId, ticketCat.id, MOD_ROLE, LOG_CH, ALERT_CH, ticketEmbed.title, ticketEmbed.description, '#FEE75C', 'Create Ticket', '🎫', panelId]
    );
  } else {
    const [ins] = await pool.execute(
      `INSERT INTO ticket_panels (guild_id, panel_name, panel_channel_id, panel_message_id, embed_title, embed_description, embed_color, button_text, button_emoji, ticket_category_id, support_role_id, ticket_name_format, save_transcripts, log_channel_id, alert_channel_id, is_active)
       VALUES (?, 'Tech Support', ?, ?, ?, ?, '#FEE75C', 'Create Ticket', '🎫', ?, ?, 'ticket-{username}', 1, ?, ?, 1)`,
      [GUILD, TECH_QA_CH, panelMsgId, ticketEmbed.title, ticketEmbed.description, ticketCat.id, MOD_ROLE, LOG_CH, ALERT_CH]
    );
    panelId = ins.insertId;
  }
  console.log(`       posted panel ${panelId} → message ${panelMsgId}`);
}
console.log('');

// ─────────────────────────────────────────────────────────────────────────
// 6. RULES REACTION-ROLE GATE + lockdown                               (task #28)
// ─────────────────────────────────────────────────────────────────────────
console.log('[6/6] Rules gate + lockdown — posting new rules message + locking @everyone out…');

// (a) Post / patch the CertiFried-owned rules embed with "I Agree" button
const rulesEmbed = {
  type: 'rich',
  title: '📖 The GCPD Handbook of Rules',
  description: [
    `Welcome to **The Bat Cave**.`,
    ``,
    `Before you can access the rest of the server, please read the rules below and click **I Agree** to receive the **Gotham Citizen** role. Without it, you can only see this channel and <#${WELCOME_CH}>.`,
    ``,
    `**1.** Be respectful. No hate speech, slurs, or harassment.`,
    `**2.** No NSFW outside <#800158750262034453>.`,
    `**3.** No spam, raid attempts, or self-promotion outside permitted channels.`,
    `**4.** No phishing links, scam DMs, or account-compromise attempts.`,
    `**5.** Listen to **The GCPD** and **Bats 🦇**. They're here to keep the cave a good place.`,
    `**6.** Use channels for their intended topic.`,
    `**7.** Discord ToS applies — anything that violates it gets you removed.`,
    ``,
    `*By clicking the button below, you confirm you've read and agree to these rules.*`,
  ].join('\n'),
  color: 0xFFD700,
};
const rulesButton = {
  type: 1,
  components: [{
    type: 2, style: 3, label: 'I Agree',
    emoji: { name: '✅' },
    custom_id: `rr_${VERIFIED_ROLE}`,
  }],
};

// Look for an existing CertiFried-owned rules message; otherwise post
const recentRules = await api('GET', `/channels/${RULES_CH}/messages?limit=20`);
let rulesMsg = recentRules.find(m => m.embeds?.[0]?.title?.includes('GCPD Handbook') && m.author?.bot && m.author.id !== '235148962103951360');
if (rulesMsg) {
  await api('PATCH', `/channels/${RULES_CH}/messages/${rulesMsg.id}`, { content: '', embeds: [rulesEmbed], components: [rulesButton] });
  console.log(`       patched existing rules message ${rulesMsg.id}`);
} else {
  rulesMsg = await api('POST', `/channels/${RULES_CH}/messages`, { embeds: [rulesEmbed], components: [rulesButton] });
  console.log(`       posted new rules message ${rulesMsg.id}`);
}
const RULES_MSG_NEW = rulesMsg.id;

// (b) Insert reaction_role_panels + mapping for the I Agree button
const [existingRulesPanel] = await pool.execute(
  'SELECT id FROM reaction_role_panels WHERE guild_id=? AND channel_id=? AND message_id=?',
  [GUILD, RULES_CH, RULES_MSG_NEW]
);
let rulesPanelId;
if (existingRulesPanel.length) {
  rulesPanelId = existingRulesPanel[0].id;
} else {
  const [ins] = await pool.execute(
    `INSERT INTO reaction_role_panels (guild_id, channel_id, message_id, panel_name, description, embed_color, panel_mode, interaction_type)
     VALUES (?, ?, ?, 'GCPD Rules Agreement', 'I Agree button grants Gotham Citizen', '#FFD700', 'standard', 'button')`,
    [GUILD, RULES_CH, RULES_MSG_NEW]
  );
  rulesPanelId = ins.insertId;
}
const [existingMap] = await pool.execute(
  'SELECT id FROM reaction_role_mappings WHERE panel_id=? AND role_id=?',
  [rulesPanelId, VERIFIED_ROLE]
);
if (!existingMap.length) {
  await pool.execute(
    `INSERT INTO reaction_role_mappings (panel_id, emoji_id, label, button_style, role_id, min_level)
     VALUES (?, '✅', 'I Agree', 'success', ?, NULL)`,
    [rulesPanelId, VERIFIED_ROLE]
  );
}
console.log(`       reaction_role_panels id=${rulesPanelId} + mapping created`);

// (c) Lock down: modify @everyone guild-level role to remove VIEW_CHANNEL.
// All current humans already have Gotham Citizen (which has VIEW_CHANNEL).
// Per-channel allows on rules + welcome will keep those visible.
const roles = await api('GET', `/guilds/${GUILD}/roles`);
const everyoneRole = roles.find(r => r.id === GUILD);
const currentEveryone = BigInt(everyoneRole.permissions);
const VIEW = 1024n, READ_HIST = 65536n;
const newEveryonePerms = currentEveryone & ~VIEW & ~READ_HIST;
if (currentEveryone !== newEveryonePerms) {
  await api('PATCH', `/guilds/${GUILD}/roles/${GUILD}`, { permissions: String(newEveryonePerms) });
  console.log(`       @everyone guild perms ${currentEveryone} → ${newEveryonePerms} (removed VIEW_CHANNEL + READ_MESSAGE_HISTORY)`);
} else {
  console.log('       @everyone guild perms already lack VIEW_CHANNEL');
}

// (d) Make sure rules + welcome are explicitly viewable by @everyone via channel overwrites
async function ensureEveryoneCanView(channelId) {
  const ch = await api('GET', `/channels/${channelId}`);
  const overwrites = (ch.permission_overwrites || []).map(o => ({ id: o.id, type: o.type, allow: o.allow, deny: o.deny }));
  const idx = overwrites.findIndex(o => o.id === GUILD);
  const ALLOW = String(VIEW | READ_HIST);
  if (idx >= 0) {
    overwrites[idx].allow = String(BigInt(overwrites[idx].allow || '0') | VIEW | READ_HIST);
    overwrites[idx].deny  = String(BigInt(overwrites[idx].deny  || '0') & ~(VIEW | READ_HIST));
  } else {
    overwrites.push({ id: GUILD, type: 0, allow: ALLOW, deny: '0' });
  }
  await api('PATCH', `/channels/${channelId}`, { permission_overwrites: overwrites });
}
await ensureEveryoneCanView(RULES_CH);
await ensureEveryoneCanView(WELCOME_CH);
console.log(`       @everyone explicit allow VIEW on #${RULES_CH} (rules) and #${WELCOME_CH} (welcome)`);

// (e) Leave the Carl-bot ✅ message alone — visual continuity. User can purge later if desired.
console.log('       Carl-bot rules message ' + CARL_RULES_MSG + ' left in place for visual continuity; user can purge manually.');

console.log('\n=== Summary ===');
console.log(`Backfill:          granted=${granted}, alreadyHad=${alreadyHad}, failed=${failed} (out of ${humans.length} humans)`);
console.log(`Security:          anti_raid + phishing + adaptive_spam + anti_nuke (alert → #mod-chat)`);
console.log(`Logging:           ${MODERATE_EVENTS.length} events → #server-logs (${LOG_CH})`);
console.log(`Welcome:           #welcome (${WELCOME_CH}) — welcome_settings configured`);
console.log(`Ticket panel:      Tech Support in #tech-questions-and-answers (panel ${panelId})`);
console.log(`Rules gate:        "I Agree" button → Gotham Citizen role (panel ${rulesPanelId})`);
console.log(`Lockdown:          @everyone lost guild-level VIEW + READ_HISTORY; #rules + #welcome explicitly allow`);

await pool.end();
console.log('\nDone.');
