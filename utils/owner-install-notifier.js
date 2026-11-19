/**
 * DM the bot owner when any CertiFried bot (default or branded custom bot) is
 * installed in a guild. Always sent through the default bot's client — custom
 * bots in the same process reach the default client via
 * `global.botManager.getDefaultClient()`, so a branded bot getting added to a
 * server where the default bot isn't present still produces a notification.
 *
 * De-dups on `(bot_id, guild_id)` within a 10-minute window so a server that
 * invites + kicks + re-invites in quick succession doesn't DM-spam the owner.
 *
 * The DM is a Components V2 container with every signal we can read without
 * fetching more members than are already cached: name/id/owner, member stats,
 * channel breakdown, roles, features, boost tier, verification level, locale,
 * creation date, whether this is a rejoin, owner badges/flags, mutual servers
 * for the owner across the whole CertiFried bot network, member-network
 * overlap (how connected this new guild is to our existing network), and the
 * bot ecosystem already in the guild.
 */
import {
    ChannelType,
    ContainerBuilder,
    TextDisplayBuilder,
    SeparatorBuilder,
    SeparatorSpacingSize,
    SectionBuilder,
    ThumbnailBuilder,
    MessageFlags,
} from 'discord.js';
import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import logger from './logger.js';
import { SUPER_ADMIN_ID } from './constants.js';

// On-disk queue drained once per boot by drainInstallDmBackfillQueue(). Lives
// in scratchpad so it's trivially git-ignored and session-scoped.
const BACKFILL_QUEUE_PATH = path.resolve(process.cwd(), 'scratchpad', 'install-dm-backfill-queue.json');

// User account age below this threshold earns a "young account" badge in the
// owner signals line — a brand-new account installing the bot on a brand-new
// server is a signal worth flagging at install time, not after an incident.
const YOUNG_ACCOUNT_DAYS = 30;

const DEDUP_WINDOW_MS = 10 * 60 * 1000;
const recentlyNotified = new Map(); // key: `${botId}:${guildId}` -> timestamp

function dedupKey(botId, guildId) { return `${botId}:${guildId}`; }

function wasRecentlyNotified(botId, guildId) {
    const k = dedupKey(botId, guildId);
    const seen = recentlyNotified.get(k);
    const now = Date.now();
    // Bounded sweep.
    if (recentlyNotified.size > 500) {
        for (const [kk, t] of recentlyNotified) if (now - t > DEDUP_WINDOW_MS) recentlyNotified.delete(kk);
    }
    if (seen && now - seen < DEDUP_WINDOW_MS) return true;
    recentlyNotified.set(k, now);
    return false;
}

/**
 * Known Discord feature flags, trimmed to a short presentation list. Anything
 * not in this table is passed through verbatim so new flags still appear.
 */
const FEATURE_LABEL = {
    COMMUNITY: 'Community',
    PARTNERED: 'Partner',
    VERIFIED: 'Verified',
    DISCOVERABLE: 'Discoverable',
    ANIMATED_ICON: 'Animated icon',
    ANIMATED_BANNER: 'Animated banner',
    BANNER: 'Banner',
    VANITY_URL: 'Vanity URL',
    MEMBER_VERIFICATION_GATE_ENABLED: 'Membership screening',
    WELCOME_SCREEN_ENABLED: 'Welcome screen',
    PREVIEW_ENABLED: 'Preview',
    THREE_DAY_THREAD_ARCHIVE: '3-day thread archive',
    SEVEN_DAY_THREAD_ARCHIVE: '7-day thread archive',
    PRIVATE_THREADS: 'Private threads',
    NEWS: 'Announcement channels',
    AUTO_MODERATION: 'AutoMod',
    APPLICATION_COMMAND_PERMISSIONS_V2: 'Command perms v2',
    CREATOR_MONETIZABLE_PROVISIONAL: 'Creator monetization',
    SOUNDBOARD: 'Soundboard',
    RAID_ALERTS_DISABLED: 'Raid alerts off',
};

