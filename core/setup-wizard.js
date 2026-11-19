/**
 * Guided /setup — registry-driven, non-linear, guild-adaptive.
 *
 * ## What was wrong with the previous version
 *
 * It worked, but had three structural problems:
 *
 *   1. TWO FEATURE LISTS. The wizard carried its own hardcoded array of 11
 *      features while core/feature-flags.js carried a registry of 42. They
 *      agreed on 7. A server owner running /setup saw a quarter of what the bot
 *      does, with no way to know that. Two lists also drift — four wizard keys
 *      (`antinuke`, `greeting`, `raid`, `selfpromo`) matched nothing in the
 *      registry, because one side had been renamed and the other hadn't.
 *
 *   2. A FORCED LINEAR MARCH. Step 0 → 1 → … → 10, no jumping. Someone who came
 *      to switch on stream alerts clicked past leveling, logging, automod and
 *      six others to reach it.
 *
 *   3. NO SENSE OF THE GUILD. A twelve-person friend group and a 2,000-member
 *      streaming community got the same eleven questions in the same order.
 *
 * ## The shape now
 *
 *   - The registry is the single source of truth. A feature becomes setup-able
 *     by adding an ACTIONS entry against its registry key — there is no second
 *     list of names, descriptions or categories to keep in sync.
 *   - PRESETS make it guild-shaped: say what kind of server this is, get a
 *     recommended set, adjust from there.
 *   - Navigation is a menu, not a queue. Jump to any category, configure one
 *     thing, leave.
 *   - Already-configured features are detected through the registry's `detect`
 *     table and shown as done rather than asked about again.
 *
 * ## State
 *
 * Still stateless, deliberately — that was the best part of the old design.
 * Everything needed to re-render lives in the component customId, and every
 * enable is an idempotent upsert. A restart mid-wizard loses nothing, and there
 * is no session table to expire or leak.
 *
 *   customId grammar:  setup_<action>_<arg>
 *     setup_preset_menu       preset chosen (value carries the key)
 *     setup_cat_menu          category chosen (value carries the name)
 *     setup_cat_<Category>    back-button into a category
 *     setup_feat_<Category>   feature chosen within a category
 *     setup_on_<featureKey>   enable, no input needed
 *     setup_chan_<featureKey> enable with the chosen channel
 *     setup_role_<featureKey> enable with the chosen role
 *     setup_apply_<presetKey> bulk-enable a preset's no-input recommendations
 *     setup_home_x            back to the overview
 */
import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ChannelSelectMenuBuilder,
    RoleSelectMenuBuilder,
    ChannelType,
} from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import { REGISTRY, catalogFor } from './feature-flags.js';
import { themeColor } from './guild-theme.js';

