/**
 * Feature adoption: how many of the servers our bots are in use each bot feature.
 * Backs /super-admin/feature-adoption (dashboard/routes/feature-adoption.js).
 *
 * Every feature names where its state lives, as up to three things:
 *   on     — guilds with it switched on (an enabled flag, or a config row when it has no flag)
 *   setup  — guilds with any config row, on or off
 *   act    — [table, timestamp column, extra WHERE] sources whose rows mean the feature DID
 *            something; a guild is "active" when its newest row is inside the chosen range
 *
 * Notes on a feature:
 *   'always'  — runs for every server (backups, stats, logs); ranked by activity, not by a switch
 *   'default' — on unless a server turns it off; ranked by activity if any is recorded, else
 *               only by servers that switched it on themselves (being on by default is not use)
 *
 * Queries select guild_id and filter to open servers here, not with a JOIN: several tables are
 * utf8mb3 or use another collation, and a join on guilds fails on them (ER_CANT_AGGREGATE_2COLLATIONS).
 * The pool is passed in so the pure parts stay testable without a database.
 */
import { FEATURE_SPECS, defaultsFor } from '../../core/feature-config-spec.js';

export const RANGES = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 };

const T = (t, where = '') => `SELECT DISTINCT guild_id FROM \`${t}\`${where ? ` WHERE ${where}` : ''}`;
const U = (...qs) => qs.join(' UNION ');
const ALL = 'SELECT guild_id FROM guilds WHERE left_at IS NULL';
const platform = p => `SELECT DISTINCT x.guild_id FROM subscriptions x JOIN streamers s ON s.streamer_id = x.streamer_id WHERE x.paused = 0 AND s.platform = '${p}'`;
const alerts = p => [['live_announcements', 'created_at', `platform = '${p}'`]];

const MOD = 'Moderation & Security', LOG = 'Logging & Analytics', STREAM = 'Streaming & Content',
    COMM = 'Community', GAMES = 'Levels, Economy & Games', VOICE = 'Music, Voice & AI', TOOLS = 'Server Tools';

