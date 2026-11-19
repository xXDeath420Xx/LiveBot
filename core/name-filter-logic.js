/*
 * Name filters — the pure rules (no Discord or DB access; unit-tested in tests/name-filters.test.js).
 * The live side is core/name-filters.js.
 *
 * A name filter is a row of automod_patterns with target = 'name' (the message patterns of
 * `/protection spam pattern-*` are the same table with target = 'message'), checked against a
 * member's three names: username, global display name and server nickname.
 *
 *   phrase  the name contains this text            stored pattern_type 'contains'
 *   regex   a regular expression                   stored pattern_type 'regex'
 *   exact   the whole name is this (Auto-Pilot)    stored pattern_type 'exact'
 *
 * With fuzzy matching on (the default) a name is compared in several forms from utils/text-fold.js,
 * so one plain word covers its disguises: lookalike letters, accents and zalgo, invisible
 * characters and leetspeak (and, with "collapse", separators and repeated letters). Phrases and
 * exact names compare skeleton to skeleton; regexes are tried against each form.
 *
 * Regexes are untrusted input run on every join and rename, so they get the guards the message
 * patterns have (core/automod-patterns.js): dangerous shapes refused when saved, input capped, and
 * matching inside node:vm with a timeout. On top of that, a name regex may not have an empty
 * alternative, match an empty name, or match a third of a list of ordinary names.
 */
import crypto from 'node:crypto';
import { textForms, foldConfusables, skeleton, collapse } from '../utils/text-fold.js';
import {
    findDangerousConstruct, findEmptyAlternative, probeRegex, safeRegexEach, MAX_REGEX_LENGTH, REGEX_TIMEOUT_MS,
} from './automod-patterns.js';
import { GENERATED_NAME_WORDS } from './name-filter-templates.js';

export const NAME_FILTER_TYPES = Object.freeze(['phrase', 'regex', 'exact']);
export const STORED_TYPE = Object.freeze({ phrase: 'contains', regex: 'regex', exact: 'exact' });
export const TYPE_OF_STORED = Object.freeze({ contains: 'phrase', regex: 'regex', exact: 'exact' });
export const NAME_ACTIONS = Object.freeze(['log', 'flag', 'timeout', 'kick', 'ban']);
export const SEVERITY = Object.freeze({ log: 0, flag: 1, timeout: 2, kick: 3, ban: 4 });
export const FIELD_LABEL = Object.freeze({ username: 'username', display: 'display name', nickname: 'server nickname' });
export const FORM_LABEL = Object.freeze({
    raw: 'as written', folded: 'lookalikes folded', leet: 'leetspeak folded', leetL: 'leetspeak folded',
    skeleton: 'lookalikes folded', collapsed: 'separators removed',
});

export const MIN_PHRASE_CHARS = 3;
export const MAX_PHRASE_CHARS = 100;
export const MAX_NAME_REGEX = MAX_REGEX_LENGTH;
export const MIN_AUTO_NAME = 4;
export const MAX_NAME_FILTERS = 1000;      // every origin together
export const MAX_MANUAL_FILTERS = 500;
export const MAX_NAME_INPUT = 128;          // Discord caps names at 32; NFKC can lengthen them
export const NAME_BATCH_TIMEOUT_MS = 50;

// Ordinary names a filter must not sweep up wholesale. A filter that matches a third of these
// would hit a large part of any server.
export const ORDINARY_NAMES = Object.freeze([
    'alex', 'Sarah', 'mike_92', 'jessica.w', 'GamerGuy', 'xXShadowXx', 'Luna', 'tom', 'Chris P',
    'nightowl', 'pixel_artist', 'BigDave', 'emma2004', 'Kai', 'the_real_sam', 'Noodle', 'J0rdan',
    'Maria Lopez', 'sleepyhead', 'coffee lover', 'Ash', 'ryan.k', 'MinecraftFan', 'Zoe', 'darkwolf',
    'Ben', 'happy camper', 'lily_rose', 'Max Power', 'oliver', 'sophie123', 'Dan the Man', 'kat',
]);

// Usernames cannot hold spaces, so "support_team" and "support.team" are how "support team" is
// written there: for phrases, runs of spaces, underscores, dots and hyphens all count as one space.
const spaced = (s) => String(s ?? '').replace(/[\s_.\-]+/g, ' ').trim();

