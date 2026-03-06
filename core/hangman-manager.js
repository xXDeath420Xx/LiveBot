import { EmbedBuilder } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';

// Store active hangman games
const activeHangmanGames = new Map();

const HANGMAN_STAGES = [
    "```\n  +---+\n  |   |\n      |\n      |\n      |\n      |\n=========```",
    "```\n  +---+\n  |   |\n  O   |\n      |\n      |\n      |\n=========```",
    "```\n  +---+\n  |   |\n  O   |\n  |   |\n      |\n      |\n=========```",
    "```\n  +---+\n  |   |\n  O   |\n /|   |\n      |\n      |\n=========```",
    "```\n  +---+\n  |   |\n  O   |\n /|\\  |\n      |\n      |\n=========```",
    "```\n  +---+\n  |   |\n  O   |\n /|\\  |\n /    |\n      |\n=========```",
    "```\n  +---+\n  |   |\n  O   |\n /|\\  |\n / \\  |\n      |\n=========```"
];

export async function handleStart(interaction) {
    const difficulty = interaction.options.getString('difficulty') || 'medium';
    const category = interaction.options.getString('category') || 'random';

    // Check if user already has an active game
    const existingGame = Array.from(activeHangmanGames.values()).find(
        game => game.userId === interaction.user.id && game.guildId === interaction.guild.id
    );

    if (existingGame) {
        return interaction.reply({
            content: '❌ You already have an active hangman game! Use `/hangman guess` to continue or `/hangman give-up` to end it.',
            ephemeral: true
        });
    }

    // Get random word from database
    let query = 'SELECT * FROM word_list WHERE difficulty = ? AND is_active = TRUE';
    const params = [difficulty];

    if (category !== 'random') {
        query += ' AND category = ?';
        params.push(category);
    }

    query += ' ORDER BY RAND() LIMIT 1';

    const [[wordData]] = await pool.execute(query, params);

    if (!wordData) {
        return interaction.reply({
            content: '❌ No words found for the selected difficulty and category.',
            ephemeral: true
        });
    }

    const word = wordData.word.toUpperCase();

    // Initialize game
    const gameId = `${interaction.guild.id}-${interaction.user.id}-${Date.now()}`;
    const gameSession = {
        gameId,
        userId: interaction.user.id,
        guildId: interaction.guild.id,
        channelId: interaction.channel.id,
        word,
        guessedLetters: new Set(),
        wrongGuesses: 0,
        maxWrongGuesses: 6,
        startTime: Date.now(),
        difficulty,
        category: wordData.category,
        definition: wordData.definition
    };

    activeHangmanGames.set(gameId, gameSession);

    // Send game board
    await displayGame(interaction, gameSession, false);

    // Set timeout to auto-end game after 10 minutes of inactivity
    setTimeout(() => {
        if (activeHangmanGames.has(gameId)) {
            activeHangmanGames.delete(gameId);
        }
    }, 10 * 60 * 1000);
}

export async function handleGuess(interaction) {
    let guess = interaction.options.getString('guess').toUpperCase().trim();

    // Find user's active game
    const game = Array.from(activeHangmanGames.values()).find(
        g => g.userId === interaction.user.id && g.guildId === interaction.guild.id
    );

    if (!game) {
        return interaction.reply({
            content: "❌ You don't have an active hangman game! Use `/hangman start` to begin.",
            ephemeral: true
        });
    }

    // Check if single letter
    if (guess.length === 1) {
        if (!/[A-Z]/.test(guess)) {
            return interaction.reply({
                content: '❌ Please guess a valid letter (A-Z).',
                ephemeral: true
            });
        }

        if (game.guessedLetters.has(guess)) {
            return interaction.reply({
                content: `❌ You already guessed the letter **${guess}**!`,
                ephemeral: true
            });
        }

        game.guessedLetters.add(guess);

        if (!game.word.includes(guess)) {
            game.wrongGuesses++;
        }

        await displayGame(interaction, game, false);

    } else {
        // Full word guess
        if (guess === game.word) {
            // Correct! Fill in all letters
            for (const letter of game.word) {
                game.guessedLetters.add(letter);
            }
            await displayGame(interaction, game, false);
        } else {
            game.wrongGuesses += 2; // Wrong word guess counts as 2 mistakes
            await interaction.reply({
                content: `❌ **${guess}** is not the word! (-2 lives)`,
                ephemeral: false
            });

            if (game.wrongGuesses >= game.maxWrongGuesses) {
                await displayGame(interaction, game, true);
            }
        }
    }
}

