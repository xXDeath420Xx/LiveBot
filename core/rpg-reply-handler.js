/**
 * RPG Reply Handler
 * Allows players to reply to bot messages to continue their RPG session
 * instead of using slash commands
 */

import { EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import RPGAiDungeonMaster from './rpg-ai-dm.js';
import RPGCampaignManager from './rpg-campaign-manager.js';
import RPGDiceEngine from './rpg-dice-engine.js';
import RPGClassResourceManager from './rpg-class-resource-manager.js';
import RPGSpellManager from './rpg-spell-manager.js';
import pool from '../utils/db.js';

// Track active RPG session channels (channelId -> lastMessageId)
const activeRPGChannels = new Map();

// Cache for guild RPG channel settings (guildId -> channelId or null)
const rpgChannelCache = new Map();

/**
 * Get the designated RPG channel for a guild
 * @param {string} guildId
 * @returns {Promise<string|null>}
 */
export async function getRPGChannel(guildId) {
    // Check cache first
    if (rpgChannelCache.has(guildId)) {
        return rpgChannelCache.get(guildId);
    }

    try {
        const [rows] = await pool.execute(
            'SELECT rpg_channel_id FROM guild_settings WHERE guild_id = ?',
            [guildId]
        );

        const channelId = rows[0]?.rpg_channel_id || null;
        rpgChannelCache.set(guildId, channelId);
        return channelId;
    } catch (error) {
        logger.error('[RPG] Error getting RPG channel:', error);
        return null;
    }
}

/**
 * Set the designated RPG channel for a guild
 * @param {string} guildId
 * @param {string|null} channelId - null to clear
 */
export async function setRPGChannel(guildId, channelId) {
    try {
        await pool.execute(
            `INSERT INTO guild_settings (guild_id, rpg_channel_id)
             VALUES (?, ?)
             ON DUPLICATE KEY UPDATE rpg_channel_id = ?`,
            [guildId, channelId, channelId]
        );
        rpgChannelCache.set(guildId, channelId);
        return true;
    } catch (error) {
        logger.error('[RPG] Error setting RPG channel:', error);
        return false;
    }
}

/**
 * Check if a channel is the designated RPG channel (or no channel is set)
 * @param {string} guildId
 * @param {string} channelId
 * @returns {Promise<boolean>}
 */
export async function isRPGChannel(guildId, channelId) {
    const rpgChannel = await getRPGChannel(guildId);
    // RPG is off by default - a channel must be explicitly designated
    // If no RPG channel is set, RPG replies are disabled everywhere
    if (!rpgChannel) return false;
    return rpgChannel === channelId;
}

// Track user's active RPG channel (userId -> channelId) for @mention detection
const userActiveChannels = new Map();

/**
 * Register a message as an RPG session message
 * Called when the bot sends an RPG response
 */
export function registerRPGMessage(channelId, messageId, sessionId, userId = null) {
    activeRPGChannels.set(channelId, {
        messageId,
        sessionId,
        timestamp: Date.now()
    });

    // Track user's active RPG channel for @mention and channel-based detection
    if (userId) {
        userActiveChannels.set(userId, {
            channelId,
            timestamp: Date.now()
        });
    }
}

/**
 * Get user's active RPG channel info
 */
export function getUserActiveChannel(userId) {
    const data = userActiveChannels.get(userId);
    if (!data) return null;

    // Expire after 30 minutes of inactivity
    const thirtyMinutes = 30 * 60 * 1000;
    if (Date.now() - data.timestamp > thirtyMinutes) {
        userActiveChannels.delete(userId);
        return null;
    }

    return data;
}

/**
 * Clear user's active RPG channel (used when game ends)
 */
export function clearUserActiveChannel(userId) {
    userActiveChannels.delete(userId);
}

/**
 * Clear channel from active RPG channels (used when game ends)
 */
export function clearActiveRPGChannel(channelId) {
    activeRPGChannels.delete(channelId);
}

/**
 * Check if a channel has an active RPG session
 */
export function hasActiveRPGSession(channelId) {
    const data = activeRPGChannels.get(channelId);
    if (!data) return false;

    // Expire after 2 hours of inactivity
    const twoHours = 2 * 60 * 60 * 1000;
    if (Date.now() - data.timestamp > twoHours) {
        activeRPGChannels.delete(channelId);
        return false;
    }

    return true;
}

/**
 * Handle a message that might be an RPG reply
 * @param {Message} message - Discord message
 * @returns {boolean} True if message was handled as RPG reply
 */
export async function handleRPGReply(message) {
    try {
        // Must be a reply to another message
        if (!message.reference?.messageId) return false;

        // RPG replies only work in the designated RPG channel
        // If no RPG channel is set, RPG is disabled — don't intercept replies
        if (!await isRPGChannel(message.guild.id, message.channel.id)) return false;

        // Get the message being replied to
        let repliedTo;
        try {
            repliedTo = await message.channel.messages.fetch(message.reference.messageId);
        } catch {
            return false;
        }

        // Must be replying to the bot
        if (repliedTo.author.id !== message.client.user.id) return false;

        // Check if it's an RPG message by looking at embeds
        const isRPGMessage = repliedTo.embeds.some(embed => {
            const footer = embed.footer?.text || '';
            const description = embed.description || '';
            // Check for RPG indicators
            return footer.includes('Reply to') ||
                   footer.includes('What do you do') ||
                   footer.includes('/rpg play') ||
                   description.includes('🎲') ||
                   embed.title?.includes('Combat') ||
                   embed.title?.includes('Session') ||
                   embed.fields?.some(f => f.name.includes('Roll'));
        });

        if (!isRPGMessage) return false;

        // Get player's campaign and session
        const campaign = await RPGCampaignManager.getUserActiveCampaign(
            message.author.id,
            message.guild.id
        );

        if (!campaign) {
            await message.reply({
                content: '❌ You\'re not in a campaign. Join one with `/rpg campaign join` first!',
                allowedMentions: { repliedUser: false }
            });
            return true;
        }

        const session = await RPGAiDungeonMaster.getActiveSession(campaign.campaign_id);
        if (!session) {
            await message.reply({
                content: '❌ No active session. Start one with `/rpg session start`',
                allowedMentions: { repliedUser: false }
            });
            return true;
        }

        const character = await RPGCampaignManager.getPlayerCharacter(
            message.author.id,
            campaign.campaign_id
        );

        if (!character) {
            await message.reply({
                content: '❌ Could not find your character in this campaign.',
                allowedMentions: { repliedUser: false }
            });
            return true;
        }

        // Parse the player's input
        let playerInput = message.content.trim();
        let actionType = 'action';

        // Check for special prefixes
        if (playerInput.startsWith('"') || playerInput.startsWith("'") || playerInput.startsWith('say ')) {
            // Speaking in character
            playerInput = playerInput.replace(/^["']|["']$/g, '').replace(/^say /i, '');
            actionType = 'dialogue';
        } else if (playerInput.toLowerCase().startsWith('examine ') || playerInput.toLowerCase().startsWith('look at ')) {
            actionType = 'examine';
        } else if (playerInput.toLowerCase().startsWith('roll ')) {
            // Handle roll commands
            const rollMatch = playerInput.match(/^roll\s+(.+)/i);
            if (rollMatch) {
                const rollType = rollMatch[1].toLowerCase();
                const rollResult = await handleQuickRoll(character, rollType);
                if (rollResult) {
                    playerInput = rollResult;
                    actionType = 'roll';
                }
            }
        }

        // Show typing indicator
        await message.channel.sendTyping();

        // Process the action through AI DM
        const response = await RPGAiDungeonMaster.processPlayerAction(
            session.session_id,
            character.character_id,
            playerInput,
            actionType
        );

        // Build response embed
        const embed = new EmbedBuilder()
            .setColor(response.combatInitiated || response.inCombat ? '#FF0000' : '#9B59B6')
            .setDescription(response.narration.length > 3500
                ? response.narration.substring(0, 3500) + '...'
                : response.narration);

        // Add combat status if in combat
        if (response.combatStatus) {
            embed.addFields({
                name: '⚔️ Combat',
                value: response.combatStatus.length > 1000 ? response.combatStatus.substring(0, 1000) + '...' : response.combatStatus,
                inline: false
            });
        }

        // Add status bar
        if (response.statusBar) {
            embed.addFields({
                name: `📊 ${character.character_name}`,
                value: response.statusBar,
                inline: false
            });
        }

        // Add location
        if (response.location && response.location !== 'Unknown Location') {
            embed.setAuthor({ name: `📍 ${response.location}` });
        }

        // Add rewards if any
        const rewards = [];
        if (response.goldGained > 0) rewards.push(`💰 ${response.goldGained} gold`);
        if (response.xpGained > 0) rewards.push(`✨ ${response.xpGained} XP`);
        if (response.loot && response.loot.length > 0) {
            rewards.push(...response.loot.map(l => `🎁 ${l.item}${l.quantity > 1 ? ` x${l.quantity}` : ''}`));
        }
        if (rewards.length > 0) {
            embed.addFields({
                name: '🏆 Rewards',
                value: rewards.join(' | '),
                inline: false
            });
        }

        if (response.combatInitiated) {
            embed.setTitle('⚔️ Combat!');
        }

        // Handle GAME OVER - no buttons, different footer, clear tracking
        if (response.gameOver) {
            embed.setTitle('🎭 Game Over');
            embed.setFooter({ text: `${character.character_name}'s adventure has ended. Use /rpg start to begin a new journey!` });
            embed.setColor('#444444'); // Gray color for ended game

            // Clear active channel tracking
            clearUserActiveChannel(message.author.id);
            clearActiveRPGChannel(message.channel.id);

            // Send response WITHOUT buttons
            await message.reply({
                embeds: [embed],
                components: [], // No buttons
                allowedMentions: { repliedUser: false }
            });

            logger.info('[RPG Reply] Game Over - session ended', {
                userId: message.author.id,
                characterName: character.character_name,
                reason: response.gameOverReason
            });

            return true;
        }

        embed.setFooter({ text: `${character.character_name} | @mention or reply to continue` });

        // Build quick action buttons
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
        const buttonRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('rpg_quick_attack')
                    .setLabel('Attack')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('⚔️'),
                new ButtonBuilder()
                    .setCustomId('rpg_quick_search')
                    .setLabel('Search')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('🔍'),
                new ButtonBuilder()
                    .setCustomId('rpg_quick_talk')
                    .setLabel('Talk')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('💬'),
                new ButtonBuilder()
                    .setCustomId('rpg_quick_rest')
                    .setLabel('Rest')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('🏕️')
            );

        // Send response
        const reply = await message.reply({
            embeds: [embed],
            components: [buttonRow],
            allowedMentions: { repliedUser: false }
        });

        // Register this message for future replies (include userId for @mention support)
        registerRPGMessage(message.channel.id, reply.id, session.session_id, message.author.id);

        logger.info('[RPG Reply] Processed player action via reply', {
            userId: message.author.id,
            characterName: character.character_name,
            actionType
        });

        return true;

    } catch (error) {
        logger.error('[RPG Reply] Error handling reply', {
            error: error.message,
            stack: error.stack
        });

        try {
            await message.reply({
                content: '❌ There was an issue processing your action. Try using `/rpg play action` instead.',
                allowedMentions: { repliedUser: false }
            });
        } catch {
            // Ignore if we can't reply
        }

        return true; // Still return true to indicate we handled it (even if with error)
    }
}

/**
 * Handle RPG messages via @mention or channel-based detection
 * @param {Message} message - Discord message
 * @param {boolean} isMention - Whether the bot was @mentioned
 * @returns {boolean} True if message was handled as RPG action
 */
export async function handleRPGMentionOrChannel(message, isMention = false) {
    try {
        // RPG only works in the designated RPG channel — skip if not set or wrong channel
        if (!await isRPGChannel(message.guild.id, message.channel.id)) return false;

        // Check if user has an active RPG session in this channel
        const userChannel = getUserActiveChannel(message.author.id);
        const channelData = activeRPGChannels.get(message.channel.id);

        // For channel-based detection, must be in the same channel as their active session
        if (!isMention && (!userChannel || userChannel.channelId !== message.channel.id)) {
            return false;
        }

        const isDesignatedRPGChannel = true; // Already confirmed above

        // Channel must have had RPG activity recently (within 30 mins)
        if (!channelData) {
            if (isMention && isDesignatedRPGChannel) {
                // Give helpful RPG message since we're in the designated RPG channel
                await message.reply({
                    content: '🎲 No active RPG session here! Start one with `/rpg session start` or join with `/rpg campaign join`',
                    allowedMentions: { repliedUser: false }
                });
                return true;
            }
            // Not in RPG channel or no active session - let other handlers process the mention
            return false;
        }

        // Get player's campaign and session
        const campaign = await RPGCampaignManager.getUserActiveCampaign(
            message.author.id,
            message.guild.id
        );

        if (!campaign) {
            if (isMention && isDesignatedRPGChannel) {
                await message.reply({
                    content: '❌ You\'re not in a campaign. Join one with `/rpg campaign join` first!',
                    allowedMentions: { repliedUser: false }
                });
                return true;
            }
            return false;
        }

        const session = await RPGAiDungeonMaster.getActiveSession(campaign.campaign_id);
        if (!session) {
            if (isMention) {
                await message.reply({
                    content: '❌ No active session. Start one with `/rpg session start`',
                    allowedMentions: { repliedUser: false }
                });
            }
            return isMention;
        }

        const character = await RPGCampaignManager.getPlayerCharacter(
            message.author.id,
            campaign.campaign_id
        );

        if (!character) {
            if (isMention) {
                await message.reply({
                    content: '❌ Could not find your character in this campaign.',
                    allowedMentions: { repliedUser: false }
                });
            }
            return isMention;
        }

        // Parse the player's input (strip the mention if present)
        let playerInput = message.content.trim();

        // Remove bot mention from the message
        const mentionRegex = new RegExp(`<@!?${message.client.user.id}>`, 'g');
        playerInput = playerInput.replace(mentionRegex, '').trim();

        // If empty after removing mention, ignore
        if (!playerInput) {
            return false;
        }

        let actionType = 'action';

        // Check for special prefixes
        if (playerInput.startsWith('"') || playerInput.startsWith("'") || playerInput.startsWith('say ')) {
            playerInput = playerInput.replace(/^["']|["']$/g, '').replace(/^say /i, '');
            actionType = 'dialogue';
        } else if (playerInput.toLowerCase().startsWith('examine ') || playerInput.toLowerCase().startsWith('look at ')) {
            actionType = 'examine';
        } else if (playerInput.toLowerCase().startsWith('roll ')) {
            const rollMatch = playerInput.match(/^roll\s+(.+)/i);
            if (rollMatch) {
                const rollType = rollMatch[1].toLowerCase();
                const rollResult = await handleQuickRoll(character, rollType);
                if (rollResult) {
                    playerInput = rollResult;
                    actionType = 'roll';
                }
            }
        }

        // Show typing indicator
        await message.channel.sendTyping();

        // Process the action through AI DM
        const response = await RPGAiDungeonMaster.processPlayerAction(
            session.session_id,
            character.character_id,
            playerInput,
            actionType
        );

        // Build response embed
        const embed = new EmbedBuilder()
            .setColor(response.combatInitiated || response.inCombat ? '#FF0000' : '#9B59B6')
            .setDescription(response.narration.length > 3500
                ? response.narration.substring(0, 3500) + '...'
                : response.narration);

        if (response.combatStatus) {
            embed.addFields({
                name: '⚔️ Combat',
                value: response.combatStatus.length > 1000 ? response.combatStatus.substring(0, 1000) + '...' : response.combatStatus,
                inline: false
            });
        }

        if (response.statusBar) {
            embed.addFields({
                name: `📊 ${character.character_name}`,
                value: response.statusBar,
                inline: false
            });
        }

        if (response.location && response.location !== 'Unknown Location') {
            embed.setAuthor({ name: `📍 ${response.location}` });
        }

        const rewards = [];
        if (response.goldGained > 0) rewards.push(`💰 ${response.goldGained} gold`);
        if (response.xpGained > 0) rewards.push(`✨ ${response.xpGained} XP`);
        if (response.loot && response.loot.length > 0) {
            rewards.push(...response.loot.map(l => `🎁 ${l.item}${l.quantity > 1 ? ` x${l.quantity}` : ''}`));
        }
        if (rewards.length > 0) {
            embed.addFields({
                name: '🏆 Rewards',
                value: rewards.join(' | '),
                inline: false
            });
        }

        if (response.combatInitiated) {
            embed.setTitle('⚔️ Combat!');
        }

        // Handle GAME OVER - no buttons, different footer, clear tracking
        if (response.gameOver) {
            embed.setTitle('🎭 Game Over');
            embed.setFooter({ text: `${character.character_name}'s adventure has ended. Use /rpg start to begin a new journey!` });
            embed.setColor('#444444'); // Gray color for ended game

            // Clear active channel tracking
            clearUserActiveChannel(message.author.id);
            clearActiveRPGChannel(message.channel.id);

            // Send response WITHOUT buttons
            await message.reply({
                embeds: [embed],
                components: [], // No buttons
                allowedMentions: { repliedUser: false }
            });

            logger.info('[RPG Mention/Channel] Game Over - session ended', {
                userId: message.author.id,
                characterName: character.character_name,
                reason: response.gameOverReason
            });

            return true;
        }

        embed.setFooter({ text: `${character.character_name} | @mention or reply to continue` });

        // Build quick action buttons
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = await import('discord.js');
        const buttonRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('rpg_quick_attack')
                    .setLabel('Attack')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('⚔️'),
                new ButtonBuilder()
                    .setCustomId('rpg_quick_search')
                    .setLabel('Search')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('🔍'),
                new ButtonBuilder()
                    .setCustomId('rpg_quick_talk')
                    .setLabel('Talk')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('💬'),
                new ButtonBuilder()
                    .setCustomId('rpg_quick_rest')
                    .setLabel('Rest')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('🏕️')
            );

        // Send response
        const reply = await message.reply({
            embeds: [embed],
            components: [buttonRow],
            allowedMentions: { repliedUser: false }
        });

        // Register this message for future interactions
        registerRPGMessage(message.channel.id, reply.id, session.session_id, message.author.id);

        logger.info('[RPG Mention/Channel] Processed player action', {
            userId: message.author.id,
            characterName: character.character_name,
            actionType,
            viaMention: isMention
        });

        return true;

    } catch (error) {
        logger.error('[RPG Mention/Channel] Error handling message', {
            error: error.message,
            stack: error.stack
        });

        try {
            await message.reply({
                content: '❌ There was an issue processing your action. Try using `/rpg play action` instead.',
                allowedMentions: { repliedUser: false }
            });
        } catch {
            // Ignore if we can't reply
        }

        return true;
    }
}

/**
 * Handle quick roll commands from replies
 */
async function handleQuickRoll(character, rollType) {
    const skillMap = {
        'perception': 'perception',
        'investigation': 'investigation',
        'stealth': 'stealth',
        'insight': 'insight',
        'persuasion': 'persuasion',
        'deception': 'deception',
        'intimidation': 'intimidation',
        'athletics': 'athletics',
        'acrobatics': 'acrobatics',
        'arcana': 'arcana',
        'history': 'history',
        'nature': 'nature',
        'religion': 'religion',
        'medicine': 'medicine',
        'survival': 'survival',
        'animal handling': 'animal_handling',
        'sleight of hand': 'sleight_of_hand',
        'performance': 'performance'
    };

    const saveMap = {
        'str save': 'strength',
        'strength save': 'strength',
        'dex save': 'dexterity',
        'dexterity save': 'dexterity',
        'con save': 'constitution',
        'constitution save': 'constitution',
        'int save': 'intelligence',
        'intelligence save': 'intelligence',
        'wis save': 'wisdom',
        'wisdom save': 'wisdom',
        'cha save': 'charisma',
        'charisma save': 'charisma'
    };

    const normalizedType = rollType.toLowerCase().trim();

    // Check for skill
    if (skillMap[normalizedType]) {
        const rollResult = RPGDiceEngine.skillCheck(character, skillMap[normalizedType], 'normal');

        const critText = rollResult.d20.isCritical ? ' **NAT 20!**' : rollResult.d20.isFumble ? ' **NAT 1!**' : '';
        const profText = rollResult.proficiencyLevel > 0 ? (rollResult.proficiencyLevel === 2 ? ' (Expertise)' : ' (Proficient)') : '';

        return `rolls a ${rollResult.skillName} check${profText}: ${rollResult.d20.roll} ${RPGDiceEngine.formatModifier(rollResult.totalModifier)} = **${rollResult.total}**${critText}`;
    }

    // Check for save
    if (saveMap[normalizedType]) {
        const rollResult = RPGDiceEngine.savingThrow(character, saveMap[normalizedType], 10, 'normal');

        const critText = rollResult.d20.isCritical ? ' **NAT 20!**' : rollResult.d20.isFumble ? ' **NAT 1!**' : '';
        const profText = rollResult.isProficient ? ' (Proficient)' : '';

        return `rolls a ${rollResult.abilityName} saving throw${profText}: ${rollResult.d20.roll} ${RPGDiceEngine.formatModifier(rollResult.totalModifier)} = **${rollResult.total}**${critText}`;
    }

    // Check for initiative
    if (normalizedType === 'initiative' || normalizedType === 'init') {
        const rollResult = RPGDiceEngine.rollInitiative(character);
        return `rolls initiative: ${rollResult.d20.roll} ${RPGDiceEngine.formatModifier(rollResult.totalModifier)} = **${rollResult.total}**`;
    }

    // Generic dice roll (e.g., "roll 1d20+5")
    const diceMatch = normalizedType.match(/(\d+d\d+(?:[+-]\d+)?)/);
    if (diceMatch) {
        const result = RPGDiceEngine.roll(diceMatch[1]);
        return `rolls ${diceMatch[1]}: [${result.rolls.join(', ')}]${result.modifier !== 0 ? ` ${RPGDiceEngine.formatModifier(result.modifier)}` : ''} = **${result.total}**`;
    }

    return null;
}

export default {
    handleRPGReply,
    handleRPGMentionOrChannel,
    registerRPGMessage,
    hasActiveRPGSession,
    getUserActiveChannel,
    clearUserActiveChannel,
    clearActiveRPGChannel,
    getRPGChannel,
    setRPGChannel,
    isRPGChannel
};
