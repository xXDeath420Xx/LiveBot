import { EmbedBuilder } from 'discord.js';
import pool from '../../../utils/db.js';

export async function execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
        case 'affirmation':
            return handleAffirmation(interaction);
        case 'mood':
            return handleMoodTrack(interaction);
        case 'moodstats':
            return handleMoodStats(interaction);
        case 'breathe':
            return handleBreathe(interaction);
        case 'pomodoro':
            return handlePomodoro(interaction);
        case 'pomostat':
            return handlePomodoroStats(interaction);
    }
}

async function handleAffirmation(interaction) {
    const category = interaction.options.getString('category') || 'general';

    const affirmations = {
        general: [
            "I am capable of achieving my goals.",
            "Every day is a new opportunity to grow.",
            "I choose to focus on the positive.",
            "I am exactly where I need to be.",
            "My potential is limitless.",
            "I embrace challenges as opportunities to learn.",
            "I am worthy of good things.",
            "Progress, not perfection, is what matters.",
            "I trust the journey of my life.",
            "I am becoming the best version of myself."
        ],
        confidence: [
            "I believe in myself and my abilities.",
            "I am confident in my decisions.",
            "I trust my instincts and intuition.",
            "I am strong, capable, and resilient.",
            "My confidence grows with every challenge I overcome.",
            "I radiate confidence and positive energy.",
            "I am proud of who I am becoming.",
            "My voice matters and deserves to be heard.",
            "I embrace my uniqueness and authentic self.",
            "I face my fears with courage and determination."
        ],
        success: [
            "I am committed to my success and growth.",
            "Opportunities for success are everywhere.",
            "I attract success through my positive actions.",
            "My hard work is paying off.",
            "I am focused and dedicated to achieving my dreams.",
            "Success flows to me naturally and easily.",
            "I am creating the life I desire.",
            "Every step forward is a step toward success.",
            "I celebrate my achievements, big and small.",
            "My success inspires others to succeed."
        ],
        love: [
            "I am worthy of love and belonging.",
            "I give and receive love freely.",
            "Love surrounds me in all its forms.",
            "I attract healthy and loving relationships.",
            "I am deserving of kindness and compassion.",
            "My heart is open to giving and receiving love.",
            "I radiate love and others reflect love back to me.",
            "I am enough just as I am.",
            "Love and acceptance flow through my life.",
            "I treat myself with love and respect."
        ],
        health: [
            "My body is healthy, vibrant, and strong.",
            "I make healthy choices for my body and mind.",
            "I am grateful for my body and all it does for me.",
            "Every cell in my body vibrates with energy and health.",
            "I prioritize rest and self-care.",
            "I listen to my body's needs with compassion.",
            "I am committed to my physical and mental wellbeing.",
            "Healthy eating and exercise come naturally to me.",
            "I deserve to feel good in my body.",
            "I am healing and growing stronger every day."
        ],
        gratitude: [
            "I am grateful for all the blessings in my life.",
            "Gratitude fills my heart and transforms my day.",
            "I appreciate the simple joys around me.",
            "I am thankful for this moment and this day.",
            "Every experience teaches me something valuable.",
            "I am blessed with amazing people in my life.",
            "Gratitude opens the door to abundance.",
            "I focus on what I have, not what I lack.",
            "I am grateful for the opportunity to grow.",
            "Thank you for another day of possibilities."
        ]
    };

    const categoryAffirmations = affirmations[category];
    const randomAffirmation = categoryAffirmations[Math.floor(Math.random() * categoryAffirmations.length)];

    const categoryEmojis = {
        general: '✨',
        confidence: '💪',
        success: '🎯',
        love: '💝',
        health: '🌿',
        gratitude: '🙏'
    };

    const embed = new EmbedBuilder()
        .setColor('#9B59B6')
        .setTitle(`${categoryEmojis[category]} Daily Affirmation`)
        .setDescription(`**${randomAffirmation}**`)
        .addFields({
            name: '📝 Practice',
            value: 'Read this affirmation aloud or silently. Take three deep breaths and let it resonate with you.',
            inline: false
        })
        .setFooter({ text: `Category: ${category.charAt(0).toUpperCase() + category.slice(1)} • Repeat as needed throughout your day` })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function handleMoodTrack(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const feeling = interaction.options.getString('feeling');
    const note = interaction.options.getString('note');
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    try {
        // Create mood tracking table if it doesn't exist
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS wellness_mood_tracking (
                id INT AUTO_INCREMENT PRIMARY KEY,
                guild_id VARCHAR(20) NOT NULL,
                user_id VARCHAR(20) NOT NULL,
                mood VARCHAR(20) NOT NULL,
                note TEXT,
                tracked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_user_date (guild_id, user_id, tracked_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        // Insert mood entry
        await pool.execute(
            'INSERT INTO wellness_mood_tracking (guild_id, user_id, mood, note) VALUES (?, ?, ?, ?)',
            [guildId, userId, feeling, note]
        );

        const moodEmojis = {
            great: '😊',
            good: '🙂',
            okay: '😐',
            down: '😔',
            terrible: '😢'
        };

        const moodMessages = {
            great: 'That\'s wonderful! Keep riding that positive wave! 🌊',
            good: 'Great to hear! Every good day counts! ☀️',
            okay: 'Thanks for checking in. Remember, okay days are okay! 💙',
            down: 'I\'m sorry you\'re feeling down. Be gentle with yourself today. 🌸',
            terrible: 'I hear you. Remember, this feeling won\'t last forever. You\'re not alone. 💜'
        };

        const embed = new EmbedBuilder()
            .setColor(feeling === 'great' || feeling === 'good' ? '#2ECC71' : feeling === 'okay' ? '#F39C12' : '#E74C3C')
            .setTitle(`${moodEmojis[feeling]} Mood Tracked`)
            .setDescription(moodMessages[feeling])
            .addFields({
                name: '📊 Your Mood',
                value: `**Feeling:** ${moodEmojis[feeling]} ${feeling.charAt(0).toUpperCase() + feeling.slice(1)}${note ? `\n**Note:** ${note}` : ''}`,
                inline: false
            })
            .setFooter({ text: 'Use /selfcare wellness moodstats to see your mood trends' })
            .setTimestamp();

        // Add helpful resources if feeling down or terrible
        if (feeling === 'down' || feeling === 'terrible') {
            embed.addFields({
                name: '💙 Remember',
                value: '• Take things one moment at a time\n• Reach out to someone you trust\n• Be kind to yourself\n• Consider talking to a professional if needed',
                inline: false
            });
        }

        return interaction.editReply({ embeds: [embed] });

    } catch (error) {
        console.error('[Wellness Mood Track Error]', error);
        return interaction.editReply({
            content: '❌ Failed to track mood. Please try again later.'
        });
    }
}

async function handleMoodStats(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const days = interaction.options.getInteger('days') || 7;
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    try {
        // Get mood entries for the specified period
        const [entries] = await pool.execute(`
            SELECT mood, note, tracked_at
            FROM wellness_mood_tracking
            WHERE guild_id = ? AND user_id = ? AND tracked_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
            ORDER BY tracked_at DESC
        `, [guildId, userId, days]);

        if (entries.length === 0) {
            return interaction.editReply({
                content: `📊 No mood data found for the last ${days} day${days > 1 ? 's' : ''}. Start tracking with \`/selfcare wellness mood\`!`
            });
        }

        // Calculate mood distribution
        const moodCounts = {
            great: 0,
            good: 0,
            okay: 0,
            down: 0,
            terrible: 0
        };

        entries.forEach(entry => {
            moodCounts[entry.mood]++;
        });

        // Calculate average mood score
        const moodScores = {
            great: 5,
            good: 4,
            okay: 3,
            down: 2,
            terrible: 1
        };

        const totalScore = entries.reduce((sum, entry) => sum + moodScores[entry.mood], 0);
        const averageScore = (totalScore / entries.length).toFixed(1);

        // Determine overall mood trend
        let trendEmoji = '😐';
        let trendText = 'Neutral';
        if (averageScore >= 4.5) {
            trendEmoji = '😊';
            trendText = 'Very Positive';
        } else if (averageScore >= 3.5) {
            trendEmoji = '🙂';
            trendText = 'Positive';
        } else if (averageScore < 2.5) {
            trendEmoji = '😔';
            trendText = 'Concerning';
        }

        const embed = new EmbedBuilder()
            .setColor('#9B59B6')
            .setTitle('📊 Your Mood Statistics')
            .setDescription(`Analysis of the last ${days} day${days > 1 ? 's' : ''} (${entries.length} ${entries.length === 1 ? 'entry' : 'entries'})`)
            .addFields(
                {
                    name: '🎭 Mood Distribution',
                    value: `😊 Great: ${moodCounts.great} (${((moodCounts.great / entries.length) * 100).toFixed(0)}%)\n` +
                           `🙂 Good: ${moodCounts.good} (${((moodCounts.good / entries.length) * 100).toFixed(0)}%)\n` +
                           `😐 Okay: ${moodCounts.okay} (${((moodCounts.okay / entries.length) * 100).toFixed(0)}%)\n` +
                           `😔 Down: ${moodCounts.down} (${((moodCounts.down / entries.length) * 100).toFixed(0)}%)\n` +
                           `😢 Terrible: ${moodCounts.terrible} (${((moodCounts.terrible / entries.length) * 100).toFixed(0)}%)`,
                    inline: true
                },
                {
                    name: '📈 Overall Trend',
                    value: `${trendEmoji} **${trendText}**\n\nAverage Score: ${averageScore}/5.0\nTotal Check-ins: ${entries.length}`,
                    inline: true
                }
            )
            .setFooter({ text: 'Keep tracking your mood daily for better insights!' })
            .setTimestamp();

        // Show recent entries
        const recentEntries = entries.slice(0, 5);
        const moodEmojis = { great: '😊', good: '🙂', okay: '😐', down: '😔', terrible: '😢' };
        const recentText = recentEntries.map(entry => {
            const date = new Date(entry.tracked_at);
            return `${moodEmojis[entry.mood]} ${date.toLocaleDateString()} - ${entry.mood}${entry.note ? ` (${entry.note.substring(0, 30)}${entry.note.length > 30 ? '...' : ''})` : ''}`;
        }).join('\n');

        embed.addFields({
            name: '📝 Recent Check-ins',
            value: recentText,
            inline: false
        });

        // Add encouragement or suggestions based on trend
        if (averageScore < 2.5) {
            embed.addFields({
                name: '💙 We Notice',
                value: 'Your mood has been lower than usual. Please consider:\n• Talking to someone you trust\n• Reaching out to a mental health professional\n• Practicing self-care activities\n• Using our wellness tools for support',
                inline: false
            });
        }

        return interaction.editReply({ embeds: [embed] });

    } catch (error) {
        console.error('[Wellness Mood Stats Error]', error);
        return interaction.editReply({
            content: '❌ Failed to retrieve mood statistics. Please try again later.'
        });
    }
}

async function handleBreathe(interaction) {
    const type = interaction.options.getString('type') || '478';

    const techniques = {
        '478': {
            name: '4-7-8 Relaxing Breath',
            description: 'A calming technique that helps reduce anxiety and promotes sleep.',
            steps: [
                '**1.** Exhale completely through your mouth (make a whoosh sound)',
                '**2.** Close your mouth and inhale quietly through your nose for **4** seconds',
                '**3.** Hold your breath for **7** seconds',
                '**4.** Exhale completely through your mouth for **8** seconds (whoosh sound)',
                '**5.** Repeat the cycle 3-4 times'
            ],
            benefits: '• Reduces anxiety\n• Helps with sleep\n• Lowers blood pressure\n• Calms the mind',
            color: '#3498DB'
        },
        box: {
            name: 'Box Breathing (4-4-4-4)',
            description: 'Used by Navy SEALs to stay calm and focused under pressure.',
            steps: [
                '**1.** Exhale completely through your mouth',
                '**2.** Inhale through your nose for **4** seconds',
                '**3.** Hold your breath for **4** seconds',
                '**4.** Exhale through your mouth for **4** seconds',
                '**5.** Hold your breath (empty lungs) for **4** seconds',
                '**6.** Repeat for 3-5 minutes'
            ],
            benefits: '• Enhances focus\n• Reduces stress\n• Improves performance\n• Regulates nervous system',
            color: '#2ECC71'
        },
        simple: {
            name: 'Simple Deep Breathing',
            description: 'Basic deep breathing for quick stress relief anywhere, anytime.',
            steps: [
                '**1.** Find a comfortable position (sitting or lying down)',
                '**2.** Place one hand on your chest, one on your belly',
                '**3.** Breathe in slowly through your nose (5-6 seconds)',
                '**4.** Feel your belly rise (not your chest)',
                '**5.** Exhale slowly through your mouth (5-6 seconds)',
                '**6.** Repeat for 5-10 minutes'
            ],
            benefits: '• Quick stress relief\n• Easy to do anywhere\n• Lowers heart rate\n• Improves oxygen flow',
            color: '#9B59B6'
        }
    };

    const technique = techniques[type];

    const embed = new EmbedBuilder()
        .setColor(technique.color)
        .setTitle(`🧘 ${technique.name}`)
        .setDescription(technique.description)
        .addFields(
            {
                name: '📋 Instructions',
                value: technique.steps.join('\n'),
                inline: false
            },
            {
                name: '✨ Benefits',
                value: technique.benefits,
                inline: false
            },
            {
                name: '💡 Tips',
                value: '• Find a quiet, comfortable space\n• Close your eyes if comfortable\n• Focus only on your breath\n• Don\'t force it - breathe naturally\n• Practice daily for best results',
                inline: false
            }
        )
        .setFooter({ text: 'Take your time and breathe at your own pace' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function handlePomodoro(interaction) {
    const duration = interaction.options.getInteger('duration') || 25;
    const breakDuration = interaction.options.getInteger('break') || 5;
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    try {
        // Create pomodoro tracking table if it doesn't exist
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS wellness_pomodoro_sessions (
                id INT AUTO_INCREMENT PRIMARY KEY,
                guild_id VARCHAR(20) NOT NULL,
                user_id VARCHAR(20) NOT NULL,
                work_duration INT NOT NULL,
                break_duration INT NOT NULL,
                started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed BOOLEAN DEFAULT FALSE,
                INDEX idx_user_sessions (guild_id, user_id, started_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        // Insert new session
        await pool.execute(
            'INSERT INTO wellness_pomodoro_sessions (guild_id, user_id, work_duration, break_duration) VALUES (?, ?, ?, ?)',
            [guildId, userId, duration, breakDuration]
        );

        const endTime = new Date(Date.now() + duration * 60 * 1000);
        const breakEndTime = new Date(Date.now() + (duration + breakDuration) * 60 * 1000);

        const embed = new EmbedBuilder()
            .setColor('#E74C3C')
            .setTitle('🍅 Pomodoro Timer Started!')
            .setDescription('Focus time has begun. Eliminate distractions and concentrate on your task.')
            .addFields(
                {
                    name: '⏰ Work Session',
                    value: `**Duration:** ${duration} minutes\n**Ends at:** ${endTime.toLocaleTimeString()}`,
                    inline: true
                },
                {
                    name: '☕ Break Time',
                    value: `**Duration:** ${breakDuration} minutes\n**Ends at:** ${breakEndTime.toLocaleTimeString()}`,
                    inline: true
                },
                {
                    name: '📋 Pomodoro Technique',
                    value: '1. Work with full focus (no distractions)\n2. Take your break when timer ends\n3. Repeat for 4 sessions\n4. Take a longer break (15-30 min)',
                    inline: false
                },
                {
                    name: '💡 Tips for Success',
                    value: '• Silence notifications\n• Close unnecessary tabs\n• Keep water nearby\n• Have a clear goal\n• Track your progress',
                    inline: false
                }
            )
            .setFooter({ text: `Use /selfcare wellness pomostat to track your productivity • Session ${duration}min work / ${breakDuration}min break` })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });

        // Schedule a follow-up reminder (Discord interaction tokens last 15 minutes)
        // For longer sessions, we just track in database
        if (duration <= 15) {
            setTimeout(async () => {
                try {
                    // Mark session as completed
                    await pool.execute(
                        'UPDATE wellness_pomodoro_sessions SET completed = TRUE WHERE guild_id = ? AND user_id = ? AND completed = FALSE ORDER BY started_at DESC LIMIT 1',
                        [guildId, userId]
                    );

                    const reminderEmbed = new EmbedBuilder()
                        .setColor('#2ECC71')
                        .setTitle('✅ Work Session Complete!')
                        .setDescription(`Great job, ${interaction.user.username}! Time for your ${breakDuration}-minute break.`)
                        .addFields({
                            name: '☕ Break Activities',
                            value: '• Stretch and move around\n• Get water or a healthy snack\n• Step outside for fresh air\n• Rest your eyes\n• Avoid screens if possible',
                            inline: false
                        })
                        .setFooter({ text: 'Start your next session when you\'re ready!' })
                        .setTimestamp();

                    await interaction.followUp({ content: `<@${userId}>`, embeds: [reminderEmbed] });
                } catch (error) {
                    console.error('[Pomodoro Reminder Error]', error);
                }
            }, duration * 60 * 1000);
        }

    } catch (error) {
        console.error('[Wellness Pomodoro Error]', error);
        return interaction.reply({
            content: '❌ Failed to start Pomodoro session. Please try again later.',
            ephemeral: true
        });
    }
}

async function handlePomodoroStats(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    try {
        // Get session statistics
        const [stats] = await pool.execute(`
            SELECT
                COUNT(*) as total_sessions,
                SUM(completed) as completed_sessions,
                SUM(work_duration) as total_focus_time,
                AVG(work_duration) as avg_session_length,
                MAX(started_at) as last_session
            FROM wellness_pomodoro_sessions
            WHERE guild_id = ? AND user_id = ?
        `, [guildId, userId]);

        const [recentSessions] = await pool.execute(`
            SELECT work_duration, break_duration, started_at, completed
            FROM wellness_pomodoro_sessions
            WHERE guild_id = ? AND user_id = ?
            ORDER BY started_at DESC
            LIMIT 10
        `, [guildId, userId]);

        if (!stats[0] || stats[0].total_sessions === 0) {
            return interaction.editReply({
                content: '📊 No Pomodoro sessions found. Start your first session with `/selfcare wellness pomodoro`!'
            });
        }

        const data = stats[0];
        const completionRate = data.total_sessions > 0
            ? Math.round((data.completed_sessions / data.total_sessions) * 100)
            : 0;

        // Calculate streak (consecutive days with sessions)
        const [dailySessions] = await pool.execute(`
            SELECT DATE(started_at) as session_date, COUNT(*) as count
            FROM wellness_pomodoro_sessions
            WHERE guild_id = ? AND user_id = ?
            GROUP BY DATE(started_at)
            ORDER BY session_date DESC
            LIMIT 30
        `, [guildId, userId]);

        let streak = 0;
        let currentDate = new Date();
        currentDate.setHours(0, 0, 0, 0);

        for (const session of dailySessions) {
            const sessionDate = new Date(session.session_date);
            sessionDate.setHours(0, 0, 0, 0);
            const daysDiff = Math.floor((currentDate - sessionDate) / (1000 * 60 * 60 * 24));

            if (daysDiff === streak) {
                streak++;
                currentDate.setDate(currentDate.getDate() - 1);
            } else {
                break;
            }
        }

        const embed = new EmbedBuilder()
            .setColor('#E74C3C')
            .setTitle('🍅 Your Pomodoro Statistics')
            .setDescription('Track your focus and productivity over time')
            .addFields(
                {
                    name: '📊 Overall Stats',
                    value: `**Total Sessions:** ${data.total_sessions}\n` +
                           `**Completed:** ${data.completed_sessions} (${completionRate}%)\n` +
                           `**Total Focus Time:** ${Math.floor(data.total_focus_time / 60)}h ${data.total_focus_time % 60}m\n` +
                           `**Avg Session:** ${Math.round(data.avg_session_length)} minutes`,
                    inline: true
                },
                {
                    name: '🔥 Productivity',
                    value: `**Current Streak:** ${streak} day${streak !== 1 ? 's' : ''}\n` +
                           `**Last Session:** ${data.last_session ? new Date(data.last_session).toLocaleDateString() : 'N/A'}\n` +
                           `**This Week:** ${dailySessions.slice(0, 7).reduce((sum, s) => sum + s.count, 0)} sessions`,
                    inline: true
                }
            )
            .setFooter({ text: 'Keep up the great work! Consistency is key.' })
            .setTimestamp();

        // Show recent sessions
        if (recentSessions.length > 0) {
            const recentText = recentSessions.slice(0, 5).map(session => {
                const date = new Date(session.started_at);
                const status = session.completed ? '✅' : '⏳';
                return `${status} ${date.toLocaleDateString()} - ${session.work_duration}min work`;
            }).join('\n');

            embed.addFields({
                name: '📝 Recent Sessions',
                value: recentText,
                inline: false
            });
        }

        // Add motivational message based on performance
        if (completionRate >= 80) {
            embed.setDescription('🌟 **Excellent focus!** You\'re crushing your Pomodoro sessions!');
        } else if (completionRate >= 60) {
            embed.setDescription('💪 **Great work!** Keep building that focus muscle!');
        } else if (data.total_sessions >= 5) {
            embed.setDescription('📈 **You\'re getting started!** Try to complete more sessions for better results.');
        }

        return interaction.editReply({ embeds: [embed] });

    } catch (error) {
        console.error('[Wellness Pomodoro Stats Error]', error);
        return interaction.editReply({
            content: '❌ Failed to retrieve Pomodoro statistics. Please try again later.'
        });
    }
}