const VERIFICATION_LABEL = { 0: 'None', 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Very High' };
const EXPLICIT_FILTER_LABEL = { 0: 'Disabled', 1: 'Members without roles', 2: 'All members' };

/**
 * Count members by human/bot. Discord only guarantees `memberCount` as an
 * exact number — the cache may be partial if GuildMembers intent isn't on or
 * chunking hasn't finished. We report cached figures with "(cached)" when the
 * cache is clearly short of memberCount so the owner isn't misled.
 */
function memberBreakdown(guild) {
    const total = guild.memberCount;
    const cached = guild.members.cache.size;
    const bots = guild.members.cache.filter(m => m.user?.bot).size;
    const humans = cached - bots;
    const partial = cached < total * 0.95; // "mostly populated" threshold
    return { total, humans, bots, cached, partial };
}

function channelBreakdown(guild) {
    const counts = { text: 0, voice: 0, category: 0, announcement: 0, stage: 0, forum: 0, media: 0, thread: 0, other: 0 };
    for (const ch of guild.channels.cache.values()) {
        switch (ch.type) {
            case ChannelType.GuildText: counts.text++; break;
            case ChannelType.GuildVoice: counts.voice++; break;
            case ChannelType.GuildCategory: counts.category++; break;
            case ChannelType.GuildAnnouncement: counts.announcement++; break;
            case ChannelType.GuildStageVoice: counts.stage++; break;
            case ChannelType.GuildForum: counts.forum++; break;
            case ChannelType.GuildMedia: counts.media++; break;
            case ChannelType.PublicThread:
            case ChannelType.PrivateThread:
            case ChannelType.AnnouncementThread: counts.thread++; break;
            default: counts.other++; break;
        }
    }
    return counts;
}

function fmtChannelLine(c) {
    const parts = [];
    if (c.text) parts.push(`${c.text} text`);
    if (c.voice) parts.push(`${c.voice} voice`);
    if (c.category) parts.push(`${c.category} categor${c.category === 1 ? 'y' : 'ies'}`);
    if (c.announcement) parts.push(`${c.announcement} announcement`);
    if (c.stage) parts.push(`${c.stage} stage`);
    if (c.forum) parts.push(`${c.forum} forum`);
    if (c.media) parts.push(`${c.media} media`);
    if (c.thread) parts.push(`${c.thread} thread${c.thread === 1 ? '' : 's'}`);
    if (c.other) parts.push(`${c.other} other`);
    return parts.length ? parts.join(' · ') : 'none visible';
}

function fmtFeatures(features) {
    if (!features?.length) return '*(none)*';
    const labelled = features
        .map(f => FEATURE_LABEL[f] ?? f.toLowerCase().replace(/_/g, ' '))
        .sort();
    return labelled.slice(0, 20).join(', ') + (labelled.length > 20 ? ` …(+${labelled.length - 20})` : '');
}

/**
 * discord.js UserFlags → human label. Spammer/Quarantined earn a warning
 * glyph because they're the two we actively care about at install time —
 * everything else is colour.
 */
const PUBLIC_FLAG_LABEL = {
    Staff: 'Discord Staff',
    Partner: 'Partnered Server Owner',
    Hypesquad: 'HypeSquad Events',
    BugHunterLevel1: 'Bug Hunter',
    HypeSquadOnlineHouse1: 'HypeSquad Bravery',
    HypeSquadOnlineHouse2: 'HypeSquad Brilliance',
    HypeSquadOnlineHouse3: 'HypeSquad Balance',
    PremiumEarlySupporter: 'Early Supporter',
    TeamPseudoUser: 'Team user',
    BugHunterLevel2: 'Bug Hunter II',
    VerifiedBot: 'Verified Bot',
    VerifiedDeveloper: 'Early Verified Bot Dev',
    CertifiedModerator: 'Certified Moderator',
    BotHTTPInteractions: 'HTTP interactions bot',
    Spammer: '⚠ Spammer',
    Quarantined: '⚠ Quarantined',
    ActiveDeveloper: 'Active Developer',
};

export function ownerSignalLines(owner, ownerCreatedTs) {
    const signals = [];
    try {
        const flagNames = owner?.flags?.toArray?.() || [];
        for (const n of flagNames) signals.push(PUBLIC_FLAG_LABEL[n] ?? n);
    } catch { /* flags optional */ }
    if (ownerCreatedTs) {
        const ageDays = (Date.now() / 1000 - ownerCreatedTs) / 86400;
        if (ageDays < YOUNG_ACCOUNT_DAYS) {
            signals.push(`⚠ Young account (${Math.floor(ageDays)}d old)`);
        }
    }
    return signals;
}

/**
 * How connected is this new guild to the rest of the CertiFried network?
 * Walks only Discord.js caches — no REST fetches — so it stays cheap even on
 * a 200-guild deployment. "Connected" here = how many members of the new
 * guild are already cached in at least one other bot-visible guild.
 *
 * Returns { overlapCount, otherGuildCount, totalChecked, sampled }.
 *   overlapCount    = members of this guild also seen in >=1 other guild
 *   otherGuildCount = distinct other guilds those members span
 *   totalChecked    = size of the new guild's cached member set we tested
 *   sampled         = up to 5 { userId, tag, otherGuildCount } for context
 */
export function collectMemberOverlap(guild) {
    const empty = { overlapCount: 0, otherGuildCount: 0, totalChecked: 0, sampled: [] };
    if (!global.botManager?.getAllClients) return empty;
    const clients = global.botManager.getAllClients() || [];
    if (!clients.length) return empty;

    // Build the user-id set we care about — humans only (bot overlap is
    // noise; a Dyno in two servers isn't an interesting signal).
    const newGuildHumans = new Map(); // userId -> tag
    for (const m of guild.members.cache.values()) {
        if (m.user?.bot) continue;
        newGuildHumans.set(m.id, m.user?.tag || m.user?.username || m.id);
    }
    const totalChecked = newGuildHumans.size;
    if (!totalChecked) return empty;

    const userToGuilds = new Map(); // userId -> Set<guildId>
    const seenGuilds = new Set();
    for (const client of clients) {
        for (const g of client.guilds.cache.values()) {
            if (g.id === guild.id) continue;
            if (seenGuilds.has(g.id)) continue; // same guild via multiple bots
            seenGuilds.add(g.id);
            for (const uid of g.members.cache.keys()) {
                if (!newGuildHumans.has(uid)) continue;
                let s = userToGuilds.get(uid);
                if (!s) { s = new Set(); userToGuilds.set(uid, s); }
                s.add(g.id);
            }
        }
    }

    const otherGuildIds = new Set();
    for (const gids of userToGuilds.values()) for (const gid of gids) otherGuildIds.add(gid);

    // Rank sampled users by breadth (how many other guilds they're in) so the
    // DM highlights the most-connected handful.
    const sampled = Array.from(userToGuilds.entries())
        .map(([uid, gids]) => ({ userId: uid, tag: newGuildHumans.get(uid) || uid, otherGuildCount: gids.size }))
        .sort((a, b) => b.otherGuildCount - a.otherGuildCount)
        .slice(0, 5);

    return {
        overlapCount: userToGuilds.size,
        otherGuildCount: otherGuildIds.size,
        totalChecked,
        sampled,
    };
}

/**
 * List the bots cached in the guild. Alphabetical. Caller slices to show the
 * first N — the full count stays on the summary line.
 */
export function collectBotEcosystem(guild) {
    const bots = [];
    for (const m of guild.members.cache.values()) {
        if (!m.user?.bot) continue;
        bots.push({ id: m.id, tag: m.user.tag || m.user.username || m.id });
    }
    bots.sort((a, b) => a.tag.localeCompare(b.tag));
    return bots;
}


/**
 * Look across every bot client in the CertiFried network and find other
 * guilds (not the one we just joined) where this guild's owner is also a
 * member. Returns a deduped array:
 *   [{ guildId, guildName, botTags: ['CertiFried Utility#5565', ...] }, ...]
 *
 * Uses `guild.members.fetch(ownerId)` which falls back to a REST lookup when
 * GuildMembers isn't cached — a 404 means not a member, anything else means
 * yes. Fetches run in parallel with a hard cap so a 200-guild network still
 * returns inside a few seconds.
 */
export async function collectMutualGuilds(ownerId, excludeGuildId, {
    perGuildTimeoutMs = 2500,
    maxConcurrent = 25,
} = {}) {
    if (!ownerId || !global.botManager?.getAllClients) return [];
    const clients = global.botManager.getAllClients() || [];
    if (!clients.length) return [];

    // Flatten (bot, guild) pairs across the network. The same guildId can be
    // visible to multiple bots, so we keep the pair list and collapse later.
    const pairs = [];
    for (const client of clients) {
        const botTag = client.user?.tag || client.botName || 'bot';
        for (const g of client.guilds.cache.values()) {
            if (g.id === excludeGuildId) continue;
            pairs.push({ botTag, guild: g });
        }
    }
    if (!pairs.length) return [];

    const results = new Map(); // guildId -> { guildId, guildName, botTags:Set }

    const checkOne = async ({ botTag, guild }) => {
        try {
            const member = await Promise.race([
                guild.members.fetch({ user: ownerId, force: false }).catch(() => null),
                new Promise(r => setTimeout(() => r(null), perGuildTimeoutMs)),
            ]);
            if (!member) return;
            const row = results.get(guild.id) || { guildId: guild.id, guildName: guild.name, botTags: new Set() };
            row.botTags.add(botTag);
            results.set(guild.id, row);
        } catch { /* swallow — a missing member is the normal case */ }
    };

    // Simple bounded-concurrency fan-out so the whole lookup bounds its wall time
    // even on a large network.
    for (let i = 0; i < pairs.length; i += maxConcurrent) {
        const slice = pairs.slice(i, i + maxConcurrent);
        await Promise.all(slice.map(checkOne));
    }

    return Array.from(results.values())
        .map(r => ({ ...r, botTags: Array.from(r.botTags).sort() }))
        .sort((a, b) => a.guildName.localeCompare(b.guildName));
}

/**
 * Build the install summary payload. Separated for testing.
 */
export function buildInstallContainer({
    guild,
    botTag,
    botId,
    isCustomBot,
    previousLeftAt,
    ownerTag,
    ownerId,
    ownerCreatedTs,
    ownerSignals = [],
    mutualGuilds = [],
    memberOverlap = null,
    botEcosystem = [],
}) {
    const members = memberBreakdown(guild);
    const channels = channelBreakdown(guild);
    const createdTs = Math.floor(guild.createdTimestamp / 1000);
    const rejoinedTs = previousLeftAt ? Math.floor(new Date(previousLeftAt).getTime() / 1000) : null;

    const headerLines = [];
    headerLines.push(rejoinedTs ? '## 🔁 Bot Rejoined a Server' : '## 🟢 Bot Installed');
    headerLines.push(`**Bot:** ${botTag}${isCustomBot ? ' *(branded custom bot)*' : ' *(default)*'}  ·  **Bot ID:** \`${botId ?? 'default'}\``);
    if (rejoinedTs) {
        headerLines.push(`*Previously left <t:${rejoinedTs}:R>.*`);
    }

    const container = new ContainerBuilder()
        .setAccentColor(rejoinedTs ? 0xE2B23A : 0x57F287);

    // Header + icon
    if (guild.iconURL()) {
        container.addSectionComponents(
            new SectionBuilder()
                .addTextDisplayComponents(new TextDisplayBuilder().setContent(headerLines.join('\n')))
                .setThumbnailAccessory(new ThumbnailBuilder({ media: { url: guild.iconURL({ size: 256 }) } }))
        );
    } else {
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(headerLines.join('\n')));
    }

    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

    // Guild identity
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `### ${guild.name}`,
        `**ID:** \`${guild.id}\``,
        `**Created:** <t:${createdTs}:F>  (<t:${createdTs}:R>)`,
        guild.preferredLocale ? `**Locale:** ${guild.preferredLocale}` : null,
        guild.vanityURLCode ? `**Vanity:** [discord.gg/${guild.vanityURLCode}](https://discord.gg/${guild.vanityURLCode})` : null,
    ].filter(Boolean).join('\n')));

    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false));

    // Owner
    const ownerLines = [
        `**Owner:** ${ownerTag ?? `<@${guild.ownerId}>`}`,
        `**Owner ID:** \`${ownerId ?? guild.ownerId}\``,
    ];
    if (ownerCreatedTs) ownerLines.push(`**Owner's account:** <t:${ownerCreatedTs}:R>`);
    if (Array.isArray(ownerSignals) && ownerSignals.length) {
        ownerLines.push(`**Signals:** ${ownerSignals.join(', ')}`);
    }
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(ownerLines.join('\n')));

    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

    // Members
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `**Members:** ${members.total.toLocaleString()}`,
        `**Humans:** ${members.humans.toLocaleString()}${members.partial ? ' *(from cache — may be low)*' : ''}  ·  **Bots:** ${members.bots.toLocaleString()}`,
    ].join('\n')));

    // Boost
    const boostLine = `**Boost tier:** ${guild.premiumTier}  ·  **Boosts:** ${guild.premiumSubscriptionCount ?? 0}`;
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(boostLine));

    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false));

    // Channels & roles
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `**Channels:** ${guild.channels.cache.size} *(${fmtChannelLine(channels)})*`,
        `**Roles:** ${guild.roles.cache.size}`,
    ].join('\n')));

    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false));

    // Verification / content filter / features
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `**Verification:** ${VERIFICATION_LABEL[guild.verificationLevel] ?? guild.verificationLevel}`,
        `**Explicit filter:** ${EXPLICIT_FILTER_LABEL[guild.explicitContentFilter] ?? guild.explicitContentFilter}`,
        `**Features:** ${fmtFeatures(guild.features)}`,
    ].join('\n')));

    // Owner's other servers across the CertiFried bot network. Rendered
    // unconditionally — "we checked and found none" is itself a signal, and
    // suppressing the block made the DM ambiguous (was it checked or not?).
    container.addSeparatorComponents(new SeparatorBuilder()
        .setSpacing(SeparatorSpacingSize.Small).setDivider(true));
    {
        const lines = [`### 🌐 Owner's other servers in the CertiFried network`];
        if (Array.isArray(mutualGuilds) && mutualGuilds.length) {
            const shown = mutualGuilds.slice(0, 20);
            for (const m of shown) {
                const bots = m.botTags.length > 1
                    ? ` *(via ${m.botTags.join(', ')})*`
                    : m.botTags[0] ? ` *(via ${m.botTags[0]})*` : '';
                // Guild names can have Discord-flavoured markdown in them — cap at
                // ~60 chars so a joke-name doesn't push the line over the embed
                // field length. The id stays verbatim so the owner can jump to it.
                const name = String(m.guildName || 'Unknown').slice(0, 60);
                lines.push(`- **${name}** (\`${m.guildId}\`)${bots}`);
            }
            if (mutualGuilds.length > shown.length) {
                lines.push(`-# …and ${mutualGuilds.length - shown.length} more.`);
            }
        } else {
            lines.push(`-# None — this owner isn't a cached member of any other CertiFried-bot guild.`);
        }
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
    }

    // Member-network overlap — how connected this new guild is to the rest
    // of the CertiFried network at install time. Only renders when there's
    // something meaningful (totalChecked > 0 means we had members to test).
    if (memberOverlap && memberOverlap.totalChecked > 0) {
        container.addSeparatorComponents(new SeparatorBuilder()
            .setSpacing(SeparatorSpacingSize.Small).setDivider(false));
        const lines = [`### 🔗 Member overlap with CertiFried network`];
        const pct = memberOverlap.totalChecked
            ? Math.round((memberOverlap.overlapCount / memberOverlap.totalChecked) * 100)
            : 0;
        lines.push(
            `**${memberOverlap.overlapCount}** of **${memberOverlap.totalChecked}** cached humans (${pct}%) ` +
            `also seen in **${memberOverlap.otherGuildCount}** other CertiFried-bot guild${memberOverlap.otherGuildCount === 1 ? '' : 's'}.`
        );
        if (memberOverlap.sampled.length) {
            lines.push('*Most-connected members:*');
            for (const s of memberOverlap.sampled) {
                const tag = String(s.tag).slice(0, 40);
                lines.push(`- **${tag}** (\`${s.userId}\`) — in ${s.otherGuildCount} other guild${s.otherGuildCount === 1 ? '' : 's'}`);
            }
        }
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
    }

    // Bot ecosystem already in this guild — flagging bot farms and competitor
    // bots at install time. Humans/bots totals are already in the Members
    // block; this adds the actual names of the bots we're sharing space with.
    if (Array.isArray(botEcosystem) && botEcosystem.length) {
        container.addSeparatorComponents(new SeparatorBuilder()
            .setSpacing(SeparatorSpacingSize.Small).setDivider(false));
        const lines = [`### 🤖 Bots in this server (${botEcosystem.length})`];
        const shown = botEcosystem.slice(0, 10);
        for (const b of shown) {
            const tag = String(b.tag).slice(0, 50);
            lines.push(`- **${tag}** (\`${b.id}\`)`);
        }
        if (botEcosystem.length > shown.length) {
            lines.push(`-# …and ${botEcosystem.length - shown.length} more.`);
        }
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));
    }

    // Footer
    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `-# Install captured <t:${Math.floor(Date.now() / 1000)}:F> · dashboard: https://certifriedmultitool.com/manage/${guild.id}`
    ));

    return container;
}

