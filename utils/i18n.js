import pool from './db.js';
import configCache from './configCache.js';
import logger from './logger.js';
import {
    t,
    tMaybe,
    normalizeLocale,
    isSupportedLocale,
    availableLocales,
    allLocaleMeta,
    localeMeta,
    localizationMap,
    DEFAULT_LOCALE,
} from './i18n-catalogue.js';

/**
 * Locale resolution — the database-aware half of the i18n layer.
 *
 * Three tables for this already existed (`guild_language_prefs`,
 * `user_language_prefs`, `translations`) plus a `guild_settings.language`
 * column. All four were empty and read by zero lines of code: the schema
 * anticipated localization that never shipped. This wires them up.
 *
 * The string catalogues and `t()` itself live in ./i18n-catalogue.js, which has
 * no database dependency so build-time scripts can use it. This module adds the
 * part that needs to know who is asking.
 *
 * ## Resolution order
 *
 *   1. The user's explicit choice     (user_language_prefs)
 *   2. The guild's configured default (guild_language_prefs, then guild_settings.language)
 *   3. The locale Discord reports     (interaction.locale — the user's client language)
 *   4. DEFAULT_LOCALE
 *
 * Discord's own locale sits *below* the guild default on purpose. A server that
 * has set itself to German wants German for everyone who hasn't said otherwise,
 * including a visitor whose client happens to be English. But an explicit
 * personal choice outranks the server, because it's the only signal that is
 * unambiguously about this person rather than about the room they're standing in.
 */

/** Re-exported so callers need only one import. */
export {
    t,
    tMaybe,
    normalizeLocale,
    isSupportedLocale,
    availableLocales,
    allLocaleMeta,
    localeMeta,
    localizationMap,
    DEFAULT_LOCALE,
};

/**
 * The legacy guild_settings.language value, or null when it says nothing. The column defaults to
 * 'en', so every server whose guild_settings row was created (saving the General settings page
 * does that) read as "English" and the Language page's "Follow each member's Discord language"
 * had no effect. No page writes the column any more, so 'en' there is the default, not a choice.
 */
export function legacyGuildLanguage(value) {
    const v = value ? String(value).trim() : '';
    return v && v.toLowerCase() !== 'en' ? v : null;
}

/**
 * Work out which locale to use for an interaction or message.
 * Cached — this runs on every command dispatch.
 *
 * @returns {Promise<string>} Always a locale we hold a catalogue for.
 */
export async function resolveLocale({ userId, guildId, discordLocale } = {}) {
    try {
        if (userId) {
            const userLocale = await configCache.get('user_language_prefs', userId, async () => {
                const [rows] = await pool.execute(
                    'SELECT locale FROM user_language_prefs WHERE user_id = ?',
                    [userId]
                );
                return rows[0]?.locale || null;
            });
            if (userLocale && isSupportedLocale(userLocale)) return normalizeLocale(userLocale);
        }

        if (guildId) {
            const guildLocale = await configCache.get('guild_language_prefs', guildId, async () => {
                const [rows] = await pool.execute(
                    'SELECT locale FROM guild_language_prefs WHERE guild_id = ?',
                    [guildId]
                );
                if (rows[0]?.locale) return rows[0].locale;

                // guild_settings.language predates guild_language_prefs and is
                // still what the older settings UI writes. Read it so servers
                // that set a language years ago get what they asked for.
                const [legacy] = await pool.execute(
                    'SELECT language FROM guild_settings WHERE guild_id = ?',
                    [guildId]
                );
                return legacyGuildLanguage(legacy[0]?.language);
            });
            if (guildLocale && isSupportedLocale(guildLocale)) return normalizeLocale(guildLocale);
        }
    } catch (error) {
        // A locale lookup must never break a command. English is a working answer.
        logger.warn(`[i18n] Locale resolution failed, using ${DEFAULT_LOCALE}: ${error.message}`);
        return DEFAULT_LOCALE;
    }

    if (discordLocale) return normalizeLocale(discordLocale);
    return DEFAULT_LOCALE;
}

