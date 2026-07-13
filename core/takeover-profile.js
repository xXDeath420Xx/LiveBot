/*
 * Derive a guild's takeover profile by reading its own history.
 *
 * This is the part that used to be me, with a REST client and an afternoon. Everything the takeover
 * needs but cannot guess — which streamer the incumbent announces, where the role panels live, what
 * `!commands` people type — is written down somewhere in the server's past. This reads it.
 *
 * THE CENTRAL HONESTY RULE: derivation is a research assistant, not an oracle. Every field carries a
 * confidence and the evidence it was drawn from, because the fields are genuinely not equal:
 *
 *   certain  — the datum is stated outright. A Twitch handle inside "Karabi420 is live at
 *              twitch.tv/karabi420" is not an inference.
 *   likely   — strongly implied but not stated. A `!pp` in chat followed by a bot reply is almost
 *              certainly a custom command, but it could be a coincidence.
 *   guess    — genuinely inferred and genuinely fallible. WHICH Discord role a Carl-bot panel's 🧡
 *              button grants appears NOWHERE in the message; Carl-bot keeps that in its own
 *              database. We can only match the panel's emoji against role names and hope. This is
 *              the field that will be wrong, so it is the field a human must actually look at.
 *
 * A profile is `proposed` until a human approves it, and only an approved profile may drive apply().
 * Handing 'guess' data straight to something that writes to a live server would be indefensible.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { walkComponents } from './guild-analyzer.js';

/**
 * Which bot posted this?
 *
 * By id AND by name, because a bot id alone is not enough: plenty of bots post through WEBHOOKS, and
 * a webhook message's `author.id` is the webhook's, not the bot's. FreeStuff and Dyno both do it in
 * Kabster's server. Matching on id alone silently skips them, and a silent skip here is a profile
 * that quietly omits a whole feature.
 *
 * The name check is deliberately narrow — anchored, not a substring sweep — so a member nicknamed
 * "carl" cannot be mistaken for Carl-bot.
 */
const BOT_MATCHERS = {
  stream:  { ids: new Set(['282286160494067712', '375805687529209857']), name: /^(pingcord|streamcord)/i },
  panel:   { ids: new Set(['235148962103951360', '155149108183695360', '204255221017214977']),
             name: /^(carl-?bot|dyno|yagpdb)/i },
  command: { ids: new Set(['83010416610906112', '159985870458322944']), name: /^(nightbot|mee6)/i },
};

function isBot(msg, kind) {
  const m = BOT_MATCHERS[kind];
  if (!msg?.author) return false;
  if (m.ids.has(msg.author.id)) return true;
  // A webhook persona only counts if it IS a webhook — otherwise any member could rename themselves
  // "Pingcord" and inject a fake streamer into the profile.
  return !!(msg.webhookId || msg.author.bot) && m.name.test(msg.author.username ?? '');
}

const field = (value, confidence, evidence) => ({ value, confidence, evidence });

/** Every readable text channel, oldest message first is irrelevant — we want all of them. */
async function readable(guild) {
  return [...guild.channels.cache.values()].filter(c =>
    c.isTextBased?.() && c.viewable && c.permissionsFor(guild.members.me)?.has('ReadMessageHistory'));
}

/** Full history of one channel, capped. Sampling under-counts, and an under-count here is a wrong profile. */
async function history(channel, cap = 2000) {
  const out = [];
  let before;
  while (out.length < cap) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before && { before }) }).catch(() => null);
    if (!batch?.size) break;
    out.push(...batch.values());
    if (batch.size < 100) break;
    before = batch.last().id;
  }
  return out;
}

/** Everything a message actually says — content, embeds, AND Components V2 (which the other two miss). */
function textOf(msg) {
  const { text } = walkComponents(msg.components ?? []);
  return [
    msg.content,
    ...msg.embeds.flatMap(e => [e.title, e.description, e.url, ...(e.fields ?? []).map(f => `${f.name} ${f.value}`)]),
    ...text,
  ].filter(Boolean).join('\n');
}

// ── the derivations ──────────────────────────────────────────────────────────

/**
 * Who does the incumbent announce, where, and does it ping?
 *
 * CERTAIN: the platform handle comes out of the announcement's own URL. The channel is the channel
 * the message is in. Whether it pings @everyone is whether it contains @everyone. Nothing inferred.
 */
