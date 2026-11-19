/*
 * Erase a departed member's traces from a server.
 *
 * What this is for: a server that promises "when you leave, your data goes", or that has to honour
 * an erasure request. It reads every readable channel and removes messages belonging to people who
 * are no longer members.
 *
 * WHAT IT DELIBERATELY WILL NOT DO
 *
 * 1. Moderation and ban records are exempt by default. Erasing someone's chat is data hygiene;
 *    erasing WHY they were banned destroys the only record staff have for spotting ban evasion, and
 *    on a server with 185 bans that is not a footnote. `exempt_mod_logs = 0` turns it off, and the
 *    owner has to choose that deliberately.
 *
 * 2. Nothing is deleted without being archived first, into `takeover_archived_messages`. Message
 *    deletion is irreversible and Discord offers no undo; the archive is the receipt. If archiving
 *    fails, the delete does not happen.
 *
 * 3. A member inside the grace window is skipped. Somebody who leaves and rejoins within minutes —
 *    a reconnect, a mis-click, a kick that is immediately reversed — should not have their history
 *    shredded in between.
 *
 * WHAT IT CANNOT DO, and the caller should say so rather than imply otherwise:
 *   • Discord's own guild audit log keeps 90 days and no bot can purge it.
 *   • Messages older than 14 days cannot be bulk-deleted; each is a separate rate-limited call. A
 *     large backfill is therefore slow by construction, not by choice.
 *   • Anything in a channel we cannot read is invisible to this, and is reported as such.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

/** Discord refuses bulk delete for anything older than this. Past it, one call per message. */
const BULK_LIMIT_MS = 14 * 24 * 60 * 60 * 1000;

/** Channels that look like a moderation or ban record. Exempt unless the owner says otherwise. */
const MOD_LOG_RE = /\b(mod|admin|ban|kick|warn|case|infract|audit|punish|discipline)\b|mod-?log|admin-?log/i;

export const DEFAULTS = Object.freeze({
  enabled: 0, on_leave: 1, on_kick: 1, on_ban: 1,
  include_mentions: 0, exempt_mod_logs: 1, archive_before: 1, grace_minutes: 5,
});

export async function getConfig(guildId) {
  const [[row]] = await pool.execute('SELECT * FROM member_purge_config WHERE guild_id = ?', [guildId]);
  return row ?? { guild_id: guildId, ...DEFAULTS, exempt_channels: null };
}

export async function setConfig(guildId, patch) {
  const cur = await getConfig(guildId);
  const next = { ...cur, ...patch };
  await pool.execute(
    `INSERT INTO member_purge_config
       (guild_id, enabled, on_leave, on_kick, on_ban, include_mentions, exempt_mod_logs,
        exempt_channels, archive_before, grace_minutes)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE enabled=VALUES(enabled), on_leave=VALUES(on_leave), on_kick=VALUES(on_kick),
       on_ban=VALUES(on_ban), include_mentions=VALUES(include_mentions), exempt_mod_logs=VALUES(exempt_mod_logs),
       exempt_channels=VALUES(exempt_channels), archive_before=VALUES(archive_before),
       grace_minutes=VALUES(grace_minutes)`,
    [guildId, next.enabled ? 1 : 0, next.on_leave ? 1 : 0, next.on_kick ? 1 : 0, next.on_ban ? 1 : 0,
      next.include_mentions ? 1 : 0, next.exempt_mod_logs ? 1 : 0,
      next.exempt_channels ?? null, next.archive_before ? 1 : 0, Number(next.grace_minutes) || 0]);
  return next;
}

/**
 * The channels a purge may touch, and the ones it must not.
 *
 * Exemption is by NAME and by our own logging routing: a channel our `log_event_config` points
 * moderation events at is a mod log whatever it is called.
 */
