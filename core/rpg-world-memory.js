/**
 * RPG World Memory — what the AI Dungeon Master has established about a campaign's world, kept in
 * the database so it survives restarts, session boundaries and cache evictions.
 *
 * Before this, {{NPC}}, {{LOCATION}}, {{TIME}} and {{WEATHER}} tags only updated an in-memory Map
 * (core/rpg-state-manager.js), so a restart — or simply starting session 2 — forgot every NPC and
 * place, and the prompt's "Active Quests" read dnd_sessions.active_quests, which nothing wrote.
 *
 * Tables (campaign-scoped, unique keys from migration 316):
 *   dnd_campaign_npcs       one row per NPC name per campaign (description, last location, alive)
 *   dnd_campaign_locations  one row per place per campaign (type, connections, NPCs met there)
 *   dnd_world_state         time_of_day / weather / current_location (JSON values)
 *   dnd_campaign_quests     the DM's quest log, driven by {{QUEST:name:ACTION:detail}}
 *   dnd_zone_discoveries    per-character exploration log (first visit + revisit count)
 *   dnd_sessions.active_quests  a JSON snapshot of the active quests, refreshed on every quest change
 *
 * Every write is best-effort: a failed write is logged with context and never breaks the DM reply.
 */
import { pool } from '../utils/db.js';
import logger from '../utils/logger.js';
import RPGLeaderboardManager from './rpg-leaderboard-manager.js';
import {
    QUEST_STATUS_FOR_ACTION,
    inferLocationType,
    isRealLocation,
    clipName,
    resolveZoneId,
    addToJsonList,
    parseJsonList,
    appendQuestNote,
    lastQuestNote,
} from './rpg-world-tags.js';

const ZONE_CACHE_MS = 5 * 60 * 1000;
let zoneCache = { at: 0, rows: [] };

function parseStateValue(v) {
    try {
        const parsed = typeof v === 'string' ? JSON.parse(v) : v;
        return parsed === null || parsed === undefined ? null : String(parsed);
    } catch {
        return null;
    }
}

class RPGWorldMemory {
    /** The static world zones (dnd_zones), cached briefly — used to map DM place names onto zone ids. */
    static async getZones() {
        if (Date.now() - zoneCache.at < ZONE_CACHE_MS) return zoneCache.rows;
        try {
            const [rows] = await pool.execute('SELECT zone_id, zone_name, connected_zones FROM dnd_zones');
            zoneCache = { at: Date.now(), rows };
        } catch (error) {
            logger.error('[RPG World] Could not load dnd_zones', { error: error.message });
            zoneCache = { at: Date.now(), rows: zoneCache.rows || [] };
        }
        return zoneCache.rows;
    }

    /**
     * Everything the DM prompt and the state cache need for one campaign.
     * Returns null on failure (logged) so callers can carry on without world memory.
     */
    static async loadWorld(campaignId) {
        if (!campaignId) return null;
        try {
            const [quests] = await pool.execute(
                `SELECT quest_id, quest_name, quest_type, description, status, progress, notes, location,
                        created_at, completed_at
                   FROM dnd_campaign_quests
                  WHERE campaign_id = ? AND status IN ('active', 'available', 'completed', 'failed')
                  ORDER BY (status = 'active') DESC, COALESCE(updated_at, created_at) DESC
                  LIMIT 30`,
                [campaignId]
            );
            const [npcs] = await pool.execute(
                `SELECT npc_name, description, location, is_alive
                   FROM dnd_campaign_npcs
                  WHERE campaign_id = ? AND is_active = 1
                  ORDER BY COALESCE(last_seen_at, created_at) DESC
                  LIMIT 25`,
                [campaignId]
            );
            const [locations] = await pool.execute(
                `SELECT location_name, location_type
                   FROM dnd_campaign_locations
                  WHERE campaign_id = ?
                  ORDER BY COALESCE(last_visited_at, created_at) DESC
                  LIMIT 25`,
                [campaignId]
            );
            const [stateRows] = await pool.execute(
                `SELECT state_key, state_value FROM dnd_world_state
                  WHERE campaign_id = ? AND state_key IN ('time_of_day', 'weather', 'current_location')`,
                [campaignId]
            );
            const state = Object.fromEntries(stateRows.map(r => [r.state_key, parseStateValue(r.state_value)]));
            return {
                quests: quests.map(q => ({ ...q, lastNote: lastQuestNote(q.notes) })),
                npcs,
                locations,
                timeOfDay: state.time_of_day || null,
                weather: state.weather || null,
                currentLocation: state.current_location || null,
            };
        } catch (error) {
            logger.error('[RPG World] Failed to load world memory', { campaignId, error: error.message });
            return null;
        }
    }

