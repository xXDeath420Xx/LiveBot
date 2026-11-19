import pool from '../utils/db.js';
import configCache from '../utils/configCache.js';
import logger from '../utils/logger.js';
import { validateCustomTheme, renderCustomThemeCss } from './custom-theme.js';
import { SECTIONS as NAV_SECTIONS } from './manage-nav.js';

/**
 * Per-user dashboard preferences.
 *
 * `user_preferences` already existed — with `theme` and `compact_mode` columns —
 * and was read by no code at all. Same pattern as the i18n tables: schema built
 * for a feature that never shipped. This wires it up and adds layout choice and
 * page pinning (migration 185).
 *
 * ## Defaults reproduce today's behaviour exactly
 *
 * The manage overview has 74 module cards and people have muscle memory for
 * where things sit. A layout that changes unasked is worse than a layout that
 * is imperfect. So every default here is what already ships, and a user who
 * never opens settings sees no difference whatsoever.
 *
 * ## Pinning is the part that actually helps
 *
 * There are 89 manage pages; a given admin uses about five. A density toggle
 * makes 89 cards slightly smaller. Pinning puts their five first. `recent_pages`
 * is the zero-configuration version of the same idea, for people who will never
 * curate a list.
 */

export const DEFAULTS = Object.freeze({
    theme: 'dark',             // no-op in themes.css — identical to today
    customTheme: null,
    sectionOrder: null,        // null = shipped order
    hiddenSections: [],
    density: 'comfortable',    // ditto
    dashboardLayout: 'grid',   // ditto
    siteStyle: 'cards',        // see STYLES
    compactMode: false,
    pinnedPages: [],
    recentPages: [],
    serverAccent: false,       // tint a server's manage pages with its embed colour (ui_options)
    hiddenChecklists: [],      // guild ids whose overview setup checklist this user dismissed (ui_options)
});

/**
 * Selectable themes. `dark` deliberately has no block in themes.css — it is
 * what every view already defines inline, so it stays pixel-identical to what
 * shipped before and switching away and back is lossless.
 */
export const THEMES = Object.freeze([
    { value: 'auto', label: 'Auto', blurb: 'Follows your system: light by day, dark at night if your OS switches.', group: 'Auto' },
    { value: 'dark', label: 'Dark', blurb: 'The default.', group: 'Dark' },
    { value: 'slate', label: 'Slate', blurb: 'Cool neutral grey — the least opinionated dark.', group: 'Dark' },
    { value: 'midnight', label: 'Midnight', blurb: 'Deeper and bluer, lower glare.', group: 'Dark' },
    { value: 'ocean', label: 'Ocean', blurb: 'Deep teal-blue, cool and calm.', group: 'Dark' },
    { value: 'forest', label: 'Forest', blurb: 'Green-tinted, restful over long sessions.', group: 'Dark' },
    { value: 'plum', label: 'Plum', blurb: 'Deep purple, closest to the brand accent.', group: 'Dark' },
    { value: 'ember', label: 'Ember', blurb: 'Warm dark — less blue light for evening use.', group: 'Dark' },
    { value: 'amoled', label: 'AMOLED', blurb: 'True black — saves power on OLED screens.', group: 'Dark' },
    { value: 'light', label: 'Light', blurb: 'Bright surfaces, dark text.', group: 'Light' },
    { value: 'sand', label: 'Sand', blurb: 'Warm light — softer than pure white for long reading.', group: 'Light' },
    { value: 'contrast', label: 'High contrast', blurb: 'Maximum legibility. Opaque borders, no blur or shadow.', group: 'Accessibility' },
    { value: 'custom', label: 'Custom', blurb: 'Your own colours.', group: 'Custom' },
]);

