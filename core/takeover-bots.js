/*
 * The incumbent-bot registry — who we recognise, what they do, and what we offer instead.
 *
 * WHY THIS IS A CATALOG AND NOT A MAP OF IDS
 *
 * The first version of this was `{ '<snowflake>': { name, feature } }`, hand-typed from one
 * server's scan. It worked perfectly on that server and recognised almost nothing anywhere else:
 * the second server it met had Streamcord, YAGPDB, Arcane and Dank Memer, four of the most common
 * bots on Discord, and reported all four as "unrecognised — needs a look". A takeover page that
 * cannot name the bots it is looking at is not an audit, it is a list of strangers.
 *
 * So each entry carries every handle a bot can show up under:
 *   • `ids`     — its application id(s). Exact, when we have it.
 *   • `aliases` — anchored name patterns, for the two cases an id never covers: a bot that posts
 *                 through a WEBHOOK (the author id is the webhook's, not the bot's), and a bot
 *                 whose id we simply do not know. Anchored, never a substring sweep, so a member
 *                 nicknamed "carl" is not mistaken for Carl-bot.
 *
 * And `features` is a LIST. Most of the big bots do six things at once; describing YAGPDB as "the
 * autorole bot" and planning around that loses its logging, its reaction roles and its welcome
 * message the moment somebody retires it.
 *
 * COVERAGE IS AN HONEST VERDICT, NOT A SALES PITCH
 *   'full'    — we reproduce what it does. Retiring it loses the server nothing.
 *   'partial' — we reproduce the core but not all of it. `why` says exactly what does not survive.
 *   'none'    — genuinely nothing to replace. KEEP it. This is a decision, not a failure.
 *
 * Adding a bot here is the only step needed to teach the audit about it. Nothing else in the
 * takeover engine knows any bot's name.
 */

/**
 * What we actually have, keyed by the feature name the catalog uses.
 *
 * `kind` decides how a step reads in the plan and is the difference between an honest audit and a
 * checklist of lies:
 *   'config'   — we write a config row for it. The plan can apply it.
 *   'standing' — a command that exists on the bot from startup. Nothing to set up; parity is real
 *                the moment the incumbent is gone.
 *   'manual'   — real, but a human has to make a decision we must not make for them (which channel,
 *                which role, what the welcome message says).
 */
export const FEATURES = Object.freeze({
  counting:        { label: 'Counting',              replacement: '/arcade counting',        kind: 'config' },
  streams:         { label: 'Stream announcements',   replacement: '/socials',                kind: 'config' },
  logging:         { label: 'Server logging',         replacement: '/systems logging',        kind: 'config' },
  reaction_roles:  { label: 'Self-assign roles',      replacement: '/manage roles',           kind: 'manual' },
  timezone:        { label: 'Timezones',              replacement: '/timezone',               kind: 'config' },
  catbot:          { label: 'Cat Bot',                replacement: '/cat',                    kind: 'config' },
  growtree:        { label: 'Grow a Tree',            replacement: '/arcade tree',                   kind: 'config' },
  owo:             { label: 'OwO',                    replacement: '/owo (and the owo prefix)', kind: 'config' },
  cannabis:        { label: 'Cannabis commands',      replacement: '/puff /pass /cheers …',   kind: 'standing' },
  emoji:           { label: 'Emoji tools',            replacement: '/emoji steal|add|remove|list', kind: 'standing' },
  custom_commands: { label: 'Custom chat replies',    replacement: 'the Command Center',      kind: 'manual' },
  throne:          { label: 'Throne wishlist',        replacement: '/creator throne',                 kind: 'config' },
  free_games:      { label: 'Free games feed',        replacement: '/alerts freegames',       kind: 'config' },
  birthday:        { label: 'Birthdays',              replacement: '/engage birthday',        kind: 'config' },
  lastfm:          { label: 'Last.fm',                replacement: '/music lastfm',           kind: 'standing' },
  moderation:      { label: 'Moderation & protection', replacement: '/protection, /admin mod', kind: 'config' },
  kofi:            { label: 'Ko-fi supporter roles',  replacement: '/creator kofi',                   kind: 'config' },
  soundboard:      { label: 'Soundboard',             replacement: '/soundboard',             kind: 'manual' },

  // Everything below here is what the first audit could not see. These are the features the most
  // common bots on Discord actually get hired for.
  leveling:        { label: 'Levels & ranks',         replacement: '/level, /rankcard',       kind: 'config' },
  welcome:         { label: 'Welcome messages',       replacement: '/manage welcome',         kind: 'manual' },
  autorole:        { label: 'Auto-role on join',      replacement: '/manage roles autorole',  kind: 'manual' },
  tickets:         { label: 'Support tickets',        replacement: '/support panel',          kind: 'manual' },
  starboard:       { label: 'Starboard',              replacement: '/systems starboard',      kind: 'manual' },
  suggestions:     { label: 'Suggestions',            replacement: '/engage suggest',         kind: 'manual' },
  giveaways:       { label: 'Giveaways',              replacement: '/manage giveaway',        kind: 'standing' },
  polls:           { label: 'Polls',                  replacement: '/manage poll',            kind: 'standing' },
  music:           { label: 'Music',                  replacement: '/music',                  kind: 'standing' },
  economy:         { label: 'Economy & games',        replacement: '/economy, /fish, /rpg',   kind: 'standing' },
  qotd:            { label: 'Question of the day',    replacement: '/qotd',                   kind: 'config' },
  events:          { label: 'Events & schedules',     replacement: '/schedule',               kind: 'manual' },
  forms:           { label: 'Applications & forms',   replacement: '/support forms',          kind: 'manual' },
  temp_voice:      { label: 'Temporary voice rooms',  replacement: '/voice',                  kind: 'manual' },
});