export async function handleGiveUp(interaction) {
    const game = Array.from(activeHangmanGames.values()).find(
        g => g.userId === interaction.user.id && g.guildId === interaction.guild.id
    );

    if (!game) {
        return interaction.reply({
            content: "❌ You don't have an active hangman game!",
            ephemeral: true
        });
    }

    game.wrongGuesses = game.maxWrongGuesses; // Trigger loss
    await displayGame(interaction, game, true);
}

export async function displayGame(interaction, game, forceEnd = false) {
    const isGameOver = forceEnd || game.wrongGuesses >= game.maxWrongGuesses || isWordComplete(game);
    const won = isWordComplete(game) && game.wrongGuesses < game.maxWrongGuesses;

    // Build display word
    let displayWord = '';
    for (const letter of game.word) {
        if (letter === ' ') {
            displayWord += '  ';
        } else if (game.guessedLetters.has(letter) || isGameOver) {
            displayWord += letter + ' ';
        } else {
            displayWord += '_ ';
        }
    }

    const embed = new EmbedBuilder()
        .setColor(isGameOver ? (won ? '#00FF00' : '#FF0000') : '#3498db')
        .setTitle(isGameOver ? (won ? '🎉 You Won!' : '💀 Game Over!') : '🎯 Hangman')
        .setDescription(`${HANGMAN_STAGES[game.wrongGuesses]}\n\n**${displayWord}**`)
        .addFields(
            { name: '❤️ Lives', value: `${game.maxWrongGuesses - game.wrongGuesses}/${game.maxWrongGuesses}`, inline: true },
            { name: '📚 Category', value: game.category, inline: true },
            { name: '⚡ Difficulty', value: game.difficulty, inline: true }
        );

    if (game.guessedLetters.size > 0) {
        const guessedArray = Array.from(game.guessedLetters).sort();
        const correctLetters = guessedArray.filter(l => game.word.includes(l));
        const wrongLetters = guessedArray.filter(l => !game.word.includes(l));

        if (correctLetters.length > 0) {
            embed.addFields({ name: '✅ Correct Letters', value: correctLetters.join(' '), inline: false });
        }
        if (wrongLetters.length > 0) {
            embed.addFields({ name: '❌ Wrong Letters', value: wrongLetters.join(' '), inline: false });
        }
    }

    if (isGameOver) {
        embed.addFields({ name: '📖 The Word Was', value: `**${game.word}**`, inline: false });

        if (game.definition) {
            embed.addFields({ name: '💡 Definition', value: game.definition, inline: false });
        }

        const duration = Math.floor((Date.now() - game.startTime) / 1000);
        embed.addFields({ name: '⏱️ Time', value: `${duration}s`, inline: true });

        if (won) {
            const score = calculateScore(game);
            embed.addFields({ name: '💰 Score', value: `${score}`, inline: true });
        }

        // Update stats
        await updateHangmanStats(game, won);

        // Remove game from active games
        activeHangmanGames.delete(game.gameId);
    } else {
        embed.setFooter({ text: 'Use /hangman guess <letter> to guess | /hangman give-up to reveal' });
    }

    const method = interaction.replied ? 'followUp' : interaction.deferred ? 'editReply' : 'reply';
    await interaction[method]({ embeds: [embed] });
}

