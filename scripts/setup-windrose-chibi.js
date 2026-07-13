// In-process, idempotent Windrose setup for guild 927416865112870923
// (Chibi's Channel). Invoked from index.js at startup, after the existing
// runChibiPanelRepair() call. Safe to leave permanently; every step
// short-circuits once the target state already exists.
//
// What it does:
//   1. Introspects the guild for an existing game-themed category to copy
//      its permission overwrite shape, child channel composition, and role
//      styling. Falls back to documented defaults if no template found.
//   2. Creates the "🌹 Windrose" role (mentionable so the Steam watcher
//      can ping it).
//   3. Creates the "🌹 Windrose" category gated to that role, with chat
//      and voice channels mirroring the discovered template, plus a
//      read-only #windrose-news channel.
//   4. Adds Windrose as a new button on the existing game-roles panel
//      (DB id 49) and rebuilds the live message in place.
//   5. Registers a steam_watchers row for app 3041230 → #windrose-news,
//      with the Windrose role in mention_role_ids.
//
// Safety:
//   - Uses the LIVE Chibi Bot client from global.botManager. No second
//     Discord session is opened. No competing login.
//   - Idempotent: each step skips itself when its target state is correct.

import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    PermissionFlagsBits,
    OverwriteType,
} from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const GUILD_ID = '927416865112870923';
const CHIBI_BOT_ID = '1493873873098375358';
const GAME_PANEL_ID = 49;
const STEAM_APP_ID = '3041230';
const ROLE_NAME = '🌹 Windrose';
const CATEGORY_NAME = '🌹 Windrose';
const NEWS_CHANNEL_NAME = 'windrose-news';
const CHAT_CHANNEL_NAME = 'windrose-chat';
const VOICE_CHANNEL_NAME = 'Windrose Voice';
const BUTTON_EMOJI = '🌹';
const BUTTON_LABEL = 'Windrose';
const LOG = '[WindroseSetup]';

// Documented fallback used only when no existing game category can be
// detected to mirror.
const DEFAULT_ROLE_COLOR = '#a78bfa';

function resolveStyle(name) {
    return {
        primary: ButtonStyle.Primary,
        secondary: ButtonStyle.Secondary,
        success: ButtonStyle.Success,
        danger: ButtonStyle.Danger,
        link: ButtonStyle.Link,
    }[(name || 'primary').toLowerCase()] || ButtonStyle.Primary;
}

// Same button-rendering shape as fix-chibi-panels.js so the rebuilt panel
// looks identical to the existing game-roles buttons.
function buildButtonsFromMappings(mappings, guild) {
    const rows = [];
    let row = new ActionRowBuilder();
    for (const m of mappings) {
        if (row.components.length >= 5) {
            rows.push(row);
            row = new ActionRowBuilder();
        }
        const btn = new ButtonBuilder()
            .setCustomId(`rr_${m.role_id}`)
            .setStyle(resolveStyle(m.button_style));
        if (m.emoji_id) btn.setEmoji(m.emoji_id);

        let label = m.label;
        if (!label) {
            const role = guild.roles.cache.get(m.role_id);
            label = role?.name || 'Role';
        }
        btn.setLabel(label.length > 80 ? label.slice(0, 77) + '…' : label);
        row.addComponents(btn);
    }
    if (row.components.length > 0) rows.push(row);
    return rows;
}

function parseColor(hex) {
    if (!hex) return 0x5865F2;
    try { return parseInt(String(hex).replace('#', ''), 16); }
    catch { return 0x5865F2; }
}

// Pick an existing game-themed category to model the new one on. A
// "game category" here = a guild category whose @everyone permission
// overwrite denies ViewChannel AND has at least one role-id overwrite
// that allows ViewChannel. We exclude obvious non-game categories
// (logs, mod, staff, ticket, voice, lobby, general, info, music).
function findTemplateGameCategory(guild) {
    const NON_GAME_RX = /log|mod|staff|admin|ticket|info|rules|welcome|general|lobby|music|stage|announcement|stream|verify|color/i;
    const categories = guild.channels.cache.filter(c =>
        c.type === ChannelType.GuildCategory && !NON_GAME_RX.test(c.name)
    );

    for (const cat of categories.values()) {
        const everyone = cat.permissionOverwrites.cache.get(guild.id);
        if (!everyone || !everyone.deny.has(PermissionFlagsBits.ViewChannel)) continue;

        const roleAllow = cat.permissionOverwrites.cache.find(o =>
            o.type === OverwriteType.Role &&
            o.id !== guild.id &&
            o.allow.has(PermissionFlagsBits.ViewChannel)
        );
        if (!roleAllow) continue;

        const role = guild.roles.cache.get(roleAllow.id);
        if (!role) continue;

        return { category: cat, role };
    }
    return null;
}

