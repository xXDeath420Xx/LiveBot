/*
 * Doing what the owner asked for.
 *
 * The questionnaire has always ASKED which of our features a server wants — forty-five of them —
 * stored the answers, and then acted on none of them. An owner could tick twenty-four boxes, watch
 * the plan report success, and find nothing switched on, because every step in the takeover was
 * about REPLACING an incumbent. Anything the server never had was recorded and forgotten.
 *
 * This is the other half: each `feat_*` answer mapped to the thing that makes it true.
 *
 * `kind` is the honest verdict on what that takes, and the difference matters more here than
 * anywhere else in the takeover, because this is where we would be creating things in somebody's
 * server rather than reproducing what was already there:
 *
 *   'config'      — a row we can write. One click, reversible, nothing appears in the server.
 *   'standing'    — already true. A command that exists from startup; there is nothing to set up.
 *   'creates'     — needs a channel, a category or a role that does not exist yet. We make it, and
 *                   we say exactly what we made.
 *   'needs-input' — needs a decision only the owner can make: WHICH game to watch, WHICH account to
 *                   mirror, WHICH voice channel to lock. Offering to guess at these would be how a
 *                   server ends up with a feed nobody asked for pointing at the wrong account.
 *
 * Nothing here runs unless the owner answered `yes` to it. A `no` is a decision, and a question we
 * never put to them is not consent.
 */
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

/** Write a single flag on a per-guild config table. The workhorse. */
const enable = (table, column = 'enabled', extra = {}) => async (guild) => {
  const cols = ['guild_id', column, ...Object.keys(extra)];
  const vals = [guild.id, 1, ...Object.values(extra)];
  const updates = [column, ...Object.keys(extra)].map(c => `\`${c}\` = VALUES(\`${c}\`)`).join(', ');
  await pool.execute(
    `INSERT INTO \`${table}\` (${cols.map(c => `\`${c}\``).join(',')}) VALUES (${cols.map(() => '?').join(',')})
     ON DUPLICATE KEY UPDATE ${updates}`, vals);
  return `${table}.${column} = on`;
};

/** Is a flag already set? Used so a re-run reports "already on" instead of pretending it did work. */
const isOn = (table, column = 'enabled') => async (guild) => {
  const [[row]] = await pool.execute(
    `SELECT \`${column}\` AS v FROM \`${table}\` WHERE guild_id = ?`, [guild.id]).catch(() => [[]]);
  return !!row?.v;
};

/**
 * Where a new channel belongs, in a server we did not lay out.
 *
 * A channel created with no parent lands at the server root, above every category — mechanically
 * fine and visually wrong, which is how a support channel ends up floating above the rules. Match
 * the server's OWN category names rather than imposing a structure on it: a server that calls its
 * chat section "Text Channels" and one that calls it "💬 Community" both get the right answer, and a
 * server with no matching category gets no parent rather than a category it never asked for.
 */
const CATEGORY_HINTS = Object.freeze({
  community: /text|chat|community|general|main|lounge|social/i,
  support:   /support|help|ticket/i,
  staff:     /staff|admin|mod|team/i,
  stats:     /stat|info|counter/i,
});

function findCategory(guild, kind) {
  const re = CATEGORY_HINTS[kind];
  if (!re) return null;
  return [...guild.channels.cache.values()].find(c => c.type === 4 && re.test(String(c.name))) ?? null;
}

/**
 * Find a channel by name-ish, or make one — under a sensible parent.
 *
 * `category` names the KIND of home it wants; the server's own category names decide which that is.
 */
async function ensureChannel(guild, { name, topic, type = 0, parent = null, category = null, reason }) {
  const want = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const found = [...guild.channels.cache.values()].find(c =>
    c.type === type && String(c.name).toLowerCase().replace(/[^a-z0-9]/g, '') === want);
  if (found) return { channel: found, created: false };

  const home = parent ?? findCategory(guild, category)?.id ?? null;
  const channel = await guild.channels.create({
    name, type, ...(home ? { parent: home } : {}), ...(topic ? { topic } : {}),
    reason: String(reason ?? 'Takeover: the owner asked for this').replace(/[^\x20-\x7E]/g, '').slice(0, 400),
  });
  return { channel, created: true, parentName: home ? guild.channels.cache.get(home)?.name ?? null : null };
}