    /**
     * Persist what one DM narration established. `events` is collected by
     * RPGAiDungeonMaster.processNarrationTags():
     *   { previousLocation, locations: [name…], npcs: [{ name, description, location }],
     *     quests: [{ name, action, detail }], timeOfDay, weather, location }
     */
    static async persistEvents(campaignId, sessionId, events) {
        if (!campaignId || !events) return;

        // Places, in the order the DM moved through them, linking each to the one before it.
        let prev = isRealLocation(events.previousLocation) ? clipName(events.previousLocation, 255) : null;
        for (const raw of events.locations || []) {
            if (!isRealLocation(raw)) continue;
            const name = clipName(raw, 255);
            await this.recordLocation(campaignId, name, prev);
            prev = name;
        }

        for (const npc of events.npcs || []) {
            await this.recordNpc(campaignId, npc);
        }

        let questsChanged = false;
        for (const q of events.quests || []) {
            if (await this.applyQuestEvent(campaignId, q, events.location)) questsChanged = true;
        }

        if (events.timeOfDay) await this.setWorldState(campaignId, 'time_of_day', events.timeOfDay, 'custom');
        if (events.weather) await this.setWorldState(campaignId, 'weather', events.weather, 'custom');
        if (isRealLocation(events.location)) {
            await this.setWorldState(campaignId, 'current_location', clipName(events.location, 255), 'location');
        }

        if (questsChanged && sessionId) await this.refreshSessionQuests(campaignId, sessionId);
    }

    /** Upsert a place; link it both ways with the place the party came from. */
    static async recordLocation(campaignId, name, fromName = null) {
        try {
            const connections = fromName && fromName.toLowerCase() !== name.toLowerCase()
                ? addToJsonList(null, fromName) : JSON.stringify([]);
            await pool.execute(
                `INSERT INTO dnd_campaign_locations
                    (campaign_id, location_name, location_type, connections, npcs_present, is_discovered, last_visited_at)
                 VALUES (?, ?, ?, ?, '[]', 1, NOW())
                 ON DUPLICATE KEY UPDATE is_discovered = 1, last_visited_at = NOW()`,
                [campaignId, name, inferLocationType(name), connections]
            );
            if (fromName && fromName.toLowerCase() !== name.toLowerCase()) {
                await this.linkLocations(campaignId, name, fromName);
                await this.linkLocations(campaignId, fromName, name);
            }
        } catch (error) {
            logger.error('[RPG World] Failed to record location', { campaignId, name, error: error.message });
        }
    }

    static async linkLocations(campaignId, name, other) {
        const [[row]] = await pool.execute(
            'SELECT location_id, connections FROM dnd_campaign_locations WHERE campaign_id = ? AND location_name = ?',
            [campaignId, name]
        );
        if (!row) return;
        const next = addToJsonList(row.connections, other);
        if (next !== JSON.stringify(parseJsonList(row.connections))) {
            await pool.execute('UPDATE dnd_campaign_locations SET connections = ? WHERE location_id = ?', [next, row.location_id]);
        }
    }

    /** Upsert an NPC by name; remember where they were last seen and add them to that place. */
    static async recordNpc(campaignId, { name, description, location }) {
        const npcName = clipName(name, 100);
        if (!npcName) return;
        const where = isRealLocation(location) ? clipName(location, 255) : null;
        try {
            await pool.execute(
                `INSERT INTO dnd_campaign_npcs (campaign_id, npc_name, description, location, last_seen_at)
                 VALUES (?, ?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE
                    description = COALESCE(VALUES(description), description),
                    location = COALESCE(VALUES(location), location),
                    is_active = 1,
                    last_seen_at = NOW()`,
                [campaignId, npcName, description ? String(description).slice(0, 1000) : null, where]
            );
            if (where) {
                const [[loc]] = await pool.execute(
                    'SELECT location_id, npcs_present FROM dnd_campaign_locations WHERE campaign_id = ? AND location_name = ?',
                    [campaignId, where]
                );
                if (loc) {
                    await pool.execute('UPDATE dnd_campaign_locations SET npcs_present = ? WHERE location_id = ?',
                        [addToJsonList(loc.npcs_present, npcName), loc.location_id]);
                }
            }
        } catch (error) {
            logger.error('[RPG World] Failed to record NPC', { campaignId, npc: npcName, error: error.message });
        }
    }

