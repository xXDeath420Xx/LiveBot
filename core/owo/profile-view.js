/*
 * CC-BY-NC-SA-4.0 derivative module. See /LICENSE-OWO-NOTICE.md.
 *
 * Builds the OwO profile message shared by `/owo2 profile view` and chat `owo profile`: the
 * profile embed (about, title, catches, wallet, luck, cookies, marriage) plus — when the member has
 * a wallpaper equipped — a rendered profile card (core/owo/profile-card.js) as the embed image.
 */
import { EmbedBuilder, AttachmentBuilder } from 'discord.js';
import logger from '../../utils/logger.js';
import { displayNameFor } from '../../utils/display-name.js';
import { getProfile } from './profile-service.js';
import { getStats } from './manager.js';
import { getCowoncy } from './cowoncy.js';
import { getSocialSummary } from './social-service.js';
import { getMarriage } from './marriage-service.js';
import { getEquippedWallpaper } from './wallpaper-service.js';
import { renderProfileCard } from './profile-card.js';
import { colorInt } from './social-math.js';

const fmt = n => Number(n).toLocaleString('en-US');

async function safe(promise, fallback, what) {
    try { return await promise; } catch (e) {
        logger.warn(`[OwO] profile: ${what} failed`, { err: e.message });
        return fallback;
    }
}

/**
 * @param {import('discord.js').Guild} guild
 * @param {string} viewerId  who asked (private profiles are hidden from everyone else)
 * @param {import('discord.js').User} target
 * @returns {Promise<{content: string}|{embeds: EmbedBuilder[], files?: AttachmentBuilder[]}>}
 */
export async function buildProfileMessage(guild, viewerId, target) {
    const guildId = guild.id;
    const profile = await getProfile(guildId, target.id);
    if (profile.private && target.id !== viewerId) return { content: "🔒 That user's profile is private." };

    const [stats, wallet, social, marriage, wallpaper] = await Promise.all([
        getStats(guildId, target.id),
        getCowoncy(guildId, target.id),
        safe(getSocialSummary(guildId, target.id), { luck: 0, cookies: 0, praysReceived: 0, cursesReceived: 0 }, 'social'),
        safe(getMarriage(guildId, target.id), null, 'marriage'),
        safe(getEquippedWallpaper(guildId, target.id), null, 'wallpaper'),
    ]);
    const name = displayNameFor(target, guild);

    const color = profile.accent
        ? parseInt(profile.accent.replace('#', ''), 16)
        : (wallpaper ? colorInt(wallpaper.colors[0]) : 0xF0A500);
    const embed = new EmbedBuilder()
        .setColor(color)
        .setAuthor({ name, iconURL: target.displayAvatarURL() });
    if (profile.title) embed.setTitle(profile.title);
    if (profile.about) embed.setDescription(profile.about);

    let marriageLine = '*Single*';
    if (marriage) {
        marriageLine = `${marriage.ring.emoji} <@${marriage.partnerId}>\n${marriage.days} day${marriage.days === 1 ? '' : 's'} · ${marriage.dailies} dailies together`;
    }
    const prayLine = social.praysReceived || social.cursesReceived
        ? `\n🙏 ${fmt(social.praysReceived)} · 👻 ${fmt(social.cursesReceived)}`
        : '';
    embed.addFields(
        { name: 'Unique animals', value: fmt(stats.uniqueAnimals), inline: true },
        { name: 'Total catches', value: fmt(stats.totalCatches), inline: true },
        { name: 'Wallet', value: `${fmt(wallet)} 💵`, inline: true },
        { name: '🍀 Luck', value: `${fmt(social.luck)}${prayLine}`, inline: true },
        { name: '🍪 Cookies', value: fmt(social.cookies), inline: true },
        { name: '💍 Marriage', value: marriageLine, inline: true },
    );
    if (stats.rarest) embed.addFields({ name: 'Rarest find', value: `${stats.rarest.emoji} ${stats.rarest.name} (${stats.rarest.rank})` });

    const payload = { embeds: [embed], allowedMentions: { parse: [] } };
    if (wallpaper) {
        const png = await renderProfileCard({
            wallpaper,
            avatarURL: target.displayAvatarURL({ extension: 'png', size: 256 }),
            name,
            title: profile.title,
            about: profile.about,
            accent: profile.accent || null,
            stats: [
                { label: 'Cowoncy', value: fmt(wallet) },
                { label: 'Luck', value: fmt(social.luck) },
                { label: 'Cookies', value: fmt(social.cookies) },
                { label: 'Zoo', value: `${fmt(stats.uniqueAnimals)} unique` },
            ],
        });
        if (png) {
            payload.files = [new AttachmentBuilder(png, { name: 'owo-profile.png' })];
            embed.setImage('attachment://owo-profile.png');
        }
        embed.setFooter({ text: `Wallpaper: ${wallpaper.name}` });
    } else {
        embed.setThumbnail(target.displayAvatarURL({ size: 256 }))
            .setFooter({ text: 'Get a profile wallpaper: owo shop · /owo wallpaper shop' });
    }
    return payload;
}