/** Find a role by name, or make one. */
async function ensureRole(guild, { name, colour = null, permissions = [], reason }) {
  const want = name.toLowerCase().trim();
  const found = guild.roles.cache.find(r => !r.managed && r.name.toLowerCase().trim() === want);
  if (found) return { role: found, created: false };

  const role = await guild.roles.create({
    name, ...(colour ? { color: colour } : {}), permissions,
    reason: String(reason ?? 'Takeover: the owner asked for this').replace(/[^\x20-\x7E]/g, '').slice(0, 400),
  });
  return { role, created: true };
}

/**
 * The map. One entry per catalogue key the owner can say yes to.
 *
 * Keys with no entry are features whose setup is genuinely a conversation — they report as
 * `needs-input` by default rather than silently doing nothing, which is what happened before.
 */
export const CATALOGUE_SETUP = Object.freeze({
  // ── Safety. All flags; nothing appears in the server. ──────────────────────
  feat_antinuke: { label: 'Anti-nuke', kind: 'config',
    done: isOn('anti_nuke_config'), apply: enable('anti_nuke_config') },
  // The raid system's own switch (core/raid-lockdown.js; the old anti_raid_config was never enforced).
  feat_antiraid: { label: 'Raid protection', kind: 'config',
    done: async (guild) => (await (await import('./raid-lockdown.js')).raidProtectionState(guild.id)).on,
    apply: async (guild) => (await import('./raid-lockdown.js')).enableRaidDetection(guild.id) },
  feat_antispam: { label: 'Anti-spam', kind: 'config',
    // A new row gets the Spam limits page's defaults; an existing one keeps its limits (core/automod-spam-config.js).
    done: isOn('automod_spam_config'), apply: async (guild) => { await (await import('./automod-spam-config.js')).enableAutomodSpam(guild.id); return 'automod_spam_config.enabled = on'; } },
  feat_phishing: { label: 'Scam link detection', kind: 'config',
    done: isOn('phishing_config'), apply: enable('phishing_config') },
  // Not its own table — image scanning is a column on the phishing config, because it is the same
  // detector reading a different surface.
  feat_scamimage: { label: 'Scam image detection', kind: 'config',
    done: isOn('phishing_config', 'scan_images'),
    apply: enable('phishing_config', 'enabled', { scan_images: 1 }) },
  feat_globalban: { label: 'Shared ban list', kind: 'config',
    done: isOn('global_ban_config'), apply: enable('global_ban_config') },

  feat_automod: {
    label: 'Word filters & automod', kind: 'config',
    done: async (guild) => {
      const [[row]] = await pool.execute(
        'SELECT COUNT(*) AS n FROM automod_rules WHERE guild_id = ? AND is_enabled = 1', [guild.id]).catch(() => [[]]);
      return Number(row?.n ?? 0) > 0;
    },
    // Invite blocking only. A banned-WORD list is a judgement about a community's own culture and
    // inventing one would be us deciding what a server may say.
    apply: async (guild) => {
      await pool.execute(
        `INSERT INTO automod_rules (guild_id, filter_type, is_enabled, action)
         VALUES (?, 'discord_invites', 1, 'delete')
         ON DUPLICATE KEY UPDATE is_enabled = 1`, [guild.id]).catch(async () => {
        await pool.execute(
          `INSERT INTO automod_rules (guild_id, filter_type, is_enabled, action) VALUES (?, 'discord_invites', 1, 'delete')`,
          [guild.id]);
      });
      return 'invite filter on — add your own word list with /admin mod';
    },
  },

  // ── Running the place ──────────────────────────────────────────────────────
  feat_warnings: {
    label: 'Warnings that escalate', kind: 'creates',
    done: async (guild) => {
      const [[row]] = await pool.execute(
        'SELECT mod_log_channel_id, muted_role_id FROM moderation_config WHERE guild_id = ?', [guild.id]).catch(() => [[]]);
      return !!(row?.mod_log_channel_id && row?.muted_role_id);
    },
    apply: async (guild) => {
      const made = [];
      // Prefer the channel this server already uses for moderation logs over making another one.
      const modLog = [...guild.channels.cache.values()].find(c =>
        c.isTextBased?.() && /log/i.test(c.name) && /\bmod/i.test(c.name))
        ?? (await ensureChannel(guild, { name: 'mod-log', reason: 'Takeover: moderation log' })).channel;

      const { role, created } = await ensureRole(guild, { name: 'Muted', permissions: [], reason: 'Takeover: mute role' });
      if (created) made.push(`created the @${role.name} role`);

      await pool.execute(
        `INSERT INTO moderation_config (guild_id, mod_log_channel_id, muted_role_id) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE mod_log_channel_id = VALUES(mod_log_channel_id), muted_role_id = VALUES(muted_role_id)`,
        [guild.id, modLog.id, role.id]);
      made.push(`warnings log to #${modLog.name}`);
      return made.join(', ');
    },
  },

  feat_suggestions: {
    label: 'Suggestions box', kind: 'creates',
    done: isOn('suggestion_config'),
    apply: async (guild) => {
      const { channel, created, parentName } = await ensureChannel(guild, {
        name: 'suggestions', topic: 'Suggest something — everyone votes, staff decide.',
        category: 'community',
        reason: 'Takeover: the owner asked for a suggestions box',
      });
      await pool.execute(
        `INSERT INTO suggestion_config (guild_id, suggestions_channel_id, enabled) VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE suggestions_channel_id = VALUES(suggestions_channel_id), enabled = 1`,
        [guild.id, channel.id]);
      return `${created ? 'created' : 'using'} #${channel.name}`
        + (created && parentName ? ` in ${parentName}` : '');
    },
  },

  feat_tickets: {
    label: 'Support tickets', kind: 'creates',
    done: async (guild) => {
      const [[row]] = await pool.execute(
        'SELECT ticket_category_id, support_role_id FROM ticket_config WHERE guild_id = ?', [guild.id]).catch(() => [[]]);
      return !!(row?.ticket_category_id && row?.support_role_id);
    },
    apply: async (guild) => {
      const made = [];
      const { channel: category, created: catNew } = await ensureChannel(guild, {
        name: 'Support', type: 4, category: 'support', reason: 'Takeover: ticket category',
      });
      if (catNew) made.push('created the Support category');

      const { channel: panel, created: panelNew } = await ensureChannel(guild, {
        name: 'open-a-ticket', parent: category.id,
        topic: 'Press the button to open a private channel with staff.',
        reason: 'Takeover: ticket panel channel',
      });
      if (panelNew) made.push(`created #${panel.name}`);

      // Reuse an existing staff role rather than inventing a second one — a server with @Moderator
      // does not need an @Support that nobody holds.
      const staff = guild.roles.cache.find(r => !r.managed && /^(support|staff|mod(erator)?s?|admin)$/i.test(r.name))
        ?? (await ensureRole(guild, { name: 'Support', reason: 'Takeover: ticket staff role' })).role;

      const modLog = [...guild.channels.cache.values()].find(c =>
        c.isTextBased?.() && /log/i.test(c.name) && /\bmod/i.test(c.name)) ?? null;

      await pool.execute(
        `INSERT INTO ticket_config (guild_id, panel_channel_id, ticket_category_id, support_role_id, log_channel_id)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE panel_channel_id = VALUES(panel_channel_id),
                                 ticket_category_id = VALUES(ticket_category_id),
                                 support_role_id = VALUES(support_role_id),
                                 log_channel_id = VALUES(log_channel_id)`,
        [guild.id, panel.id, category.id, staff.id, modLog?.id ?? null]);

      made.push(`staff role @${staff.name}`);
      made.push('post the panel with /support panel');
      return made.join(', ');
    },
  },

  feat_verify: {
    label: 'Verification gate', kind: 'config',
    done: isOn('verify_config'),
    // Deliberately reuses an existing rules gate rather than building a second one. A server that
    // already makes people click 👍 on its rules HAS a verification gate; standing up another would
    // be two doors into the same room.
    apply: async (guild) => {
      const [[panel]] = await pool.execute(
        `SELECT p.channel_id, p.message_id, m.role_id
           FROM reaction_role_panels p JOIN reaction_role_mappings m ON m.panel_id = p.id
          WHERE p.guild_id = ? AND (p.panel_name LIKE '%rule%' OR p.panel_name LIKE '%agree%')
          LIMIT 1`, [guild.id]).catch(() => [[]]);
      if (!panel?.role_id) {
        return 'no rules gate found to attach to — run /systems verification setup to build one';
      }
      await pool.execute(
        `INSERT INTO verify_config (guild_id, verified_role_id, gate_channel_id, gate_message_id, enabled)
         VALUES (?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE verified_role_id = VALUES(verified_role_id),
                                 gate_channel_id = VALUES(gate_channel_id),
                                 gate_message_id = VALUES(gate_message_id), enabled = 1`,
        [guild.id, panel.role_id, panel.channel_id, panel.message_id]);
      const role = guild.roles.cache.get(panel.role_id);
      return `attached to the existing rules gate — granting @${role?.name ?? panel.role_id}`;
    },
  },

  feat_serverstats: {
    label: 'Live stat channels', kind: 'creates',
    done: async (guild) => {
      const [[row]] = await pool.execute(
        'SELECT COUNT(*) AS n FROM stat_display_channels WHERE guild_id = ?', [guild.id]).catch(() => [[]]);
      return Number(row?.n ?? 0) > 0;
    },
    apply: async (guild) => {
      const made = [];
      // Voice channels nobody can connect to — that is the whole trick; the NAME is the display.
      // Their own category, at the top, because that is what these are for: a banner. Created once
      // and reused, so a re-run does not stack up empty categories.
      let home = findCategory(guild, 'stats');
      if (!home) {
        home = await guild.channels.create({
          name: '📊 Server Stats', type: 4, position: 0,
          reason: 'Takeover: a home for the live stat channels',
        });
      }

      // The placeholder is `{value}` — that is the token core/stat-display-manager.js substitutes.
      // Writing `{count}` here produced channels literally named "Members: {count}": the updater ran
      // on schedule, found no `{value}` to replace, and renamed each channel to its own template.
      for (const [statType, template] of [['members', 'Members: {value}'], ['online', 'Online: {value}']]) {
        const { channel } = await ensureChannel(guild, {
          name: template.replace('{value}', '—'), type: 2, parent: home.id,
          reason: 'Takeover: live stat channel',
        });
        // Display-only. A voice channel called "Members: 22" that people can sit in is just confusing.
        await channel.permissionOverwrites?.edit(guild.roles.everyone, { Connect: false, ViewChannel: true })
          .catch(() => { /* a locked channel is a nicety; the number is the point */ });
        await pool.execute(
          `INSERT INTO stat_display_channels (guild_id, channel_id, stat_type, template) VALUES (?, ?, ?, ?)`,
          [guild.id, channel.id, statType, template]).catch(() => {});
        made.push(`#${channel.name}`);
      }
      return made.join(', ');
    },
  },

  feat_tts: { label: 'Text to speech', kind: 'config',
    done: isOn('tts_config'), apply: enable('tts_config') },

  feat_selfpromo: {
    label: 'Member stream promotion', kind: 'creates',
    done: isOn('self_promo_config'),
    apply: async (guild) => {
      // Prefer a channel this server already announces lives in.
      const live = [...guild.channels.cache.values()].find(c =>
        c.isTextBased?.() && /live|stream|promo/i.test(c.name));
      if (!live) return 'no live/promo channel found — run /systems selfpromo and pick one';
      await pool.execute(
        `INSERT INTO self_promo_config (guild_id, enabled, channel_id, auto_subscribe) VALUES (?, 1, ?, 1)
         ON DUPLICATE KEY UPDATE enabled = 1, channel_id = VALUES(channel_id), auto_subscribe = 1`,
        [guild.id, live.id]);
      return `members can sign themselves up; announcements go to #${live.name}`;
    },
  },

  // ── Standing commands. Nothing to configure; they exist from startup. ──────
  feat_leveling: { label: 'Levels & XP', kind: 'config', done: isOn('level_config'), apply: enable('level_config') },
  feat_welcome: { label: 'Welcome messages', kind: 'creates',
    done: async (guild) => {
      const [[row]] = await pool.execute(
        'SELECT channel_id FROM welcome_settings WHERE guild_id = ?', [guild.id]).catch(() => [[]]);
      return !!row?.channel_id;
    },
    apply: async (guild) => {
      const { channel, created } = await ensureChannel(guild, {
        name: 'welcome', category: 'community', reason: 'Takeover: welcome channel' });
      await pool.execute(
        `INSERT INTO welcome_settings (guild_id, channel_id, message) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id)`,
        [guild.id, channel.id, 'Welcome {mention} to {server}!']);
      return `${created ? 'created' : 'using'} #${channel.name} — reword it with /manage welcome`;
    },
  },
  feat_giveaways: { label: 'Giveaways', kind: 'standing', note: '/manage giveaway' },
  feat_polls: { label: 'Polls', kind: 'standing', note: '/manage poll' },
  feat_music: { label: 'Music player', kind: 'standing', note: '/music' },
  feat_weather: { label: 'Weather & lookups', kind: 'standing', note: '/tools, /weather' },
  // starboard_config is one row per board (migration 423), so there is no guild_id key to upsert on:
  // switch on the boards the server has; with none, the channel has to be chosen on the Starboard page.
  feat_starboard: { label: 'Starboard', kind: 'config', done: isOn('starboard_config'), apply: async (guild) => {
    const [res] = await pool.execute('UPDATE starboard_config SET enabled = 1 WHERE guild_id = ?', [guild.id]);
    if (!res.affectedRows) throw new Error('No starboard yet: choose its channel on the Starboard page.');
    return 'starboard_config.enabled = on';
  } },
  feat_qotd: { label: 'Question of the day', kind: 'needs-input',
    note: '/qotd setup — pick the channel and how often' },

  // ── Genuinely a conversation. We will not guess these. ─────────────────────
  feat_vcguard: { label: 'Locked voice channels', kind: 'needs-input',
    note: '/voice guard — which channel, and who is allowed in it' },
  feat_socialfeeds: { label: 'Social feeds', kind: 'needs-input',
    note: '/social add — which account, on which platform, into which channel' },
  feat_twitchsched: { label: 'Twitch schedule', kind: 'needs-input',
    note: '/schedule twitch — whose schedule, and where to mirror it' },
  feat_gamepatch: { label: 'Game update watcher', kind: 'needs-input',
    note: '/alerts gamenews — which games you follow' },
});