/** The single source of truth. Order is irrelevant; lookup is by index built below. */
const CATALOG = [
  // ── The all-rounders. These are the bots a takeover usually meets. ────────────
  {
    name: 'Dyno', ids: ['155149108183695360'], aliases: [/^dyno\b/i],
    // `reaction_roles` belongs here: Dyno's role panels are one of the most-used things it does, and
    // leaving it off meant its "select :purple_circle: for Affiliate" panel could not even be
    // classified — reaction_roles was not in the running for a bot that plainly runs one.
    features: ['logging', 'moderation', 'reaction_roles', 'autorole', 'custom_commands', 'welcome',
      'starboard', 'suggestions'],
    coverage: 'full',
  },
  {
    name: 'YAGPDB.xyz', ids: ['204255221017214977'], aliases: [/^yagpdb/i],
    // `streams` is in here because servers really do use YAGPDB's feed module for live alerts — the
    // scan that prompted this found 175 of its stream announcements. A feature list written from the
    // bot's marketing page instead of from what it actually posted would have missed every one.
    features: ['moderation', 'autorole', 'reaction_roles', 'custom_commands', 'welcome', 'logging',
      'starboard', 'streams'],
    coverage: 'partial',
    why: "we cover its moderation, roles, welcome and logging. What does NOT come across is YAGPDB's "
      + 'custom-command scripting language — templated commands with variables and conditionals have '
      + 'to be rewritten as plain replies in the Command Center.',
  },
  {
    name: 'MEE6', ids: ['159985870458322944'], aliases: [/^mee6/i],
    features: ['leveling', 'welcome', 'autorole', 'moderation', 'custom_commands', 'streams'],
    coverage: 'full',
    // Not a coverage caveat — an ORDER-OF-OPERATIONS one. See feedback_mee6_migration_order.
    why: 'export its level data BEFORE it leaves — MEE6 takes the leaderboard with it and there is no '
      + 'way to get it back afterwards.',
  },
  {
    name: 'Carl-bot', ids: ['235148962103951360'], aliases: [/^carl-?bot/i],
    features: ['reaction_roles', 'logging', 'moderation', 'custom_commands', 'welcome', 'starboard', 'suggestions'],
    coverage: 'full',
  },
  {
    name: 'ProBot', ids: ['282859044593598464'], aliases: [/^probot/i],
    features: ['leveling', 'welcome', 'moderation', 'autorole', 'logging'],
    coverage: 'partial',
    why: "ProBot's image-based welcome cards are its own renderer — the welcome message comes across, "
      + 'the generated banner does not.',
  },

  // ── Levels ───────────────────────────────────────────────────────────────────
  {
    name: 'Arcane', ids: ['437808476106784770'], aliases: [/^arcane\b/i],
    features: ['leveling', 'moderation', 'autorole', 'welcome'],
    coverage: 'full',
    why: 'levels and level-roles come across, but the XP totals do not — Arcane keeps them and exposes '
      + 'no export. Members keep their ROLE, and start earning again from our own count.',
  },
  {
    name: 'Tatsu', ids: ['172002275412279296'], aliases: [/^tatsu/i],
    features: ['leveling', 'economy'],
    coverage: 'partial',
    why: "levels come across. Tatsu's own currency, inventory and pets do not — they live in its "
      + 'global economy, which is shared across every server it is in.',
  },
  { name: 'Amari', aliases: [/^amari/i], features: ['leveling'], coverage: 'full' },
  { name: 'Polaris', aliases: [/^polaris/i], features: ['leveling'], coverage: 'full' },

  // ── Streams ──────────────────────────────────────────────────────────────────
  {
    name: 'Streamcord', ids: ['375805687529209857'], aliases: [/^streamcord/i],
    features: ['streams'], coverage: 'full',
    why: 'Twitch, YouTube and Kick live alerts, with the same ping role and channel. We add Rumble '
      + 'and TikTok, which Streamcord does not do.',
  },
  { name: 'Pingcord', ids: ['282286160494067712'], aliases: [/^pingcord/i], features: ['streams'], coverage: 'full' },
  { name: 'Nova', aliases: [/^nova\b/i], features: ['streams'], coverage: 'full' },
  {
    name: 'StreamElements', aliases: [/^streamelements/i], features: ['streams'], coverage: 'partial',
    why: 'the Discord live alert comes across. Everything StreamElements does on the TWITCH side — '
      + 'overlays, alerts, loyalty points — is not a Discord feature and stays where it is.',
  },

  // ── Tickets, forms, events ───────────────────────────────────────────────────
  {
    name: 'Ticket Tool', ids: ['557628352828014614'], aliases: [/^ticket ?tool/i],
    features: ['tickets'], coverage: 'full',
    why: 'panels, categories, transcripts and staff roles all come across. Existing OPEN tickets do '
      + 'not migrate — close them, or leave the old bot until they are closed.',
  },
  { name: 'Tickety', aliases: [/^tickety/i], features: ['tickets'], coverage: 'full' },
  { name: 'Sesh', ids: ['616754792965865495'], aliases: [/^sesh\b/i], features: ['events'], coverage: 'partial',
    why: 'we schedule and announce events. sesh\'s RSVP polling and calendar sync do not come across.' },

  // ── Single-purpose ───────────────────────────────────────────────────────────
  { name: 'counting', ids: ['510016054391734273'], features: ['counting'], coverage: 'full' },
  { name: 'Counting Bot', ids: ['696797815782768650'], aliases: [/^counting ?bot/i], features: ['counting'], coverage: 'full' },
  { name: 'Friend Time', ids: ['471091072546766849'], aliases: [/^friend ?time/i], features: ['timezone'], coverage: 'full' },
  { name: 'Cat Bot', ids: ['966695034340663367'], aliases: [/^cat ?bot/i], features: ['catbot'], coverage: 'full' },
  { name: 'Grow a Tree', ids: ['972637072991068220'], aliases: [/^grow ?a ?tree/i], features: ['growtree'], coverage: 'full' },
  { name: 'OwO', ids: ['408785106942164992'], aliases: [/^owo$/i], features: ['owo'], coverage: 'full' },
  { name: 'CannaFriend', ids: ['1071983600729346208'], aliases: [/^cannafriend/i], features: ['cannabis'], coverage: 'full' },
  { name: 'Sx Bot', ids: ['696870234262339614'], aliases: [/^sx ?bot/i], features: ['emoji'], coverage: 'full' },
  { name: 'Nightbot', ids: ['83010416610906112'], aliases: [/^nightbot/i], features: ['custom_commands'], coverage: 'full' },
  { name: 'Throne Integration', ids: ['1437489496680828968'], aliases: [/^throne/i], features: ['throne'], coverage: 'full' },
  { name: 'FreeStuff', ids: ['672822334641537041'], aliases: [/^freestuff/i], features: ['free_games'], coverage: 'full' },
  { name: 'Birthday Bot', ids: ['656621136808902656'], aliases: [/^birthday ?bot/i], features: ['birthday'], coverage: 'full' },
  { name: '.fmbot', ids: ['356268235697553409'], aliases: [/^\.?fmbot/i], features: ['lastfm'], coverage: 'full' },
  { name: 'FlaviBot', ids: ['684773505157431347'], aliases: [/^flavibot/i], features: ['moderation'], coverage: 'full' },
  { name: 'Ko-fi Bot', ids: ['836232765942923305'], aliases: [/^ko-?fi/i], features: ['kofi'], coverage: 'full' },
  { name: 'Zira', ids: ['275813801792634880'], aliases: [/^zira/i], features: ['reaction_roles'], coverage: 'full' },
  { name: 'GiveawayBot', ids: ['294882584201461760'], aliases: [/^giveaway ?bot/i], features: ['giveaways'], coverage: 'full' },
  { name: 'Simple Poll', ids: ['324631108731928587'], aliases: [/^simple ?poll/i], features: ['polls'], coverage: 'full' },
  { name: 'QOTD Bot', aliases: [/^qotd/i], features: ['qotd'], coverage: 'full' },
  { name: 'Statbot', ids: ['491769129318088714'], aliases: [/^statbot/i], features: [], coverage: 'partial',
    why: '/moderation activity audits membership and voice activity, but Statbot\'s long-run graphs and public '
      + 'dashboards have no equivalent here.' },

  // ── Moderation specialists ───────────────────────────────────────────────────
  {
    name: 'Wick', ids: ['536991182035746816'], aliases: [/^wick\b/i],
    features: ['moderation'], coverage: 'partial',
    why: 'our anti-nuke, anti-raid, phishing and automod cover the same ground. What Wick has that we '
      + 'do not is its own verification/captcha gateway — /systems verify is a role gate, not a captcha.',
  },
  { name: 'Beemo', aliases: [/^beemo/i], features: [], coverage: 'none',
    why: 'a dedicated raid-detection service with its own network-wide signals. Our anti-raid is not the '
      + 'same thing — keep Beemo.' },

  // ── Music ────────────────────────────────────────────────────────────────────
  {
    name: 'Hydra', ids: ['647369836523503616'], aliases: [/^hydra/i], features: ['music'], coverage: 'partial',
    why: '/music plays from Spotify, YouTube and SoundCloud with a control panel. Saved PLAYLISTS on the '
      + 'old bot do not come across.',
  },
  { name: 'Jockie Music', aliases: [/^jockie/i], features: ['music'], coverage: 'partial',
    why: 'playback comes across; saved playlists do not.' },
  { name: 'FredBoat', ids: ['184405311681986560'], aliases: [/^fredboat/i], features: ['music'], coverage: 'full' },
  { name: 'Rythm', ids: ['235088799074484224'], aliases: [/^rythm/i], features: ['music'], coverage: 'full',
    why: 'Rythm has been shut down since 2021 — if it is still in the member list it has not worked in years.' },
  { name: 'Groovy', ids: ['234395307759108106'], aliases: [/^groovy/i], features: ['music'], coverage: 'full',
    why: 'Groovy has been shut down since 2021 — if it is still in the member list it has not worked in years.' },

  // ── Economy / games. Ours is real but it is not THEIR economy. ───────────────
  {
    name: 'Dank Memer', ids: ['270904126974590976'], aliases: [/^dank ?memer/i],
    features: ['economy'], coverage: 'partial',
    why: 'we have /economy, /fish, /rpg and the OwO-style games. What we cannot do is move anyone\'s Dank '
      + 'Memer balance or inventory — it is global to that bot and there is no export. Retiring it wipes '
      + 'nothing (their balance survives wherever else Dank Memer is), but it does not come here either.',
  },
  {
    name: 'UnbelievaBoat', ids: ['292953664492929025'], aliases: [/^unbelievaboat/i],
    features: ['economy'], coverage: 'partial',
    why: 'UnbelievaBoat\'s economy is PER-SERVER and it has a balance export. Ours is per-user and global, '
      + 'so balances cannot be carried across one-for-one — export before removing it.',
  },
  { name: 'Mudae', ids: ['432610292342587392'], aliases: [/^mudae/i], features: [], coverage: 'none',
    why: 'character-collection game with its own card database — no equivalent.' },
  { name: 'Pokétwo', ids: ['716390085896962058'], aliases: [/^pok[eé]two/i], features: [], coverage: 'none',
    why: 'catching game with per-user collections that cannot be moved — no equivalent.' },
  { name: 'Karuta', aliases: [/^karuta/i], features: [], coverage: 'none',
    why: 'card-collection game — no equivalent.' },
  { name: 'TacoShack', ids: ['490707751832649738'], aliases: [/^tacoshack/i], features: [], coverage: 'none',
    why: 'idle taco game — no equivalent.' },

  // ── Keep. Not a gap in us; just not a thing we do. ───────────────────────────
  { name: 'DISBOARD', ids: ['302050872383242240'], aliases: [/^disboard/i], features: [], coverage: 'none',
    why: 'server-listing bump service — nothing to replace.' },
  { name: 'BetterTTV', ids: ['351227880153546754'], aliases: [/^betterttv/i], features: [], coverage: 'none',
    why: 'Twitch emote service, not a Discord feature.' },
  { name: 'Xenon', ids: ['416358583220043796'], aliases: [/^xenon/i], features: [], coverage: 'none',
    why: 'server backup and templating. /admin backup covers config, not a full server clone — keep it.' },
  {
    name: 'Blerp', ids: ['964278831085125722'], aliases: [/^blerp/i],
    features: ['soundboard'], coverage: 'partial',
    why: '/soundboard plays clips into voice from a button panel — but you upload the clips. '
      + "Blerp's hosted library and Twitch integration do not come across.",
  },
];

