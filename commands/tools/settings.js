import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import {
    t,
    setLocale,
    getStoredLocale,
    resolveLocale,
    allLocaleMeta,
    localeMeta,
    isSupportedLocale,
    normalizeLocale,
    localizationMap,
    DEFAULT_LOCALE,
} from '../../utils/i18n.js';
import logger from '../../utils/logger.js';
import { themeColor } from '../../core/guild-theme.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

/** Discord locales we can offer translated command metadata for. */
const DISCORD_LOCALES = ['es-ES', 'pt-BR', 'fr', 'de'];

/**
 * Language choices, built from the catalogues rather than a second hardcoded
 * list — adding locales/xx.json is all it should take to offer a new language.
 *
 * Labelled with the native name, because someone looking for their own language
 * is scanning for "Português", not "Portuguese".
 */
function languageChoices() {
    return allLocaleMeta().map((m) => ({ name: `${m.nativeName} (${m.name})`, value: m.locale }));
}

export default {
    category: 'tools',
    data: new SlashCommandBuilder()
        .setName('settings')
        .setDescription('Your preferences and this server\'s defaults')
        .addSubcommand((s) =>
            s
                .setName('language')
                .setDescription('Choose the language this bot replies in')
                .setDescriptionLocalizations(
                    localizationMap('settings.language.command_description', { discordLocales: DISCORD_LOCALES })
                )
                .addStringOption((o) =>
                    o
                        .setName('language')
                        .setDescription('Which language? Leave empty to see the current setting.')
                        .addChoices(...languageChoices())
                )
                .addStringOption((o) =>
                    o
                        .setName('scope')
                        .setDescription('Just for you, or the default for everyone in this server?')
                        .addChoices(
                            { name: 'Me — only affects my replies', value: 'me' },
                            { name: 'Server — the default for everyone here (needs Manage Server)', value: 'server' }
                        )
                )
                .addBooleanOption((o) =>
                    o.setName('reset').setDescription('Clear the setting and fall back to the server / your Discord language')
                )
        ),

    async execute(interaction) {
        if (interaction.options.getSubcommand() !== 'language') return;
        return handleLanguage(interaction);
    },
};

async function handleLanguage(interaction) {
    const scope = interaction.options.getString('scope') || 'me';
    const requested = interaction.options.getString('language');
    const reset = interaction.options.getBoolean('reset') || false;

    // Reply in whatever locale currently applies, so the confirmation for a
    // change arrives in the language just chosen and everything else arrives in
    // the language already in force.
    const currentLocale = await resolveLocale({
        userId: interaction.user.id,
        guildId: interaction.guild?.id,
        discordLocale: interaction.locale,
    });
    const tr = (key, vars, locale = currentLocale) => t(key, vars, { locale });

    if (scope === 'server') {
        if (!interaction.guild) {
            return interaction.reply({ content: tr('errors.guild_only'), ...EPHEMERAL });
        }
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.reply({ content: tr('errors.no_permission'), ...EPHEMERAL });
        }
    }

    try {
        // --- Clear ------------------------------------------------------
        if (reset) {
            await setLocale(scope === 'server' ? 'guild' : 'user', scopeId(interaction, scope), null);
            const after = await resolveLocale({
                userId: interaction.user.id,
                guildId: interaction.guild?.id,
                discordLocale: interaction.locale,
            });
            return interaction.reply({
                content: t(scope === 'server' ? 'settings.language.set_guild' : 'settings.language.reset_user',
                    { language: localeMeta(after)?.nativeName ?? after, command: '`/settings language`' },
                    { locale: after }),
                ...EPHEMERAL,
            });
        }

        // --- Show current ----------------------------------------------
        if (!requested) return showCurrent(interaction, scope, currentLocale, tr);

        // --- Set --------------------------------------------------------
        if (!isSupportedLocale(requested)) {
            return interaction.reply({
                content: tr('settings.language.unsupported', {
                    locale: requested,
                    available: allLocaleMeta().map((m) => m.nativeName).join(', '),
                }),
                ...EPHEMERAL,
            });
        }

        const saved = await setLocale(
            scope === 'server' ? 'guild' : 'user',
            scopeId(interaction, scope),
            requested,
            interaction.user.id
        );

        // Confirm in the newly chosen language — the most direct proof it worked.
        return interaction.reply({
            content: t(scope === 'server' ? 'settings.language.set_guild' : 'settings.language.set_user',
                { language: localeMeta(saved)?.nativeName ?? saved, command: '`/settings language`' },
                { locale: saved }),
            ...EPHEMERAL,
        });
    } catch (error) {
        logger.error('[Settings/language] Failed', {
            error: error.message,
            scope,
            requested,
            guildId: interaction.guild?.id,
        });
        return interaction.reply({ content: tr('errors.generic'), ...EPHEMERAL });
    }
}

function scopeId(interaction, scope) {
    return scope === 'server' ? interaction.guild.id : interaction.user.id;
}

async function showCurrent(interaction, scope, currentLocale, tr) {
    const stored = interaction.guild || scope === 'me'
        ? await getStoredLocale(scope === 'server' ? 'guild' : 'user', scopeId(interaction, scope))
        : null;

    const effective = localeMeta(currentLocale);
    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'primary'))
        .setDescription(
            tr(scope === 'server' ? 'settings.language.current_guild' : 'settings.language.current_user', {
                language: stored
                    ? (localeMeta(stored)?.nativeName ?? stored)
                    : `${effective?.nativeName ?? currentLocale} (${tr('common.none')} set — inherited)`,
            })
        )
        .addFields({
            name: tr('settings.language.available_title'),
            value: allLocaleMeta()
                .map((m) => `${m.locale === currentLocale ? '**' : ''}${m.nativeName}${m.locale === currentLocale ? '**' : ''} — \`${m.locale}\``)
                .join('\n'),
        })
        .setFooter({ text: tr('settings.language.help') });

    return interaction.reply({ embeds: [embed], ...EPHEMERAL });
}

export { DISCORD_LOCALES, DEFAULT_LOCALE, normalizeLocale };
