/*
 * "Stream schedule look" — the picker behind the build panel button.
 *
 * Three decisions, in the order they matter: what shape the card is, where its
 * backdrop comes from, and a preview before anything is saved. Same
 * preview-then-confirm rule as the rest of the build panel.
 */
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, AttachmentBuilder } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

const may = (m) => m.permissions.has(PermissionFlagsBits.ManageGuild)
    || m.permissions.has(PermissionFlagsBits.Administrator);

async function config(guildId) {
    const [[row]] = await pool.execute(
        'SELECT * FROM twitch_schedule_sync_config WHERE guild_id = ? LIMIT 1', [guildId]);
    return row || null;
}

/** Sample rows so a preview looks like a schedule even before Twitch is read. */
function sampleRows() {
    return [
        { day: 'Monday', time: '10:00 PM – 12:30 AM', title: 'Fortnite' },
        { day: 'Wednesday', time: '8:00 PM – 11:00 PM', title: 'Sponsor Games + Fortnite' },
        { day: 'Friday', time: '10:00 PM – 12:30 AM', title: 'Fortnite' },
        { day: 'Saturday', time: '8:00 PM – 11:00 PM', title: 'Fortnite' },
        { day: 'Sunday', time: '', title: 'Rest day' },
    ];
}

export async function handleScheduleStyle(interaction) {
    if (!may(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
    const cfg = await config(interaction.guild.id);
    if (!cfg) {
        return interaction.reply({
            content: 'There is no Twitch schedule set up for this server yet, so there is nothing to restyle.',
            ephemeral: true,
        });
    }
    return interaction.reply({
        ephemeral: true,
        embeds: [new EmbedBuilder().setTitle('Stream schedule look').setColor(0x9146FF)
            .setDescription(
                `**Now:** ${cfg.layout || 'month'} card, ${cfg.background_mode || 'default'} background.\n\n` +
                '**Shape**\n' +
                '**Overlay** — wide card, artwork down the right, one line per day.\n' +
                '**Rows** — tall card, a box per day with the game beside it.\n' +
                '**Month grid** — the plain Sun–Sat calendar.')],
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('schedstyle_layout:overlay').setLabel('Overlay').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('schedstyle_layout:rows').setLabel('Rows').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('schedstyle_layout:month').setLabel('Month grid').setStyle(ButtonStyle.Secondary)),
        ],
    });
}

export async function handleScheduleLayout(interaction) {
    const layout = interaction.customId.split(':')[1];
    await pool.execute('UPDATE twitch_schedule_sync_config SET layout = ? WHERE guild_id = ?',
        [layout, interaction.guild.id]);
    if (layout === 'month') {
        return interaction.update({
            content: 'Set to the month grid. That one has no background options.',
            embeds: [], components: [],
        });
    }
    return interaction.update({
        embeds: [new EmbedBuilder().setTitle(`${layout === 'rows' ? 'Rows' : 'Overlay'} card — the background`)
            .setColor(0x9146FF)
            .setDescription(
                '**Match one of your old schedules** — paste a link to a schedule you like. The bot reads its ' +
                'colours and mood and makes fresh artwork in the same style, with no old dates on it. ' +
                'Best option if what you have is a finished poster.\n\n' +
                '**Use an image exactly** — paste a link and it is used as-is. Good for a plain backdrop; ' +
                'if the image has writing on it, that writing will still be there behind the new text.\n\n' +
                '**Describe it** — type what you want and the artwork is made from that.\n\n' +
                '**Plain** — a drawn gradient in your accent colour. Costs nothing, never fails.')],
        components: [
            new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('schedstyle_bg:style').setLabel('Match one of my schedules').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('schedstyle_bg:upload').setLabel('Use an image exactly').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('schedstyle_bg:prompt').setLabel('Describe it').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('schedstyle_bg:default').setLabel('Plain').setStyle(ButtonStyle.Secondary)),
        ],
    });
}

export async function handleScheduleBackground(interaction) {
    const mode = interaction.customId.split(':')[1];
    if (mode === 'default') {
        await pool.execute(
            `UPDATE twitch_schedule_sync_config
                SET background_mode='default', background_cache_url=NULL WHERE guild_id=?`,
            [interaction.guild.id]);
        return preview(interaction, true);
    }
    const isImage = mode === 'style' || mode === 'upload';
    return interaction.showModal({
        custom_id: `schedstyle_modal:${mode}`,
        title: mode === 'style' ? 'Match one of my schedules' : mode === 'upload' ? 'Use an image' : 'Describe the artwork',
        components: [
            { type: 1, components: [{
                type: 4, custom_id: 'value', style: isImage ? 1 : 2, required: true, max_length: 900,
                label: isImage ? 'Link to the image' : 'What should it look like?',
                placeholder: isImage
                    ? 'Right-click the image in Discord and Copy Link'
                    : 'gothic metal, red and black, skulls and roses',
            }] },
            ...(mode === 'style' ? [{ type: 1, components: [{
                type: 4, custom_id: 'extra', style: 1, required: false, max_length: 200,
                label: 'Anything to add? (optional)', placeholder: 'more roses, less chain',
            }] }] : []),
        ],
    });
}