/**
 * Bots that post ONLY through webhooks have no guild member to detect and no id to match. They can
 * be recognised by name and nothing else.
 */
export const WEBHOOK_ONLY = Object.freeze({
  TANGIA: 'Twitch-side TTS overlay, not a Discord feature',
});

/** Our own bots. They appear in a scan like anything else, but are never retirement targets. */
export const OURS = new Set(['certifriedutility', 'kabbot']);

/** Discord's own personas. Not bots — nothing to attribute, nothing to remove. */
export const SYSTEM_PERSONAS = new Set(['communityupdates', 'automod', 'serverboost', 'discord']);

export const nameKey = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Normalise a catalog row into the shape the rest of the engine expects.
 *
 * `feature` (singular) is kept as the PRIMARY feature because a great deal of the engine — the
 * plan's `byFeature` index, the removal ordering, the enable-after-removal map — was written
 * around one feature per bot. `features` is the full truth and is what the audit reports.
 */
function normalise(entry) {
  const features = entry.features ?? (entry.feature ? [entry.feature] : []);
  return Object.freeze({
    name: entry.name,
    feature: features[0] ?? null,
    features: Object.freeze([...features]),
    coverage: entry.coverage ?? (features.length ? 'full' : 'none'),
    why: entry.why ?? null,
    ids: Object.freeze([...(entry.ids ?? [])]),
    aliases: entry.aliases ?? [],
  });
}

