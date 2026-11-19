import { SEGMENTS } from './activity-audit.js';

/**
 * Compound filtering over an audit's member rows.
 *
 * One shared implementation because the same filter has to mean the same thing in three
 * places: the dashboard table you look at, the count you are shown before a bulk action,
 * and the set of members that action actually touches. If the table and the action
 * disagreed by even one row, someone gets kicked who was never on screen.
 *
 * Every field is optional and they AND together. Segments are the exception — those are
 * any-of, because "voice only OR spoke once" is a question people actually ask, and
 * AND-ing them would silently produce an empty set.
 */

const segmentByKey = new Map(SEGMENTS.map(s => [s.key, s]));

export const FILTER_FIELDS = [
    { key: 'segments', type: 'segment-list', label: 'In any of these groups' },
    { key: 'messagesMin', type: 'int', label: 'Messages at least' },
    { key: 'messagesMax', type: 'int', label: 'Messages at most' },
    { key: 'voiceSecondsMin', type: 'int', label: 'Voice seconds at least' },
    { key: 'voiceSecondsMax', type: 'int', label: 'Voice seconds at most' },
    { key: 'voiceSessionsMin', type: 'int', label: 'Voice sessions at least' },
    { key: 'voiceSessionsMax', type: 'int', label: 'Voice sessions at most' },
    { key: 'channelsMin', type: 'int', label: 'Channels posted in at least' },
    { key: 'daysSinceActiveMin', type: 'int', label: 'Quiet for at least (days)' },
    { key: 'daysSinceActiveMax', type: 'int', label: 'Quiet for at most (days)' },
    { key: 'neverActiveOnly', type: 'bool', label: 'Never active at all' },
    { key: 'membershipDaysMin', type: 'int', label: 'In the server at least (days)' },
    { key: 'membershipDaysMax', type: 'int', label: 'In the server at most (days)' },
    { key: 'hasRoles', type: 'role-list', label: 'Has any of these roles' },
    { key: 'lacksRoles', type: 'role-list', label: 'Has none of these roles' },
    { key: 'includeLeft', type: 'bool', label: 'Include members who left' },
    { key: 'includeBots', type: 'bool', label: 'Include bots' },
    { key: 'search', type: 'text', label: 'Name or handle contains' },
];

/** Normalise anything user-supplied into a filter object with only known keys. */
export function normaliseFilter(raw = {}) {
    const int = (v) => {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? Math.trunc(n) : null;
    };
    const ids = (v) => (Array.isArray(v) ? v : [])
        .map(String).filter(x => /^\d{17,20}$/.test(x)).slice(0, 25);

    return {
        segments: (Array.isArray(raw.segments) ? raw.segments : [])
            .filter(k => segmentByKey.has(k) && k !== 'all').slice(0, 15),
        messagesMin: int(raw.messagesMin),
        messagesMax: int(raw.messagesMax),
        voiceSecondsMin: int(raw.voiceSecondsMin),
        voiceSecondsMax: int(raw.voiceSecondsMax),
        voiceSessionsMin: int(raw.voiceSessionsMin),
        voiceSessionsMax: int(raw.voiceSessionsMax),
        channelsMin: int(raw.channelsMin),
        daysSinceActiveMin: int(raw.daysSinceActiveMin),
        daysSinceActiveMax: int(raw.daysSinceActiveMax),
        neverActiveOnly: Boolean(raw.neverActiveOnly),
        membershipDaysMin: int(raw.membershipDaysMin),
        membershipDaysMax: int(raw.membershipDaysMax),
        hasRoles: ids(raw.hasRoles),
        lacksRoles: ids(raw.lacksRoles),
        includeLeft: Boolean(raw.includeLeft),
        includeBots: Boolean(raw.includeBots),
        search: typeof raw.search === 'string' ? raw.search.trim().slice(0, 80) : '',
    };
}

/**
 * @param {Object[]} members - decorated rows from loadAudit()
 * @param {Object} filter - already through normaliseFilter()
 * @param {Object} ctx - { nowMs, windowStartMs }
 * @param {Map<string,string[]>} [roleMap] - userId -> roleIds, for role conditions
 */
