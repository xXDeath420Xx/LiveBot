// In-process repair for guild 927416865112870923 (Chibi's Channel)
// after the botched server transfer on 2026-04-15. Invoked from index.js
// at the end of startup; idempotent, so it's safe to leave the call in.
//
// What it fixes:
//   1. Music panel — rebuilds using the real MusicPanel class so the
//      add-song select menu + correct button customIds are restored
//      (the transfer had built a dumb stub with dead buttons).
//   2. Reaction role panels — sets sensible default descriptions on
//      the three panels whose description column was null in the DB,
//      then edits the live Discord messages in place so the rendered
//      embeds actually show the new text.
//
// Safety:
//   - Uses the LIVE Chibi Bot client from global.botManager. No second
//     Discord session is opened. No competing login.
//   - Idempotent: skips any step whose target state is already correct.

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

const GUILD_ID = '927416865112870923';
const CHIBI_BOT_ID = '1493873873098375358';
const LOG = '[ChibiRepair]';

// Intro text used as the panel description. Buttons carry the role names
// themselves now (via setLabel), so no legend is needed.
const REACTION_PANEL_INTROS = {
    49: 'Click a button below to toggle a game role. Click again to remove it.',
    50: 'Click a button below to toggle a notification role. Click again to remove it.',
    52: "Click the button below to confirm you've read the rules and unlock access to the rest of the server.",
};

function buildLegendDescription(panelId /*, mappings, guild */) {
    return REACTION_PANEL_INTROS[panelId] || 'Click a button below to toggle a role.';
}

function resolveStyle(name) {
    const s = (name || 'primary').toLowerCase();
    return {
        primary: ButtonStyle.Primary,
        secondary: ButtonStyle.Secondary,
        success: ButtonStyle.Success,
        danger: ButtonStyle.Danger,
        link: ButtonStyle.Link,
    }[s] || ButtonStyle.Primary;
}

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

        // Always set a label so users can tell what each button does. Prefer
        // an explicit DB label, fall back to the live role name (auto-updates
        // if the role is renamed), fall back to a generic placeholder last.
        // Discord caps button labels at 80 chars.
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
    try {
        return parseInt(String(hex).replace('#', ''), 16);
    } catch {
        return 0x5865F2;
    }
}

async function repairMusicPanel(chibiClient, guild) {
    const [rows] = await pool.execute(
        'SELECT channel_id, message_id FROM music_panels WHERE guild_id = ?',
        [GUILD_ID]
    );
    if (rows.length === 0) {
        logger.info(`${LOG} No music_panels row, skipping`);
        return;
    }
    const { channel_id, message_id } = rows[0];

    const channel = await guild.channels.fetch(channel_id).catch(() => null);
    if (!channel) {
        logger.warn(`${LOG} Music channel ${channel_id} not accessible, skipping`);
        return;
    }

    // Idempotency: fetch current message, check if it has the music-add-song
    // select menu (correct rebuild) vs just disabled buttons (stub).
    let needsRebuild = true;
    const existing = message_id ? await channel.messages.fetch(message_id).catch(() => null) : null;
    if (existing) {
        const hasAddSongMenu = existing.components?.some(row =>
            row.components?.some(c => c.customId === 'music-add-song')
        );
        if (hasAddSongMenu) {
            logger.info(`${LOG} Music panel already correct, skipping rebuild`);
            needsRebuild = false;
        }
    }

    if (!needsRebuild) {
        // Still register in live panel manager so events update it
        const { default: MusicPanel } = await import('../core/music-panel.js');
        const panel = new MusicPanel(chibiClient, GUILD_ID);
        panel.message = existing;
        chibiClient.musicPanelManager?.set(GUILD_ID, panel);
        global.musicPanelManager?.set(GUILD_ID, panel);
        return;
    }

    const { default: MusicPanel } = await import('../core/music-panel.js');
    const panel = new MusicPanel(chibiClient, GUILD_ID);
    const embed = await panel.buildEmbed(null);
    const components = panel.buildComponents(null);

    const newMsg = await channel.send({ embeds: [embed], components });
    logger.info(`${LOG} Posted new music panel ${newMsg.id}`);

    if (existing && existing.id !== newMsg.id) {
        await existing.delete().catch(err =>
            logger.warn(`${LOG} Could not delete old stub ${existing.id}: ${err.message}`)
        );
    }

    await pool.execute('UPDATE music_panels SET message_id = ? WHERE guild_id = ?', [newMsg.id, GUILD_ID]);

    panel.message = newMsg;
    chibiClient.musicPanelManager?.set(GUILD_ID, panel);
    global.musicPanelManager?.set(GUILD_ID, panel);
    logger.info(`${LOG} Music panel rebuilt and registered`);
}

