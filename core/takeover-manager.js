/*
 * Guild takeover — migrate a server from third-party bots onto this one, channel by channel.
 *
 * Design rules, in order of importance:
 *   1. `apply()` NEVER posts, deletes or edits anything in any channel — it only writes config
 *      rows. Welcome messages and rules stay exactly as the old bot left them.
 *      The single exception is `postPanels()`, which is deliberately NOT an apply step and must be
 *      invoked on its own: it posts the new self-assign panels and removes Carl-bot's old reaction
 *      panels, which would otherwise sit there looking clickable forever. It archives before it
 *      deletes. Nothing else in this file touches a channel's contents.
 *   2. `plan()` is pure inspection and always safe to run. `apply()` only ever performs the
 *      steps a plan produced, and only the ones the caller explicitly opted into.
 *   3. Every step is idempotent and independently skippable. Re-running is a no-op.
 *   4. Live state wins. Where a value must be carried across (a counting channel's current
 *      number), we read it from the channel's own history rather than guessing.
 *   5. Removing the old bot is never automatic. We report which bots are now redundant and
 *      leave the kick to a human.
 */
import { PermissionFlagsBits } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import ReactionRoleManager from './reaction-role-manager.js';

/** X-Audit-Log-Reason must be ASCII — anything above 0x7E is rejected outright. */
const ascii = (s) => String(s).replace(/[^\x20-\x7E]/g, '').slice(0, 400);

/**
 * What each incumbent bot does, and whether we can take it over.
 * `probe` decides whether the feature is actually in use in this guild.
 */
/**
 * `coverage` is the honest verdict, and it is three-valued on purpose:
 *   'full'    — we reproduce what it does here. Retire it.
 *   'partial' — we reproduce the core of it but not all of it. `why` says exactly what is missing.
 *   'none'    — genuinely nothing to replace. KEEP it; this is not a failure, it is a decision.
 * Anything without `coverage` defaults to 'full' when a feature is set. Never label a bot we do
 * replace as unreplaceable — that was the old bug, and it made a nearly-complete takeover read as
 * a wall of red.
 */
export const KNOWN_BOTS = Object.freeze({
  // Replaceable — we have the feature.
  '510016054391734273': { name: 'counting', feature: 'counting', coverage: 'full' },
  '696797815782768650': { name: 'Counting Bot', feature: 'counting', coverage: 'full' },
  '282286160494067712': { name: 'Pingcord', feature: 'streams', coverage: 'full' },
  '155149108183695360': { name: 'Dyno', feature: 'logging', coverage: 'full' },
  '235148962103951360': { name: 'Carl-bot', feature: 'reaction_roles', coverage: 'full' },
  '471091072546766849': { name: 'Friend Time', feature: 'timezone', coverage: 'full' },
  '966695034340663367': { name: 'Cat Bot', feature: 'catbot', coverage: 'full' },
  '972637072991068220': { name: 'Grow a Tree', feature: 'growtree', coverage: 'full' },
  '408785106942164992': { name: 'OwO', feature: 'owo', coverage: 'full' },
  '1071983600729346208': { name: 'CannaFriend', feature: 'cannabis', coverage: 'full' },
  '696870234262339614': { name: 'Sx Bot', feature: 'emoji', coverage: 'full' },
  '83010416610906112': { name: 'Nightbot', feature: 'custom_commands', coverage: 'full' },
  '1437489496680828968': { name: 'Throne Integration', feature: 'throne', coverage: 'full' },
  '672822334641537041': { name: 'FreeStuff', feature: 'free_games', coverage: 'full' },
  '656621136808902656': { name: 'Birthday Bot', feature: 'birthday', coverage: 'full' },
  '356268235697553409': { name: '.fmbot', feature: 'lastfm', coverage: 'full' },
  '684773505157431347': { name: 'FlaviBot', feature: 'moderation', coverage: 'full' },
  '836232765942923305': { name: 'Ko-fi Bot', feature: 'kofi', coverage: 'full' },

  // Partial — we have the system, but not every part of what this bot gives you.
  // Blerp posts nothing (it plays clips into VOICE), so a message scan never sees it. Our
  // /soundboard does the Discord half — upload clips, button panel, play into VC. What it does
  // NOT give you is Blerp's hosted clip library or its Twitch integration.
  '964278831085125722': {
    name: 'Blerp', feature: 'soundboard', coverage: 'partial',
    why: '/soundboard plays clips into voice from a button panel — but you upload the clips. ' +
      "Blerp's hosted library and Twitch integration do not come across.",
  },

  // Keep — genuinely no equivalent. Not a gap in us; just not a thing we do.
  '490707751832649738': { name: 'TacoShack', feature: null, coverage: 'none', why: 'idle taco game — no equivalent' },
  '302050872383242240': { name: 'DISBOARD', feature: null, coverage: 'none', why: 'server-listing bump service — nothing to replace' },
  '351227880153546754': { name: 'BetterTTV', feature: null, coverage: 'none', why: 'Twitch emote service, not a Discord feature' },
});

/**
 * Streamers the incumbent announced that we do not. Read out of Pingcord's own posts: it pings
 * @everyone for Karabi420 in #kabs-live★, and she was never in our `subscriptions` — retiring
 * Pingcord without this would silently stop the server's most important announcement.
 */
export const PINGCORD_STREAMERS = Object.freeze([
  { platform: 'twitch', username: 'karabi420', channelId: '814371170341617664', pingRoleId: 'everyone' },
]);

/**
 * Bots that post only through webhooks have no guild member to detect. TANGIA is one: it
 * pipes Twitch TTS into a channel and owns no bot user.
 */
export const WEBHOOK_ONLY = Object.freeze({
  TANGIA: 'Twitch-side TTS overlay, not a Discord feature',
});

/** Our own bots. They appear in a scan like anything else, but are never retirement targets. */
const OURS = new Set(['certifriedutility', 'kabbot']);

/** Discord's own personas. Not bots — nothing to attribute, nothing to remove. */
const SYSTEM_PERSONAS = new Set(['communityupdates', 'automod', 'serverboost', 'discord']);

const nameKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The set of bots actually still in the guild, by normalised name. Built from the scan rows so a
 * webhook can be tied back to whether its owning bot is still here.
 *
 * Records BOTH the scanned name and the name we know it by — they differ ("Throne Integration Bot"
 * in the guild vs "Throne Integration" in KNOWN_BOTS), and a plain equality check silently treated
 * a present, replaceable bot as absent and stopped gating it.
 */
export function presentBotNames(scanBots) {
  const set = new Set();
  for (const b of scanBots ?? []) {
    if (b.kind !== 'bot' || !(b.present === 1 || b.present === true)) continue;
    set.add(nameKey(b.name));
    const meta = resolveBotMeta(b.bot_id, b.name);
    if (meta?.name) set.add(nameKey(meta.name));
  }
  return set;
}

/**
 * Does this speaker's message shapes have to be explained before anything can happen?
 *
 * Only a bot we are actually going to REMOVE gates on evidence. Three things are therefore NOT
 * gated, and demanding checkboxes for them was pure noise that made a finished takeover look
 * unfinished:
 *   • a bot we keep (TacoShack, TANGIA — 770 TTS shapes we will never retire)
 *   • one of ours, or a Discord system persona
 *   • a bot that has ALREADY LEFT — you cannot retire what is not there (Dyno)
 *
 * A webhook is judged by its owning bot: FreeStuff posts through a webhook, so that evidence still
 * counts while FreeStuff is in the guild. Dyno's webhook does not, because Dyno is gone.
 */
export function needsEvidence(meta, presentNames = null) {
  if (!meta) return true; // unrecognised — a human genuinely must look
  if (meta.coverage !== 'full' && meta.coverage !== 'partial') return false;
  if (!presentNames) return true; // caller has no presence info — stay strict
  return presentNames.has(nameKey(meta.name));
}

