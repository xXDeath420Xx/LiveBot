import pool from '../utils/db.js';
import configCache from '../utils/configCache.js';
import logger from '../utils/logger.js';

/**
 * One place to ask "is this feature on for this guild", and one place to see
 * everything that exists.
 *
 * The audit that prompted this found 211 of 443 guild-scoped tables with zero
 * rows across all 82 guilds — features built, shipped, and never used by anyone.
 * Some of that is genuinely unwanted. Most of it is that there has never been a
 * single surface listing what exists, so a server owner cannot adopt what they
 * cannot find, and 1,124 subcommands do not fit in a `/help` list.
 *
 * The REGISTRY below is the answer to "what does this bot do". It is
 * deliberately hand-maintained rather than derived from the command list: what a
 * server owner wants to browse is *capabilities* ("Leveling", "Stream alerts"),
 * not the 1,124 subcommands those capabilities are spelled with. A derived list
 * would be complete and useless.
 *
 * ## Flags vs. config tables
 *
 * A flag is not the source of truth for a feature's settings — those stay in
 * their own tables. It answers only "has this guild turned this on", which is
 * what the catalog needs and what no single existing table could report.
 *
 * `detect` lets a feature report itself as already-active based on its real
 * config, so a guild that set something up before flags existed shows as ON
 * rather than as a fresh install waiting to be enabled.
 */

/**
 * @typedef {object} Feature
 * @property {string} key          Stable identifier. Never rename — flags key on it.
 * @property {string} name         What a server owner calls it.
 * @property {string} category     For grouping in the catalog.
 * @property {string} description  One line, plain language, no jargon.
 * @property {string} [command]    Primary entry point.
 * @property {string} [page]       Dashboard ?page= slug.
 * @property {string} [detect]     Table whose having a row for this guild means "already set up".
 * @property {string} [detectWhere] Extra condition on that row (a fixed SQL fragment), when having a row
 *                                  is not the same as being on.
 */

