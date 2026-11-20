import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../utils/db.js';
import logger from '../utils/logger.js';
import * as opentdb from '../utils/opentdb.js';
import { displayNameFor } from '../utils/display-name.js';
import { themeColor } from './guild-theme.js';
import { updateChallengeProgress } from './daily-challenges-manager.js';

// Store active trivia sessions
const activeTriviaGames = new Map();

// Daily-challenge progress is fire-and-forget: a failure there must never break the game.
function trackChallenge(guildId, userId, challengeType) {
    updateChallengeProgress(guildId, userId, challengeType, 1).catch(err =>
        logger.warn('[Trivia] Daily challenge progress failed', { error: err.message, guildId, userId, challengeType }));
}

export async function handleStart(interaction) {
    const category = interaction.options.getString('category') || 'random';
    const difficulty = interaction.options.getString('difficulty');
    const questionCount = interaction.options.getInteger('questions') || 5;

    // Check if user already has an active game
    const existingGame = Array.from(activeTriviaGames.values()).find(
        game => game.userId === interaction.user.id && game.guildId === interaction.guild.id
    );

    if (existingGame) {
        return interaction.reply({
            content: '❌ You already have an active trivia game! Finish it first or wait for it to expire.',
            ephemeral: true
        });
    }

    await interaction.deferReply();

    // Build query to get questions: the shared bank plus this server's own (migration 261)
    let query = 'SELECT * FROM trivia_questions WHERE (guild_id IS NULL OR guild_id = ?)';
    const params = [interaction.guild.id];

    if (category !== 'random') {
        query += ' AND category = ?';
        params.push(category);
    }

    if (difficulty) {
        query += ' AND difficulty = ?';
        params.push(difficulty);
    }

    query += ' ORDER BY RAND() LIMIT ?';
    params.push(questionCount);

    let [questions] = await pool.execute(query, params);

    // Not enough local questions: top up from OpenTDB, keeping the local (incl. this server's) ones
    if (questions.length < questionCount) {
        const needed = questionCount - questions.length;
        try {
            logger.info(`[Trivia] Fetching ${needed} questions from OpenTDB (category: ${category}, difficulty: ${difficulty})`);

            const openTdbQuestions = await opentdb.fetchQuestions({
                category: category,
                difficulty: difficulty,
                amount: needed,
                type: 'multiple'
            });

            // Transform OpenTDB questions to match local format
            const transformedQuestions = openTdbQuestions.map(q => ({
                question: q.question,
                correct_answer: q.correct_answer,
                incorrect_answers: JSON.stringify(q.incorrect_answers), // Store as JSON string
                category: category,
                difficulty: q.difficulty || difficulty || 'medium',
                points_value: q.difficulty === 'easy' ? 10 : q.difficulty === 'hard' ? 30 : 20
            }));

            questions = [...questions, ...transformedQuestions].slice(0, questionCount);
            shuffleArray(questions);

        } catch (error) {
            logger.error('[Trivia] Error fetching from OpenTDB:', { error: error.message });
            // If we have some local questions, use them even if we couldn't get OpenTDB ones
        }
    }

    if (questions.length === 0) {
        return interaction.editReply({
            content: '❌ No trivia questions found. Please try again later.'
        });
    }

    // Initialize game session
    const gameId = `${interaction.guild.id}-${interaction.user.id}-${Date.now()}`;
    const gameSession = {
        gameId,
        userId: interaction.user.id,
        guildId: interaction.guild.id,
        channelId: interaction.channel.id,
        questions,
        currentQuestion: 0,
        score: 0,
        correctAnswers: 0,
        startTime: Date.now(),
        category,
        difficulty: difficulty || 'mixed'
    };

    activeTriviaGames.set(gameId, gameSession);

    // Send first question
    await sendQuestion(interaction, gameId);

    // Set timeout to auto-end game after 5 minutes of inactivity
    setTimeout(() => {
        if (activeTriviaGames.has(gameId)) {
            activeTriviaGames.delete(gameId);
        }
    }, 5 * 60 * 1000);
}