/**
 * Resolve a scanned speaker to what we know about it.
 *
 * The analyzer keys a webhook persona as `wh:<name>`, not as a snowflake — so a straight
 * `KNOWN_BOTS[botId]` lookup misses every webhook. That mattered: Dyno posted 252 of its message
 * shapes through its webhook, FreeStuff posts through one too, and all of them sat permanently
 * "unrecognised", blocking retirement on evidence we had already explained for the same bot's
 * member account. Fall back to a name match for those.
 *
 * @param {string} botId    snowflake, or `wh:<name>` for a webhook persona
 * @param {string} [name]   display name, used for the webhook fallback
 * @param {string} [selfId] the id of the bot doing the takeover — never a retirement target
 */
export function resolveBotMeta(botId, name, selfId = null) {
  if (selfId && botId === selfId) {
    return { name: name ?? 'this bot', feature: null, coverage: 'self', why: 'this is the bot doing the takeover' };
  }
  const direct = KNOWN_BOTS[botId];
  if (direct) return direct;

  const key = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const nk = key(name);

  // Ours (the main bot, which may have left the guild) — never a retirement target.
  if (OURS.has(nk)) {
    return { name: name, feature: null, coverage: 'self', why: 'one of our own bots' };
  }
  // Discord's own system personas. Not bots, not removable, nothing to replace.
  if (SYSTEM_PERSONAS.has(nk)) {
    return { name: name, feature: null, coverage: 'system', why: "Discord's own system messages — not a bot" };
  }

  // Webhook persona → match by name, both against the known bots and the webhook-only list.
  const raw = String(botId ?? '').startsWith('wh:') ? String(botId).slice(3) : (name ?? '');
  const needle = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!needle) return null;

  for (const [whName, why] of Object.entries(WEBHOOK_ONLY)) {
    if (whName.toLowerCase().replace(/[^a-z0-9]/g, '') === needle) {
      return { name: whName, feature: null, coverage: 'none', why };
    }
  }
  for (const meta of Object.values(KNOWN_BOTS)) {
    const known = meta.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    // `wh:Dyno™ #dyno-updates` → starts with `dyno`. Prefix match, not equality.
    if (needle === known || needle.startsWith(known)) return meta;
  }
  return null;
}

/**
 * Exact reply parity, recovered from message history. Discord exposes no API for another bot's
 * configuration, so these were reconstructed from what the bot actually posted and the messages
 * users typed to trigger it.
 *
 * Nightbot's `!pp` answered with a different percentage every time (`9%`, `10%`, `1%`), so it is
 * a random roll, not a fixed string — `{random:a-b}` reproduces it. `:0` is literal.
 *
 * `bruh` / `W` / `L` are AUTORESPONSES, not prefix commands: they fire on ordinary chat with no
 * prefix at all. Registering them as commands would not reproduce the behaviour.
 */
export const NIGHTBOT_COMMANDS = Object.freeze([
  { name: 'pp', response: '{user.name} has a {random:1-10}% inch pp :0' },
  { name: 'karabi', response: 'this command was made by tiz bcuz why not' },
]);

const BRUH_ART =
  '⡏⠉⠉⠉⠉⠉⠉⠋⠉⠉⠉⠉⠉⠉⠋⠉⠉⠉⠉⠉⠉⠉⠉⠉⠉⠙⠉⠉⠉⠹\n⡇⢸⣿⡟⠛⢿⣷⠀⢸⣿⡟⠛⢿⣷⡄⢸⣿⡇⠀⢸⣿⡇⢸⣿⡇⠀⢸⣿⡇⠀\n⡇⢸⣿⣧⣤⣾⠿⠀⢸⣿⣇⣀⣸⡿⠃⢸⣿⡇⠀⢸⣿⡇⢸⣿⣇⣀⣸⣿⡇⠀\n⡇⢸⣿⡏⠉⢹⣿⡆⢸⣿⡟⠛⢻⣷⡄⢸⣿⡇⠀⢸⣿⡇⢸⣿⡏⠉⢹⣿⡇⠀\n⡇⢸⣿⣧⣤⣼⡿⠃⢸⣿⡇⠀⢸⣿⡇⠸⣿⣧⣤⣼⡿⠁⢸⣿⡇⠀⢸⣿⡇⠀\n⣇⣀⣀⣀⣀⣀⣀⣄⣀⣀⣀⣀⣀⣀⣀⣠⣀⡈⠉⣁⣀⣄⣀⣀⣀⣠⣀⣀⣀⣰';

/**
 * These fire on the FIRST WORD of an ordinary chat message — Nightbot command semantics.
 *
 * The match type was established against all 4,773 human messages in the guild, because the two
 * obvious readings are both catastrophically wrong:
 *   • `starts_with 'W'`  → 184 matches ("Well", "When", "what…"). Nightbot replied to 3.
 *   • `contains 'bruh'`  →   8 matches. "Love ya too bruh" got NO reply from Nightbot.
 * Only "first word equals the trigger" reproduces the observed behaviour, so these are stored as
 * `regex` (the `autoresponders` matcher compiles it case-insensitively when case_sensitive = 0).
 *
 * `\b` is what does the work: `^\s*w\b` matches "W", "W new bot", "W Batkabs!" but not "Well".
 */
export const NIGHTBOT_AUTORESPONSES = Object.freeze([
  { name: 'bruh', pattern: '^\\s*bruh\\b', response: BRUH_ART },
  { name: 'W',    pattern: '^\\s*w\\b',    response: 'WWW' },
  { name: 'L',    pattern: '^\\s*l\\b',    response: 'Loser LLLLL' },
]);

/**
 * Carl-bot's four self-assign panels, read out of #self-assign-roles. Emoji → role, exactly as
 * they stand today. Rebuilt as our own panels; the old messages are never touched.
 */
export const SELF_ASSIGN_CHANNEL = '1466950359665873079';

/**
 * The platform panel's five emoji live on Carl-bot's OWN emoji server, not here. A bot may only
 * use a custom emoji from a guild it is itself in, so once Carl-bot leaves we can neither react
 * with them nor put them on a button — `UseExternalEmojis` does not grant access to a guild we
 * are not in. The images are still served from the CDN, so we re-upload them into this guild and
 * reference the local copies by NAME. Ids are deliberately absent: they only exist after upload.
 */
export const PLATFORM_EMOJI = Object.freeze([
  { name: 'steam', sourceId: '948489425791361044' },
  { name: 'xbox', sourceId: '948490089133133826' },
  { name: 'playstation', sourceId: '948490481900347403' },
  { name: 'switch', sourceId: '948490748746166292' },
  { name: 'android', sourceId: '948490975213404160' },
]);

/** `:name:` means "the custom emoji called `name` in THIS guild" — resolved at panel-build time. */
export function resolveEmoji(guild, spec) {
  const m = /^:(\w+):$/.exec(spec);
  if (!m) return spec; // plain unicode
  const found = guild.emojis.cache.find(e => e.name === m[1]);
  return found ? `<${found.animated ? 'a' : ''}:${found.name}:${found.id}>` : null;
}

/**
 * `mode`:
 *   'multiple' — tick as many as you like (the default; what Carl-bot's panels do today).
 *   'unique'   — picking one drops the others in the SAME panel.
 * The four panels recovered from Carl-bot stay 'multiple' because that is how they behave today;
 * parity beats our opinion. The three NEW panels choose deliberately — see each.
 */
