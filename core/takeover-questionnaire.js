/*
 * Build the takeover questionnaire for ONE guild, from that guild's own audit.
 *
 * The old questionnaire (core/takeover-questions.js QUESTIONS) was a single hardcoded list written for
 * one server — it asked every owner about Ko-fi, DISBOARD, a tree called "Kababi", an "ALT" role and
 * "seven spare roles" whether or not any of that was ever in their server. This generates the
 * "Decisions" section from what the scan ACTUALLY found: the bots still present (core/takeover-manager
 * KNOWN_BOTS via resolveBotMeta), the real empty/duplicate roles (deriveProfile roleHygiene), and the
 * live security posture (MFA / verification level). The generic feature menu (CATALOGUE) is carried
 * over but marked with what the guild already has.
 *
 * SECURITY: the generated set is the validation whitelist for a public, unauthenticated form. It is
 * produced here, server-side, from the scan — never from client input — and persisted per guild
 * (takeover_profiles.questionnaire_json) so the save endpoint validates against exactly what it
 * authored. See dashboard/routes/kabster.js and core/takeover-questions.js validateAnswer.
 *
 * Stable keys: `tree`, `owo`, `kofi`, `roles_ok`, `panels_ok` are emitted with those exact keys when
 * the relevant bot/condition is present, because core/takeover-decisions.js STEP_DECISION gates plan
 * steps on them. Generic replaceable bots get `bot_<feature>` keys (not step-gated, same as before).
 */
import pool from '../utils/db.js';
import { CATALOGUE, QCC } from './takeover-questions.js';
// Straight from the catalog, NOT via takeover-manager. The manager imports this module's consumer
// (takeover-decisions), so routing through it would close a cycle: manager → decisions →
// questionnaire → manager. The catalog imports nothing of ours and is the real home of all three.
import { resolveBotMeta, featuresOf, FEATURES } from './takeover-bots.js';
import { getProfile } from './takeover-profile.js';
import logger from '../utils/logger.js';

/**
 * Catalogue feature -> the config table that proves the guild already has it (for `have` badges), or
 * [table, condition] when having a row is not the same as being on.
 */
const HAVE_TABLE = Object.freeze({
  feat_antinuke: 'anti_nuke_config', feat_antiraid: ['raid_detection_config', '(enabled = 1 OR auto_lockdown_enabled = 1)'],
  feat_phishing: 'phishing_config',
  feat_verify: 'verify_config', feat_suggestions: 'suggestion_config', feat_starboard: 'starboard_config',
  feat_leveling: 'level_config', feat_qotd: 'qotd_channels', feat_events: 'event_schedule_config',
  feat_confessions: 'confession_config', feat_twitchsched: 'twitch_schedule_sync_config',
  feat_tickets: 'ticket_panels', feat_economy: 'economy_config', feat_serverstats: 'stat_display_channels',
});

/**
 * A bot `feature` slug -> the catalogue key(s) it satisfies, so replacing it flips those items to
 * `have`.
 *
 * The catalogue is meant to be "things your server has never had, that you could switch on". An
 * item the takeover is ALREADY bringing across is not that, and asking an owner whether they would
 * like welcome messages — while the plan above says we are taking over the welcome messages their
 * bot posts today — is the fastest way to make the whole page look like it was written for someone
 * else. This map is what keeps the menu honest, so it has to cover every feature the catalog knows,
 * not the six it happened to start with.
 */
const FEATURE_TO_CATALOGUE = Object.freeze({
  moderation: ['feat_warnings', 'feat_automod', 'feat_antiraid', 'feat_antispam', 'feat_phishing'],
  soundboard: ['feat_soundboard'],
  free_games: ['feat_selfpromo'],
  streams: ['feat_selfpromo', 'feat_socialfeeds'],
  custom_commands: ['feat_tags'],
  cannabis: ['feat_confessions'],
  leveling: ['feat_leveling'],
  welcome: ['feat_welcome'],
  tickets: ['feat_tickets'],
  starboard: ['feat_starboard'],
  suggestions: ['feat_suggestions'],
  giveaways: ['feat_giveaways'],
  polls: ['feat_polls'],
  qotd: ['feat_qotd'],
  events: ['feat_events'],
  music: ['feat_music'],
  economy: ['feat_economy'],
  reaction_roles: ['feat_verify'],
  birthday: ['feat_announce'],
});

const latestScan = async (guildId) => {
  const [[scan]] = await pool.execute(
    "SELECT id FROM guild_scans WHERE guild_id = ? AND status = 'complete' ORDER BY finished_at DESC, id DESC LIMIT 1",
    [guildId]);
  return scan?.id ?? null;
};

