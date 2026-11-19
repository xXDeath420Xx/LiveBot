import { EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { displayNameFor } from '../../utils/display-name.js';
import { themeColor } from '../../core/guild-theme.js';
import { updateChallengeProgress } from '../../core/daily-challenges-manager.js';
import { getConfig as getFeatureConfig } from '../../core/feature-config.js';

const QUIZ_SONGS = [
    { artist: 'The Beatles', song: 'Hey Jude', hints: ['British band', '1968', 'Paul McCartney'] },
    { artist: 'Queen', song: 'Bohemian Rhapsody', hints: ['6 minutes long', 'Freddie Mercury', 'Opera section'] },
    { artist: 'Michael Jackson', song: 'Billie Jean', hints: ['Thriller album', 'Moonwalk', '1982'] },
    { artist: 'Nirvana', song: 'Smells Like Teen Spirit', hints: ['Grunge', '1991', 'Seattle'] },
    { artist: 'Led Zeppelin', song: 'Stairway to Heaven', hints: ['8 minutes', 'Jimmy Page', '1971'] },
    { artist: 'Pink Floyd', song: 'Wish You Were Here', hints: ['1975', 'Progressive rock', 'Syd Barrett'] },
    { artist: 'AC/DC', song: 'Back in Black', hints: ['1980', 'Hard rock', 'Brian Johnson'] },
    { artist: 'Guns N Roses', song: 'Sweet Child O Mine', hints: ['Slash guitar solo', '1987', 'Appetite for Destruction'] },
    { artist: 'Metallica', song: 'Enter Sandman', hints: ['Black Album', '1991', 'Thrash metal'] },
    { artist: 'Radiohead', song: 'Creep', hints: ['1992', 'Alternative rock', 'Thom Yorke'] }
];

const START_DELAY_MS = 5000;
const ROUND_MS = 30000;
const BETWEEN_ROUNDS_MS = 3000;
const BASE_POINTS = 10;       // per correct answer
const MAX_SPEED_BONUS = 10;   // +1 for every full 3 seconds left on the round clock

// Quizzes running in THIS process: channel id -> session id (null while the session is being
// created). The bot runs as a single process, so a music_quiz_sessions row still marked 'active'
// that is not in this map was orphaned by a restart and is safe to close.
const runningQuizzes = new Map();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function shuffle(items) {
    for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
}

/** Lower-case, strip accents/apostrophes/punctuation and collapse spaces, for answer matching. */
export function normalizeAnswer(text) {
    return String(text ?? '')
        .toLowerCase()
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/['’`]/g, '')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/**
 * True when a chat message names the song: the title on its own, or the title with a little
 * around it ("bohemian rhapsody by queen"). Case/punctuation-insensitive; whole words only, and a
 * message much longer than the title (a list of guesses) does not count.
 */
export function isCorrectAnswer(guess, title) {
    const answer = normalizeAnswer(title);
    const said = normalizeAnswer(guess);
    if (!answer || !said) return false;
    if (said === answer) return true;
    return said.length <= answer.length + 30 && ` ${said} `.includes(` ${answer} `);
}

/**
 * Close sessions still marked 'active' that no quiz in this process is running (left behind when
 * the bot restarted mid-quiz, which used to block the channel forever). Safe to call at any time;
 * handleStart runs it for its own channel, and startup can run it with no arguments to tidy up.
 */
export async function closeStaleMusicQuizSessions(guildId = null, channelId = null) {
    const live = [...runningQuizzes.values()].filter(id => id != null);
    let sql = "UPDATE music_quiz_sessions SET status = 'abandoned', ended_at = NOW() WHERE status = 'active'";
    const params = [];
    if (guildId) { sql += ' AND guild_id = ?'; params.push(guildId); }
    if (channelId) { sql += ' AND channel_id = ?'; params.push(channelId); }
    if (live.length > 0) {
        sql += ` AND id NOT IN (${live.map(() => '?').join(', ')})`;
        params.push(...live);
    }
    const [result] = await pool.execute(sql, params);
    if (result.affectedRows > 0) {
        logger.info('[MusicQuiz] Closed stale active sessions', { count: result.affectedRows, guildId, channelId });
    }
    return result.affectedRows;
}

async function endSession(sessionId, status) {
    if (!sessionId) return;
    try {
        await pool.execute(
            'UPDATE music_quiz_sessions SET status = ?, ended_at = NOW() WHERE id = ?',
            [status, sessionId]
        );
    } catch (error) {
        logger.error('[MusicQuiz] Failed to close session', { error: error.message, sessionId, status });
    }
}

async function recordCorrectAnswer(sessionId, userId, points, elapsedMs) {
    try {
        await pool.execute(
            `INSERT INTO music_quiz_scores (session_id, user_id, score, correct_answers, fastest_answer_time)
             VALUES (?, ?, ?, 1, ?)
             ON DUPLICATE KEY UPDATE
                 score = score + VALUES(score),
                 correct_answers = correct_answers + 1,
                 fastest_answer_time = LEAST(COALESCE(fastest_answer_time, VALUES(fastest_answer_time)), VALUES(fastest_answer_time))`,
            [sessionId, userId, points, elapsedMs]
        );
    } catch (error) {
        logger.error('[MusicQuiz] Failed to save score', { error: error.message, sessionId, userId });
    }
}

/**
 * Collect chat for one round. Resolves with the first message that names the song, or null when
 * the round times out. Everyone who types during the round is added to `participants`.
 */
function waitForAnswer(channel, title, timeMs, participants) {
    return new Promise(resolve => {
        let winner = null;
        const collector = channel.createMessageCollector({ filter: m => !m.author.bot, time: timeMs });
        collector.on('collect', message => {
            participants.add(message.author.id);
            if (!winner && isCorrectAnswer(message.content, title)) {
                winner = message;
                collector.stop('answered');
            }
        });
        collector.on('end', () => resolve(winner));
    });
}

async function runQuiz({ channel, guildId, hostId, sessionId, rounds }) {
    const songs = shuffle([...QUIZ_SONGS]);
    const tally = new Map(); // userId -> { score, correct, fastestMs }
    const participants = new Set([hostId]);
    let status = 'completed';

    try {
        for (let round = 1; round <= rounds; round++) {
            const song = songs[(round - 1) % songs.length];

            const roundEmbed = new EmbedBuilder()
                .setColor('#FEE75C')
                .setTitle(`🎵 Round ${round}/${rounds}`)
                .setDescription(`**Guess the song!**\n\nHints:\n${song.hints.map((h, i) => `${i + 1}. ${h}`).join('\n')}`)
                .setFooter({ text: 'Type the song title in chat! (30 seconds)' });

            await channel.send({ embeds: [roundEmbed] });
            const roundStart = Date.now();

            const winner = await waitForAnswer(channel, song.song, ROUND_MS, participants);

            const answerEmbed = new EmbedBuilder()
                .setColor(themeColor(guildId, 'success'))
                .setTitle('✅ Answer')
                .setDescription(`**${song.song}** by **${song.artist}**`);

            if (winner) {
                const elapsedMs = Math.max(0, winner.createdTimestamp - roundStart);
                const speedBonus = Math.min(MAX_SPEED_BONUS, Math.floor(Math.max(0, ROUND_MS - elapsedMs) / 3000));
                const points = BASE_POINTS + speedBonus;

                const entry = tally.get(winner.author.id) || { score: 0, correct: 0, fastestMs: elapsedMs };
                entry.score += points;
                entry.correct += 1;
                entry.fastestMs = Math.min(entry.fastestMs, elapsedMs);
                tally.set(winner.author.id, entry);

                await recordCorrectAnswer(sessionId, winner.author.id, points, elapsedMs);
                winner.react('✅').catch(() => {});
                answerEmbed.addFields({
                    name: 'Winner',
                    value: `<@${winner.author.id}> got it in ${(elapsedMs / 1000).toFixed(1)}s (+${points} points)`
                });
            } else {
                answerEmbed.addFields({ name: 'Winner', value: 'Nobody got it this time!' });
            }

            await channel.send({ embeds: [answerEmbed], allowedMentions: { parse: [] } });

            await pool.execute('UPDATE music_quiz_sessions SET current_round = ? WHERE id = ?', [round, sessionId])
                .catch(err => logger.warn('[MusicQuiz] Failed to update round', { error: err.message, sessionId, round }));

            if (round < rounds) {
                await sleep(BETWEEN_ROUNDS_MS);
            }
        }
    } catch (error) {
        status = 'cancelled';
        logger.error('[MusicQuiz] Quiz stopped early', { error: error.message, sessionId, guildId, channelId: channel.id });
    } finally {
        runningQuizzes.delete(channel.id);
        await endSession(sessionId, status);
    }

    if (status !== 'completed') {
        await channel.send({ content: '⚠️ The music quiz stopped early because of an error. Points already won were saved.' })
            .catch(() => {});
        return;
    }

    // Daily challenges: everyone who took part (host + anyone who answered in chat)
    for (const userId of participants) {
        updateChallengeProgress(guildId, userId, 'games', 1).catch(err =>
            logger.warn('[MusicQuiz] Daily challenge progress failed', { error: err.message, guildId, userId }));
    }

    const standings = [...tally.entries()].sort((a, b) => b[1].score - a[1].score || b[1].correct - a[1].correct);
    const endEmbed = new EmbedBuilder()
        .setColor(themeColor(guildId, 'primary'))
        .setTitle('🏁 Music Quiz Completed!')
        .setFooter({ text: `${BASE_POINTS} points per correct answer + up to ${MAX_SPEED_BONUS} for speed` });

    if (standings.length === 0) {
        endEmbed.setDescription('Nobody named a song this time! Check the all-time leaderboard with `/arcade musicquiz leaderboard`');
    } else {
        const medals = ['🥇', '🥈', '🥉'];
        const lines = standings.slice(0, 10).map(([userId, s], i) =>
            `${medals[i] || `**${i + 1}.**`} <@${userId}> — **${s.score}** points (${s.correct}/${rounds} correct, fastest ${(s.fastestMs / 1000).toFixed(1)}s)`);
        endEmbed.setDescription(`**Final standings**\n${lines.join('\n')}\n\nAll-time scores: \`/arcade musicquiz leaderboard\``);
    }

    await channel.send({ embeds: [endEmbed], allowedMentions: { parse: [] } })
        .catch(err => logger.warn('[MusicQuiz] Failed to post summary', { error: err.message, sessionId }));
}

/** The page's default rounds, within 1..QUIZ_SONGS.length (every round a different song). Pure. */
export function defaultQuizRounds(cfg) {
    const n = Math.trunc(Number(cfg?.musicquiz_rounds));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, QUIZ_SONGS.length) : 5;
}

/** The page's music quiz channel when it is set and the bot can run a quiz there (post + read chat). */
function configuredQuizChannel(interaction, cfg) {
    const id = cfg?.musicquiz_channel_id ? String(cfg.musicquiz_channel_id) : null;
    if (!id) return null;
    const ch = interaction.guild.channels.cache.get(id);
    const me = interaction.guild.members.me;
    const perms = ch?.isTextBased?.() && me ? ch.permissionsFor(me) : null;
    return perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory]) ? ch : null;
}

