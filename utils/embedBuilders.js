import { EmbedBuilder } from 'discord.js';
import Colors from './colors.js';

/**
 * Standardized embed builders for consistent UI across the bot
 * Reduces code duplication and ensures consistent styling
 */

/**
 * Create a success embed
 * @param {string} title - Embed title
 * @param {string} description - Embed description
 * @param {Object} options - Additional options
 * @returns {EmbedBuilder}
 */
export function createSuccessEmbed(title, description, options = {}) {
    const embed = new EmbedBuilder()
        .setColor(options.color || Colors.SUCCESS)
        .setDescription(description)
        .setTimestamp();

    if (title) embed.setTitle(title);
    if (options.footer) embed.setFooter({ text: options.footer });
    if (options.thumbnail) embed.setThumbnail(options.thumbnail);
    if (options.fields) embed.addFields(options.fields);

    return embed;
}

/**
 * Create an error embed
 * @param {string} title - Embed title
 * @param {string} description - Error description
 * @param {Object} options - Additional options
 * @returns {EmbedBuilder}
 */
export function createErrorEmbed(title, description, options = {}) {
    const embed = new EmbedBuilder()
        .setColor(options.color || Colors.ERROR)
        .setDescription(description)
        .setTimestamp();

    if (title) embed.setTitle(title);
    if (options.footer) embed.setFooter({ text: options.footer });

    return embed;
}

/**
 * Create a warning embed
 * @param {string} title - Embed title
 * @param {string} description - Warning description
 * @param {Object} options - Additional options
 * @returns {EmbedBuilder}
 */
export function createWarningEmbed(title, description, options = {}) {
    const embed = new EmbedBuilder()
        .setColor(options.color || Colors.WARNING)
        .setDescription(description)
        .setTimestamp();

    if (title) embed.setTitle(title);
    if (options.footer) embed.setFooter({ text: options.footer });
    if (options.fields) embed.addFields(options.fields);

    return embed;
}

/**
 * Create an info embed
 * @param {string} title - Embed title
 * @param {string} description - Info description
 * @param {Object} options - Additional options
 * @returns {EmbedBuilder}
 */
export function createInfoEmbed(title, description, options = {}) {
    const embed = new EmbedBuilder()
        .setColor(options.color || Colors.INFO)
        .setDescription(description)
        .setTimestamp();

    if (title) embed.setTitle(title);
    if (options.footer) embed.setFooter({ text: options.footer });
    if (options.thumbnail) embed.setThumbnail(options.thumbnail);
    if (options.fields) embed.addFields(options.fields);
    if (options.image) embed.setImage(options.image);

    return embed;
}

/**
 * Create a leaderboard embed
 * @param {string} title - Leaderboard title
 * @param {Array} entries - Array of { rank, name, value } objects
 * @param {Object} options - Additional options
 * @returns {EmbedBuilder}
 */
export function createLeaderboardEmbed(title, entries, options = {}) {
    const medals = ['🥇', '🥈', '🥉'];

    const description = entries.map((entry, i) => {
        const medal = i < 3 ? medals[i] : `**${i + 1}.**`;
        return `${medal} ${entry.name} - ${entry.value}`;
    }).join('\n');

    const embed = new EmbedBuilder()
        .setColor(options.color || Colors.PRIMARY)
        .setTitle(title)
        .setDescription(description || 'No entries yet')
        .setTimestamp();

    if (options.footer) embed.setFooter({ text: options.footer });
    if (options.thumbnail) embed.setThumbnail(options.thumbnail);

    return embed;
}

/**
 * Create a stats embed with multiple fields
 * @param {string} title - Stats title
 * @param {Array} stats - Array of { name, value, inline } field objects
 * @param {Object} options - Additional options
 * @returns {EmbedBuilder}
 */
export function createStatsEmbed(title, stats, options = {}) {
    const embed = new EmbedBuilder()
        .setColor(options.color || Colors.PRIMARY)
        .setTitle(title)
        .addFields(stats.map(s => ({
            name: s.name,
            value: String(s.value),
            inline: s.inline !== false
        })))
        .setTimestamp();

    if (options.description) embed.setDescription(options.description);
    if (options.footer) embed.setFooter({ text: options.footer });
    if (options.thumbnail) embed.setThumbnail(options.thumbnail);

    return embed;
}

/**
 * Create a moderation action embed
 * @param {string} action - Action taken (ban, kick, mute, etc.)
 * @param {Object} target - Target user { tag, id, avatarURL }
 * @param {Object} moderator - Moderator user { tag, id }
 * @param {string} reason - Reason for action
 * @param {Object} options - Additional options like duration
 * @returns {EmbedBuilder}
 */
export function createModActionEmbed(action, target, moderator, reason, options = {}) {
    const embed = new EmbedBuilder()
        .setColor(Colors.MODERATION)
        .setTitle(`${action.charAt(0).toUpperCase() + action.slice(1)}`)
        .setThumbnail(target.avatarURL || null)
        .addFields(
            { name: 'User', value: `${target.tag} (${target.id})`, inline: true },
            { name: 'Moderator', value: `${moderator.tag}`, inline: true },
            { name: 'Reason', value: reason || 'No reason provided', inline: false }
        )
        .setTimestamp();

    if (options.duration) {
        embed.addFields({ name: 'Duration', value: options.duration, inline: true });
    }

    if (options.caseId) {
        embed.setFooter({ text: `Case #${options.caseId}` });
    }

    return embed;
}

/**
 * Create a loading/processing embed
 * @param {string} message - Loading message
 * @returns {EmbedBuilder}
 */
export function createLoadingEmbed(message = 'Processing...') {
    return new EmbedBuilder()
        .setColor(Colors.INFO)
        .setDescription(`⏳ ${message}`);
}

/**
 * Create a paginated embed footer
 * @param {number} currentPage - Current page (1-indexed)
 * @param {number} totalPages - Total number of pages
 * @param {string} additionalText - Additional footer text
 * @returns {string} Footer text
 */
export function createPaginationFooter(currentPage, totalPages, additionalText = '') {
    const pageText = `Page ${currentPage}/${totalPages}`;
    return additionalText ? `${pageText} • ${additionalText}` : pageText;
}

export default {
    createSuccessEmbed,
    createErrorEmbed,
    createWarningEmbed,
    createInfoEmbed,
    createLeaderboardEmbed,
    createStatsEmbed,
    createModActionEmbed,
    createLoadingEmbed,
    createPaginationFooter
};
