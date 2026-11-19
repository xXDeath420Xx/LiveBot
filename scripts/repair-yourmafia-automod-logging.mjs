/**
 * Repair automod aggression + logging for "Your Mafia" (1475352754682597468).
 *
 * The guild's channels were rebuilt at some point but its config still pointed at the
 * old, now-deleted channel IDs, so every log path silently dead-ended. Separately the
 * anti-spam rule was stored with key names core/automod.js didn't read, so it fell back
 * to a far tighter built-in default (3 similar messages in 30s) than anything configured.
 *
 * Idempotent — safe to re-run. REST-only Discord reads + DB writes, so safe while PM2 runs.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

const GUILD_ID = '1475352754682597468';

// Live channels, verified present via REST at time of writing.
const CH = {
  auditLog:     '1487024639069651024', // 📜・audit-log
  modLogs:      '1487024649819918464', // ⚖️・mod-logs
  automodLogs:  '1487024689959276596', // 🤖・automod-logs
  joinLeaveLog: '1487024703049568308', // 🚪・join-leave-log
};

// Dead channel IDs still referenced by config (deleted from the guild).
const DEAD = new Set(['1475365808644427830', '1475365800465661974']);

// Route each event family to the channel its name implies. Anything not listed
// falls through to logging_config.log_channel_id (the audit log).
const EVENT_ROUTES = [
  [CH.automodLogs,  ['automod', 'automodAction', 'automodTrigger', 'antiSpam', 'spam',
                     'adaptiveSpam', 'adaptiveSpamTrigger', 'linkFilter', 'inviteFilter',
                     'filter', 'heat', 'raid', 'raidDetection', 'selfbot', 'antiNuke']],
  [CH.modLogs,      ['ban', 'unban', 'memberBan', 'memberKick', 'memberTimeout', 'mute',
                     'unmute', 'timeout', 'warn', 'infraction', 'moderation',
                     'moderationBan', 'moderationKick', 'moderationMute', 'moderationWarn',
                     'moderationTimeout', 'moderationUnban', 'moderationUnmute',
                     'guildBanAdd', 'guildBanRemove', 'guildMemberTimeout',
                     'escalationAction']],
  [CH.joinLeaveLog, ['memberJoin', 'memberLeave', 'guildMemberAdd', 'guildMemberRemove']],
];

const log = (...a) => console.log(...a);
let db;

try {
  db = await mysql.createConnection({
    host: process.env.DB_HOST, user: process.env.DB_USER,
    password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
    port: process.env.DB_PORT || 3306,
  });

  // ---- 1. Mod log channel pointed at a deleted channel -------------------------
  const [[mod]] = await db.query(
    'SELECT mod_log_channel_id FROM moderation_config WHERE guild_id = ?', [GUILD_ID]);
  if (!mod) {
    await db.execute(
      'INSERT INTO moderation_config (guild_id, mod_log_channel_id) VALUES (?, ?)',
      [GUILD_ID, CH.modLogs]);
    log(`moderation_config: created -> #mod-logs`);
  } else if (mod.mod_log_channel_id !== CH.modLogs) {
    await db.execute(
      'UPDATE moderation_config SET mod_log_channel_id = ? WHERE guild_id = ?',
      [CH.modLogs, GUILD_ID]);
    log(`moderation_config: ${mod.mod_log_channel_id}` +
        `${DEAD.has(mod.mod_log_channel_id) ? ' (deleted channel)' : ''} -> #mod-logs`);
  } else {
    log('moderation_config: already correct, skipped');
  }

  // ---- 2. logging_config had no row at all, so sendLogEmbed bailed immediately --
  // enabled_events NULL = allow everything, then defer to log_event_config.
  const [[lc]] = await db.query(
    'SELECT log_channel_id, enabled FROM logging_config WHERE guild_id = ?', [GUILD_ID]);
  if (!lc) {
    await db.execute(
      'INSERT INTO logging_config (guild_id, log_channel_id, enabled, enabled_events) VALUES (?, ?, 1, NULL)',
      [GUILD_ID, CH.auditLog]);
    log('logging_config: created -> #audit-log (enabled, all events)');
  } else if (lc.log_channel_id !== CH.auditLog || lc.enabled !== 1) {
    await db.execute(
      'UPDATE logging_config SET log_channel_id = ?, enabled = 1 WHERE guild_id = ?',
      [CH.auditLog, GUILD_ID]);
    log('logging_config: repointed -> #audit-log (enabled)');
  } else {
    log('logging_config: already correct, skipped');
  }

  // ---- 3. Per-event channel overrides ------------------------------------------
  let routed = 0;
  for (const [channelId, events] of EVENT_ROUTES) {
    for (const ev of events) {
      await db.execute(
        `INSERT INTO log_event_config (guild_id, event_type, enabled, log_channel_id)
         VALUES (?, ?, 1, ?)
         ON DUPLICATE KEY UPDATE enabled = 1, log_channel_id = VALUES(log_channel_id)`,
        [GUILD_ID, ev, channelId]);
      routed++;
    }
  }
  log(`log_event_config: routed ${routed} event types across automod/mod/join-leave channels`);

  // ---- 4. Strip dead channel IDs from automod exemptions ------------------------
  const [rules] = await db.query(
    'SELECT id, filter_type, ignored_channels FROM automod_rules WHERE guild_id = ?', [GUILD_ID]);
  for (const r of rules) {
    let ids;
    try { ids = JSON.parse(r.ignored_channels || '[]'); } catch { ids = []; }
    if (!Array.isArray(ids)) ids = [];
    const live = ids.filter(id => !DEAD.has(id));
    if (live.length !== ids.length) {
      await db.execute('UPDATE automod_rules SET ignored_channels = ? WHERE id = ?',
        [JSON.stringify(live), r.id]);
      log(`automod_rules #${r.id} (${r.filter_type}): dropped deleted exempt channel(s)`);
    }
  }

  // ---- 5. Loosen the message-rate spam trigger ----------------------------------
  // checkSpam fires at strictly greater-than, so max_messages 5 meant 6 msgs in 5s
  // earned a 10-minute mute — far too tight for a small, chatty server.
  const [[spam]] = await db.query(
    'SELECT max_messages, time_window FROM automod_spam_config WHERE guild_id = ?', [GUILD_ID]);
  if (spam && (spam.max_messages !== 10 || spam.time_window !== 5)) {
    await db.execute(
      'UPDATE automod_spam_config SET max_messages = 10, time_window = 5 WHERE guild_id = ?',
      [GUILD_ID]);
    log(`automod_spam_config: ${spam.max_messages} msgs/${spam.time_window}s -> 10 msgs/5s`);
  } else {
    log('automod_spam_config: already correct, skipped');
  }

  log('\nDone.');
} catch (err) {
  console.error('FAILED:', err.message);
  process.exitCode = 1;
} finally {
  if (db) await db.end();
}