/** @type {Feature[]} */
export const REGISTRY = [
    // ── Community ────────────────────────────────────────────────────────
    { key: 'leveling', name: 'Leveling & XP', category: 'Community', page: 'leveling', command: '/level', detect: 'level_config',
      description: 'Members earn XP for chatting and voice, with rank cards and role rewards.' },
    { key: 'welcome', name: 'Welcome & goodbye', category: 'Community', page: 'welcome', command: '/manage welcome', detect: 'welcome_settings',
      description: 'Greet people when they join, with an optional generated banner.' },
    { key: 'birthdays', name: 'Birthdays', category: 'Community', page: 'birthday', command: '/engage birthday', detect: 'birthday_config', detectWhere: 'enabled = 1',
      description: 'Members register a birthday and the bot announces it on the day.' },
    { key: 'reaction_roles', name: 'Reaction roles', category: 'Community', page: 'reaction-roles', command: '/manage roles', detect: 'reaction_role_panels',
      description: 'Self-assign roles from a button or dropdown panel.' },
    { key: 'starboard', name: 'Starboard', category: 'Community', page: 'starboard', detect: 'starboard_config',
      description: 'Reposts messages the server reacts to enough times into a highlights channel.' },
    { key: 'suggestions', name: 'Suggestions', category: 'Community', page: 'suggestions', command: '/engage suggest', detect: 'suggestion_config', detectWhere: 'enabled = 1',
      description: 'A suggestion box with voting and staff responses.' },
    { key: 'qotd', name: 'Question of the day', category: 'Community', page: 'qotd', command: '/qotd', detect: 'qotd_channels',
      description: 'Posts a discussion prompt on a schedule.' },
    { key: 'confessions', name: 'Anonymous confessions', category: 'Community', page: 'confessions', command: '/fun confess', detect: 'confession_config', detectWhere: 'enabled = 1',
      description: 'Members post anonymously, with optional staff approval first.' },

    // ── Moderation & safety ─────────────────────────────────────────────
    { key: 'automod', name: 'Auto-moderation', category: 'Moderation', page: 'automod', detect: 'automod_rules',
      description: 'Filters spam, links, invites and word lists automatically.' },
    { key: 'phishing', name: 'Phishing protection', category: 'Moderation', page: 'phishing', detect: 'phishing_config',
      description: 'Blocks known scam and phishing links from a continuously updated list.' },
    { key: 'anti_raid', name: 'Raid protection', category: 'Moderation', page: 'advanced-protection', detect: 'raid_detection_config',
      detectWhere: '(enabled = 1 OR auto_lockdown_enabled = 1)',
      description: 'Detects and slows coordinated joins and mass-message floods.' },
    { key: 'anti_nuke', name: 'Anti-nuke', category: 'Moderation', page: 'security', detect: 'anti_nuke_config',
      description: 'Limits how much damage a compromised admin account can do.' },
    { key: 'logging', name: 'Audit logging', category: 'Moderation', page: 'logging', detect: 'logging_config',
      description: 'Records edits, deletes, joins, leaves, roles and moderator actions.' },
    { key: 'verification', name: 'Verification gate', category: 'Moderation', page: 'verification', detect: 'verify_config',
      description: 'New members pass an I agree button or a CAPTCHA before they can see the server.' },
    { key: 'global_ban', name: 'Global ban network', category: 'Moderation', page: 'global-ban', detect: 'global_ban_config',
      description: 'Shares bans across servers that opt in to the same network.' },
    { key: 'tickets', name: 'Support tickets', category: 'Moderation', page: 'tickets', detect: 'ticket_config',
      description: 'Members open private channels to talk to staff.' },

    // ── Streaming ────────────────────────────────────────────────────────
    { key: 'stream_alerts', name: 'Live alerts', category: 'Streaming', page: 'streamers', command: '/socials', detect: 'subscriptions',
      description: 'Announces when tracked streamers go live on Twitch, Kick, YouTube and more.' },
    { key: 'self_promo', name: 'Self-promo signup', category: 'Streaming', page: 'self-promo', detect: 'self_promo_config',
      description: 'Members add their own stream link and get tracked automatically.' },
    { key: 'twitch_schedule', name: 'Twitch schedule sync', category: 'Streaming', page: 'twitch-schedules', detect: 'twitch_schedule_sync_config',
      description: 'Mirrors a streamer\'s Twitch schedule into Discord as a weekly board.' },
    { key: 'stream_team', name: 'Stream teams', category: 'Streaming', page: 'teams', detect: 'twitch_teams',
      description: 'Track a whole Twitch team rather than adding each member by hand.' },

    // ── Games & economy ──────────────────────────────────────────────────
    { key: 'economy', name: 'Economy', category: 'Games', page: 'economy', command: '/economy', detect: 'economy_config',
      description: 'Server currency, daily rewards, a shop and gambling.' },
    { key: 'emoji_hunts', name: 'Emoji hunts', category: 'Games', page: 'emojihunt', command: '/arcade emojihunt', detect: 'emoji_hunts',
      description: 'The bot hides an emoji on recent messages; the fastest finders win points.' },
    { key: 'tournaments', name: 'Tournaments', category: 'Games', page: 'tournaments', command: '/tournament', detect: 'tournaments',
      description: 'Bracket tournaments with sign-ups, result reporting and prizes.' },
    { key: 'community_goals', name: 'Community goals', category: 'Community', page: 'communitygoals', command: '/arcade goals', detect: 'community_goals',
      description: 'Server-wide targets with a deadline, live progress and a reward for everyone who helps.' },
    { key: 'loyalty', name: 'Loyalty points', category: 'Community', page: 'loyalty', command: '/level loyalty', detect: 'loyalty_rewards',
      description: 'Members earn points for daily activity and spend them on roles and rewards.' },
    { key: 'counting', name: 'Counting', category: 'Games', page: 'counting', detect: 'counting_channels',
      description: 'Members count upward together in a channel.' },
    { key: 'word_games', name: 'Word games', category: 'Games', page: 'wordgames', command: '/wordgame', detect: 'word_game_channels',
      description: 'Wordle-likes, word searches and last-letter chains in chat.' },
    { key: 'pokemon', name: 'Pokémon', category: 'Games', page: 'pokemon', command: '/pokemon', detect: 'pokemon_settings',
      description: 'Pokémon spawn in chat to be caught, traded and battled.' },
    { key: 'digimon', name: 'Digimon', category: 'Games', page: 'digimon', command: '/digimon', detect: 'digimon_settings', detectWhere: 'enabled = 1',
      description: 'Raise a partner Digimon, tame wild ones, battle, and take a daily "which Digimon are you" quiz.' },
    { key: 'catbot', name: 'Cat collecting', category: 'Games', page: 'minigames', command: '/cat', detect: 'catbot_channels',
      description: 'Cats appear in chat to catch, collect and trade.' },
    { key: 'growtree', name: 'Grow a tree', category: 'Games', page: 'minigames', command: '/tree', detect: 'gat_trees',
      description: 'The whole server waters one tree and grows it together.' },
    { key: 'fishing', name: 'Fishing', category: 'Games', page: 'fishing', command: '/fish', detect: 'fishing_players',
      description: 'Catch fish, build a collection, enter tournaments.' },
    { key: 'rpg', name: 'D&D campaigns', category: 'Games', page: 'rpg', command: '/rpg', detect: 'dnd_campaigns',
      description: 'Dice, characters and AI-run campaigns.' },
    { key: 'cah', name: 'Cards Against Humanity', category: 'Games', page: 'cah', command: '/cah', detect: 'cah_guild_config',
      description: 'Play in Discord or on the web dashboard, with custom decks.' },

    // ── Utility ──────────────────────────────────────────────────────────
    { key: 'music', name: 'Music', category: 'Utility', page: 'music', command: '/music', detect: 'music_config',
      description: 'Play audio in a voice channel from Spotify, YouTube and SoundCloud.' },
    { key: 'soundboard', name: 'Soundboard', category: 'Utility', page: 'soundboard', command: '/soundboard', detect: 'vc_sound_config',
      description: 'Upload clips and play them from a button panel.' },
    { key: 'timezone', name: 'Time zones', category: 'Utility', page: 'minigames', command: '/timezone', detect: 'tz_guild_config',
      description: 'Converts times mentioned in chat into each reader\'s own zone.' },
    { key: 'weather', name: 'Weather', category: 'Utility', page: 'weather', command: '/weather', detect: 'weather_config',
      description: 'Current conditions and forecasts, with optional alerts.' },
    { key: 'giveaways', name: 'Giveaways', category: 'Utility', page: 'giveaways', command: '/manage giveaway', detect: 'giveaway_host_roles',
      description: 'Timed giveaways with entry requirements and automatic winner picking.' },
    { key: 'polls', name: 'Polls', category: 'Utility', page: 'polls', command: '/manage poll', detect: 'polls',
      description: 'Single or multi-choice polls with live results.' },
    { key: 'server_stats', name: 'Server stat channels', category: 'Utility', page: 'stat-displays', detect: 'stat_display_channels',
      description: 'Voice channels whose names show live member and activity counts.' },
    { key: 'free_games', name: 'Free game alerts', category: 'Utility', page: 'free-games', detect: 'free_games_subscriptions',
      description: 'Announces free games from Epic, Steam, GOG and others.' },
    { key: 'backups', name: 'Server backups', category: 'Utility', page: 'backups', detect: 'server_backups',
      description: 'Snapshot roles, channels and settings so they can be restored.' },

    // ── Personalisation ──────────────────────────────────────────────────
    { key: 'theme', name: 'Embed theme', category: 'Personalisation', page: 'theme', detect: 'guild_theme',
      description: 'Your own colours and footer branding on everything the bot posts.' },
    { key: 'language', name: 'Language', category: 'Personalisation', page: 'language', command: '/settings language', detect: 'guild_language_prefs',
      description: 'Which language the bot replies in for this server.' },
    { key: 'prefixes', name: 'Custom prefixes', category: 'Personalisation', page: 'command-center', detect: 'prefix_command_config',
      description: 'Use ! ? $ . or a mention instead of slash commands.' },
    { key: 'custom_commands', name: 'Custom commands', category: 'Personalisation', page: 'custom-commands', detect: 'custom_commands',
      description: 'Your own commands with templated responses.' },
];

