/*
 * A small, safe arithmetic evaluator for the {math:…} template token (core/custom-command-vars.js; stream bot W2.16,
 * Firebot $math, Streamer.bot mXparser). A recursive-descent parser: no eval, no Function, no property access.
 *
 *   evaluateMath(text) → { ok: true, value, text } | { ok: false, error }
 *
 * Numbers (1, 2.5, 1e3; no thousands separators, since commas separate function arguments), + - * / % ^ (power, right-associative), brackets,
 * unary minus, and the functions round(x[, places]) floor ceil abs sqrt min max (any number of arguments), pi.
 * Limits: 200 characters, 40 levels of brackets, results outside ±1e15 or not finite are refused.
 *
 * Tested in tests/stream-bot-control.test.js.
 */

const MAX_LEN = 200;
const MAX_DEPTH = 40;
const FUNCS = Object.freeze({
    round: (x, p = 0) => { const k = 10 ** Math.max(0, Math.min(10, Math.trunc(p))); return Math.round(x * k) / k; },
    floor: Math.floor, ceil: Math.ceil, abs: Math.abs, sqrt: Math.sqrt,
    min: (...a) => Math.min(...a), max: (...a) => Math.max(...a),
});

export function formatNumber(n) {
    if (Number.isInteger(n)) return String(n);
    return String(Math.round(n * 1e6) / 1e6);
}

export function evaluateMath(input) {
    const src = String(input ?? '').trim();
    if (!src) return { ok: false, error: 'empty' };
    if (src.length > MAX_LEN) return { ok: false, error: 'too long' };
    let i = 0;
    let depth = 0;
    const fail = (m) => { throw new Error(m); };
    const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
    const peek = () => { ws(); return src[i]; };

    function number() {
        ws();
        const m = src.slice(i).match(/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i);
        if (!m) fail('expected a number');
        i += m[0].length;
        return Number(m[0]);
    }
    function primary() {
        const c = peek();
        if (c === '(') {
            if (++depth > MAX_DEPTH) fail('too many brackets');
            i++;
            const v = expr();
            if (peek() !== ')') fail('missing )');
            i++;
            depth--;
            return v;
        }
        if (c === '-') { i++; return -power(); }
        if (c === '+') { i++; return power(); }
        if (/[a-z]/i.test(c || '')) {
            const m = src.slice(i).match(/^[a-z]+/i);
            const name = m[0].toLowerCase();
            i += m[0].length;
            if (name === 'pi') return Math.PI;
            const fn = FUNCS[name];
            if (!fn || peek() !== '(') fail(`unknown name ${name}`);
            i++;
            if (++depth > MAX_DEPTH) fail('too many brackets');
            const args = [expr()];
            while (peek() === ',') { i++; args.push(expr()); }
            if (peek() !== ')') fail('missing )');
            i++;
            depth--;
            return fn(...args);
        }
        return number();
    }
    function power() {
        const base = primary();
        if (peek() === '^') { i++; return base ** unary(); }
        return base;
    }
    function unary() { return power(); }
    function term() {
        let v = power();
        for (;;) {
            const c = peek();
            if (c === '*') { i++; v *= power(); } else if (c === '/') { i++; v /= power(); } else if (c === '%') { i++; v %= power(); } else return v;
        }
    }
    function expr() {
        let v = term();
        for (;;) {
            const c = peek();
            if (c === '+') { i++; v += term(); } else if (c === '-') { i++; v -= term(); } else return v;
        }
    }
    try {
        const value = expr();
        ws();
        if (i < src.length) fail(`unexpected "${src[i]}"`);
        if (!Number.isFinite(value) || Math.abs(value) > 1e15) return { ok: false, error: 'result out of range' };
        return { ok: true, value, text: formatNumber(value) };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

export default { evaluateMath, formatNumber };