/** 'log' | 'flag' | 'timeout' | 'kick' | 'ban'; anything unknown is `fallback`. */
export function normaliseNameAction(value, fallback = 'log') {
    const v = String(value ?? '').toLowerCase();
    return NAME_ACTIONS.includes(v) ? v : fallback;
}

/** The comparison key for exact names: skeleton with every separator removed ("Mod.Bob" = "modbob"). */
export function exactKey(text, { fuzzy = true } = {}) {
    const base = fuzzy ? skeleton(text) : String(text ?? '').toLowerCase();
    return base.replace(/[^\p{L}\p{N}]/gu, '');
}

function compileRegex(source, caseSensitive) {
    try {
        return new RegExp(source, caseSensitive ? '' : 'i');
    } catch {
        return null;
    }
}

/**
 * Validate a filter before it is stored.
 * @returns {{ ok:true, value:string } | { ok:false, error:string }}
 */
export function validateNameFilter(type, raw, { caseSensitive = false, regexTimeoutMs = REGEX_TIMEOUT_MS } = {}) {
    if (!NAME_FILTER_TYPES.includes(type)) return { ok: false, error: `Unknown filter type "${type}".` };
    const value = type === 'regex' ? String(raw ?? '').trim() : String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!value) return { ok: false, error: 'The filter is empty.' };

    if (type === 'phrase') {
        if (value.length > MAX_PHRASE_CHARS) return { ok: false, error: `Phrases are limited to ${MAX_PHRASE_CHARS} characters.` };
        if (exactKey(value).length < MIN_PHRASE_CHARS) {
            return { ok: false, error: `A phrase needs at least ${MIN_PHRASE_CHARS} letters or digits; shorter ones are inside ordinary names.` };
        }
    } else if (type === 'exact') {
        if (value.length > MAX_PHRASE_CHARS) return { ok: false, error: `Names are limited to ${MAX_PHRASE_CHARS} characters.` };
        if (exactKey(value).length < 2) return { ok: false, error: 'The name needs at least 2 letters or digits.' };
    } else {
        if (value.length > MAX_NAME_REGEX) return { ok: false, error: `Regex filters are limited to ${MAX_NAME_REGEX} characters.` };
        const danger = findDangerousConstruct(value) || findEmptyAlternative(value);
        if (danger) return { ok: false, error: `Refused: ${danger}.` };
        const re = compileRegex(value, caseSensitive);
        if (!re) {
            try { new RegExp(value); } catch (err) { return { ok: false, error: `Invalid regex: ${err.message}` }; }
            return { ok: false, error: 'Invalid regex.' };
        }
        const probe = probeRegex(re, '', regexTimeoutMs);
        if (probe.timedOut) return { ok: false, error: 'Refused: the regex is too slow to evaluate.' };
        if (probe.matched) return { ok: false, error: 'Refused: that regex matches an empty name, so it would match everyone.' };
    }

    // Too broad: hits a third of the ordinary names.
    const filter = compileFilter({ id: 0, pattern_type: STORED_TYPE[type], pattern: value, case_sensitive: caseSensitive ? 1 : 0, action: 'log' });
    if (!filter) return { ok: false, error: 'Invalid filter.' };
    // Same budget as the probe above (callers that pass a bigger one get it here too).
    const runner = (jobs, ms) => safeRegexEach(jobs, Math.max(ms ?? REGEX_TIMEOUT_MS, regexTimeoutMs));
    const hits = ORDINARY_NAMES.filter(n => matchNames([filter], [{ field: 'username', text: n }], { fuzzy: true, runner }).match);
    if (hits.length >= Math.ceil(ORDINARY_NAMES.length / 3)) {
        return { ok: false, error: `Refused: it matches ordinary names like ${hits.slice(0, 3).map(h => `"${h}"`).join(', ')}, so it would hit most of the server.` };
    }
    return { ok: true, value };
}

/**
 * A stored row ready to match: { id, type, value, action, caseSensitive, origin, autoUserId, ... }.
 * null when a stored regex no longer compiles.
 */
