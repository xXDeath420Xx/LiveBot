/**
 * Wave 408 — log settings saved under Discord's gateway event names, which the bot never sends.
 *
 * sendLogEmbed is called with the dashboard's category keys (memberJoin, voiceUpdate, ban …). One-off setup scripts
 * wrote Discord's event names instead (guildMemberAdd, voiceStateUpdate, guildBanAdd …), so a server whose list
 * holds only those names never gets member, voice, ban or AutoMod logs: Kreator's Kingdom had 8 of its 18 that
 * way since 2026-10-29, and its member, voice and moderation log channels stayed empty. The dashboard shows
 * these as unticked boxes because it only knows the category keys.
 *
 * Each old name becomes the categories it was meant to cover, keeping its channel. A setting the server already
 * has under the category key wins; the old row is then removed. Covers logging_config.enabled_events,
 * log_event_config and log_channel_routing.
 */
export const RAW_TO_CATEGORIES = {
    guildMemberAdd: ['memberJoin'],
    guildMemberRemove: ['memberLeave', 'memberKick'],
    guildMemberUpdate: ['memberUpdate', 'memberTimeout'],
    messageBulkDelete: ['messageDelete'],          // bulk deletes are sent as messageDelete
    guildBanAdd: ['ban'],
    guildBanRemove: ['unban'],
    voiceStateUpdate: ['voiceUpdate', 'voiceServerMute', 'voiceServerDeaf'],
    autoModerationActionExecution: ['automodAction'],
};
const RAW = Object.keys(RAW_TO_CATEGORIES);

export async function up(pool) {
    // enabled_events lists
    const [configs] = await pool.query('SELECT guild_id, enabled_events FROM logging_config');
    for (const c of configs) {
        let events;
        try { events = JSON.parse(c.enabled_events || '[]'); } catch { continue; }
        if (!Array.isArray(events) || !events.some(e => RAW.includes(e))) continue;
        const next = [...new Set(events.flatMap(e => RAW_TO_CATEGORIES[e] ?? [e]))];
        await pool.query('UPDATE logging_config SET enabled_events = ? WHERE guild_id = ?', [JSON.stringify(next), c.guild_id]);
    }

    // per-event channel overrides
    const [overrides] = await pool.query('SELECT * FROM log_event_config WHERE event_type IN (?)', [RAW]);
    for (const o of overrides) {
        for (const cat of RAW_TO_CATEGORIES[o.event_type]) {
            await pool.query(
                'INSERT IGNORE INTO log_event_config (guild_id, event_type, enabled, log_channel_id) VALUES (?, ?, ?, ?)',
                [o.guild_id, cat, o.enabled, o.log_channel_id]);
        }
        await pool.query('DELETE FROM log_event_config WHERE guild_id = ? AND event_type = ?', [o.guild_id, o.event_type]);
    }

    const [routes] = await pool.query('SELECT * FROM log_channel_routing WHERE log_type IN (?)', [RAW]);
    for (const r of routes) {
        for (const cat of RAW_TO_CATEGORIES[r.log_type]) {
            await pool.query(
                'INSERT IGNORE INTO log_channel_routing (guild_id, log_type, channel_id, enabled) VALUES (?, ?, ?, ?)',
                [r.guild_id, cat, r.channel_id, r.enabled]);
        }
        await pool.query('DELETE FROM log_channel_routing WHERE id = ?', [r.id]);
    }
}