async function repairReactionPanels(chibiClient, guild) {
    const [panels] = await pool.execute(
        `SELECT id, panel_name, description, channel_id, message_id, interaction_type,
                panel_mode, embed_color, thumbnail_url, image_url, placeholder_text, max_selections
         FROM reaction_role_panels WHERE guild_id = ?`,
        [GUILD_ID]
    );
    logger.info(`${LOG} Found ${panels.length} reaction panel(s) to check`);

    for (const panel of panels) {
        const channel = await guild.channels.fetch(panel.channel_id).catch(() => null);
        if (!channel) {
            logger.warn(`${LOG} Reaction panel ${panel.id} channel ${panel.channel_id} not accessible`);
            continue;
        }

        const [mappings] = await pool.execute(
            'SELECT role_id, emoji_id, label, button_style FROM reaction_role_mappings WHERE panel_id = ? ORDER BY id',
            [panel.id]
        );

        // Auto-generate a short intro description. Buttons carry the role
        // names via setLabel, so no in-body legend is needed. If the DB has a
        // description we don't recognize as one of our generated forms, leave
        // it alone — the user hand-wrote it in the dashboard.
        const generatedDescription = buildLegendDescription(panel.id, mappings, guild);
        const currentDescription = (panel.description || '').trim();
        const looksGenerated =
            currentDescription === '' ||
            currentDescription === generatedDescription ||
            // Known generated forms from earlier runs of this repair:
            currentDescription.startsWith('Pick the games you play') ||
            currentDescription.startsWith('Choose which pings') ||
            currentDescription.startsWith('Click ✅ to agree to the rules') ||
            currentDescription.startsWith('Click a button below to toggle a game role:') ||
            currentDescription.startsWith('Click a button below to toggle a notification role:') ||
            currentDescription.startsWith("Click ✅ to confirm you've read the rules");

        let description;
        if (looksGenerated) {
            description = generatedDescription;
            if (currentDescription !== generatedDescription) {
                await pool.execute(
                    'UPDATE reaction_role_panels SET description = ? WHERE id = ?',
                    [description, panel.id]
                );
                logger.info(`${LOG} Updated description on panel ${panel.id} (${panel.panel_name})`);
            }
        } else {
            description = panel.description;
            logger.info(`${LOG} Panel ${panel.id} has custom description, leaving alone`);
        }

        const embed = new EmbedBuilder()
            .setTitle(panel.panel_name || 'Role Selection')
            .setColor(parseColor(panel.embed_color));
        if (description) embed.setDescription(description);
        if (panel.thumbnail_url) embed.setThumbnail(panel.thumbnail_url);
        if (panel.image_url) embed.setImage(panel.image_url);

        const components = panel.interaction_type === 'button'
            ? buildButtonsFromMappings(mappings, guild)
            : []; // only rebuild buttons in this repair run; the 3 target panels are all button-type

        // Idempotency: skip only if title, description, button count AND every
        // button already has a non-empty label (so a label-less panel always
        // gets rebuilt even if description and count match).
        const existing = panel.message_id ? await channel.messages.fetch(panel.message_id).catch(() => null) : null;
        if (existing) {
            const existingEmbed = existing.embeds[0];
            const existingButtonCount = existing.components?.reduce((n, row) => n + (row.components?.length || 0), 0) || 0;
            const expectedButtonCount = components.reduce((n, row) => n + row.components.length, 0);
            const allButtonsLabeled = (existing.components || []).every(row =>
                (row.components || []).every(c => c.label && c.label.length > 0)
            );
            const titleOk = existingEmbed?.title === (panel.panel_name || 'Role Selection');
            const descOk = (existingEmbed?.description || null) === (description || null);
            const countOk = existingButtonCount === expectedButtonCount;
            if (titleOk && descOk && countOk && allButtonsLabeled) {
                logger.info(`${LOG} Panel ${panel.id} already matches DB, skipping rebuild`);
                continue;
            }
        }

        // Edit existing message in place if possible (avoids deleting/reposting,
        // preserves reactions if any, keeps position in channel)
        if (existing) {
            try {
                await existing.edit({ embeds: [embed], components });
                logger.info(`${LOG} Edited panel ${panel.id} (${panel.panel_name}) in place`);
                continue;
            } catch (err) {
                logger.warn(`${LOG} In-place edit failed for panel ${panel.id}, falling back to repost: ${err.message}`);
            }
        }

        // Fallback: repost
        try {
            const newMsg = await channel.send({ embeds: [embed], components });
            if (existing) await existing.delete().catch(() => {});
            await pool.execute(
                'UPDATE reaction_role_panels SET message_id = ? WHERE id = ?',
                [newMsg.id, panel.id]
            );
            logger.info(`${LOG} Reposted panel ${panel.id} as ${newMsg.id}`);
        } catch (err) {
            logger.error(`${LOG} Failed to rebuild panel ${panel.id}: ${err.message}`);
        }
    }
}

export async function runChibiPanelRepair() {
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

        logger.info(`${LOG} Starting repair for ${guild.name} (${GUILD_ID})`);
        await repairMusicPanel(chibiClient, guild);
        await repairReactionPanels(chibiClient, guild);
        logger.info(`${LOG} Repair complete`);
    } catch (err) {
        logger.error(`${LOG} Unexpected failure: ${err.message}`, { stack: err.stack });
    }
}

export default runChibiPanelRepair;