const BY_KEY = new Map(REGISTRY.map((f) => [f.key, f]));

/**
 * How the catalog switches each feature off and on (dashboard ?page=catalog → setFeatureState()).
 *
 * THE RULE: a feature that already has its own master switch is switched THROUGH that switch, never
 * with a parallel flag. Two switches for one feature let the catalog say "off" while the feature's page
 * says "on" (and the bot follows the page), or the reverse. So per feature:
 *
 *   { table, column }   its own on/off column in its guild_id-keyed config table (always the detect
 *                       table). The runtime already reads it. `onExpr` when "on" is more than one column
 *                       (anti-raid: detection or auto-lockdown); `offAlso` lists the columns turned off
 *                       with it; `defaultOn` when the feature runs with no row at all (economy and prefix
 *                       commands run on built-in defaults until a server saves settings).
 *   { bgames: key }     core/bgames-settings.js (guild_feature_config JSON): the `enabled` the emoji-hunt,
 *                       community-goal, loyalty and tournament managers check.
 *   { managed: key }    a generated page's `enabled` (core/feature-config.js), enforced by the
 *                       COMMAND_FEATURE_MAP gate in events/interactionCreate.js and the prefix bridge.
 *   { flag: [keys] }    no switch of its own: guild_feature_flags (setFlag) holds "deliberately off",
 *                       and flagGateFor() makes the slash and prefix command gates refuse these command
 *                       keys while it is. Keys use the gate's shape, `command` or `command:sub`, after
 *                       mounts (/arcade tree arrives as `tree`). Turning one back on clears the flag.
 *
 * A feature with NO entry gets no catalog switch, only a link to its page: it runs from per-item settings
 * (each starboard, counting channel, stream subscription, free-game feed, ticket panel, QOTD channel …),
 * so one off flag would hide it from the catalog while it kept posting. Those are turned off on their
 * own pages. Before adding an entry, confirm the runtime really reads the switch (grep the column).
 *
 * Everything that asks "is this on" goes through catalogFor() (the catalog, the Overview and sidebar
 * dots via core/page-status.js, /discover, /setup) or guildsWithFeaturesOn() (core/guild-shortcuts.js),
 * so a change made here shows everywhere. `refresh` drops a module's own in-memory cache.
 */