// ---------------------------------------------------------------------------
// Enable actions, keyed by REGISTRY key.
//
// A registry feature without an entry here is still browsable — it just points
// at its dashboard page instead of offering one-click enable. That is the
// honest treatment for anything needing more than a channel to be useful, and
// it means the wizard never promises something it cannot deliver.
//
// SQL is written against the VERIFIED live schema, including the quirks:
// logging logs ALL events when enabled_events is empty; welcome has no explicit
// enabled column (a row IS the enable); starboard's `enabled` defaults to 1;
// suggestion_config's `enabled` defaults to 0, so it is set explicitly; anti-raid is the
// raid system's own switch (raid_detection_config.enabled through core/raid-lockdown.js, which
// also clears the config cache the raid manager reads) — the old anti_raid_config table it used
// to write was never enforced.
// ---------------------------------------------------------------------------
const ACTIONS = {
    welcome: {
        input: 'channel',
        run: (g, { channelId }) => pool.execute(
            `INSERT INTO welcome_settings (guild_id, channel_id, message) VALUES (?,?,?)
             ON DUPLICATE KEY UPDATE channel_id=VALUES(channel_id)`,
            [g, channelId, 'Welcome {user.mention}! 🎉 Glad to have you.']),
    },
    leveling: {
        input: 'channel_optional',
        run: (g, { channelId }) => pool.execute(
            `INSERT INTO level_config (guild_id, enabled, level_up_channel_id) VALUES (?,1,?)
             ON DUPLICATE KEY UPDATE enabled=1, level_up_channel_id=COALESCE(VALUES(level_up_channel_id), level_up_channel_id)`,
            [g, channelId || null]),
    },
    logging: {
        input: 'channel',
        run: (g, { channelId }) => pool.execute(
            `INSERT INTO logging_config (guild_id, enabled, log_channel_id) VALUES (?,1,?)
             ON DUPLICATE KEY UPDATE enabled=1, log_channel_id=VALUES(log_channel_id)`,
            [g, channelId]),
    },
    automod: {
        input: 'none',
        // A new row gets the Spam limits page's defaults, not the table's column defaults (core/automod-spam-config.js).
        run: async (g) => (await import('./automod-spam-config.js')).enableAutomodSpam(g),
    },
    anti_nuke: {
        input: 'none',
        run: (g) => pool.execute(
            `INSERT INTO anti_nuke_config (guild_id, enabled) VALUES (?,1)
             ON DUPLICATE KEY UPDATE enabled=1`, [g]),
    },
    anti_raid: {
        input: 'none',
        run: async (g) => (await import('./raid-lockdown.js')).enableRaidDetection(g),
    },
    phishing: {
        input: 'none',
        run: (g) => pool.execute(
            `INSERT INTO phishing_config (guild_id, enabled) VALUES (?,1)
             ON DUPLICATE KEY UPDATE enabled=1`, [g]),
    },
    starboard: {
        input: 'channel',
        // starboard_config is one row per board (migration 423): point the board already in that
        // channel, or the first board, at the channel; add a board only when there is none.
        run: async (g, { channelId }) => {
            const { listBoards, saveBoard } = await import('./starboard-manager.js');
            const boards = await listBoards(g);
            const target = boards.find((b) => b.channel_id === channelId) || boards[0];
            const saved = await saveBoard(g, target ? target.id : null, { channel_id: channelId, enabled: 1 });
            if (!saved.ok) throw new Error(saved.error);
        },
    },
    suggestions: {
        input: 'channel',
        run: (g, { channelId }) => pool.execute(
            // /engage suggest refuses unless enabled=1 (the column defaults to 0), so set it here
            // the same way `/engage suggest setup` and the takeover flow do.
            `INSERT INTO suggestion_config (guild_id, suggestions_channel_id, enabled) VALUES (?,?,1)
             ON DUPLICATE KEY UPDATE suggestions_channel_id=VALUES(suggestions_channel_id), enabled=1`, [g, channelId]),
    },
    birthdays: {
        input: 'channel',
        run: (g, { channelId }) => pool.execute(
            `INSERT INTO birthday_config (guild_id, announcement_channel_id, enabled) VALUES (?,?,1)
             ON DUPLICATE KEY UPDATE announcement_channel_id=VALUES(announcement_channel_id), enabled=1`,
            [g, channelId]),
    },
    economy: {
        input: 'none',
        run: (g) => pool.execute(
            `INSERT INTO economy_config (guild_id, enabled) VALUES (?,1)
             ON DUPLICATE KEY UPDATE enabled=1`, [g]),
    },
    self_promo: {
        input: 'channel',
        run: (g, { channelId }) => pool.execute(
            `INSERT INTO self_promo_config (guild_id, enabled, channel_id, allowed_platforms) VALUES (?,1,?,?)
             ON DUPLICATE KEY UPDATE enabled=1, channel_id=VALUES(channel_id)`,
            [g, channelId, JSON.stringify(['twitch', 'kick', 'youtube'])]),
    },
    counting: {
        input: 'channel',
        run: (g, { channelId }) => pool.execute(
            `INSERT INTO counting_channels (guild_id, channel_id, current_count) VALUES (?,?,0)
             ON DUPLICATE KEY UPDATE channel_id=VALUES(channel_id)`, [g, channelId]),
    },
    qotd: {
        input: 'channel',
        run: (g, { channelId }) => pool.execute(
            `INSERT INTO qotd_channels (guild_id, channel_id, enabled) VALUES (?,?,1)
             ON DUPLICATE KEY UPDATE channel_id=VALUES(channel_id), enabled=1`, [g, channelId]),
    },
    confessions: {
        input: 'channel',
        run: (g, { channelId }) => pool.execute(
            `INSERT INTO confession_config (guild_id, channel_id, enabled) VALUES (?,?,1)
             ON DUPLICATE KEY UPDATE channel_id=VALUES(channel_id), enabled=1`, [g, channelId]),
    },
    verification: {
        input: 'role',
        run: (g, { roleId }) => pool.execute(
            `INSERT INTO verify_config (guild_id, verified_role_id, enabled) VALUES (?,?,1)
             ON DUPLICATE KEY UPDATE verified_role_id=VALUES(verified_role_id), enabled=1`,
            [g, roleId]),
    },
};

