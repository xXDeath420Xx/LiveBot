/*
 * Retroactive commission-ad sweep.
 *
 *   node scripts/commission-spam-backfill.mjs                  # dry run, every enabled guild
 *   node scripts/commission-spam-backfill.mjs --guild <id>     # one guild
 *   node scripts/commission-spam-backfill.mjs --since 2026-07-01
 *   node scripts/commission-spam-backfill.mjs --apply          # actually delete
 *
 * Replays the CURRENT matcher over `message_logs` to find ads that the old substring-only filter
 * let through, and deletes them. Dry run is the default and prints every candidate with the rule
 * that caught it — read that list before ever passing --apply.
 *
 * SAFETY
 *   · Scoped to guilds with commission_spam_config.enabled = 1. Enabling the filter is the consent
 *     signal; a guild that never turned it on does not get its history swept.
 *   · Honours each guild's channel scope and custom phrase list, exactly as the live filter does.
 *   · Re-checks staff exemption LIVE against Discord (admin / ManageGuild / ModerateMembers / owner)
 *     rather than trusting anything cached, because roles change and the log has no permissions.
 *   · Every Discord call is REST — no gateway login — so this is safe to run while PM2 is up.
 *     (The "never run scripts with custom bot tokens while PM2 is running" rule is about competing
 *     *gateway* sessions.)
 *   · A message already gone (404) is counted as such, not as an error. `message_logs` is written
 *     BEFORE the filter runs, so it legitimately contains messages the live filter already removed.
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { writeFileSync } from 'node:fs';
import { PermissionsBitField, PermissionFlagsBits } from 'discord.js';
import encryption from '../utils/encryption.js';
import { matchCommissionAd, DEFAULT_PHRASES } from '../core/commission-spam-match.js';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val = (n, d = null) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);

const APPLY = flag('--apply');
const ONLY_GUILD = val('--guild');
const SINCE = val('--since');
const OUT = val('--out', 'commission-backfill-report.json');
const LIMIT = Number(val('--limit', '0')) || 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── db ───────────────────────────────────────────────────────────────────────
// Dedicated connection, never the shared pool — the pool hangs in one-off scripts.
const db = await mysql.createConnection({
  host: process.env.DB_HOST, user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME,
});

async function main() {
  const [configs] = await db.execute(
    `SELECT guild_id, phrases, channel_ids FROM commission_spam_config WHERE enabled = 1
     ${ONLY_GUILD ? 'AND guild_id = ?' : ''}`,
    ONLY_GUILD ? [ONLY_GUILD] : []);

  if (!configs.length) { console.error('No enabled guilds matched.'); return; }

  const cfgByGuild = new Map(configs.map((c) => [c.guild_id, buildOpts(c)]));
  const ids = configs.map((c) => c.guild_id);

  const [rows] = await db.query(
    `SELECT message_id, guild_id, channel_id, author_id, author_tag, content, timestamp
       FROM message_logs
      WHERE guild_id IN (?) AND content IS NOT NULL AND content <> ''
        ${SINCE ? 'AND timestamp >= ?' : ''}
      ORDER BY timestamp ASC`,
    SINCE ? [ids, SINCE] : [ids]);

  console.log(`Scanning ${rows.length} logged messages across ${ids.length} enabled guild(s)…\n`);

  // ── match ──────────────────────────────────────────────────────────────────
  const hits = [];
  for (const r of rows) {
    const opts = cfgByGuild.get(r.guild_id);
    if (opts.channels && !opts.channels.includes(r.channel_id)) continue;
    const m = matchCommissionAd(r.content, opts.match);
    if (m) hits.push({ ...r, matched: m.matched, via: m.via, rule: m.rule || null });
  }

  if (!hits.length) { console.log('No matches.'); return; }

  const byGuild = new Map();
  for (const h of hits) {
    if (!byGuild.has(h.guild_id)) byGuild.set(h.guild_id, []);
    byGuild.get(h.guild_id).push(h);
  }

  // ── per guild: staff re-check, then report or delete ───────────────────────
  const report = [];
  const totals = { candidates: hits.length, staffSkipped: 0, deleted: 0, gone: 0, failed: 0, noBot: 0 };

  for (const [guildId, list] of byGuild) {
    const guildName = await guildLabel(guildId);
    const auth = await tokenFor(guildId);
    if (!auth) {
      console.log(`\n── ${guildName} (${guildId}) — ${list.length} candidate(s) — NO BOT TOKEN, skipped`);
      totals.noBot += list.length;
      continue;
    }

    const staff = await staffCheckerFor(guildId, auth);
    const kept = [];
    for (const h of list) {
      if (await staff(h.author_id)) { totals.staffSkipped++; continue; }
      kept.push(h);
    }

    console.log(`\n── ${guildName} (${guildId}) — ${kept.length} to remove` +
      `${list.length - kept.length ? `, ${list.length - kept.length} skipped as staff/bot` : ''}`);

    let n = 0;
    let deletedHere = 0;
    for (const h of kept) {
      if (LIMIT && n >= LIMIT) break;
      n++;
      const when = new Date(h.timestamp).toISOString().slice(0, 16).replace('T', ' ');
      const preview = h.content.replace(/\s+/g, ' ').slice(0, 88);
      const tag = h.via === 'pattern' ? `pattern:${h.rule}` : 'phrase';

      let status = 'DRY-RUN';
      if (APPLY) {
        status = await deleteMessage(h.channel_id, h.message_id, auth);
        if (status === 'deleted') { totals.deleted++; deletedHere++; }
        else if (status === 'gone') totals.gone++;
        else totals.failed++;
        await sleep(350); // stay well inside the per-channel delete bucket
      }

      console.log(`   [${status}] ${when}  ${h.author_tag}  «${preview}»`);
      console.log(`             ↳ ${tag} — matched "${h.matched}"`);
      report.push({ ...h, guildName, status, timestamp: new Date(h.timestamp).toISOString() });
    }

    if (APPLY && deletedHere) {
      await db.execute(
        'UPDATE commission_spam_config SET deleted_count = deleted_count + ?, last_hit_at = NOW() WHERE guild_id = ?',
        [deletedHere, guildId]).catch(() => {});
    }
  }

  writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), apply: APPLY, totals, report }, null, 2));

  console.log('\n' + '─'.repeat(72));
  console.log(`candidates ${totals.candidates} · staff/bot skipped ${totals.staffSkipped} · ` +
    (APPLY ? `deleted ${totals.deleted} · already gone ${totals.gone} · failed ${totals.failed}`
           : `would delete ${report.length}`) +
    (totals.noBot ? ` · unreachable ${totals.noBot}` : ''));
  console.log(`report → ${OUT}`);
  if (!APPLY) console.log('\nDRY RUN — nothing was deleted. Re-run with --apply once the list above looks right.');
}

/** Mirror of the live filter's matchOptionsFor + channel scope. */
function buildOpts(cfg) {
  let phrases = null;
  try { const a = JSON.parse(cfg.phrases || 'null'); if (Array.isArray(a) && a.length) phrases = a; } catch { /* defaults */ }
  let channels = null;
  try { const c = JSON.parse(cfg.channel_ids || 'null'); if (Array.isArray(c) && c.length) channels = c; } catch { /* all */ }
  return {
    channels,
    match: phrases ? { phrases, usePatterns: false } : { phrases: DEFAULT_PHRASES, usePatterns: true },
  };
}