    /** dnd_world_state.state_value is a JSON column (CHECK json_valid). */
    static async setWorldState(campaignId, key, value, type = 'custom') {
        try {
            await pool.execute(
                `INSERT INTO dnd_world_state (campaign_id, state_key, state_value, state_type, is_revealed)
                 VALUES (?, ?, ?, ?, 1)
                 ON DUPLICATE KEY UPDATE state_value = VALUES(state_value), state_type = VALUES(state_type)`,
                [campaignId, key, JSON.stringify(String(value).slice(0, 255)), type]
            );
        } catch (error) {
            logger.error('[RPG World] Failed to save world state', { campaignId, key, error: error.message });
        }
    }

    /**
     * Apply one {{QUEST}} event to the campaign quest log. Returns true when the log changed.
     *   start     -> insert as active (re-activates an abandoned quest; never reopens completed/failed)
     *   update    -> append the detail to notes (creating the quest as active if the DM skipped START)
     *   complete  -> completed, progress 100, completed_at
     *   fail      -> failed, completed_at
     *   abandon   -> abandoned
     */
    static async applyQuestEvent(campaignId, { name, action, detail }, location = null) {
        const questName = clipName(name, 255);
        const status = QUEST_STATUS_FOR_ACTION[action];
        if (!questName || !status) return false;
        const where = isRealLocation(location) ? clipName(location, 255) : null;
        try {
            const [[existing]] = await pool.execute(
                'SELECT quest_id, status, notes FROM dnd_campaign_quests WHERE campaign_id = ? AND quest_name = ?',
                [campaignId, questName]
            );

            if (!existing) {
                // The first quest a campaign gets is its main quest; later ones are side quests.
                const [[{ mains }]] = await pool.execute(
                    "SELECT COUNT(*) AS mains FROM dnd_campaign_quests WHERE campaign_id = ? AND quest_type = 'main'",
                    [campaignId]
                );
                const description = action === 'start' ? detail : null;
                const notes = action === 'start' ? null : appendQuestNote(null, detail);
                await pool.execute(
                    `INSERT INTO dnd_campaign_quests
                        (campaign_id, quest_name, quest_type, description, location, status, progress, notes, completed_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE status = VALUES(status)`,
                    [campaignId, questName, Number(mains) > 0 ? 'side' : 'main', description, where, status,
                        status === 'completed' ? 100 : 0, notes,
                        status === 'completed' || status === 'failed' ? new Date() : null]
                );
                logger.info('[RPG World] Quest added to log', { campaignId, quest: questName, status });
                return true;
            }

            if (action === 'start') {
                if (existing.status === 'completed' || existing.status === 'failed') return false;
                await pool.execute(
                    `UPDATE dnd_campaign_quests
                        SET status = 'active', description = COALESCE(?, description), location = COALESCE(location, ?)
                      WHERE quest_id = ?`,
                    [detail, where, existing.quest_id]
                );
            } else if (action === 'update') {
                if (existing.status === 'completed' || existing.status === 'failed') return false;
                await pool.execute(
                    `UPDATE dnd_campaign_quests SET status = 'active', notes = ? WHERE quest_id = ?`,
                    [appendQuestNote(existing.notes, detail), existing.quest_id]
                );
            } else if (action === 'complete') {
                if (existing.status === 'completed') return false;
                await pool.execute(
                    `UPDATE dnd_campaign_quests
                        SET status = 'completed', progress = 100, completed_at = NOW(), notes = ?
                      WHERE quest_id = ?`,
                    [detail ? appendQuestNote(existing.notes, detail) : existing.notes, existing.quest_id]
                );
            } else if (action === 'fail') {
                if (existing.status === 'failed') return false;
                await pool.execute(
                    `UPDATE dnd_campaign_quests SET status = 'failed', completed_at = NOW(), notes = ? WHERE quest_id = ?`,
                    [detail ? appendQuestNote(existing.notes, detail) : existing.notes, existing.quest_id]
                );
            } else if (action === 'abandon') {
                if (existing.status === 'abandoned') return false;
                await pool.execute(`UPDATE dnd_campaign_quests SET status = 'abandoned' WHERE quest_id = ?`, [existing.quest_id]);
            }
            logger.info('[RPG World] Quest log updated', { campaignId, quest: questName, action });
            return true;
        } catch (error) {
            logger.error('[RPG World] Failed to update quest log', { campaignId, quest: questName, action, error: error.message });
            return false;
        }
    }

