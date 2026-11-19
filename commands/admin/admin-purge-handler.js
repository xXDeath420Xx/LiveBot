/*
 * `/utilities erase` — erase departed members' traces.
 *
 * Lives here rather than under /admin because that command is at Discord's 8000-character ceiling;
 * see commands/admin/erase.js.
 *
 * Every path here defaults to a DRY RUN and says so. Message deletion is irreversible, Discord
 * offers no undo, and on a server with real history a backfill can run to tens of thousands of
 * deletions — so "show me what this would do" is the default and the live run needs the server name
 * typed, the same barrier the takeover uses.
 */
import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { themeColor } from '../../core/guild-theme.js';
import { isSuperAdmin } from '../../utils/constants.js';
import {
  getConfig, setConfig, channelScope, run, findDeparted,
  trackJob, untrackJob, cancelJob,
} from '../../core/member-purge.js';

const EPHEMERAL = { flags: 64 };
const norm = (v) => String(v ?? '').replace(/[’‘‛]/g, "'").replace(/[“”]/g, '"').trim();

/**
 * Administrator, matching the rest of `/admin`.
 *
 * The command is already hidden from anyone without Administrator by its
 * `default_member_permissions`, and Discord filters on that BEFORE dispatch — but that only controls
 * VISIBILITY, so the check has to exist here too or the gate is decorative.
 *
 * The barrier that matters for the destructive paths is not who you are, it is typing the server
 * name: an admin who means to erase somebody has to say so explicitly, and one who wandered in gets
 * a dry run.
 */
function requireAdmin(interaction) {
  const isAdmin = interaction.member?.permissions?.has(PermissionFlagsBits.Administrator);
  if (isAdmin || interaction.user.id === interaction.guild.ownerId || isSuperAdmin(interaction.user.id)) return true;
  interaction.reply({
    content: 'This needs Administrator permission — it permanently deletes messages.',
    ...EPHEMERAL,
  });
  return false;
}

