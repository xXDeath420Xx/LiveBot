/*
 * Custom automod patterns: validation and matching.
 *
 * Server admins add their own patterns with `/protection spam pattern-add` (stored in
 * `automod_patterns`) and core/advanced-automod-manager.js runs every enabled pattern against
 * every message. That makes a pattern untrusted input executed on the hot path, so this module
 * is deliberately dependency-free (node:vm only) and unit-tested on its own. Name filters
 * (core/name-filter-logic.js, rows in the same table with target = 'name') run member names
 * through the same guards.
 *
 * ## Why regexes go through three guards
 *
 * JavaScript regexes backtrack. `(a+)+$` against forty `a`s and a `b` takes minutes, and the bot
 * is one Node process: a single bad pattern in one guild would freeze every guild, the dashboard
 * and the music player. So:
 *
 *   1. validatePattern() refuses the shapes that backtrack exponentially — a repeated group that
 *      itself contains a quantifier or an alternation — plus backreferences, and anything that
 *      matches an empty message (that would delete every message in the server).
 *   2. Input is capped at MAX_INPUT_CHARS before matching.
 *   3. Matching runs inside node:vm with a hard timeout. Polynomial blow-ups such as
 *      `\d+\d+\d+$` slip past any static check, and a timeout is the only guarantee; V8 aborts a
 *      running regex when the watchdog fires. The caller disables a pattern that times out.
 */

import vm from 'node:vm';

export const PATTERN_TYPES = ['regex', 'contains', 'exact', 'domain'];
export const PATTERN_ACTIONS = ['delete', 'warn', 'mute', 'kick', 'ban'];

export const MAX_REGEX_LENGTH = 200;
export const MAX_TEXT_LENGTH = 300;
export const MIN_CONTAINS_LENGTH = 3;
export const MAX_INPUT_CHARS = 4000;
export const REGEX_TIMEOUT_MS = 25;
export const MAX_PATTERNS_PER_GUILD = 50;
const MAX_REPEATS = 12;

const BRACE_QUANTIFIER = /^\{(\d+)(,(\d*))?\}/;

/**
 * Walk a regex source and report the constructs that make backtracking explode.
 * Not a full parser — it only needs groups, classes, escapes, alternation and quantifiers.
 * @returns {string|null} a human-readable reason to refuse, or null when the shape is safe
 */