export function compileFilter(row) {
    const type = TYPE_OF_STORED[row.pattern_type];
    if (!type) return null;
    const caseSensitive = !!Number(row.case_sensitive ?? 0);
    const value = String(row.pattern ?? '');
    const out = {
        id: Number(row.id),
        type,
        value,
        action: normaliseNameAction(row.action),
        caseSensitive,
        origin: row.origin ?? 'manual',
        autoUserId: row.auto_user_id ?? null,
        sourceKey: row.source_key ?? null,
    };
    if (type === 'regex') {
        out.re = compileRegex(value, caseSensitive);
        if (!out.re) return null;
    } else if (type === 'phrase') {
        out.lower = spaced(value.toLowerCase());
        out.skel = spaced(skeleton(value));
        out.collapsed = collapse(out.skel);
        out.foldedCase = foldConfusables(value, { keepCase: true });
    } else {
        out.key = exactKey(value);
        out.plainKey = exactKey(value, { fuzzy: false });
    }
    return out;
}

/** The names a member is known by: [{ field, text }], blanks and repeats left out. */
export function nameFieldsOf({ username = null, globalName = null, nickname = null } = {}) {
    const out = [];
    const seen = new Set();
    for (const [field, text] of [['username', username], ['display', globalName], ['nickname', nickname]]) {
        const t = String(text ?? '').trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        out.push({ field, text: t.slice(0, MAX_NAME_INPUT) });
    }
    return out;
}

/** Short stable hash of a member's names: a "mark safe" holds only while the names stay the same. */
export function namesHash(fields) {
    return crypto.createHash('sha1').update(JSON.stringify(fields.map(f => [f.field, f.text]))).digest('hex').slice(0, 16);
}

function prepare(field, opts) {
    const forms = textForms(field.text, { maxLength: MAX_NAME_INPUT, collapseRepeats: !!opts.collapse });
    return {
        ...field,
        forms,
        lower: spaced(forms.raw.toLowerCase()),
        skel: spaced(forms.skeleton),
        foldedCase: opts.fuzzy ? foldConfusables(forms.raw, { keepCase: true }) : null,
        key: exactKey(forms.raw),
        plainKey: exactKey(forms.raw, { fuzzy: false }),
        // collapse(leet) keeps letters a regex can still read; collapse(skeleton) is for phrases.
        regexCollapsed: opts.collapse ? collapse(forms.leet) : null,
    };
}

/** Which form of one name a phrase or exact filter matches, or null. */
function matchPlain(filter, p, opts) {
    if (filter.type === 'phrase') {
        if (filter.caseSensitive) {
            if (p.forms.raw.includes(filter.value)) return 'raw';
            if (opts.fuzzy && p.foldedCase.includes(filter.foldedCase)) return 'folded';
            return null;
        }
        if (p.lower.includes(filter.lower)) return 'raw';
        if (!opts.fuzzy) return null;
        if (p.skel.includes(filter.skel)) return 'skeleton';
        if (opts.collapse && filter.collapsed.length >= MIN_PHRASE_CHARS && p.forms.collapsed.includes(filter.collapsed)) return 'collapsed';
        return null;
    }
    // exact
    if (filter.caseSensitive) return p.forms.raw === filter.value ? 'raw' : null;
    if (p.plainKey && p.plainKey === filter.plainKey) return 'raw';
    if (opts.fuzzy && p.key && p.key === filter.key) return 'skeleton';
    return null;
}

/** The inputs one regex filter is tried against for one name, with the form each came from. */
function regexInputs(filter, p, opts) {
    const list = [['raw', p.forms.raw]];
    if (opts.fuzzy) {
        if (filter.caseSensitive) list.push(['folded', p.foldedCase]);
        else {
            list.push(['folded', p.forms.folded], ['leet', p.forms.leet]);
            if (p.forms.leetL) list.push(['leetL', p.forms.leetL]);
            if (p.regexCollapsed) list.push(['collapsed', p.regexCollapsed]);
        }
    }
    const seen = new Set();
    return list.filter(([, text]) => text && !seen.has(text) && seen.add(text));
}