/**
 * Overview sections, in shipped order. A user's `section_order` is validated
 * against these keys — an unknown key is dropped rather than rendered, so a
 * stale saved order can never blank the page.
 *
 * The list lives in core/manage-nav.js with the pages filed under each section,
 * so the overview and this validation cannot disagree. Orders saved under the
 * pre-2026-10 keys (core/streaming/analytics/utility…) are dropped by that
 * validation and those users simply see the shipped order again.
 */
export const SECTIONS = Object.freeze(NAV_SECTIONS.map((s) => Object.freeze({ key: s.key, label: s.label })));
const SECTION_KEYS = new Set(SECTIONS.map((s) => s.key));

/**
 * How the overview arranges its pages, inside whichever style is chosen. The
 * values are the ones saved since migration 185; the labels describe what each
 * now does (in the Compact style `grid` is the two-column row list).
 */
export const LAYOUTS = Object.freeze([
    { value: 'grid', label: 'Grid', blurb: 'The default: a grid of cards (two columns of rows in Compact).' },
    { value: 'cozy', label: 'Rows', blurb: 'One page per row with its full description.' },
    { value: 'list', label: 'Compact list', blurb: 'Titles only. Fastest once you know the names.' },
]);
const LAYOUT_VALUES = new Set(LAYOUTS.map((l) => l.value));

export const DENSITIES = Object.freeze([
    { value: 'comfortable', label: 'Comfortable', blurb: 'The default spacing.' },
    { value: 'compact', label: 'Compact', blurb: 'Tighter — more on screen at once.' },
    { value: 'spacious', label: 'Spacious', blurb: 'Roomier. Easier to hit on touch screens.' },
]);

const THEME_VALUES = new Set(THEMES.map((t) => t.value));

/*
 * `auto` is stored and rendered as data-theme="auto"; a few lines at the top of every themed
 * template's <head> (AUTO_THEME_SCRIPT below) swap it for "light" or "dark" from
 * prefers-color-scheme before first paint, and again when the OS switches, keeping
 * data-theme-mode="auto" so pickers still show Auto. With scripts off it reads as dark (cf-ui.css's
 * dark block matches anything that is not light/sand). Every [data-theme="light"] rule in every
 * stylesheet therefore applies to Auto-in-light unchanged.
 */
export const AUTO_THEME_SCRIPT = "<script>(function(){var d=document.documentElement,m=window.matchMedia?matchMedia('(prefers-color-scheme: light)'):null;function a(){if(d.getAttribute('data-theme')==='auto'||d.getAttribute('data-theme-mode')==='auto'){d.setAttribute('data-theme-mode','auto');d.setAttribute('data-theme',m&&m.matches?'light':'dark');}}a();if(m&&m.addEventListener)m.addEventListener('change',a);})();</script>";

/** The light/dark token set a theme draws on ('auto' follows the OS, so it is both). */
export function themeMode(theme, prefersLight = false) {
    if (theme === 'auto') return prefersLight ? 'light' : 'dark';
    return theme === 'light' || theme === 'sand' ? 'light' : 'dark';
}

const MAX_HIDDEN_CHECKLISTS = 200;
const SNOWFLAKE = /^\d{15,25}$/;

/**
 * Site styles: the overall look, separate from the colour theme. Every style
 * works with every theme; the style is rendered onto <html data-style> (the
 * same way as data-theme) and the CSS for it lives in cf-ui.css (tokens) and
 * cf-manage.css (the manage page). Column user_preferences.site_style
 * (migration 334). The owner asked to keep every look the site has had and let
 * people choose (2026-10-13), so:
 *   cards    the default: coloured icon tiles and a card grid
 *   compact  the 2026-10-13 neutral look: list rows, tight spacing, little colour
 *   classic  the look before that: purple accent, colourful rounded cards
 * `preview` is the screenshot shown on the Settings page (dashboard/public/img/styles).
 */