export async function handleStart(interaction) {
    // LFG & Music Quiz page: quizzes run in the music quiz channel when one is set (answers are read
    // from that channel's chat), and the default number of rounds.
    const cfg = await getFeatureConfig('arcade', interaction.guildId);
    const rounds = interaction.options.getInteger('rounds') || defaultQuizRounds(cfg);
    const quizChannel = configuredQuizChannel(interaction, cfg);
    const channel = quizChannel || interaction.channel;
    const elsewhere = channel.id !== interaction.channelId;
    const guildId = interaction.guild.id;
    await interaction.deferReply({ ephemeral: elsewhere });

    if (runningQuizzes.has(channel.id)) {
        return interaction.editReply({ content: elsewhere
            ? `❌ There is already an active music quiz in <#${channel.id}>!`
            : '❌ There is already an active music quiz in this channel!' });
    }
    runningQuizzes.set(channel.id, null); // reserve the channel before any further await

    let sessionId = null;
    try {
        // Anything still 'active' for this channel was orphaned by a restart: nothing here runs it.
        await closeStaleMusicQuizSessions(guildId, channel.id);

        const [result] = await pool.execute(
            `INSERT INTO music_quiz_sessions (guild_id, channel_id, host_id, total_rounds, status, started_at)
             VALUES (?, ?, ?, ?, 'active', NOW())`,
            [guildId, channel.id, interaction.user.id, rounds]
        );

        sessionId = result.insertId;
        runningQuizzes.set(channel.id, sessionId);

        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'danger'))
            .setTitle('🎵 Music Quiz Starting!')
            .setDescription(`Get ready for ${rounds} rounds of music trivia!\n\nType your answers in chat. First correct answer wins points!`)
            .addFields(
                { name: 'Rounds', value: rounds.toString(), inline: true },
                { name: 'Host', value: displayNameFor(interaction.user, interaction.guild), inline: true }
            )
            .setFooter({ text: 'Quiz starting in 5 seconds...' });

        if (elsewhere) {
            await channel.send({ embeds: [embed] });
            await interaction.editReply({ content: `🎵 The music quiz is starting in <#${channel.id}>. Answer there!` });
        } else {
            await interaction.editReply({ embeds: [embed] });
        }
    } catch (error) {
        runningQuizzes.delete(channel.id);
        await endSession(sessionId, 'cancelled');
        logger.error('[MusicQuiz] Failed to start quiz', { error: error.message, guildId, channelId: channel.id });
        return interaction.editReply({ content: '❌ An error occurred with the music quiz.' }).catch(() => {});
    }

    setTimeout(() => {
        runQuiz({ channel, guildId, hostId: interaction.user.id, sessionId, rounds })
            .catch(err => logger.error('[MusicQuiz] Quiz loop crashed', { error: err.message, sessionId }));
    }, START_DELAY_MS);
}