// ---------------------------------------------------------------------------
// Presets — what makes this per-guild rather than one list for everyone.
//
// Each names what a server of that shape almost always wants. A recommendation,
// never a lock: every preset lands back on the overview where anything can
// still be toggled individually.
// ---------------------------------------------------------------------------
export const PRESETS = {
    streaming: {
        emoji: '📡', label: 'Streaming community',
        blurb: 'Go-live alerts, self-promo signup, and the social glue around them.',
        features: ['stream_alerts', 'self_promo', 'welcome', 'leveling', 'logging', 'automod', 'phishing'],
    },
    gaming: {
        emoji: '🎮', label: 'Gaming server',
        blurb: 'Games, economy and levelling, with moderation underneath.',
        features: ['leveling', 'economy', 'counting', 'word_games', 'welcome', 'automod', 'anti_raid'],
    },
    community: {
        emoji: '💬', label: 'General community',
        blurb: 'Engagement and safety — what most servers want first.',
        features: ['welcome', 'leveling', 'starboard', 'suggestions', 'birthdays', 'qotd', 'logging', 'automod', 'phishing'],
    },
    support: {
        emoji: '🛟', label: 'Support / business',
        blurb: 'Tickets, verification and a full audit trail.',
        features: ['tickets', 'verification', 'logging', 'automod', 'anti_nuke', 'phishing'],
    },
    safety: {
        emoji: '🛡️', label: 'Just the safety net',
        blurb: 'Moderation and anti-abuse only. Nothing social, nothing noisy.',
        features: ['automod', 'phishing', 'anti_raid', 'anti_nuke', 'logging', 'verification'],
    },
};

/** Registry features this wizard can enable in one click. */
export function setupableFeatures() {
    return REGISTRY.filter((f) => ACTIONS[f.key]);
}

const featureByKey = (key) => REGISTRY.find((f) => f.key === key) || null;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Landing view.
 *
 * Leads with the guild's ACTUAL state rather than a generic welcome, because an
 * admin re-running /setup wants to see where they got to, not be greeted.
 */
export async function renderHome(guildId, guildName = 'this server') {
    const catalog = await catalogFor(guildId);
    const isOn = (key) => catalog.find((c) => c.key === key)?.active;

    const active = catalog.filter((f) => f.active);
    const setupable = setupableFeatures();
    const oneClickAway = setupable.filter((f) => !isOn(f.key));

    const embed = new EmbedBuilder()
        .setColor(themeColor(guildId, 'primary'))
        .setTitle('⚙️ Setup')
        .setDescription(
            active.length
                ? `**${guildName}** has **${active.length} of ${catalog.length}** features running.\n\nJump to a category to fine-tune, or start from a preset if you'd rather not decide one at a time.`
                : `Nothing is set up in **${guildName}** yet.\n\nThe quickest start is a preset — pick the closest match and adjust after. Or browse by category and choose everything yourself.`
        );

    if (active.length) {
        embed.addFields({ name: `✅ Already running (${active.length})`, value: clip(active.map((f) => f.name)) });
    }
    if (oneClickAway.length) {
        embed.addFields({ name: `⬜ One click away (${oneClickAway.length})`, value: clip(oneClickAway.map((f) => f.name)) });
    }

    embed.setFooter({ text: 'Nothing here is permanent — anything can be changed later.' });

    const presetMenu = new StringSelectMenuBuilder()
        .setCustomId('setup_preset_menu')
        .setPlaceholder('Start from a preset…')
        .addOptions(Object.entries(PRESETS).map(([key, p]) => ({
            label: p.label, value: key, emoji: p.emoji, description: p.blurb.slice(0, 100),
        })));

    const categories = [...new Set(setupable.map((f) => f.category))];
    const catMenu = new StringSelectMenuBuilder()
        .setCustomId('setup_cat_menu')
        .setPlaceholder('Or jump to a category…')
        .addOptions(categories.slice(0, 25).map((c) => {
            const inCat = setupable.filter((f) => f.category === c);
            const on = inCat.filter((f) => isOn(f.key)).length;
            return { label: c, value: c, description: `${on} of ${inCat.length} on` };
        }));

    return {
        embeds: [embed],
        components: [
            new ActionRowBuilder().addComponents(presetMenu),
            new ActionRowBuilder().addComponents(catMenu),
        ],
    };
}

/**
 * A preset, with what Apply would actually change spelled out.
 *
 * Split by whether the wizard can enable it unattended, so the preview never
 * promises something the button won't deliver.
 */