const presentBots = async (scanId) => {
  const [bots] = await pool.execute(
    "SELECT bot_id, name FROM guild_scan_bots WHERE scan_id = ? AND kind = 'bot' AND present = 1 ORDER BY messages DESC",
    [scanId]);
  return bots;
};

// ── decision templates. Each returns a question in the shape the page already renders. ──────────────
const D = 'Decisions', ROLES = 'Roles', SEC = 'Security';

function botDecision(meta) {
  // Special, stable keys the plan gates on.
  if (meta.feature === 'growtree') return {
    key: 'tree', section: D, q: `The tree (${meta.name})`,
    why: `You run ${meta.name}. We have our own tree — members plant, water and grow it. We can carry your `
       + `current tree over at its height so nobody loses progress, start everyone fresh, or leave ${meta.name} in place.`,
    options: [
      { v: 'carry', label: 'Carry it over', detail: 'Same height, nobody loses progress' },
      { v: 'fresh', label: 'Start fresh', detail: 'A clean sapling for everyone' },
      { v: 'keep',  label: `Leave ${meta.name}`, detail: 'Their tree stays; we do not run one' },
    ],
    note: 'Anything about the tree? (e.g. a "natural disaster" story for a reset.)',
  };
  if (meta.feature === 'owo') return {
    key: 'owo', section: D, q: `OwO progress (${meta.name})`,
    why: `You run ${meta.name}. We have our own OwO. We can carry levels, XP and balances over, start the whole `
       + `server fresh, or leave the real ${meta.name} alone.`,
    options: [
      { v: 'carry', label: 'Carry it all over', detail: 'Levels, XP, team and balance' },
      { v: 'fresh', label: 'Everyone starts fresh', detail: 'A clean slate for the whole server' },
      { v: 'keep',  label: `Leave ${meta.name}`, detail: 'The real OwO stays; we do not run it' },
    ],
    note: 'Anything about OwO?',
  };
  if (meta.feature === 'kofi') return {
    key: 'kofi', section: D, q: `Ko-fi supporter roles (${meta.name})`,
    why: `Ko-fi keeps a token only you can copy from your own Ko-fi settings — no bot can fetch it. It is the one `
       + `thing we cannot do for you without a hand from you.`,
    options: [
      { v: 'token', label: "I'll get the token", detail: 'We take over supporter roles automatically' },
      { v: 'keep',  label: `Leave ${meta.name} alone`, detail: 'It stays; nothing changes' },
      { v: 'drop',  label: "Drop it — I don't use it", detail: 'It leaves; no supporter roles' },
    ],
    note: 'Anything about Ko-fi?',
  };
  if (meta.feature === 'reaction_roles') return {
    key: 'panels_ok', section: ROLES, q: `Replace ${meta.name}'s reaction-role panels`,
    why: `${meta.name} runs your self-assign role panels. We can rebuild them as button panels and take its old `
       + `ones down in the same step — once ${meta.name} leaves, its panels still show reactions but do nothing.`,
    options: [{ v: 'go', label: 'Go ahead' }, { v: 'hold', label: 'Hold off for now' }],
  };

  // Coverage 'none' — a bot we do NOT replace. Keep or remove is the only real question.
  if (!meta.feature || meta.coverage === 'none') return {
    key: `bot_${slug(meta.name)}`, section: D, q: meta.name,
    why: (meta.why ? meta.why[0].toUpperCase() + meta.why.slice(1) + '. ' : '')
       + `We do not replace this — it is just a question of whether you want it here.`,
    options: [
      { v: 'keep',   label: 'Keep it', detail: 'It stays in the server' },
      { v: 'remove', label: 'Remove it', detail: 'It leaves' },
    ],
  };

  // Generic replaceable bot: we have the feature.
  //
  // The jobs are SPELLED OUT. "You run Dyno; we have our own version of what it does" is a question
  // nobody can answer honestly — Dyno does seven things, and the person reading this is being asked
  // whether all seven can be taken over. Naming them is the difference between informed consent and
  // a shrug.
  const partial = meta.coverage === 'partial';
  const jobs = featuresOf(meta).map(f => FEATURES[f]?.label ?? f);
  const lead = jobs.length > 1 ? `${meta.name} runs ${listOf(jobs)} in this server. ` : '';
  // Catalog `why` lines are written to follow a colon ("partial: we cover…"), so they start
  // lowercase. Here one can land straight after a full stop — capitalise it rather than shipping a
  // sentence that starts mid-word.
  const detail = meta.why
    ? (lead ? meta.why[0].toUpperCase() + meta.why.slice(1) : meta.why) + ' '
    : (lead ? 'We have our own version of all of it. ' : `You run ${meta.name}; we have our own version of what it does. `);
  return {
    key: `bot_${meta.feature}`, section: D, q: `${meta.name}`,
    why: lead + detail
       + (partial ? 'Note it is a partial match — see the detail.' : 'We can take it over so you can drop the extra bot.'),
    options: [
      { v: 'replace', label: 'Take it over', detail: partial ? 'We cover the Discord half' : 'We run it; the old bot can leave' },
      { v: 'keep',    label: `Keep ${meta.name}`, detail: 'Leave it in place; we do not run this' },
    ],
    note: partial ? 'Anything from it you must keep?' : null,
  };
}