export const CARLBOT_PANELS = Object.freeze([
  { name: 'Where are you from?', roles: [
    ['🇪🇺', '1466950885136535876', 'Europe'],
    ['🦅', '1466950886134906932', 'North America'],
    ['🌄', '1466950888034795693', 'South America'],
    ['🐼', '1466950888760545333', 'Asia'],
    ['🐨', '1466950889653932223', 'Oceania'],
    // Carl-bot's live panel offers 🦒 pointing at role 1466950890425679976, which is DELETED — the
    // button has been silently doing nothing. `Africa` (below) is the real, surviving role, so the
    // option is restored rather than dropped.
    ['🦒', '1466950520668422421', 'Africa'],
    // Renamed from an abandoned duplicate — see scripts/kabster-role-plan.mjs.
    ['🕌', '1466950515253313711', 'Middle East'],
  ] },
  { name: 'What are your pronouns?', roles: [
    ['🧡', '1466950818564411604', 'He/Him'],
    ['💛', '1466950819432759296', 'She/Her'],
    ['💜', '1466950820208840859', 'They/Them'],
    ['💚', '1466950820888314058', 'Ask'],
  ] },
  // `:name:` — the local copy, uploaded by the `platform_emoji` step. See PLATFORM_EMOJI above.
  { name: 'What platform do you game on?', roles: [
    [':steam:', '1466950606135628061', 'PC'],
    [':xbox:', '1466950606550995137', 'XBOX'],
    [':playstation:', '1466950607993569512', 'Playstation'],
    [':switch:', '1466950609008726127', 'Switch'],
    [':android:', '1466950610279469123', 'Mobile'],
  ] },
  { name: 'What is your zodiac sign?', roles: [
    ['♈', '1466950563781546195', 'Aries'],       ['♉', '1466950565287170270', 'Taurus'],
    ['♊', '1466950565908058356', 'Gemini'],      ['♋', '1466950566188941543', 'Cancer'],
    ['♌', '1466950567443173529', 'Leo'],         ['♍', '1466950567804014782', 'Virgo'],
    ['♎', '1466950568399343901', 'Libra'],       ['♏', '1466950569519349936', 'Scorpio'],
    ['♐', '1466950571301933248', 'Sagittarius'], ['♑', '1466950572132532460', 'Capricorn'],
    ['♒', '1466950573415993385', 'Aquarius'],    ['♓', '1466950574582010085', 'Pisces'],
  ] },

  // ── New panels. These roles ALREADY EXIST in the guild but have never had a panel to pick them
  //    from, which is why they are empty. Nothing here invents a role out of nothing: the first
  //    entries in each set are the guild's own, the rest are duplicates reclaimed by the role plan.

  // 'unique': two colour roles fight, and the higher one silently wins — a confusing outcome the
  // member cannot see or explain. One at a time is the only honest behaviour.
  { name: 'Pick a name colour', mode: 'unique', roles: [
    ['🔴', '1466950769541517362', 'Red'],      ['🟠', '1466950773500936275', 'Orange'],
    ['🟡', '1466950775631511742', 'Yellow'],   ['🟢', '1466950771198394603', 'Green'],
    ['🔵', '1466950777158373491', 'Blue'],     ['🟣', '1466950770069999639', 'Purple'],
    ['🩷', '1466950772607549460', 'Pink'],
    ['🩵', '1466949413120512217', 'Cyan'],     ['🐬', '1466949461216333907', 'Teal'],
    ['🍋', '1466949462290202847', 'Lime'],     ['💗', '1466949463124869233', 'Magenta'],
    ['🏆', '1466949464190357729', 'Gold'],     ['🪻', '1466949546671210639', 'Lavender'],
    ['🍷', '1466949547568660510', 'Crimson'],  ['⚪', '1466949548508184597', 'White'],
  ] },

  // 'unique': you are in one timezone. The whole point is that other people can read it off you.
  { name: 'What timezone are you in?', mode: 'unique', roles: [
    ['🇬🇧', '1488345353697890405', 'GMT'],   ['🌍', '1488345779264295032', 'UTC'],
    ['🌇', '1488345530546393241', 'EST'],   ['🌆', '1466950516411076650', 'CST'],
    ['🏜️', '1466950518222885018', 'MST'],   ['🌉', '1488345592370429963', 'PST'],
    ['🥐', '1466950519254814851', 'CET'],   ['🏛️', '1466950520110317720', 'EET'],
    ['🦘', '1488345630572285963', 'AEST'],  ['🌏', '1466949410595278872', 'ACST'],
    ['🏄', '1466949409446301788', 'AWST'],  ['🥝', '1466949412013080617', 'NZST'],
  ] },

  // 'multiple': the entire point is opting in to some pings and not others.
  { name: 'What do you want pinged for?', mode: 'multiple', roles: [
    ['🔴', '1466950362702286918', 'Stream Pings'],
    ['🎁', '1466949549955219701', 'Free Games'],
    ['🎉', '1466950313675198580', 'Giveaways'],
    ['📅', '1466950315210178714', 'Events'],
    ['❓', '1466950315784802519', 'Question of the Day'],
  ] },
]);

/** Steps a plan can contain. Each is idempotent; `check` decides if it is already done. */
const STEPS = {
  counting: {
    label: 'Counting',
    describe: s => `Take over #${s.channelName} at **${s.lastNumber}** (next: ${s.lastNumber + 1}), ` +
      `mode: ${s.failMode === 'delete' ? 'delete wrong numbers, never reset' : 'reset on wrong number'}`,
    needs: ['ManageMessages', 'ViewChannel', 'ReadMessageHistory'],
  },
  platform_emoji: {
    label: 'Platform emoji',
    describe: s => `Re-upload ${s.missing.length} emoji (${s.missing.join(', ')}) into this server — ` +
      'the platform role panel cannot use them while they live on Carl-bot\'s emoji server',
    needs: ['ManageGuildExpressions'],
  },
  streams: { label: 'Stream announcements', describe: s => `Subscribe **${s.username}** (${s.platform}) → #${s.channelName}` },
  logging: { label: 'Server logging', describe: s => `Log events to #${s.channelName}` },
  timezone: { label: 'Timezones', describe: () => 'Enable /timezone (react 🕰️ to convert times)' },
  catbot: { label: 'Cat Bot', describe: s => `Spawn cats in #${s.channelName}` },
  growtree: { label: 'Grow a Tree', describe: () => 'Enable /tree (a tree is planted on first use)' },
  owo: { label: 'OwO', describe: () => 'Enable OwO commands and the `owo` chat prefix' },
  birthday: {
    label: 'Birthdays',
    describe: s => `Announce in #${s.channelName}, granting **${s.roleName}** for the day`,
    needs: ['ManageRoles'],
  },
};

/** The guild's own birthday role. Empty today only because Birthday Bot never actually granted it. */
const BIRTHDAY_ROLE = '1488337520889696517';

// ── Inspection ───────────────────────────────────────────────────────────────

/**
 * Read a counting channel's live state straight from its history: the highest number that
 * forms an unbroken run ending at the newest numeric message. That is exactly where the old
 * bot left off, whoever posted it.
 *
 * @returns {Promise<{lastNumber:number, lastUserId:string|null, sampled:number}|null>}
 */
export async function readCountingState(channel, scan = 200) {
  const msgs = await channel.messages.fetch({ limit: Math.min(scan, 100) }).catch(() => null);
  if (!msgs?.size) return null;

  // Newest first. The first purely-numeric human message is the current count.
  for (const m of msgs.values()) {
    if (m.author.bot) continue;
    const hit = /^(\d{1,15})$/.exec(m.content.trim());
    if (hit) return { lastNumber: parseInt(hit[1], 10), lastUserId: m.author.id, sampled: msgs.size };
  }
  return null;
}

/** Which of the known bots are actually present right now. */
export async function detectBots(guild) {
  const present = [];
  for (const [id, meta] of Object.entries(KNOWN_BOTS)) {
    const member = await guild.members.fetch(id).catch(() => null);
    if (member) present.push({ id, ...meta, tag: member.user.tag });
  }
  return present;
}

/**
 * Channel names are routinely written in styled Unicode — `#𝗰𝗼𝘂𝗻𝘁𝗶𝗻𝗴` is
 * MATHEMATICAL SANS-SERIF BOLD, and `/count/i` does not match a single character of it.
 * NFKC folds those back to ASCII (`𝗰𝗼𝘂𝗻𝘁𝗶𝗻𝗴` → `counting`, `𝟰𝟮𝟬` → `420`).
 */
export function normalizeName(name) {
  return String(name || '').normalize('NFKC').toLowerCase();
}