export async function handle(interaction) {
  const sub = interaction.options.getSubcommand();
  const guild = interaction.guild;

  // Which subcommand, by name. Without this the only trace of an /erase is "executed /erase", and
  // "did my backfill run?" cannot be answered from the logs at all — which is exactly the question
  // this feature invites the moment somebody uses it.
  logger.info(`[MemberPurge] ${interaction.user.tag} ran /erase ${sub} in ${guild.name} (${guild.id})`);

  // ── settings ────────────────────────────────────────────────────────────
  if (sub === 'settings') {
    if (!requireAdmin(interaction)) return;
    const patch = {};
    for (const [opt, col] of [['enabled', 'enabled'], ['on-leave', 'on_leave'], ['on-kick', 'on_kick'],
      ['on-ban', 'on_ban'], ['include-mentions', 'include_mentions'], ['exempt-mod-logs', 'exempt_mod_logs'],
      ['archive', 'archive_before']]) {
      const v = interaction.options.getBoolean(opt);
      if (v !== null) patch[col] = v ? 1 : 0;
    }
    const grace = interaction.options.getInteger('grace-minutes');
    if (grace !== null) patch.grace_minutes = grace;

    const cfg = Object.keys(patch).length ? await setConfig(guild.id, patch) : await getConfig(guild.id);
    const { usable, skipped } = await channelScope(guild, cfg);
    const exempt = skipped.filter(s => s.why === 'moderation record — exempt');

    const embed = new EmbedBuilder()
      .setColor(themeColor(guild.id, 'primary'))
      .setTitle('Erase departed members — settings')
      .setDescription(cfg.enabled
        ? 'On. Departing members have their messages removed after the grace window.'
        : 'Off. Nothing is purged automatically; the backfill still works on demand.')
      .addFields(
        { name: 'Triggers', inline: true, value: [
          `Leave: ${cfg.on_leave ? 'yes' : 'no'}`, `Kick: ${cfg.on_kick ? 'yes' : 'no'}`,
          `Ban: ${cfg.on_ban ? 'yes' : 'no'}`].join('\n') },
        { name: 'Scope', inline: true, value: [
          `Their messages: always`,
          `Messages mentioning them: ${cfg.include_mentions ? 'yes' : 'no'}`,
          `Archive first: ${cfg.archive_before ? 'yes' : 'NO'}`].join('\n') },
        { name: 'Grace window', inline: true, value: `${cfg.grace_minutes} min — a rejoin inside it cancels the purge` },
        { name: `Channels in scope (${usable.length})`, value: usable.slice(0, 20).map(c => `#${c.name}`).join(', ') || 'none' },
        { name: `Exempt (${skipped.length})`, value:
          (exempt.length ? `**Moderation records kept:** ${exempt.map(s => `#${s.name}`).join(', ')}\n` : '')
          + (skipped.filter(s => s.why !== 'moderation record — exempt')
            .map(s => `#${s.name} — ${s.why}`).join('\n') || '_nothing else_') },
      )
      .setFooter({ text: "Discord's own audit log keeps 90 days and no bot can purge it." });
    return interaction.reply({ embeds: [embed], ...EPHEMERAL });
  }

  // ── who has left ────────────────────────────────────────────────────────
  if (sub === 'departed') {
    await interaction.deferReply(EPHEMERAL);
    const { departed, error } = await findDeparted(guild);
    if (error) return interaction.editReply(error);
    if (!departed.length) return interaction.editReply('Nobody who has posted here is missing from the member list.');

    const total = departed.reduce((n, d) => n + d.messages, 0);
    const embed = new EmbedBuilder()
      .setColor(themeColor(guild.id, 'warning'))
      .setTitle(`${departed.length} former member(s) still have messages here`)
      .setDescription(departed.slice(0, 25)
        .map(d => `**${d.name}** — ${d.messages.toLocaleString()} message(s)`).join('\n')
        + (departed.length > 25 ? `\n…and ${departed.length - 25} more` : ''))
      .setFooter({ text: `${total.toLocaleString()} messages in total. Run /utilities erase backfill to see what would go.` });
    return interaction.editReply({ embeds: [embed] });
  }

  // ── one person ──────────────────────────────────────────────────────────
  if (sub === 'member') {
    if (!requireAdmin(interaction)) return;
    await interaction.deferReply(EPHEMERAL);

    const user = interaction.options.getUser('user', true);
    const confirm = interaction.options.getString('confirm');
    const live = !!confirm && norm(confirm) === norm(guild.name);

    // The row goes in FIRST, before any scanning.
    //
    // It used to be created after the scan, so for the ~50 seconds a scan takes there was no record
    // that anything was happening — `/utilities erase status` said "no erase has ever been run here" while one
    // was actively running, and an error during the scan left no trace whatsoever.
    const jobId = await newJob(guild.id, {
      userId: user.id, kind: 'member', dryRun: !live, startedBy: interaction.user.id,
      maxAgeDays: interaction.options.getInteger('max-age-days') });

    const still = await guild.members.fetch(user.id).catch(() => null);
    if (still) {
      await finishJob(jobId, null, 'cancelled', `${user.username} is still a member`);
      return interaction.editReply(`${user.username} is still in this server. This only removes people who have left.`);
    }

    // Backgrounded whether it is a dry run or not: even one member's history is a full scan of
    // every channel, which outlives the ephemeral reply it would have been written to.
    return startBackground(interaction, guild, {
      ids: new Map([[user.id, user.username]]), jobId, live, who: user.username,
      maxAgeDays: interaction.options.getInteger('max-age-days'),
      howToRun: `/utilities erase member user:${user.username} confirm:${guild.name}`,
    });
  }

  // ── everyone who has left ───────────────────────────────────────────────
  if (sub === 'backfill') {
    if (!requireAdmin(interaction)) return;
    await interaction.deferReply(EPHEMERAL);

    const confirm = interaction.options.getString('confirm');
    const live = !!confirm && norm(confirm) === norm(guild.name);

    // Row first — finding who has left is itself a full scan of every channel and takes about a
    // minute. Creating the row afterwards meant that whole minute was invisible, and any failure
    // inside it vanished without a trace.
    const jobId = await newJob(guild.id, {
      kind: 'backfill', dryRun: !live, startedBy: interaction.user.id,
      maxAgeDays: interaction.options.getInteger('max-age-days') });

    // Working out who has left is itself a full scan, so it happens inside the background task —
    // otherwise the command sits silent for a minute before it can even say it started.
    return startBackground(interaction, guild, {
      ids: null, jobId, live, who: 'everyone who has left',
      maxAgeDays: interaction.options.getInteger('max-age-days'),
      howToRun: `/utilities erase backfill confirm:${guild.name}`,
    });
  }
  // ── how is it going ────────────────────────────────────────────────────
  if (sub === 'status') {
    const [rows] = await pool.execute(
      `SELECT * FROM member_purge_jobs WHERE guild_id=? ORDER BY id DESC LIMIT 5`, [guild.id]);
    if (!rows.length) return interaction.reply({ content: 'No erase has ever been run here.', ...EPHEMERAL });

    const embed = new EmbedBuilder()
      .setColor(themeColor(guild.id, 'primary'))
      .setTitle('Recent erases')
      .setDescription(rows.map(j => {
        const when = j.started_at?.toISOString?.().slice(0, 16).replace('T', ' ') ?? '';
        const what = j.kind === 'backfill' ? `everyone who has left (${j.users_total})` : `one member`;
        const prog = (j.progress ? `_${j.progress}_\n` : '')
          + `${j.channels_done}/${j.channels_total} channels · ${Number(j.messages_scanned || 0).toLocaleString()} read`
          + ` · ${j.messages_found} matched`
          + (j.dry_run ? '' : ` · ${j.messages_deleted} deleted`)
          + (j.messages_failed ? ` · ${j.messages_failed} failed` : '')
          + (j.max_age_days ? ` · last ${j.max_age_days}d only` : '');
        return [
          `**#${j.id}** ${j.dry_run ? '_dry run_' : '**LIVE**'} — ${j.status}`,
          `${when} · ${what}`,
          prog,
        ].join('\n');
      }).join('\n\n'));
    const live = rows.find(j => j.status === 'running');
    const stopped = rows.find(j => j.status === 'interrupted');
    if (live) embed.setFooter({ text: `Job #${live.id} is still going. /erase cancel job:${live.id} stops it.` });
    else if (stopped) embed.setFooter({ text: `Job #${stopped.id} was interrupted. /erase resume picks it up where it stopped.` });
    return interaction.reply({ embeds: [embed], ...EPHEMERAL });
  }

  // ── pick up where a restart left off ───────────────────────────────────
  if (sub === 'resume') {
    if (!requireAdmin(interaction)) return;
    await interaction.deferReply(EPHEMERAL);

    const wanted = interaction.options.getInteger('job');
    const [[j]] = wanted
      ? await pool.execute('SELECT * FROM member_purge_jobs WHERE id=? AND guild_id=?', [wanted, guild.id])
      : await pool.execute(
        "SELECT * FROM member_purge_jobs WHERE guild_id=? AND status='interrupted' ORDER BY id DESC LIMIT 1",
        [guild.id]);

    if (!j) return interaction.editReply(wanted ? `No job #${wanted} here.` : 'Nothing to resume.');
    if (j.status !== 'interrupted') return interaction.editReply(`Job #${j.id} is ${j.status}, not interrupted.`);

    const doneChannels = safeList(j.done_channels);
    const targetPairs = safeList(j.target_ids);
    const targets = j.phase === 'purge' && targetPairs.length ? new Map(targetPairs) : null;

    await pool.execute("UPDATE member_purge_jobs SET status='running', error=NULL WHERE id=?", [j.id]);

    return startBackground(interaction, guild, {
      ids: targets,
      jobId: j.id,
      live: !j.dry_run,
      who: j.kind === 'backfill' ? 'everyone who has left' : 'one former member',
      maxAgeDays: j.max_age_days,
      howToRun: `/utilities erase resume job:${j.id}`,
      // What this job had already found and deleted before the restart. Without it the resumed
      // run reports only its own tail and the earlier deletions disappear from the record.
      resume: {
        phase: j.phase,
        doneChannels,
        carry: {
          found: Number(j.messages_found) || 0,
          deleted: Number(j.messages_deleted) || 0,
          failed: Number(j.messages_failed) || 0,
          scanned: Number(j.messages_scanned) || 0,
        },
      },
    });
  }

  if (sub === 'cancel') {
    if (!requireAdmin(interaction)) return;
    const id = interaction.options.getInteger('job', true);
    const [[j]] = await pool.execute('SELECT * FROM member_purge_jobs WHERE id=? AND guild_id=?', [id, guild.id]);
    if (!j) return interaction.reply({ content: `No job #${id} on this server.`, ...EPHEMERAL });
    if (j.status !== 'running') return interaction.reply({ content: `Job #${id} is already ${j.status}.`, ...EPHEMERAL });

    const stopped = cancelJob(id);
    return interaction.reply({
      content: stopped
        ? `Stopping job #${id}. Messages already deleted stay deleted — nothing further will be touched.`
        : `Job #${id} is marked running but is not active in this process (a restart, most likely). Marking it cancelled.`,
      ...EPHEMERAL,
    });
  }

  return interaction.reply({ content: 'Unknown subcommand.', ...EPHEMERAL });
}

/** JSON columns arrive as text; a malformed one must not take the resume down with it. */
function safeList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v.trim()) return [];
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
}