/**
 * Check names against filters.
 * @param filters  compiled filters (compileFilter)
 * @param fields   nameFieldsOf(...)
 * @param opts     { fuzzy, collapse, memberId } — an Auto-Pilot filter never matches the member it protects
 * @returns {{ match: object|null, matches: object[], timedOut: number[] }}
 *          a match is { filter, field, text, form }; `match` is the most severe (ban > kick > … > log)
 */
export function matchNames(filters, fields, { fuzzy = true, collapse: collapseOpt = false, memberId = null, runner = safeRegexEach } = {}) {
    const opts = { fuzzy, collapse: collapseOpt };
    const prepared = fields.map(f => prepare(f, opts));
    const matches = [];
    const timedOut = [];
    const regexJobs = [];   // [{ filter, inputs: [[form, text, prepared]] }]

    for (const filter of filters) {
        if (!filter || (filter.autoUserId && memberId && filter.autoUserId === memberId)) continue;
        if (filter.type === 'regex') {
            const inputs = [];
            for (const p of prepared) for (const [form, text] of regexInputs(filter, p, opts)) inputs.push([form, text, p]);
            if (inputs.length) regexJobs.push({ filter, inputs });
            continue;
        }
        for (const p of prepared) {
            const form = matchPlain(filter, p, opts);
            if (form) { matches.push({ filter, field: p.field, text: p.text, form }); break; }
        }
    }

    if (regexJobs.length) {
        const texts = (job) => job.inputs.map(i => i[1]);
        let result = runner(regexJobs.map(j => [j.filter.re, texts(j)]), NAME_BATCH_TIMEOUT_MS);
        if (result.timedOut) {
            // Find the slow pattern(s): one at a time, each with the normal per-regex limit.
            result = { hits: [] };
            regexJobs.forEach((job, index) => {
                const one = runner([[job.filter.re, texts(job)]]);
                if (one.timedOut) timedOut.push(job.filter.id);
                else if (one.hits?.length) result.hits.push({ job: index, input: one.hits[0].input });
            });
        }
        for (const hit of result.hits ?? []) {
            const job = regexJobs[hit.job];
            const [form, , p] = job.inputs[hit.input];
            matches.push({ filter: job.filter, field: p.field, text: p.text, form });
        }
    }

    let match = null;
    for (const m of matches) {
        const a = SEVERITY[m.filter.action];
        const b = match ? SEVERITY[match.filter.action] : -1;
        if (a > b || (a === b && m.filter.id < match.filter.id)) match = m;
    }
    return { match, matches, timedOut };
}

/** How a name looks in each form, for the test box. */
export function describeForms(text, { collapse: collapseOpt = false } = {}) {
    const f = textForms(text, { maxLength: MAX_NAME_INPUT, collapseRepeats: collapseOpt });
    return { raw: f.raw, folded: f.folded, leet: f.leet, skeleton: f.skeleton, collapsed: f.collapsed };
}

// ── generated usernames ──────────────────────────────────────────────────────

const GENERATED_RE = /^([a-z]{3,12})([._])([a-z]{3,12})\2?(\d{2,6})$/;

/**
 * `word_word_1234` / `word.word.1234` where BOTH words are in the generator vocabulary.
 * @returns {{ first:string, second:string, digits:string } | null}
 */
export function generatedUsername(username, words = GENERATED_NAME_WORDS) {
    const m = String(username ?? '').match(GENERATED_RE);
    if (!m) return null;
    const [, first, , second, digits] = m;
    return words.has(first) && words.has(second) ? { first, second, digits } : null;
}

// ── planning ─────────────────────────────────────────────────────────────────

/**
 * Sort members a scan matched into what to queue and why the rest are left alone.
 * candidates: [{ id, bot, owner, staff, exempt, safeHash, namesHash, match }]
 * @returns {{ queue: object[], skipped: { bots:string[], staff:string[], exempt:string[], safe:string[] }, clean:number }}
 */
export function planCleanse(candidates) {
    const out = { queue: [], skipped: { bots: [], staff: [], exempt: [], safe: [] }, clean: 0 };
    for (const c of candidates) {
        if (c.bot) { out.skipped.bots.push(c.id); continue; }
        if (!c.match) { out.clean++; continue; }
        if (c.owner || c.staff) out.skipped.staff.push(c.id);
        else if (c.exempt) out.skipped.exempt.push(c.id);
        else if (c.safeHash && c.safeHash === c.namesHash) out.skipped.safe.push(c.id);
        else out.queue.push(c);
    }
    return out;
}

