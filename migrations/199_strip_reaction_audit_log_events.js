/**
 * Migration 199: Remove reaction audit-log event types from existing guilds.
 *
 * 2026-10-18 — the owner killed the four reaction audit-channel embeds
 * (`reactionAdd`, `reactionRemove`, `reactionRemoveAll`, `reactionRemoveEmoji`)
 * because per-tap "<user> added :smile: to a message" entries were spamming
 * every guild's log channel. The event handlers no longer call `sendLogEmbed`
 * for those four types, and the dashboard default-enabled list no longer
 * includes them, but existing guilds have the names stored in two places:
 *
 *   - `logging_config.enabled_events` — JSON array of event names
 *   - `log_event_config` — rows keyed by (guild_id, event_type)
 *
 * This migration strips those references so the dashboard toggle UI stops
 * offering a setting that no longer does anything.
 *
 * Idempotent.
 */

const REACTION_EVENTS = [
    'reactionAdd',
    'reactionRemove',
    'reactionRemoveAll',
    'reactionRemoveEmoji',
];

export async function up(db) {
    // 1. logging_config.enabled_events — JSON array per guild
    const [rows] = await db.execute(
        "SELECT guild_id, enabled_events FROM logging_config WHERE enabled_events IS NOT NULL AND enabled_events != '[]'",
    );
    for (const r of rows) {
        let arr;
        try {
            arr = JSON.parse(r.enabled_events);
        } catch {
            continue;
        }
        if (!Array.isArray(arr)) continue;
        const next = arr.filter(e => !REACTION_EVENTS.includes(e));
        if (next.length === arr.length) continue;
        await db.execute(
            'UPDATE logging_config SET enabled_events = ? WHERE guild_id = ?',
            [JSON.stringify(next), r.guild_id],
        );
    }

    // 2. log_event_config — per-event rows
    await db.execute(
        'DELETE FROM log_event_config WHERE event_type IN (?, ?, ?, ?)',
        REACTION_EVENTS,
    );
}