    /** Keep dnd_sessions.active_quests (read by the DM prompt and older code) in step with the log. */
    static async refreshSessionQuests(campaignId, sessionId) {
        try {
            const [rows] = await pool.execute(
                `SELECT quest_name, description, quest_type FROM dnd_campaign_quests
                  WHERE campaign_id = ? AND status = 'active' ORDER BY created_at LIMIT 20`,
                [campaignId]
            );
            const snapshot = rows.map(q => ({ name: q.quest_name, description: q.description || null, type: q.quest_type }));
            await pool.execute('UPDATE dnd_sessions SET active_quests = ? WHERE session_id = ?', [JSON.stringify(snapshot), sessionId]);
        } catch (error) {
            logger.error('[RPG World] Failed to refresh session quest snapshot', { campaignId, sessionId, error: error.message });
        }
    }

    /**
     * Record that a character reached a place. Returns { zoneId, isNew } or null.
     * Call only when the character actually MOVED (the caller compares with their previous zone),
     * so times_visited counts visits, not DM replies.
     */
    static async recordDiscovery(characterId, campaignId, location) {
        if (!characterId || !isRealLocation(location)) return null;
        try {
            const zoneId = resolveZoneId(location, await this.getZones());
            if (!zoneId) return null;
            const [res] = await pool.execute(
                `INSERT INTO dnd_zone_discoveries (character_id, zone_id, campaign_id, last_visited_at)
                 VALUES (?, ?, ?, NOW())
                 ON DUPLICATE KEY UPDATE times_visited = times_visited + 1, last_visited_at = NOW(),
                    campaign_id = COALESCE(VALUES(campaign_id), campaign_id)`,
                [characterId, zoneId, campaignId || null]
            );
            // MariaDB reports 1 for an insert and 2 for an ON DUPLICATE KEY update.
            const isNew = res.affectedRows === 1;
            if (isNew) {
                logger.info('[RPG World] New area discovered', { characterId, campaignId, zoneId });
                RPGLeaderboardManager.trackAchievements(characterId); // Cartographer (zones visited)
            }
            return { zoneId, isNew };
        } catch (error) {
            logger.error('[RPG World] Failed to record discovery', { characterId, campaignId, location, error: error.message });
            return null;
        }
    }

    // ── journal views (/rpg journal …) ──────────────────────────────────────────────────────────

    static async getDiscoveries(characterId) {
        const [rows] = await pool.execute(
            `SELECT d.zone_id, d.discovered_at, d.times_visited, d.last_visited_at, d.campaign_id,
                    z.zone_name, z.connected_zones, z.danger_level
               FROM dnd_zone_discoveries d
               LEFT JOIN dnd_zones z ON z.zone_id = d.zone_id
              WHERE d.character_id = ?
              ORDER BY d.discovered_at ASC
              LIMIT 100`,
            [characterId]
        );
        return rows;
    }

    static async getQuestLog(campaignId) {
        const [rows] = await pool.execute(
            `SELECT quest_name, quest_type, description, status, progress, notes, location, created_at, completed_at
               FROM dnd_campaign_quests
              WHERE campaign_id = ?
              ORDER BY FIELD(status, 'active', 'available', 'completed', 'failed', 'abandoned', 'unknown'),
                       COALESCE(updated_at, created_at) DESC
              LIMIT 50`,
            [campaignId]
        );
        return rows;
    }

    static async getNpcs(campaignId) {
        const [rows] = await pool.execute(
            `SELECT npc_name, description, location, is_alive, created_at, last_seen_at
               FROM dnd_campaign_npcs
              WHERE campaign_id = ? AND is_active = 1
              ORDER BY COALESCE(last_seen_at, created_at) DESC
              LIMIT 50`,
            [campaignId]
        );
        return rows;
    }

    static async getLocations(campaignId) {
        const [rows] = await pool.execute(
            `SELECT location_name, location_type, connections, npcs_present, created_at, last_visited_at
               FROM dnd_campaign_locations
              WHERE campaign_id = ?
              ORDER BY created_at ASC
              LIMIT 50`,
            [campaignId]
        );
        return rows;
    }
}

export default RPGWorldMemory;
export { RPGWorldMemory };