export async function handleStats(interaction) {
    const targetUser = interaction.options.getUser('user') || interaction.user;

    const [[stats]] = await pool.execute(
        "SELECT * FROM game_stats WHERE guild_id = ? AND user_id = ? AND game_type = 'hangman'",
        [interaction.guild.id, targetUser.id]
    );

    if (!stats) {
        return interaction.reply({
            content: targetUser.id === interaction.user.id
                ? "❌ You haven't played any hangman games yet! Use `/hangman start` to begin."
                : `❌ ${targetUser.username} hasn't played any hangman games yet.`,
            ephemeral: true
        });
    }

    const winRate = stats.games_played > 0 ? Math.round((stats.games_won / stats.games_played) * 100) : 0;
    const avgScore = stats.games_played > 0 ? Math.round(stats.total_score / stats.games_played) : 0;

    const embed = new EmbedBuilder()
        .setColor('#3498db')
        .setTitle(`🎯 Hangman Statistics - ${targetUser.username}`)
        .setThumbnail(targetUser.displayAvatarURL())
        .addFields(
            { name: '🎮 Games Played', value: `${stats.games_played}`, inline: true },
            { name: '🏆 Games Won', value: `${stats.games_won}`, inline: true },
            { name: '❌ Games Lost', value: `${stats.games_lost}`, inline: true },
            { name: '💯 Win Rate', value: `${winRate}%`, inline: true },
            { name: '💰 Total Score', value: `${stats.total_score.toLocaleString()}`, inline: true },
            { name: '⭐ Best Score', value: `${stats.best_score}`, inline: true },
            { name: '📊 Avg Score', value: `${avgScore}`, inline: true },
            { name: '🔥 Current Streak', value: `${stats.current_streak}`, inline: true },
            { name: '🏅 Best Streak', value: `${stats.best_streak}`, inline: true }
        )
        .setFooter({ text: `Last played: ${new Date(stats.last_played).toLocaleDateString()}` })
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

export function isWordComplete(game) {
    for (const letter of game.word) {
        if (letter !== ' ' && !game.guessedLetters.has(letter)) {
            return false;
        }
    }
    return true;
}

export function calculateScore(game) {
    const baseScore = 100;
    const difficultyMultiplier = { easy: 1, medium: 1.5, hard: 2 }[game.difficulty] || 1;
    const livesBonus = (game.maxWrongGuesses - game.wrongGuesses) * 20;
    const timeBonus = Math.max(0, 300 - Math.floor((Date.now() - game.startTime) / 1000)) * 2;

    return Math.floor((baseScore + livesBonus + timeBonus) * difficultyMultiplier);
}

export async function updateHangmanStats(game, won) {
    try {
        const score = won ? calculateScore(game) : 0;
        const duration = Math.floor((Date.now() - game.startTime) / 1000);

        // Get or create game stats
        const [[stats]] = await pool.execute(
            "SELECT * FROM game_stats WHERE guild_id = ? AND user_id = ? AND game_type = 'hangman'",
            [game.guildId, game.userId]
        );

        if (stats) {
            const newStreak = won ? stats.current_streak + 1 : 0;

            await pool.execute(
                `UPDATE game_stats
                 SET games_played = games_played + 1,
                     games_won = games_won + ?,
                     games_lost = games_lost + ?,
                     total_score = total_score + ?,
                     best_score = GREATEST(best_score, ?),
                     current_streak = ?,
                     best_streak = GREATEST(best_streak, ?),
                     last_played = NOW()
                 WHERE guild_id = ? AND user_id = ? AND game_type = 'hangman'`,
                [won ? 1 : 0, won ? 0 : 1, score, score, newStreak, newStreak, game.guildId, game.userId]
            );
        } else {
            await pool.execute(
                `INSERT INTO game_stats (guild_id, user_id, game_type, games_played, games_won, games_lost, total_score, best_score, current_streak, best_streak)
                 VALUES (?, ?, 'hangman', 1, ?, ?, ?, ?, ?, ?)`,
                [game.guildId, game.userId, won ? 1 : 0, won ? 0 : 1, score, score, won ? 1 : 0, won ? 1 : 0]
            );
        }

        // Log game history
        await pool.execute(
            `INSERT INTO game_history (guild_id, user_id, game_type, result, score, duration, game_data)
             VALUES (?, ?, 'hangman', ?, ?, ?, ?)`,
            [
                game.guildId,
                game.userId,
                won ? 'win' : 'loss',
                score,
                duration,
                JSON.stringify({ word: game.word, difficulty: game.difficulty, wrongGuesses: game.wrongGuesses })
            ]
        );

        // Check for economy rewards
        if (won) {
            const [[economyConfig]] = await pool.execute(
                'SELECT enabled FROM economy_config WHERE guild_id = ?',
                [game.guildId]
            );

            if (economyConfig && economyConfig.enabled) {
                const coinReward = Math.floor(score * 2);

                await pool.execute(
                    'UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ? WHERE guild_id = ? AND user_id = ?',
                    [coinReward, coinReward, game.guildId, game.userId]
                );

                const [[userEconomy]] = await pool.execute(
                    'SELECT wallet FROM user_economy WHERE guild_id = ? AND user_id = ?',
                    [game.guildId, game.userId]
                );

                if (userEconomy) {
                    await pool.execute(
                        `INSERT INTO economy_transactions (guild_id, user_id, transaction_type, amount, balance_before, balance_after, description)
                         VALUES (?, ?, 'reward', ?, ?, ?, ?)`,
                        [
                            game.guildId,
                            game.userId,
                            coinReward,
                            userEconomy.wallet - coinReward,
                            userEconomy.wallet,
                            `Hangman game reward (${score} points)`
                        ]
                    );
                }
            }
        }

    } catch (error) {
        logger.error('[Hangman] Error updating stats:', { error: error.message });
    }
}

export { activeHangmanGames };