async function ensureWindroseRole(guild, template) {
    let role = guild.roles.cache.find(r => r.name === ROLE_NAME);
    if (role) {
        logger.info(`${LOG} Role "${ROLE_NAME}" already exists (${role.id})`);
        // Make sure it's mentionable so the Steam watcher can ping it,
        // even if a previous run created it without that flag.
        if (!role.mentionable) {
            await role.setMentionable(true, 'WindroseSetup: required for Steam news pings');
            logger.info(`${LOG} Flipped role ${role.id} to mentionable`);
        }
        return role;
    }

    const opts = {
        name: ROLE_NAME,
        hoist: template?.role.hoist ?? true,
        mentionable: true,
        color: template?.role.hexColor && template.role.hexColor !== '#000000'
            ? template.role.hexColor
            : DEFAULT_ROLE_COLOR,
        reason: 'WindroseSetup: new game role',
    };
    role = await guild.roles.create(opts);
    logger.info(`${LOG} Created role "${ROLE_NAME}" (${role.id}) color=${opts.color}`);
    return role;
}

// Build category permission overwrites: copy the template's bit pattern
// but substitute the new Windrose role id wherever the template's gating
// role was used. If no template, use a sensible default.
function buildCategoryOverwrites(guild, windroseRoleId, template, botUserId) {
    if (template) {
        const overwrites = [];
        for (const ow of template.category.permissionOverwrites.cache.values()) {
            // Substitute template's gating role for Windrose
            const id = ow.id === template.role.id ? windroseRoleId : ow.id;
            overwrites.push({
                id,
                type: ow.type,
                allow: ow.allow.bitfield,
                deny: ow.deny.bitfield,
            });
        }
        // Make sure Windrose role is in the list even if the template's
        // gating role overwrote a different bit set than expected.
        if (!overwrites.some(o => o.id === windroseRoleId)) {
            overwrites.push({
                id: windroseRoleId,
                type: OverwriteType.Role,
                allow: PermissionFlagsBits.ViewChannel
                    | PermissionFlagsBits.SendMessages
                    | PermissionFlagsBits.Connect
                    | PermissionFlagsBits.Speak,
            });
        }
        // Ensure the bot has manage perms in here so it can post news / repair later
        if (!overwrites.some(o => o.id === botUserId)) {
            overwrites.push({
                id: botUserId,
                type: OverwriteType.Member,
                allow: PermissionFlagsBits.ViewChannel
                    | PermissionFlagsBits.SendMessages
                    | PermissionFlagsBits.EmbedLinks
                    | PermissionFlagsBits.ManageMessages
                    | PermissionFlagsBits.ManageChannels,
            });
        }
        return overwrites;
    }

    // Fallback default
    return [
        { id: guild.id, type: OverwriteType.Role, deny: PermissionFlagsBits.ViewChannel },
        {
            id: windroseRoleId,
            type: OverwriteType.Role,
            allow: PermissionFlagsBits.ViewChannel
                | PermissionFlagsBits.SendMessages
                | PermissionFlagsBits.Connect
                | PermissionFlagsBits.Speak,
        },
        {
            id: botUserId,
            type: OverwriteType.Member,
            allow: PermissionFlagsBits.ViewChannel
                | PermissionFlagsBits.SendMessages
                | PermissionFlagsBits.EmbedLinks
                | PermissionFlagsBits.ManageMessages
                | PermissionFlagsBits.ManageChannels,
        },
    ];
}

async function ensureCategory(guild, windroseRole, template, botUserId) {
    let category = guild.channels.cache.find(c =>
        c.type === ChannelType.GuildCategory && c.name === CATEGORY_NAME
    );
    if (category) {
        logger.info(`${LOG} Category "${CATEGORY_NAME}" already exists (${category.id})`);
        return category;
    }

    category = await guild.channels.create({
        name: CATEGORY_NAME,
        type: ChannelType.GuildCategory,
        permissionOverwrites: buildCategoryOverwrites(guild, windroseRole.id, template, botUserId),
        reason: 'WindroseSetup: new game category',
    });
    logger.info(`${LOG} Created category "${CATEGORY_NAME}" (${category.id})`);
    return category;
}