/**
 * Force mode: act now on each queued member with the matched filter's own action; log-only
 * matches still go to the review queue.
 * @returns {{ act: object[], review: object[] }}
 */
export function splitForce(queue) {
    const act = [];
    const review = [];
    // A generated-username match has no filter; it carries the check's own action.
    for (const c of queue) ((c.match.filter?.action ?? c.match.action ?? 'log') === 'log' ? review : act).push(c);
    return { act, review };
}

/**
 * Auto-Pilot: the exact-name filters that should exist for protected staff, against what does.
 * protectedMembers: [{ id, names: string[] }]
 * owners:           Map(exactKey -> Set(memberId)) over every cached member
 * existing:         [{ id, autoUserId, key, removed }]  (removed = deleted by staff; never recreated)
 * @returns {{ create: Array<{ userId, key, text }>, retire: number[] }}
 */
export function planAutoPilot({ protectedMembers, owners, existing }) {
    const have = new Map(existing.map(r => [`${r.autoUserId}:${r.key}`, r]));
    const want = new Map();   // `${userId}:${key}` -> { userId, key, text }
    for (const m of protectedMembers) {
        for (const text of m.names) {
            const key = exactKey(text);
            if (key.length < MIN_AUTO_NAME) continue;                         // too short to be safe
            const id = `${m.id}:${key}`;
            // Someone else already has the name: not a safe filter to create. Once one exists it is
            // kept, though: an impersonator taking the name afterwards is exactly what it is for.
            const holders = owners.get(key);
            if (!have.has(id) && holders && [...holders].some(other => other !== m.id)) continue;
            if (!want.has(id)) want.set(id, { userId: m.id, key, text: String(text).trim() });
        }
    }
    const create = [...want.entries()].filter(([id]) => !have.has(id)).map(([, v]) => v);
    const retire = existing.filter(r => !r.removed && !want.has(`${r.autoUserId}:${r.key}`)).map(r => r.id);
    return { create, retire };
}

/**
 * Bring one server's copy of a template pack in line with the pack.
 * existing: [{ id, key (entry key), type, value, removed }]  entries: expandPack(...)
 * @returns {{ insert: object[], update: Array<{ id, entry }>, remove: number[] }}
 */
export function planTemplateSync(existing, entries) {
    const byKey = new Map(existing.map(r => [r.key, r]));
    const wanted = new Set(entries.map(e => e.key));
    const insert = [];
    const update = [];
    for (const e of entries) {
        const row = byKey.get(e.key);
        if (!row) insert.push(e);
        else if (!row.removed && (row.value !== e.value || row.type !== e.type)) update.push({ id: row.id, entry: e });
    }
    const remove = existing.filter(r => !wanted.has(r.key)).map(r => r.id);
    return { insert, update, remove };
}

/** Audit-log reason: plain ASCII, never the member's name or the pattern (they can hold anything). */
export function nameReason(match, source = 'auto') {
    const suffix = source === 'review' ? ' (review)' : source === 'cleanse' ? ' (cleanse)' : '';
    if (match?.generated) return `Name filter: generated scam username${suffix}`;
    const field = FIELD_LABEL[match?.field] ?? 'name';
    return `Name filter #${match?.filter?.id ?? '?'} matched their ${field}${suffix}`;
}

/** join_gate_events.action for an outcome. */
export function nameEventAction(action) {
    return { ban: 'name_banned', kick: 'name_kicked', timeout: 'name_timeout', flag: 'name_flagged' }[action] ?? 'name_logged';
}

/** A short human label for a filter: `phrase "support team"`. */
export function filterLabel(filter) {
    const v = filter.value.length > 60 ? `${filter.value.slice(0, 59)}…` : filter.value;
    return filter.type === 'regex' ? `regex /${v}/` : `${filter.type} "${v}"`;
}

// ── export / import (/namefilter export|import, dashboard Name Filters page) ──
// A versioned JSON file of the server's own filters (templates and Auto-Pilot entries are not exported: they
// are generated per server). Importing runs every entry through validateNameFilter — the same regex safety
// rules as adding one by hand — and previews what would be added, skipped as a duplicate or rejected.