export async function sendQuestion(interaction, gameId) {
    const game = activeTriviaGames.get(gameId);
    if (!game) return;

    const question = game.questions[game.currentQuestion];
    if (!question) {
        // Game completed
        return endGame(interaction, gameId);
    }

    // Prepare answers (shuffle correct and incorrect)
    const allAnswers = [question.correct_answer, ...JSON.parse(question.incorrect_answers)];
    shuffleArray(allAnswers);
    // Buttons carry the answer's index, not its text: custom ids are capped at 100 chars, and a
    // long (e.g. server-written) answer would otherwise make the whole question fail to send.
    game.currentAnswers = allAnswers;

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'primary'))
        .setTitle(`🧠 Trivia Question ${game.currentQuestion + 1}/${game.questions.length}`)
        .setDescription(question.question)
        .addFields(
            { name: '📚 Category', value: getCategoryDisplay(question.category), inline: true },
            { name: '⚡ Difficulty', value: getDifficultyDisplay(question.difficulty), inline: true },
            { name: '💰 Points', value: `${question.points_value}`, inline: true }
        )
        .setFooter({ text: `Score: ${game.score} | Correct: ${game.correctAnswers}/${game.currentQuestion}` })
        .setTimestamp();

    // Create buttons for answers
    const buttons = new ActionRowBuilder();
    const answerEmojis = ['🇦', '🇧', '🇨', '🇩'];

    allAnswers.forEach((answer, index) => {
        buttons.addComponents(
            new ButtonBuilder()
                .setCustomId(`trivia_answer_${gameId}_${game.currentQuestion}_${index}`)
                .setLabel(`${String.fromCharCode(65 + index)}. ${answer.length > 50 ? answer.substring(0, 50) + '...' : answer}`)
                .setStyle(ButtonStyle.Primary)
                .setEmoji(answerEmojis[index])
        );
    });

    const method = interaction.deferred ? 'editReply' : 'reply';
    await interaction[method]({
        embeds: [embed],
        components: [buttons]
    });
}

