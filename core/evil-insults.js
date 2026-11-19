/*
 * Evil Insult, served from our own copy of its database.
 *
 * evilinsult.com's API (generate_insult.php) answers every datacenter IP, ours included, with a
 * Cloudflare bot challenge, so it cannot be called. Its whole insult database is public domain (the
 * Unlicense: EvilInsultGenerator/media, Miscellaneous/Database/insults.sql), so the active rows live
 * in data/evil-insults.json (source and licence in data/evil-insults.SOURCE.md) and are served here:
 *
 *   random(lang, opts)   one insult for /fun insult (insult_source 'evilinsult') and the custom-command
 *                        token {evilinsult} / {evilinsult:de}. Unknown languages fall back to English.
 *                        "[Name]" in a line becomes the target's name, or "you". The same server does not
 *                        see the same line again within its last RECENT_WINDOW picks (per language).
 *                        Every pick goes through `reject` (core/hate-terms.js rejectReason bound to the
 *                        server's automod words and patterns); a hit is re-rolled, and after EVIL_TRIES
 *                        the built-in generator (core/insult-generator.js pickInsult) answers instead.
 *   answerApi(url, opts) the compatibility shim for custom commands: an {api:…} / ${customapi.…} /
 *                        $(urlfetch …) URL on evilinsult.com/generate_insult.php is answered from the
 *                        corpus without any network call, honouring lang= and type=text|json|xml, in
 *                        the same shapes the real API returns (so `{api.json:…|insult}` keeps working).
 *
 * The corpus is read once, on first use (nothing touches the disk at import). createEvilInsults({ rows })
 * builds an independent instance for tests. Tested in tests/evil-insults.test.js.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickInsult } from './insult-generator.js';

export const CORPUS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'evil-insults.json');
export const DEFAULT_LANG = 'en';
export const RECENT_WINDOW = 50;   // no repeat within a server's last 50 lines (per language)
export const EVIL_TRIES = 8;       // filtered lines re-rolled this many times before the built-in generator answers
const RECENT_KEYS_MAX = 5000;

/**
 * Languages offered on /fun insult and the dashboard: every language with a useful number of lines,
 * largest first. Codes are the corpus's own ('cn' is Chinese there). Discord allows 25 choices.
 */
export const LANGUAGES = Object.freeze([
    ['en', 'English'], ['de', 'German'], ['pt', 'Portuguese'], ['es', 'Spanish'], ['ru', 'Russian'],
    ['id', 'Indonesian'], ['ar', 'Arabic'], ['cs', 'Czech'], ['fr', 'French'], ['tr', 'Turkish'],
    ['hi', 'Hindi'], ['vi', 'Vietnamese'], ['la', 'Latin'], ['cn', 'Chinese'], ['ur', 'Urdu'],
    ['ja', 'Japanese'], ['te', 'Telugu'], ['ta', 'Tamil'], ['jv', 'Javanese'], ['mr', 'Marathi'],
    ['az', 'Azerbaijani'], ['ko', 'Korean'], ['it', 'Italian'], ['sw', 'Swahili'], ['el', 'Greek'],
].map(([code, name]) => Object.freeze({ code, name })));
const LANGUAGE_CODES = new Set(LANGUAGES.map(l => l.code));
export const isKnownLanguage = (code) => LANGUAGE_CODES.has(String(code || '').toLowerCase());

const NAME_RE = /\[name\]/gi;
const HAS_NAME = /\[name\]/i;

/** "[Name]" → the name, or "you" (capitalised at the start of the line). */
export function fillName(text, name = null) {
    const who = name ? String(name) : null;
    return String(text ?? '').replace(NAME_RE, (m, at) => who ?? (at === 0 ? 'You' : 'you'));
}

