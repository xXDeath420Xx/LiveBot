/**
 * The dashboard's EJS view engine, with a template cache that can be dropped without a restart.
 *
 * Before this the engine read and compiled every template (and every include of every
 * template) on every request; whether Express also cached depended on NODE_ENV, and when it
 * did, ejs keyed its cache by file name only, so a partial rendered once with the Classic CSS
 * restore (services/classic-style.js) would have been served to cards/compact pages too.
 *
 * Now:
 *   - each template is compiled once per variant ('' or 'classic') and kept until reload();
 *     DASHBOARD_VIEW_CACHE=0 turns the cache off (every render recompiles, as before)
 *   - include() resolves exactly as it always did: caller-relative first, then from views/
 *   - local stylesheet and script references in the template source (href="/css/x.css",
 *     src="/js/x.js") get ?v=<hash of the file's content> added at compile time, so a changed
 *     file gets a new URL (Cloudflare caches /css and /js by URL) and an unchanged one keeps
 *     its URL across restarts; references that already carry a query string are left alone
 *   - reload() drops compiled templates, include resolutions, asset hashes, the classic CSS
 *     map and ejs's own cache. The dashboard calls it when scripts/reload-dashboard.mjs drops
 *     a request (services/dashboard-reload.js); that is how a views/public-only deploy goes
 *     live without restarting the bots.
 *
 * The top-level template is never classic-transformed (manage-classic.ejs is itself the
 * original page); its includes are when the render sets classicCss, same as before.
 * Used by server.js, tests/view-engine.test.js and scripts/visual-check.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ejs from 'ejs';
import { classicSource, resetClassicMap } from './classic-style.js';

// href="/css/x.css" or src="/js/y.js" with no query string, nothing dynamic inside the URL.
const ASSET_REF = /(\s(?:href|src)=")(\/(?:css|js)\/[^"?#<>\s]+\.(?:css|js))"/g;

/** Template source with ?v=<hash> on every local css/js reference whose file exists. */
export function versionAssetRefs(source, hashFor) {
    return String(source).replace(ASSET_REF, (whole, open, url) => {
        const v = hashFor(url);
        return v ? `${open}${url}?v=${v}"` : whole;
    });
}

/** First 10 hex of the sha1 of a file under publicDir, or null (missing, or outside publicDir). */
export function fileHash(publicDir, urlPath) {
    const root = path.resolve(publicDir);
    const file = path.resolve(root, '.' + urlPath);
    if (!file.startsWith(root + path.sep)) return null;
    try {
        return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
    } catch {
        return null;
    }
}

export function createViewEngine({ viewsDir, publicDir = null, cache = process.env.DASHBOARD_VIEW_CACHE !== '0' } = {}) {
    if (!viewsDir) throw new Error('createViewEngine: viewsDir is required');
    const compiled = new Map();   // `${variant}\0${file}` -> template function
    const resolved = new Map();   // `${callerDir}\0${name}` -> absolute template path
    const hashes = new Map();     // '/css/x.css' -> hash | null
    let generation = 1;
    let reloadedAt = Date.now();

    const hashFor = (url) => {
        if (!publicDir) return null;
        if (cache && hashes.has(url)) return hashes.get(url);
        const v = fileHash(publicDir, url);
        if (cache) hashes.set(url, v);
        return v;
    };

    function load(file, variant) {
        const key = `${variant}\0${file}`;
        if (cache) {
            const hit = compiled.get(key);
            if (hit) return hit;
        }
        let src = fs.readFileSync(file, 'utf8');
        if (variant === 'classic') src = classicSource(viewsDir, file, src);
        src = versionAssetRefs(src, hashFor);
        const fn = ejs.compile(src, { filename: file, views: [viewsDir] });
        if (cache) compiled.set(key, fn);
        return fn;
    }

    function resolveInclude(callerFile, name) {
        const callerDir = callerFile ? path.dirname(callerFile) : viewsDir;
        const key = `${callerDir}\0${name}`;
        if (cache && resolved.has(key)) return resolved.get(key);
        const ext = name.endsWith('.ejs') ? '' : '.ejs';
        let full = path.resolve(callerDir, name + ext);
        if (!fs.existsSync(full)) full = path.resolve(viewsDir, name + ext);
        if (cache) resolved.set(key, full);
        return full;
    }

    /** Render a template file with Express-style options (locals); synchronous. */
    function renderFile(filePath, options = {}) {
        const variant = options.classicCss ? 'classic' : '';
        const makeInclude = (callerFile) => (name, data = {}) => {
            const full = resolveInclude(callerFile, name);
            return load(full, variant)({ ...options, ...data, filename: full, include: makeInclude(full) });
        };
        options.filename = filePath;
        options.views = [viewsDir];
        options.include = makeInclude(filePath);
        return load(filePath, '')(options);
    }

    /** app.engine('ejs', engine) */
    function engine(filePath, options, callback) {
        let html;
        try {
            html = renderFile(filePath, options);
        } catch (error) {
            return callback(error);
        }
        return callback(null, html);
    }

    /** Drop everything cached; the next render of each template recompiles it. */
    function reload() {
        const cleared = compiled.size;
        compiled.clear();
        resolved.clear();
        hashes.clear();
        resetClassicMap();
        ejs.clearCache();
        generation++;
        reloadedAt = Date.now();
        return { generation, cleared, reloadedAt };
    }

    function stats() {
        return { cache, compiled: compiled.size, generation, reloadedAt };
    }

    return { engine, renderFile, reload, stats, assetHash: hashFor };
}