export async function channelScope(guild, config) {
  const explicit = new Set(String(config.exempt_channels ?? '').split(',').map(s => s.trim()).filter(Boolean));

  let modRouted = new Set();
  if (config.exempt_mod_logs) {
    const [rows] = await pool.execute(
      `SELECT DISTINCT log_channel_id FROM log_event_config
        WHERE guild_id = ? AND log_channel_id IS NOT NULL
          AND event_type IN ('ban','unban','memberKick','memberTimeout','automod','moderation',
                             'moderationBan','moderationKick','moderationWarn','warn','infraction')`,
      [guild.id]).catch(() => [[]]);
    modRouted = new Set(rows.map(r => r.log_channel_id));
  }

  const usable = [], skipped = [];
  const me = guild.members.me;
  for (const c of guild.channels.cache.values()) {
    if (!c.isTextBased?.()) continue;
    const perms = c.permissionsFor?.(me);
    if (!perms?.has('ViewChannel') || !perms?.has('ReadMessageHistory')) {
      skipped.push({ name: c.name, id: c.id, why: 'cannot read it' });
      continue;
    }
    if (explicit.has(c.id)) { skipped.push({ name: c.name, id: c.id, why: 'exempted by the owner' }); continue; }
    if (config.exempt_mod_logs && (modRouted.has(c.id) || MOD_LOG_RE.test(c.name))) {
      skipped.push({ name: c.name, id: c.id, why: 'moderation record — exempt' });
      continue;
    }
    if (!perms.has('ManageMessages')) {
      skipped.push({ name: c.name, id: c.id, why: 'no Manage Messages — cannot delete here' });
      continue;
    }
    usable.push(c);
  }
  return { usable, skipped };
}

/**
 * Names that are not names.
 *
 * These are single words a log embed uses as a FIELD LABEL, not as somebody's handle — the real
 * embeds here read `… | User | holydabrip420 (842…) | Channel | Toke party`. If a departed member's
 * username were literally "User", matching it by name would hit every log entry in the server.
 *
 * "Deleted User" is deliberately NOT in this list. It is two words, so it does not collide with a
 * field label, and it only ever appears where an account was already deleted when the entry was
 * written — which is exactly the trace that should be cleaned up. Its own records still match by id
 * as well; this only governs the name path.
 */
const GENERIC_NAMES = /^(unknown[ _-]?user|unknown|user|member|someone|none|n\/a)$/i;

/** Every word an embed carries, flattened — a log entry keeps its subject in here, not in `content`. */
function embedText(msg) {
  const parts = [];
  for (const e of msg.embeds ?? []) {
    parts.push(e.title, e.description, e.author?.name, e.footer?.text, e.url);
    for (const f of e.fields ?? []) parts.push(f.name, f.value);
  }
  return parts.filter(Boolean).join('\n');
}

/**
 * Does this message belong to, or name, one of the users we are purging?
 *
 * `targets` is a Map of id -> username, not a bare id set, and that matters for the whole point of
 * scanning logs. A moderation or join/leave log entry ABOUT somebody is a message posted BY A BOT,
 * with the person named inside an embed — so an author check never fires and a `content` check
 * never fires either, because the content is empty. Scanning five years of log channels while
 * looking only at author and content is pure cost for no result, which is exactly what it was doing.
 */