/** { lang, type } for an evilinsult.com generate_insult.php URL (any case, trailing slash ok), else null. */
export function parseEvilInsultUrl(url) {
    let u;
    try { u = new URL(String(url ?? '').trim()); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (host !== 'evilinsult.com' && host !== 'www.evilinsult.com') return null;
    if (!/^\/generate_insult\.php\/?$/i.test(u.pathname)) return null;
    const param = (name) => {
        for (const [k, v] of u.searchParams) if (k.toLowerCase() === name) return String(v).trim().toLowerCase();
        return '';
    };
    const type = param('type');
    return { lang: param('lang') || DEFAULT_LANG, type: type === 'json' || type === 'xml' ? type : 'text' };
}
export const isEvilInsultUrl = (url) => parseEvilInsultUrl(url) !== null;

const xmlEscape = (s) => String(s ?? '').replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

/**
 * The real API's JSON record: every value a string ({number, language, insult, created, shown,
 * createdby, active, comment}). A built-in fallback line has an empty number and createdby.
 */
export function apiRecord(pick) {
    const row = pick.row;
    return {
        number: row ? String(row.n) : '',
        language: pick.lang,
        insult: pick.line,
        created: row?.created ?? '',
        shown: String(row?.shown ?? 0),
        createdby: row?.createdby ?? '',
        active: '1',
        comment: row ? (row.comment ?? '') : 'built-in fallback: every Evil Insult line tried was filtered',
    };
}

/** The record as the API's type=xml answer. */
export function apiXml(record) {
    const body = Object.entries(record).map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<evilinsult>${body}</evilinsult>`;
}

/**
 * An independent insult source over `rows` ([{ n, lang, text, created?, shown?, createdby?, comment? }]),
 * or over data/evil-insults.json (read on first use) when `rows` is omitted.
 */
export function createEvilInsults({ rows = null, file = CORPUS_PATH, window = RECENT_WINDOW, tries = EVIL_TRIES } = {}) {
    let byLang = null;
    const recent = new Map(); // `${guild}|${lang}` -> [row numbers, oldest first]

    function corpus() {
        if (byLang) return byLang;
        const list = rows ?? JSON.parse(fs.readFileSync(file, 'utf8'));
        byLang = new Map();
        for (const r of list) {
            if (!r || r.active === false || !String(r.text ?? '').trim()) continue;
            const lang = String(r.lang || '').toLowerCase();
            if (!byLang.has(lang)) byLang.set(lang, []);
            byLang.get(lang).push(r);
        }
        return byLang;
    }

    /** The language actually served for a requested code: itself when it has lines, else English. */
    function resolveLang(lang) {
        const code = String(lang || '').trim().toLowerCase();
        return corpus().get(code)?.length ? code : DEFAULT_LANG;
    }

    function remember(key, n, size) {
        if (size <= 0) return;
        const list = recent.get(key) || [];
        list.push(n);
        while (list.length > size) list.shift();
        recent.delete(key);
        recent.set(key, list); // re-insert: the Map stays oldest-used first
        if (recent.size > RECENT_KEYS_MAX) recent.delete(recent.keys().next().value);
    }

    /**
     * One insult.
     * @param {string} lang  corpus language code; unknown → English
     * @param {object} o
     *   name      replaces "[Name]" (default "you"); it is not filtered (it is the target's own name)
     *   guildId   whose no-repeat window to use (null = one shared window)
     *   reject    (text) => reason|null — core/hate-terms.js rejectReason bound to the server's filter
     * @returns {Promise<{ line, lang, row, named, source: 'evilinsult'|'builtin'|'none', filtered: Array<{source, reason, number?}> }>}
     */
    async function random(lang = DEFAULT_LANG, { name = null, guildId = null, reject = () => null, rng = Math.random } = {}) {
        const code = resolveLang(lang);
        const list = corpus().get(code) || [];
        const key = `${guildId || '*'}|${code}`;
        // Keep at least one line outside the window, so a small language never runs dry.
        const size = Math.min(window, Math.max(0, list.length - 1));
        const blocked = new Set(size ? (recent.get(key) || []).slice(-size) : []);
        const filtered = [];
        for (let i = 0; i < tries; i++) {
            const candidates = list.filter(r => !blocked.has(r.n));
            if (!candidates.length) break;
            const row = candidates[Math.floor(rng() * candidates.length)];
            blocked.add(row.n); // not again in this call either
            const reason = reject(fillName(row.text));
            if (reason) { filtered.push({ source: 'evilinsult', reason, number: row.n }); continue; }
            remember(key, row.n, size);
            return { line: fillName(row.text, name), lang: code, row, named: !!name && HAS_NAME.test(row.text), source: 'evilinsult', filtered };
        }
        const fallback = await pickInsult({ reject, rng });
        return { line: fallback.line, lang: DEFAULT_LANG, row: null, named: false, source: fallback.source, filtered: [...filtered, ...fallback.filtered] };
    }

    /**
     * The generate_insult.php shim: a safeFetch-shaped answer for an Evil Insult URL, or null for any
     * other URL (which then goes to the network as usual). Never makes a network call.
     */
    async function answerApi(url, { guildId = null, reject = () => null, rng = Math.random } = {}) {
        const req = parseEvilInsultUrl(url);
        if (!req) return null;
        const pick = await random(req.lang, { guildId, reject, rng });
        const record = apiRecord(pick);
        const [contentType, text] = req.type === 'json' ? ['application/json; charset=utf-8', JSON.stringify(record)]
            : req.type === 'xml' ? ['text/xml; charset=utf-8', apiXml(record)]
                : ['text/plain; charset=utf-8', pick.line];
        return { status: 200, url: String(url), contentType, text, truncated: false, redirects: 0, local: true, source: pick.source, filtered: pick.filtered };
    }

    /** Lines per language actually loaded (for the dashboard / tests). */
    function counts() {
        return Object.fromEntries([...corpus()].map(([lang, list]) => [lang, list.length]));
    }

    return { random, answerApi, resolveLang, counts, reset: () => recent.clear() };
}

/** The process-wide instance over data/evil-insults.json. */
export const evilInsults = createEvilInsults();

export default { evilInsults, createEvilInsults, parseEvilInsultUrl, isEvilInsultUrl, fillName, apiRecord, apiXml, LANGUAGES, isKnownLanguage, DEFAULT_LANG, RECENT_WINDOW, EVIL_TRIES };