function deriveStreamers(messages) {
  const found = new Map();

  for (const m of messages) {
    if (!isBot(m, 'stream')) continue;
    const text = textOf(m);

    const hits = [
      [/twitch\.tv\/([a-z0-9_]{3,25})/i, 'twitch'],
      [/youtube\.com\/(?:@|channel\/|c\/)([a-z0-9_.-]{2,})/i, 'youtube'],
      [/kick\.com\/([a-z0-9_-]{3,25})/i, 'kick'],
    ];

    for (const [re, platform] of hits) {
      const hit = text.match(re);
      if (!hit) continue;
      const username = hit[1].toLowerCase();
      const key = `${platform}/${username}`;
      const prev = found.get(key);
      found.set(key, {
        platform,
        username,
        channelId: m.channelId,
        // @everyone in the announcement means the incumbent pings everyone. Preserve that: quietly
        // dropping the ping would be a visible downgrade the day we take over.
        pingRoleId: /@everyone/.test(text) ? 'everyone' : (text.match(/<@&(\d+)>/) ?? [])[1] ?? null,
        seen: (prev?.seen ?? 0) + 1,
      });
    }
  }

  const list = [...found.values()].sort((a, b) => b.seen - a.seen);
  return field(
    list.map(({ seen, ...s }) => s),
    list.length ? 'certain' : 'none',
    list.length ? `${list.length} streamer(s) across ${list.reduce((a, s) => a + s.seen, 0)} announcements`
                : 'no stream announcements found');
}

/**
 * The role panels, and where they live.
 *
 * The panel's TITLE and its EMOJI are certain — they are right there in the message. The ROLE each
 * emoji grants is a GUESS, and an honest one: Carl-bot stores that mapping in its own database and
 * never puts it in the message. All we can do is look at the emoji and the guild's roles and try to
 * match them up. `roleConfidence` is per-option so a reviewer can see exactly which buttons we are
 * unsure about instead of being asked to trust the lot.
 */
function derivePanels(messages, guild) {
  const panels = [];
  const channels = new Map();

  for (const m of messages) {
    if (!isBot(m, 'panel')) continue;
    if (!m.reactions.cache.size) continue;             // a panel you react to
    if (m.components?.length) continue;                // already a button panel — not the incumbent's
    const title = m.embeds[0]?.title?.trim();
    if (!title) continue;

    const options = [...m.reactions.cache.values()].map(r => {
      const emoji = r.emoji.id ? `:${r.emoji.name}:` : r.emoji.name;

      // The guess. Try to find a role this emoji plausibly grants. There is no signal in the message
      // itself, so: exact name match on the emoji's own name, else nothing. We do NOT guess by
      // position or by order — that produces confident nonsense, which is worse than an admitted gap.
      const byName = guild.roles.cache.find(role =>
        r.emoji.name && role.name.toLowerCase() === r.emoji.name.toLowerCase());

      return {
        emoji,
        emojiId: r.emoji.id ?? null,        // needed to re-upload it; unicode has none
        animated: !!r.emoji.animated,
        roleId: byName?.id ?? null,
        label: byName?.name ?? null,
        roleConfidence: byName ? 'guess' : 'unknown',
      };
    });

    panels.push({ name: title, channelId: m.channelId, messageId: m.id, mode: 'multiple', options });
    channels.set(m.channelId, (channels.get(m.channelId) ?? 0) + 1);
  }

  // The self-assign channel is simply wherever most of the panels are.
  const top = [...channels.entries()].sort((a, b) => b[1] - a[1])[0];
  const resolved = panels.reduce((n, p) => n + p.options.filter(o => o.roleId).length, 0);
  const total = panels.reduce((n, p) => n + p.options.length, 0);

  return {
    panels: field(panels, panels.length ? 'guess' : 'none',
      panels.length
        ? `${panels.length} panel(s), ${total} buttons — we resolved ${resolved} to a role by name. `
          + `The rest we CANNOT know: the emoji-to-role mapping lives in the old bot's database, not in the message. `
          + `Every one of these needs a human eye.`
        : 'no reaction-role panels found'),
    selfAssignChannel: field(top?.[0] ?? null, top ? 'certain' : 'none',
      top ? `${top[1]} panel(s) live here` : 'no panel channel found'),
  };
}

/**
 * Custom chat commands — the `!pp`s of the world.
 *
 * LIKELY, not certain: we look for a member message starting with a prefix, immediately followed by
 * a bot reply in the same channel. That is what a custom command looks like from the outside. It
 * could also be a coincidence, so the RESPONSE is captured verbatim and a human confirms it.
 */