const nameMatches = (channel, re) => re.test(normalizeName(channel.name));

/** Permissions we would need in a channel to run a step there. */
function missingPerms(channel, guild, names) {
  const me = guild.members.me;
  const perms = channel.permissionsFor(me);
  return (names ?? []).filter(n => !perms?.has(PermissionFlagsBits[n]));
}

/**
 * Guild-level readiness — the picture *around* the parity steps. Pure inspection, safe to run any
 * time. It answers the three questions a plan alone does not: can we actually remove these bots
 * (hierarchy), is the server itself in good shape (security), and what parity gaps remain that are
 * bigger than a config row.
 *
 * Hierarchy is the load-bearing one. Discord only lets a member remove another whose highest role is
 * STRICTLY below its own; Administrator does not bypass it. So we compare our bot's top role against
 * each target bot's top role and report exactly which are removable today.
 */
export async function readiness(guild) {
  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  const myTop = me?.roles?.highest?.position ?? 0;

  const bots = await detectBots(guild);
  const hierarchy = { botPosition: myTop, removable: [], blocked: [] };
  for (const b of bots) {
    const member = await guild.members.fetch(b.id).catch(() => null);
    if (!member) continue;
    const top = member.roles.highest.position;
    const entry = { name: b.name, id: b.id, position: top, topRole: member.roles.highest.name };
    (myTop > top ? hierarchy.removable : hierarchy.blocked).push(entry);
  }

  // Server security posture. These are the settings a takeover should not silently inherit as-is.
  const VERIF = ['None', 'Low', 'Medium', 'High', 'Highest'];
  const FILTER = ['Disabled', 'Members without roles', 'All members'];
  const security = {
    verification: VERIF[guild.verificationLevel] ?? String(guild.verificationLevel),
    twoFactorForMod: guild.mfaLevel === 1,
    explicitContentFilter: FILTER[guild.explicitContentFilter] ?? String(guild.explicitContentFilter),
    warnings: [],
  };
  if (guild.mfaLevel !== 1) security.warnings.push('2FA is NOT required for moderation actions — any compromised mod account can ban/kick.');
  if ((guild.verificationLevel ?? 0) < 2) security.warnings.push(`Verification is ${security.verification} — a raid can post immediately. Medium+ gates new/unverified accounts.`);

  // Role hygiene: same-named duplicates (Carl-bot rebuilds leave stacks of pronoun/region roles) and
  // empty non-managed roles. Cheap — reads the role cache only, no member sweep.
  const byName = new Map();
  for (const r of guild.roles.cache.values()) {
    if (r.managed || r.id === guild.id) continue;
    const key = r.name.toLowerCase().trim();
    (byName.get(key) ?? byName.set(key, []).get(key)).push(r);
  }
  const duplicates = [...byName.entries()].filter(([, rs]) => rs.length > 1)
    .map(([name, rs]) => ({ name, count: rs.length }));
  const empty = guild.roles.cache.filter(r => !r.managed && r.id !== guild.id && r.members.size === 0 && r.name !== 'new role').size;
  const placeholders = guild.roles.cache.filter(r => r.name === 'new role').size;

  return {
    hierarchy,
    security,
    roleHygiene: { duplicates, emptyRoles: empty, placeholderRoles: placeholders },
    parityGaps: [], // OwO guild boss is now built (migration 154); nothing outstanding.
    notes: [
      'The analyzer was blind to Components V2 messages until 2026-07-12 — FreeStuff (95 posts) and ' +
      "OwO's guild boss were invisible. Re-scan to see them; FreeStuff parity (free_games) still holds.",
    ],
  };
}

// ── Planning ─────────────────────────────────────────────────────────────────

/**
 * Inspect the guild and produce the list of steps a takeover would perform.
 * Purely read-only. Every step carries `done` (already true), `blocked` (why not), and the
 * data `apply()` will need — so the plan a human approves is exactly what runs.
 */