/** Every run gets a row, dry or live — otherwise "did it run?" has no answer. */
async function newJob(guildId, { userId = null, kind, dryRun, usersTotal = 0, startedBy, maxAgeDays = null }) {
  const [ins] = await pool.execute(
    `INSERT INTO member_purge_jobs
       (guild_id,user_id,kind,reason,status,dry_run,users_total,started_by,max_age_days,progress)
     VALUES (?,?,?, 'manual','running',?,?,?,?, 'starting')`,
    [guildId, userId, kind, dryRun ? 1 : 0, usersTotal, startedBy, maxAgeDays]);
  return ins.insertId;
}

async function finishJob(jobId, stats, status = 'complete', error = null) {
  await pool.execute(
    `UPDATE member_purge_jobs SET status=?, finished_at=NOW(), error=?,
       messages_found=?, messages_deleted=?, messages_failed=? WHERE id=?`,
    [status, error ? String(error).slice(0, 500) : null,
      stats?.found ?? 0, stats?.deleted ?? 0, stats?.failed ?? 0, jobId]);
}

/**
 * Start the job and return immediately — dry run or live, both.
 *
 * Every path here is minutes long: finding who has left is a full scan of every channel, and
 * deleting is paced at roughly three messages a second. Awaiting any of it inline means the answer
 * arrives after Discord's interaction token has expired, or into an ephemeral message that has
 * already vanished from the operator's client. Either way the person who asked never sees it.
 *
 * So: reply at once with the job number, and DM the finished report. A DM persists; an ephemeral
 * reply does not, and this is a job somebody needs the result of.
 */
