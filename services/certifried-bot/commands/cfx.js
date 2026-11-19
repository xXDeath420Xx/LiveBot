/**
 * CertiFried Extension - Twitch Chat Commands
 * !cfx - View your garden stats
 * !cfxdaily - Claim daily reward
 * !cfxmarket - View market prices
 * !cfxleaderboard - View leaderboard
 */

import * as cfxCommands from '../../certifried-extension/bot/commands.js';
import { isFrozen as v1Frozen, FROZEN_MESSAGE } from '../../certifried-extension/freeze.js';
import { isGreenhouseLive, oldGameMovedMessage } from '../../cfx/integrations/cutover.js';

// Frozen until v2 (CFX_FROZEN, H-636), replaced once Greenhouse Tycoon is live (GREENHOUSE_LIVE=1, phase 5).
const isFrozen = () => v1Frozen() || isGreenhouseLive();

/** Every !cfx command only says the game is frozen, or once live, where it went. */
async function replyFrozen(ctx) {
    const message = isGreenhouseLive() ? oldGameMovedMessage() : FROZEN_MESSAGE;
    try { await ctx.reply(message); } catch { /* chat send failed; nothing else to do */ }
}

/**
 * !cfx - Show player stats
 */
export async function cfxCommand(ctx) {
    if (isFrozen()) return replyFrozen(ctx);
    const { username, userId, reply, profile } = ctx;

    try {
        const user = {
            id: userId,
            username: username,
            displayName: profile?.display_name || username,
            avatar: profile?.profile_image_url || null
        };

        const message = await cfxCommands.handleStatsCommand(user, 'twitch');
        await reply(message);

    } catch (error) {
        await reply(`@${username}, couldn't fetch your garden stats. Try again later!`);
    }
}

/**
 * !cfxdaily - Claim daily reward
 */
export async function cfxDailyCommand(ctx) {
    if (isFrozen()) return replyFrozen(ctx);
    const { username, userId, reply, profile } = ctx;

    try {
        const user = {
            id: userId,
            username: username,
            displayName: profile?.display_name || username,
            avatar: profile?.profile_image_url || null
        };

        const result = await cfxCommands.handleDailyReward(user, 'twitch');
        await reply(result.message);

    } catch (error) {
        await reply(`@${username}, couldn't claim your daily. Try again later!`);
    }
}

/**
 * !cfxmarket - View market prices
 */
export async function cfxMarketCommand(ctx) {
    if (isFrozen()) return replyFrozen(ctx);
    const { reply } = ctx;

    try {
        const message = await cfxCommands.handleMarketCommand();
        await reply(message);

    } catch (error) {
        await reply(`Market data unavailable. Try again later!`);
    }
}

/**
 * !cfxleaderboard - View leaderboard
 */
export async function cfxLeaderboardCommand(ctx) {
    if (isFrozen()) return replyFrozen(ctx);
    const { reply, args } = ctx;

    try {
        const type = args[0]?.toLowerCase() || 'level';
        const validTypes = ['level', 'currency', 'prestige'];
        const finalType = validTypes.includes(type) ? type : 'level';

        const message = await cfxCommands.handleLeaderboardCommand(finalType, 5);
        await reply(message);

    } catch (error) {
        await reply(`Leaderboard unavailable. Try again later!`);
    }
}

/**
 * !cfxsell - Quick sell from inventory
 */
export async function cfxSellCommand(ctx) {
    if (isFrozen()) return replyFrozen(ctx);
    const { username, userId, reply, args, profile } = ctx;

    if (!args[0]) {
        await reply(`@${username}, usage: !cfxsell <strain name> [quantity]`);
        return;
    }

    try {
        const user = {
            id: userId,
            username: username,
            displayName: profile?.display_name || username
        };

        const strainName = args.slice(0, -1).join(' ') || args[0];
        const quantity = parseInt(args[args.length - 1], 10) || 1;

        const message = await cfxCommands.handleQuickSellCommand(
            user,
            'twitch',
            strainName,
            isNaN(quantity) ? 1 : quantity
        );
        await reply(message);

    } catch (error) {
        await reply(`@${username}, sale failed. Try again later!`);
    }
}

export default {
    cfxCommand,
    cfxDailyCommand,
    cfxMarketCommand,
    cfxLeaderboardCommand,
    cfxSellCommand
};
