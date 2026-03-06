import * as triviaManager from '../../core/trivia-manager.js';

export async function handleStart(interaction) {
    await triviaManager.handleStart(interaction);
}

export async function handleStats(interaction) {
    await triviaManager.handleStats(interaction);
}

export async function handleLeaderboard(interaction) {
    await triviaManager.handleLeaderboard(interaction);
}

export async function handleButton(interaction) {
    return await triviaManager.handleButton(interaction);
}