export async function endGame(interaction, gameId) {
    const game = activeTriviaGames.get(gameId);
    if (!game) return;

    activeTriviaGames.delete(gameId);

    const duration = Math.floor((Date.now() - game.startTime) / 1000);
    const accuracy = game.questions.length > 0 ? Math.round((game.correctAnswers / game.questions.length) * 100) : 0;

    // Daily challenges: the player took part; a win (same rule as game_stats below) also counts
    trackChallenge(game.guildId, game.userId, 'trivia');
    trackChallenge(game.guildId, game.userId, 'games');
    if (game.correctAnswers > game.questions.length / 2) {
        trackChallenge(game.guildId, game.userId, 'trivia_win');
    }

    // Update database stats
    let newAchievements = [];
    try {
        // Get or create game stats
        const [[stats]] = await pool.execute(
            "SELECT * FROM game_stats WHERE guild_id = ? AND user_id = ? AND game_type = 'trivia'",
            [game.guildId, game.userId]
        );

        if (stats) {
            const won = game.correctAnswers > game.questions.length / 2 ? 1 : 0;
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
                 WHERE guild_id = ? AND user_id = ? AND game_type = 'trivia'`,
                [won, won ? 0 : 1, game.score, game.score, newStreak, newStreak, game.guildId, game.userId]
            );
        } else {
            const won = game.correctAnswers > game.questions.length / 2 ? 1 : 0;
            await pool.execute(
                `INSERT INTO game_stats (guild_id, user_id, game_type, games_played, games_won, games_lost, total_score, best_score, current_streak, best_streak)
                 VALUES (?, ?, 'trivia', 1, ?, ?, ?, ?, ?, ?)`,
                [game.guildId, game.userId, won, won ? 0 : 1, game.score, game.score, won ? 1 : 0, won ? 1 : 0]
            );
        }

        // Log game history
        await pool.execute(
            `INSERT INTO game_history (guild_id, user_id, game_type, result, score, duration)
             VALUES (?, ?, 'trivia', ?, ?, ?)`,
            [
                game.guildId,
                game.userId,
                game.correctAnswers > game.questions.length / 2 ? 'win' : 'loss',
                game.score,
                duration
            ]
        );

        // Check for economy rewards
        const [[economyConfig]] = await pool.execute(
            'SELECT enabled FROM economy_config WHERE guild_id = ?',
            [game.guildId]
        );

        let economyReward = 0;
        if (economyConfig && economyConfig.enabled) {
            // Award coins based on score
            economyReward = Math.floor(game.score * 5);

            // A member who never used the economy has no row: make it, and only report coins that were paid (H-807).
            await pool.execute('INSERT IGNORE INTO user_economy (guild_id, user_id, wallet, bank) VALUES (?, ?, 0, 0)', [game.guildId, game.userId]);
            const [paid] = await pool.execute(
                'UPDATE user_economy SET wallet = wallet + ?, total_earned = total_earned + ? WHERE guild_id = ? AND user_id = ?',
                [economyReward, economyReward, game.guildId, game.userId]
            );
            if (!(paid?.affectedRows > 0)) economyReward = 0;

            const [[userEconomy]] = await pool.execute(
                'SELECT wallet FROM user_economy WHERE guild_id = ? AND user_id = ?',
                [game.guildId, game.userId]
            );

            if (userEconomy && economyReward > 0) {
                await pool.execute(
                    `INSERT INTO economy_transactions (guild_id, user_id, transaction_type, amount, balance_before, balance_after, description)
                     VALUES (?, ?, 'reward', ?, ?, ?, ?)`,
                    [
                        game.guildId,
                        game.userId,
                        economyReward,
                        userEconomy.wallet - economyReward,
                        userEconomy.wallet,
                        `Trivia game reward (${game.correctAnswers}/${game.questions.length} correct)`
                    ]
                );
            }
        }

        // Check for achievements (returns only the ones earned for the first time just now)
        newAchievements = await checkAchievements(game.guildId, game.userId, stats, game);

    } catch (error) {
        logger.error('[Trivia] Error updating stats:', { error: error.message });
    }

    // Create results embed
    const embed = new EmbedBuilder()
        .setColor(accuracy >= 70 ? '#00FF00' : accuracy >= 50 ? '#FFA500' : '#FF0000')
        .setTitle('🎯 Trivia Game Completed!')
        .setDescription(`Great job, <@${game.userId}>!`)
        .addFields(
            { name: '✅ Correct Answers', value: `${game.correctAnswers}/${game.questions.length}`, inline: true },
            { name: '💯 Accuracy', value: `${accuracy}%`, inline: true },
            { name: '💰 Final Score', value: `${game.score}`, inline: true },
            { name: '⏱️ Duration', value: `${duration}s`, inline: true }
        )
        .setTimestamp();

    if (economyReward > 0) {
        embed.addFields({ name: '🪙 Coins Earned', value: `+${economyReward.toLocaleString()}`, inline: true });
    }

    if (newAchievements.length) {
        embed.addFields({
            name: newAchievements.length === 1 ? 'Achievement unlocked' : 'Achievements unlocked',
            value: newAchievements.map(a => `**${a.name}** - ${a.description}`).join('\n'),
        });
    }

    // Performance message
    if (accuracy === 100) {
        embed.setDescription(`🏆 **PERFECT SCORE!** Excellent work, <@${game.userId}>!`);
    } else if (accuracy >= 80) {
        embed.setDescription(`⭐ **GREAT JOB!** You really know your stuff, <@${game.userId}>!`);
    } else if (accuracy >= 60) {
        embed.setDescription(`👍 **GOOD EFFORT!** Not bad, <@${game.userId}>!`);
    } else {
        embed.setDescription(`📚 **KEEP TRYING!** Practice makes perfect, <@${game.userId}>!`);
    }

    await interaction.editReply({
        embeds: [embed],
        components: []
    });
}

export async function handleStats(interaction) {
    const targetUser = interaction.options.getUser('user') || interaction.user;

    const [[stats]] = await pool.execute(
        "SELECT * FROM game_stats WHERE guild_id = ? AND user_id = ? AND game_type = 'trivia'",
        [interaction.guild.id, targetUser.id]
    );

    if (!stats) {
        return interaction.reply({
            content: targetUser.id === interaction.user.id
                ? "❌ You haven't played any trivia games yet! Use `/trivia start` to begin."
                : `❌ ${displayNameFor(targetUser, interaction.guild)} hasn't played any trivia games yet.`,
            ephemeral: true
        });
    }

    const winRate = stats.games_played > 0 ? Math.round((stats.games_won / stats.games_played) * 100) : 0;
    const avgScore = stats.games_played > 0 ? Math.round(stats.total_score / stats.games_played) : 0;

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'primary'))
        .setTitle(`🧠 Trivia Statistics - ${displayNameFor(targetUser, interaction.guild)}`)
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

    const achievements = await getTriviaAchievements(interaction.guild.id, targetUser.id);
    if (achievements.length) {
        embed.addFields({
            name: `Achievements (${achievements.length})`,
            value: achievements
                .map(a => `**${a.achievement_name}** - ${a.achievement_description || ''} (<t:${Math.floor(new Date(a.earned_at).getTime() / 1000)}:d>)`)
                .join('\n')
                .slice(0, 1024),
        });
    }

    await interaction.reply({ embeds: [embed] });
}