const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'bot';

/** "a, b and c" — a list a person reads, not an array they parse. */
const listOf = (xs) => xs.length < 2 ? (xs[0] ?? '')
  : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

async function detectHave(guildId) {
  const have = new Set();
  for (const [key, spec] of Object.entries(HAVE_TABLE)) {
    const [table, where] = Array.isArray(spec) ? spec : [spec, null];
    try {
      const [[row]] = await pool.execute(`SELECT COUNT(*) n FROM \`${table}\` WHERE guild_id = ?${where ? ` AND ${where}` : ''}`, [guildId]);
      if (row.n > 0) have.add(key);
    } catch { /* table may not exist in some deployments — skip */ }
  }
  return have;
}

/** Security questions we can only answer from the live guild (MFA, verification level, admin roles). */
function securityQuestions(guild) {
  const out = [];
  if (!guild) return out;
  if (Number(guild.mfaLevel) === 0) out.push({
    key: 'sec_2fa', section: SEC, q: 'Require 2FA for moderators',
    why: 'Discord can require two-factor auth on any account with moderation powers. It is currently off.',
    options: [{ v: 'on', label: 'Turn it on' }, { v: 'off', label: 'Leave it off' }],
  });
  if (Number(guild.verificationLevel) <= 1) out.push({
    key: 'sec_verify', section: SEC, q: 'Verification level',
    why: 'It is currently low, which lets a brand-new account post the moment it joins. Raising it is the usual '
       + 'first defence against a raid.',
    options: [{ v: 'raise', label: 'Raise it' }, { v: 'keep', label: 'Leave it as it is' }],
  });
  // sec_alt: an admin-power role held by very few accounts is worth flagging — best-effort.
  try {
    const ADMIN = 1n << 3n;
    const suspect = guild.roles?.cache?.find((r) =>
      r.id !== guild.id && !r.managed && (BigInt(r.permissions.bitfield ?? r.permissions) & ADMIN) === ADMIN
      && r.members && r.members.size > 0 && r.members.size <= 3
      && !/admin|owner|staff|mod|founder/i.test(r.name));
    if (suspect) out.push({
      key: 'sec_alt', section: SEC, q: `The "${suspect.name}" role`,
      why: `A role called "${suspect.name}" carries administrator power and sits on ${suspect.members.size} `
         + `account(s). It may be deliberate — you would know better than us.`,
      options: [
        { v: 'intended', label: "That's intentional", detail: 'Leave it alone' },
        { v: 'strip', label: 'Strip its powers', detail: 'It should not have those' },
        { v: 'unsure', label: 'Not sure what it is', detail: "We'll dig in before touching anything" },
      ],
    });
  } catch (e) { logger.debug?.(`[questionnaire] sec_alt skipped: ${e.message}`); }
  return out;
}

/**
 * Build (and persist) the questionnaire for a guild. `guild` is the live discord.js Guild when we have
 * it (enables the security questions); it is resolved from the bot manager when not passed.
 */