export async function renderPreset(guildId, presetKey) {
    const preset = PRESETS[presetKey];
    if (!preset) return renderHome(guildId);

    const catalog = await catalogFor(guildId);
    const isOn = (k) => catalog.find((c) => c.key === k)?.active;

    const wouldEnable = preset.features.filter((k) => ACTIONS[k]?.input === 'none' && !isOn(k));
    const needsInput = preset.features.filter((k) => ACTIONS[k] && ACTIONS[k].input !== 'none' && !isOn(k));
    const already = preset.features.filter((k) => isOn(k));
    const manual = preset.features.filter((k) => !ACTIONS[k] && !isOn(k));

    const names = (keys) => clip(keys.map((k) => featureByKey(k)?.name || k));

    const embed = new EmbedBuilder()
        .setColor(themeColor(guildId, 'primary'))
        .setTitle(`${preset.emoji} ${preset.label}`)
        .setDescription(preset.blurb);

    if (wouldEnable.length) embed.addFields({ name: `✅ Apply turns these on now (${wouldEnable.length})`, value: names(wouldEnable) });
    if (needsInput.length) embed.addFields({ name: `📝 Need a channel or role from you (${needsInput.length})`, value: names(needsInput) });
    if (already.length) embed.addFields({ name: `✔️ Already on (${already.length})`, value: names(already) });
    if (manual.length) embed.addFields({ name: `🔧 Set up on the dashboard (${manual.length})`, value: names(manual) });

    embed.setFooter({ text: 'Apply only switches on what needs no input. The rest stay for you.' });

    return {
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`setup_apply_${presetKey}`)
                .setLabel(wouldEnable.length ? `Apply (${wouldEnable.length})` : 'Nothing to apply')
                .setStyle(ButtonStyle.Success).setEmoji('✅')
                .setDisabled(wouldEnable.length === 0),
            new ButtonBuilder().setCustomId('setup_home_x').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('◀️'),
        )],
    };
}

/** One category. A select rather than a button grid, so it scales past 5 features. */
export async function renderCategory(guildId, category) {
    const catalog = await catalogFor(guildId);
    const isOn = (key) => catalog.find((c) => c.key === key)?.active;
    const features = setupableFeatures().filter((f) => f.category === category);

    if (!features.length) return renderHome(guildId);

    const embed = new EmbedBuilder()
        .setColor(themeColor(guildId, 'primary'))
        .setTitle(`⚙️ Setup • ${category}`)
        .setDescription(features.map((f) => `${isOn(f.key) ? '🟢' : '⚪'} **${f.name}** — ${f.description}`).join('\n\n'))
        .setFooter({ text: 'Pick one below to configure it.' });

    const menu = new StringSelectMenuBuilder()
        .setCustomId(`setup_feat_${category}`)
        .setPlaceholder('Configure a feature…')
        .addOptions(features.slice(0, 25).map((f) => ({
            label: f.name.slice(0, 100),
            value: f.key,
            emoji: isOn(f.key) ? '🟢' : '⚪',
            description: (isOn(f.key) ? 'Already on — reconfigure' : f.description).slice(0, 100),
        })));

    return {
        embeds: [embed],
        components: [
            new ActionRowBuilder().addComponents(menu),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('setup_home_x').setLabel('Back to overview').setStyle(ButtonStyle.Secondary).setEmoji('◀️')
            ),
        ],
    };
}