function matches(msg, targets, includeMentions) {
  if (targets.has(msg.author?.id)) return 'author';

  // The id, wherever it appears: a mention, an embed footer, a "User ID: 123" field. An id is exact,
  // so this is safe to check whether or not mentions are in scope.
  const haystack = `${msg.content ?? ''}\n${embedText(msg)}`;
  for (const id of targets.keys()) {
    if (haystack.includes(id)) return 'record';
  }

  if (!includeMentions) return null;

  if (msg.mentions?.users?.some?.(u => targets.has(u.id))) return 'mention';

  // A username, only inside an embed, and only bounded. Names are not unique and a bare substring
  // sweep would delete somebody else's message for containing a common word.
  const embeds = embedText(msg);
  if (embeds) {
    for (const name of targets.values()) {
      if (!name || name.length < 3) continue;
      // A field label is not a handle — see GENERIC_NAMES. A deleted account IS purgeable: it is
      // gone from the server by definition, and its leftovers are the point of this feature.
      if (GENERIC_NAMES.test(name)) continue;
      const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|[^a-z0-9_])${esc}([^a-z0-9_]|$)`, 'i').test(embeds)) return 'named';
    }
  }
  return null;
}

/** Keep the receipt. A delete that was never archived does not happen. */
async function archive(guildId, msg) {
  await pool.execute(
    `INSERT INTO takeover_archived_messages
       (guild_id, channel_id, message_id, author_id, author_name, content, embeds, reactions)
     VALUES (?,?,?,?,?,?,?,?)`,
    [guildId, msg.channelId, msg.id, msg.author?.id ?? null, msg.author?.username ?? null,
      msg.content ?? '', JSON.stringify(msg.embeds ?? []), JSON.stringify([])]);
}

/**
 * Walk every in-scope channel and act on matching messages.
 *
 * `dryRun` reads and counts and touches nothing — and it is the default everywhere, because the
 * live version of this is not reversible.
 */
export async function run(guild, targets, {
  dryRun = true, jobId = null, config = null, onProgress = null, signal = null, maxAgeDays = null,
  resumeFrom = null, carry = null,
} = {}) {
  const cfg = config ?? await getConfig(guild.id);
  // Accepts a Map(id -> name), or a plain list of ids when no names are known.
  const ids = targets instanceof Map ? targets : new Map([...targets].map(id => [String(id), null]));
  const cutoff = maxAgeDays ? Date.now() - maxAgeDays * 86_400_000 : null;
  const { usable, skipped } = await channelScope(guild, cfg);

  // Channels this job already finished before it was interrupted. A full-history run is hours long
  // and gets restarted for reasons that have nothing to do with it; starting over each time means
  // never finishing.
  const done = new Set(resumeFrom ?? []);

  // Why each message matched. An exact id is certain; a username inside an embed is an inference,
  // and before deleting thirteen thousand messages somebody should be able to see the split.
  //
  // A resumed job carries the totals it had already reached. The per-channel loop writes these
  // straight over the job row, so starting them at zero would report a resumed run as having
  // deleted only what the LAST attempt deleted — eleven thousand messages that really are gone
  // silently unaccounted for, and a final report that understates what was destroyed.
  const stats = {
    found: carry?.found ?? 0, deleted: carry?.deleted ?? 0, failed: carry?.failed ?? 0,
    scanned: carry?.scanned ?? 0,
    byChannel: [], skipped, tooOldForBulk: 0,
    resumed: done.size, byReason: { author: 0, record: 0, mention: 0, named: 0 },
  };
  if (jobId) {
    await pool.execute("UPDATE member_purge_jobs SET channels_total=?, phase='purge' WHERE id=?",
      [usable.length, jobId]);
  }

  for (const [i, channel] of usable.entries()) {
    if (signal?.cancelled) break;
    if (done.has(channel.id)) continue;
    let before, found = 0, deleted = 0, failed = 0;

    let scanned = 0, reachedCutoff = false, reportedAt = 0;
    for (;;) {
      if (signal?.cancelled) break;
      const page = await channel.messages.fetch({ limit: 100, ...(before && { before }) }).catch(() => null);
      if (!page?.size) break;

      // Oldest-first within the page tells us when we have gone past the window.
      if (cutoff && page.last().createdTimestamp < cutoff) reachedCutoff = true;

      for (const msg of page.values()) {
        if (cutoff && msg.createdTimestamp < cutoff) continue;
        const why = matches(msg, ids, cfg.include_mentions);
        if (!why) continue;
        stats.byReason[why] = (stats.byReason[why] ?? 0) + 1;
        found++;
        if (dryRun) continue;

        try {
          if (cfg.archive_before) await archive(guild.id, msg);
          if (Date.now() - msg.createdTimestamp > BULK_LIMIT_MS) stats.tooOldForBulk++;
          await msg.delete();
          deleted++;
          // Discord's delete bucket is unforgiving on old messages; pace rather than get 429'd
          // into a stall that looks like a hang.
          await new Promise(r => setTimeout(r, 350));
        } catch (err) {
          failed++;
          logger.warn(`[MemberPurge] could not delete ${msg.id} in #${channel.name}: ${err.message}`);
        }
      }
      scanned += page.size;
      stats.scanned = (stats.scanned ?? 0) + page.size;

      // Every ~1000 messages, measured against the last report rather than with a modulo.
      //
      // `scanned % 1000 === 0` only ever fires when the running total lands exactly on a multiple,
      // which holds while every page is a full 100 and breaks permanently the moment one is not —
      // the end of a channel, a gap, anything. After that the intra-channel updates stop for good
      // and the job looks frozen between channel boundaries, which is precisely what it did.
      if (jobId && scanned - reportedAt >= 1000) {
        reportedAt = scanned;
        await pool.execute(
          'UPDATE member_purge_jobs SET progress=?, messages_scanned=?, messages_found=? WHERE id=?',
          [`${dryRun ? 'counting' : 'erasing'} #${channel.name} — ${scanned.toLocaleString()} read`,
            stats.scanned, stats.found + found, jobId]).catch(() => {});
      }

      before = page.last().id;
      if (page.size < 100) break;
      if (reachedCutoff) break;
    }

    stats.found += found; stats.deleted += deleted; stats.failed += failed;
    if (found) stats.byChannel.push({ channel: channel.name, found, deleted, failed });

    done.add(channel.id);
    if (jobId) {
      await pool.execute(
        `UPDATE member_purge_jobs SET channels_done=?, messages_found=?, messages_deleted=?,
           messages_failed=?, messages_scanned=?, progress=?, done_channels=? WHERE id=?`,
        [done.size, stats.found, stats.deleted, stats.failed, stats.scanned ?? 0,
          `${dryRun ? 'counted' : 'erased'} #${channel.name} (${done.size}/${usable.length})`,
          JSON.stringify([...done]), jobId]);
    }
    onProgress?.({ done: i + 1, total: usable.length, channel: channel.name, ...stats });
  }
  return stats;
}