export const SWITCHES = {
    leveling: { table: 'level_config', column: 'enabled' },
    birthdays: { table: 'birthday_config', column: 'enabled' },
    suggestions: { table: 'suggestion_config', column: 'enabled' },
    confessions: { table: 'confession_config', column: 'enabled' },
    phishing: { table: 'phishing_config', column: 'enabled' },
    anti_raid: { table: 'raid_detection_config', column: 'enabled',
        onExpr: '(enabled = 1 OR auto_lockdown_enabled = 1)', offAlso: ['auto_lockdown_enabled'] },
    anti_nuke: { table: 'anti_nuke_config', column: 'enabled',
        refresh: (g) => global.botManager?.getClientForGuild?.(g)?.antiNukeManager?.invalidateConfigCache?.(g) },
    logging: { table: 'logging_config', column: 'enabled' },
    verification: { table: 'verify_config', column: 'enabled',
        refresh: async (g) => (await import('./verification.js')).invalidateVerifyConfig(g) },
    global_ban: { table: 'global_ban_config', column: 'enabled' },
    self_promo: { table: 'self_promo_config', column: 'enabled',
        refresh: async (g) => (await import('./self-promo-handler.js')).invalidateSelfPromoConfig(g) },
    economy: { table: 'economy_config', column: 'enabled', defaultOn: true },
    // The Pokémon page's master switch is spawning; /pokemon itself stays available for collections.
    pokemon: { table: 'pokemon_settings', column: 'spawn_enabled' },
    digimon: { table: 'digimon_settings', column: 'enabled' },
    // Converting times mentioned in chat; /timezone itself always works.
    timezone: { table: 'tz_guild_config', column: 'enabled',
        refresh: async (g) => (await import('./timezone-manager.js')).invalidateGuild(g) },
    // Weather alerts; /weather lookups always work.
    weather: { table: 'weather_config', column: 'enabled' },
    theme: { table: 'guild_theme', column: 'enabled',
        refresh: async (g) => (await import('./guild-theme.js')).invalidate(g) },
    prefixes: { table: 'prefix_command_config', column: 'enabled', defaultOn: true,
        refresh: async (g) => (await import('./prefix-command-manager.js')).invalidateGuildCache(g) },

    emoji_hunts: { bgames: 'emojihunt' },
    community_goals: { bgames: 'communitygoals' },
    loyalty: { bgames: 'loyalty' },
    tournaments: { bgames: 'tournaments' },
    fishing: { managed: 'fishing' },
    word_games: { managed: 'wordgames' },

    giveaways: { flag: ['manage:giveaway'] },  // /giveaway (a shortcut) arrives as manage:giveaway
    polls: { flag: ['manage:poll'] },
    growtree: { flag: ['tree'] },
    rpg: { flag: ['rpg'] },
    cah: { flag: ['cah'] },
    // music_config's enabled columns are not read by anything, so music is flag-gated.
    music: { flag: ['music'] },
    // vc_sound_config.enabled is VC sound drops, not the soundboard panel.
    soundboard: { flag: ['soundboard'] },
};