export function findDangerousConstruct(source) {
    const stack = [{ hasQuantifier: false, hasAlternation: false }];
    // What the next quantifier applies to: { kind: 'atom' } or { kind: 'group', frame }
    let lastAtom = null;
    let repeats = 0;
    let i = 0;

    const applyQuantifier = (max) => {
        if (!lastAtom) return 'a quantifier has nothing to repeat';
        const repeating = max === Infinity || max > 1;
        if (lastAtom.kind === 'group') {
            if (repeating && lastAtom.frame.hasQuantifier) {
                return 'a repeated group contains another quantifier (e.g. `(a+)+`), which can freeze the bot';
            }
            if (repeating && lastAtom.frame.hasAlternation) {
                return 'a repeated group contains `|` (e.g. `(a|b)+`); drop the outer repeat, a pattern already matches anywhere in the message';
            }
        }
        stack[stack.length - 1].hasQuantifier = true;
        if (repeating) repeats++;
        if (repeats > MAX_REPEATS) return `too many repeats (more than ${MAX_REPEATS})`;
        lastAtom = null;
        return null;
    };

    while (i < source.length) {
        const ch = source[i];

        if (ch === '\\') {
            const next = source[i + 1];
            if (next === undefined) return 'the pattern ends with a lone backslash';
            if (/[1-9]/.test(next) || (next === 'k' && source[i + 2] === '<')) {
                return 'backreferences (\\1, \\k<name>) are not allowed';
            }
            lastAtom = { kind: 'atom' };
            i += 2;
            continue;
        }

        if (ch === '[') {
            // Character class: skip to the closing bracket, honouring escapes.
            let j = i + 1;
            if (source[j] === '^') j++;
            if (source[j] === ']') j++; // a leading ] is literal
            while (j < source.length && source[j] !== ']') {
                j += source[j] === '\\' ? 2 : 1;
            }
            if (j >= source.length) return 'unclosed character class `[`';
            lastAtom = { kind: 'atom' };
            i = j + 1;
            continue;
        }

        if (ch === '(') {
            stack.push({ hasQuantifier: false, hasAlternation: false });
            lastAtom = null;
            i++;
            if (source[i] === '?') {
                // (?: (?= (?! (?<= (?<! (?<name>
                if (source[i + 1] === '<' && source[i + 2] !== '=' && source[i + 2] !== '!') {
                    const close = source.indexOf('>', i);
                    if (close === -1) return 'unclosed group name';
                    i = close + 1;
                } else if (source[i + 1] === '<') {
                    i += 3;
                } else {
                    i += 2;
                }
            }
            continue;
        }

        if (ch === ')') {
            if (stack.length === 1) return 'unbalanced `)`';
            const frame = stack.pop();
            const parent = stack[stack.length - 1];
            if (frame.hasQuantifier) parent.hasQuantifier = true;
            lastAtom = { kind: 'group', frame };
            i++;
            continue;
        }

        if (ch === '|') {
            stack[stack.length - 1].hasAlternation = true;
            lastAtom = null;
            i++;
            continue;
        }

        if (ch === '*' || ch === '+' || ch === '?') {
            const err = applyQuantifier(ch === '?' ? 1 : Infinity);
            if (err) return err;
            i++;
            if (source[i] === '?') i++; // lazy modifier
            continue;
        }

        if (ch === '{') {
            const m = source.slice(i).match(BRACE_QUANTIFIER);
            if (m) {
                const min = Number(m[1]);
                const max = m[2] === undefined ? min : (m[3] === '' ? Infinity : Number(m[3]));
                if (min > 1000 || (max !== Infinity && max > 1000)) return 'a `{n,m}` repeat count above 1000';
                const err = applyQuantifier(max);
                if (err) return err;
                i += m[0].length;
                if (source[i] === '?') i++;
                continue;
            }
            // A `{` that is not a quantifier is a literal in non-unicode mode.
            lastAtom = { kind: 'atom' };
            i++;
            continue;
        }

        if (ch === '^' || ch === '$') {
            lastAtom = null;
            i++;
            continue;
        }

        lastAtom = { kind: 'atom' };
        i++;
    }

    if (stack.length !== 1) return 'unclosed group `(`';
    return null;
}

/**
 * An alternation with an empty branch (`a|`, `|a`, `(a||b)`, `(|x)`) matches "nothing" on that branch,
 * so it is either a typo or a pattern that matches far more than intended. Name filters refuse it
 * (core/name-filter-logic.js); a branch holding only an anchor (`(^|\s)`) is not empty.
 * @returns {string|null} reason to refuse, or null
 */
export function findEmptyAlternative(source) {
    const stack = [{ empty: true, alternation: false }];
    let i = 0;
    while (i < source.length) {
        const ch = source[i];
        const top = stack[stack.length - 1];
        if (ch === '\\') { top.empty = false; i += 2; continue; }
        if (ch === '[') {
            let j = i + 1;
            if (source[j] === '^') j++;
            if (source[j] === ']') j++;
            while (j < source.length && source[j] !== ']') j += source[j] === '\\' ? 2 : 1;
            top.empty = false;
            i = j + 1;
            continue;
        }
        if (ch === '(') {
            i++;
            if (source[i] === '?') {
                if (source[i + 1] === '<' && source[i + 2] !== '=' && source[i + 2] !== '!') {
                    const close = source.indexOf('>', i);
                    i = close === -1 ? source.length : close + 1;
                } else if (source[i + 1] === '<') i += 3;
                else i += 2;
            }
            stack.push({ empty: true, alternation: false });
            continue;
        }
        if (ch === '|') {
            if (top.empty) return 'an alternative is empty (`a|`, `|a` or `a||b`), so it matches almost anything';
            top.alternation = true;
            top.empty = true;
            i++;
            continue;
        }
        if (ch === ')') {
            if (stack.length > 1) {
                const frame = stack.pop();
                if (frame.alternation && frame.empty) return 'an alternative is empty (`(a|)`), so it matches almost anything';
                stack[stack.length - 1].empty = false;
            }
            i++;
            continue;
        }
        // Quantifiers attach to what came before; anything else is content.
        if (!'*+?{'.includes(ch)) top.empty = false;
        i++;
    }
    const top = stack[0];
    if (top.alternation && top.empty) return 'an alternative is empty (`a|`), so it matches almost anything';
    return null;
}