// name, category, on, setup, act, note
export const FEATURES = [
    ['Anti-nuke', MOD, T('anti_nuke_config', 'enabled = 1'), T('anti_nuke_config')],
    ['Raid detection', MOD, T('raid_detection_config', 'enabled = 1'), T('raid_detection_config')],
    ['Commission-spam filter', MOD, T('commission_spam_config', 'enabled = 1'), T('commission_spam_config'), [['commission_spam_decisions', 'created_at'], ['commission_spam_config', 'last_hit_at']]],
    ['Global ban network', MOD, T('global_ban_config', 'enabled = 1'), T('global_ban_config'), [['global_ban_action_log', 'created_at']]],
    ['Global ban: alert / feed only mode', MOD, T('global_ban_config', "enabled = 1 AND mode <> 'protect'"), null],
    ['Join risk insight', MOD, T('logging_config', 'join_insight = 1 AND enabled = 1 AND log_channel_id IS NOT NULL'), null],
    ['Phishing & scam-image protection', MOD, T('phishing_config', 'enabled = 1'), T('phishing_config'), [['phishing_detections', 'created_at'], ['blocked_image_hits', 'last_seen']]],
    ['Self-bot detection', MOD, T('selfbot_detection_config', 'enabled = 1'), T('selfbot_detection_config'), [['selfbot_detections', 'detected_at']]],
    ['Adaptive spam filter', MOD, T('adaptive_spam_config', 'enabled = 1'), T('adaptive_spam_config'), [['spam_profiles', 'last_violation_at']]],
    ['Raid auto-lockdown', MOD, T('raid_detection_config', 'auto_lockdown_enabled = 1'), null, [['raid_lockdowns', 'started_at']]],
    ['NSFW avatars', MOD, T('join_gate_config', 'nsfw_avatar_enabled = 1'), null, [['join_gate_events', 'created_at', "action LIKE 'nsfw\\_%'"]]],
    ['NSFW chat images', MOD, T('phishing_config', 'nsfw_img_enabled = 1'), null, [['phishing_detections', 'created_at', "source = 'nsfw_image'"]]],
    ['Self-promo rules', MOD, T('self_promo_config', 'enabled = 1'), T('self_promo_config')],
    ['Escalation rules', MOD, T('escalation_rules'), T('escalation_rules')],
    ['Join gate', MOD, T('join_gate_config', 'age_gate_enabled = 1 OR rejoin_limit_enabled = 1 OR spammer_enabled = 1 OR name_filters_enabled = 1 OR avatar_enabled = 1'), T('join_gate_config'), [['member_join_history', 'created_at']]],
    ['Age gate', MOD, T('join_gate_config', 'age_gate_enabled = 1'), null],
    ['Rejoin limit', MOD, T('join_gate_config', 'rejoin_limit_enabled = 1'), null],
    ['Warnings & infractions', MOD, T('infractions', 'is_active = 1'), T('infractions'), [['infractions', 'created_at']]],
    ['Verification (I agree / CAPTCHA)', MOD, T('verify_config', 'enabled = 1'), T('verify_config'), [['join_gate_events', 'created_at', "action = 'verify_passed'"]]],
    ['Auto-prune', MOD, T('join_gate_config', 'prune_enabled = 1'), null, [['join_gate_events', 'created_at', "action = 'prune_kicked'"]]],
    ['Inactivity prune', MOD, T('join_gate_config', 'inactive_never_enabled = 1 OR inactive_quiet_enabled = 1'), null, [['join_gate_events', 'created_at', "action = 'prune_inactive_kicked'"]]],
    ['Automod rules', MOD, T('automod_rules', 'is_enabled = 1'), T('automod_rules')],
    ['Scheduled channel purges', MOD, T('scheduled_purges', 'enabled = 1'), T('scheduled_purges'), [['scheduled_purges', 'last_purge_at']]],
    ['Spam thresholds', MOD, T('automod_spam_config', 'enabled = 1'), T('automod_spam_config')],
    ['Invite link filter', MOD, T('invite_filter_config', 'enabled = 1'), T('invite_filter_config')],
    ['Quarantine', MOD, T('quarantine_config', 'is_enabled = 1'), T('quarantine_config')],
    ['Sticky roles', MOD, T('guilds', 'sticky_roles_enabled = 1'), null, [['role_persistence', 'last_updated']]],
    ['Automod heat', MOD, T('automod_heat_config', 'is_enabled = 1'), T('automod_heat_config')],
    ['Link policy', MOD, T('link_policy_config', 'enabled = 1'), T('link_policy_config'), [['link_policy_decisions', 'created_at']]],
    ['Channel post rules', MOD, T('channel_post_rules', 'enabled = 1'), T('channel_post_rules')],
    ['Voice channel guards', MOD, T('voice_channel_guards'), T('voice_channel_guards')],
    ['Ban requests', MOD, T('ban_request_config'), T('ban_request_config'), [['ban_requests', 'created_at']]],
    ['Channel purge rules', MOD, T('channel_purge_rules', 'enabled = 1'), T('channel_purge_rules'), [['channel_purge_rules', 'last_run_at']]],
    ['Channel access watch', MOD, T('channel_access_watch', 'enabled = 1'), T('channel_access_watch')],
    ['Auto-delete channels', MOD, T('auto_delete_channels'), T('auto_delete_channels')],
    ['Counting sabotage guard', MOD, T('counting_sabotage_guards', 'enabled = 1'), T('counting_sabotage_guards')],
    ['Member purge', MOD, T('member_purge_config', 'enabled = 1'), T('member_purge_config')],

    ['Server backups', LOG, ALL, null, [['server_backups', 'created_at']], 'always'],
    ['Server stats', LOG, ALL, null, [['server_stats', 'date']], 'always'],
    ['Audit log capture', LOG, ALL, null, [['audit_logs', 'timestamp']], 'always'],
    ['Message activity stats', LOG, ALL, null, [['message_stats', 'created_at']], 'always'],
    ['Message log cache', LOG, ALL, null, [['message_logs', 'timestamp']], 'always'],
    ['Voice activity tracking', LOG, ALL, null, [['voice_activity', 'joined_at']], 'always'],
    ['Emoji usage stats', LOG, ALL, null, [['emoji_usage', 'created_at']], 'always'],
    ['Invite tracking', LOG, ALL, null, [['invite_tracking', 'created_at']], 'always'],
    ['Server logging channels', LOG, T('logging_config', 'enabled = 1'), T('logging_config')],
    ['Stat display channels', LOG, T('stat_display_channels'), T('stat_display_channels')],
    ['Log channel routing', LOG, T('log_channel_routing', 'enabled = 1'), T('log_channel_routing')],

    ['Live stream alerts', STREAM, T('subscriptions', 'paused = 0'), T('subscriptions'), [['live_announcements', 'created_at']]],
    ['Live alerts: Twitch', STREAM, platform('twitch'), null, alerts('twitch')],
    ['Live alerts: YouTube', STREAM, platform('youtube'), null, alerts('youtube')],
    ['Live alerts: Kick', STREAM, platform('kick'), null, alerts('kick')],
    ['Live alerts: TikTok', STREAM, platform('tiktok'), null, alerts('tiktok')],
    ['Live alerts: Rumble', STREAM, platform('rumble'), null, alerts('rumble')],
    ['Member Twitch linking', STREAM, T('community_twitch_links'), T('community_twitch_links'), [['community_twitch_links', 'last_checked']]],
    ['Live roles', STREAM, T('subscriptions', 'paused = 0 AND live_role_id IS NOT NULL'), T('subscriptions', 'live_role_id IS NOT NULL'), [['live_role_grants', 'granted_at']]],
    ['Streamer auto-track', STREAM, T('guild_streamer_auto_track', 'enabled = 1'), T('guild_streamer_auto_track')],
    ['Free games alerts', STREAM, T('free_games_subscriptions', 'is_enabled = 1'), T('free_games_subscriptions'), [['free_games_seen', 'seen_at']]],
    ['Auto publisher', STREAM, T('auto_publisher_config', 'is_enabled = 1'), T('auto_publisher_config')],
    ['Twitch schedule sync', STREAM, T('twitch_schedule_sync_config', 'is_enabled = 1'), T('twitch_schedule_sync_config'), [['twitch_schedule_sync_config', 'last_synced']]],
    ['Webhooks', STREAM, T('webhook_config', 'active = 1'), T('webhook_config'), [['webhook_config', 'last_used']]],
    ['YouTube upload feeds', STREAM, T('youtube_feeds'), T('youtube_feeds')],
    ['Twitch role sync', STREAM, T('twitch_role_sync_config', 'enabled = 1'), T('twitch_role_sync_config'), [['twitch_role_sync_config', 'last_synced']]],
    ['Steam game update watch', STREAM, T('steam_watchers', 'is_enabled = 1'), T('steam_watchers'), [['steam_watchers', 'last_update_found_at']]],
    ['Fortnite Sprites live embeds', STREAM, T('epic_sprite_discord_embeds'), T('epic_sprite_discord_embeds'), [['epic_sprite_discord_embeds', 'updated_at']]],
    ['Game patch watchers', STREAM, T('game_patch_watchers', 'is_enabled = 1'), T('game_patch_watchers'), [['game_patch_watchers', 'last_posted_at']]],
    ['Community support shoutouts', STREAM, T('community_support_config', 'enabled = 1'), T('community_support_config'), [['community_support_entries', 'created_at']]],
    ['Twitch clip feeds', STREAM, T('twitch_clip_feeds', 'enabled = 1'), T('twitch_clip_feeds')],
    ['Twitch teams', STREAM, T('twitch_teams'), T('twitch_teams')],
    ['Stream signup', STREAM, T('stream_signup_config'), T('stream_signup_config')],
    ['Throne wishlist alerts', STREAM, T('throne_notifications'), T('throne_notifications'), [['throne_notification_log', 'created_at']]],
    ['Bluesky feeds', STREAM, T('bluesky_feeds'), T('bluesky_feeds')],
    ['Twitter / X feeds', STREAM, T('twitter_feeds'), T('twitter_feeds')],
    ['Fortnite news feed', STREAM, T('fortnite_feeds', 'enabled = 1'), T('fortnite_feeds'), [['fortnite_feed_seen', 'seen_at']]],
    ['Staff live forwarding', STREAM, T('staff_live_forward', 'enabled = 1'), T('staff_live_forward')],
    ['Ko-fi supporters', STREAM, T('kofi_config', 'enabled = 1'), T('kofi_config'), [['kofi_transactions', 'received_at']]],
    ['Live channel rules', STREAM, T('guild_live_channel_rules', 'enabled = 1'), T('guild_live_channel_rules')],

    ['Orientation message', COMM, T('orientation_config', 'channel_id IS NOT NULL'), T('orientation_config')],
    ['Welcome messages', COMM, T('welcome_settings', 'channel_id IS NOT NULL'), T('welcome_settings')],
    ['Reaction roles', COMM, T('reaction_role_panels'), T('reaction_role_panels')],
    ['Ticket system', COMM, U(T('ticket_panels', 'is_active = 1'), T('ticket_config')), U(T('ticket_panels'), T('ticket_config')), [['tickets', 'created_at']]],
    ['Birthdays', COMM, T('birthday_config', 'enabled = 1'), T('birthday_config'), [['user_birthdays', 'last_announced']]],
    ['Welcome banner cards', COMM, T('welcome_settings', 'banner_enabled = 1 OR welcome_banner_enabled = 1'), null],
    ['Suggestions', COMM, T('suggestion_config', 'enabled = 1'), T('suggestion_config'), [['suggestions', 'created_at']]],
    ['Prefix commands', COMM, T('prefix_command_config', 'enabled = 1'), T('prefix_command_config')],
    ['Birthday cards', COMM, T('birthday_config', 'cards_enabled = 1'), null, [['birthday_cards', 'created_at']]],
    ['Goodbye messages', COMM, T('welcome_settings', 'goodbye_enabled = 1'), null],
    ['Custom embeds', COMM, T('custom_embeds'), T('custom_embeds')],
    ['Join-to-create voice', COMM, T('temp_channel_config'), T('temp_channel_config'), [['temp_voice_channels', 'created_at']]],
    ['Command restrictions', COMM, T('guild_command_restrictions'), T('guild_command_restrictions')],
    ['Discord event reminders', COMM, T('scheduled_events_config'), T('scheduled_events_config'), [['scheduled_events_config', 'created_at']]],
    ['Starboard', COMM, T('starboard_config', 'enabled = 1'), T('starboard_config')],
    ['Polls', COMM, T('polls'), T('polls'), [['polls', 'ends_at']]],
    ['Auto roles', COMM, T('autoroles_config', 'is_enabled = 1'), T('autoroles_config')],
    ['Question of the Day', COMM, T('qotd_channels', 'enabled = 1'), T('qotd_channels'), [['qotd_history', 'posted_at']]],
    ['Timezones', COMM, T('tz_guild_config', 'enabled = 1'), T('tz_guild_config')],
    ['Confessions', COMM, T('confession_config', 'enabled = 1'), T('confession_config'), [['confessions', 'submitted_at']]],
    ['Server join requests', COMM, T('guild_join_requests'), T('guild_join_requests'), [['guild_join_requests', 'applied_at']]],
    ['Event schedule board', COMM, T('event_schedule_config', 'is_enabled = 1'), T('event_schedule_config'), [['event_schedule_posts', 'last_synced']]],
    ['Autoresponders', COMM, T('autoresponders', 'enabled = 1'), T('autoresponders'), [['autoresponders', 'last_triggered']]],
    ['Sticky messages', COMM, T('sticky_messages'), T('sticky_messages')],
    ['Modmail', COMM, T('modmail_config', 'enabled = 1'), T('modmail_config')],
    ['Context Menus', COMM, T('context_menu_config', 'enabled = 1'), T('context_menu_config')],
    ['Server theme', COMM, T('guild_theme', 'enabled = 1'), T('guild_theme')],
    ['Language preference', COMM, T('guild_language_prefs'), T('guild_language_prefs')],
    ['Forms', COMM, T('form_panels'), T('form_panels'), [['form_submissions', 'submitted_at']]],
    ['Custom commands', COMM, T('custom_commands'), T('custom_commands')],
    ['Colour picker roles', COMM, T('colour_picker_config'), T('colour_picker_config'), [['colour_role_usage', 'last_used']]],
    ['Creator showcase', COMM, T('showcase_channels', 'enabled = 1'), T('showcase_channels'), [['showcase_items', 'created_at']]],
    ['Temporary access invites', COMM, T('temp_access_config', 'enabled = 1'), T('temp_access_config'), [['temp_access_members', 'started_at']]],
    ['Giveaways', COMM, T('giveaway_host_roles'), T('giveaway_host_roles')],
    ['AFK status', COMM, T('guilds', 'afk_enabled = 1'), null, [['afk_statuses', 'set_at']], 'default'],

    ['Achievements', GAMES, `${ALL} AND guild_id NOT IN (SELECT guild_id FROM achievement_config WHERE enabled = 0)`, T('achievement_config'), [['user_achievements', 'created_at']], 'default'],
    ['Leveling & XP', GAMES, T('level_config', 'enabled = 1'), T('level_config'), [['user_levels', 'last_message_timestamp']]],
    ['Level role rewards', GAMES, U(T('level_role_rewards'), T('level_rewards')), null],
    ['Counting', GAMES, T('counting_channels', 'is_active = 1'), T('counting_channels'), [['counting_stats', 'last_count_at']]],
    ['Cannabis community', GAMES, U(T('tokes'), T('daily_joints'), T('smoke_circles')), null, [['toke_sessions', 'created_at'], ['joint_claims', 'claimed_at'], ['smoke_circles', 'started_at']]],
    ['Pokémon spawns', GAMES, T('pokemon_settings', 'spawn_enabled = 1'), T('pokemon_settings'), [['pokemon_spawns', 'spawned_at']]],
    ['Digimon', GAMES, T('digimon_settings', 'enabled = 1'), T('digimon_settings'), [['user_digimon', 'obtained_at'], ['digimon_quiz_results', 'created_at']]],
    ['Economy', GAMES, T('economy_config', 'enabled = 1'), T('economy_config'), [['economy_transactions', 'created_at']]],
    ['Word Games', GAMES, T('word_game_channels', 'enabled = 1'), T('word_game_channels'), [['word_game_sessions', 'created_at']]],
    ['OwO pets & battles', GAMES, T('owo_config', 'enabled = 1'), T('owo_config'), [['owo_points_guild', 'updated_at']]],
    ['Monthly XP reset', GAMES, T('level_config', 'monthly_reset_enabled = 1'), null, [['level_config', 'last_reset_at']]],
    ['D&D campaigns', GAMES, T('dnd_campaigns'), T('dnd_campaigns'), [['dnd_dice_rolls', 'created_at']]],
    ['Gambling', GAMES, T('gambling_config', 'enabled = 1'), T('gambling_config'), [['gambling_history', 'created_at']]],
    ['Rank card styles', GAMES, T('rank_card_settings'), T('rank_card_settings')],
    ['Grow-a-tree', GAMES, T('gat_trees'), T('gat_trees'), [['gat_encounters', 'spawned_at']]],
    ['Cat catching', GAMES, T('catbot_channels', 'enabled = 1'), T('catbot_channels')],
    ['Currency', GAMES, T('currency_config', 'enabled = 1'), T('currency_config')],
    ['Cards Against Humanity', GAMES, T('cah_guild_config'), T('cah_guild_config')],

    ['Music player', VOICE, T('music_config', 'enabled = 1 OR is_enabled = 1'), T('music_config'), [['music_play_log', 'logged_at']]],
    ['Music request panels', VOICE, T('music_panels'), T('music_panels')],
    ['DJ role', VOICE, T('music_config', "dj_role_id IS NOT NULL AND dj_role_id <> ''"), null],
    ['AI DJ', VOICE, T('ai_dj_config', 'enabled = 1'), T('ai_dj_config')],
    ['Cinema', VOICE, T('cinema_config', 'enabled = 1'), T('cinema_config')],
    ['AI assistant', VOICE, T('ai_config', 'enabled = 1'), T('ai_config')],
    ['Voice chat reader', VOICE, T('voice_reader_config', 'enabled = 1'), T('voice_reader_config')],
    ['Text to speech', VOICE, T('tts_config', 'enabled = 1'), T('tts_config')],
    ['AI image generation', VOICE, T('imagine_config', 'enabled = 1'), T('imagine_config')],
    ['Voice transcription', VOICE, T('voice_transcription_config', 'enabled = 1'), T('voice_transcription_config'), [['voice_transcription_sessions', 'started_at']]],
    ['VC sound drops', VOICE, T('vc_sound_config', 'enabled = 1'), T('vc_sound_config'), [['vc_sound_log', 'played_at']]],
    ['Weather alerts', VOICE, T('weather_config', 'enabled = 1'), T('weather_config')],

    ['Custom branded bot', TOOLS, T('guild_bot_mapping'), T('guild_bot_mapping')],
    ['Server transfers', TOOLS, T('server_transfers'), T('server_transfers'), [['server_transfers', 'started_at']]],
    ['Steam library', TOOLS, T('steam_library_config'), T('steam_library_config')],
];