export function applyFilter(members, filter, ctx, roleMap = null) {
    const f = filter;
    const term = f.search.toLowerCase();

    return members.filter(m => {
        if (!f.includeBots && m.isBot) return false;
        if (!f.includeLeft && !m.inGuild) return false;

        if (f.segments.length) {
            const hit = f.segments.some(k => segmentByKey.get(k).predicate(m, ctx));
            if (!hit) return false;
        }

        if (f.neverActiveOnly && (m.messages > 0 || m.voiceSeconds > 0)) return false;

        if (f.messagesMin !== null && m.messages < f.messagesMin) return false;
        if (f.messagesMax !== null && m.messages > f.messagesMax) return false;
        if (f.voiceSecondsMin !== null && m.voiceSeconds < f.voiceSecondsMin) return false;
        if (f.voiceSecondsMax !== null && m.voiceSeconds > f.voiceSecondsMax) return false;
        if (f.voiceSessionsMin !== null && m.voiceSessions < f.voiceSessionsMin) return false;
        if (f.voiceSessionsMax !== null && m.voiceSessions > f.voiceSessionsMax) return false;
        if (f.channelsMin !== null && m.channelsPosted < f.channelsMin) return false;

        // daysSinceActive is null for members who were never active at all. Treating that as
        // 0 would hide exactly the people a "quiet for 60+ days" filter is looking for, and
        // treating it as Infinity would sweep them into every dormancy filter whether or not
        // that was intended — so it only satisfies a minimum, never a maximum.
        if (f.daysSinceActiveMin !== null) {
            if (m.daysSinceActive === null) { /* never active — counts as maximally quiet */ }
            else if (m.daysSinceActive < f.daysSinceActiveMin) return false;
        }
        if (f.daysSinceActiveMax !== null) {
            if (m.daysSinceActive === null) return false;
            if (m.daysSinceActive > f.daysSinceActiveMax) return false;
        }

        if (f.membershipDaysMin !== null || f.membershipDaysMax !== null) {
            // Unknown join date cannot satisfy a membership-length condition. Guessing here
            // would put members of unknown tenure into a "been here long enough to kick" set.
            if (!m.joinedGuildAt) return false;
            const days = Math.floor((ctx.nowMs - Date.parse(m.joinedGuildAt)) / 86400000);
            if (f.membershipDaysMin !== null && days < f.membershipDaysMin) return false;
            if (f.membershipDaysMax !== null && days > f.membershipDaysMax) return false;
        }

        if (f.hasRoles.length || f.lacksRoles.length) {
            const roles = roleMap?.get(m.userId);
            // No role data means the condition cannot be evaluated. Failing closed keeps an
            // un-evaluated "must not have Staff" from letting staff through into a kick set.
            if (!roles) return false;
            if (f.hasRoles.length && !f.hasRoles.some(r => roles.includes(r))) return false;
            if (f.lacksRoles.length && f.lacksRoles.some(r => roles.includes(r))) return false;
        }

        if (term) {
            const hay = `${m.displayName ?? ''} ${m.username ?? ''}`.toLowerCase();
            if (!hay.includes(term)) return false;
        }

        return true;
    });
}

/** A short human sentence describing what a filter selects, for confirmation prompts. */
export function describeFilter(filter) {
    const bits = [];
    if (filter.segments.length) {
        bits.push('in ' + filter.segments.map(k => segmentByKey.get(k)?.label ?? k).join(' or '));
    }
    if (filter.neverActiveOnly) bits.push('with no activity at all');
    const range = (min, max, unit) => {
        if (min !== null && max !== null) return `${min}–${max} ${unit}`;
        if (min !== null) return `${min}+ ${unit}`;
        if (max !== null) return `at most ${max} ${unit}`;
        return null;
    };
    const m = range(filter.messagesMin, filter.messagesMax, 'messages'); if (m) bits.push(m);
    // Voice TIME is a separate condition from voice SESSIONS. Describing only sessions let
    // a filter of "no voice at all" print as though it constrained messages alone — an
    // understated summary on a confirmation prompt for an irreversible action.
    if (filter.voiceSecondsMax === 0) bits.push('with no voice time');
    else {
        const vt = range(
            filter.voiceSecondsMin === null ? null : Math.round(filter.voiceSecondsMin / 60),
            filter.voiceSecondsMax === null ? null : Math.round(filter.voiceSecondsMax / 60),
            'minutes of voice');
        if (vt) bits.push(vt);
    }
    if (filter.voiceSessionsMax === 0) bits.push('who never joined voice');
    else {
        const vs = range(filter.voiceSessionsMin, filter.voiceSessionsMax, 'voice sessions');
        if (vs) bits.push(vs);
    }
    const ch = range(filter.channelsMin, null, 'channels posted in'); if (ch) bits.push(ch);
    const q = range(filter.daysSinceActiveMin, filter.daysSinceActiveMax, 'days quiet'); if (q) bits.push(q);
    const mem = range(filter.membershipDaysMin, filter.membershipDaysMax, 'days in the server'); if (mem) bits.push(mem);
    if (filter.hasRoles.length) bits.push(`holding ${filter.hasRoles.length} specified role(s)`);
    if (filter.lacksRoles.length) bits.push(`without ${filter.lacksRoles.length} specified role(s)`);
    if (filter.search) bits.push(`matching “${filter.search}”`);
    if (filter.includeLeft) bits.push('including members who left');
    return bits.length ? `Members ${bits.join(', ')}` : 'All members in the audit';
}