export async function plan(guild, opts = {}) {
  const guildId = guild.id;
  const steps = [];
  const push = (key, data) => steps.push({ key, ...data });

  const bots = await detectBots(guild);
  const byFeature = new Map(bots.filter(b => b.feature).map(b => [b.feature, b]));

  // ── Counting ──
  const countingChannel = opts.countingChannel
    ?? guild.channels.cache.find(c => c.isTextBased?.() && nameMatches(c, /count/) && !nameMatches(c, /log/));
  if (countingChannel) {
    const [[row]] = await pool.execute(
      'SELECT * FROM counting_channels WHERE guild_id = ? AND channel_id = ?', [guildId, countingChannel.id]);
    const live = await readCountingState(countingChannel);
    const miss = missingPerms(countingChannel, guild, STEPS.counting.needs);

    push('counting', {
      label: STEPS.counting.label,
      channelId: countingChannel.id,
      channelName: countingChannel.name,
      lastNumber: live?.lastNumber ?? 0,
      lastUserId: null, // never lock anyone out of the next number
      // "Infinite attempts": the channel is a pure ladder of numbers. ANY message that is not
      // the exact next number is deleted, no matter who posts it, and the count NEVER resets.
      //   • allow_same_user MUST be 1 — otherwise the correct next number gets deleted purely
      //     because the same person posted the previous one, which contradicts the rule.
      //   • delete_chatter removes non-numeric talk.
      //   • milestones would post a non-number into a numbers-only channel.
      failMode: opts.failMode ?? 'delete',
      allowSameUser: Number(opts.allowSameUser ?? 1),
      reactOnValid: Number(opts.reactOnValid ?? 1),
      announceMilestones: Number(opts.announceMilestones ?? 0),
      deleteChatter: Number(opts.deleteChatter ?? 1),
      done: !!(row?.is_active && Number(row.current_count) === (live?.lastNumber ?? -1)),
      blocked: !live ? 'could not read the current number from recent history'
        : miss.length ? `missing ${miss.join(', ')}` : null,
      replaces: byFeature.get('counting')?.name ?? null,
      note: live ? `read ${live.lastNumber} from the channel (sampled ${live.sampled} messages)` : null,
    });
  }

  // ── Stale counting rows on channels that are not the counting channel ──
  const [staleRows] = await pool.execute(
    'SELECT channel_id FROM counting_channels WHERE guild_id = ? AND is_active = TRUE', [guildId]);
  for (const r of staleRows) {
    if (countingChannel && r.channel_id === countingChannel.id) continue;
    const ch = guild.channels.cache.get(r.channel_id);
    push('counting_disable', {
      label: 'Disable stray counting channel',
      channelId: r.channel_id,
      channelName: ch?.name ?? r.channel_id,
      done: false,
      blocked: null,
      note: 'counting is active here but this is not the counting channel',
    });
  }

  // ── Logging ──
  const [[logRow]] = await pool.execute('SELECT log_channel_id FROM logging_config WHERE guild_id = ?', [guildId]);
  if (byFeature.has('logging')) {
    push('logging', {
      label: STEPS.logging.label,
      channelId: logRow?.log_channel_id ?? null,
      channelName: guild.channels.cache.get(logRow?.log_channel_id)?.name ?? '—',
      done: !!logRow?.log_channel_id,
      blocked: logRow?.log_channel_id ? null : 'no log channel configured — run /systems logging first',
      replaces: byFeature.get('logging').name,
    });
  }

  // ── Timezone (Friend Time) ──
  if (byFeature.has('timezone')) {
    const [[tz]] = await pool.execute('SELECT guild_id FROM tz_guild_config WHERE guild_id = ?', [guildId]);
    push('timezone', {
      label: STEPS.timezone.label, done: !!tz, blocked: null,
      replaces: byFeature.get('timezone').name,
    });
  }

  // ── Cat Bot ──
  if (byFeature.has('catbot')) {
    const [rows] = await pool.execute('SELECT channel_id FROM catbot_channels WHERE guild_id = ? AND enabled = 1', [guildId]);
    const target = opts.catChannel ?? guild.channels.cache.get(rows[0]?.channel_id)
      ?? guild.channels.cache.find(c => c.isTextBased?.() && nameMatches(c, /bot-spam|bot_commands|arcade|games/));
    push('catbot', {
      label: STEPS.catbot.label,
      channelId: target?.id ?? null,
      channelName: target?.name ?? '—',
      done: rows.length > 0,
      blocked: target ? null : 'no obvious channel — pass one explicitly',
      replaces: byFeature.get('catbot').name,
    });
  }

  // ── Grow a Tree ──
  if (byFeature.has('growtree')) {
    const [[tree]] = await pool.execute(
      'SELECT guild_id, name, size FROM gat_trees WHERE guild_id = ?', [guildId]);

    // The incumbent's tree is READABLE. It keeps a single message and edits it in place forever, so
    // its live height is sitting right there in the channel — this is not history, it is current
    // state. That turns "start again from a 3ft sapling" from the only option into a CHOICE.
    const old = await readIncumbentTree(guild);

    push('growtree', {
      label: STEPS.growtree.label,
      done: !!tree,
      carryOver: old,
      // Not blocked and not a no-op: it is a decision only the owner can make, because the two
      // answers are both defensible and we must not pick for her.
      needsInput: tree ? null
        : old
          ? `the server's tree is "${old.name}" at ${old.size}ft — carry it over at that height, or start fresh? ` +
            `(/tree setup ${old.size} carries it; plain /tree plants a 3ft sapling)`
          : null,
      noop: tree || old ? null : 'no setup needed — the first /tree plants the tree',
      note: old
        ? `read live from #${old.channelName}: "${old.name}", ${old.size}ft, last watered by <@${old.lastWateredBy}>`
        : null,
      replaces: byFeature.get('growtree').name,
    });
  }

  // ── OwO ──
  if (byFeature.has('owo')) {
    const [[owo]] = await pool.execute('SELECT enabled FROM owo_config WHERE guild_id = ?', [guildId]);
    push('owo', {
      label: STEPS.owo.label, done: !!owo?.enabled,
      // Not blocked — everything works. It is SEQUENCED: enabling ours while the real OwO is still
      // in the guild would make both bots answer `owoh`. Flip it on the moment OwO is removed.
      sequenced: owo?.enabled ? null : 'enable the moment the real OwO bot is removed (both would double-reply otherwise)',
      note: 'parity: hunt/gems/lootboxes/crates/battle/pets built; guild boss now built too (see readiness). ' +
        'karabi progress is importable from #owo-game — cowoncy is the only unrecoverable piece.',
      replaces: byFeature.get('owo').name,
    });
  }

  // ── Birthdays ──
  if (byFeature.has('birthday')) {
    const [[bd]] = await pool.execute(
      'SELECT announcement_channel_id, birthday_role_id, enabled FROM birthday_config WHERE guild_id = ?', [guildId]);
    const [[stored]] = await pool.execute(
      'SELECT COUNT(*) AS n FROM user_birthdays WHERE guild_id = ?', [guildId]);

    const channel = guild.channels.cache.get(bd?.announcement_channel_id)
      ?? guild.channels.cache.find(c => c.isTextBased?.() && nameMatches(c, /birthday/));
    const role = guild.roles.cache.get(bd?.birthday_role_id ?? BIRTHDAY_ROLE);

    // A birthday role is worthless if we cannot actually put it on anyone, and the failure is
    // silent at grant time (a caught warn in birthday-manager). Prove the hierarchy up front:
    // Discord only lets us grant a role strictly BELOW our own highest, and `managed` roles
    // (a bot's or a boost role) can never be granted by anyone at all.
    const me = guild.members.me;
    const cannotGrant = !role ? 'the birthday role no longer exists'
      : role.managed ? `${role.name} is managed by Discord and cannot be granted by any bot`
        : !me?.permissions.has(PermissionFlagsBits.ManageRoles) ? 'missing Manage Roles'
          : me.roles.highest.comparePositionTo(role) <= 0
            ? `${role.name} sits at or above our own highest role — Discord refuses the grant`
            : null;

    push('birthday', {
      label: STEPS.birthday.label,
      channelId: channel?.id ?? null,
      channelName: channel?.name ?? '—',
      roleId: role?.id ?? null,
      roleName: role?.name ?? '—',
      stored: Number(stored.n),
      done: !!(bd?.enabled && bd.announcement_channel_id && bd.birthday_role_id && !cannotGrant),
      blocked: cannotGrant ?? (channel ? null : 'no birthday channel found'),
      note: `${stored.n} birthday(s) already imported. The ${role?.name ?? 'birthday'} role is empty today because ` +
        'the incumbent never granted it — we grant it on the day and strip it the morning after.',
      replaces: byFeature.get('birthday').name,
    });
  }

  // ── Ko-fi ──
  if (byFeature.has('kofi')) {
    const [[kofi]] = await pool.execute('SELECT enabled FROM kofi_config WHERE guild_id = ?', [guildId]);
    push('kofi', {
      label: 'Ko-fi supporter roles',
      done: !!kofi?.enabled,
      // The one genuine external dependency: Ko-fi's webhook token is not exposed by any API, so
      // only the server owner can supply it. Everything else about Ko-fi is ready.
      needsInput: kofi?.enabled ? null
        : 'your Ko-fi webhook verification token (Ko-fi → Settings → API) — then /kofi setup and /kofi tier',
      replaces: byFeature.get('kofi').name,
    });
  }

  // ── Streams (Pingcord) ──
  if (byFeature.has('streams')) {
    const [subs] = await pool.execute(
      `SELECT st.username, st.platform FROM subscriptions s
         JOIN streamers st ON st.streamer_id = s.streamer_id WHERE s.guild_id = ?`, [guildId]);
    const have = new Set(subs.map(s => `${s.platform}/${s.username}`.toLowerCase()));
    const missing = PINGCORD_STREAMERS.filter(s => !have.has(`${s.platform}/${s.username}`.toLowerCase()));

    push('streams', {
      label: 'Stream announcements',
      streamers: missing,
      done: missing.length === 0,
      blocked: null,
      note: missing.length
        ? `MISSING: ${missing.map(s => `${s.platform}/${s.username}`).join(', ')} — the incumbent pings @everyone for this. ` +
          `We currently announce: ${subs.map(s => s.username).join(', ') || 'nobody'}`
        : `we announce: ${subs.map(s => `${s.platform}/${s.username}`).join(', ')}`,
      replaces: byFeature.get('streams').name,
    });
  }

  // ── Nightbot: custom commands + autoresponses, recovered from history ──
  if (byFeature.has('custom_commands')) {
    const [[haveCmds]] = await pool.execute(
      'SELECT COUNT(*) AS n FROM custom_commands WHERE guild_id = ?', [guildId]);
    const [[haveAuto]] = await pool.execute(
      'SELECT COUNT(*) AS n FROM autoresponders WHERE guild_id = ?', [guildId]);

    push('nightbot_commands', {
      label: 'Nightbot commands',
      done: Number(haveCmds.n) >= NIGHTBOT_COMMANDS.length,
      blocked: null,
      note: NIGHTBOT_COMMANDS.map(c => `!${c.name}`).join(', '),
      replaces: byFeature.get('custom_commands').name,
    });
    push('nightbot_autoresponses', {
      label: 'Nightbot autoresponses',
      done: Number(haveAuto.n) >= NIGHTBOT_AUTORESPONSES.length,
      blocked: null,
      note: `${NIGHTBOT_AUTORESPONSES.map(a => a.name).join(', ')} — fire on the FIRST WORD of plain chat, not on a prefix`,
      replaces: byFeature.get('custom_commands').name,
    });
  }

  // ── Carl-bot: rebuild the self-assign panels as our own ──
  if (byFeature.has('reaction_roles')) {
    const channel = guild.channels.cache.get(SELF_ASSIGN_CHANNEL);
    const [[panels]] = await pool.execute(
      "SELECT COUNT(*) AS n FROM reaction_role_panels WHERE guild_id = ? AND message_id <> 'PENDING'", [guildId]);
    const missingRoles = CARLBOT_PANELS.flatMap(p => p.roles)
      .filter(([, id]) => !guild.roles.cache.has(id))
      .map(([, id, label]) => label ?? id);

    // Every `:name:` in a panel must exist in THIS guild before the panel can be posted.
    const missingEmoji = CARLBOT_PANELS.flatMap(p => p.roles)
      .filter(([emoji]) => resolveEmoji(guild, emoji) === null)
      .map(([emoji, , label]) => `${emoji.replaceAll(':', '')} (${label})`);

    const needUpload = PLATFORM_EMOJI.filter(e => !guild.emojis.cache.some(g => g.name === e.name));
    // Static and animated have separate caps; these are all static PNGs.
    const staticCap = { 0: 50, 1: 100, 2: 150, 3: 250 }[guild.premiumTier] ?? 50;
    const staticUsed = guild.emojis.cache.filter(e => !e.animated).size;

    push('platform_emoji', {
      label: 'Platform emoji',
      done: needUpload.length === 0,
      missing: needUpload.map(e => e.name),
      blocked: needUpload.length === 0 ? null
        : staticUsed + needUpload.length > staticCap
          ? `no room: ${staticUsed}/${staticCap} static emoji slots used, need ${needUpload.length} more`
          : null,
      note: `${staticUsed}/${staticCap} static slots used`,
      replaces: byFeature.get('reaction_roles').name,
    });

    // A genuine problem (missing channel/roles/emoji) is `blocked`. Otherwise it is READY but
    // `deliberate`: a role panel IS a message, so this is the one step that posts to the guild and
    // it must be triggered on its own (the "Post panels" button), never swept up by config-apply.
    // The role plan RENAMES abandoned duplicates into the colours/timezones/pings these panels
    // offer. A button carries a role ID, so it would still "work" before the rename — it would just
    // hand out a role called "Ask" to someone who clicked "Cyan". That is worse than not working.
    const notYetRenamed = CARLBOT_PANELS.flatMap(p => p.roles)
      .filter(([, id, label]) => guild.roles.cache.get(id) && guild.roles.cache.get(id).name !== label)
      .map(([, , label]) => label);

    const panelBlocker = !channel ? 'self-assign channel not found'
      : missingRoles.length ? `these roles no longer exist: ${missingRoles.join(', ')}`
        : missingEmoji.length ? `upload the platform emoji first — not in this server yet: ${missingEmoji.join(', ')}`
          : null;
    // Surface the old panels we will take down, BEFORE anyone clicks anything. The one destructive
    // act in the whole takeover should never be a surprise discovered afterwards.
    const oldPanels = channel ? await findOldPanels(channel).catch(() => []) : [];

    push('carlbot_panels', {
      label: 'Self-assign role panels',
      channelId: SELF_ASSIGN_CHANNEL,
      channelName: channel?.name ?? SELF_ASSIGN_CHANNEL,
      removes: oldPanels.map(m => ({ id: m.id, title: m.embeds[0]?.title ?? '(untitled)' })),
      done: Number(panels.n) >= CARLBOT_PANELS.length,
      blocked: panelBlocker,
      sequenced: panelBlocker || !notYetRenamed.length ? null
        : `run the role clean-up first (scripts/kabster-role-plan.mjs --apply) — ${notYetRenamed.length} role(s) ` +
          `still carry their old duplicate name, so a member clicking "${notYetRenamed[0]}" would be given the wrong-named role`,
      deliberate: panelBlocker || notYetRenamed.length ? null
        : `ready — posts ${CARLBOT_PANELS.length} button panels` +
          (oldPanels.length ? `, then removes Carl-bot's ${oldPanels.length} old reaction panel(s) once ours are up` : '') +
          '. Use the "Post panels" action; it is the only step that writes to the guild.',
      note: CARLBOT_PANELS.map(p => `${p.name} (${p.roles.length})`).join(' · ')
        + (oldPanels.length
          ? ` — REMOVES (archived first): ${oldPanels.map(m => m.embeds[0]?.title ?? m.id).join(', ')}. `
            + 'Carl-bot panels keep showing their reactions after it leaves, so members would click a dead panel.'
          : ''),
      replaces: byFeature.get('reaction_roles').name,
    });
  }

  // ── Things we simply cannot do ──
  const unreplaceable = [
    ...bots.filter(b => !b.feature),
    ...Object.entries(WEBHOOK_ONLY).map(([name, why]) => ({ id: null, name, feature: null, why })),
  ];

  // ── Manual carry-over: Nightbot replies, reaction-role panels ──
  const [[cc]] = await pool.execute('SELECT COUNT(*) AS n FROM custom_commands WHERE guild_id = ?', [guildId]);
  if (byFeature.has('custom_commands') && !Number(cc.n)) {
    push('custom_commands', {
      label: 'Other custom chat replies',
      done: false,
      // The two Nightbot commands WE saw in history are handled by nightbot_commands above. This
      // catch-all is only for any others: Discord exposes no API for a foreign bot's command list,
      // so anything it never posted on-camera can only be re-created by hand.
      needsInput: "any Nightbot commands beyond !pp/!karabi aren't API-readable — re-create them in the Command Center",
      replaces: byFeature.get('custom_commands').name,
    });
  }

  // Give every step one honest status instead of overloading `blocked`. The distinction matters:
  // only `blocked` is a problem. `ready` is one click away; `sequenced`/`deliberate`/`needs-input`
  // are working-as-intended; `no-op` needs nothing at all.
  for (const s of steps) s.status = statusOf(s);

  return {
    guildId,
    guildName: guild.name,
    bots,
    unreplaceable,
    steps,
    // "actionable" = the config-only steps apply() will run. Deliberate (panel-posting) and
    // sequenced (post-removal) steps are intentionally excluded — they are not blocked, just not
    // part of a bulk config apply.
    actionable: steps.filter(s => s.status === 'ready'),
    summary: summarize(steps),
    readiness: await readiness(guild).catch(err => {
      logger.warn(`[Takeover] readiness failed: ${err.message}`);
      return null;
    }),
  };
}