/** The control for one feature — channel picker, role picker, or a button. */
export async function renderFeature(guildId, featureKey) {
    const feature = featureByKey(featureKey);
    const action = ACTIONS[featureKey];
    if (!feature || !action) return renderHome(guildId);

    const catalog = await catalogFor(guildId);
    const on = catalog.find((c) => c.key === featureKey)?.active;

    const embed = new EmbedBuilder()
        .setColor(themeColor(guildId, on ? 'success' : 'primary'))
        .setAuthor({ name: `Setup • ${feature.category}` })
        .setTitle(feature.name)
        .setDescription(feature.description)
        .addFields({ name: 'Status', value: on ? '🟢 Running' : '⚪ Not set up', inline: true });

    if (feature.command) embed.addFields({ name: 'Command', value: `\`${feature.command}\``, inline: true });

    const rows = [];

    if (action.input === 'channel' || action.input === 'channel_optional') {
        rows.push(new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
                .setCustomId(`setup_chan_${featureKey}`)
                .setPlaceholder(action.input === 'channel_optional' ? 'Pick a channel (optional)…' : 'Pick a channel to turn this on…')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setMinValues(1).setMaxValues(1)
        ));
    } else if (action.input === 'role') {
        rows.push(new ActionRowBuilder().addComponents(
            new RoleSelectMenuBuilder()
                .setCustomId(`setup_role_${featureKey}`)
                .setPlaceholder('Pick the role to grant…')
                .setMinValues(1).setMaxValues(1)
        ));
    }

    const buttons = [];
    if (action.input === 'none' || action.input === 'channel_optional') {
        buttons.push(new ButtonBuilder()
            .setCustomId(`setup_on_${featureKey}`)
            .setLabel(action.input === 'channel_optional' ? 'Turn on (no channel)' : 'Turn on')
            .setStyle(ButtonStyle.Success).setEmoji('✅'));
    }
    buttons.push(new ButtonBuilder().setCustomId(`setup_cat_${feature.category}`).setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('◀️'));
    rows.push(new ActionRowBuilder().addComponents(buttons));

    return { embeds: [embed], components: rows };
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/** Turn on one feature. Idempotent — safe to click twice. */
export async function applyFeature(guildId, featureKey, opts = {}) {
    const action = ACTIONS[featureKey];
    if (!action) throw new Error(`No setup action for "${featureKey}"`);
    await action.run(guildId, opts);
    logger.info(`[setup] enabled ${featureKey}`, { guildId, ...opts });
}

/**
 * Apply a preset's no-input recommendations.
 *
 * Only what needs nothing from the user. Anything wanting a channel or role is
 * left alone rather than guessed at — picking a channel on someone's behalf is
 * how a wizard ends up posting welcome messages into #staff-only.
 *
 * Per-feature failures are collected, not thrown: one bad table must not
 * abandon the other six enables that would have worked.
 */
export async function applyPreset(guildId, presetKey) {
    const preset = PRESETS[presetKey];
    if (!preset) return { enabled: [], failed: [] };

    const catalog = await catalogFor(guildId);
    const isOn = (k) => catalog.find((c) => c.key === k)?.active;

    const enabled = [];
    const failed = [];

    for (const key of preset.features) {
        if (ACTIONS[key]?.input !== 'none' || isOn(key)) continue;
        try {
            await ACTIONS[key].run(guildId, {});
            enabled.push(featureByKey(key)?.name || key);
        } catch (error) {
            failed.push(`${featureByKey(key)?.name || key}: ${error.message}`);
            logger.error(`[setup] preset enable failed for ${key}`, { guildId, error: error.message });
        }
    }

    return { enabled, failed };
}

/** Result screen after a preset is applied. */
export async function renderApplied(guildId, presetKey, result) {
    const preset = PRESETS[presetKey];

    const embed = new EmbedBuilder()
        .setColor(themeColor(guildId, result.failed.length ? 'warning' : 'success'))
        .setTitle(`${preset?.emoji || '✅'} ${preset?.label || 'Preset'} applied`)
        .setDescription(
            result.enabled.length
                ? `Turned on **${result.enabled.length}** feature${result.enabled.length === 1 ? '' : 's'}.`
                : 'Nothing needed turning on — it was already running.'
        );

    if (result.enabled.length) embed.addFields({ name: 'Enabled', value: clip(result.enabled) });

    // Surfaced, never swallowed — a silent partial failure is how someone ends
    // up believing moderation is on when it isn't.
    if (result.failed.length) {
        embed.addFields({ name: `⚠️ Could not enable (${result.failed.length})`, value: clip(result.failed) });
    }

    const stillNeeded = (preset?.features || []).filter((k) => ACTIONS[k] && ACTIONS[k].input !== 'none');
    if (stillNeeded.length) {
        embed.addFields({
            name: 'Still needs a channel or role from you',
            value: clip(stillNeeded.map((k) => featureByKey(k)?.name || k)),
        });
    }

    return {
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('setup_home_x').setLabel('Back to overview').setStyle(ButtonStyle.Primary).setEmoji('⚙️')
        )],
    };
}

/** Bullet list clipped to Discord's 1024-char field limit, with an honest remainder. */
function clip(items, max = 1000) {
    if (!items.length) return '*none*';
    const out = [];
    let length = 0;
    for (const item of items) {
        const line = `• ${item}`;
        if (length + line.length + 1 > max - 28) {
            out.push(`*…and ${items.length - out.length} more*`);
            break;
        }
        out.push(line);
        length += line.length + 1;
    }
    return out.join('\n');
}

export default {
    renderHome, renderPreset, renderCategory, renderFeature,
    applyFeature, applyPreset, renderApplied,
    PRESETS, setupableFeatures,
};
