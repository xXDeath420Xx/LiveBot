/**
 * /setup interaction handlers.
 *
 * No server-side session: every route is decidable from the customId alone, and
 * every enable is an idempotent upsert. A restart mid-wizard loses nothing, and
 * a stale message from an hour ago still works.
 *
 * customId grammar is `setup_<action>_<arg>`. The arg is taken as "everything
 * after the second underscore" rather than split on every underscore — the old
 * parser used `split('_')[2]`, which would truncate any multi-word key or a
 * category name containing a space or hyphen.
 */
import { PermissionFlagsBits, MessageFlags } from 'discord.js';
import {
    renderHome,
    renderPreset,
    renderCategory,
    renderFeature,
    renderApplied,
    applyFeature,
    applyPreset,
    setupableFeatures,
    PRESETS,
} from '../core/setup-wizard.js';
import logger from '../utils/logger.js';
import { logFeatureEvent, userLabel } from '../core/feature-log.js';

/** Server-log line for a feature switched on from /setup (the wizard re-renders; this is the record). */
function logFeatureApplied(interaction, featureKey, { channelId, roleId } = {}) {
    let name = featureKey;
    try { name = setupableFeatures().find((f) => f.key === featureKey)?.name || featureKey; } catch { /* the name is cosmetic */ }
    void logFeatureEvent(() => (interaction.guild), 'system.setupApplied', () => ({
        title: '🛠️ Setup Applied',
        description: `**${name}** was set up with \`/setup\`.`,
        fields: [
            ['Feature', name],
            ['Channel', channelId ? `<#${channelId}>` : null],
            ['Role', roleId ? `<@&${roleId}>` : null],
            ['By', userLabel(interaction.user)],
        ],
    }));
}

/** setup_<action>_<arg> — arg may itself contain underscores. */
function parse(customId) {
    const m = customId.match(/^setup_([a-z]+)_(.*)$/);
    return m ? { action: m[1], arg: m[2] } : { action: null, arg: '' };
}

async function guard(interaction) {
    if (!interaction.inGuild()) {
        await interaction.reply({
            content: interaction.t?.('errors.guild_only') ?? 'Use this in a server.',
            flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return false;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply({
            content: interaction.t?.('errors.no_permission') ?? '🚫 You need **Manage Server** to use setup.',
            flags: MessageFlags.Ephemeral,
        }).catch(() => {});
        return false;
    }
    return true;
}

/** Report rather than leave a dead component the user keeps clicking. */
async function fail(interaction, error, context) {
    logger.error('[setup] handler failed', { error: error.message, customId: interaction.customId, ...context });
    const body = { content: `Setup hit an error: ${error.message}`, flags: MessageFlags.Ephemeral };
    if (interaction.replied || interaction.deferred) await interaction.followUp(body).catch(() => {});
    else await interaction.reply(body).catch(() => {});
}

/** Buttons: setup_on_*, setup_apply_*, setup_home_*, setup_cat_* */
export async function handleSetupButton(interaction) {
    try {
        if (!(await guard(interaction))) return;
        const { action, arg } = parse(interaction.customId);
        const guildId = interaction.guildId;

        if (action === 'home') {
            return interaction.update(await renderHome(guildId, interaction.guild.name));
        }

        if (action === 'cat') {
            return interaction.update(await renderCategory(guildId, arg));
        }

        if (action === 'on') {
            await applyFeature(guildId, arg, {});
            logFeatureApplied(interaction, arg);
            // Re-render the feature so the status flips in place. Confirming the
            // click did something beats jumping the user somewhere else.
            return interaction.update(await renderFeature(guildId, arg));
        }

        if (action === 'apply') {
            // A preset can enable several features; defer so Discord's 3-second
            // interaction window isn't the limit on how many it may contain.
            await interaction.deferUpdate();
            const result = await applyPreset(guildId, arg);
            if (result.enabled.length || result.failed.length) {
                const preset = PRESETS[arg];
                void logFeatureEvent(() => (interaction.guild), 'system.setupApplied', () => ({
                    title: '🛠️ Setup Applied',
                    description: `The **${preset?.label || arg}** preset was applied with \`/setup\`.`,
                    fields: [
                        ['Preset', preset ? `${preset.emoji || ''} ${preset.label}`.trim() : arg],
                        ['By', userLabel(interaction.user)],
                        ['Turned on', result.enabled.length ? result.enabled.join(', ') : null, false],
                        ['Failed', result.failed.length ? result.failed.join('\n') : null, false],
                    ],
                }));
            }
            return interaction.editReply(await renderApplied(guildId, arg, result));
        }

        // Unknown action — re-render home rather than leave the message dead.
        return interaction.update(await renderHome(guildId, interaction.guild.name));
    } catch (error) {
        await fail(interaction, error, { guildId: interaction.guildId });
    }
}

/** String selects: setup_preset_menu, setup_cat_menu, setup_feat_<Category> */
export async function handleSetupSelect(interaction) {
    try {
        if (!(await guard(interaction))) return;
        const { action } = parse(interaction.customId);
        const chosen = interaction.values?.[0];
        const guildId = interaction.guildId;

        if (action === 'preset') return interaction.update(await renderPreset(guildId, chosen));
        if (action === 'cat') return interaction.update(await renderCategory(guildId, chosen));
        if (action === 'feat') return interaction.update(await renderFeature(guildId, chosen));

        return interaction.update(await renderHome(guildId, interaction.guild.name));
    } catch (error) {
        await fail(interaction, error, { guildId: interaction.guildId });
    }
}

/** Channel select: setup_chan_<featureKey> */
export async function handleSetupChannelSelect(interaction) {
    try {
        if (!(await guard(interaction))) return;
        const { arg: featureKey } = parse(interaction.customId);
        await applyFeature(interaction.guildId, featureKey, { channelId: interaction.values?.[0] });
        logFeatureApplied(interaction, featureKey, { channelId: interaction.values?.[0] });
        return interaction.update(await renderFeature(interaction.guildId, featureKey));
    } catch (error) {
        await fail(interaction, error, { guildId: interaction.guildId });
    }
}

/** Role select: setup_role_<featureKey> */
export async function handleSetupRoleSelect(interaction) {
    try {
        if (!(await guard(interaction))) return;
        const { arg: featureKey } = parse(interaction.customId);
        await applyFeature(interaction.guildId, featureKey, { roleId: interaction.values?.[0] });
        logFeatureApplied(interaction, featureKey, { roleId: interaction.values?.[0] });
        return interaction.update(await renderFeature(interaction.guildId, featureKey));
    } catch (error) {
        await fail(interaction, error, { guildId: interaction.guildId });
    }
}
