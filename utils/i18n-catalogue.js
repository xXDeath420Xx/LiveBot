import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from './logger.js';

/**
 * Translation catalogues — the pure, dependency-free half of the i18n layer.
 *
 * Deliberately imports nothing but `fs` and the logger. `deploy-commands.js`
 * needs `localizationMap()` to attach setNameLocalizations at command-build
 * time, and that runs as a standalone script; if this module pulled in the
 * database pool, importing it would open a connection and leave the script
 * hanging on exit. Locale *resolution* (which needs user/guild rows) lives in
 * ./i18n.js, which imports this.
 *
 * Catalogues live in `locales/*.json` and are the source of truth — they can be
 * reviewed in a diff, which per-guild override rows cannot.
 *
 * A missing key falls back to the fallback locale, then DEFAULT_LOCALE, and
 * finally renders as the key itself. It never throws and never returns an empty
 * string: a user-facing blank is a worse failure than an untranslated string,
 * because it reads as the feature being broken rather than merely untranslated.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.join(__dirname, '..', 'locales');

export const DEFAULT_LOCALE = 'en';

/** Discord sends `en-US`, `pt-BR`, `es-419`; our catalogues are `en`, `pt-BR`. */
const DISCORD_TO_CATALOGUE = {
    'en-US': 'en',
    'en-GB': 'en',
    'es-419': 'es-ES',
};

/** locale -> flat key/value map. Loaded once at boot. */
const catalogues = new Map();

function loadCatalogues() {
    let files = [];
    try {
        files = readdirSync(LOCALES_DIR).filter((f) => f.endsWith('.json'));
    } catch {
        logger.warn('[i18n] No locales/ directory — every string will render as its key.');
        return;
    }

    for (const file of files) {
        const locale = path.basename(file, '.json');
        try {
            const raw = JSON.parse(readFileSync(path.join(LOCALES_DIR, file), 'utf8'));
            catalogues.set(locale, flatten(raw));
        } catch (error) {
            // A malformed catalogue must not take the bot down; it degrades to
            // the fallback locale for that language only.
            logger.error(`[i18n] Failed to load locale "${locale}": ${error.message}`);
        }
    }

    logger.info(`[i18n] Loaded ${catalogues.size} locale(s): ${[...catalogues.keys()].join(', ')}`);
}

/** { a: { b: 'x' } } -> { 'a.b': 'x' } so lookups are a single Map hit. */
function flatten(obj, prefix = '', out = {}) {
    for (const [key, value] of Object.entries(obj)) {
        const full = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, full, out);
        else out[full] = value;
    }
    return out;
}

loadCatalogues();

/** Catalogues we actually have, for building Discord localization maps. */
export function availableLocales() {
    return [...catalogues.keys()];
}

/**
 * The `_meta` block from a catalogue: display name, native name, and which
 * Discord locale codes it should serve. Used to build the language picker and
 * the Discord localization maps without hardcoding a second list.
 */
export function localeMeta(locale) {
    const cat = catalogues.get(normalizeLocale(locale));
    if (!cat) return null;
    return {
        locale: normalizeLocale(locale),
        name: cat['_meta.name'] || locale,
        nativeName: cat['_meta.nativeName'] || cat['_meta.name'] || locale,
    };
}

/** Every locale we hold, as pickable options. */
export function allLocaleMeta() {
    return availableLocales().map(localeMeta).filter(Boolean);
}

export function isSupportedLocale(locale) {
    return catalogues.has(normalizeLocale(locale));
}

/** Map a Discord locale onto the closest catalogue we hold. */
export function normalizeLocale(locale) {
    if (!locale) return DEFAULT_LOCALE;
    if (catalogues.has(locale)) return locale;

    const mapped = DISCORD_TO_CATALOGUE[locale];
    if (mapped && catalogues.has(mapped)) return mapped;

    // `pt-BR` -> `pt` if we hold a base catalogue but not the regional one.
    const base = String(locale).split('-')[0];
    if (catalogues.has(base)) return base;

    return DEFAULT_LOCALE;
}

/**
 * Substitute {placeholders}. Values are inserted verbatim — this output goes to
 * Discord as message content, not HTML, so escaping here would corrupt mentions
 * and markdown. Callers putting user input into a string must still handle
 * mention-injection at their own level (allowedMentions), as they do today.
 */
function interpolate(template, vars) {
    if (!vars) return template;
    return String(template).replace(/\{(\w+(?:\.\w+)*)\}/g, (match, key) => {
        const value = key.split('.').reduce((acc, part) => (acc == null ? acc : acc[part]), vars);
        return value === undefined || value === null ? match : String(value);
    });
}

/**
 * Translate a key.
 *
 * @param {string} key      Dot-separated, e.g. 'leveling.rank.title'.
 * @param {object} [vars]   Values for {placeholders}.
 * @param {object} [opts]
 * @param {string} [opts.locale]   Resolved locale. Defaults to DEFAULT_LOCALE.
 * @param {string} [opts.fallback] Tried before DEFAULT_LOCALE.
 * @returns {string} Never empty, never throws.
 */
export function t(key, vars, { locale = DEFAULT_LOCALE, fallback } = {}) {
    const chain = [normalizeLocale(locale), fallback && normalizeLocale(fallback), DEFAULT_LOCALE]
        .filter(Boolean);

    for (const candidate of chain) {
        const value = catalogues.get(candidate)?.[key];
        if (value !== undefined) return interpolate(value, vars);
    }

    // Surfacing the key beats surfacing nothing: it is obviously wrong in
    // review, and still tells the reader roughly what belongs there.
    logger.debug(`[i18n] Missing translation key "${key}" (locale ${locale})`);
    return interpolate(key, vars);
}

/**
 * Like t(), but returns undefined when the key exists in no catalogue.
 *
 * t() deliberately renders a missing key as the key itself, which is right for
 * a string that is *supposed* to be translated — it is obviously wrong in review
 * and still hints at the intent. It is wrong for the "translate this, but I have
 * a literal English fallback right here" pattern, because `t(k) || 'English'`
 * can never reach the fallback: t() always returns something truthy, so the user
 * sees `errors.some_key` instead of the English sentence sitting next to it.
 *
 * Use this where a call site carries its own fallback.
 */
export function tMaybe(key, vars, { locale = DEFAULT_LOCALE, fallback } = {}) {
    const chain = [normalizeLocale(locale), fallback && normalizeLocale(fallback), DEFAULT_LOCALE].filter(Boolean);
    for (const candidate of chain) {
        const value = catalogues.get(candidate)?.[key];
        if (value !== undefined) return interpolate(value, vars);
    }
    return undefined;
}

/**
 * Build a Discord localization map for a key: { 'de': '…', 'fr': '…' }.
 *
 * Feeds setNameLocalizations/setDescriptionLocalizations, which is free native
 * translation — Discord renders command names and descriptions in each user's
 * own client language with no work at runtime.
 *
 * Locales with no translation are omitted so Discord falls back to the default
 * name rather than showing the raw key.
 */
export function localizationMap(key, { discordLocales = [] } = {}) {
    const map = {};
    for (const discordLocale of discordLocales) {
        const catalogue = catalogues.get(normalizeLocale(discordLocale));
        const value = catalogue?.[key];
        if (value !== undefined && normalizeLocale(discordLocale) !== DEFAULT_LOCALE) {
            map[discordLocale] = value;
        }
    }
    return Object.keys(map).length ? map : undefined;
}

export default { t, tMaybe, localizationMap, availableLocales, allLocaleMeta, isSupportedLocale, normalizeLocale, localeMeta, DEFAULT_LOCALE };
