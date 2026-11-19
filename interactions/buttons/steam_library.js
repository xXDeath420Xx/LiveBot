/*
 * Steam library panel buttons (static ids so posted panels survive restarts):
 *   stlib_link     → the member's link state + Steam sign-in / paste options
 *   stlib_share    → count an already-linked library in this server too
 *   stlib_paste    → modal for a profile link (unverified; guild can turn it off)
 *   stlib_refresh  → re-read the library from Steam (10-min cooldown)
 *   stlib_leave    → stop counting in this server (deletes all data if shared nowhere else)
 *   stlib_rsvp:<nightId>:<in|maybe|out> → game night card answers
 * Modal: stlib_paste_modal.
 */
import {
    ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags,
} from 'discord.js';
import {
    SteamLibraryError, buildLinkPrompt, getConfig, getLink, linkAccount, shareWithGuild, syncLibrary,
    refreshWaitMs, refreshPanel, refreshPanels, guildsSharedBy, unshareFromGuild, isSharedWith,
    getNight, setRsvp, buildNightMessage, resolveSteamInput,
} from '../../core/steam-library-manager.js';
import logger from '../../utils/logger.js';

const EPHEMERAL = { flags: MessageFlags.Ephemeral };

const RESULT_TEXT = {
    ok: n => `✅ Linked. **${n}** games counted in this server.`,
    private: () => "🔗 Linked, but **your game list is private on Steam**, so nothing is counted yet.\n" +
        'Steam → your profile → *Edit Profile* → *Privacy Settings* → **Game details: Public**, then press **Refresh my games**.',
    error: () => '🔗 Linked, but Steam did not answer. Your games will be picked up automatically within the hour.',
};

async function fail(interaction, err, where) {
    const content = err instanceof SteamLibraryError ? `❌ ${err.message}` : '❌ Something went wrong. Try again in a minute.';
    if (!(err instanceof SteamLibraryError)) logger.error(`[SteamLibrary] ${where}`, { error: err.message, stack: err.stack });
    if (interaction.deferred || interaction.replied) return interaction.editReply({ content, components: [] }).catch(() => {});
    return interaction.reply({ content, ...EPHEMERAL }).catch(() => {});
}

export async function handleSteamLibraryButton(interaction) {
    const id = interaction.customId;
    const guildId = interaction.guildId;
    const userId = interaction.user.id;
    try {
        if (id.startsWith('stlib_rsvp:')) return await handleRsvp(interaction);

        if (id === 'stlib_link') {
            return await interaction.reply({ ...(await buildLinkPrompt(guildId, userId)), ...EPHEMERAL });
        }

        if (id === 'stlib_paste') {
            const cfg = await getConfig(guildId);
            if (!cfg.allow_unverified) {
                return await interaction.reply({ content: 'This server only accepts **Sign in through Steam**.', ...EPHEMERAL });
            }
            const modal = new ModalBuilder().setCustomId('stlib_paste_modal').setTitle('Link your Steam profile')
                .addComponents(new ActionRowBuilder().addComponents(
                    new TextInputBuilder().setCustomId('profile').setLabel('Steam profile link, custom URL name, or ID')
                        .setPlaceholder('https://steamcommunity.com/id/yourname').setStyle(TextInputStyle.Short)
                        .setRequired(true).setMaxLength(200)));
            return await interaction.showModal(modal);
        }

        if (id === 'stlib_share') {
            const link = await getLink(userId);
            if (!link) return await interaction.update({ ...(await buildLinkPrompt(guildId, userId)) });
            await shareWithGuild(guildId, userId);
            refreshPanel(guildId);
            const text = link.sync_status === 'ok' ? RESULT_TEXT.ok(link.game_count) : (RESULT_TEXT[link.sync_status] || RESULT_TEXT.error)();
            return await interaction.update({ content: text, components: [] });
        }

        if (id === 'stlib_refresh') {
            const link = await getLink(userId);
            if (!link) return await interaction.reply({ ...(await buildLinkPrompt(guildId, userId)), ...EPHEMERAL });
            if (!(await isSharedWith(guildId, userId))) {
                return await interaction.reply({ ...(await buildLinkPrompt(guildId, userId)), ...EPHEMERAL });
            }
            const wait = refreshWaitMs(link);
            if (wait > 0) {
                return await interaction.reply({ content: `⏳ Refreshed recently. Try again <t:${Math.ceil((Date.now() + wait) / 1000)}:R>.`, ...EPHEMERAL });
            }
            await interaction.deferReply(EPHEMERAL);
            const r = await syncLibrary(userId);
            refreshPanels(await guildsSharedBy(userId));
            return await interaction.editReply(RESULT_TEXT[r.status](r.count).replace('Linked. ', 'Refreshed. ').replace('Linked, but', 'Refreshed, but'));
        }

        if (id === 'stlib_leave') {
            if (!(await isSharedWith(guildId, userId))) {
                return await interaction.reply({ content: "Your games aren't counted in this server.", ...EPHEMERAL });
            }
            const { deletedAll } = await unshareFromGuild(guildId, userId);
            refreshPanel(guildId, 2000);
            return await interaction.reply({
                content: deletedAll
                    ? "🗑️ Removed, and since you weren't sharing with any other server, your link and game list are deleted."
                    : '✅ Your games are no longer counted here. `/steam unlink everywhere:true` deletes your link from every server.',
                ...EPHEMERAL,
            });
        }
    } catch (err) {
        return fail(interaction, err, id);
    }
}

export async function handleSteamLibraryPasteModal(interaction) {
    const guildId = interaction.guildId;
    const userId = interaction.user.id;
    await interaction.deferReply(EPHEMERAL);
    try {
        const cfg = await getConfig(guildId);
        if (!cfg.allow_unverified) throw new SteamLibraryError('verified_only', 'This server only accepts **Sign in through Steam**.');
        const steamId = await resolveSteamInput(interaction.fields.getTextInputValue('profile'));
        const current = await getLink(userId);
        if (current?.verified && current.steam_id64 !== steamId) {
            throw new SteamLibraryError('verified_link',
                'You already verified a different Steam account with Steam sign-in. Use **Re-link with Steam sign-in** to switch accounts.');
        }
        const displacedGuilds = await linkAccount(userId, steamId, { verified: false });
        await shareWithGuild(guildId, userId);
        const r = await syncLibrary(userId);
        refreshPanels([...new Set([...(await guildsSharedBy(userId)), ...displacedGuilds])]);
        return await interaction.editReply(RESULT_TEXT[r.status](r.count) +
            '\n-# Pasted links are unverified. **Sign in through Steam** marks your link as verified.');
    } catch (err) {
        return fail(interaction, err, 'paste modal');
    }
}

async function handleRsvp(interaction) {
    const [, nightId, status] = interaction.customId.split(':');
    if (!['in', 'maybe', 'out'].includes(status)) return;
    const night = await getNight(Number(nightId));
    if (!night || night.guild_id !== interaction.guildId) {
        return interaction.reply({ content: 'This game night no longer exists.', ...EPHEMERAL });
    }
    await setRsvp(night.id, interaction.user.id, status);
    return interaction.update(await buildNightMessage(night));
}