/**
 * Everyone who has posted here and is no longer a member.
 *
 * Read from the guild's own history rather than from a member list, because the people this feature
 * is about are precisely the ones NOT on the member list any more.
 */
export async function findDeparted(guild, {
  config = null, onProgress = null, jobId = null, signal = null, maxAgeDays = null, resumeFrom = null,
} = {}) {
  const cfg = config ?? await getConfig(guild.id);
  const { usable } = await channelScope(guild, cfg);

  // Publish a total straight away. Without this the first pass of a backfill sits at 0/0 for
  // minutes and is indistinguishable from a stuck job — which is exactly how it was read.
  if (jobId) {
    await pool.execute('UPDATE member_purge_jobs SET channels_total=?, channels_done=0 WHERE id=?',
      [usable.length, jobId]).catch(() => {});
  }

  const present = new Set();
  const fetched = await guild.members.fetch().catch(() => null);
  if (fetched) for (const m of fetched.values()) present.add(m.id);
  else return { departed: [], error: 'could not read the member list — refusing to guess who has left' };

  const cutoff = maxAgeDays ? Date.now() - maxAgeDays * 86_400_000 : null;
  const seen = new Map();  // userId -> { id, name, messages }
  let scanned = 0, reportedAt = 0;

  const done = new Set(resumeFrom ?? []);
  for (const [i, channel] of usable.entries()) {
    if (signal?.cancelled) break;
    if (done.has(channel.id)) continue;
    let before, reachedCutoff = false;
    for (;;) {
      if (signal?.cancelled) break;
      const page = await channel.messages.fetch({ limit: 100, ...(before && { before }) }).catch(() => null);
      if (!page?.size) break;
      if (cutoff && page.last().createdTimestamp < cutoff) reachedCutoff = true;

      for (const msg of page.values()) {
        if (cutoff && msg.createdTimestamp < cutoff) continue;
        const a = msg.author;
        if (!a || a.bot) continue;
        if (present.has(a.id)) continue;
        const e = seen.get(a.id) ?? { id: a.id, name: a.username, messages: 0 };
        e.messages++; seen.set(a.id, e);
      }
      scanned += page.size;

      if (jobId && scanned - reportedAt >= 1000) {
        reportedAt = scanned;
        await pool.execute(
          'UPDATE member_purge_jobs SET progress=?, messages_scanned=?, users_total=? WHERE id=?',
          [`finding who has left — #${channel.name}, ${scanned.toLocaleString()} read`, scanned, seen.size, jobId])
          .catch(() => {});
      }

      before = page.last().id;
      if (page.size < 100) break;
      if (reachedCutoff) break;
    }
    done.add(channel.id);
    if (jobId) {
      await pool.execute(
        `UPDATE member_purge_jobs SET channels_done=?, users_total=?, messages_scanned=?, progress=?,
           done_channels=? WHERE id=?`,
        [done.size, seen.size, scanned,
          `finding who has left — ${done.size}/${usable.length} channels, ${seen.size} found`,
          JSON.stringify([...done]), jobId]).catch(() => {});
    }
    onProgress?.({ done: i + 1, total: usable.length, channel: channel.name, found: seen.size });
  }
  return { departed: [...seen.values()].sort((a, b) => b.messages - a.messages) };
}

/** Should a departure trigger a purge at all? */
export async function shouldPurge(guildId, reason) {
  const cfg = await getConfig(guildId);
  if (!cfg.enabled) return { purge: false, cfg };
  const on = reason === 'ban' ? cfg.on_ban : reason === 'kick' ? cfg.on_kick : cfg.on_leave;
  return { purge: !!on, cfg };
}

/**
 * Jobs running right now, by job id, so a long one can be watched and stopped.
 *
 * A live backfill deletes at roughly three messages a second — the scan is quick but the deletion
 * is not, and a few thousand messages runs past Discord's 15-minute interaction token. The command
 * therefore starts the job and returns; this is how anything can find it again.
 */