// command key → feature key, for the flag gate.
const FLAG_GATES = new Map(Object.entries(SWITCHES)
    .flatMap(([key, sw]) => (sw.flag || []).map((cmd) => [cmd, key])));

const truthy = (v) => v === true || v === 1 || v === '1' || v === 'true';

/** Has this guild any config row for the feature (its detect table, with detectWhere)? */
async function detectRow(feature, guildId) {
    if (!feature.detect) return false;
    try {
        const [result] = await pool.execute(
            `SELECT 1 FROM \`${feature.detect}\` WHERE guild_id = ?${feature.detectWhere ? ` AND ${feature.detectWhere}` : ''} LIMIT 1`,
            [guildId]
        );
        return result.length > 0;
    } catch (error) {
        // A missing or renamed detect table must not blank the catalog.
        logger.debug(`[FeatureFlags] detect failed for ${feature.key} (${feature.detect}): ${error.message}`);
        return false;
    }
}

/** Stored `enabled` (true/false, or null when never saved) and the value in effect, for bgames/managed. */
async function settingEnabled(sw, storedConfig) {
    let fallback = true;
    if (sw.bgames) {
        const { DEFAULTS } = await import('./bgames-settings.js');
        fallback = truthy(DEFAULTS[sw.bgames]?.enabled ?? true);
    } else {
        const { defaultsFor } = await import('./feature-config-spec.js');
        const d = defaultsFor(sw.managed).enabled;
        fallback = d === undefined ? true : truthy(d);
    }
    const raw = storedConfig ? storedConfig.enabled : undefined;
    const stored = raw === undefined || raw === null || raw === '' ? null : truthy(raw);
    return { stored, effective: stored ?? fallback };
}

function parseConfig(v) {
    if (!v) return {};
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return {}; }
}

export function getFeature(key) {
    return BY_KEY.get(key) || null;
}

export function categories() {
    return [...new Set(REGISTRY.map((f) => f.category))];
}

/**
 * Explicit flags for a guild. Absent key = never touched, which is different
 * from "off" — the catalog distinguishes "not set up" from "deliberately off".
 *
 * @returns {Promise<Map<string, boolean>>}
 */
