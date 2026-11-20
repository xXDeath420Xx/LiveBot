/**
 * The shared site frame (views/site-frame.ejs: site head, header, footer, theme) for routes that
 * build their page as a string instead of rendering a template: the Sprite Tracker
 * (routes/sprites.js), the scam lookup, holiday countdowns, the showcase player and a few
 * one-off public pages.
 *
 *   await sendFramed(req, res, { title, description, path, headHtml, bodyHtml, scriptsHtml }, status)
 *   const html = await renderFramed(req, res, opts)
 *
 * Several of those routers are mounted in server.js BEFORE the UI-preferences middleware, so
 * res.locals.uiTheme and friends are not set yet when they run. ensureUiLocals() fills them the
 * same way that middleware does (Dark by default; a signed-in Discord user's saved theme), so the
 * page paints in the visitor's theme with no flash. Signed-out visitors get the theme from the
 * footer switch (localStorage) through the head script in partials/site-head.ejs.
 *
 * frameLocals() is the pure part (no request): tests and scripts/theme-audit render the same frame
 * through a view engine with it.
 */
import { getPreferences, customThemeCss } from '../../core/user-preferences.js';
import { isSuperAdmin } from '../../utils/constants.js';
import logger from '../../utils/logger.js';

/** Fill res.locals the way server.js's preferences middleware does, when it has not run yet. */
export async function ensureUiLocals(req, res) {
    const L = res.locals;
    if (L.uiTheme) return L;
    L.uiTheme = 'dark';
    L.uiDensity = 'comfortable';
    L.uiLayout = 'grid';
    L.uiStyle = 'cards';
    const user = req.user;
    if (user?.id && /^\d{15,22}$/.test(String(user.id))) {
        try {
            const prefs = await getPreferences(user.id);
            L.uiTheme = prefs.theme || 'dark';
            L.uiDensity = prefs.density || 'comfortable';
            L.uiStyle = prefs.siteStyle || 'cards';
            L.userPrefs = prefs;
            L.uiCustomCss = customThemeCss(prefs);
        } catch (error) {
            // Defaults are a working answer; never fail a page over a preference.
            logger.debug(`[site-frame] preference load failed: ${error.message}`);
        }
        user.isSuperAdmin = isSuperAdmin(user.id);
        L.siteUser = user;
    }
    if (req.method === 'GET' && !L.sitePath) L.sitePath = req.originalUrl;
    return L;
}

/** The locals the frame template is rendered with: the request's res.locals plus the page's own. */
export function frameLocals(baseLocals = {}, opts = {}) {
    return { ...baseLocals, ...opts };
}

/** The framed page as a string. */
export async function renderFramed(req, res, opts = {}) {
    await ensureUiLocals(req, res);
    const locals = frameLocals(res.locals, opts);
    return new Promise((resolve, reject) => {
        req.app.render('site-frame', locals, (error, html) => (error ? reject(error) : resolve(html)));
    });
}

/** Render and send the framed page (status defaults to the response's current status). */
export async function sendFramed(req, res, opts = {}, status = null) {
    const html = await renderFramed(req, res, opts);
    if (status) res.status(status);
    return res.type('html').send(html);
}

export default { ensureUiLocals, frameLocals, renderFramed, sendFramed };
