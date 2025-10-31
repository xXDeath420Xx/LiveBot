"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
class I18nManager {
    constructor(client) {
        this.translations = new Map();
        this.guildLocales = new Map();
        this.userLocales = new Map();
        this.defaultLocale = 'en-US';
        this.client = client;
    }
    async init() {
        logger_1.default.info('[i18n] Initializing Internationalization Manager...');
        await this.loadTranslations();
        await this.loadGuildPreferences();
        await this.loadUserPreferences();
        logger_1.default.info('[i18n] Internationalization Manager initialized');
    }
    async loadTranslations() {
        try {
            const [translations] = await db_1.default.execute('SELECT * FROM translations ORDER BY locale, translation_key');
            for (const translation of translations) {
                if (!this.translations.has(translation.locale)) {
                    this.translations.set(translation.locale, new Map());
                }
                this.translations.get(translation.locale).set(translation.translation_key, translation.translation_value);
            }
            logger_1.default.info(`[i18n] Loaded translations for ${this.translations.size} locales`);
        }
        catch (error) {
            logger_1.default.error('[i18n] Error loading translations:', error);
        }
    }
    async loadGuildPreferences() {
        try {
            const [prefs] = await db_1.default.execute('SELECT guild_id, locale FROM guild_language_prefs');
            for (const pref of prefs) {
                this.guildLocales.set(pref.guild_id, pref.locale);
            }
            logger_1.default.info(`[i18n] Loaded ${prefs.length} guild language preferences`);
        }
        catch (error) {
            logger_1.default.error('[i18n] Error loading guild preferences:', error);
        }
    }
    async loadUserPreferences() {
        try {
            const [prefs] = await db_1.default.execute('SELECT user_id, locale FROM user_language_prefs');
            for (const pref of prefs) {
                this.userLocales.set(pref.user_id, pref.locale);
            }
            logger_1.default.info(`[i18n] Loaded ${prefs.length} user language preferences`);
        }
        catch (error) {
            logger_1.default.error('[i18n] Error loading user preferences:', error);
        }
    }
    translate(key, locale = this.defaultLocale, replacements) {
        let text = this.translations.get(locale)?.get(key);
        if (!text) {
            // Fallback to default locale
            text = this.translations.get(this.defaultLocale)?.get(key);
        }
        if (!text) {
            // Fallback to key itself
            return key;
        }
        // Replace placeholders
        if (replacements) {
            for (const [placeholder, value] of Object.entries(replacements)) {
                text = text.replace(new RegExp(`\\{${placeholder}\\}`, 'g'), value);
            }
        }
        return text;
    }
    t(key, locale, replacements) {
        return this.translate(key, locale || this.defaultLocale, replacements);
    }
    async setGuildLocale(guildId, locale, setBy) {
        try {
            await db_1.default.execute(`INSERT INTO guild_language_prefs (guild_id, locale, set_by)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE locale = VALUES(locale), set_by = VALUES(set_by), set_at = NOW()`, [guildId, locale, setBy]);
            this.guildLocales.set(guildId, locale);
            logger_1.default.info(`[i18n] Set guild ${guildId} locale to ${locale}`);
            return true;
        }
        catch (error) {
            logger_1.default.error('[i18n] Error setting guild locale:', error);
            return false;
        }
    }
    async setUserLocale(userId, locale) {
        try {
            await db_1.default.execute(`INSERT INTO user_language_prefs (user_id, locale)
                 VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE locale = VALUES(locale), set_at = NOW()`, [userId, locale]);
            this.userLocales.set(userId, locale);
            logger_1.default.info(`[i18n] Set user ${userId} locale to ${locale}`);
            return true;
        }
        catch (error) {
            logger_1.default.error('[i18n] Error setting user locale:', error);
            return false;
        }
    }
    getGuildLocale(guildId) {
        return this.guildLocales.get(guildId) || this.defaultLocale;
    }
    getUserLocale(userId) {
        return this.userLocales.get(userId) || this.defaultLocale;
    }
    getPreferredLocale(guildId, userId) {
        // Priority: User preference > Guild preference > Default
        if (userId) {
            const userLocale = this.getUserLocale(userId);
            if (userLocale !== this.defaultLocale)
                return userLocale;
        }
        if (guildId) {
            return this.getGuildLocale(guildId);
        }
        return this.defaultLocale;
    }
    async addTranslation(locale, key, value, category = 'general') {
        try {
            await db_1.default.execute(`INSERT INTO translations (locale, translation_key, translation_value, category)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE translation_value = VALUES(translation_value), category = VALUES(category)`, [locale, key, value, category]);
            if (!this.translations.has(locale)) {
                this.translations.set(locale, new Map());
            }
            this.translations.get(locale).set(key, value);
            logger_1.default.info(`[i18n] Added translation: ${locale}.${key}`);
            return true;
        }
        catch (error) {
            logger_1.default.error('[i18n] Error adding translation:', error);
            return false;
        }
    }
    getSupportedLocales() {
        return Array.from(this.translations.keys());
    }
    async getTranslationStats() {
        try {
            const [stats] = await db_1.default.execute(`SELECT locale, COUNT(*) as translation_count
                 FROM translations
                 GROUP BY locale
                 ORDER BY translation_count DESC`);
            return stats;
        }
        catch (error) {
            logger_1.default.error('[i18n] Error getting translation stats:', error);
            return [];
        }
    }
    shutdown() {
        this.translations.clear();
        this.guildLocales.clear();
        this.userLocales.clear();
        logger_1.default.info('[i18n] Internationalization Manager shut down');
    }
}
exports.default = I18nManager;
