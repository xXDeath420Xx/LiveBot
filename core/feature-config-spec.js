/*
 * Declarative configuration surface for features that had no dashboard page.
 *
 * The 2026-08-05 coverage audit found 27 command families with zero dashboard control. Building
 * 27 bespoke pages would mean 27 copies of the same fetch/render/save boilerplate, and the
 * free-games page is a standing demonstration of how that decays: its markup listed 11 of the
 * 25 toggles the schema had, so 14 settings were unreachable for as long as that drift went
 * unnoticed.
 *
 * Instead, every feature here declares WHAT it stores and WHERE, and one generic API router
 * (dashboard/routes/api/features/feature-config.js) plus one generic page partial
 * (partials/manage/feature-config.ejs) do the rest. Adding a control is a line in this file.
 *
 * ## Two storage shapes
 *
 *   table   — the feature already has a per-guild config table. Fields map to real columns and
 *             the manager already reads them, so a change here takes effect immediately.
 *   managed — the feature had no config table at all. Fields live as JSON in
 *             `guild_feature_config` (migration 197) and are read via core/feature-config.js.
 *
 * ## `wired` (per field) and `unwired` (per feature)
 *
 * `wired: false` on a field means it is stored and shown but the runtime does not read it yet.
 * `unwired: '<table>'` on a FEATURE means no runtime code reads that table at all — the page
 * renders a banner saying so instead of pretending the controls do something.
 *
 * Both exist because the alternative is worse than an empty page: a server changes a setting,
 * nothing happens, and there is no way to tell a broken feature from a misunderstood one.
 * Verify with `grep -rl '<table>' core/ commands/ events/ jobs/ utils/` before marking anything
 * wired — note that `utils/backup-utils.js` merely enumerates tables for backups and is NOT a
 * runtime reader.
 *
 * ## Before adding a feature, check it is not already covered
 *
 * Several tables in this schema are dead duplicates of a live one, and a page built on the dead
 * twin is a control that silently does nothing. Confirmed pairs, all of which already have a
 * hand-written page and must NOT be re-added here:
 *
 *   auto_voice_config       → dead; live join-to-create is `temp_channel_config`  (?page=utilities)
 *   statdocks_config        → dead; live stat channels are `stat_display_channels` (?page=stat-displays)
 *   statroles_config        → dead; live rules are `statrole_configs`              (?page=stat-roles)
 *   verification_config     → dead; live gating is `verify_config`                 (?page=verification)
 *   join_gate_config.is_enabled / verification_* → dead; folded into `verify_config` (migration 328)
 *   verify_config           → has its own page (?page=verification, core/verification.js); the
 *                             generic 'verify-gate' spec that edited it raw was removed with it
 *   scheduled_events_config → live mirror of Discord events for reminders (core/event-reminder-manager.js)
 *
 * Grep the WHOLE dashboard/ tree, not just partials — server.js does most config queries.
 */
import { LANGUAGES as EVIL_INSULT_LANGUAGES } from './evil-insults.js';
import { jellyfinLibraryOptions } from './activities/watch/library-options.js';

/**
 * @typedef {Object} Field
 * @property {string} key      Column name (table specs) or JSON key (managed specs)
 * @property {string} label
 * @property {'toggle'|'text'|'number'|'select'|'channel'|'role'|'color'|'multiline'|'message'|'channels'|'roles'|'voice'} type
 *           `voice`: a TTS voice id (Piper, or Kokoro as kokoro_<name>), picked from a grouped list with a
 *           preview button; blank = the fallback named in the hint.
 *           `message`: text the bot posts. Drawn with a live Discord-style preview that fills {variables}
 *           with sample values; at most 2000 characters unless `maxLength` is lower.
 * @property {string} [group]  Section the field is drawn in (spec-level `groups: [{ title, desc }]` orders
 *           them). Without groups, a page of six or more fields is split by kind automatically.
 * @property {string} [unit]   Shown after a number box. A trailing "(minutes)" in the label works too.
 * @property {Object<string,string>|string[]} [vars]  `message`: variables it supports, as name: sample value.
 * @property {'message'|'embed'} [preview]  `message`: draw the preview as plain text or an embed description.
 * @property {string} [placeholder]  What the bot uses when the field is left empty (also the box's placeholder).
 * @property {number} [maxLength]  `text` / `multiline` / `message`: character limit (saved values are cut to it).
 * @property {Object} [showIf] @property {Object} [hideIf]  { otherKey: value }: show the field only while
 *           another field has (or lacks) that value. Hidden fields are still saved unchanged.
 * @property {string} [hint]
 * @property {*} [default]
 * @property {Array<{value:string,label:string}>} [options]  For `select`
 * @property {number} [min] @property {number} [max]         For `number`
 * @property {boolean} [wired]  Default true. False = stored but not yet enforced.
 * @property {boolean} [json]  `multiline`: the value must be JSON (an object or array) or empty; anything else is refused on save.
 */

/**
 * The manage-page sections a generated card can be filed under. These match the hand-written
 * section headings in manage-tailwind.ejs exactly — a card whose `category` does not appear here
 * falls through to the "More Features" catch-all at the bottom of the page, which is a signal
 * that the category was mistyped rather than a place things are meant to live.
 */
export const CATEGORIES = [
    'Core',
    'Streaming & Content',
    'Community',
    'Economy & Games',
    'Moderation & Security',
    'Analytics & Logging',
    'Automation & Scheduling',
    'Server Tools',
];

