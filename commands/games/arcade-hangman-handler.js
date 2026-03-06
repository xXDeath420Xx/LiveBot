import * as hangmanManager from '../../core/hangman-manager.js';

export async function handleStart(interaction) {
    await hangmanManager.handleStart(interaction);
}

export async function handleGuess(interaction) {
    await hangmanManager.handleGuess(interaction);
}

export async function handleGiveUp(interaction) {
    await hangmanManager.handleGiveUp(interaction);
}

export async function handleStats(interaction) {
    await hangmanManager.handleStats(interaction);
}