/**
 * Translator bound to one interaction: `const tr = await translatorFor(interaction)`.
 * Resolves the locale once rather than per string, and carries `.locale` for
 * callers that need to branch on it.
 *
 * Accepts an Interaction or a Message — the prefix-command bridge passes the
 * latter, and both expose the fields we need under slightly different names.
 */
export async function translatorFor(source) {
    const locale = await resolveLocale({
        userId: source?.user?.id ?? source?.author?.id,
        guildId: source?.guild?.id ?? source?.guildId,
        discordLocale: source?.locale,
    });

    const translate = (key, vars) => t(key, vars, { locale });
    translate.locale = locale;
    translate.meta = localeMeta(locale);
    return translate;
}

/**
 * Persist a language choice.
 *
 * @param {'user'|'guild'} scope
 * @param {string} id      User or guild snowflake.
 * @param {string|null} locale  null clears the preference.
 * @param {string} [setBy] Who set it, for the guild audit column.
 */
export async function setLocale(scope, id, locale, setBy = null) {
    if (locale !== null && !isSupportedLocale(locale)) {
        throw new Error(`Unsupported locale: ${locale}`);
    }
    const normalized = locale === null ? null : normalizeLocale(locale);

    if (scope === 'user') {
        if (normalized === null) {
            await pool.execute('DELETE FROM user_language_prefs WHERE user_id = ?', [id]);
        } else {
            await pool.execute(
                `INSERT INTO user_language_prefs (user_id, locale) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE locale = VALUES(locale), set_at = CURRENT_TIMESTAMP`,
                [id, normalized]
            );
        }
        invalidateLocaleCache({ userId: id });
        return normalized;
    }

    if (scope === 'guild') {
        if (normalized === null) {
            await pool.execute('DELETE FROM guild_language_prefs WHERE guild_id = ?', [id]);
            // guild_settings.language is the legacy store and is also read by
            // resolveLocale. Deleting only the new row leaves the old one behind,
            // and the clear silently does nothing — the guild keeps answering in
            // the language it was just told to forget. Both have to go.
            await pool.execute(
                'UPDATE guild_settings SET language = NULL WHERE guild_id = ?',
                [id]
            ).catch((e) => logger.debug(`[i18n] guild_settings.language clear skipped: ${e.message}`));
        } else {
            await pool.execute(
                `INSERT INTO guild_language_prefs (guild_id, locale, set_by) VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE locale = VALUES(locale), set_by = VALUES(set_by), set_at = CURRENT_TIMESTAMP`,
                [id, normalized, setBy]
            );
            // Keep the legacy column in step so the older settings UI doesn't
            // show a stale value next to the new one.
            await pool.execute(
                `INSERT INTO guild_settings (guild_id, language) VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE language = VALUES(language)`,
                [id, normalized]
            ).catch((e) => logger.debug(`[i18n] guild_settings.language sync skipped: ${e.message}`));
        }
        invalidateLocaleCache({ guildId: id });
        return normalized;
    }

    throw new Error(`Unknown locale scope: ${scope}`);
}

/** Read a stored preference without applying the resolution chain. */
export async function getStoredLocale(scope, id) {
    if (scope === 'user') {
        const [rows] = await pool.execute('SELECT locale FROM user_language_prefs WHERE user_id = ?', [id]);
        return rows[0]?.locale || null;
    }
    const [rows] = await pool.execute('SELECT locale FROM guild_language_prefs WHERE guild_id = ?', [id]);
    return rows[0]?.locale || null;
}

/** Drop cached prefs after a change so the next call sees it immediately. */
export function invalidateLocaleCache({ userId, guildId } = {}) {
    if (userId) configCache.invalidate('user_language_prefs', userId);
    if (guildId) configCache.invalidate('guild_language_prefs', guildId);
}

export default {
    t,
    tMaybe,
    resolveLocale,
    translatorFor,
    setLocale,
    getStoredLocale,
    localizationMap,
    availableLocales,
    allLocaleMeta,
    localeMeta,
    isSupportedLocale,
    normalizeLocale,
    invalidateLocaleCache,
    DEFAULT_LOCALE,
};