export const FEATURE_SPECS = {

    // ── Features with an existing per-guild config table ────────────────────────────────

    'vc-sounds': {
        label: 'VC sound drops',
        category: 'Community',
        icon: 'fa-volume-high',
        colour: 'purple',
        blurb: 'Plays a random clip in a busy voice channel now and then',
        commands: ['/admin vcsounds'],
        storage: { kind: 'table', table: 'vc_sound_config', key: 'guild_id' },
        fields: [
            { key: 'enabled', label: 'Sound drops', type: 'toggle', default: 0,
              hint: 'The bot joins a voice channel, plays one of the clips below and leaves.' },
            // The values are vc_sound_config.mode's (random, scheduled, both), as /admin vcsounds enable
            // and jobs/vc-sound-scheduler.js use them.
            { key: 'mode', label: 'When to play', type: 'select', default: 'random',
              options: [{ value: 'random', label: 'After a random wait' }, { value: 'scheduled', label: 'At fixed times' },
                  { value: 'both', label: 'Both' }] },
            { key: 'min_interval_minutes', label: 'Shortest wait (minutes)', type: 'number', min: 5, max: 1440, default: 30, hideIf: { mode: 'scheduled' } },
            { key: 'max_interval_minutes', label: 'Longest wait (minutes)', type: 'number', min: 10, max: 1440, default: 120, hideIf: { mode: 'scheduled' },
              hint: 'Never sooner than the shortest wait; on average about halfway between the two.' },
            { key: 'schedule_times', label: 'Times', type: 'text', maxLength: 200, placeholder: '14:00, 20:30', hideIf: { mode: 'random' },
              hint: '24-hour times in UTC, separated by commas.' },
            { key: 'min_users_in_vc', label: 'People needed in the channel', type: 'number', min: 1, max: 50, default: 1,
              hint: 'Members who are not bots. Nothing plays to a channel with fewer.' },
            { key: 'volume', label: 'Volume (%)', type: 'number', min: 1, max: 100, default: 50 },
            { key: 'leave_after_seconds', label: 'Leave after (seconds)', type: 'number', min: 1, max: 300, default: 5,
              hint: 'How long the bot stays once the clip ends.' },
            { key: 'blacklisted_channels', label: 'Never play in', type: 'channels', channelKind: 'voice', hint: 'Voice channels to skip.' },
            { key: 'whitelisted_channels', label: 'Only play in', type: 'channels', channelKind: 'voice', hint: 'Leave empty to allow every voice channel.' },
        ],
    },

    qotd: {
        label: 'Question of the Day',
        category: 'Automation & Scheduling',
        icon: 'fa-circle-question',
        colour: 'orange',
        blurb: 'Scheduled question posts with decks and threads',
        commands: ['/qotd'],
        // qotd_channels is keyed on channel_id, not guild_id — one row per configured channel.
        // A guild-keyed upsert would either collapse every channel into one row or duplicate
        // them, so the per-channel rows stay read-only here and these are guild-wide defaults.
        storage: { kind: 'managed', feature: 'qotd' },
        list: {
            table: 'qotd_channels',
            title: 'Channels',
            columns: ['channel_id', 'schedule_type', 'schedule_time', 'timezone', 'enabled', 'last_posted_at'],
            labels: ['Channel', 'Schedule', 'Time', 'Timezone', 'Enabled', 'Last posted'],
            // Each row is edited in place. Validation and the write live in core/qotd-poster.js
            // (updateChannelSchedule / createChannel), shared with /qotd setup.
            key: 'channel_id',
            editor: 'qotd',
            addLabel: 'Add a channel',
            edit: [
                { key: 'enabled', label: 'Posting', type: 'toggle' },
                { key: 'schedule_type', label: 'Schedule', type: 'select',
                  options: [{ value: 'daily', label: 'Every day' }, { value: 'weekly', label: 'On chosen days' }, { value: 'custom', label: 'Every set number of minutes' }] },
                { key: 'schedule_days', label: 'Days', type: 'days', showIf: { schedule_type: 'weekly' } },
                { key: 'custom_interval_minutes', label: 'Every (minutes)', type: 'number', min: 15, max: 10080, showIf: { schedule_type: 'custom' } },
                { key: 'schedule_time', label: 'Time', type: 'time', hideIf: { schedule_type: 'custom' } },
                { key: 'timezone', label: 'Timezone', type: 'timezone', hideIf: { schedule_type: 'custom' } },
                { key: 'embed_title', label: 'Title', type: 'text', hint: 'Shown above each question, e.g. Question of the Week' },
                { key: 'ping_role_ids', label: 'Ping', type: 'roles' },
                { key: 'thread_enabled', label: 'Open a thread per question', type: 'toggle' },
            ],
        },
        note: 'Change any channel below, or add one. The settings here are what a newly added channel starts with.',
        fields: [
            { key: 'enabled', label: 'Enabled', type: 'toggle', default: true,
              hint: 'Off: no channel posts on its schedule. /qotd post still works.' },
            { key: 'default_schedule_type', label: 'Default schedule', type: 'select', default: 'daily',
              options: [{ value: 'daily', label: 'Every day' }, { value: 'weekly', label: 'On chosen days' }] },
            { key: 'default_schedule_days', label: 'Default days', type: 'days', hint: 'Used when the default schedule is on chosen days. With none picked, a new channel posts on Mondays.' },
            { key: 'default_schedule_time', label: 'Default time of day', type: 'time', hint: 'Left empty, a new channel posts at 09:00 in its timezone.' },
            { key: 'default_timezone', label: 'Default timezone', type: 'timezone', default: 'UTC' },
            { key: 'default_mode', label: 'Default card order', type: 'select', default: 'random',
              options: [{ value: 'random', label: 'Random' }, { value: 'sequential', label: 'In order' }] },
            { key: 'default_ping_roles', label: 'Default ping roles', type: 'roles' },
            { key: 'default_embed_color', label: 'Default embed colour', type: 'color' },
            { key: 'default_thread_enabled', label: 'Open a thread per question', type: 'toggle', default: false },
            { key: 'default_pin_message', label: 'Pin each question', type: 'toggle', default: false },
        ],
    },

    pokemon: {
        label: 'Pokémon',
        category: 'Economy & Games',
        icon: 'fa-dragon',
        colour: 'yellow',
        blurb: 'Spawning, catching, battling and trading',
        commands: ['/pokemon'],
        storage: { kind: 'table', table: 'pokemon_settings', key: 'guild_id' },
        fields: [
            // min_spawn_rate / max_spawn_rate are the chance per message as a fraction (DECIMAL(4,3), 0.05 = 5%),
            // the unit commands/games/pokemon.js calculateSpawnRate and /pokemon spawnconfig use. The page shows
            // them as whole percent (`scale: 100`): defaults are in stored units, min/max in shown units.
            { key: 'spawn_enabled', label: 'Spawns enabled', type: 'toggle', default: 0,
              hint: 'Pokémon appear as people chat. The rest of /pokemon works either way.' },
            { key: 'pokemon_channel_id', label: 'Spawn channel', type: 'channel', channelKind: 'text',
              hint: 'Leave empty to spawn in whichever channel people are talking in.' },
            { key: 'min_spawn_rate', label: 'Chance per message when quiet (%)', type: 'number', min: 1, max: 50, scale: 100, default: 0.05,
              hint: 'At most one spawn per channel each minute.' },
            { key: 'max_spawn_rate', label: 'Chance per message when busy (%)', type: 'number', min: 1, max: 50, scale: 100, default: 0.25,
              hint: 'Reached once about 50 members have talked in the last 5 minutes. Keep it at or above the quiet chance.' },
            { key: 'activity_tracking_enabled', label: 'Raise the chance as more people chat', type: 'toggle', default: 1,
              hint: 'Off: every message uses the quiet chance.' },
        ],
    },

    digimon: {
        label: 'Digimon',
        category: 'Economy & Games',
        icon: 'fa-dragon',
        colour: 'blue',
        blurb: 'Raise a partner, tame wild Digimon, battle, and a daily "which Digimon are you" quiz',
        commands: ['/digimon'],
        storage: { kind: 'table', table: 'digimon_settings', key: 'guild_id' },
        fields: [
            // Off by default: the whole /digimon command answers "turned off" until a server opts in.
            { key: 'enabled', label: 'Enabled', type: 'toggle', default: 0,
              hint: 'Turns on /digimon, including the daily quiz.' },
            { key: 'spawns_enabled', label: 'Wild Digimon appear in chat', type: 'toggle', default: 1 },
            { key: 'spawn_channel_id', label: 'Spawn channel', type: 'channel',
              hint: 'Leave empty to spawn in whichever channel people are talking in.' },
            { key: 'spawn_chance', label: 'Chance per message (%)', type: 'number', min: 1, max: 50, default: 4,
              hint: 'At most one spawn per channel every 2 minutes.' },
            { key: 'trades_enabled', label: 'Members can trade Digimon', type: 'toggle', default: 1 },
            { key: 'market_enabled', label: 'Market for buying and selling with bits', type: 'toggle', default: 1 },
            { key: 'market_fee_percent', label: 'Market fee (%)', type: 'number', min: 0, max: 50, default: 5,
              hint: 'Taken from the seller\'s bits on each sale, so bits leave the economy. 0 for no fee.' },
            { key: 'lifespan_days', label: 'Lifespan (days)', type: 'number', min: 0, max: 365, default: 30,
              hint: 'Days on the team before a partner is reborn as a Digi-Egg. 0 turns it off.' },
        ],
    },

    'steam-watch': {
        label: 'Steam Watch',
        category: 'Economy & Games',
        icon: 'fa-steam',
        iconPack: 'fab',
        colour: 'blue',
        blurb: 'Track Steam games for updates and news',
        commands: ['/media steam'],
        storage: { kind: 'table', table: 'steam_guild_settings', key: 'guild_id' },
        fields: [
            // The same choices as /media steam currency (commands/info/media.js); the value is Steam's store region.
            { key: 'currency', label: 'Price currency', type: 'select', default: 'us',
              options: [['us', 'USD (United States)'], ['eu', 'EUR (Europe)'], ['uk', 'GBP (United Kingdom)'], ['ca', 'CAD (Canada)'],
                  ['au', 'AUD (Australia)'], ['jp', 'JPY (Japan)'], ['ru', 'RUB (Russia)'], ['br', 'BRL (Brazil)']].map(([value, label]) => ({ value, label })) },
        ],
        // The watcher rows themselves are a list, not a settings form.
        list: {
            table: 'steam_watchers',
            title: 'Watched games',
            columns: ['steam_name', 'watcher_type', 'discord_channel_id', 'is_enabled', 'last_checked_at'],
            labels: ['Game', 'Type', 'Channel', 'Enabled', 'Last checked'],
        },
    },

    orientation: {
        label: 'Orientation',
        category: 'Server Tools',
        icon: 'fa-map-signs',
        colour: 'purple',
        blurb: 'A guide message listing what the bot does in this server',
        commands: ['/systems orientation post', '/systems orientation update', '/systems orientation remove'],
        note: 'The guide lists the bot features this server has set up and how to set up the rest. It is not refreshed on its own: after changing features, use /systems orientation update.',
        storage: { kind: 'table', table: 'orientation_config', key: 'guild_id' },
        fields: [
            { key: 'channel_id', label: 'Guide channel', type: 'channel', channelKind: 'text',
              hint: 'Saving a different channel posts the guide there and deletes it from the old one. Leave empty to remove the guide.' },
        ],
    },

    imagine: {
        label: 'AI image generation',
        category: 'Server Tools',
        icon: 'fa-wand-magic-sparkles',
        colour: 'purple',
        blurb: 'Generate images from a text prompt',
        commands: ['/imagine generate'],
        storage: { kind: 'table', table: 'imagine_config', key: 'guild_id' },
        // Defaults and range as commands/fun/imagine.js: no row = on, 15 s; /imagine config cooldown is 5-300.
        fields: [
            { key: 'enabled', label: 'Image generation', type: 'toggle', default: 1, hint: 'Members can use /imagine generate.' },
            { key: 'allowed_channel_id', label: 'Only in this channel', type: 'channel', hint: 'Leave empty to allow it anywhere.' },
            { key: 'cooldown_seconds', label: 'Wait between requests (seconds)', type: 'number', min: 5, max: 300, default: 15,
              hint: 'Per member, from 5 to 300 seconds.' },
        ],
    },

    'ai-assistant': {
        label: 'AI assistant',
        category: 'Core',
        icon: 'fa-robot',
        colour: 'purple',
        blurb: 'Answers when the bot is @mentioned',
        commands: ['/manage ai'],
        storage: { kind: 'table', table: 'ai_config', key: 'guild_id' },
        fields: [
            { key: 'enabled', label: 'AI assistant', type: 'toggle', default: 0, hint: 'Answers when someone mentions the bot.' },
            { key: 'allow_actions', label: 'Allow it to take actions', type: 'toggle', default: 1,
              hint: 'Such as playing music or clearing messages, only when the member asking could do it themselves. When off it can only answer, never change anything.' },
            { key: 'channel_ids', label: 'Only in these channels', type: 'channels', hint: 'Leave empty to answer anywhere.' },
            // As /manage ai limit (1-5000) and the ai_config default (500).
            { key: 'daily_cap', label: 'Replies per day', type: 'number', min: 1, max: 5000, default: 500,
              hint: 'For the whole server. It stops answering for the day once this is reached.' },
            { key: 'memory_mode', label: 'Conversation memory', type: 'select', default: 'user',
                options: [{ value: 'user', label: 'Per member (private)' }, { value: 'channel', label: 'Shared per channel' }, { value: 'off', label: 'Off' }],
                hint: 'Members can say "@bot forget" to wipe their own memory. Turning it off via /manage ai memory also deletes stored messages.' },
            { key: 'memory_turns', label: 'Exchanges remembered', type: 'number', min: 1, max: 20, default: 6 },
            { key: 'memory_ttl_minutes', label: 'Forget after (minutes)', type: 'number', min: 5, max: 1440, default: 60 },
        ],
    },

    modmail: {
        label: 'Modmail',
        category: 'Server Tools',
        icon: 'fa-envelope-open-text',
        colour: 'red',
        blurb: 'Members DM the bot to open a private staff thread',
        commands: [],
        storage: { kind: 'table', table: 'modmail_config', key: 'guild_id' },
        fields: [
            { key: 'enabled', label: 'Enabled', type: 'toggle', default: 0 },
            { key: 'category_id', label: 'Thread category', type: 'channel', channelKind: 'category', hint: 'New modmail channels are created in this category.' },
            { key: 'log_channel_id', label: 'Log channel', type: 'channel', channelKind: 'text', hint: 'Opened and closed threads are logged here.' },
            { key: 'staff_role_id', label: 'Staff role', type: 'role', hint: 'Can see and answer modmail channels.' },
            { key: 'anonymous_replies', label: 'Anonymous staff replies', type: 'toggle', default: 0,
                hint: 'Members see "<server> Staff" instead of the name of whoever answered.' },
            // Both go into an embed description (core/modmail-manager.js); the placeholders are its defaults.
            { key: 'greeting_message', label: 'Greeting', type: 'message', preview: 'embed', maxLength: 2000,
              placeholder: 'Thank you for contacting the staff team. Please describe your issue.',
              hint: 'Sent to the member when they open a thread.' },
            { key: 'close_message', label: 'Closing message', type: 'message', preview: 'embed', maxLength: 2000,
              placeholder: 'This modmail thread has been closed. Thank you for contacting us.',
              hint: 'Sent to the member when staff close the thread.' },
        ],
    },

    'sticky-roles': {
        label: 'Sticky Roles',
        category: 'Moderation & Security',
        icon: 'fa-thumbtack',
        colour: 'blue',
        blurb: 'Members who leave and rejoin get their roles back',
        commands: [],
        // The switch already lived on `guilds`; migration 281 added the other two columns beside it.
        storage: { kind: 'table', table: 'guilds', key: 'guild_id' },
        note: 'Never given back: @everyone, roles managed by an integration (boosts, bots) and roles at or above the bot\'s highest role. Each restore is logged under "Sticky role updates" on the Logging page.',
        fields: [
            { key: 'sticky_roles_enabled', label: 'Give roles back on rejoin', type: 'toggle', default: 0 },
            { key: 'sticky_roles_retention_days', label: 'Remember roles for (days)', type: 'number', min: 1, max: 365, default: 30,
                hint: 'Someone who stays away longer than this rejoins with no saved roles.' },
            { key: 'sticky_roles_exclude', label: 'Never give back these roles', type: 'roles',
                hint: 'For example a "new member" role, or staff roles you would rather give back by hand.' },
        ],
    },

    cah: {
        label: 'Cards Against Humanity',
        category: 'Economy & Games',
        icon: 'fa-clone',
        colour: 'yellow',
        blurb: 'Game defaults and content rules',
        commands: ['/cah'],
        storage: { kind: 'table', table: 'cah_guild_config', key: 'guild_id' },
        fields: [
            // Defaults and ranges are core/cah-manager.js getGuildConfig/DEFAULT_SETTINGS and the /cah start
            // and /cah config set options (the same as the website's CAH settings page, dashboard/routes/cah.js).
            { key: 'nsfw_allowed', label: 'Allow NSFW cards', type: 'toggle', default: 0,
              hint: 'Lets a host include NSFW decks when they start a game. Off by default.' },
            { key: 'blank_cards_allowed', label: 'Allow blank cards', type: 'toggle', default: 1,
              hint: 'Write-your-own cards a host can mix into the deck.' },
            { key: 'max_blank_cards', label: 'Blank cards per game', type: 'number', min: 0, max: 50, default: 5,
              hint: 'The most blank cards a host may add to one game.' },
            { key: 'allow_public_imports', label: 'Members can import CrCast decks', type: 'toggle', default: 1,
              hint: 'With /cah decks add. Members with Manage Server can always import.' },
            { key: 'default_points', label: 'Points to win', type: 'number', min: 3, max: 30, default: 7,
              hint: 'Used by /cah start when the host does not set it.' },
            { key: 'default_max_rounds', label: 'Maximum rounds', type: 'number', min: 3, max: 50, default: 20,
              hint: 'After this many rounds the highest score wins. Used by /cah start when the host does not set it.' },
            { key: 'default_timeout_secs', label: 'Turn timer (seconds)', type: 'number', min: 30, max: 600, default: 90,
              hint: 'How long players have each round while the turn timer is on. Used by /cah start when the host does not set it.' },
        ],
    },

    fourthwall: {
        label: 'Fourthwall Shop',
        category: 'Streaming & Content',
        icon: 'fa-store',
        colour: 'green',
        blurb: 'Order and shop notifications',
        commands: ['/fourthwall'],
        storage: { kind: 'table', table: 'fourthwall_guild_config', key: 'guild_id' },
        fields: [
            { key: 'default_channel_id', label: 'Notification channel', type: 'channel' },
            { key: 'show_customer_names', label: 'Show customer names', type: 'toggle', default: 0 },
            { key: 'show_amounts', label: 'Show order amounts', type: 'toggle', default: 1 },
            { key: 'embed_color', label: 'Embed colour', type: 'color' },
        ],
    },

    'ai-dj': {
        label: 'AI DJ',
        category: 'Community',
        icon: 'fa-headphones',
        colour: 'purple',
        blurb: 'AI-curated music with a voice DJ between tracks',
        commands: ['/music dj'],
        storage: { kind: 'table', table: 'ai_dj_config', key: 'guild_id' },
        fields: [
            { key: 'enabled', label: 'AI DJ', type: 'toggle', default: 0,
              hint: 'The same switch as the AI DJ switch on the Music page. Music must be on too, and the DJ role and music channels set there apply to /music dj.' },
            { key: 'voice_channel_id', label: 'Voice channel', type: 'channel', channelKind: 'voice', hint: 'Used when the person starting the DJ is not in a voice channel.' },
            { key: 'mood', label: 'Mood', type: 'text', placeholder: 'chill', hint: 'Such as chill, hype or focus.' },
            { key: 'activity_type', label: 'Activity', type: 'text', placeholder: 'gaming', hint: 'Such as gaming, studying or a party.' },
            { key: 'genres', label: 'Genres', type: 'text', hint: 'Comma-separated.' },
            { key: 'artists', label: 'Seed artists', type: 'text', hint: 'Comma-separated.' },
            { key: 'songs', label: 'Seed songs', type: 'text', hint: 'Comma-separated.' },
            { key: 'year_range_start', label: 'Earliest year', type: 'number', min: 1900, max: 2100 },
            { key: 'year_range_end', label: 'Latest year', type: 'number', min: 1900, max: 2100 },
            { key: 'ai_prompt', label: 'Extra instructions for the DJ', type: 'multiline' },
            { key: 'randomness_level', label: 'Randomness', type: 'number', min: 0, max: 10, default: 5,
              hint: '0 sticks closely to the seeds above; 10 strays furthest from them.' },
            { key: 'volume', label: 'Volume (%)', type: 'number', min: 1, max: 100, default: 50 },
            { key: 'filter_explicit', label: 'Skip explicit tracks', type: 'toggle', default: 0, hint: 'The DJ is asked for clean songs only; tracks are not checked one by one.' },
            { key: 'announce_songs', label: 'Announce each track', type: 'toggle', default: 1, hint: 'Posts one line for each song the AI DJ plays.' },
            { key: 'announcement_channel_id', label: 'Announcement channel', type: 'channel', channelKind: 'text',
              showIf: { announce_songs: true }, hint: 'Where each track is announced. Leave empty to post in the channel /music dj was used in.' },
        ],
    },

    'voice-recording': {
        label: 'Voice recording', category: 'Community', icon: 'fa-microphone', colour: 'red',
        blurb: 'Staff record their voice channel with /music record; everyone in it is told',
        commands: ['/music record', '/music settings recording'],
        storage: { kind: 'table', table: 'record_config', key: 'guild_id' },
        fields: [
            { key: 'is_enabled', label: 'Allow voice recording', type: 'toggle', default: 0 },
            { key: 'allowed_role_ids', label: 'Roles that may record', type: 'roles', hint: 'Members with Manage Server can always record.' },
            { key: 'output_channel_id', label: 'Post recordings to', type: 'channel', channelKind: 'text', hint: 'Leave empty to post in the channel the recording was started from.' },
            { key: 'max_minutes', label: 'Longest recording (minutes)', type: 'number', min: 1, max: 120, default: 30, hint: 'Also cut to fit Discord\'s upload limit, about 37 minutes without server boosts.' },
        ],
    },

    'automod-spam': {
        label: 'Spam limits',
        category: 'Moderation & Security',
        icon: 'fa-gauge-high',
        colour: 'red',
        blurb: 'Message rate, mention, emoji and repeat-character limits',
        // No command: /protection spam sets up the adaptive spam check on the Raid lockdown page, not these limits.
        commands: [],
        note: 'Administrators, the server owner, and the roles and channels any AutoMod rule ignores are never checked. Sending the same message more than 3 times within the time window also counts as spam.',
        storage: { kind: 'table', table: 'automod_spam_config', key: 'guild_id' },
        fields: [
            { key: 'enabled', label: 'Spam limits', type: 'toggle', default: 0,
              hint: 'Check every message against the limits below.' },
            { key: 'max_messages', label: 'Most messages in the time window', type: 'number', min: 1, max: 100, default: 5,
              hint: 'Sending more than this within the window below counts as spam.' },
            { key: 'time_window', label: 'Time window (seconds)', type: 'number', min: 1, max: 600, default: 10 },
            { key: 'max_mentions', label: 'Most mentions in one message', type: 'number', min: 1, max: 100, default: 5,
              hint: 'Mentions of members. Role, @everyone and @here mentions are not counted.' },
            { key: 'max_emojis', label: 'Most emoji in a row', type: 'number', min: 1, max: 200, default: 15,
              hint: 'A longer run of emoji, or a message that is mostly emoji, counts as spam. Emoji spread through a message do not.' },
            { key: 'max_repeated_chars', label: 'Most repeats of one character', type: 'number', min: 2, max: 200, default: 10,
              hint: 'For example "aaaaaaaaaaaa" or "!!!!!!!!!!!!".' },
            { key: 'action', label: 'What happens', type: 'select', default: 'warn',
              hint: 'The message is always deleted. Warn posts a short notice in the channel for 5 seconds and is not recorded as a warning. A timeout lasts 10 minutes.',
              options: [{ value: 'warn', label: 'Delete and warn' }, { value: 'mute', label: 'Delete and time out' }, { value: 'kick', label: 'Delete and kick' }] },
        ],
    },

    // Invite creation rules. Read on every new invite by events/inviteCreate.js; no command.
    // staff_only is not read by anything and verified_role_id is only a fallback for rows whose
    // allowed_roles is NULL (saving here always writes allowed_roles), so neither is shown.
    'invite-policy': {
        label: 'Invite link rules',
        category: 'Moderation & Security',
        icon: 'fa-envelope-open-text',
        colour: 'red',
        blurb: 'Only allow single-use invite links that expire',
        commands: [],
        note: 'Checked each time someone creates an invite. Single-use invites that expire within the limit are kept. Any other invite is deleted: staff (Manage Server, Manage Messages or Administrator) and the roles below get a single-use replacement by DM, and everyone else gets a DM saying why. Invites made by bots are deleted with no DM. Invites made before this was switched on are not checked.',
        storage: { kind: 'table', table: 'invite_policy', key: 'guild_id' },
        fields: [
            { key: 'single_use_only', label: 'Enforce single-use invites', type: 'toggle', default: 0,
              hint: 'Off: invites are only logged.' },
            { key: 'max_age_seconds', label: 'Longest an invite may last', type: 'select', default: '604800',
              hint: 'Invites set to last longer, or to never expire, count as breaking the rule. Also the expiry given to replacement invites.',
              options: [
                  { value: '1800', label: '30 minutes' },
                  { value: '3600', label: '1 hour' },
                  { value: '21600', label: '6 hours' },
                  { value: '43200', label: '12 hours' },
                  { value: '86400', label: '1 day' },
                  { value: '604800', label: '7 days' },
              ] },
            { key: 'allowed_roles', label: 'Roles that get a replacement', type: 'roles',
              hint: 'Members with any of these roles get a replacement link by DM when their invite breaks the rule. Staff always do. Leave empty for staff only.' },
        ],
    },

    // Deleted-image evidence (migration 285). Read directly by core/evidence-capture.js.
    'message-evidence': {
        label: 'Deleted-image evidence',
        category: 'Analytics & Logging',
        icon: 'fa-images',
        colour: 'red',
        blurb: 'Images from deleted messages, re-posted where staff can see them',
        commands: [],
        note: 'When a message with images is deleted, the images are re-uploaded to the evidence channel and linked from the message-delete log, so the evidence survives Discord removing the originals. To make that possible, images are copied privately when posted and kept for up to 72 hours unless the message is deleted. Members who used /privacy opt-out are never captured. Needs either an evidence channel below or message-delete logging set up on the Logging page.',
        storage: { kind: 'table', table: 'logging_config', key: 'guild_id' },
        fields: [
            { key: 'evidence_capture_enabled', label: 'Keep images from deleted messages', type: 'toggle', default: 0,
              hint: 'Members who used /privacy opt-out are never copied.' },
            { key: 'evidence_channel_id', label: 'Evidence channel', type: 'channel', channelKind: 'text',
              hint: 'A staff-only channel. Leave empty to post evidence in the message-delete log channel.' },
            { key: 'evidence_max_mb', label: 'Largest image to keep (MB)', type: 'number', min: 1, max: 25, default: 8,
              hint: 'Larger images are listed in the log but not copied. Discord allows 10 MB uploads unless the server is boosted.' },
        ],
    },

    // Per-server log retention (migration 288). Enforced nightly by jobs/retention-sweeper.js.
    'log-retention': {
        label: 'Log retention',
        category: 'Analytics & Logging',
        icon: 'fa-clock-rotate-left',
        colour: 'teal',
        blurb: 'Bot-wide: cached messages 90 days, moderation logs 365 days',
        commands: [],
        note: 'The bot already deletes cached messages after 90 days and moderation/audit logs after 365 days. Set a shorter window here and the nightly clean-up removes this server\'s older rows. A value at or above the bot-wide limit changes nothing; leave a field empty to use the bot-wide window. Deleted rows cannot be recovered.',
        storage: { kind: 'table', table: 'log_retention_policy', key: 'guild_id' },
        fields: [
            { key: 'message_logs_days', label: 'Keep cached messages for (days)', type: 'number', min: 1, max: 365,
              hint: 'The copies used to show deleted and edited message content and images in your logs. Leave empty for 90 days.' },
            { key: 'audit_logs_days', label: 'Keep moderation and audit logs for (days)', type: 'number', min: 1, max: 365,
              hint: 'Moderation actions and server audit entries the bot recorded. Leave empty for 365 days.' },
        ],
    },

    'automod-heat': {
        label: 'AutoMod heat',
        category: 'Moderation & Security',
        icon: 'fa-temperature-arrow-up',
        colour: 'red',
        blurb: 'Accumulating infraction score that decays over time',
        commands: [],
        note: 'AutoMod rules set to Delete, Warn or Mute add heat instead of acting straight away: the message stays up until a threshold is reached. When a member\'s heat reaches a threshold, that action is taken and their heat starts again from zero. Kick and Ban rules always act at once, and Message spam rules are not affected. With no thresholds saved, heat builds up but nothing happens.',
        storage: { kind: 'table', table: 'automod_heat_config', key: 'guild_id' },
        fields: [
            { key: 'is_enabled', label: 'Heat scoring', type: 'toggle', default: 0 },
            { key: 'decay_minutes', label: 'A violation counts for (minutes)', type: 'number', min: 1, max: 10080, default: 60,
              hint: 'After this long a violation no longer adds to the member\'s heat.' },
            { key: 'heat_values', label: 'Heat per violation', type: 'multiline', json: true, default: '{"banned_word":20,"invite":25,"mention":15,"caps":5}',
              hint: 'JSON. Names: banned_word, invite, mention, caps. A violation not listed adds 1. Example: {"banned_word":20,"invite":25,"mention":15,"caps":5}' },
            { key: 'action_thresholds', label: 'Actions and the heat that triggers them', type: 'multiline', json: true, default: '{"warn":25,"mute_10min":50,"kick":100,"ban":150}',
              hint: 'JSON. Actions: warn, mute_<minutes>min, kick, ban. Example: {"warn":25,"mute_10min":50,"kick":100,"ban":150}' },
        ],
    },

    cinema: {
        label: 'Cinema',
        category: 'Community',
        icon: 'fa-clapperboard',
        colour: 'blue',
        blurb: 'Shared movie playback in a voice channel',
        commands: ['/watch'],
        note: 'What a server plays is that server\'s responsibility: show only films and shows you have the right to show to the people in your server. Watch Together streams from the CertiFried film library through certifriedmultitool.com, a few films at a time across all servers. See the Watch Together guide in the docs.',
        storage: { kind: 'table', table: 'cinema_config', key: 'guild_id' },
        fields: [
            { key: 'enabled', label: 'Cinema', type: 'toggle', default: 0, hint: 'Needed for /watch (also typed as /movie): while it is off nothing can be played. The Watch party page has a second switch for the same command.' },
            { key: 'control_role_id', label: 'Playback control role', type: 'role', hint: 'Can control any film playing, not only one they started.' },
            { key: 'default_vc_id', label: 'Default voice channel', type: 'channel', channelKind: 'voice', hint: 'Used when the person starting a film is not in a voice channel.' },
            // Discord Activities (docs/activities.md, migration 467). The 'How films play' choice (watch_mode) is gone: the
            // Go Live stream (the CertiFried-Cinema selfbot) was retired on 2026-11-20 and every server uses Watch Together.
            { key: 'jellyfin_library_id', label: 'Library', type: 'select', get options() { return jellyfinLibraryOptions(); },
              hint: 'Which library this server watches from. Every video library is the whole collection.' },
        ],
    },

    marketplace: {
        label: 'Marketplace Guards',
        category: 'Economy & Games',
        icon: 'fa-shop',
        colour: 'green',
        blurb: 'Removes posts from new accounts in marketplace channels',
        commands: [],
        note: 'Read by events/marketplaceFilter.js. It checks messages in channels whose name contains marketplace, market, trading, buy-sell, for-sale, wtb, wts or seed-exchange: a post from an account younger than the minimum is deleted and its author is told by DM when they can post. A channel named mod-log or modlog gets a note. On until you turn it off.',
        storage: { kind: 'table', table: 'marketplace_settings', key: 'guild_id' },
        fields: [
            { key: 'account_age_filter', label: 'Require a minimum account age', type: 'toggle', default: 1 },
            { key: 'min_account_age_days', label: 'Minimum account age (days)', type: 'number', min: 0, max: 3650, default: 7,
              hint: '0 lets any account post.' },
            { key: 'trader_role_bypass', label: 'Trusted roles skip the check', type: 'toggle', default: 1,
              hint: 'Members with a role whose name contains trader, trusted, veteran or elite.' },
        ],
    },

    'staff-contact': {
        label: 'Staff contact',
        category: 'Server Tools',
        icon: 'fa-headset',
        colour: 'blue',
        blurb: 'A pinned panel for contacting staff and filing reports',
        commands: [],
        storage: { kind: 'table', table: 'staff_contact_config', key: 'guild_id' },
        fields: [
            { key: 'contact_channel_id', label: 'Contact panel channel', type: 'channel', channelKind: 'text', hint: 'The bot posts and pins the contact panel here when you save.' },
            { key: 'reports_channel_id', label: 'Reports go to', type: 'channel', channelKind: 'text', hint: 'A staff-only channel; each report is posted here.' },
        ],
    },

    'stream-signup': {
        label: 'Stream Signup',
        category: 'Streaming & Content',
        icon: 'fa-tower-broadcast',
        colour: 'purple',
        blurb: 'Members post their stream link to be tracked, once they reach a level',
        commands: [],
        // Read by events/streamSignupTracker.js; the reset pause is jobs/leveling-monthly-reset.js.
        note: 'A member posts a Twitch, Kick, YouTube or TikTok link in the signup channel; the bot checks their level and adds them as a streamer announced in the channel below. Other messages in the signup channel are deleted. If leveling resets are on, each reset also pauses the signed-up streamers below the level until they reach it again.',
        storage: { kind: 'table', table: 'stream_signup_config', key: 'guild_id' },
        fields: [
            { key: 'stream_signup_channel_id', label: 'Signup channel', type: 'channel',
              hint: 'Members post their stream link here to sign up.' },
            { key: 'stream_announcement_channel_id', label: 'Announce their streams in', type: 'channel',
              hint: 'Where signed-up streamers are announced when they go live.' },
            { key: 'level_gate', label: 'Minimum level to sign up', type: 'number', min: 0, max: 200, default: 0,
              hint: 'Members below this level are told to keep chatting first. 0 lets anyone sign up.' },
        ],
    },

    tts: {
        label: 'Text to speech',
        category: 'Community',
        icon: 'fa-comment-dots',
        colour: 'blue',
        blurb: 'Read messages aloud in voice',
        commands: ['/tools tts speak'],
        note: 'Changes apply to /tools tts speak within a minute of saving. A server that never saved this page has text to speech on, with no length limit and no wait.',
        storage: { kind: 'table', table: 'tts_config', key: 'guild_id' },
        fields: [
            // Defaults are what core/tts-config.js uses for a server with no tts_config row.
            { key: 'enabled', label: 'Text to speech', type: 'toggle', default: 1, hint: 'Members can use /tools tts speak.' },
            { key: 'default_voice', label: 'Default voice', type: 'voice',
              hint: 'Used when a member has not picked a voice. Blank uses Ryan (Piper). Kokoro voices sound more natural and take a moment longer to start.' },
            { key: 'max_length', label: 'Maximum characters', type: 'number', min: 0, max: 2000, default: 0, hint: '0 for no limit.' },
            { key: 'cooldown_seconds', label: 'Wait between messages (seconds)', type: 'number', min: 0, max: 600, default: 0, hint: 'Per member. 0 for none.' },
            { key: 'allowed_channels', label: 'Only in these channels', type: 'channels', hint: 'Where the command can be used. Leave empty for anywhere.' },
            { key: 'blocked_channels', label: 'Never in these channels', type: 'channels' },
            { key: 'allowed_roles', label: 'Only for these roles', type: 'roles', hint: 'Leave empty for everyone.' },
            { key: 'blocked_roles', label: 'Never for these roles', type: 'roles' },
        ],
    },

    'voice-reader': {
        label: 'Voice chat reader',
        category: 'Community',
        icon: 'fa-volume-high',
        colour: 'blue',
        blurb: 'Read a text channel aloud in voice',
        commands: ['/voice reader enable', '/voice reader disable', '/voice reader skip', '/voice reader my-voice', '/voice reader my-name', '/voice disconnect'],
        note: 'Changes apply within a minute. With no channels listed, each voice channel\'s built-in chat is read into that voice channel. The reader stays quiet while music is playing, and never reads members who used /voice privacy opt-out.',
        storage: { kind: 'table', table: 'voice_reader_config', key: 'guild_id' },
        fields: [
            { key: 'enabled', label: 'Voice chat reader', type: 'toggle', default: 0 },
            { key: 'text_channels', label: 'Channels to read', type: 'channels',
              hint: 'Leave empty to read each voice channel\'s own chat into that voice channel.' },
            { key: 'voice_channel_id', label: 'Voice channel to speak in', type: 'channel', channelKind: 'voice',
              hint: 'Used when "Follow the author" is off, or the author is not in voice.' },
            { key: 'follow_author', label: 'Follow the author', type: 'toggle', default: 1,
              hint: 'Speak in whichever voice channel the author is sitting in.' },
            { key: 'require_in_voice', label: 'Author must be in that voice channel', type: 'toggle', default: 1,
              hint: 'Stops people outside a room from talking into it.' },
            { key: 'voice', label: 'Voice', type: 'voice', hint: 'Blank uses the Text to speech default. Members can still pick their own with /voice reader my-voice.' },
            { key: 'read_names', label: 'Say who wrote it', type: 'toggle', default: 1 },
            { key: 'skip_links', label: 'Say "a link" instead of reading URLs', type: 'toggle', default: 1 },
            { key: 'reactions', label: 'Show what is being read', type: 'toggle', default: 1,
              hint: 'Reacts with 🗣️ while a message is read and 🙊 when it is done. Needs Add Reactions in the channels being read.' },
            { key: 'max_length', label: 'Maximum characters read', type: 'number', min: 40, max: 1000, default: 600,
              hint: 'Longer messages stop at the end of a sentence, never mid-word.' },
            { key: 'allowed_roles', label: 'Only read these roles', type: 'roles', hint: 'Leave empty to read everyone.' },
        ],
    },

    'voice-transcription': {
        label: 'Voice transcription',
        category: 'Community',
        icon: 'fa-closed-captioning',
        colour: 'blue',
        blurb: 'Live captions and transcripts of voice channels',
        commands: ['/voice transcribe start', '/voice transcribe stop', '/voice privacy opt-out'],
        note: 'Speech-to-text runs on this server (Whisper) — audio is never recorded or stored, only the text. Staff start each session by hand; everyone in the channel is notified, and members can opt out with /voice privacy opt-out.',
        storage: { kind: 'table', table: 'voice_transcription_config', key: 'guild_id' },
        fields: [
            { key: 'enabled', label: 'Allow transcription in this server', type: 'toggle', default: 1 },
            { key: 'caption_channel_id', label: 'Live caption channel', type: 'channel', channelKind: 'text',
              hint: 'Leave empty to post captions where the start command was used.' },
            { key: 'live_captions', label: 'Post live captions', type: 'toggle', default: 1 },
            { key: 'caption_style', label: 'Caption style', type: 'select', default: 'webhook',
              options: [
                  { value: 'webhook', label: 'As the speaker — their name and avatar, one message per phrase' },
                  { value: 'compact', label: 'Compact — the bot posts "Name: text" lines in batches' },
              ],
              hint: 'Speaker style needs Manage Webhooks in the caption channel; without it captions fall back to compact.' },
            { key: 'skip_filler', label: 'Leave "mm-hmm", "yeah", "okay" out of live captions', type: 'toggle', default: 1,
              hint: 'They are still kept in the full transcript.' },
            { key: 'post_transcript', label: 'Post the transcript when a session ends', type: 'toggle', default: 1 },
            { key: 'transcript_channel_id', label: 'Transcript channel', type: 'channel', channelKind: 'text',
              showIf: { post_transcript: true }, hint: 'Leave empty to use the caption channel.' },
            { key: 'model', label: 'Speech model', type: 'select', default: 'fast',
              options: [
                  { value: 'fast', label: 'Fast — captions in about a second' },
                  { value: 'accurate', label: 'Accurate — better with names, a few seconds behind' },
              ] },
            { key: 'starter_role_id', label: 'Role that may start sessions', type: 'role',
              hint: 'Members with Manage Server can always start one.' },
            { key: 'retention_days', label: 'Keep transcripts for (days)', type: 'number', min: 1, max: 365, default: 30 },
        ],
        list: {
            table: 'voice_transcription_sessions',
            title: 'Recent sessions',
            columns: ['id', 'voice_channel_id', 'starter_user_id', 'started_at', 'ended_at', 'end_reason', 'segment_count'],
            labels: ['#', 'Voice channel', 'Started by', 'Started', 'Ended', 'Why it ended', 'Phrases'],
        },
    },

    // ── Features that had no config table at all (stored in guild_feature_config) ───────

    grow: {
        label: 'Grow Toolkit',
        category: 'Community',
        icon: 'fa-seedling',
        colour: 'green',
        blurb: 'Calculators, strain database, journals, timers and competitions',
        commands: ['/grow'],
        // guildScoped: the main bot registers /grow only for guild_scoped_commands rows.
        note: 'On the main bot, /grow is only registered in servers on the bot owner\'s per-server list, because it is kept out of the App Directory.',
        storage: { kind: 'managed', feature: 'grow' },
        fields: [
            { key: 'enabled', label: 'Enabled', type: 'toggle', default: true },
            { key: 'require_age_gate', label: 'Require an 18+ role', type: 'toggle', default: false },
            { key: 'age_role_id', label: '18+ role', type: 'role' },
            { key: 'allowed_channels', label: 'Restrict to channels', type: 'channels', hint: 'Leave empty to allow anywhere.' },
            { key: 'journal_channel_id', label: 'Journal posts channel', type: 'channel', channelKind: 'text',
              hint: 'Updates from public journals (a new journal, daily logs, milestones, the harvest) are copied here. Private journals are never posted.' },
            { key: 'competition_channel_id', label: 'Competition announcements', type: 'channel', channelKind: 'text',
              hint: 'New competitions and their results are posted here. Leave empty to post where the command is used.' },
            { key: 'reminder_dm', label: 'Send reminders by DM', type: 'toggle', default: true,
              hint: 'On: /grow reminder sends by DM unless the member picks the channel. Off: reminders are posted in the channel they were set in.' },
            { key: 'public_journals_default', label: 'New journals are public by default', type: 'toggle', default: false,
              hint: 'Members can still change each journal with /grow journal privacy.' },
        ],
    },

    windrose: {
        label: 'Windrose Server',
        category: 'Community',
        icon: 'fa-compass',
        colour: 'orange',
        blurb: 'Status, join info and admin controls for the CertiFried Windrose game server',
        commands: ['/windrose'],
        storage: { kind: 'managed', feature: 'windrose' },
        fields: [
            // Default OFF, unlike most features here. /windrose talks to one
            // specific game server; in every other guild the bot is in, the
            // command is noise at best. A server owner opts in from their
            // feature page rather than discovering it already live.
            { key: 'enabled', label: 'Enabled', type: 'toggle', default: false,
              hint: 'Off by default — this command controls one specific game server.' },
            { key: 'allowed_channels', label: 'Restrict to channels', type: 'channels',
              hint: 'Leave empty to allow anywhere.' },
            { key: 'announce_channel_id', label: 'Announcements channel', type: 'channel',
              hint: 'Where restart warnings and status changes are posted.' },
        ],
    },

    cannabis: {
        label: 'Cannabis Community',
        category: 'Community',
        icon: 'fa-cannabis',
        colour: 'green',
        blurb: 'Smoke circles, tokes, strains, trivia and stats',
        commands: ['/cannabis', '/smokecircle', '/puff', '/pass', '/cheers', '/dailyjoint'],
        // guildScoped commands: the main bot registers them only for guild_scoped_commands rows
        // (scripts/deploy-guild-scoped-commands.js); typed as messages they follow the same rule (H-711).
        note: '/cannabis is typed as a message. On the main bot, /cannabis, /smokecircle, /puff, /pass, /cheers and /dailyjoint only work in servers on the bot owner\'s per-server list, because they are kept out of the App Directory. Custom bots have them in every server they serve.',
        storage: { kind: 'managed', feature: 'cannabis' },
        fields: [
            { key: 'enabled', label: 'Enabled', type: 'toggle', default: true },
            { key: 'require_age_gate', label: 'Require an 18+/21+ role', type: 'toggle', default: false },
            { key: 'age_role_id', label: 'Age-verified role', type: 'role' },
            { key: 'allowed_channels', label: 'Restrict to channels', type: 'channels' },
            { key: 'circle_channel_id', label: 'Smoke circle channel', type: 'channel', channelKind: 'text',
              hint: 'Smoke circles can only be started here. Leave empty to allow any channel.' },
            { key: 'circle_max_players', label: 'Maximum people per circle', type: 'number', min: 2, max: 50, default: 20,
              hint: 'Nobody else can join once a circle has this many people.' },
            { key: 'circle_turn_seconds', label: 'Seconds per turn', type: 'number', min: 10, max: 600, default: 120,
              hint: 'If the person holding it does not /puff or /pass in time, it moves to the next person. A whole round with nobody puffing ends the circle.' },
            { key: 'daily_reset_hour', label: 'Daily reset hour (0-23)', type: 'number', min: 0, max: 23, default: 0,
              hint: "When /dailyjoint can be claimed again and toke streak days roll over, in the server's timezone (UTC if none is set)." },
            { key: 'leaderboard_channel_id', label: 'Leaderboard channel', type: 'channel', channelKind: 'text',
              hint: 'One toke leaderboard is kept here and updated every 10 minutes when the standings change.' },
        ],
    },

    fun: {
        label: 'Fun & Party Games',
        category: 'Economy & Games',
        icon: 'fa-face-laugh',
        colour: 'yellow',
        blurb: 'Jokes, memes, insults, trivia, tarot, icebreakers and random generators',
        // Only /fun confess is a slash command; the rest are typed as text under their own names
        // (/joke, /meme, /insult, /owoify, /luck: core/command-registration.js TEXT_ALIASES).
        commands: ['/fun', '/owoify', '/luck'],
        storage: { kind: 'managed', feature: 'fun' },
        fields: [
            { key: 'enabled', label: 'Enabled', type: 'toggle', default: true },
            { key: 'allowed_channels', label: 'Restrict to channels', type: 'channels' },
            { key: 'nsfw_allowed', label: 'Allow adult content', type: 'toggle', default: false,
              hint: 'Lets /meme show posts Reddit marks as NSFW, and only in age-restricted channels. Truth or dare and never have I ever have no adult prompts either way.' },
            { key: 'cooldown_seconds', label: 'Cooldown per user (seconds)', type: 'number', min: 0, max: 600, default: 3,
              hint: 'How long a member waits between fun commands (/joke, /meme and the rest). 0 turns it off.' },
            { key: 'disabled_groups', label: 'Disabled sections', type: 'text', maxLength: 200, placeholder: 'astrology, quotes',
              hint: 'Separated by commas. Any of: games, animals, astrology, creative, partygames, quotes, random, icebreakers, jokes. The single commands that repeat a section (meme, fact, 8ball, would you rather) follow it.' },
            // /fun insult (commands/fun/fun-insult-handler.js). Off until a server opts in: a roast
            // command is not something to switch on for a community without asking.
            { key: 'insults_enabled', label: 'Allow /insult', type: 'toggle', default: false,
              hint: "Off by default. Members can roast each other with playful insults; every line is checked against a built-in slur list and this server's automod banned words, and re-rolled if it hits." },
            // Where /fun insult lines come from (core/evil-insults.js for 'evilinsult'). Built-in stays the default.
            { key: 'insult_source', label: 'Insult source', type: 'select', default: 'builtin',
              options: [
                  { value: 'builtin', label: 'Built-in (playful)' },
                  { value: 'evilinsult', label: "Evil Insult (crude, from evilinsult.com's open database)" },
              ],
              hint: "Heads up: the Evil Insult set is crude and includes sexual jokes and swearing. Lines come from our own copy of evilinsult.com's public-domain database (their site is never contacted), do not repeat within this server's last 50, and pass the same slur list and banned-word filter; if several lines in a row are filtered, a built-in line is used instead." },
            { key: 'insult_language', label: 'Evil Insult language', type: 'select', default: 'en',
              options: EVIL_INSULT_LANGUAGES.map(l => ({ value: l.code, label: l.name })),
              hint: 'Default language for Evil Insult lines. Members can pick another with the language option on /insult. The built-in insults are English only.' },
        ],
    },

    wordgames: {
        label: 'Word Games',
        category: 'Economy & Games',
        icon: 'fa-spell-check',
        colour: 'yellow',
        blurb: 'Last Letter, Story Chain, Coordle and Word Seek',
        commands: ['/wordgame'],
        storage: { kind: 'managed', feature: 'wordgames' },
        list: {
            table: 'word_game_channels',
            title: 'Configured channels',
            columns: ['channel_id', 'game_type', 'enabled'],
            labels: ['Channel', 'Game', 'Enabled'],
        },
        fields: [
            { key: 'enabled', label: 'Enabled', type: 'toggle', default: true },
            { key: 'announce_channel_id', label: 'Announce results in', type: 'channel', channelKind: 'text',
              hint: 'Each finished game is posted here: a solved or failed Coordle, a completed WordSeek grid, and any game ended with /wordgame ... end or disable.' },
            { key: 'leaderboard_role_id', label: 'Award role to the leader', type: 'role',
              hint: "Given to whoever is first on each game's /wordgame leaderboard (one person per game) and moved when first place changes. The role must be below the bot's highest role." },
            { key: 'wordseek_hint_after', label: 'WordSeek: hint after this many wrong guesses', type: 'number', min: 0, max: 100, default: 8,
              hint: 'Counts real words that aren\'t in the grid; resets when a hidden word is found. Hints get stronger each time — first letter, then two letters, then where the word starts. 0 turns hints off.' },
        ],
    },

    fishing: {
        label: 'Fishing',
        category: 'Economy & Games',
        icon: 'fa-fish',
        colour: 'blue',
        blurb: 'Catching, gear, aquarium and tournaments',
        commands: ['/fish'],
        storage: { kind: 'managed', feature: 'fishing' },
        fields: [
            { key: 'enabled', label: 'Enabled', type: 'toggle', default: true },
            { key: 'allowed_channels', label: 'Restrict to channels', type: 'channels' },
            { key: 'tournament_channel_id', label: 'Tournament announcements', type: 'channel', channelKind: 'text', hint: 'Where tournament starts and results are posted. Empty = the channel the tournament is started in.' },
            { key: 'tournament_role_id', label: 'Ping role for tournaments', type: 'role', hint: 'Pinged when a tournament starts.' },
            { key: 'cooldown_seconds', label: 'Seconds between casts', type: 'number', min: 0, max: 600, default: 3,
              hint: 'Per member. A pet that shortens the wait takes its cut off this; never under 0.8 seconds.' },
        ],
        note: 'Balances, gear and the bestiary are global per user by design — a catch follows the player across every server. Only the per-server settings above are configurable here.',
    },

    selfcare: {
        label: 'Self-Care',
        category: 'Community',
        icon: 'fa-heart-pulse',
        colour: 'green',
        blurb: 'Habits, challenges, mood tracking, breathing and tasks',
        // Only the mood tracker (/selfcare wellness mood, moodstats) is a slash command; the rest are
        // typed as text: /habit, /challenges, /wellness, /tasks (core/command-registration.js).
        commands: ['/selfcare', '/habit', '/challenges', '/wellness', '/tasks'],
        storage: { kind: 'managed', feature: 'selfcare' },
        fields: [
            { key: 'enabled', label: 'Enabled', type: 'toggle', default: true },
            { key: 'allowed_channels', label: 'Restrict to channels', type: 'channels' },
            { key: 'private_by_default', label: 'Replies are private by default', type: 'toggle', default: true,
              hint: 'On: replies are shown only to the member who used the command. The slash commands (/selfcare wellness mood and moodstats) reply privately; typed commands such as /habit and /tasks send the reply by DM and say so in the channel. Off: progress and streaks are posted in the channel, settings changes stay private.' },
            { key: 'daily_challenge_channel_id', label: 'Daily challenge channel', type: 'channel', channelKind: 'text',
              hint: "Each day at midnight UTC, when new challenges are handed out, a notice with the previous day's top finishers is posted here." },
            { key: 'reminder_dm', label: 'Send habit reminders by DM', type: 'toggle', default: true,
              hint: 'At 20:00 UTC, four hours before the day ends, members get one DM listing habits they kept up this week but have not done today.' },
        ],
    },

    knowledge: {
        label: 'Knowledge and lookups',
        category: 'Server Tools',
        icon: 'fa-book-open',
        colour: 'blue',
        blurb: 'Facts, NASA, dictionary, crypto, GitHub, recipes and jokes',
        // Only /knowledge is gated by this page (COMMAND_FEATURE_MAP). /lookup is /user profile info; /media is not covered.
        commands: ['/knowledge'],
        storage: { kind: 'managed', feature: 'knowledge' },
        fields: [
            { key: 'enabled', label: 'Knowledge and lookups', type: 'toggle', default: true },
            { key: 'allowed_channels', label: 'Only in these channels', type: 'channels', hint: 'Leave empty to allow them anywhere.' },
            { key: 'disabled_groups', label: 'Turned-off sections', type: 'text', maxLength: 200, placeholder: 'urban, crypto',
              hint: 'Separated by commas. Any of: facts, knowledge, nasa, fortune, urban, inspire, jokes, crypto, github, recipe.' },
            { key: 'urban_nsfw', label: 'Allow Urban Dictionary', type: 'toggle', default: false,
              hint: 'Its definitions are often explicit. While off, /knowledge urban is refused.' },
        ],
    },

    deals: {
        label: 'Game Deals',
        category: 'Economy & Games',
        icon: 'fa-tags',
        colour: 'yellow',
        blurb: 'Price lookups, historical lows and giveaway search',
        commands: ['/deals'],
        storage: { kind: 'managed', feature: 'deals' },
        fields: [
            { key: 'enabled', label: 'Enabled', type: 'toggle', default: true },
            { key: 'allowed_channels', label: 'Restrict to channels', type: 'channels' },
            { key: 'region', label: 'Price region', type: 'select', default: 'US',
              options: ['US', 'GB', 'DE', 'CA', 'AU', 'BR', 'JP'].map(v => ({ value: v, label: v })) },
        ],
    },

    arcade: {
        label: 'LFG & Music Quiz',
        category: 'Economy & Games',
        icon: 'fa-users-rectangle',
        colour: 'yellow',
        blurb: 'Looking-for-group posts and the music quiz',
        commands: ['/arcade lfg', '/arcade musicquiz'],
        storage: { kind: 'managed', feature: 'arcade' },
        fields: [
            { key: 'lfg_enabled', label: 'LFG enabled', type: 'toggle', default: true },
            { key: 'lfg_channel_id', label: 'LFG channel', type: 'channel', channelKind: 'text', hint: 'New LFG posts go here. Empty = the channel the command is used in.' },
            { key: 'lfg_ping_role_id', label: 'Ping role for new LFG posts', type: 'role', hint: 'Pinged once when a post goes up.' },
            { key: 'lfg_expire_hours', label: 'Auto-close LFG posts after (hours)', type: 'number', min: 1, max: 168, default: 12, hint: 'Closed posts stop taking joins and their buttons are switched off.' },
            { key: 'musicquiz_enabled', label: 'Music quiz enabled', type: 'toggle', default: true },
            { key: 'musicquiz_channel_id', label: 'Music quiz channel', type: 'channel', channelKind: 'text', hint: 'Quizzes run here wherever they are started. Empty = the channel the command is used in.' },
            { key: 'musicquiz_rounds', label: 'Default rounds', type: 'number', min: 1, max: 10, default: 5, hint: 'Used when /arcade musicquiz start is given no number. Up to 10, one song each.' },
        ],
    },

    emojihunt: {
        label: 'Emoji Hunts', category: 'Economy & Games', icon: 'fa-magnifying-glass', colour: 'yellow',
        blurb: 'The bot hides an emoji on recent messages; first to react finds it',
        commands: ['/arcade emojihunt'],
        storage: { kind: 'managed', feature: 'emojihunt' },
        list: { table: 'emoji_hunt_leaderboard', title: 'All-time hunters',
            columns: ['total_points', 'user_id', 'total_finds', 'hunts_completed', 'last_find_at'],
            labels: ['Points', 'Member', 'Finds', 'Hunts', 'Last find'] },
        note: 'Staff start a hunt with /arcade emojihunt start. Automatic hunts need at least one hunt channel. The bot needs View Channel, Read Message History and Add Reactions there.',
        fields: [
            { key: 'enabled', label: 'Enabled', type: 'toggle', default: true },
            { key: 'hunt_channels', label: 'Hide emoji in', type: 'channels', hint: 'Empty = the channel /arcade emojihunt start is run in.' },
            { key: 'announce_channel_id', label: 'Announce hunts in', type: 'channel' },
            { key: 'ping_role_id', label: 'Ping role when a hunt starts', type: 'role' },
            { key: 'default_emoji', label: 'Default emoji', type: 'text', default: '🥚' },
            { key: 'default_count', label: 'Emoji per hunt', type: 'number', min: 1, max: 25, default: 5 },
            { key: 'default_duration_minutes', label: 'Hunt length (minutes)', type: 'number', min: 5, max: 1440, default: 30 },
            { key: 'finders_per_emoji', label: 'Finders per emoji', type: 'number', min: 1, max: 10, default: 1 },
            { key: 'points_per_find', label: 'Hunt points per find', type: 'number', min: 0, max: 10000, default: 10 },
            { key: 'coins_per_find', label: 'Coins per find', type: 'number', min: 0, max: 100000, default: 0 },
            { key: 'xp_per_find', label: 'XP per find', type: 'number', min: 0, max: 10000, default: 0 },
            { key: 'max_message_age_minutes', label: 'Only use messages newer than (minutes)', type: 'number', min: 10, max: 10080, default: 1440 },
            { key: 'remove_unfound', label: 'Remove unfound emoji when a hunt ends', type: 'toggle', default: true },
            { key: 'auto_enabled', label: 'Run hunts automatically', type: 'toggle', default: false },
            { key: 'auto_interval_hours', label: 'Hours between automatic hunts', type: 'number', min: 1, max: 168, default: 24 },
        ],
    },

    communitygoals: {
        label: 'Community Goals', category: 'Community', icon: 'fa-bullseye', colour: 'green',
        blurb: 'Server-wide targets with deadlines, live progress and rewards',
        commands: ['/arcade goals'],
        storage: { kind: 'managed', feature: 'communitygoals' },
        list: { table: 'community_goals', title: 'Goals',
            columns: ['id', 'title', 'goal_type', 'current_value', 'target_value', 'status', 'ends_at'],
            labels: ['#', 'Goal', 'Type', 'Progress', 'Target', 'Status', 'Deadline'] },
        note: 'Goals are created by typing /arcade goals create as a message (/arcade is a text command). Progress comes from message and voice activity the bot already records, or the member/boost count; custom goals are moved with /arcade goals add.',
        fields: [
            { key: 'enabled', label: 'Enabled', type: 'toggle', default: true },
            { key: 'announce_channel_id', label: 'Default progress channel', type: 'channel', channelKind: 'text' },
            { key: 'ping_role_id', label: 'Ping role for new goals', type: 'role' },
            { key: 'milestone_announcements', label: 'Announce 25/50/75%', type: 'toggle', default: true },
        ],
    },

    loyalty: {
        label: 'Loyalty Points', category: 'Economy & Games', icon: 'fa-gem', colour: 'purple',
        blurb: 'Points for being active every day, spent on roles and rewards',
        commands: ['/level loyalty'],
        storage: { kind: 'managed', feature: 'loyalty' },
        list: { table: 'loyalty_rewards', title: 'Rewards on offer',
            columns: ['id', 'name', 'cost', 'reward_type', 'stock', 'enabled'],
            labels: ['#', 'Reward', 'Cost', 'Type', 'Stock', 'Active'] },
        note: 'Points are settled once a day from message and voice activity the bot already tracks (nothing new is recorded). Add rewards with /level loyalty reward-add.',
        fields: [
            { key: 'enabled', label: 'Enabled', type: 'toggle', default: false },
            { key: 'points_name', label: 'What points are called', type: 'text', default: 'loyalty points', maxLength: 40 },
            { key: 'daily_active_points', label: 'Points for an active day', type: 'number', min: 0, max: 10000, default: 10 },
            { key: 'min_daily_messages', label: 'Messages that make a day active', type: 'number', min: 1, max: 1000, default: 3 },
            { key: 'min_voice_minutes', label: '…or voice minutes', type: 'number', min: 1, max: 1440, default: 15 },
            { key: 'voice_minutes_per_point', label: 'Voice minutes per point (0 = none)', type: 'number', min: 0, max: 1440, default: 10 },
            { key: 'max_voice_points_per_day', label: 'Daily cap on voice points', type: 'number', min: 0, max: 10000, default: 30 },
            { key: 'streak_bonus_per_day', label: 'Streak bonus per day in a row', type: 'number', min: 0, max: 1000, default: 2 },
            { key: 'max_streak_bonus', label: 'Streak bonus cap', type: 'number', min: 0, max: 10000, default: 20 },
            { key: 'redemption_log_channel_id', label: 'Log redemptions in', type: 'channel', hint: 'Needed for custom rewards so staff see them.' },
        ],
    },

    tournaments: {
        label: 'Tournaments', category: 'Economy & Games', icon: 'fa-trophy', colour: 'orange',
        blurb: 'Single/double elimination and round-robin brackets with sign-ups',
        commands: ['/tournament'],
        storage: { kind: 'managed', feature: 'tournaments' },
        list: { table: 'tournaments', title: 'Tournaments',
            columns: ['id', 'name', 'bracket_type', 'status', 'winner_id', 'created_at'],
            labels: ['#', 'Name', 'Format', 'Status', 'Winner', 'Created'] },
        note: 'Staff (Manage Server, Manage Events, the organiser role, or whoever created it) run tournaments with /tournament. Players report results and their opponent confirms; unanswered reports are accepted automatically.',
        fields: [
            { key: 'enabled', label: 'Enabled', type: 'toggle', default: true },
            { key: 'default_channel_id', label: 'Default bracket channel', type: 'channel', channelKind: 'text',
                hint: 'Used when /tournament create is given no channel. Empty: the channel the command is typed in.' },
            { key: 'organizer_role_id', label: 'Organiser role', type: 'role', hint: 'Can create and run tournaments without Manage Server or Manage Events.' },
            { key: 'ping_role_id', label: 'Ping role when sign-ups open', type: 'role' },
            { key: 'auto_confirm_hours', label: 'Accept unanswered reports after (hours)', type: 'number', min: 1, max: 168, default: 12 },
        ],
    },

    showcase: {
        label: 'Creator Showcase',
        category: 'Streaming & Content',
        icon: 'fa-photo-film',
        colour: 'purple',
        blurb: 'Share music and video as protected, no-download streams',
        commands: ['/creator showcase'],
        storage: { kind: 'managed', feature: 'showcase' },
        list: {
            table: 'showcase_channels',
            title: 'Showcase channels',
            columns: ['channel_id', 'enabled', 'created_at'],
            labels: ['Channel', 'Enabled', 'Added'],
        },
        // submitter_role_id and max_upload_mb were listed here but nothing reads them (uploads are
        // capped at 250 MB in core/showcase-manager.js); removed so the page only shows what works.
        note: 'Showcase channels are added with /creator showcase add. Audio and video posted in one is converted to a stream that plays on the site but cannot be downloaded.',
        fields: [
            { key: 'enabled', label: 'Enabled', type: 'toggle', default: true,
              hint: 'Off stops the /creator showcase commands in this server. Files posted in a listed showcase channel are still converted.' },
        ],
    },

    colorroles: {
        label: 'Colour Roles & AFK',
        category: 'Community',
        icon: 'fa-palette',
        colour: 'purple',
        blurb: 'Self-service colour roles and AFK status',
        commands: ['/tools colorrole', '/tools afk'],
        storage: { kind: 'managed', feature: 'colorroles' },
        list: {
            table: 'color_roles',
            title: 'Colour roles created',
            columns: ['role_id', 'color_hex', 'created_at'],
            labels: ['Role', 'Colour', 'Created'],
        },
        fields: [
            { key: 'colorrole_enabled', label: 'Let members pick a name colour', type: 'toggle', default: true,
                hint: 'With /tools colorrole set and a hex code. The bot makes or reuses a "Color: #HEX" role.' },
            { key: 'colorrole_min_level', label: 'Level needed to pick a colour', type: 'number', min: 0, max: 200, default: 0,
                hint: '0 lets everyone. Uses levels from the leveling system.' },
            { key: 'colorrole_max_per_guild', label: 'Most colour roles in the server', type: 'number', min: 1, max: 250, default: 50,
                hint: 'Once reached, members can only pick colours that already have a role.' },
            { key: 'afk_enabled', label: 'Let members set an AFK status', type: 'toggle', default: true,
                hint: 'With /tools afk. Anyone who mentions them sees their AFK message.' },
            { key: 'afk_rename', label: 'Add [AFK] to their nickname', type: 'toggle', default: true,
                hint: 'Needs Manage Nicknames. The bot cannot rename the server owner or anyone above its own role.' },
        ],
    },

    bugs: {
        label: 'Bug Reports',
        category: 'Server Tools',
        icon: 'fa-bug',
        colour: 'red',
        blurb: 'Member-submitted bug reports and their triage state',
        commands: ['/utilities bugs', '/engage report bug'],
        storage: { kind: 'managed', feature: 'bugs' },
        list: {
            table: 'bug_reports',
            title: 'Reports',
            columns: ['title', 'username', 'status', 'priority', 'created_at'],
            labels: ['Title', 'Reporter', 'Status', 'Priority', 'Submitted'],
        },
        fields: [
            { key: 'enabled', label: 'Accept bug reports', type: 'toggle', default: true },
            { key: 'report_channel_id', label: 'Post new reports to', type: 'channel', channelKind: 'text', hint: 'Leave empty to keep reports on this page only.' },
            { key: 'triage_role_id', label: 'Role to ping for a new report', type: 'role', hint: 'Leave empty to post without a ping.' },
        ],
    },

    shoutout: {
        label: 'Auto Shoutouts',
        category: 'Streaming & Content',
        icon: 'fa-bullhorn',
        colour: 'blue',
        blurb: 'Automatic shoutouts for streamers and supporters',
        commands: ['/alerts shoutout'],
        storage: { kind: 'managed', feature: 'shoutout' },
        // channel_id, template and cooldown_hours were listed here but nothing reads them. Shoutouts
        // post in the Community support page's shoutout channel (commands/admin/shoutout.js, monthly
        // rotation in core/community-support-manager.js); the message is set per batch with /shoutout add.
        note: 'Shoutouts are posted in the shoutout channel set on the Community support page: the top 10 supporters each month, and streamers added for 30 days with /alerts shoutout add (which also takes the go-live message).',
        fields: [
            { key: 'enabled', label: 'Enabled', type: 'toggle', default: true,
              hint: 'Off stops the /alerts shoutout command in this server.' },
        ],
    },

    sprites: {
        label: 'Fortnite Sprites',
        category: 'Economy & Games',
        icon: 'fa-ghost',
        colour: 'purple',
        blurb: 'Link a Sprite Tracker collection to Discord',
        commands: ['/sprites'],
        storage: { kind: 'managed', feature: 'sprites' },
        fields: [
            { key: 'enabled', label: 'Enabled', type: 'toggle', default: true },
            { key: 'embed_channel_id', label: 'Collection embed channel', type: 'channel', channelKind: 'text', hint: 'Where /sprites embed posts when no channel is picked.' },
            { key: 'allowed_channels', label: 'Restrict commands to channels', type: 'channels' },
        ],
    },

    rankcard: {
        label: 'Rank Cards',
        category: 'Community',
        icon: 'fa-id-card',
        colour: 'purple',
        blurb: 'Defaults and limits for member rank card customisation',
        commands: ['/rankcard'],
        storage: { kind: 'managed', feature: 'rankcard' },
        fields: [
            { key: 'allow_custom', label: 'Members may customise their card', type: 'toggle', default: true,
              hint: "Off: every card uses the server style. Members' own styles are kept for when you turn it back on." },
            { key: 'allow_uploads', label: 'Allow custom background uploads', type: 'toggle', default: true,
              hint: 'Off: members choose from presets and colours only, and uploaded backgrounds show as the default background.' },
            { key: 'min_level_to_customise', label: 'Minimum level to customise', type: 'number', min: 0, max: 200, default: 0,
              hint: 'Members below this level cannot change their card. 0 lets everyone.' },
            { key: 'default_accent', label: 'Default accent colour', type: 'color',
              hint: 'Progress bar and avatar ring colour on cards that members have not recoloured themselves.' },
        ],
    },

    buymeacoffee: {
        label: 'Buy Me a Coffee',
        category: 'Streaming & Content',
        icon: 'fa-mug-hot',
        colour: 'yellow',
        blurb: 'Supporter announcements for linked creators',
        commands: ['/creator buymeacoffee'],
        storage: { kind: 'managed', feature: 'buymeacoffee' },
        // announce_channel_id, supporter_role_id and show_amounts were listed here but nothing reads
        // them: announcements are per creator (bmc_announce, core/buymeacoffee-manager.js), set with
        // /creator buymeacoffee announce, and no supporter role is given.
        note: 'Each creator links their own Buy Me a Coffee account with /creator buymeacoffee link, then picks the channel with /creator buymeacoffee announce. New supporters, memberships and extras are posted there.',
        fields: [
            { key: 'enabled', label: 'Enabled', type: 'toggle', default: true,
              hint: 'Off stops the /creator buymeacoffee commands in this server. Announcements creators already set up keep posting until they run /creator buymeacoffee stop.' },
        ],
    },

    // ── Per-row tables (guild_id is not unique) ─────────────────────────────────────────
    // These cannot use `table` storage: an upsert keyed on guild_id would collapse or
    // duplicate rows. Settings live in guild_feature_config; the rows themselves are shown
    // read-only, since they are created by the commands that own them.

    forums: {
        label: 'Forum channels',
        category: 'Server Tools',
        icon: 'fa-comments',
        colour: 'blue',
        blurb: 'Rules for forums set up with /admin forum',
        commands: ['/admin forum'],
        note: 'Per-forum rules are set with /admin forum setup and applied by core/forum-manager.js when a post is created. The switch below turns the whole feature off without deleting those rules.',
        storage: { kind: 'managed', feature: 'forums' },
        list: {
            table: 'forum_config',
            title: 'Configured forums',
            columns: ['forum_channel_id', 'auto_create_enabled', 'require_tag', 'default_slowmode'],
            labels: ['Forum', 'Auto-create', 'Tag required', 'Slowmode (seconds)'],
        },
        fields: [
            { key: 'enabled', label: 'Forum rules on', type: 'toggle', default: true,
              hint: 'Off stops every forum rule in this server without deleting them.' },
            { key: 'default_auto_archive_hours', label: 'Archive inactive posts after (hours)', type: 'number', min: 1, max: 168, default: 24,
              hint: 'For configured forums that have no archive time of their own. Discord allows 1, 24, 72 or 168 hours; other values are rounded to the nearest.' },
            { key: 'auto_lock_on_archive', label: 'Lock posts when they archive', type: 'toggle', default: false,
              hint: 'Used for a forum set up with /admin forum without the lock-on-archive option. After that each forum keeps its own setting.' },
        ],
    },

    webhooks: {
        label: 'Webhooks',
        category: 'Server Tools',
        icon: 'fa-plug',
        colour: 'teal',
        blurb: 'Lets stream alerts post with the streamer\'s name and avatar',
        commands: [],
        note: 'Stream announcements post through a webhook so they carry the streamer’s name and avatar. Turning creation off makes them post as the bot instead — useful if a channel is at Discord’s 15-webhook-per-channel limit.',
        storage: { kind: 'managed', feature: 'webhooks' },
        list: {
            table: 'webhook_config',
            title: 'Registered webhooks',
            columns: ['webhook_name', 'channel_id', 'webhook_type', 'active', 'last_used'],
            labels: ['Name', 'Channel', 'Type', 'Active', 'Last used'],
        },
        fields: [
            { key: 'allow_creation', label: 'Allow the bot to create webhooks', type: 'toggle', default: true,
              hint: 'Off: posts that would use a new webhook go out as the bot instead. Webhooks already made keep working.' },
        ],
    },

    'context-menus': {
        label: 'Context Menus',
        category: 'Core',
        icon: 'fa-square-caret-down',
        colour: 'purple',
        blurb: 'Right-click actions on users and messages',
        commands: [],
        note: 'These appear under Apps when you right-click a member or a message: User Info, Report Message, Report DM spam, Forward Message, Highlight Message and Reroll Giveaway. The switch below turns all of them on or off in this server. Each menu below can also be turned off on its own, or limited to some roles.',
        storage: { kind: 'managed', feature: 'context-menus' },
        list: {
            table: 'context_menu_config',
            title: 'Menus',
            columns: ['menu_name', 'menu_type', 'enabled'],
            labels: ['Name', 'Target', 'Enabled'],
            // H-703: each menu is edited in place. core/context-menu-config.js updateMenu() writes the row
            // checkAccess reads and clears its cache. Rows are keyed by menu name and created when the page
            // opens, so there is nothing to add.
            key: 'menu_name',
            editor: 'context-menus',
            canAdd: false,
            noun: ['menu', 'menus'],
            saveLabel: 'Save menu',
            meta: { key: 'menu_type', labels: { user: 'On a member', message: 'On a message' } },
            edit: [
                { key: 'enabled', label: 'On', type: 'toggle', hint: 'Off: this menu answers "turned off in this server".' },
                { key: 'permission_roles', label: 'Only these roles', type: 'roles', hint: 'Leave empty for anyone who can use the menu.' },
            ],
        },
        fields: [
            { key: 'enabled', label: 'Right-click actions', type: 'toggle', default: true,
              hint: 'Off: every menu answers "turned off in this server".' },
        ],
    },

    'event-reminders': {
        label: 'Event Reminders',
        category: 'Automation & Scheduling',
        icon: 'fa-bell',
        colour: 'purple',
        blurb: 'DM reminders and start announcements for Discord server events, plus repeating events',
        commands: ['/schedule discord'],
        storage: { kind: 'managed', feature: 'event-reminders' },
        list: {
            table: 'recurring_events',
            title: 'Repeating events',
            columns: ['id', 'template_name', 'next_scheduled', 'active', 'last_error'],
            labels: ['ID', 'Name', 'Latest start', 'Active', 'Last error'],
        },
        fields: [
            { key: 'dm_reminders_enabled', label: 'DM reminders to members who clicked Interested', type: 'toggle', default: false,
                hint: 'Off by default. Members can opt out with the button on the DM or /schedule discord reminders.' },
            { key: 'reminder_minutes', label: 'Remind this many minutes before the start', type: 'number', min: 5, max: 1440, default: 30 },
            { key: 'announce_enabled', label: 'Post in a channel when an event starts', type: 'toggle', default: false },
            { key: 'announce_channel_id', label: 'Start announcement channel', type: 'channel', channelKind: 'text' },
            { key: 'announce_role_id', label: 'Role to ping in start announcements', type: 'role', hint: 'Optional.' },
        ],
        note: 'Repeating events are created with /schedule discord recurring-add; the next event is created automatically when one ends.',
    },

    jellyfin: {
        label: 'Watch party',
        category: 'Community',
        icon: 'fa-film',
        colour: 'blue',
        blurb: 'Stream a Jellyfin library title into voice',
        commands: ['/watch'],
        storage: { kind: 'managed', feature: 'jellyfin' },
        fields: [
            { key: 'enabled', label: 'Watch party', type: 'toggle', default: true, hint: 'Members can use /watch (also typed as /movie). Cinema must be switched on too.' },
            { key: 'voice_channel_id', label: 'Default voice channel', type: 'channel', channelKind: 'voice', hint: 'Used when the person starting one is not in a voice channel.' },
            { key: 'host_role_id', label: 'Only this role can start one', type: 'role', hint: 'Leave empty for everyone. Members with Manage Server can always start one.' },
        ],
    },
};

