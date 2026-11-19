/**
 * DM the bot owner when any CertiFried bot (default or branded custom bot) is
 * removed from a guild. Mirrors utils/owner-install-notifier.js: always sent
 * through the default bot's client, so a branded bot leaving a server where
 * the default isn't present still produces a notification.
 *
 * Caller is responsible for guarding the "last bot leaves" case
 * (core/guild-presence-logic.js:servedByAnotherClient) — this notifier does
 * not re-check, it just builds and sends the DM.
 *
 * De-dups on `(bot_id, guild_id)` within a 10-minute window so a flap
 * (kick + re-invite + kick) in quick succession doesn't DM-spam.
 *
 * GuildDelete gives us a partial guild object: cache may already be gone,
 * `guild.name` may be the last cached string. The caller passes a DB-row
 * snapshot (name, member_count, owner_id, icon_hash, last_seen) that we fall
 * back to for anything the live guild object no longer has.
 */
import {
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    SectionBuilder,
    ThumbnailBuilder,
    MessageFlags,
} from 'discord.js';
import logger from './logger.js';
import { SUPER_ADMIN_ID } from './constants.js';

const DEDUP_WINDOW_MS = 10 * 60 * 1000;
const recentlyNotified = new Map(); // key: `${botId}:${guildId}` -> timestamp

function dedupKey(botId, guildId) { return `${botId}:${guildId}`; }

function wasRecentlyNotified(botId, guildId) {
    const k = dedupKey(botId, guildId);
    const seen = recentlyNotified.get(k);
    const now = Date.now();
    if (recentlyNotified.size > 500) {
        for (const [kk, t] of recentlyNotified) if (now - t > DEDUP_WINDOW_MS) recentlyNotified.delete(kk);
    }
    if (seen && now - seen < DEDUP_WINDOW_MS) return true;
    recentlyNotified.set(k, now);
    return false;
}

/** "11d 4h", "3h 12m", "47m" — rough stay-length for the DM header. */
function fmtStayLength(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const d = Math.floor(ms / 86_400_000);
    const h = Math.floor((ms % 86_400_000) / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    return `${m}m`;
}

/**
 * Build the removal summary payload. Separated for testing.
 */
export function buildRemovalContainer({
    guildId, guildName, memberCount, createdTimestamp, iconUrl,
    botTag, botId, isCustomBot,
    lastSeenAt, firstKnownAt,
    ownerTag, ownerId, ownerCreatedTs,
}) {
    const createdTs = createdTimestamp ? Math.floor(createdTimestamp / 1000) : null;
    const lastSeenTs = lastSeenAt ? Math.floor(new Date(lastSeenAt).getTime() / 1000) : null;
    const stayMs = (firstKnownAt && lastSeenAt)
        ? Math.max(0, new Date(lastSeenAt).getTime() - new Date(firstKnownAt).getTime())
        : null;
    const stayLabel = fmtStayLength(stayMs);

    const headerLines = [];
    headerLines.push('## 🔴 Bot Removed from Server');
    headerLines.push(`**Bot:** ${botTag}${isCustomBot ? ' *(branded custom bot)*' : ' *(default)*'}  ·  **Bot ID:** \`${botId ?? 'default'}\``);
    if (lastSeenTs) headerLines.push(`*Last seen <t:${lastSeenTs}:R>${stayLabel ? ` · served for ~${stayLabel}` : ''}.*`);

    const container = new ContainerBuilder().setAccentColor(0xED4245);

    if (iconUrl) {
        container.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerLines.join('\n')))
                .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: iconUrl } }))
        );
    } else {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(headerLines.join('\n')));
    }

    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

    // Guild identity
    const idLines = [
        `### ${guildName || 'Unknown'}`,
        `**ID:** \`${guildId}\``,
    ];
    if (createdTs) idLines.push(`**Created:** <t:${createdTs}:F>  (<t:${createdTs}:R>)`);
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(idLines.join('\n')));

    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false));

    // Owner
    const ownerLines = [];
    if (ownerTag) ownerLines.push(`**Owner:** ${ownerTag}`);
    if (ownerId) ownerLines.push(`**Owner ID:** \`${ownerId}\``);
    if (ownerCreatedTs) ownerLines.push(`**Owner's account:** <t:${ownerCreatedTs}:R>`);
    if (ownerLines.length) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(ownerLines.join('\n')));
        container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false));
    }

    // Members (last known)
    if (Number.isFinite(memberCount)) {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `**Members (last known):** ${memberCount.toLocaleString()}`
        ));
    }

    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `-# Removal captured <t:${Math.floor(Date.now() / 1000)}:F> · dashboard: https://certifriedmultitool.com/manage/${guildId}`
    ));

    return container;
}