/**
 * Send the install summary DM. Idempotent per 10-minute window; silent-fail
 * if the owner can't be DMed (so a protected-DM owner doesn't crash a join).
 */
export async function notifyOwnerOfInstall(guild, { previousLeftAt = null } = {}) {
    try {
        if (!SUPER_ADMIN_ID) {
            logger.warn('[OwnerInstallDM] BOT_OWNER_ID not set in env — skipping install DM');
            return;
        }

        // Resolve the client we send *from*. Always the default bot: a branded
        // custom bot might not be able to open a DM with the owner, and this
        // keeps the DM thread the owner reads at a single consistent sender.
        const defaultClient = global.botManager?.getDefaultClient?.() || guild.client;
        if (!defaultClient) return;

        // Which bot joined (for the embed)? We're in the handler of THAT bot,
        // so guild.client is authoritative.
        const joinedBotClient = guild.client;
        const botTag = joinedBotClient.user?.tag || joinedBotClient.botName || 'Unknown bot';
        const botId = joinedBotClient.user?.id || joinedBotClient.botId || null;
        const isCustomBot = joinedBotClient.isDefaultBot === false;

        if (botId && wasRecentlyNotified(botId, guild.id)) return;

        // Resolve the guild owner object for a nicer tag line + flag badges.
        // `force: true` makes sure we get fresh `flags` even if the user is
        // already cached without them.
        let ownerTag = null, ownerCreatedTs = null, ownerUserObj = null;
        try {
            const owner = await defaultClient.users.fetch(guild.ownerId, { force: true }).catch(() => null);
            if (owner) {
                ownerUserObj = owner;
                ownerTag = owner.tag || owner.username;
                ownerCreatedTs = Math.floor(owner.createdTimestamp / 1000);
            }
        } catch { /* best effort */ }

        const ownerSignals = ownerSignalLines(ownerUserObj, ownerCreatedTs);

        // Best-effort mutual-guild lookup — bounded wall time via collectMutualGuilds.
        let mutualGuilds = [];
        try {
            mutualGuilds = await collectMutualGuilds(guild.ownerId, guild.id);
        } catch (e) {
            logger.warn('[OwnerInstallDM] mutual-guild lookup failed', { err: e.message });
        }

        // Cheap, cache-only overlap + ecosystem scans.
        let memberOverlap = null;
        try {
            memberOverlap = collectMemberOverlap(guild);
        } catch (e) {
            logger.warn('[OwnerInstallDM] member-overlap scan failed', { err: e.message });
        }
        let botEcosystem = [];
        try {
            botEcosystem = collectBotEcosystem(guild);
        } catch (e) {
            logger.warn('[OwnerInstallDM] bot-ecosystem scan failed', { err: e.message });
        }

        const container = buildInstallContainer({
            guild,
            botTag,
            botId,
            isCustomBot,
            previousLeftAt,
            ownerTag,
            ownerId: guild.ownerId,
            ownerCreatedTs,
            ownerSignals,
            mutualGuilds,
            memberOverlap,
            botEcosystem,
        });

        // DM the owner through the default bot.
        const ownerUser = await defaultClient.users.fetch(SUPER_ADMIN_ID).catch(() => null);
        if (!ownerUser) {
            logger.warn('[OwnerInstallDM] could not resolve bot owner user — skipping', { ownerId: SUPER_ADMIN_ID });
            return;
        }
        await ownerUser.send({
            components: [container],
            flags: MessageFlags.IsComponentsV2,
        });

        logger.info('[OwnerInstallDM] sent install summary to bot owner', {
            botId, botTag,
            guildId: guild.id, guildName: guild.name,
            rejoin: !!previousLeftAt,
            mutualCount: mutualGuilds.length,
            ownerSignalCount: ownerSignals.length,
            overlapCount: memberOverlap?.overlapCount ?? 0,
            overlapChecked: memberOverlap?.totalChecked ?? 0,
            botsInGuild: botEcosystem.length,
        });
    } catch (err) {
        // Owner may have DMs closed; log and move on — this must never fail a join.
        logger.warn('[OwnerInstallDM] send failed', { err: err.message, guildId: guild?.id });
    }
}

