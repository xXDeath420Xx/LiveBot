import { EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';

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

export async function handleStart(interaction) {
    const rounds = interaction.options.getInteger('rounds') || 5;
    await interaction.deferReply();

    try {
        const [[activeSession]] = await pool.execute(
            'SELECT * FROM music_quiz_sessions WHERE guild_id = ? AND channel_id = ? AND status = "active"',
            [interaction.guild.id, interaction.channel.id]
        );

        if (activeSession) {
            return interaction.editReply({ content: '❌ There is already an active music quiz in this channel!' });
        }

        const [result] = await pool.execute(
            `INSERT INTO music_quiz_sessions (guild_id, channel_id, host_id, total_rounds, status, started_at)
             VALUES (?, ?, ?, ?, 'active', NOW())`,
            [interaction.guild.id, interaction.channel.id, interaction.user.id, rounds]
        );

        const sessionId = result.insertId;

        const embed = new EmbedBuilder()
            .setColor('#ED4245')
            .setTitle('🎵 Music Quiz Starting!')
            .setDescription(`Get ready for ${rounds} rounds of music trivia!\n\nType your answers in chat. First correct answer wins points!`)
            .addFields(
                { name: 'Rounds', value: rounds.toString(), inline: true },
                { name: 'Host', value: interaction.user.username, inline: true }
            )
            .setFooter({ text: 'Quiz starting in 5 seconds...' });

        await interaction.editReply({ embeds: [embed] });

        setTimeout(async () => {
            for (let round = 1; round <= rounds; round++) {
                const song = QUIZ_SONGS[Math.floor(Math.random() * QUIZ_SONGS.length)];

                const roundEmbed = new EmbedBuilder()
                    .setColor('#FEE75C')
                    .setTitle(`🎵 Round ${round}/${rounds}`)
                    .setDescription(`**Guess the song!**\n\nHints:\n${song.hints.map((h, i) => `${i + 1}. ${h}`).join('\n')}`)
                    .setFooter({ text: 'Type your answer in chat! (30 seconds)' });

                await interaction.channel.send({ embeds: [roundEmbed] });
                await new Promise(resolve => setTimeout(resolve, 30000));

                const answerEmbed = new EmbedBuilder()
                    .setColor('#57F287')
                    .setTitle('✅ Answer')
                    .setDescription(`**${song.song}** by **${song.artist}**`);

                await interaction.channel.send({ embeds: [answerEmbed] });

                await pool.execute('UPDATE music_quiz_sessions SET current_round = ? WHERE id = ?', [round, sessionId]);

                if (round < rounds) {
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
            }

            await pool.execute(
                'UPDATE music_quiz_sessions SET status = "completed", ended_at = NOW() WHERE id = ?',
                [sessionId]
            );

            const endEmbed = new EmbedBuilder()
                .setColor('#5865F2')
                .setTitle('🏁 Music Quiz Completed!')
                .setDescription('Thanks for playing! Check the leaderboard with `/arcade musicquiz leaderboard`');

            await interaction.channel.send({ embeds: [endEmbed] });
        }, 5000);

    } catch (error) {
        console.error('[Music Quiz Command Error]', error);
        const replyMethod = interaction.deferred ? 'editReply' : 'reply';
        return interaction[replyMethod]({ content: '❌ An error occurred with the music quiz.', ephemeral: true });
    }
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
            .setColor('#FFD700')
            .setTitle('🏆 Music Quiz Leaderboard')
            .setTimestamp();

        const leaderboardText = await Promise.all(
            topPlayers.map(async (player, index) => {
                const user = await interaction.client.users.fetch(player.user_id).catch(() => null);
                const username = user ? user.username : 'Unknown';
                const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `**${index + 1}.**`;

                return `${medal} **${username}**\n└ ${player.total_score} points | ${player.total_correct} correct`;
            })
        );

        embed.setDescription(leaderboardText.join('\n\n'));

        return interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[Music Quiz Command Error]', error);
        const replyMethod = interaction.deferred ? 'editReply' : 'reply';
        return interaction[replyMethod]({ content: '❌ An error occurred with the music quiz.', ephemeral: true });
    }
}
