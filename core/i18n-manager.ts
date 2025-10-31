import db from '../utils/db';
import logger from '../utils/logger';
import { Client } from 'discord.js';
import { RowDataPacket, ResultSetHeader } from 'mysql2';

interface TranslationRow extends RowDataPacket {
    locale: string;
    translation_key: string;
    translation_value: string;
    category: string;
}

interface GuildLanguagePreference extends RowDataPacket {
    guild_id: string;
    locale: string;
}

interface UserLanguagePreference extends RowDataPacket {
    user_id: string;
    locale: string;
}

interface TranslationStats extends RowDataPacket {
    locale: string;
    translation_count: number;
}

interface ReplacementMap {
    [key: string]: string;
}

class I18nManager {
    private translations: Map<string, Map<string, string>>;
    private guildLocales: Map<string, string>;
    private userLocales: Map<string, string>;
    private defaultLocale: string;
    private client: Client;

    constructor(client: Client) {
        this.translations = new Map();
        this.guildLocales = new Map();
        this.userLocales = new Map();
        this.defaultLocale = 'en-US';
        this.client = client;
    }

    async init(): Promise<void> {
        logger.info('[i18n] Initializing Internationalization Manager...');
        await this.loadTranslations();
        await this.loadGuildPreferences();
        await this.loadUserPreferences();
        logger.info('[i18n] Internationalization Manager initialized');
    }

    async loadTranslations(): Promise<void> {
        try {
            const [translations] = await db.execute<TranslationRow[]>('SELECT * FROM translations ORDER BY locale, translation_key');
            for (const translation of translations) {
                if (!this.translations.has(translation.locale)) {
                    this.translations.set(translation.locale, new Map());
                }
                this.translations.get(translation.locale)!.set(translation.translation_key, translation.translation_value);
            }
            logger.info(`[i18n] Loaded translations for ${this.translations.size} locales`);
        } catch (error: any) {
            logger.error('[i18n] Error loading translations:', error as Record<string, any>);
        }
    }

    async loadGuildPreferences(): Promise<void> {
        try {
            const [prefs] = await db.execute<GuildLanguagePreference[]>('SELECT guild_id, locale FROM guild_language_prefs');
            for (const pref of prefs) {
                this.guildLocales.set(pref.guild_id, pref.locale);
            }
            logger.info(`[i18n] Loaded ${prefs.length} guild language preferences`);
        } catch (error: any) {
            logger.error('[i18n] Error loading guild preferences:', error as Record<string, any>);
        }
    }

    async loadUserPreferences(): Promise<void> {
        try {
            const [prefs] = await db.execute<UserLanguagePreference[]>('SELECT user_id, locale FROM user_language_prefs');
            for (const pref of prefs) {
                this.userLocales.set(pref.user_id, pref.locale);
            }
            logger.info(`[i18n] Loaded ${prefs.length} user language preferences`);
        } catch (error: any) {
            logger.error('[i18n] Error loading user preferences:', error as Record<string, any>);
        }
    }

    translate(key: string, locale: string = this.defaultLocale, replacements?: ReplacementMap): string {
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

    t(key: string, locale?: string, replacements?: ReplacementMap): string {
        return this.translate(key, locale || this.defaultLocale, replacements);
    }

    async setGuildLocale(guildId: string, locale: string, setBy: string): Promise<boolean> {
        try {
            await db.execute(
                `INSERT INTO guild_language_prefs (guild_id, locale, set_by)
                 VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE locale = VALUES(locale), set_by = VALUES(set_by), set_at = NOW()`,
                [guildId, locale, setBy]
            );
            this.guildLocales.set(guildId, locale);
            logger.info(`[i18n] Set guild ${guildId} locale to ${locale}`);
            return true;
        } catch (error: any) {
            logger.error('[i18n] Error setting guild locale:', error as Record<string, any>);
            return false;
        }
    }

    async setUserLocale(userId: string, locale: string): Promise<boolean> {
        try {
            await db.execute(
                `INSERT INTO user_language_prefs (user_id, locale)
                 VALUES (?, ?)
                 ON DUPLICATE KEY UPDATE locale = VALUES(locale), set_at = NOW()`,
                [userId, locale]
            );
            this.userLocales.set(userId, locale);
            logger.info(`[i18n] Set user ${userId} locale to ${locale}`);
            return true;
        } catch (error: any) {
            logger.error('[i18n] Error setting user locale:', error as Record<string, any>);
            return false;
        }
    }

    getGuildLocale(guildId: string): string {
        return this.guildLocales.get(guildId) || this.defaultLocale;
    }

    getUserLocale(userId: string): string {
        return this.userLocales.get(userId) || this.defaultLocale;
    }

    getPreferredLocale(guildId?: string | null, userId?: string | null): string {
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

    async addTranslation(locale: string, key: string, value: string, category: string = 'general'): Promise<boolean> {
        try {
            await db.execute(
                `INSERT INTO translations (locale, translation_key, translation_value, category)
                 VALUES (?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE translation_value = VALUES(translation_value), category = VALUES(category)`,
                [locale, key, value, category]
            );
            if (!this.translations.has(locale)) {
                this.translations.set(locale, new Map());
            }
            this.translations.get(locale)!.set(key, value);
            logger.info(`[i18n] Added translation: ${locale}.${key}`);
            return true;
        } catch (error: any) {
            logger.error('[i18n] Error adding translation:', error as Record<string, any>);
            return false;
        }
    }

    getSupportedLocales(): string[] {
        return Array.from(this.translations.keys());
    }

    async getTranslationStats(): Promise<TranslationStats[]> {
        try {
            const [stats] = await db.execute<TranslationStats[]>(
                `SELECT locale, COUNT(*) as translation_count
                 FROM translations
                 GROUP BY locale
                 ORDER BY translation_count DESC`
            );
            return stats;
        } catch (error: any) {
            logger.error('[i18n] Error getting translation stats:', error as Record<string, any>);
            return [];
        }
    }

    shutdown(): void {
        this.translations.clear();
        this.guildLocales.clear();
        this.userLocales.clear();
        logger.info('[i18n] Internationalization Manager shut down');
    }
}

export default I18nManager;