/** Normalise a domain the way an admin is likely to type it: scheme, www., path and port removed. */
export function normaliseDomain(raw) {
    let d = String(raw || '').trim().toLowerCase();
    d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    d = d.split(/[/?#]/)[0];
    d = d.replace(/:\d+$/, '');
    d = d.replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
    return d;
}

const HOSTNAME_RE = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z][a-z0-9-]*[a-z0-9]$/;

/** Hostname shape check; inputs are already split on whitespace and bounded by the caller. */
function isHostname(value) {
    return value.length <= 253 && HOSTNAME_RE.test(value);
}

/**
 * Validate and normalise a pattern before it is stored.
 * @returns {{ ok: true, value: string } | { ok: false, error: string }}
 */
export function validatePattern(type, raw, { regexTimeoutMs = REGEX_TIMEOUT_MS } = {}) {
    if (!PATTERN_TYPES.includes(type)) return { ok: false, error: `Unknown pattern type "${type}".` };
    const text = String(raw ?? '');

    if (type === 'domain') {
        const value = normaliseDomain(text);
        if (!isHostname(value)) {
            return { ok: false, error: 'That is not a domain. Use something like `example.com` (subdomains are matched too).' };
        }
        return { ok: true, value };
    }

    if (type === 'regex') {
        const value = text.trim();
        if (!value) return { ok: false, error: 'The pattern is empty.' };
        if (value.length > MAX_REGEX_LENGTH) {
            return { ok: false, error: `Regex patterns are limited to ${MAX_REGEX_LENGTH} characters.` };
        }
        const danger = findDangerousConstruct(value);
        if (danger) return { ok: false, error: `Refused: ${danger}.` };
        let re;
        try {
            re = new RegExp(value, 'i');
        } catch (err) {
            return { ok: false, error: `Invalid regex: ${err.message}` };
        }
        // A pattern that matches nothing at all matches every message.
        const probe = probeRegex(re, '', regexTimeoutMs);
        if (probe.matched) {
            return { ok: false, error: 'Refused: that regex matches an empty message, so it would match every message in the server.' };
        }
        if (probe.timedOut) return { ok: false, error: 'Refused: the regex is too slow to evaluate.' };
        return { ok: true, value };
    }

    // contains / exact
    const value = text.trim();
    if (!value) return { ok: false, error: 'The pattern is empty.' };
    if (value.length > MAX_TEXT_LENGTH) {
        return { ok: false, error: `Text patterns are limited to ${MAX_TEXT_LENGTH} characters.` };
    }
    if (type === 'contains' && value.length < MIN_CONTAINS_LENGTH) {
        return { ok: false, error: `A "contains" pattern needs at least ${MIN_CONTAINS_LENGTH} characters — shorter ones match ordinary words.` };
    }
    return { ok: true, value };
}

// One reusable context: creating a context per call costs far more than the regex.
const sandbox = vm.createContext(Object.create(null));
const testScript = new vm.Script('__re.test(__input)');

/**
 * Run a regex with a hard time limit.
 * @returns {{ matched: boolean, timedOut?: boolean, error?: Error }}
 */
export function safeRegexTest(regex, input, timeoutMs = REGEX_TIMEOUT_MS) {
    sandbox.__re = regex;
    sandbox.__input = String(input ?? '').slice(0, MAX_INPUT_CHARS);
    try {
        regex.lastIndex = 0;
        return { matched: testScript.runInContext(sandbox, { timeout: timeoutMs }) === true };
    } catch (error) {
        if (error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return { matched: false, timedOut: true };
        return { matched: false, error };
    } finally {
        sandbox.__re = null;
        sandbox.__input = null;
    }
}

/**
 * The validators' "is it too slow?" probe. The vm watchdog counts wall-clock time, including
 * time the process spends descheduled on a loaded machine, so one timeout can be the machine
 * rather than the pattern: it is only believed when a second run with 8x the budget (at least
 * 200 ms) times out too. Validation only, never the per-message path.
 */
export function probeRegex(regex, input, timeoutMs = REGEX_TIMEOUT_MS) {
    const first = safeRegexTest(regex, input, timeoutMs);
    if (!first.timedOut) return first;
    return safeRegexTest(regex, input, Math.max(timeoutMs * 8, 200));
}

const eachScript = new vm.Script(`(function () {
    const hits = [];
    for (let i = 0; i < __jobs.length; i++) {
        const re = __jobs[i][0], inputs = __jobs[i][1];
        for (let j = 0; j < inputs.length; j++) {
            re.lastIndex = 0;
            if (re.test(inputs[j])) { hits.push(i, j); break; }
        }
    }
    return hits.join(',');
})()`);

/**
 * Many regexes against many short inputs in ONE sandboxed run (name filters test every regex
 * against several forms of three names; a vm call each would cost more than the matching).
 * `jobs` is [[RegExp, string[]], ...]; inputs are capped at MAX_INPUT_CHARS like safeRegexTest.
 * Each job reports its first matching input. On a timeout the caller re-runs the jobs one by one
 * (safeRegexTest) to find the slow pattern.
 * @returns {{ hits: Array<{ job:number, input:number }>, timedOut?: boolean, error?: Error }}
 */
export function safeRegexEach(jobs, timeoutMs = REGEX_TIMEOUT_MS) {
    if (!jobs.length) return { hits: [] };
    sandbox.__jobs = jobs.map(([re, inputs]) => [re, inputs.map(s => String(s ?? '').slice(0, MAX_INPUT_CHARS))]);
    try {
        const flat = String(eachScript.runInContext(sandbox, { timeout: timeoutMs }));
        const nums = flat ? flat.split(',').map(Number) : [];
        const hits = [];
        for (let k = 0; k < nums.length; k += 2) hits.push({ job: nums[k], input: nums[k + 1] });
        return { hits };
    } catch (error) {
        if (error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return { hits: [], timedOut: true };
        return { hits: [], error };
    } finally {
        sandbox.__jobs = null;
    }
}

/**
 * Hostnames mentioned in a message, with or without a scheme. Tokenises rather than running a
 * URL regex over the whole message, so the scan is linear in the message length.
 */
export function extractHostnames(content) {
    const hosts = new Set();
    for (const rawToken of String(content || '').slice(0, MAX_INPUT_CHARS).split(/[\s<>()[\]"'`|]+/)) {
        if (!rawToken || !rawToken.includes('.')) continue;
        let token = rawToken.toLowerCase();
        token = token.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
        token = token.replace(/^[^@/]*@/, '');            // user:pass@host
        token = token.split(/[/?#\\]/)[0].replace(/:\d+$/, '').replace(/[.,;:!]+$/, '');
        if (token.startsWith('www.')) token = token.slice(4);
        if (isHostname(token)) hosts.add(token);
    }
    return [...hosts];
}

export function hostnameMatches(host, domain) {
    return host === domain || host.endsWith(`.${domain}`);
}

/** Compile a stored regex pattern; null when it no longer compiles. */
export function compilePattern(pattern) {
    if (pattern.pattern_type !== 'regex') return null;
    try {
        return new RegExp(pattern.pattern, 'i');
    } catch {
        return null;
    }
}

/**
 * Match one stored pattern against message content.
 * `compiled` is the cached RegExp for regex patterns (see compilePattern); `timeoutMs` is the
 * regex budget (tests pass a generous one).
 * @returns {{ matched: boolean, timedOut?: boolean, error?: Error }}
 */
export function matchPattern(pattern, content, compiled = null, timeoutMs = REGEX_TIMEOUT_MS) {
    const text = String(content || '');
    switch (pattern.pattern_type) {
        case 'regex': {
            const re = compiled || compilePattern(pattern);
            if (!re) return { matched: false, error: new Error('invalid regex') };
            return safeRegexTest(re, text, timeoutMs);
        }
        case 'contains':
            return { matched: text.toLowerCase().includes(String(pattern.pattern).toLowerCase()) };
        case 'exact':
            return { matched: text.trim().toLowerCase() === String(pattern.pattern).trim().toLowerCase() };
        case 'domain': {
            const domain = normaliseDomain(pattern.pattern);
            return { matched: extractHostnames(text).some(h => hostnameMatches(h, domain)) };
        }
        default:
            return { matched: false };
    }
}

/** Effectiveness as stored in spam_patterns_stats: true positives over all hits, smoothed by 1. */
export function effectivenessScore(truePositives, falsePositives) {
    const tp = Math.max(0, Number(truePositives) || 0);
    const fp = Math.max(0, Number(falsePositives) || 0);
    return (tp / (tp + fp + 1)) * 100;
}