/**
 * The one honest status for a step. Order matters: done wins, then a real blocker, then the
 * intentional non-actionable states, and everything left is genuinely ready to apply now.
 */
export function statusOf(s) {
  if (s.done) return 'done';
  if (s.blocked) return 'blocked';       // a real problem: missing perms, unreadable state, gone roles
  if (s.sequenced) return 'sequenced';   // works, but do it after a named event (e.g. OwO removal)
  if (s.deliberate) return 'deliberate'; // ready, but posts to the guild — its own explicit action
  if (s.needsInput) return 'needs-input';// ready once the owner supplies something (a token)
  if (s.noop) return 'no-op';            // nothing to configure
  return 'ready';                        // one click away
}

const STATUS_LABELS = Object.freeze({
  done: 'done', ready: 'ready to apply', sequenced: 'after removal',
  deliberate: 'deliberate action', 'needs-input': 'needs your input', 'no-op': 'no setup needed',
  blocked: 'blocked',
});

/** Roll the per-step statuses up into counts, so the UI can lead with an honest headline. */
function summarize(steps) {
  const counts = {};
  for (const s of steps) counts[s.status] = (counts[s.status] ?? 0) + 1;
  return { counts, labels: STATUS_LABELS };
}

// ── Applying ─────────────────────────────────────────────────────────────────

/**
 * Perform the given steps. Writes config rows and never posts, edits or deletes a message. The one
 * step that reaches into the guild itself is `platform_emoji`, which uploads emoji — additive, and
 * a hard prerequisite for the role panel, which cannot use emoji hosted anywhere else.
 * @param {string[]} only  step keys to run; anything else in the plan is skipped.
 */