export async function handleLeaderboard(interaction) {
    const [topPlayers] = await pool.execute(
        `SELECT user_id, total_score, games_played, games_won, best_streak
         FROM game_stats
         WHERE guild_id = ? AND game_type = 'trivia'
         ORDER BY total_score DESC
         LIMIT 10`,
        [interaction.guild.id]
    );

    if (topPlayers.length === 0) {
        return interaction.reply({
            content: '❌ No trivia games have been played in this server yet!',
            ephemeral: true
        });
    }

    const embed = new EmbedBuilder()
        .setColor(themeColor(interaction.guildId, 'warning'))
        .setTitle('🏆 Trivia Leaderboard')
        .setDescription('Top 10 trivia masters in this server');

    let description = '';
    for (let i = 0; i < topPlayers.length; i++) {
        const player = topPlayers[i];
        const user = await interaction.client.users.fetch(player.user_id).catch(() => null);
        const username = displayNameFor(user, interaction.guild);
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        const winRate = player.games_played > 0 ? Math.round((player.games_won / player.games_played) * 100) : 0;

        description += `${medal} **${username}** - ${player.total_score.toLocaleString()} pts (${winRate}% WR, ${player.best_streak} streak)\n`;
    }

    embed.setDescription(description);
    embed.setFooter({ text: `Total players: ${topPlayers.length}` });

    await interaction.reply({ embeds: [embed] });
}

export async function checkAchievements(guildId, userId, oldStats, game) {
    try {
        const achievements = [];

        // Perfect Score Achievement
        if (game.correctAnswers === game.questions.length && game.questions.length >= 5) {
            achievements.push({
                type: 'trivia_perfect_score',
                name: '🎯 Perfect Score',
                description: `Answered all ${game.questions.length} questions correctly!`
            });
        }

        // Speed Demon Achievement
        const duration = Math.floor((Date.now() - game.startTime) / 1000);
        if (game.correctAnswers >= 5 && duration <= 30) {
            achievements.push({
                type: 'trivia_speed_demon',
                name: '⚡ Speed Demon',
                description: 'Completed 5+ questions in under 30 seconds!'
            });
        }

        // Streak Master Achievement — the streak including this game (endGame's won rule), so a
        // loss after a 10-game run does not award it.
        const wonThis = game.correctAnswers > game.questions.length / 2;
        const streakNow = wonThis ? (oldStats?.current_streak || 0) + 1 : 0;
        if (streakNow >= 10) {
            achievements.push({
                type: 'trivia_streak_master',
                name: '🔥 Streak Master',
                description: 'Won 10 trivia games in a row!'
            });
        }

        // Insert new achievements. INSERT IGNORE hits the (guild, user, type) unique key for
        // ones already held, so affectedRows tells us which were earned just now.
        const earned = [];
        for (const achievement of achievements) {
            const [result] = await pool.execute(
                `INSERT IGNORE INTO game_achievements (guild_id, user_id, achievement_type, achievement_name, achievement_description)
                 VALUES (?, ?, ?, ?, ?)`,
                [guildId, userId, achievement.type, achievement.name, achievement.description]
            );
            if (result?.affectedRows) earned.push(achievement);
        }
        return earned;
    } catch (error) {
        logger.error('[Trivia] Error checking achievements:', { error: error.message });
        return [];
    }
}