const ENTRIES = CATALOG.map(normalise);

/**
 * id → meta, for every entry that has an id.
 *
 * Exported under its historical name because the API, the retirement engine and the takeover
 * command all read it. It is now DERIVED — the catalog above is where a bot gets added.
 */
export const KNOWN_BOTS = Object.freeze(Object.fromEntries(
  ENTRIES.flatMap(e => e.ids.map(id => [id, e]))));

/** Every catalog entry, id or not. This is what a name-based match searches. */
export const BOT_CATALOG = Object.freeze(ENTRIES);

/**
 * Resolve a scanned or live speaker to what we know about it.
 *
 * Four passes, most-certain first:
 *   1. It is us. Never a retirement target.
 *   2. Exact application id.
 *   3. Our own bots and Discord's system personas, by name.
 *   4. Name — the catalog's anchored aliases, then a prefix match on the catalog name.
 *
 * Pass 4 is what makes the audit portable. The analyzer keys a webhook persona as `wh:<name>`, not
 * as a snowflake, so an id lookup misses every webhook — and Dyno, FreeStuff and half the big bots
 * post most of their output through one. It also catches bots whose id we never wrote down.
 *
 * @param {string} botId    snowflake, or `wh:<name>` for a webhook persona
 * @param {string} [name]   display name, used for the name passes
 * @param {string} [selfId] the id of the bot doing the takeover — never a retirement target
 */