/**
 * Everything the owner said yes to, and what it would take.
 *
 * Read-only. Every entry carries whether it is already true, so a second run reports "already on"
 * rather than claiming credit for work it did not do.
 */
export async function catalogueWork(guild, decisions) {
  const out = [];
  for (const item of decisions?.wanted ?? []) {
    const spec = CATALOGUE_SETUP[item.key];
    if (!spec) {
      out.push({ key: item.key, label: item.name, kind: 'needs-input',
        note: 'no automated setup for this yet — ask and we will wire it up' });
      continue;
    }
    const already = spec.done ? await spec.done(guild).catch(() => false) : spec.kind === 'standing';
    out.push({ key: item.key, label: spec.label, kind: spec.kind, note: spec.note ?? null, done: already });
  }
  return out;
}

/**
 * Do it.
 *
 * Only `config` and `creates` run; `standing` is already true and `needs-input` is a decision that
 * is not ours. Each failure is caught and reported against its own item — one feature that cannot be
 * set up must never stop the other twenty.
 */
export async function applyCatalogue(guild, decisions, { only = null } = {}) {
  const work = await catalogueWork(guild, decisions);
  const results = [];

  for (const item of work) {
    if (only && !only.includes(item.key)) continue;
    const spec = CATALOGUE_SETUP[item.key];

    if (!spec || item.kind === 'needs-input') {
      results.push({ ...item, outcome: 'needs you', detail: item.note });
      continue;
    }
    if (item.kind === 'standing') {
      results.push({ ...item, outcome: 'already available', detail: spec.note ?? null });
      continue;
    }
    if (item.done) {
      results.push({ ...item, outcome: 'already on' });
      continue;
    }
    try {
      const detail = await spec.apply(guild);
      results.push({ ...item, outcome: 'set up', detail });
      logger.info(`[Takeover] set up "${spec.label}" for ${guild.name}: ${detail}`);
    } catch (err) {
      results.push({ ...item, outcome: 'failed', detail: err.message });
      logger.error(`[Takeover] could not set up "${spec.label}" for ${guild.name}: ${err.message}`);
    }
  }
  return results;
}

export default { CATALOGUE_SETUP, catalogueWork, applyCatalogue };
