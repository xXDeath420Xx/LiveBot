/*
 * Pure helpers for the AI DM's persistent world memory (core/rpg-world-memory.js).
 * No database, no discord.js — unit-tested in tests/rpg-world-memory.test.js.
 *
 *   parseQuestTag()      {{QUEST:Name:ACTION:detail}} -> { name, action, detail }
 *   inferLocationType()  free-text place name -> dnd_campaign_locations.location_type ENUM
 *   resolveZoneId()      free-text place name -> a dnd_zones id when it names one, else the name
 *   addToJsonList()      append-unique into a JSON array column value
 *   isRealLocation()     filters the state manager's "Unknown Location" placeholder and "???" tags
 */

export const QUEST_ACTIONS = ['start', 'update', 'complete', 'fail', 'abandon'];

const QUEST_ACTION_ALIASES = {
    start: 'start', new: 'start', begin: 'start', begun: 'start', accept: 'start', accepted: 'start',
    active: 'start', add: 'start', added: 'start', given: 'start', received: 'start', available: 'start',
    update: 'update', updated: 'update', progress: 'update', advance: 'update', advanced: 'update',
    note: 'update', step: 'update', objective: 'update',
    complete: 'complete', completed: 'complete', done: 'complete', finish: 'complete', finished: 'complete',
    success: 'complete', succeeded: 'complete', resolved: 'complete', turnin: 'complete',
    fail: 'fail', failed: 'fail', failure: 'fail', lost: 'fail',
    abandon: 'abandon', abandoned: 'abandon', drop: 'abandon', dropped: 'abandon', cancel: 'abandon', cancelled: 'abandon',
};

/** ENUM('unknown','available','active','completed','failed','abandoned') for each action. */
export const QUEST_STATUS_FOR_ACTION = {
    start: 'active', update: 'active', complete: 'completed', fail: 'failed', abandon: 'abandoned',
};

export function normalizeQuestAction(raw) {
    const key = String(raw || '').toLowerCase().replace(/[^a-z]/g, '');
    return QUEST_ACTION_ALIASES[key] || null;
}

/**
 * Parse the inside of a {{QUEST:...}} tag (everything after "QUEST:").
 *
 *   "The Missing Miller:START:Find the miller's son in the woods"
 *   "The Missing Miller:UPDATE:Found tracks heading north"
 *   "The Missing Miller:COMPLETE"
 *   "The Missing Miller"                       -> treated as START (the DM named a new quest)
 *   "START:The Missing Miller:Find the son"     -> action-first is accepted too
 *
 * Quest names are capped at 255 chars (VARCHAR(255)); details at 500.
 * Returns null when no usable name is present.
 */