export function resolveBotMeta(botId, name, selfId = null) {
  if (selfId && botId === selfId) {
    return { name: name ?? 'this bot', feature: null, features: [], coverage: 'self', why: 'this is the bot doing the takeover' };
  }

  const direct = KNOWN_BOTS[botId];
  if (direct) return direct;

  const nk = nameKey(name);
  if (OURS.has(nk)) {
    return { name, feature: null, features: [], coverage: 'self', why: 'one of our own bots' };
  }
  if (SYSTEM_PERSONAS.has(nk)) {
    return { name, feature: null, features: [], coverage: 'system', why: "Discord's own system messages — not a bot" };
  }

  // `wh:Dyno™ #dyno-updates` → the persona name is everything after the prefix.
  const raw = String(botId ?? '').startsWith('wh:') ? String(botId).slice(3) : (name ?? '');
  if (!raw) return null;

  // A FOLLOWED announcement channel, not a bot doing a job here.
  //
  // When a server follows another server's announcements, Discord creates a webhook named
  // `<Server> #<channel>` and every post arrives under it. It looks exactly like a bot in a scan —
  // and one real server had 13 of a vendor's product announcements gating the retirement of that
  // vendor's actual bot, as if patch notes were a feature somebody had to replace.
  //
  // Matched BEFORE the catalog, because the name starts with the bot's own name and would otherwise
  // resolve to it. There is nothing to replace and nothing to remove: unfollowing the channel is a
  // thing a person does in channel settings.
  if (/\s#[a-z0-9_-]+$/i.test(raw)) {
    return {
      name: raw,
      feature: null,
      features: [],
      coverage: 'system',
      why: 'a followed announcement channel — someone hit Follow on another server\'s announcements. '
        + 'Not a bot doing a job in this server; unfollow the channel if you no longer want it.',
    };
  }

  for (const [whName, why] of Object.entries(WEBHOOK_ONLY)) {
    if (nameKey(whName) === nameKey(raw)) {
      return { name: whName, feature: null, features: [], coverage: 'none', why };
    }
  }

  // Anchored alias patterns first — they are written to be exact about where the name starts.
  for (const e of ENTRIES) {
    if (e.aliases.some(re => re.test(raw))) return e;
  }
  // Then a prefix match on the catalog name, which catches decorated webhook personas
  // (`Dyno™ #changelogs` → `dyno`).
  const needle = nameKey(raw);
  for (const e of ENTRIES) {
    const known = nameKey(e.name);
    if (known.length >= 3 && (needle === known || needle.startsWith(known))) return e;
  }
  return null;
}