export async function getFlags(guildId) {
    return configCache.get('guild_feature_flags', guildId, async () => {
        const [rows] = await pool.execute(
            'SELECT feature_key, enabled FROM guild_feature_flags WHERE guild_id = ?',
            [guildId]
        );
        return new Map(rows.map((r) => [r.feature_key, Boolean(r.enabled)]));
    });
}

/**
 * Is the feature on for this guild — by the catalog's rule (its own switch from SWITCHES, else real
 * config unless flagged off, or flagged on), not the raw flag alone, which says nothing for a feature
 * switched through its own setting.
 */
export async function isEnabled(guildId, key) {
    const row = (await catalogFor(guildId)).find((f) => f.key === key);
    return row ? row.active : false;
}

export async function setFlag(guildId, key, enabled, configuredBy = null) {
    if (!BY_KEY.has(key)) throw new Error(`Unknown feature: ${key}`);
    await pool.execute(
        `INSERT INTO guild_feature_flags (guild_id, feature_key, enabled, configured_by)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), configured_by = VALUES(configured_by)`,
        [guildId, key, enabled ? 1 : 0, configuredBy]
    );
    configCache.invalidate('guild_feature_flags', guildId);
    configCache.invalidate('feature_catalog', String(guildId));
    configCache.invalidate('page_status', String(guildId));
    // Feature shortcuts (/confess, /birthday …) appear or go with the feature.
    import('./guild-shortcuts.js').then(m => m.refreshSoon(guildId)).catch(() => {});
}

/** Forget a guild's explicit flag for a feature: back to "on when it has real config". */
export async function clearFlag(guildId, key) {
    const [res] = await pool.execute(
        'DELETE FROM guild_feature_flags WHERE guild_id = ? AND feature_key = ?', [guildId, key]);
    if (!res.affectedRows) return false;
    configCache.invalidate('guild_feature_flags', guildId);
    configCache.invalidate('feature_catalog', String(guildId));
    configCache.invalidate('page_status', String(guildId));
    import('./guild-shortcuts.js').then(m => m.refreshSoon(guildId)).catch(() => {});
    return true;
}

/**
 * Turn a feature on or off for a guild the way SWITCHES says (its own switch, or the flag).
 * Returns { ok: true } or { ok: false, status, error, needsSetup? }; never a half-written state.
 */