export async function handleScheduleStyleModal(interaction) {
    const mode = interaction.customId.split(':')[1];
    const value = interaction.fields.getTextInputValue('value').trim();
    let extra = '';
    try { extra = (interaction.fields.getTextInputValue('extra') || '').trim(); } catch { /* not on every modal */ }

    if ((mode === 'style' || mode === 'upload') && !/^https?:\/\//i.test(value)) {
        return interaction.reply({
            content: 'That needs to be a link. Right-click the image in Discord and pick **Copy Link**.',
            ephemeral: true,
        });
    }
    // Clearing the cache is what makes a change take effect rather than silently
    // reusing the artwork generated for the previous answer.
    await pool.execute(
        `UPDATE twitch_schedule_sync_config
            SET background_mode=?, background_url=?, background_prompt=?, background_cache_url=NULL
          WHERE guild_id=?`,
        [mode,
            (mode === 'style' || mode === 'upload') ? value : null,
            mode === 'prompt' ? value : (extra || null),
            interaction.guild.id]);
    return preview(interaction, false);
}

/** Render the card as it will actually appear and show it before saving anything else. */
async function preview(interaction, fromUpdate) {
    const reply = fromUpdate
        ? (p) => interaction.update(p)
        : (p) => interaction.reply({ ...p, ephemeral: true });
    if (fromUpdate) await interaction.deferUpdate().catch(() => {});
    else await interaction.deferReply({ ephemeral: true }).catch(() => {});

    const cfg = await config(interaction.guild.id);
    try {
        const { renderSchedule } = await import('../../core/schedule-art.js');
        const { resolveBackground } = await import('../../utils/schedule-background.js');
        const { buffer, mode } = await resolveBackground(cfg);
        const png = await renderSchedule({
            layout: cfg.layout,
            title: cfg.card_title || cfg.username || interaction.guild.name,
            subtitle: 'Twitch schedule · preview',
            footer: cfg.card_footer || 'All times shown in your server timezone',
            accent: cfg.accent_color || '#C7A5E8',
            rows: sampleRows(),
            mode: buffer ? mode : 'default',
            imageBuffer: buffer,
        });
        if (!png) throw new Error('nothing rendered');
        // Remember the generated art so the next sync does not pay for it again.
        if (mode === 'style' || mode === 'prompt') {
            const { cacheUrl } = await resolveBackground(cfg).catch(() => ({}));
            if (cacheUrl) await pool.execute(
                'UPDATE twitch_schedule_sync_config SET background_cache_url=? WHERE guild_id=?',
                [cacheUrl, interaction.guild.id]);
        }
        const file = new AttachmentBuilder(png, { name: 'schedule-preview.png' });
        const note = mode === 'default' && (cfg.background_mode !== 'default')
            ? '\n\n⚠️ The backdrop you chose could not be used, so this is the plain one. Check the link is public.'
            : '';
        return interaction.editReply({
            content: `**${cfg.layout}** card, **${cfg.background_mode}** background. This is how it will post.${note}`,
            embeds: [], components: [], files: [file],
        });
    } catch (e) {
        logger.error(`[ScheduleStyle] preview failed: ${e.message}`, { guildId: interaction.guild.id });
        return interaction.editReply({
            content: `Saved, but the preview failed: ${e.message}`, embeds: [], components: [],
        });
    }
}

/**
 * "Update schedule now" — run the sync this instant instead of waiting for the tick.
 *
 * Twitch has no EventSub topic for schedule changes, so this is a poll however
 * you dress it. The poll is cheap — a hash comparison decides whether anything
 * is re-rendered — so the interval carries the automatic case and this button
 * carries the "I just changed it and want to see it" case.
 */
export async function handleScheduleNow(interaction) {
    if (!may(interaction.member)) return interaction.reply({ content: 'Staff only.', ephemeral: true });
    const cfg = await config(interaction.guild.id);
    if (!cfg) return interaction.reply({ content: 'No Twitch schedule is set up here.', ephemeral: true });

    await interaction.deferReply({ ephemeral: true });
    try {
        const { default: TwitchScheduleManager } = await import('../../core/twitch-schedule-manager.js');
        const manager = new TwitchScheduleManager(interaction.client);
        // Re-read through the manager's own query so the row carries every column
        // the renderer needs — the style fields live outside this table's basics.
        const syncs = await manager.getEnabledSyncs();
        const mine = syncs.find(s => s.guild_id === interaction.guild.id);
        if (!mine) {
            return interaction.editReply('That schedule is switched off, so there is nothing to pull.');
        }
        // skipCooldown so an unchanged schedule still re-renders: she may have
        // changed the LOOK rather than the times, and "nothing happened" would
        // read as a broken button.
        const result = await manager.syncSchedule(mine, { skipCooldown: true });
        const changed = result?.updated ?? result?.posted ?? true;
        return interaction.editReply(changed
            ? 'Pulled from Twitch and the post is up to date.'
            : 'Pulled from Twitch — nothing had changed, so the post is unchanged.');
    } catch (e) {
        logger.error(`[ScheduleStyle] manual sync failed: ${e.message}`, { guildId: interaction.guild.id });
        return interaction.editReply(`Could not reach Twitch: ${e.message}`);
    }
}