export async function buildQuestionnaire(guildId, guild = null) {
  if (!guild) {
    try { guild = global.botManager?.getClientForGuild?.(guildId)?.guilds?.cache?.get(guildId) ?? null; } catch { /* ignore */ }
  }

  const scanId = await latestScan(guildId);
  if (!scanId) {
    const set = { scanned: false, decisions: [], catalogue: [], generatedAt: new Date().toISOString() };
    await persist(guildId, set);
    return set;
  }

  const profile = await getProfile(guildId).catch(() => null);
  const bots = await presentBots(scanId);

  const decisions = [];
  const coveredFeatures = new Set();
  const seenKeys = new Set();
  for (const b of bots) {
    const meta = resolveBotMeta(b.bot_id, b.name);
    if (!meta || meta.coverage === 'self' || meta.coverage === 'system') continue;
    const q = botDecision(meta);

    // Two bots can share a primary feature (a server running both Dyno and Carl-bot). The old code
    // dropped the second question outright, which meant the owner was never asked about a bot that
    // is really in their server. Make the key unique instead — the answer is per-bot either way.
    if (seenKeys.has(q.key)) q.key = `${q.key}_${slug(meta.name)}`;
    if (seenKeys.has(q.key)) continue; // genuinely the same bot twice (member + webhook)
    seenKeys.add(q.key);
    decisions.push(q);
    for (const f of featuresOf(meta)) coveredFeatures.add(f);
  }

  // Roles: only if there is anything to tidy.
  const empty = profile?.roleHygiene?.value?.empty ?? [];
  const dups = profile?.roleHygiene?.value?.duplicates ?? [];
  const spareCount = empty.length + dups.length;
  if (spareCount > 0) {
    decisions.push({
      key: 'spare_roles', section: ROLES, q: `${spareCount} spare role${spareCount === 1 ? '' : 's'}`,
      why: `The tidy-up leaves ${spareCount} empty role${spareCount === 1 ? '' : 's'} going spare. They would make `
         + `good game or interest roles, but you know what this server plays and we do not.`,
      options: [
        { v: 'names', label: "I'll name them", detail: 'Write them below and we build a pick-a-role panel' },
        { v: 'skip',  label: 'Leave them empty for now', detail: 'We will not touch them' },
      ],
      note: 'One per line — e.g. Fortnite, Minecraft, Movie Nights…',
    });
    if (!seenKeys.has('panels_ok')) decisions.push({
      key: 'roles_ok', section: ROLES, q: 'The role clean-up',
      why: `Renaming the ${spareCount} empty role${spareCount === 1 ? '' : 's'} into useful ones. Nothing with a person `
         + `in it is touched, and nothing is deleted.`,
      options: [{ v: 'go', label: 'Go ahead' }, { v: 'hold', label: 'Hold off for now' }],
    });
  }

  // Streamers / Twitch — only if the server actually streams.
  const streamers = profile?.streamers?.value ?? [];
  if (streamers.length > 0 || coveredFeatures.has('streams')) {
    decisions.push({
      key: 'twitch_roles', section: ROLES, q: 'Link your Twitch, so VIPs and mods get roles here',
      why: 'Connect your Twitch and anyone you make a VIP or mod on stream gets the matching Discord role '
         + 'automatically — and loses it if you remove it on Twitch. Subscriber roles are Discord\'s own job '
         + '(Server Settings → Integrations → Twitch) and are better done there.',
      options: [
        { v: 'yes', label: 'Yes, link it', detail: "One click on our site" },
        { v: 'later', label: 'Maybe later', detail: 'Switch it on any time' },
        { v: 'no', label: 'No thanks', detail: 'Keep Twitch and Discord separate' },
      ],
      note: 'Which Discord roles should your Twitch VIPs and mods get?',
    });
  }

  // Security (live guild).
  decisions.push(...securityQuestions(guild));

  // Always: free-text.
  decisions.push(...QCC);

  // Catalogue with `have` marks.
  const have = await detectHave(guildId);
  for (const f of coveredFeatures) for (const k of FEATURE_TO_CATALOGUE[f] ?? []) have.add(k);
  const catalogue = CATALOGUE.map((c) => ({ ...c, have: have.has(c.key) }));

  const set = { scanned: true, decisions, catalogue, generatedAt: new Date().toISOString() };
  await persist(guildId, set);
  logger.info(`[questionnaire] built for ${guildId}: ${decisions.length} decisions (${bots.length} bots scanned)`);
  return set;
}

async function persist(guildId, set) {
  await pool.execute(
    `INSERT INTO takeover_profiles (guild_id, data, questionnaire_json, questionnaire_generated_at, status)
     VALUES (?, '{}', ?, CURRENT_TIMESTAMP, 'proposed')
     ON DUPLICATE KEY UPDATE questionnaire_json = VALUES(questionnaire_json), questionnaire_generated_at = CURRENT_TIMESTAMP`,
    [guildId, JSON.stringify(set)]);
}

/** The stored generated set — regenerates if missing. Used by the render + validation paths. */
export async function getQuestionnaire(guildId, { rebuild = false } = {}) {
  if (!rebuild) {
    const [[row]] = await pool.execute('SELECT questionnaire_json FROM takeover_profiles WHERE guild_id = ?', [guildId]);
    if (row?.questionnaire_json) {
      try { return JSON.parse(row.questionnaire_json); } catch { /* fall through to rebuild */ }
    }
  }
  return buildQuestionnaire(guildId);
}

export default { buildQuestionnaire, getQuestionnaire };