function deriveCustomCommands(messages) {
  const byChannel = new Map();
  for (const m of messages) {
    if (!byChannel.has(m.channelId)) byChannel.set(m.channelId, []);
    byChannel.get(m.channelId).push(m);
  }

  const cmds = new Map();
  for (const list of byChannel.values()) {
    // Discord hands us newest-first; walk oldest-first so "the reply follows the trigger" is true.
    const ordered = [...list].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    for (let i = 0; i < ordered.length - 1; i++) {
      const trigger = ordered[i];
      const reply = ordered[i + 1];
      if (trigger.author?.bot) continue;
      if (!isBot(reply, 'command')) continue;

      const hit = trigger.content?.match(/^([!?$.])([a-z0-9_-]{1,24})\s*$/i);
      if (!hit) continue;
      // A reply more than 10s later is a different conversation, not an answer to this.
      if (reply.createdTimestamp - trigger.createdTimestamp > 10_000) continue;

      const name = hit[2].toLowerCase();
      const response = textOf(reply).trim();
      if (!response) continue;

      const prev = cmds.get(name);
      cmds.set(name, { name, prefix: hit[1], response, seen: (prev?.seen ?? 0) + 1 });
    }
  }

  const list = [...cmds.values()].sort((a, b) => b.seen - a.seen);
  return field(
    list.map(({ seen, ...c }) => c),
    list.length ? 'likely' : 'none',
    list.length ? `${list.length} command(s) seen answered by a bot: ${list.map(c => c.prefix + c.name).join(', ')}`
                : 'no custom commands seen');
}

/** The birthday role. CERTAIN if a role is literally named for birthdays; otherwise we do not guess. */
function deriveBirthdayRole(guild) {
  const role = guild.roles.cache.find(r => /birthday/i.test(r.name) && !r.managed);
  return field(role?.id ?? null, role ? 'certain' : 'none',
    role ? `role "${role.name}"` : 'no role named for birthdays');
}

/**
 * Custom emoji THE PANELS need that this guild does not have.
 *
 * A bot may only use an emoji from a guild it is IN — Administrator does not help. Carl-bot hosts
 * its platform emoji on its own emoji server, so rebuilding those panels needs them re-uploaded
 * here first, or the buttons render blank.
 *
 * Reads the derived PANELS, not every message a panel-bot ever posted. Scanning all of Dyno's
 * messages swept up emoji from ordinary reactions that have nothing to do with any panel, and
 * reported them as things we must re-upload. A false "you must upload 3 emoji" is a step that can
 * never go green.
 */
function deriveMissingEmoji(panels, guild) {
  const need = new Map();
  for (const p of panels) {
    for (const o of p.options) {
      if (!o.emojiId) continue;                                        // unicode is always available
      if (guild.emojis.cache.some(e => e.name === o.emoji.replaceAll(':', ''))) continue; // already ours
      const name = o.emoji.replaceAll(':', '');
      need.set(name, { name, sourceId: o.emojiId, animated: o.animated });
    }
  }
  const list = [...need.values()];
  return field(list, list.length ? 'certain' : 'none',
    list.length ? `${list.length} emoji live on the old bot's server and must be re-uploaded here`
                : 'no external emoji needed');
}

/**
 * Empty duplicate roles, and what they could become.
 *
 * We PROPOSE renames but never names: which spare roles should become timezones and which should
 * become game roles is a judgment about what the server is for, and we do not know that. What we can
 * do — reliably — is find the roles that are safe to touch: zero members, not managed, and a name
 * that already exists elsewhere.
 */