/** Every feature a resolved bot covers, as a flat list. Safe on unknown/null metas. */
export function featuresOf(meta) {
  if (!meta) return [];
  if (meta.features?.length) return meta.features;
  return meta.feature ? [meta.feature] : [];
}

/**
 * The set of bots actually still in the guild, by normalised name. Built from the scan rows so a
 * webhook can be tied back to whether its owning bot is still here.
 *
 * Records BOTH the scanned name and the name we know it by — they differ ("Throne Integration Bot"
 * in the guild vs "Throne Integration" in the catalog), and a plain equality check silently treated
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
 *   • a bot we keep (TacoShack, TANGIA — hundreds of shapes we will never retire)
 *   • one of ours, or a Discord system persona
 *   • a bot that has ALREADY LEFT — you cannot retire what is not there
 *
 * A webhook is judged by its owning bot: FreeStuff posts through a webhook, so that evidence still
 * counts while FreeStuff is in the guild. A departed bot's webhook does not.
 */
export function needsEvidence(meta, presentNames = null) {
  if (!meta) return true; // unrecognised — a human genuinely must look
  if (meta.coverage !== 'full' && meta.coverage !== 'partial') return false;
  if (!presentNames) return true; // caller has no presence info — stay strict
  return presentNames.has(nameKey(meta.name));
}

export default {
  FEATURES, KNOWN_BOTS, BOT_CATALOG, WEBHOOK_ONLY, OURS, SYSTEM_PERSONAS,
  resolveBotMeta, featuresOf, presentBotNames, needsEvidence, nameKey,
};