async function ensureChildChannel(guild, category, name, type, extraOverwrites = null) {
    const existing = guild.channels.cache.find(c =>
        c.type === type && c.name === name && c.parentId === category.id
    );
    if (existing) {
        logger.info(`${LOG} Channel "${name}" already exists (${existing.id})`);
        return existing;
    }

    const opts = {
        name,
        type,
        parent: category.id,
        reason: 'WindroseSetup: new Windrose child channel',
    };
    if (extraOverwrites) opts.permissionOverwrites = extraOverwrites;
    const channel = await guild.channels.create(opts);
    logger.info(`${LOG} Created channel "${name}" (${channel.id})`);
    return channel;
}

async function ensurePanelButton(chibiClient, guild, windroseRole) {
    const [panels] = await pool.execute(
        `SELECT id, panel_name, description, channel_id, message_id, interaction_type,
                panel_mode, embed_color, thumbnail_url, image_url
         FROM reaction_role_panels WHERE id = ? AND guild_id = ?`,
        [GAME_PANEL_ID, GUILD_ID]
    );
    const panel = panels[0];
    if (!panel) {
        logger.warn(`${LOG} Game roles panel ${GAME_PANEL_ID} not found in DB; skipping button add`);
        return;
    }

    // Already on the panel?
    const [existingMappings] = await pool.execute(
        'SELECT id FROM reaction_role_mappings WHERE panel_id = ? AND role_id = ?',
        [panel.id, windroseRole.id]
    );
    if (existingMappings.length > 0) {
        logger.info(`${LOG} Windrose already on game-roles panel ${panel.id}, skipping`);
        return;
    }

    // Insert into emoji_id (canonical render path reads this column —
    // see fix-chibi-panels.js:169). Note: core/reaction-role-manager.js's
    // addRoleToPanel writes to "emoji" instead, which is why we don't
    // call it here.
    await pool.execute(
        `INSERT INTO reaction_role_mappings (panel_id, role_id, emoji_id, label, button_style)
         VALUES (?, ?, ?, ?, ?)`,
        [panel.id, windroseRole.id, BUTTON_EMOJI, BUTTON_LABEL, 'primary']
    );
    logger.info(`${LOG} Inserted Windrose mapping into panel ${panel.id}`);

    // Rebuild the live Discord message so the new button shows up.
    const channel = await guild.channels.fetch(panel.channel_id).catch(() => null);
    if (!channel) {
        logger.warn(`${LOG} Panel ${panel.id} channel ${panel.channel_id} not accessible; mapping inserted but message not rebuilt`);
        return;
    }

    const [mappings] = await pool.execute(
        'SELECT role_id, emoji_id, label, button_style FROM reaction_role_mappings WHERE panel_id = ? ORDER BY id',
        [panel.id]
    );

    const embed = new EmbedBuilder()
        .setTitle(panel.panel_name || 'Role Selection')
        .setColor(parseColor(panel.embed_color));
    if (panel.description) embed.setDescription(panel.description);
    if (panel.thumbnail_url) embed.setThumbnail(panel.thumbnail_url);
    if (panel.image_url) embed.setImage(panel.image_url);

    const components = panel.interaction_type === 'button'
        ? buildButtonsFromMappings(mappings, guild)
        : [];

    const existing = panel.message_id
        ? await channel.messages.fetch(panel.message_id).catch(() => null)
        : null;

    if (existing) {
        try {
            await existing.edit({ embeds: [embed], components });
            logger.info(`${LOG} Edited game-roles panel ${panel.id} in place`);
            return;
        } catch (err) {
            logger.warn(`${LOG} In-place edit of panel ${panel.id} failed (${err.message}); reposting`);
        }
    }

    const newMsg = await channel.send({ embeds: [embed], components });
    if (existing) await existing.delete().catch(() => {});
    await pool.execute(
        'UPDATE reaction_role_panels SET message_id = ? WHERE id = ?',
        [newMsg.id, panel.id]
    );
    logger.info(`${LOG} Reposted game-roles panel ${panel.id} as ${newMsg.id}`);
}