/**
 * Rebuild a previously-sent install DM and edit it in place with the current,
 * richer rendering. Used to backfill DMs that were sent before new sections
 * (member overlap, bot ecosystem, owner badges) existed.
 *
 * The guild must still be visible to at least one bot client — overlap and
 * ecosystem come from live caches. If the guild is gone, the mutuals/signals
 * portion can still backfill but overlap/ecosystem will come up empty.
 */
export async function backfillInstallDm({ messageId, guildId, previousLeftAt = null, botTag: botTagOverride, botId: botIdOverride } = {}) {
    if (!messageId || !guildId) throw new Error('backfillInstallDm requires messageId and guildId');
    if (!global.botManager?.getDefaultClient) throw new Error('botManager not ready');
    const defaultClient = global.botManager.getDefaultClient();
    if (!defaultClient) throw new Error('no default client');

    let joinedClient = null;
    let guild = null;
    for (const c of global.botManager.getAllClients()) {
        const g = c.guilds.cache.get(guildId);
        if (g) { joinedClient = c; guild = g; break; }
    }
    if (!guild) throw new Error(`guild ${guildId} not in any client's cache`);

    const botTag = botTagOverride || joinedClient.user?.tag || joinedClient.botName || 'bot';
    const botId = botIdOverride || joinedClient.user?.id || null;
    const isCustomBot = joinedClient.isDefaultBot === false;

    let ownerTag = null, ownerCreatedTs = null, ownerUserObj = null;
    try {
        const owner = await defaultClient.users.fetch(guild.ownerId, { force: true }).catch(() => null);
        if (owner) {
            ownerUserObj = owner;
            ownerTag = owner.tag || owner.username;
            ownerCreatedTs = Math.floor(owner.createdTimestamp / 1000);
        }
    } catch { /* best effort */ }

    const ownerSignals = ownerSignalLines(ownerUserObj, ownerCreatedTs);
    const mutualGuilds = await collectMutualGuilds(guild.ownerId, guild.id).catch(() => []);
    const memberOverlap = collectMemberOverlap(guild);
    const botEcosystem = collectBotEcosystem(guild);

    const container = buildInstallContainer({
        guild, botTag, botId, isCustomBot, previousLeftAt,
        ownerTag, ownerId: guild.ownerId, ownerCreatedTs,
        ownerSignals, mutualGuilds, memberOverlap, botEcosystem,
    });

    const ownerUser = await defaultClient.users.fetch(SUPER_ADMIN_ID);
    const dm = await ownerUser.createDM();
    const msg = await dm.messages.fetch(messageId);
    await msg.edit({ components: [container], flags: MessageFlags.IsComponentsV2 });

    const summary = {
        messageId, guildId, botTag,
        mutualCount: mutualGuilds.length,
        ownerSignalCount: ownerSignals.length,
        overlapCount: memberOverlap?.overlapCount ?? 0,
        overlapChecked: memberOverlap?.totalChecked ?? 0,
        botsInGuild: botEcosystem.length,
    };
    logger.info('[OwnerInstallDM] backfilled install DM', summary);
    return summary;
}