export async function setFeatureState(guildId, key, enabled, configuredBy = null) {
    const feature = getFeature(key);
    if (!feature) return { ok: false, status: 404, error: 'Unknown feature.' };
    const sw = SWITCHES[key];
    if (!sw) return { ok: false, status: 409, error: `${feature.name} is turned on and off from its own page.` };
    const on = Boolean(enabled);

    if (sw.table) {
        const [rows] = await pool.execute(`SELECT 1 FROM \`${sw.table}\` WHERE guild_id = ? LIMIT 1`, [guildId]);
        if (on) {
            if (rows.length) {
                await pool.execute(`UPDATE \`${sw.table}\` SET \`${sw.column}\` = 1 WHERE guild_id = ?`, [guildId]);
            } else if (!sw.defaultOn) {
                return { ok: false, status: 409, needsSetup: true, error: `${feature.name} needs setting up on its page first.` };
            }
        } else {
            const cols = [sw.column, ...(sw.offAlso || [])];
            if (rows.length) {
                await pool.execute(
                    `UPDATE \`${sw.table}\` SET ${cols.map((c) => `\`${c}\` = 0`).join(', ')} WHERE guild_id = ?`, [guildId]);
            } else if (sw.defaultOn) {
                // Runs on defaults with no row, so "off" needs one; every other column keeps its default.
                await pool.execute(
                    `INSERT INTO \`${sw.table}\` (guild_id, ${cols.map((c) => `\`${c}\``).join(', ')})
                     VALUES (?, ${cols.map(() => '0').join(', ')})`, [guildId]);
            }
            // No row and not on by default: nothing is running, nothing to switch off.
        }
    } else if (sw.bgames) {
        await (await import('./bgames-settings.js')).updateSettings(sw.bgames, guildId, { enabled: on }, configuredBy);
    } else if (sw.managed) {
        await (await import('./feature-config.js')).setConfig(sw.managed, guildId, { enabled: on ? 1 : 0 }, configuredBy);
    } else if (sw.flag) {
        if (on) {
            await clearFlag(guildId, key);
            // Nothing set up yet: the flag is what makes it on (shortcuts registered, shown as On).
            if (!(await detectRow(feature, guildId))) await setFlag(guildId, key, true, configuredBy);
        } else {
            await setFlag(guildId, key, false, configuredBy);
        }
    }

    // A feature with its own switch never keeps a flag beside it.
    if (!sw.flag) await clearFlag(guildId, key);

    configCache.invalidateGuild(String(guildId));
    try {
        (await import('./feature-config.js')).invalidateGuild(guildId);
        await sw.refresh?.(guildId);
    } catch (err) {
        logger.debug(`[FeatureFlags] cache refresh after switching ${key}: ${err.message}`);
    }
    import('./guild-shortcuts.js').then(m => m.refreshSoon(guildId)).catch(() => {});
    return { ok: true };
}

/**
 * The feature an explicit off flag closes this command to, or null. Called by the slash gate
 * (events/interactionCreate.js) and the prefix bridge (core/universal-commands.js) with the same
 * `command` / `command:sub` keys as the COMMAND_FEATURE_MAP gate. Ungated commands cost no query.
 */
export async function flagGateFor(guildId, commandName, subKey) {
    const key = (subKey && FLAG_GATES.get(subKey)) || FLAG_GATES.get(commandName);
    if (!key || !guildId) return null;
    const flags = await getFlags(guildId);
    return flags.get(key) === false ? getFeature(key) : null;
}

/**
 * guildId → Set of feature keys that are on there, for the given keys, by the same rule as
 * catalogFor(): the feature's own switch where it has one, otherwise detected config unless
 * flagged off, or flagged on. Not for `defaultOn` features (they are on in every guild without a row).
 */
export async function guildsWithFeaturesOn(keys) {
    const byGuild = new Map();
    const add = (g, k) => { const id = String(g); if (!byGuild.has(id)) byGuild.set(id, new Set()); byGuild.get(id).add(k); };
    const flagKeys = keys.filter((k) => !SWITCHES[k] || SWITCHES[k].flag);
    for (const key of keys) {
        const feature = getFeature(key);
        const sw = SWITCHES[key];
        if (!feature) continue;
        try {
            if (sw?.table) {
                const [rows] = await pool.query(
                    `SELECT guild_id FROM \`${sw.table}\` WHERE ${sw.onExpr || `\`${sw.column}\` = 1`}`);
                for (const r of rows) add(r.guild_id, key);
                continue;
            }
            if (!feature.detect) continue;
            const [rows] = await pool.query(
                `SELECT DISTINCT guild_id FROM \`${feature.detect}\`${feature.detectWhere ? ` WHERE ${feature.detectWhere}` : ''}`);
            if (sw?.bgames || sw?.managed) {
                const [cfgRows] = await pool.query(
                    'SELECT guild_id, config FROM guild_feature_config WHERE feature_key = ?', [sw.bgames || sw.managed]);
                const stored = new Map(cfgRows.map((r) => [String(r.guild_id), parseConfig(r.config)]));
                for (const r of rows) {
                    if ((await settingEnabled(sw, stored.get(String(r.guild_id)))).effective) add(r.guild_id, key);
                }
            } else {
                for (const r of rows) add(r.guild_id, key);
            }
        } catch (e) {
            logger.debug(`[FeatureFlags] guildsWithFeaturesOn failed for ${key}: ${e.message}`);
        }
    }
    if (flagKeys.length) {
        const [flags] = await pool.query(
            'SELECT guild_id, feature_key, enabled FROM guild_feature_flags WHERE feature_key IN (?)', [flagKeys]);
        // An explicit flag wins over detected config, both ways.
        for (const r of flags) {
            if (r.enabled) add(r.guild_id, r.feature_key);
            else byGuild.get(String(r.guild_id))?.delete(r.feature_key);
        }
    }
    return byGuild;
}