/**
 * Send the removal summary DM. Idempotent per 10-minute window; silent-fail
 * if the owner can't be DMed (so a protected-DM owner doesn't crash the handler).
 *
 * @param {import('discord.js').Guild} guild            The partial guild from GuildDelete.
 * @param {object} snapshot                              Prior row from the `guilds` table.
 * @param {string} [snapshot.guildName]                  Fallback name if the live guild object has lost it.
 * @param {number} [snapshot.memberCount]                Fallback member count.
 * @param {string} [snapshot.ownerId]                    Fallback owner id.
 * @param {string} [snapshot.iconHash]                   Fallback icon hash (CDN URL built in-notifier).
 * @param {string|Date} [snapshot.lastSeenAt]            For the "last seen <relative>" line.
 * @param {string|Date} [snapshot.firstKnownAt]          Oldest timestamp we have for this guild, for stay-length.
 */
export async function notifyOwnerOfRemoval(guild, snapshot = {}) {
    try {
        if (!SUPER_ADMIN_ID) {
            logger.warn('[OwnerRemovalDM] BOT_OWNER_ID not set in env — skipping removal DM');
            return;
        }

        const defaultClient = global.botManager?.getDefaultClient?.() || guild.client;
        if (!defaultClient) return;

        const leftBotClient = guild.client;
        const botTag = leftBotClient.user?.tag || leftBotClient.botName || 'Unknown bot';
        const botId = leftBotClient.user?.id || leftBotClient.botId || null;
        const isCustomBot = leftBotClient.isDefaultBot === false;

        if (botId && wasRecentlyNotified(botId, guild.id)) return;

        // Prefer the live guild object, fall back to the DB snapshot the caller
        // read before the upsert. On GuildDelete the cache may already be gone,
        // so these fallbacks are what makes the DM actually readable.
        const guildName = guild.name || snapshot.guildName || 'Unknown';
        const memberCount = Number.isFinite(guild.memberCount)
            ? guild.memberCount
            : (Number.isFinite(snapshot.memberCount) ? snapshot.memberCount : null);
        const ownerId = guild.ownerId || snapshot.ownerId || null;
        const iconUrl = (typeof guild.iconURL === 'function' ? guild.iconURL({ size: 256 }) : null)
            || (snapshot.iconHash
                ? `https://cdn.discordapp.com/icons/${guild.id}/${snapshot.iconHash}.png?size=256`
                : null);

        let ownerTag = null, ownerCreatedTs = null;
        if (ownerId) {
            try {
                const owner = await defaultClient.users.fetch(ownerId).catch(() => null);
                if (owner) {
                    ownerTag = owner.tag || owner.username;
                    ownerCreatedTs = Math.floor(owner.createdTimestamp / 1000);
                }
            } catch { /* best effort */ }
        }

        const container = buildRemovalContainer({
            guildId: guild.id,
            guildName,
            memberCount,
            createdTimestamp: guild.createdTimestamp || null,
            iconUrl,
            botTag,
            botId,
            isCustomBot,
            lastSeenAt: snapshot.lastSeenAt || null,
            firstKnownAt: snapshot.firstKnownAt || null,
            ownerTag,
            ownerId,
            ownerCreatedTs,
        });

        const ownerUser = await defaultClient.users.fetch(SUPER_ADMIN_ID).catch(() => null);
        if (!ownerUser) {
            logger.warn('[OwnerRemovalDM] could not resolve bot owner user — skipping', { ownerId: SUPER_ADMIN_ID });
            return;
        }
        await ownerUser.send({
            components: [container],
            flags: MessageFlags.IsComponentsV2,
        });

        logger.info('[OwnerRemovalDM] sent removal summary to bot owner', {
            botId, botTag, guildId: guild.id, guildName,
        });
    } catch (err) {
        // Owner may have DMs closed; log and move on — this must never fail a departure.
        logger.warn('[OwnerRemovalDM] send failed', { err: err.message, guildId: guild?.id });
    }
}