export const NAME_EXPORT_FORMAT = 'certifried.name-filters';
export const NAME_EXPORT_VERSION = 1;
export const MAX_IMPORT_ENTRIES = 1000;

/**
 * @param {Array<{ type, pattern, action, caseSensitive, note, enabled, origin, removed }>} filters  listFilters() rows
 * @param {{ guildId?:string, guildName?:string, now?:number }} [meta]
 */
export function buildNameExport(filters, { guildId = null, guildName = null, now = Date.now() } = {}) {
    const entries = (filters || [])
        .filter(f => f.origin === 'manual' && !f.removed)
        .map(f => ({ type: f.type, pattern: f.pattern, action: f.action, caseSensitive: !!f.caseSensitive, note: f.note || null, enabled: f.enabled !== false }));
    return { format: NAME_EXPORT_FORMAT, version: NAME_EXPORT_VERSION, exportedAt: new Date(now).toISOString(), source: { guildId, guildName }, filters: entries };
}

/**
 * What importing a file would do.
 * @param {object|string} input             the parsed file (or its text)
 * @param {Array<{ type:string, pattern:string }>} existing  the server's current filters (any origin, not removed)
 * @param {{ room?:number }} [opts]          how many more manual filters fit
 * @returns {{ ok:false, error:string } | { ok:true, add:object[], duplicates:object[], rejected:object[], overCap:object[] }}
 */
export function planNameImport(input, existing = [], { room = MAX_MANUAL_FILTERS } = {}) {
    let data = input;
    if (typeof input === 'string') {
        try { data = JSON.parse(input); } catch { return { ok: false, error: 'That file is not valid JSON.' }; }
    }
    if (!data || typeof data !== 'object' || data.format !== NAME_EXPORT_FORMAT) {
        return { ok: false, error: 'That is not a name-filter export (the "format" field is missing or different).' };
    }
    if (!Number.isInteger(data.version) || data.version < 1 || data.version > NAME_EXPORT_VERSION) {
        return { ok: false, error: `Unsupported export version ${data.version}; this bot reads version ${NAME_EXPORT_VERSION}.` };
    }
    if (!Array.isArray(data.filters)) return { ok: false, error: 'The file has no filter list.' };
    if (data.filters.length > MAX_IMPORT_ENTRIES) return { ok: false, error: `The file has ${data.filters.length} filters; at most ${MAX_IMPORT_ENTRIES} can be imported at once.` };
    const key = (type, value) => `${STORED_TYPE[type] ?? type}\u0000${value}`;
    const have = new Set((existing || []).map(e => key(e.type, e.pattern)));
    const out = { ok: true, add: [], duplicates: [], rejected: [], overCap: [] };
    let left = Math.max(0, room);
    for (const raw of data.filters) {
        const e = raw && typeof raw === 'object' ? raw : {};
        const type = String(e.type ?? '');
        const shown = { type, pattern: String(e.pattern ?? '').slice(0, 200) };
        if (!NAME_FILTER_TYPES.includes(type)) { out.rejected.push({ ...shown, why: `unknown type "${type}"` }); continue; }
        const caseSensitive = e.caseSensitive === true;
        const check = validateNameFilter(type, e.pattern, { caseSensitive });
        if (!check.ok) { out.rejected.push({ ...shown, why: check.error }); continue; }
        const k = key(type, check.value);
        if (have.has(k)) { out.duplicates.push({ type, pattern: check.value }); continue; }
        have.add(k);
        const entry = { type, pattern: check.value, action: normaliseNameAction(e.action), caseSensitive,
            note: e.note ? String(e.note).slice(0, 200) : null, enabled: e.enabled !== false };
        if (left <= 0) { out.overCap.push(entry); continue; }
        left--;
        out.add.push(entry);
    }
    return out;
}

export default {
    NAME_FILTER_TYPES, NAME_ACTIONS, validateNameFilter, buildNameExport, planNameImport, compileFilter, nameFieldsOf, namesHash, matchNames,
    describeForms, generatedUsername, planCleanse, splitForce, planAutoPilot, planTemplateSync, nameReason,
    nameEventAction, filterLabel, exactKey, normaliseNameAction,
};