/**
 * The catalog: every feature with its real state for this guild.
 *
 * `detect` is queried so a guild that configured something years before flags
 * existed shows as active rather than as an untouched feature — otherwise the
 * catalog would tell 82 servers that nothing is set up, which is both wrong and
 * the fastest way to make people stop trusting it.
 *
 * One COUNT per feature is ~40 cheap indexed queries; the result is cached.
 */
export async function catalogFor(guildId) {
    // Cached with the rest of the guild's config (configCache TTL, dropped after any dashboard
    // write and by setFlag): every manage page renders the catalog and the page-status dots
    // (core/page-status.js) from it. Callers get copies, so they may change the rows.
    const rows = await configCache.get('feature_catalog', String(guildId), () => computeCatalog(guildId));
    return rows.map((r) => ({ ...r }));
}

async function computeCatalog(guildId) {
    const flags = await getFlags(guildId);
    let managed = new Map();
    if (Object.values(SWITCHES).some((sw) => sw.bgames || sw.managed)) {
        try {
            const [cfgRows] = await pool.execute(
                'SELECT feature_key, config FROM guild_feature_config WHERE guild_id = ?', [guildId]);
            managed = new Map(cfgRows.map((r) => [r.feature_key, parseConfig(r.config)]));
        } catch (error) {
            logger.debug(`[FeatureFlags] guild_feature_config read failed: ${error.message}`);
        }
    }

    const rows = await Promise.all(REGISTRY.map(async (feature) => {
        const sw = SWITCHES[feature.key] || null;
        let configured = false;
        // The stored on/off — the feature's own switch where it has one (SWITCHES), else the flag.
        // null = never set. `explicitFlag` keeps its name: the catalog and page-status read it.
        let explicit = null;
        let active;

        if (sw?.table) {
            // The switch lives in the detect table itself: a row means set up, its column means on.
            try {
                const [result] = await pool.execute(
                    `SELECT ${sw.onExpr || `\`${sw.column}\` = 1`} AS v FROM \`${sw.table}\` WHERE guild_id = ? LIMIT 1`,
                    [guildId]
                );
                if (result.length) {
                    configured = true;
                    explicit = Boolean(Number(result[0].v));
                }
            } catch (error) {
                logger.debug(`[FeatureFlags] switch read failed for ${feature.key} (${sw.table}): ${error.message}`);
            }
            active = explicit ?? Boolean(sw.defaultOn);
        } else {
            configured = await detectRow(feature, guildId);
            if (sw?.bgames || sw?.managed) {
                const s = await settingEnabled(sw, managed.get(sw.bgames || sw.managed));
                explicit = s.stored;
                active = configured && s.effective;
            } else {
                const flag = flags.get(feature.key);
                explicit = flag ?? null;
                // Active when explicitly on, or when it has real config and has not
                // been explicitly turned off.
                active = flag === true || (flag !== false && configured);
            }
        }

        return {
            ...feature,
            configured,
            explicitFlag: explicit,
            active,
            // How the catalog can switch it: 'switch' (its own), 'flag', or null (only on its page).
            control: !sw ? null : (sw.flag ? 'flag' : 'switch'),
            // A switch that needs a saved row cannot be turned on from nothing; send them to the page.
            canEnableFromNothing: Boolean(sw && (sw.flag || sw.defaultOn)),
        };
    }));

    return rows;
}

/** Catalog grouped by category, for rendering. */
export async function catalogByCategory(guildId) {
    const all = await catalogFor(guildId);
    const grouped = new Map();
    for (const feature of all) {
        if (!grouped.has(feature.category)) grouped.set(feature.category, []);
        grouped.get(feature.category).push(feature);
    }
    return grouped;
}

export default { REGISTRY, SWITCHES, getFeature, categories, getFlags, isEnabled, setFlag, clearFlag, setFeatureState, flagGateFor, guildsWithFeaturesOn, catalogFor, catalogByCategory };