// Dashboard-managed command families (guild_feature_config JSON, core/feature-config-spec.js).
// Several have their own switch keys; one without any switch is a settings page, not a feature.
const SWITCHES = {
    arcade: [['LFG posts', 'lfg_enabled'], ['Music quiz', 'musicquiz_enabled']],
    colorroles: [['Colour roles', 'colorrole_enabled']],
};
const parseConfig = c => { try { return (typeof c === 'string' ? JSON.parse(c) : c) || {}; } catch { return {}; } };
const truthy = v => v === true || Number(v) === 1;

/**
 * Turn guild_feature_config rows into features. Pure, so tests can feed it rows.
 * @returns {Array<{name, cat, on:Set, chosen:Set, setup:Set, note}>}
 */
export function managedFeatures(rows, openIds, specs = FEATURE_SPECS, taken = new Set(FEATURES.map(f => f[0].toLowerCase()))) {
    const out = [];
    for (const [key, spec] of Object.entries(specs)) {
        if (spec.storage?.kind !== 'managed') continue;
        const mine = rows.filter(r => r.feature_key === key && openIds.has(String(r.guild_id)))
            .map(r => ({ id: String(r.guild_id), cfg: parseConfig(r.config) }));
        const defs = defaultsFor(key);
        for (const [label, flag] of SWITCHES[key] || [[spec.label, 'enabled']]) {
            if (taken.has(label.toLowerCase())) continue;
            if (!(flag in defs) && !mine.some(r => flag in r.cfg)) continue;
            const chosen = new Set(mine.filter(r => truthy(r.cfg[flag])).map(r => r.id));
            const dflt = truthy(defs[flag]);
            const on = new Set(chosen);
            if (dflt) for (const id of openIds) if (!mine.some(r => r.id === id && flag in r.cfg)) on.add(id);
            out.push({ name: label, cat: spec.category || TOOLS, on, chosen, setup: new Set(mine.map(r => r.id)), note: dflt ? 'default' : null });
        }
    }
    return out;
}