/** Every feature key, for route validation. */
export const FEATURE_KEYS = Object.keys(FEATURE_SPECS);

/**
 * Which feature gates which command, so `events/interactionCreate.js` can enforce the
 * enable/channel/age-gate settings in one place rather than each command remembering to.
 *
 * Keys are either a bare command name (`grow`) or `command:subgroup` (`arcade:lfg`), matching
 * the same key shape the per-guild command-restriction gate already builds a few lines above
 * the check. A command absent from this map is ungated, which is the correct default: only
 * features that actually declare an enable/channel/age setting appear here.
 *
 * Table-backed features are deliberately NOT listed. Their managers already read their own
 * config tables, and adding a second gate here would double-enforce — /imagine, for one,
 * already refuses when `imagine_config.enabled` is 0.
 */
export const COMMAND_FEATURE_MAP = {
    grow: 'grow',
    cannabis: 'cannabis',
    smokecircle: 'cannabis',
    join: 'cannabis',
    puff: 'cannabis',
    pass: 'cannabis',
    endcircle: 'cannabis',
    cheers: 'cannabis',
    dailyjoint: 'cannabis',
    fun: 'fun',
    owoify: 'fun',
    luck: 'fun',
    wordgame: 'wordgames',
    fish: 'fishing',
    selfcare: 'selfcare',
    knowledge: 'knowledge',
    deals: 'deals',
    showcase: 'showcase',
    sprites: 'sprites',
    shoutout: 'shoutout',
    buymeacoffee: 'buymeacoffee',
    movie: 'jellyfin',
    watch: 'jellyfin', // /watch is the same command as /movie (commands/media/watch.js)
    // Gated so the command is registered globally but inert until a guild
    // enables it. Without this line the toggle would save and be ignored.
    windrose: 'windrose',
    digimon: 'digimon',
    // null exempts a subcommand from its command's gate: /digimon setup is how an admin turns Digimon on.
    'digimon:setup': null,
    // Where one feature covers several commands with their own switches, name the switch —
    // `arcade` has no single `enabled` field, so without this the LFG and music-quiz toggles
    // would save but never be enforced.
    'arcade:lfg': { feature: 'arcade', enabledKey: 'lfg_enabled' },
    'arcade:musicquiz': { feature: 'arcade', enabledKey: 'musicquiz_enabled' },
    'tools:colorrole': { feature: 'colorroles', enabledKey: 'colorrole_enabled' },
    'tools:afk': { feature: 'colorroles', enabledKey: 'afk_enabled' },
    'tools:afk-list': { feature: 'colorroles', enabledKey: 'afk_enabled' },
};

/**
 * The feature gating a command path, as `{ feature, enabledKey }`, or null if it is ungated.
 * `enabledKey` defaults to 'enabled'.
 */
export function featureForCommand(commandName, subKey) {
    if (subKey && Object.hasOwn(COMMAND_FEATURE_MAP, subKey) && COMMAND_FEATURE_MAP[subKey] === null) return null;
    const entry = COMMAND_FEATURE_MAP[subKey] ?? COMMAND_FEATURE_MAP[commandName] ?? null;
    if (!entry) return null;
    return typeof entry === 'string'
        ? { feature: entry, enabledKey: 'enabled' }
        : { enabledKey: 'enabled', ...entry };
}

export function getSpec(key) {
    return FEATURE_SPECS[key] ?? null;
}

/** Field defaults as a plain object, used when a guild has no row yet. */
export function defaultsFor(key) {
    const spec = getSpec(key);
    if (!spec) return {};
    const out = {};
    for (const f of spec.fields) {
        if (f.default !== undefined) out[f.key] = f.default;
    }
    return out;
}

export default FEATURE_SPECS;
