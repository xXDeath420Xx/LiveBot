import logger from '../utils/logger.js';
import { EmbedBuilder } from 'discord.js';
import {
    getConfig, extractTwitchUsernames, checkAffiliateStatus,
    resolveTwitchUsername, recordEntry, findBestTwitchMatch
} from '../core/community-support-manager.js';

export default {
    name: 'messageCreate',
    async execute(message) {
        // Ignore bots and DMs
        if (message.author.bot || !message.guild) return;

        const guildId = message.guild.id;
        const channelId = message.channel.id;

        // Fast path: check config (cached)
        const config = await getConfig(guildId);
        if (!config) return;

        // Determine entry type based on channel
        let entryType = null;
        if (channelId === config.raid_channel_id) {
            entryType = 'raid';
        } else if (channelId === config.support_channel_id) {
            entryType = 'support';
        } else {
            return; // Not a tracked channel
        }

        // Override to raid if message content indicates a raid (e.g. "raided xyz with 5")
        if (entryType === 'support' && /\braid(ed|ing)?\b/i.test(message.content)) {
            entryType = 'raid';
        }

        try {
            // Extract targets: Discord mentions first, then Twitch usernames as fallback
            const targets = [];

            // Extract Discord user mentions
            const mentionRegex = /<@!?(\d+)>/g;
            let match;
            while ((match = mentionRegex.exec(message.content)) !== null) {
                const mentionedId = match[1];
                if (mentionedId === message.author.id) continue; // Skip self-mentions

                // Try to resolve to Twitch username
                const resolved = await resolveTwitchUsername(guildId, mentionedId);
                if (resolved) {
                    targets.push({ username: resolved.username, twitchId: resolved.twitchId, discordId: mentionedId });
                } else {
                    // Smart fallback: try username, nickname, and globalName with variant stripping
                    try {
                        const member = await message.guild.members.fetch(mentionedId).catch(() => null);
                        if (member) {
                            const nameSources = [
                                member.user.username,
                                member.nickname,
                                member.user.globalName
                            ].filter(Boolean);

                            const bestMatch = await findBestTwitchMatch(nameSources, guildId, mentionedId);
                            if (bestMatch) {
                                targets.push({
                                    username: bestMatch.canonicalUsername,
                                    twitchId: bestMatch.twitchId,
                                    discordId: mentionedId,
                                    preResolved: true,
                                    isAffiliate: bestMatch.isAffiliate
                                });
                            } else {
                                // No Twitch account found at all — fall back to cleaned username
                                // Only strip explicit _ttv/.ttv/ttv suffixes, NOT plain "tv"
                                let cleaned = member.user.username.toLowerCase()
                                    .replace(/\.+$/, '')         // trailing dots
                                    .replace(/[_.]?ttv$/i, '')   // _ttv/.ttv/ttv suffixes only
                                    .replace(/[^a-z0-9_]/g, '')  // non-Twitch chars
                                    .replace(/^_+|_+$/g, '');    // leading/trailing underscores
                                targets.push({ username: cleaned, discordId: mentionedId, noTwitch: true });
                            }
                        }
                    } catch {
                        // Can't resolve, skip
                    }
                }
            }

            // Also check for Twitch links and @usernames in the message text
            const twitchUsernames = extractTwitchUsernames(message.content);
            for (const { username: name, fromUrl } of twitchUsernames) {
                if (!targets.find(t => t.username.toLowerCase() === name.toLowerCase())) {
                    targets.push({ username: name, fromUrl });
                }
            }

            if (targets.length === 0) {
                return;
            }

            let totalPoints = 0;
            const results = [];

            for (const target of targets) {
                let isAffiliate = false;
                let twitchId = target.twitchId || null;
                let displayUsername = target.username;
                try {
                    if (target.preResolved) {
                        // Already resolved by findBestTwitchMatch — use cached result
                        isAffiliate = target.isAffiliate;
                    } else if (target.fromUrl) {
                        // Twitch.tv link — exact lookup, trust the URL
                        const affiliateResult = await checkAffiliateStatus(guildId, target.username);
                        isAffiliate = affiliateResult.isAffiliate;
                        twitchId = affiliateResult.twitchId || twitchId;
                        displayUsername = affiliateResult.canonicalUsername || target.username;
                    } else if (target.noTwitch) {
                        // Discord mention — findBestTwitchMatch already tried all name variants
                        // and found nothing. Do a final exact lookup on the cleaned name.
                        const affiliateResult = await checkAffiliateStatus(guildId, target.username);
                        isAffiliate = affiliateResult.isAffiliate;
                        twitchId = affiliateResult.twitchId || twitchId;
                        displayUsername = affiliateResult.canonicalUsername || target.username;
                    } else if (target.fromUrl === false) {
                        // Text @mention — try exact match first, then variant
                        const variantMatch = await findBestTwitchMatch([target.username], guildId);
                        if (variantMatch) {
                            isAffiliate = variantMatch.isAffiliate;
                            twitchId = variantMatch.twitchId;
                            displayUsername = variantMatch.canonicalUsername;
                        } else {
                            const affiliateResult = await checkAffiliateStatus(guildId, target.username);
                            isAffiliate = affiliateResult.isAffiliate;
                            twitchId = affiliateResult.twitchId || twitchId;
                            displayUsername = affiliateResult.canonicalUsername || target.username;
                        }
                    } else {
                        // Default: exact lookup (e.g. resolved Discord mention with known username)
                        const affiliateResult = await checkAffiliateStatus(guildId, target.username);
                        isAffiliate = affiliateResult.isAffiliate;
                        twitchId = affiliateResult.twitchId || twitchId;
                        displayUsername = affiliateResult.canonicalUsername || target.username;
                    }
                } catch {
                    // API failure — default to non-affiliate
                }

                // Record the entry
                const points = await recordEntry(
                    guildId, message.author.id, entryType, displayUsername,
                    isAffiliate, message.id, channelId, config, twitchId
                );

                totalPoints += points;
                results.push({ username: displayUsername, isAffiliate, points });
            }

            // React to confirm tracking
            await message.react('\u2705').catch(() => {});

            // Reply with point breakdown
            if (results.length > 0) {
                const pointBreakdown = results.map(r => {
                    const tag = r.isAffiliate ? 'Affiliate' : 'Non-Affiliate';
                    return `**${r.username}** (${tag}) +${r.points}pts`;
                }).join('\n');

                const leaderboardUrl = `https://certifriedmultitool.com/supporters/${guildId}`;
                const embed = new EmbedBuilder()
                    .setColor(entryType === 'raid' ? 0x9146FF : 0x00D166)
                    .setDescription(
                        `${entryType === 'raid' ? '\uD83D\uDEE1\uFE0F Raid' : '\uD83D\uDC9A Support'} tracked for <@${message.author.id}>!\n\n${pointBreakdown}\n\n**Total: +${totalPoints} points**\n\n\uD83D\uDCCA [View your ranking here](${leaderboardUrl})`
                    )
                    .setFooter({ text: 'Community Support Tracker' })
                    .setTimestamp();

                await message.reply({ embeds: [embed], allowedMentions: { repliedUser: false } }).catch(() => {});
            }

        } catch (error) {
            logger.error(`[CommunitySupport] Error processing message in ${channelId}:`, {
                error: error.message,
                messageId: message.id,
                userId: message.author.id
            });
        }
    }
};