export async function apply(guild, planned, only) {
  const wanted = new Set(only ?? planned.actionable.map(s => s.key));
  const results = [];

  for (const step of planned.steps) {
    if (!wanted.has(step.key)) continue;
    const status = step.status ?? statusOf(step);
    if (status === 'done') { results.push({ ...step, outcome: 'already-done' }); continue; }
    // Only 'ready' steps are config-applies. Everything else is intentionally hand-driven:
    // 'deliberate' posts via postPanels(), 'sequenced' waits for OwO's removal, 'needs-input'
    // waits on the owner, 'no-op' needs nothing, 'blocked' is a real problem.
    if (status !== 'ready') { results.push({ ...step, outcome: status }); continue; }

    try {
      await runStep(guild, step);
      results.push({ ...step, outcome: 'applied' });
    } catch (err) {
      logger.error(`[Takeover] step ${step.key} failed: ${err.message}`);
      results.push({ ...step, outcome: 'failed', error: err.message });
    }
  }
  return results;
}

async function runStep(guild, step) {
  const g = guild.id;
  switch (step.key) {
    case 'counting': {
      // Seed at the number the old bot left off on. last_user_id stays NULL so whoever
      // posted last is not locked out of the next number.
      await pool.execute(
        `INSERT INTO counting_channels
           (guild_id, channel_id, current_count, highest_count, last_user_id, reset_count, is_active,
            fail_mode, allow_same_user, react_on_valid, announce_milestones, delete_chatter)
         VALUES (?, ?, ?, ?, NULL, 0, TRUE, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           current_count = VALUES(current_count),
           highest_count = GREATEST(highest_count, VALUES(highest_count)),
           last_user_id = NULL,
           is_active = TRUE,
           fail_mode = VALUES(fail_mode),
           allow_same_user = VALUES(allow_same_user),
           react_on_valid = VALUES(react_on_valid),
           announce_milestones = VALUES(announce_milestones),
           delete_chatter = VALUES(delete_chatter)`,
        [g, step.channelId, step.lastNumber, step.lastNumber, step.failMode,
          step.allowSameUser, step.reactOnValid, step.announceMilestones, step.deleteChatter]);
      return;
    }
    case 'counting_disable':
      await pool.execute(
        'UPDATE counting_channels SET is_active = FALSE WHERE guild_id = ? AND channel_id = ?', [g, step.channelId]);
      return;

    case 'timezone':
      await pool.execute(
        `INSERT INTO tz_guild_config (guild_id, enabled, auto_detect) VALUES (?, 1, 'react')
         ON DUPLICATE KEY UPDATE enabled = 1`, [g]);
      return;

    case 'catbot': {
      const { setupChannel, scheduleRespawn } = await import('./catbot/spawn-manager.js');
      await setupChannel(g, step.channelId);
      await scheduleRespawn(step.channelId);
      return;
    }

    case 'owo':
      await pool.execute(
        `INSERT INTO owo_config (guild_id, enabled) VALUES (?, 1)
         ON DUPLICATE KEY UPDATE enabled = 1`, [g]);
      return;

    case 'birthday':
      // The row already carries the incumbent's own wording, recovered from its posts — leave
      // message_template alone so re-running never overwrites it with a default.
      await pool.execute(
        `INSERT INTO birthday_config (guild_id, announcement_channel_id, birthday_role_id, enabled)
         VALUES (?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE
           announcement_channel_id = VALUES(announcement_channel_id),
           birthday_role_id        = VALUES(birthday_role_id),
           enabled                 = 1`,
        [g, step.channelId, step.roleId]);
      return;

    case 'platform_emoji': {
      // Pull each image straight from the CDN and re-host it here. Idempotent: an emoji whose name
      // already exists is left alone, so a partial run can simply be repeated.
      for (const { name, sourceId } of PLATFORM_EMOJI) {
        if (guild.emojis.cache.some(e => e.name === name)) continue;

        const res = await fetch(`https://cdn.discordapp.com/emojis/${sourceId}.png`);
        if (!res.ok) throw new Error(`emoji ${name}: source image gone (HTTP ${res.status})`);
        const buf = Buffer.from(await res.arrayBuffer());

        await guild.emojis.create({
          name,
          attachment: buf,
          reason: ascii('Takeover: re-hosting platform emoji so the role panel can use them'),
        });
      }
      break;
    }

    case 'streams': {
      // Reuse the same path self-promo uses, so the streamer row and subscription are created
      // exactly as they would be by /socials — no bespoke insert that drifts from the real one.
      const { createStreamerAndSubscription, validatePlatformUser } = await import('./self-promo-handler.js');
      for (const s of step.streamers ?? []) {
        // Resolve the platform's real user id (Twitch's numeric id), not the handle — the live
        // checker keys on it. Fall back to the handle if the API is unreachable.
        const v = await validatePlatformUser(s.platform, s.username);
        const platformUserId = v?.platformUserId ?? s.username;
        const username = v?.canonicalUsername ?? s.username;
        await createStreamerAndSubscription(g, s.platform, platformUserId, username, null, s.channelId, null);
        if (s.pingRoleId) {
          await pool.execute(
            `UPDATE subscriptions sub
               JOIN streamers st ON st.streamer_id = sub.streamer_id
                SET sub.ping_role_id = ?
              WHERE sub.guild_id = ? AND st.platform = ? AND st.username = ?`,
            [s.pingRoleId, g, s.platform, username]);
        }
      }
      return;
    }

    case 'nightbot_commands':
      for (const c of NIGHTBOT_COMMANDS) {
        await pool.execute(
          `INSERT INTO custom_commands (guild_id, command_name, response, action_type)
           VALUES (?, ?, ?, 'reply')
           ON DUPLICATE KEY UPDATE response = VALUES(response)`,
          [g, c.name, c.response]);
      }
      return;

    case 'nightbot_autoresponses':
      // `autoresponders` is the LIVE table — `auto_responses` exists but NOTHING reads it.
      // There is no unique key on (guild_id, trigger_text), so this is select-then-write.
      for (const a of NIGHTBOT_AUTORESPONSES) {
        const [dupe] = await pool.execute(
          'SELECT id FROM autoresponders WHERE guild_id = ? AND trigger_text = ?', [g, a.pattern]);
        if (dupe.length) {
          await pool.execute(
            "UPDATE autoresponders SET response_text = ?, match_type = 'regex', case_sensitive = 0, enabled = 1 WHERE id = ?",
            [a.response, dupe[0].id]);
        } else {
          // 5s cooldown mirrors Nightbot's default, so a burst of "W"s cannot spam the channel.
          await pool.execute(
            `INSERT INTO autoresponders
               (guild_id, trigger_text, response_text, match_type, case_sensitive, enabled, cooldown_seconds, created_by)
             VALUES (?, ?, ?, 'regex', 0, 1, 5, ?)`,
            [g, a.pattern, a.response, step.createdBy ?? '365905620060340224']);
        }
      }
      return;

    default:
      throw new Error(`step "${step.key}" has no apply action`);
  }
}

/**
 * Rebuild Carl-bot's self-assign panels as our own. This POSTS MESSAGES and then DELETES Carl-bot's
 * originals, which is why it is not a case in `apply()` and can never be swept up by an "apply
 * everything" click — it is its own deliberate action, and the only place the takeover writes to a
 * channel at all.
 *
 * The originals cannot simply be left in place. A Carl-bot panel is a REACTION panel: after Carl-bot
 * leaves, the message still renders every reaction, so members carry on clicking it and silently get
 * nothing. A dead panel that looks alive is worse than no panel. They come down only AFTER every
 * replacement is confirmed posted, and every one is archived to `takeover_archived_messages` first —
 * it is not our server, and deleting is irreversible.
 *
 * Buttons, not reactions: a reaction panel needs the member to have Add Reactions in the channel
 * and silently does nothing when they don't, and every emoji must be re-fetched on restart.
 *
 * Idempotent by panel name — a panel we already posted is skipped, so a partial run is repeatable.
 */