async function ensureSteamWatcher(newsChannelId, windroseRoleId) {
    const [existing] = await pool.execute(
        `SELECT id FROM steam_watchers
         WHERE guild_id = ? AND discord_channel_id = ? AND watcher_type = 'app_news' AND steam_id = ?`,
        [GUILD_ID, newsChannelId, STEAM_APP_ID]
    );
    if (existing.length > 0) {
        logger.info(`${LOG} Steam watcher for app ${STEAM_APP_ID} already exists (id=${existing[0].id})`);
        return;
    }

    const mentionRoles = JSON.stringify([windroseRoleId]);
    const [result] = await pool.execute(
        `INSERT INTO steam_watchers (
            guild_id, discord_channel_id, watcher_type, steam_id, steam_name,
            mention_role_ids, check_interval_minutes, is_enabled
         ) VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)`,
        [GUILD_ID, newsChannelId, 'app_news', STEAM_APP_ID, 'Windrose', mentionRoles, 30]
    );
    logger.info(`${LOG} Registered Steam watcher for app ${STEAM_APP_ID} → channel ${newsChannelId} (watcher id=${result.insertId})`);
}

export async function runWindroseSetup() {
    try {
        const botManager = global.botManager;
        if (!botManager) {
            logger.warn(`${LOG} global.botManager not available, aborting`);
            return;
        }

        const chibiClient = botManager.clients.get(CHIBI_BOT_ID);
        if (!chibiClient || !chibiClient.isReady?.()) {
            logger.warn(`${LOG} Chibi Bot not ready, aborting (will retry next restart)`);
            return;
        }

        const guild = chibiClient.guilds.cache.get(GUILD_ID);
        if (!guild) {
            logger.warn(`${LOG} Chibi Bot not in guild ${GUILD_ID}, aborting`);
            return;
        }

        logger.info(`${LOG} Starting setup for ${guild.name} (${GUILD_ID})`);

        // Make sure caches are populated (the bot manager fetches members/
        // roles/channels at startup, but be defensive).
        if (guild.channels.cache.size === 0) await guild.channels.fetch();
        if (guild.roles.cache.size === 0) await guild.roles.fetch();

        const template = findTemplateGameCategory(guild);
        if (template) {
            logger.info(`${LOG} Using template: category "${template.category.name}" gated to role "${template.role.name}"`);
        } else {
            logger.info(`${LOG} No existing game category found; using documented defaults`);
        }

        const windroseRole = await ensureWindroseRole(guild, template);
        const category = await ensureCategory(guild, windroseRole, template, chibiClient.user.id);

        // Mirror the template's child-channel composition. If the template
        // had at least one voice channel, replicate that. Always include a
        // chat channel and the news channel.
        await ensureChildChannel(guild, category, CHAT_CHANNEL_NAME, ChannelType.GuildText);

        const templateHasVoice = template?.category
            ? guild.channels.cache.some(c => c.parentId === template.category.id && c.type === ChannelType.GuildVoice)
            : true;
        if (templateHasVoice) {
            await ensureChildChannel(guild, category, VOICE_CHANNEL_NAME, ChannelType.GuildVoice);
        }

        // News channel: inherits the category overwrites (so it's gated
        // to Windrose role per user decision), plus a per-channel deny on
        // SendMessages for @everyone and an explicit allow for the bot,
        // making it a read-only feed.
        const newsChannel = await ensureChildChannel(
            guild,
            category,
            NEWS_CHANNEL_NAME,
            ChannelType.GuildText,
            [
                {
                    id: guild.id,
                    type: OverwriteType.Role,
                    deny: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages,
                },
                {
                    id: windroseRole.id,
                    type: OverwriteType.Role,
                    allow: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.ReadMessageHistory,
                    deny: PermissionFlagsBits.SendMessages,
                },
                {
                    id: chibiClient.user.id,
                    type: OverwriteType.Member,
                    allow: PermissionFlagsBits.ViewChannel
                        | PermissionFlagsBits.SendMessages
                        | PermissionFlagsBits.EmbedLinks
                        | PermissionFlagsBits.MentionEveryone
                        | PermissionFlagsBits.ManageMessages,
                },
            ]
        );

        await ensurePanelButton(chibiClient, guild, windroseRole);
        await ensureSteamWatcher(newsChannel.id, windroseRole.id);

        logger.info(`${LOG} Setup complete`);
    } catch (err) {
        logger.error(`${LOG} Unexpected failure: ${err.message}`, { stack: err.stack });
    }
}

export default runWindroseSetup;