/** Trivia achievements a user holds in a guild, oldest first. */
export async function getTriviaAchievements(guildId, userId) {
    try {
        const [rows] = await pool.execute(
            `SELECT achievement_name, achievement_description, earned_at FROM game_achievements
              WHERE guild_id = ? AND user_id = ? AND achievement_type LIKE 'trivia\\_%'
              ORDER BY earned_at ASC`,
            [guildId, userId]
        );
        return rows;
    } catch (error) {
        logger.error('[Trivia] Error loading achievements:', { error: error.message });
        return [];
    }
}

export function getCategoryDisplay(category) {
    const categories = {
        'general': '🧠 General Knowledge',
        'science': '🔬 Science & Nature',
        'history': '📜 History',
        'geography': '🌍 Geography',
        'entertainment': '🎬 Entertainment',
        'sports': '⚽ Sports',
        'technology': '💻 Technology',
        'music': '🎵 Music',
        'art': '🎨 Art & Literature',
        'gaming': '🎮 Video Games'
    };
    return categories[category] || category;
}

export function getDifficultyDisplay(difficulty) {
    const difficulties = {
        'easy': '🌱 Easy',
        'medium': '⚡ Medium',
        'hard': '🔥 Hard'
    };
    return difficulties[difficulty] || difficulty;
}

export function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

// Handle button interactions
export async function handleButton(interaction) {
    if (!interaction.customId.startsWith('trivia_answer_')) return false;

    // trivia_answer_<gameId>_<questionIndex>_<answerIndex>
    const parts = interaction.customId.split('_');
    const gameId = parts[2];
    const questionIndex = Number(parts[3]);
    const answerIndex = Number(parts[4]);

    const game = activeTriviaGames.get(gameId);
    if (!game) {
        return interaction.reply({
            content: '❌ This trivia game has expired.',
            ephemeral: true
        });
    }

    if (interaction.user.id !== game.userId) {
        return interaction.reply({
            content: '❌ This is not your trivia game!',
            ephemeral: true
        });
    }

    if (questionIndex !== game.currentQuestion || game.awaitingNext) {
        return interaction.reply({
            content: '❌ You already answered that question.',
            ephemeral: true
        });
    }

    const question = game.questions[game.currentQuestion];
    const answer = game.currentAnswers?.[answerIndex];
    const correct = answer === question.correct_answer;
    game.awaitingNext = true;

    if (correct) {
        game.score += question.points_value;
        game.correctAnswers++;
    }

    // Send feedback
    const feedbackEmbed = new EmbedBuilder()
        .setColor(correct ? '#00FF00' : '#FF0000')
        .setTitle(correct ? '✅ Correct!' : '❌ Incorrect!')
        .setDescription(correct
            ? `**+${question.points_value} points!**`
            : `The correct answer was: **${question.correct_answer}**`)
        .setFooter({ text: `Score: ${game.score}` });

    // Acknowledge the click by deferring an update of the question message, then send the
    // feedback privately. Deferring (rather than replying) is what lets sendQuestion/endGame
    // editReply that same message with the next question or the results; replying here made
    // the next sendQuestion call reply() a second time and throw, so games stalled after Q1.
    await interaction.deferUpdate();
    await interaction.followUp({
        embeds: [feedbackEmbed],
        ephemeral: true
    });

    // Move to next question
    game.currentQuestion++;

    setTimeout(async () => {
        game.awaitingNext = false;
        try {
            await sendQuestion(interaction, gameId);
        } catch (error) {
            logger.error('[Trivia] Error sending next question', { error: error.message, gameId });
        }
    }, 2000);

    return true;
}

export { activeTriviaGames };