/**
 * Rank one feature. `lastByGuild` maps guild → newest activity (ms) across the feature's sources.
 * "Using": always-on → guilds active in range; default-on → active in range if the feature records
 * activity at all, else guilds that switched it on themselves; otherwise → guilds with it on.
 */
export function summarise({ name, cat, note = null, on = null, chosen = null, setup = null, lastByGuild = null }, cutoffMs) {
    const active = lastByGuild ? new Set([...lastByGuild].filter(([, t]) => t >= cutoffMs).map(([id]) => id)) : null;
    const using = note === 'always' ? (active || new Set())
        : note === 'default' ? (active ?? chosen ?? new Set())
        : (on || new Set());
    let lastAt = null;
    if (lastByGuild) for (const t of lastByGuild.values()) if (lastAt == null || t > lastAt) lastAt = t;
    return {
        name, cat, note,
        using: [...using].map(id => ({ id, last: lastByGuild?.get(id) ?? null })),
        on: on ? on.size : null,
        setup: setup ? (note === 'default' ? setup.size : Math.max(setup.size, on?.size ?? 0)) : null,
        active: active ? active.size : null,
        lastAt,
    };
}

export function rank(features) {
    return features.sort((a, b) => b.using.length - a.using.length || (b.setup ?? 0) - (a.setup ?? 0) || a.name.localeCompare(b.name));
}