async function guildLabel(guildId) {
  const [[g]] = await db.execute('SELECT guild_name FROM guilds WHERE guild_id = ?', [guildId]).catch(() => [[]]);
  return g?.guild_name || 'unknown guild';
}

/** The custom bot mapped to this guild, else the main bot. */
const tokenCache = new Map();
async function tokenFor(guildId) {
  if (tokenCache.has(guildId)) return tokenCache.get(guildId);
  let token = null;
  const [[bot]] = await db.execute(
    `SELECT bot_token FROM custom_bots
      WHERE bot_id = (SELECT bot_id FROM guild_bot_mapping WHERE guild_id = ? LIMIT 1)`, [guildId]).catch(() => [[]]);
  if (bot?.bot_token) { try { token = encryption.decrypt(JSON.parse(bot.bot_token)); } catch { token = null; } }
  if (!token) token = process.env.DISCORD_TOKEN || process.env.BOT_TOKEN || null;
  tokenCache.set(guildId, token);
  return token;
}

async function api(path, token, init = {}) {
  for (;;) {
    const r = await fetch(`https://discord.com/api/v10${path}`, {
      ...init, headers: { Authorization: `Bot ${token}`, ...(init.headers || {}) },
    });
    if (r.status === 429) {
      const j = await r.json().catch(() => ({}));
      await sleep((j.retry_after ?? 1) * 1000 + 250);
      continue;
    }
    return r;
  }
}

/**
 * Returns isStaff(userId) — true for admins, ManageGuild, ModerateMembers, the owner, and bots.
 * Exactly the live filter's exemption set, re-derived from Discord right now.
 */
async function staffCheckerFor(guildId, token) {
  const gr = await api(`/guilds/${guildId}`, token);
  const guild = gr.ok ? await gr.json() : null;
  const rr = await api(`/guilds/${guildId}/roles`, token);
  const roles = rr.ok ? await rr.json() : [];
  const rolePerms = new Map(roles.map((x) => [x.id, BigInt(x.permissions ?? 0)]));
  const everyone = rolePerms.get(guildId) ?? 0n;

  // ANY of these exempts, not all — so they are tested separately. PermissionsBitField.has() with a
  // combined mask requires every bit, which would only ever exempt someone holding all three.
  const EXEMPT = [
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ModerateMembers,
  ];

  const seen = new Map();
  return async function isStaff(userId) {
    if (seen.has(userId)) return seen.get(userId);
    let result = false;
    if (guild && guild.owner_id === userId) result = true;
    else {
      const mr = await api(`/guilds/${guildId}/members/${userId}`, token);
      if (mr.ok) {
        const m = await mr.json();
        if (m.user?.bot) result = true;
        else {
          let bits = everyone;
          for (const rid of m.roles || []) bits |= rolePerms.get(rid) ?? 0n;
          const bf = new PermissionsBitField(bits);
          result = EXEMPT.some((p) => bf.has(p));
        }
      } else if (mr.status !== 404) {
        // Can't tell → treat as staff and leave it alone. Never delete on ambiguity.
        result = true;
      }
      // 404 = they left the guild; their old messages are still fair game.
    }
    seen.set(userId, result);
    return result;
  };
}

async function deleteMessage(channelId, messageId, token) {
  const r = await api(`/channels/${channelId}/messages/${messageId}`, token, { method: 'DELETE' });
  if (r.status === 204) return 'deleted';
  if (r.status === 404) return 'gone';
  return `failed:${r.status}`;
}

try { await main(); } catch (e) { console.error('FATAL', e); process.exitCode = 1; }
finally { await db.end(); }