export const STYLES = Object.freeze([
    { value: 'cards', label: 'Cards', blurb: 'Coloured icon tiles on a roomy card grid. The default.', preview: 'cards' },
    { value: 'compact', label: 'Compact', blurb: 'Neutral list rows and tight spacing. The most on one screen.', preview: 'compact' },
    { value: 'classic', label: 'Classic', blurb: 'The original look: purple accent and bold, rounded category cards.', preview: 'classic' },
]);
const STYLE_VALUES = new Set(STYLES.map((s) => s.value));

/** A valid style value, or null. Used for the ?style= preview override too. */
export function normaliseStyle(value) {
    const v = String(value ?? '').trim().toLowerCase();
    return STYLE_VALUES.has(v) ? v : null;
}
const DENSITY_VALUES = new Set(DENSITIES.map((d) => d.value));

const MAX_PINNED = 12;
const MAX_RECENT = 8;

/** JSON columns come back as strings on some driver/version combinations. */
function asArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function parseObject(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/** user_preferences.ui_options (migration 335): small per-user switches with no column of their own. */
export function parseUiOptions(value) {
    const o = parseObject(value) || {};
    return {
        serverAccent: o.serverAccent === true,
        hiddenChecklists: asArray(o.hiddenChecklists).map(String).filter((id) => SNOWFLAKE.test(id)).slice(-MAX_HIDDEN_CHECKLISTS),
    };
}

/**
 * Apply a checklist show/hide to the stored list. `hideChecklist` hides one server's
 * checklist, `showChecklist` brings one back, `showAllChecklists: true` clears the list.
 */
export function nextHiddenChecklists(current, { hideChecklist, showChecklist, showAllChecklists } = {}) {
    let list = asArray(current).map(String).filter((id) => SNOWFLAKE.test(id));
    if (showAllChecklists) list = [];
    if (showChecklist !== undefined) list = list.filter((id) => id !== String(showChecklist));
    if (hideChecklist !== undefined) {
        const id = String(hideChecklist);
        if (!SNOWFLAKE.test(id)) throw new Error('Invalid server id for the setup checklist.');
        list = [...list.filter((x) => x !== id), id];
    }
    return list.slice(-MAX_HIDDEN_CHECKLISTS);
}

function rowToPrefs(row) {
    if (!row) return { ...DEFAULTS };
    const ui = parseUiOptions(row.ui_options);
    return {
        // Guard against a stale value from before a theme was renamed/removed —
        // an unknown theme would render as an unstyled page rather than falling
        // back, because themes.css simply wouldn't match the attribute.
        theme: THEME_VALUES.has(row.theme) ? row.theme : DEFAULTS.theme,
        density: DENSITY_VALUES.has(row.density) ? row.density : DEFAULTS.density,
        dashboardLayout: row.dashboard_layout || DEFAULTS.dashboardLayout,
        // Unknown or missing (row written before migration 334) = the default style.
        siteStyle: normaliseStyle(row.site_style) || DEFAULTS.siteStyle,
        compactMode: Boolean(row.compact_mode),
        pinnedPages: asArray(row.pinned_pages),
        recentPages: asArray(row.recent_pages),
        customTheme: parseObject(row.custom_theme),
        // Filter against SECTION_KEYS so a stale order saved before a section
        // was renamed can't blank the overview.
        sectionOrder: asArray(row.section_order).filter((k) => SECTION_KEYS.has(k)) || null,
        hiddenSections: asArray(row.hidden_sections).filter((k) => SECTION_KEYS.has(k)),
        serverAccent: ui.serverAccent,
        hiddenChecklists: ui.hiddenChecklists,
    };
}

/**
 * Read a user's preferences, merged over the defaults.
 * Cached — this runs on every dashboard page render.
 */
export async function getPreferences(userId) {
    if (!userId) return { ...DEFAULTS };

    return configCache.get('user_preferences', userId, async () => {
        try {
            const [rows] = await pool.execute(
                'SELECT * FROM user_preferences WHERE discord_user_id = ?',
                [userId]
            );
            return rowToPrefs(rows[0]);
        } catch (error) {
            // A preferences lookup must never break a page render. Defaults are
            // a working answer and are what the user sees today anyway.
            logger.warn(`[UserPrefs] Read failed for ${userId}, using defaults: ${error.message}`);
            return { ...DEFAULTS };
        }
    });
}

/**
 * Write preferences. Only the keys present in `updates` are touched.
 *
 * @param {string} userId
 * @param {object} updates {theme, siteStyle, dashboardLayout, compactMode, pinnedPages,
 *                          serverAccent, hideChecklist, showChecklist, showAllChecklists}
 */
export async function setPreferences(userId, updates = {}) {
    const columns = [];
    const values = [];

    // ui_options is one JSON column: read-modify-write of just the keys asked for.
    const uiKeys = ['serverAccent', 'hideChecklist', 'showChecklist', 'showAllChecklists'].filter((k) => k in updates);
    if (uiKeys.length) {
        const current = await getPreferences(userId);
        const next = { serverAccent: current.serverAccent === true, hiddenChecklists: current.hiddenChecklists || [] };
        if ('serverAccent' in updates) next.serverAccent = updates.serverAccent === true;
        next.hiddenChecklists = nextHiddenChecklists(next.hiddenChecklists, updates);
        columns.push('ui_options');
        values.push(JSON.stringify(next));
    }

    if ('theme' in updates) {
        if (!THEME_VALUES.has(updates.theme)) {
            throw new Error(`Unknown theme "${updates.theme}". Available: ${[...THEME_VALUES].join(', ')}.`);
        }
        columns.push('theme');
        values.push(updates.theme);
    }

    if ('density' in updates) {
        if (!DENSITY_VALUES.has(updates.density)) {
            throw new Error(`Unknown density "${updates.density}". Available: ${[...DENSITY_VALUES].join(', ')}.`);
        }
        columns.push('density');
        values.push(updates.density);
    }

    if ('dashboardLayout' in updates) {
        if (!LAYOUT_VALUES.has(updates.dashboardLayout)) {
            throw new Error(`Unknown layout "${updates.dashboardLayout}". Available: ${[...LAYOUT_VALUES].join(', ')}.`);
        }
        columns.push('dashboard_layout');
        values.push(updates.dashboardLayout);
    }

    if ('siteStyle' in updates) {
        const style = normaliseStyle(updates.siteStyle);
        if (!style) {
            throw new Error(`Unknown style "${updates.siteStyle}". Available: ${[...STYLE_VALUES].join(', ')}.`);
        }
        columns.push('site_style');
        values.push(style);
    }

    if ('compactMode' in updates) {
        columns.push('compact_mode');
        values.push(updates.compactMode ? 1 : 0);
    }

    if ('customTheme' in updates) {
        if (updates.customTheme === null) {
            columns.push('custom_theme');
            values.push(null);
        } else {
            // Validated here as well as at the route: this is the last point
            // before the value is persisted, and a stored bad value would be
            // re-rendered on every page load thereafter.
            const result = validateCustomTheme(updates.customTheme);
            if (!result.ok) throw new Error(result.error);
            columns.push('custom_theme');
            values.push(JSON.stringify(result.theme));
        }
    }

    if ('sectionOrder' in updates) {
        const order = updates.sectionOrder === null
            ? null
            : [...new Set(asArray(updates.sectionOrder).filter((k) => SECTION_KEYS.has(k)))];
        columns.push('section_order');
        values.push(order === null ? null : JSON.stringify(order));
    }

    if ('hiddenSections' in updates) {
        const hidden = [...new Set(asArray(updates.hiddenSections).filter((k) => SECTION_KEYS.has(k)))];
        // Refuse to hide everything — an empty overview looks like a broken page
        // rather than a configured one, and there'd be no UI left to undo it.
        if (hidden.length >= SECTIONS.length) {
            throw new Error('At least one section must stay visible.');
        }
        columns.push('hidden_sections');
        values.push(JSON.stringify(hidden));
    }

    if ('pinnedPages' in updates) {
        // Bounded and de-duplicated. An unbounded pin list would just recreate
        // the 74-card overview it exists to shortcut.
        const pins = [...new Set(asArray(updates.pinnedPages).map(String))]
            .filter((p) => /^[a-z0-9-]{1,40}$/.test(p))
            .slice(0, MAX_PINNED);
        columns.push('pinned_pages');
        values.push(JSON.stringify(pins));
    }

    if (!columns.length) return getPreferences(userId);

    const insertCols = ['discord_user_id', ...columns];
    const placeholders = insertCols.map(() => '?').join(', ');
    const updateClause = columns.map((c) => `${c} = VALUES(${c})`).join(', ');

    await pool.execute(
        `INSERT INTO user_preferences (${insertCols.join(', ')}) VALUES (${placeholders})
         ON DUPLICATE KEY UPDATE ${updateClause}`,
        [userId, ...values]
    );

    configCache.invalidate('user_preferences', userId);
    return getPreferences(userId);
}

/** Toggle one page's pinned state. Returns the new pin list. */
export async function togglePin(userId, page) {
    if (!/^[a-z0-9-]{1,40}$/.test(String(page))) throw new Error('Invalid page slug.');

    const { pinnedPages } = await getPreferences(userId);
    const next = pinnedPages.includes(page)
        ? pinnedPages.filter((p) => p !== page)
        : [...pinnedPages, page].slice(-MAX_PINNED);

    await setPreferences(userId, { pinnedPages: next });
    return next;
}

/**
 * Record a page visit for the "recently used" shortcut.
 *
 * Deliberately fire-and-forget and never awaited by a render path: this is a
 * convenience, and a write failure must not slow down or break the page the
 * user actually asked for.
 */
export function noteVisit(userId, page) {
    if (!userId || !/^[a-z0-9-]{1,40}$/.test(String(page))) return;

    (async () => {
        try {
            const { recentPages } = await getPreferences(userId);
            const next = [page, ...recentPages.filter((p) => p !== page)].slice(0, MAX_RECENT);
            if (next.join() === recentPages.join()) return;   // no change, skip the write

            await pool.execute(
                `INSERT INTO user_preferences (discord_user_id, recent_pages) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE recent_pages = VALUES(recent_pages)`,
                [userId, JSON.stringify(next)]
            );
            configCache.invalidate('user_preferences', userId);
        } catch (error) {
            logger.debug(`[UserPrefs] noteVisit failed for ${userId}: ${error.message}`);
        }
    })();
}

/**
 * The section order to render for a user: their saved order first, then any
 * sections they've never seen (added since they last arranged things) appended
 * in shipped order, minus anything hidden.
 *
 * Appending unknown sections rather than dropping them means a new feature
 * category becomes visible to existing users instead of silently never
 * appearing because it wasn't in their saved array.
 */
export function resolveSectionOrder(prefs) {
    const hidden = new Set(prefs?.hiddenSections || []);
    const saved = (prefs?.sectionOrder || []).filter((k) => SECTION_KEYS.has(k));
    const rest = SECTIONS.map((s) => s.key).filter((k) => !saved.includes(k));
    return [...saved, ...rest].filter((k) => !hidden.has(k));
}

/** CSS for the user's custom theme, or '' when they have none. */
export function customThemeCss(prefs) {
    if (!prefs?.customTheme) return '';
    try {
        return renderCustomThemeCss(prefs.customTheme);
    } catch {
        return '';
    }
}

export default {
    getPreferences, setPreferences, togglePin, noteVisit, resolveSectionOrder, customThemeCss,
    DEFAULTS, THEMES, DENSITIES, LAYOUTS, SECTIONS, STYLES, normaliseStyle,
    AUTO_THEME_SCRIPT, themeMode, parseUiOptions, nextHiddenChecklists,
};