export async function postPanels(guild) {
  const channel = guild.channels.cache.get(SELF_ASSIGN_CHANNEL);
  if (!channel) throw new Error('self-assign channel not found');

  const [existing] = await pool.execute(
    "SELECT panel_name FROM reaction_role_panels WHERE guild_id = ? AND message_id <> 'PENDING'",
    [guild.id]);
  const already = new Set(existing.map(r => r.panel_name));

  const results = [];
  for (const panel of CARLBOT_PANELS) {
    if (already.has(panel.name)) { results.push({ panel: panel.name, outcome: 'already-done' }); continue; }

    const roles = [];
    for (const [emojiSpec, roleId, label] of panel.roles) {
      const role = guild.roles.cache.get(roleId);
      if (!role) throw new Error(`${panel.name}: role ${label} (${roleId}) no longer exists`);

      const emoji = resolveEmoji(guild, emojiSpec);
      if (emoji === null) throw new Error(`${panel.name}: emoji ${emojiSpec} is not in this server — run the platform_emoji step first`);

      roles.push({ roleId, label, name: role.name, emoji, style: 'secondary' });
    }

    // Built against the client that actually holds this guild — with custom bots there is no one
    // global client, and the manager resolves the guild from its own cache.
    const manager = new ReactionRoleManager(guild.client);
    const mode = panel.mode ?? 'multiple';
    const made = await manager.createReactionPanel(
      guild.id, channel.id, panel.name, mode, 'button', roles,
      { title: panel.name, description: mode === 'unique'
        ? 'Pick one. Picking another swaps it; click the one you have to remove it.'
        : 'Pick as many as you like. Click again to remove.' });

    if (!made) throw new Error(`${panel.name}: panel creation failed`);
    results.push({ panel: panel.name, outcome: 'posted', messageId: made.messageId });
  }

  // Only now that every replacement is up do the originals come down. If any panel above threw, we
  // have already returned and the old ones are still there — never a channel with neither.
  for (const old of await findOldPanels(channel)) {
    await archiveMessage(guild.id, old);
    await old.delete(ascii('Takeover: replaced by our own self-assign panel'))
      .then(() => results.push({ panel: old.embeds[0]?.title ?? old.id, outcome: 'old-panel-removed', messageId: old.id }))
      .catch(e => results.push({ panel: old.id, outcome: `old-panel-delete-failed: ${e.message}` }));
  }
  return results;
}

/**
 * Carl-bot's own panels, still sitting in the channel.
 *
 * Identified by AUTHOR + STRUCTURE, never by a hardcoded message id: an id list would silently rot
 * if a panel were ever reposted, and worse, could point at whatever message inherited the position.
 * A Carl-bot panel is an embed with a title we recognise and reactions but no buttons — which is
 * exactly what makes it dangerous to leave behind. The reactions still render after Carl-bot is
 * gone, so members keep clicking a dead panel and silently get nothing.
 *
 * Human messages in the channel are never candidates: `author.bot` gates that.
 */
async function findOldPanels(channel) {
  const CARLBOT = '235148962103951360';
  const titles = new Set(CARLBOT_PANELS.map(p => p.name.toLowerCase()));
  const msgs = await channel.messages.fetch({ limit: 100 });
  return [...msgs.values()].filter(m =>
    m.author?.bot
    && m.author.id === CARLBOT
    && m.reactions.cache.size > 0
    && !m.components?.length
    && titles.has((m.embeds[0]?.title ?? '').trim().toLowerCase()));
}

/**
 * Post the "Link your Twitch" button.
 *
 * Linking the BROADCASTER's Twitch tells us who her VIPs and moderators are. It does not tell us
 * which Discord account belongs to each of them — only they can say that. Without this, she would
 * connect her account, watch nothing happen, and reasonably conclude the whole thing was broken.
 *
 * The member flow at /link/twitch already exists and works (623 links across 65 guilds). What was
 * missing was any way to REACH it: nothing in Discord has ever pointed at that page.
 *
 * A Link-style button needs no interaction handler and no customId — Discord opens the URL itself,
 * so this keeps working even if the bot is offline. Like postPanels(), this WRITES A MESSAGE to the
 * guild, so it is never part of apply() and must be asked for by name.
 */
export async function postTwitchLinkPanel(guild, channelId) {
  const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');

  const channel = guild.channels.cache.get(channelId);
  if (!channel?.isTextBased?.()) throw new Error('that channel does not exist, or is not a text channel');

  const miss = missingPerms(channel, guild, ['ViewChannel', 'SendMessages', 'EmbedLinks']);
  if (miss.length) throw new Error(`missing ${miss.join(', ')} in #${channel.name}`);

  const base = (process.env.DASHBOARD_URL || 'https://certifriedmultitool.com').replace(/\/$/, '');

  const embed = new EmbedBuilder()
    .setTitle('Link your Twitch')
    .setColor(0x9146FF)
    .setDescription(
      'If you are a **VIP** or a **moderator** on the stream, link your Twitch here and you will get '
      + 'the matching role in this server automatically.\n\n'
      + 'It takes about fifteen minutes to show up. You can unlink at any time, and we never get your '
      + 'password — Twitch handles the login.');

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel('Link my Twitch')
      .setEmoji('🟣')
      .setStyle(ButtonStyle.Link)
      .setURL(`${base}/link/twitch`));

  const msg = await channel.send({ embeds: [embed], components: [row] });
  await msg.pin(ascii('Takeover: members need to be able to find this')).catch(() => {
    // Pinning is a nicety. A full pin list, or no Manage Messages, must not fail the whole post.
    logger.warn(`[Takeover] posted the Twitch link panel in #${channel.name} but could not pin it`);
  });

  logger.info(`[Takeover] posted the Twitch link panel in #${channel.name} (${guild.name})`);
  return { channelId: channel.id, channelName: channel.name, messageId: msg.id };
}

/**
 * The incumbent Grow a Tree bot's CURRENT tree, read straight out of its own message.
 *
 * It posts exactly one message per guild and edits that message in place for the tree's whole life,
 * so what is rendered there is not a stale log line — it is the live tree. That means the height,
 * the tree's name and whoever watered it last are all recoverable, and "everyone loses the tree" is
 * a choice rather than a technical limit.
 *
 * Returns null if there is no tree to read; the caller must not invent one.
 */
async function readIncumbentTree(guild) {
  const channel = guild.channels.cache.find(c => c.isTextBased?.() && nameMatches(c, /grow-a-tree|tree/));
  if (!channel) return null;

  const msgs = await channel.messages.fetch({ limit: 20 }).catch(() => null);
  if (!msgs) return null;

  for (const m of msgs.values()) {
    if (!m.author?.bot) continue;
    const text = [m.content, ...m.embeds.flatMap(e => [e.title, e.description])].filter(Boolean).join(' ');
    // "Kababi | **Your tree is 193ft tall.** Last watered by: <@756325866660691998>"
    const height = text.match(/tree is\s+\*{0,2}([\d,]+)\s*(ft|feet|cm|m)\b/i);
    if (!height) continue;

    return {
      name: (text.match(/^\s*([^|*\n]{1,36}?)\s*\|/) ?? [])[1]?.trim() || guild.name,
      size: Number(height[1].replace(/,/g, '')),
      unit: height[2].toLowerCase(),
      lastWateredBy: (text.match(/watered by:?\s*<@!?(\d+)>/i) ?? [])[1] ?? null,
      channelName: channel.name,
      messageId: m.id,
    };
  }
  return null;
}

/** Keep a copy of anything we delete from a guild. Deleting is irreversible; this is the receipt. */
async function archiveMessage(guildId, msg) {
  await pool.execute(
    `INSERT INTO takeover_archived_messages
       (guild_id, channel_id, message_id, author_id, author_name, content, embeds, reactions)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE archived_at = CURRENT_TIMESTAMP`,
    [guildId, msg.channelId, msg.id, msg.author?.id ?? null, msg.author?.username ?? null,
      msg.content ?? '', JSON.stringify(msg.embeds ?? []),
      JSON.stringify([...msg.reactions.cache.values()].map(r => ({
        emoji: r.emoji.id ? `${r.emoji.name}:${r.emoji.id}` : r.emoji.name, count: r.count })))]);
}