async function startBackground(interaction, guild,
  { ids, jobId, live, who, howToRun, maxAgeDays = null, resume = null }) {
  const signal = { cancelled: false };
  trackJob(jobId, signal);
  const user = interaction.user;

  // Deliberately not awaited.
  (async () => {
    try {
      let targets = ids;
      let label = who;

      if (!targets) {
        const { departed, error } = await findDeparted(guild,
          { jobId, signal, maxAgeDays, resumeFrom: resume?.phase === 'find' ? resume.doneChannels : null });
        if (error) {
          await finishJob(jobId, null, 'failed', error);
          await dm(user, guild, `Job #${jobId} could not run: ${error}`);
          return;
        }
        if (!departed.length) {
          await finishJob(jobId, null, 'complete');
          await dm(user, guild, `Job #${jobId}: nothing to do — everyone who has posted here is still a member.`);
          return;
        }
        // id -> username. The name is what finds them inside a log embed; without it, scanning the
        // log channels finds nothing at all.
        targets = new Map(departed.map(d => [d.id, d.name]));
        label = `${departed.length} former member(s)`;

        // Cached on the job. Pass one is half the total cost; a resume must never repeat it.
        await pool.execute(
          "UPDATE member_purge_jobs SET target_ids=?, done_channels=NULL, channels_done=0, phase='purge' WHERE id=?",
          [JSON.stringify([...targets]), jobId]).catch(() => {});
      }

      const stats = await run(guild, targets, {
        dryRun: !live, jobId, signal, maxAgeDays,
        resumeFrom: resume?.phase === 'purge' ? resume.doneChannels : null,
        carry: resume?.carry ?? null,
      });
      await finishJob(jobId, stats, signal.cancelled ? 'cancelled' : 'complete');
      logger.info(`[MemberPurge] job ${jobId} on ${guild.name}: `
        + `${live ? `deleted ${stats.deleted}, failed ${stats.failed}` : `found ${stats.found} (dry run)`}`);

      await dm(user, guild, await report(guild, stats, live, label, howToRun, jobId));
    } catch (err) {
      await finishJob(jobId, null, 'failed', err.message);
      logger.error(`[MemberPurge] job ${jobId} on ${guild.name} failed: ${err.message}`);
      await dm(user, guild, `Job #${jobId} failed: ${err.message}`);
    } finally {
      untrackJob(jobId);
    }
  })();

  return interaction.editReply({
    embeds: [new EmbedBuilder()
      .setColor(themeColor(guild.id, live ? 'danger' : 'primary'))
      .setTitle(`${live ? 'Erasing' : 'Dry run —'} ${who} · job #${jobId}`)
      .setDescription(live
        ? "Running in the background. Deleting is paced to stay inside Discord's limits, so this takes "
          + 'minutes and will keep going after this message disappears.'
        : '**Nothing will be deleted.** Counting what a real run would remove; this takes a few minutes.')
      .addFields(
        { name: 'The result is DMed to you', value: 'This message vanishes; the DM will not.' },
        { name: 'Check progress any time', value: '`/utilities erase status`' },
        { name: 'Stop it', value: `\`/utilities erase cancel job:${jobId}\`` })],
  });
}

