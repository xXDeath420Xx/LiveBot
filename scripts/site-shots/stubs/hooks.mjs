/*
 * Module hooks for the screenshot run (registered by ../run.mjs before anything from the bot is
 * imported): the bot's database pool and logger are replaced with the stubs next to this file, so
 * rendering a card or a page never opens a database connection and never writes to the bot's logs.
 */
const STUBS = {
    '/utils/db.js': new URL('./db.mjs', import.meta.url).href,
    '/utils/logger.js': new URL('./logger.mjs', import.meta.url).href,
};
let ROOT = null;

export async function initialize(data) {
    ROOT = data?.root ? String(data.root).split('\\').join('/').replace(/\/$/, '') : null;
}

export async function resolve(specifier, context, next) {
    const out = await next(specifier, context);
    if (ROOT && out.url.startsWith('file://')) {
        const p = decodeURIComponent(new URL(out.url).pathname);
        for (const [tail, stub] of Object.entries(STUBS)) {
            if (p === ROOT + tail) return { url: stub, shortCircuit: true, format: 'module' };
        }
    }
    return out;
}