/** Everything the page draws. Errors on one table drop that number to null rather than the page. */
export async function loadAdoption(pool, rangeKey = '30d', { log } = {}) {
    const days = RANGES[rangeKey] ?? 30;
    const now = Date.now();
    const cutoffMs = now - days * 86400000;

    const [open] = await pool.query('SELECT guild_id, guild_name FROM guilds WHERE left_at IS NULL');
    const openIds = new Set(open.map(r => String(r.guild_id)));
    const failed = [];

    const idCache = new Map();
    async function ids(sql) {
        if (!sql) return null;
        if (!idCache.has(sql)) {
            idCache.set(sql, pool.query(sql).then(([rows]) => rows.map(r => String(r.guild_id)))
                .catch(e => { failed.push(e.message.slice(0, 120)); log?.(sql, e); return null; }));
        }
        const list = await idCache.get(sql);
        return list ? new Set(list.filter(id => openIds.has(id))) : null;
    }
    const lastCache = new Map();
    async function lastBy(sources) {
        if (!sources) return null;
        const merged = new Map();
        let any = false;
        for (const [table, col, where] of sources) {
            const sql = `SELECT guild_id, MAX(\`${col}\`) AS last FROM \`${table}\`${where ? ` WHERE ${where}` : ''} GROUP BY guild_id`;
            if (!lastCache.has(sql)) {
                lastCache.set(sql, pool.query(sql).then(([rows]) => rows).catch(e => { failed.push(e.message.slice(0, 120)); log?.(sql, e); return null; }));
            }
            const rows = await lastCache.get(sql);
            if (!rows) continue;
            any = true;
            for (const r of rows) {
                const id = String(r.guild_id), t = r.last ? new Date(r.last).getTime() : NaN;
                // Future timestamps (scheduled poll ends, expiries) are not activity yet.
                if (!openIds.has(id) || !Number.isFinite(t) || t > now) continue;
                if (!merged.has(id) || t > merged.get(id)) merged.set(id, t);
            }
        }
        return any ? merged : null;
    }

    const features = await Promise.all(FEATURES.map(async ([name, cat, onQ, setupQ, act, note]) => summarise({
        name, cat, note,
        on: await ids(onQ),
        setup: await ids(setupQ),
        lastByGuild: await lastBy(act),
    }, cutoffMs)));

    const [gfc] = await pool.query('SELECT guild_id, feature_key, config FROM guild_feature_config');
    for (const m of managedFeatures(gfc, openIds)) features.push(summarise(m, cutoffMs));

    return {
        now, range: rangeKey, days,
        openServers: openIds.size,
        servers: Object.fromEntries(open.map(r => [String(r.guild_id), r.guild_name || String(r.guild_id)])),
        features: rank(features),
        failed: [...new Set(failed)],
    };
}

export default { RANGES, FEATURES, managedFeatures, summarise, rank, loadAdoption };