/** Send the finished report where it will still be there in ten minutes. */
async function dm(user, guild, payload) {
  const body = typeof payload === 'string' ? { content: `**${guild.name}** — ${payload}` } : payload;
  await user.send(body).catch(() => {
    logger.warn(`[MemberPurge] could not DM ${user.tag} the report — DMs closed. Still in /erase status.`);
  });
}

/** One honest summary, whether it ran or only looked. */
async function report(guild, stats, live, who, howToRun, jobId = null) {
  const embed = new EmbedBuilder()
    .setColor(themeColor(guild.id, live ? 'danger' : 'primary'))
    .setTitle(live ? `Purged ${who}` : `Dry run — ${who}`)
    .setDescription(live
      ? `**${stats.deleted.toLocaleString()}** message(s) deleted, **${stats.failed}** failed.`
        + (stats.failed ? ' Failures are usually a message another bot already removed.' : '')
      : `**${stats.found.toLocaleString()}** message(s) would be deleted. **Nothing has been changed.**`);

  if (stats.byChannel.length) {
    embed.addFields({
      name: 'By channel',
      value: stats.byChannel.slice(0, 15)
        .map(c => `#${c.channel} — ${live ? `${c.deleted} deleted` : `${c.found} found`}`).join('\n')
        + (stats.byChannel.length > 15 ? `\n…and ${stats.byChannel.length - 15} more` : ''),
    });
  }
  const exempt = (stats.skipped ?? []).filter(s => s.why === 'moderation record — exempt');
  if (exempt.length) {
    embed.addFields({ name: 'Left alone (moderation records)', value: exempt.map(s => `#${s.name}`).join(', ') });
  }
  if (!live) embed.addFields({ name: 'To run it for real', value: `\`${howToRun}\`` });
  if (jobId) embed.setAuthor({ name: `job #${jobId} — recorded, see /erase status` });
  if (stats.tooOldForBulk) {
    embed.setFooter({ text: `${stats.tooOldForBulk} were older than 14 days — deleted one at a time, which is why this is slow.` });
  }
  return { embeds: [embed] };
}

export default { handle };