function deriveRoleHygiene(guild) {
  const counts = new Map();
  for (const m of guild.members.cache.values()) {
    for (const id of m.roles.cache.keys()) counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const byName = new Map();
  for (const r of guild.roles.cache.values()) {
    if (r.managed || r.id === guild.id) continue;
    const k = r.name.trim().toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(r);
  }

  const duplicates = [];
  for (const [name, roles] of byName) {
    if (roles.length < 2) continue;
    // Keep the one people are actually in; the empties are the corpses.
    const empties = roles.filter(r => !(counts.get(r.id) > 0));
    const live = roles.filter(r => counts.get(r.id) > 0);
    // If NONE of them has members we still keep one, so the name does not vanish from the server.
    const spare = live.length ? empties : empties.slice(1);
    for (const r of spare) duplicates.push({ id: r.id, name: r.name, position: r.position });
    if (spare.length) {
      logger.debug(`[TakeoverProfile] "${name}" exists ${roles.length}x; ${spare.length} spare`);
    }
  }

  const empty = [...guild.roles.cache.values()].filter(r =>
    !r.managed && r.id !== guild.id && !(counts.get(r.id) > 0)
    && !duplicates.some(d => d.id === r.id));

  return field(
    { duplicates, empty: empty.map(r => ({ id: r.id, name: r.name, position: r.position })) },
    'certain',
    `${duplicates.length} empty duplicate role(s) safe to repurpose; ${empty.length} other empty role(s). `
    + 'What they should BECOME is a judgment about this server — we do not guess at that.');
}

// ── the whole thing ──────────────────────────────────────────────────────────

/**
 * Read a guild and propose its profile. Read-only: touches nothing, posts nothing.
 *
 * Returns the profile with every field's confidence attached. Stored as `proposed`; a human has to
 * approve it before apply() will act on any of it.
 */
export async function deriveProfile(guild, { onProgress } = {}) {
  const started = Date.now();
  const channels = await readable(guild);

  // Members are needed for role-hygiene counts and are NOT in the cache by default.
  await guild.members.fetch().catch(() => logger.warn('[TakeoverProfile] could not fetch members'));

  const messages = [];
  for (const [i, ch] of channels.entries()) {
    onProgress?.({ done: i, total: channels.length, channel: ch.name });
    messages.push(...await history(ch));
  }
  logger.info(`[TakeoverProfile] read ${messages.length} messages across ${channels.length} channels in ${guild.name}`);

  const { panels, selfAssignChannel } = derivePanels(messages, guild);

  const profile = {
    guildId: guild.id,
    guildName: guild.name,
    streamers: deriveStreamers(messages),
    panels,
    selfAssignChannel,
    customCommands: deriveCustomCommands(messages),
    birthdayRole: deriveBirthdayRole(guild),
    platformEmoji: deriveMissingEmoji(panels.value, guild),
    roleHygiene: deriveRoleHygiene(guild),
    stats: {
      messagesRead: messages.length,
      channelsRead: channels.length,
      channelsSkipped: guild.channels.cache.filter(c => c.isTextBased?.()).size - channels.length,
      tookMs: Date.now() - started,
    },
  };

  await pool.execute(
    `INSERT INTO takeover_profiles (guild_id, data, status) VALUES (?, ?, 'proposed')
     ON DUPLICATE KEY UPDATE data = VALUES(data), status = 'proposed',
                             derived_at = CURRENT_TIMESTAMP, approved_by = NULL, approved_at = NULL`,
    [guild.id, JSON.stringify(profile)]);

  return profile;
}

/** The stored profile, whatever its state. Null if we have never studied this guild. */
export async function getProfile(guildId) {
  const [[row]] = await pool.execute(
    'SELECT data, status, derived_at, approved_by, approved_at FROM takeover_profiles WHERE guild_id = ?',
    [guildId]);
  if (!row) return null;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  return { ...data, status: row.status, derivedAt: row.derived_at, approvedBy: row.approved_by };
}

/**
 * A human has checked it. Only now may apply() use it.
 *
 * `edits` lets the reviewer correct what derivation got wrong — above all the emoji-to-role mapping,
 * which is a guess by construction and is the field most likely to be wrong.
 */
export async function approveProfile(guildId, userId, edits = null) {
  const current = await getProfile(guildId);
  if (!current) throw new Error('there is no profile for this server yet — derive one first');

  const merged = edits ? { ...current, ...edits } : current;
  delete merged.status; delete merged.derivedAt; delete merged.approvedBy;

  await pool.execute(
    `UPDATE takeover_profiles SET data = ?, status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP
      WHERE guild_id = ?`,
    [JSON.stringify(merged), userId, guildId]);

  logger.info(`[TakeoverProfile] ${userId} approved the profile for ${guildId}`);
  return merged;
}

/** Every field derivation was NOT sure about. This is the review list, and it is the point. */
export function needsReview(profile) {
  const out = [];
  for (const [key, f] of Object.entries(profile ?? {})) {
    if (!f || typeof f !== 'object' || !('confidence' in f)) continue;
    if (f.confidence === 'guess' || f.confidence === 'likely') {
      out.push({ key, confidence: f.confidence, evidence: f.evidence });
    }
  }
  // Panel buttons we could not resolve at all are the sharpest edge: a panel posted with a null
  // roleId is a button that does nothing.
  const unresolved = (profile?.panels?.value ?? [])
    .flatMap(p => p.options.filter(o => !o.roleId).map(o => `${p.name}: ${o.emoji}`));
  if (unresolved.length) {
    out.push({
      key: 'panels.unresolved',
      confidence: 'unknown',
      evidence: `${unresolved.length} button(s) we could not match to any role — they would do NOTHING if posted: `
        + unresolved.slice(0, 8).join(', ') + (unresolved.length > 8 ? '…' : ''),
    });
  }
  return out;
}

export default { deriveProfile, getProfile, approveProfile, needsReview };