const running = new Map();

/**
 * A job marked `running` that no process is actually running.
 *
 * Called at startup. Without it a restart mid-purge leaves a row that says "running" forever, and
 * `/utilities erase status` reports a job that will never move — which is worse than saying nothing, because
 * somebody will sit and wait for it.
 */
let reconciledOnce = false;
export async function reconcileStaleJobs() {
  // Once per process. The natural call site is manager init, which runs for every one of the 43
  // custom bots — and 43 identical sweeps is 42 pointless writes.
  if (reconciledOnce) return 0;
  reconciledOnce = true;

  // 'interrupted', not 'cancelled'. One can be picked up where it left off; the other was somebody's
  // decision to stop. Collapsing them loses hours of completed work on every restart.
  const [r] = await pool.execute(
    `UPDATE member_purge_jobs SET status='interrupted',
       error='the bot restarted — resume it with /utilities erase resume'
     WHERE status='running'`);
  if (r.affectedRows) logger.warn(`[MemberPurge] ${r.affectedRows} job(s) interrupted by a restart — resumable`);
  return r.affectedRows;
}

export function trackJob(jobId, signal) { running.set(jobId, signal); }
export function untrackJob(jobId) { running.delete(jobId); }
export function isRunning(jobId) { return running.has(jobId); }

/** Stop a job mid-flight. What is already deleted stays deleted; nothing further is touched. */
export function cancelJob(jobId) {
  const sig = running.get(jobId);
  if (!sig) return false;
  sig.cancelled = true;
  return true;
}

/**
 * Departures waiting out their grace window, keyed `guildId:userId`.
 *
 * In-process on purpose. A pending purge that is lost to a restart is the safe failure: nothing is
 * deleted, and the owner can run a backfill whenever they like. The unsafe failure would be a purge
 * that fires twice, or one that fires after the member has already come back.
 */
const pending = new Map();

/**
 * Queue a purge for someone who has just left.
 *
 * Deduplicated by member, because a ban raises BOTH `guildBanAdd` and `guildMemberRemove` — without
 * this, every ban would start two purges racing each other through the same channels.
 *
 * The membership is re-checked when the timer fires, not when it is set. Somebody who leaves and
 * rejoins inside the window keeps their history; that is the entire point of the window.
 */
export async function schedulePurge(guild, userId, reason) {
  const { purge, cfg } = await shouldPurge(guild.id, reason);
  if (!purge) return { queued: false, why: `purge on ${reason} is off for this server` };

  const key = `${guild.id}:${userId}`;
  if (pending.has(key)) return { queued: false, why: 'already queued' };

  const delay = Math.max(0, Number(cfg.grace_minutes) || 0) * 60_000;
  const timer = setTimeout(async () => {
    pending.delete(key);
    try {
      // Still gone? A rejoin inside the window cancels it.
      const back = await guild.members.fetch(userId).catch(() => null);
      if (back) {
        logger.info(`[MemberPurge] ${userId} rejoined ${guild.name} within the grace window — purge cancelled`);
        return;
      }

      const [job] = await pool.execute(
        `INSERT INTO member_purge_jobs (guild_id, user_id, kind, reason, status, dry_run)
         VALUES (?, ?, 'member', ?, 'running', 0)`, [guild.id, userId, reason]);

      const stats = await run(guild, [userId], { dryRun: false, jobId: job.insertId, config: cfg });
      await pool.execute(
        `UPDATE member_purge_jobs SET status='complete', finished_at=NOW() WHERE id=?`, [job.insertId]);
      logger.info(`[MemberPurge] ${guild.name}: removed ${stats.deleted} message(s) for ${userId} (${reason})`);
    } catch (err) {
      logger.error(`[MemberPurge] purge for ${userId} in ${guild.name} failed: ${err.message}`);
    }
  }, delay);

  // Never hold the process open for a purge.
  timer.unref?.();
  pending.set(key, timer);
  return { queued: true, inMinutes: delay / 60_000 };
}

/** A member came back before the timer fired. */
export function cancelPending(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const t = pending.get(key);
  if (!t) return false;
  clearTimeout(t);
  pending.delete(key);
  return true;
}

export default {
  getConfig, setConfig, channelScope, run, findDeparted, shouldPurge,
  schedulePurge, cancelPending, trackJob, untrackJob, isRunning, cancelJob,
  reconcileStaleJobs, DEFAULTS,
};