/**
 * Boot-time drain. Reads scratchpad/install-dm-backfill-queue.json (an array
 * of { messageId, guildId, previousLeftAt?, botTag?, botId? }), runs backfill
 * for each, then deletes the file. Safe to call always: no file = no-op.
 *
 * Called from events/ready.js in the default-bot startup block. The members
 * cache needs a moment after READY to populate — the caller delays enough.
 */
export async function drainInstallDmBackfillQueue() {
    let raw;
    try {
        raw = await readFile(BACKFILL_QUEUE_PATH, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') return; // nothing to do
        logger.warn('[OwnerInstallDM] backfill queue read failed', { err: e.message });
        return;
    }
    let queue;
    try { queue = JSON.parse(raw); }
    catch (e) {
        logger.warn('[OwnerInstallDM] backfill queue parse failed — leaving file in place for inspection', { err: e.message });
        return;
    }
    if (!Array.isArray(queue) || !queue.length) {
        await unlink(BACKFILL_QUEUE_PATH).catch(() => {});
        return;
    }
    logger.info('[OwnerInstallDM] draining install-DM backfill queue', { count: queue.length });
    for (const entry of queue) {
        try {
            await backfillInstallDm(entry);
        } catch (e) {
            logger.warn('[OwnerInstallDM] backfill entry failed', { entry, err: e.message });
        }
    }
    await unlink(BACKFILL_QUEUE_PATH).catch(() => {});
}