export async function handleLeaderboard(interaction) {
    await interaction.deferReply();

    try {
        const [topPlayers] = await pool.execute(
            `SELECT user_id, SUM(score) as total_score, SUM(correct_answers) as total_correct
             FROM music_quiz_scores
             WHERE session_id IN (SELECT id FROM music_quiz_sessions WHERE guild_id = ?)
             GROUP BY user_id
             ORDER BY total_score DESC
             LIMIT 10`,
            [interaction.guild.id]
        );

        if (topPlayers.length === 0) {
            return interaction.editReply({ content: 'No quiz scores yet! Start a quiz with `/arcade musicquiz start`' });
        }

        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'warning'))
            .setTitle('🏆 Music Quiz Leaderboard')
            .setTimestamp();

        const leaderboardText = await Promise.all(
            topPlayers.map(async (player, index) => {
                const user = await interaction.client.users.fetch(player.user_id).catch(() => null);
                const username = displayNameFor(user, interaction.guild);
                const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `**${index + 1}.**`;

                return `${medal} **${username}**\n└ ${Number(player.total_score)} points | ${Number(player.total_correct)} correct`;
            })
        );

        embed.setDescription(leaderboardText.join('\n\n'));

        return interaction.editReply({ embeds: [embed] });
    } catch (error) {
        logger.error('[MusicQuiz] Leaderboard failed', { error: error.message, guildId: interaction.guild?.id });
        const replyMethod = interaction.deferred ? 'editReply' : 'reply';
        return interaction[replyMethod]({ content: '❌ An error occurred with the music quiz.', ephemeral: true });
    }
}