export function parseQuestTag(inner) {
    const raw = String(inner || '').split(':');      // detail keeps its own colons and spacing
    const parts = raw.map(s => s.trim());
    if (!parts.length || !parts[0]) return null;

    let name;
    let action;
    let detailFrom;

    const firstAsAction = normalizeQuestAction(parts[0]);
    const secondAsAction = parts.length > 1 ? normalizeQuestAction(parts[1]) : null;

    if (secondAsAction) {
        name = parts[0];
        action = secondAsAction;
        detailFrom = 2;
    } else if (firstAsAction && parts.length > 1 && parts[1]) {
        action = firstAsAction;
        name = parts[1];
        detailFrom = 2;
    } else {
        // No recognisable action word: the whole thing up to the first colon is the name and
        // whatever follows is a description of a newly offered quest.
        name = parts[0];
        action = 'start';
        detailFrom = 1;
    }

    name = name.replace(/^["'*_\s]+|["'*_\s]+$/g, '').replace(/\s+/g, ' ').slice(0, 255).trim();
    if (!name || /^\?+$/.test(name)) return null;
    const detail = raw.slice(detailFrom).join(':').replace(/\s+/g, ' ').trim().slice(0, 500) || null;
    return { name, action, detail };
}

/** How a processed quest tag reads in the narration. Avoids the words "quest complete/failed" in
 * that order — the natural-language GAME_OVER fallback looks for exactly that phrase. */
export function renderQuestEvent({ name, action, detail }) {
    switch (action) {
        case 'start': return `📜 **New quest:** ${name}${detail ? ` — *${detail}*` : ''}`;
        case 'update': return `📜 **Quest log updated:** ${name}${detail ? ` — *${detail}*` : ''}`;
        case 'complete': return `✅ **Completed:** ${name}`;
        case 'fail': return `❌ **Failed:** ${name}`;
        case 'abandon': return `🚫 **Abandoned:** ${name}`;
        default: return `📜 ${name}`;
    }
}

const LOCATION_TYPE_RULES = [
    ['room', /\b(room|chamber|cell|corridor|hallway|antechamber|vestibule|study|cellar|attic)\b/i],
    ['dungeon', /\b(dungeon|crypt|tomb|catacombs?|cave|caves|cavern|lair|mine|mines|sewers?|vault|barrow|pit|labyrinth|underdark|grotto|den)\b/i],
    ['building', /\b(tavern|inn|temple|shrine|church|chapel|shop|store|smithy|forge|tower|castle|keep|manor|mansion|hall|library|guild|house|cottage|hut|market|warehouse|barracks|fort|fortress|palace|abbey|monastery|stable|mill|lighthouse|academy|prison|jail)\b/i],
    ['city', /\b(city|capital|metropolis)\b/i],
    ['village', /\b(village|hamlet|settlement|camp|encampment|outpost)\b/i],
    ['town', /\b(town|port|harbor|harbour|haven|burg|ville)\b/i],
    ['wilderness', /\b(forest|woods?|wood|swamp|marsh|bog|mountains?|peaks?|hills?|plains?|desert|wastes?|road|path|trail|river|lake|coast|shore|beach|field|fields|meadows?|tundra|jungle|glade|valley|canyon|pass|wilds|wilderness|grove|sea|ocean|island|badlands|steppe|moor)\b/i],
    ['landmark', /\b(statue|bridge|gate|gates|monument|ruins?|standing stones|obelisk|well|crossroads|altar|circle|portal|waterfall)\b/i],
];

/** Map a free-text place name onto ENUM('city','town','village','dungeon','wilderness','building','room','landmark'). */
export function inferLocationType(name) {
    const s = String(name || '');
    for (const [type, re] of LOCATION_TYPE_RULES) {
        if (re.test(s)) return type;
    }
    return 'town'; // the column's own default: a named, unqualified place ("Oakhaven") is usually a settlement
}

/** The state manager's placeholder and malformed tags are not places anyone discovered. */
export function isRealLocation(name) {
    const s = String(name || '').trim();
    if (!s) return false;
    if (/^\?+$/.test(s)) return false;
    return s.toLowerCase() !== 'unknown location';
}

/** Trim a place name for VARCHAR storage. */
export function clipName(name, max) {
    return String(name || '').replace(/\s+/g, ' ').trim().slice(0, max).trim();
}

/**
 * dnd_zone_discoveries.zone_id / dnd_characters.current_zone are VARCHAR(50). When the DM names one
 * of the static world zones ("Whispering Forest", "town", "the Crystal Caves") use its id so the
 * shop/enemy/zone features line up; otherwise keep the (trimmed) free-text name.
 *
 * zones: [{ zone_id, zone_name }]
 */
export function resolveZoneId(location, zones = []) {
    const raw = clipName(location, 255);
    if (!raw) return null;
    const norm = (s) => String(s || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
    const n = norm(raw);
    for (const z of zones) {
        if (!z) continue;
        if (norm(z.zone_id) === n || norm(String(z.zone_id).replace(/_/g, ' ')) === n || norm(z.zone_name) === n) {
            return String(z.zone_id).slice(0, 50);
        }
    }
    return raw.slice(0, 50).trim();
}

/** Keep the newest `max` quest-note lines, each bounded, so dnd_campaign_quests.notes never outgrows TEXT. */
export function appendQuestNote(existing, note, max = 10) {
    const lines = String(existing || '').split('\n').map(s => s.trim()).filter(Boolean);
    const n = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (n && lines[lines.length - 1] !== n) lines.push(n);
    return lines.slice(-max).join('\n') || null;
}

export function lastQuestNote(notes) {
    const lines = String(notes || '').split('\n').map(s => s.trim()).filter(Boolean);
    return lines.length ? lines[lines.length - 1] : null;
}

/** Parse a JSON-array column value, tolerating NULL / malformed data. */
export function parseJsonList(value) {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined || value === '') return [];
    try {
        const v = JSON.parse(value);
        return Array.isArray(v) ? v : [];
    } catch {
        return [];
    }
}

/** Append `item` to a JSON array value if not already present (case-insensitive); returns a JSON string. */
export function addToJsonList(value, item, max = 50) {
    const list = parseJsonList(value).map(String);
    const s = String(item || '').trim();
    if (s && !list.some(x => x.toLowerCase() === s.toLowerCase())) list.push(s);
    return JSON.stringify(list.slice(-max));
}

/**
 * The "## World Memory" block of the DM's system prompt, built from what rpg-world-memory loaded.
 * world: { quests: [{quest_name, status, description, notes, quest_type}], npcs: [{npc_name, description,
 *          location, is_alive}], locations: [{location_name, location_type}], timeOfDay, weather }
 * Bounded so a long campaign cannot balloon the prompt.
 */
export function buildWorldPromptSection(world) {
    if (!world) return '';
    const out = [];
    const active = (world.quests || []).filter(q => q.status === 'active');
    const closed = (world.quests || []).filter(q => q.status === 'completed' || q.status === 'failed');
    if (active.length) {
        out.push('## Quest Log — Active');
        for (const q of active.slice(0, 10)) {
            const note = q.lastNote ? ` (latest: ${q.lastNote})` : '';
            out.push(`- ${q.quest_name}${q.quest_type === 'main' ? ' [main]' : ''}: ${q.description || 'No description'}${note}`);
        }
    }
    if (closed.length) {
        out.push('## Quest Log — Resolved (do not re-offer these)');
        out.push(closed.slice(0, 8).map(q => `${q.quest_name} (${q.status})`).join('; '));
    }
    const npcs = world.npcs || [];
    if (npcs.length) {
        out.push('## Known NPCs (keep their names, personalities and fates consistent)');
        for (const n of npcs.slice(0, 15)) {
            const bits = [n.description, n.location ? `last seen: ${n.location}` : null, n.is_alive === 0 ? 'DEAD' : null].filter(Boolean);
            out.push(`- ${n.npc_name}${bits.length ? ` — ${bits.join('; ')}` : ''}`);
        }
    }
    const locs = world.locations || [];
    if (locs.length) {
        out.push('## Places the party has been');
        out.push(locs.slice(0, 15).map(l => l.location_name).join(', '));
    }
    const env = [world.timeOfDay ? `time: ${world.timeOfDay}` : null, world.weather ? `weather: ${world.weather}` : null].filter(Boolean);
    if (env.length) out.push(`## Environment — ${env.join(', ')}`);
    return out.length ? `\n\n${out.join('\n')}` : '';
}
