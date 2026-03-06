import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

const XP_PER_TOKE = 10;
const XP_PER_LEVEL = 100;
const STREAK_BONUS_XP = 5;

const TOKE_RESPONSES = {
    dab: [
        'takes a fat dab and ascends to another dimension!',
        'heats up the nail and takes a massive dab!',
        'fires up the rig for a tasty dab!',
        'vaporizes some concentrate with style!',
        'takes a dab so big, the smoke alarm is jealous!',
    ],
    blunt: [
        'sparks up a fat blunt and passes it around!',
        'lights up a backwood and vibes out!',
        'rolls up a perfect blunt and blazes!',
        'gets the blunt rotation going!',
        'unwraps a fresh blunt and gets lifted!',
    ],
    joint: [
        'lights up a perfectly rolled joint!',
        'sparks a J and lets the good times roll!',
        'puffs on a classic joint!',
        'fires up a fatty and shares the love!',
        'twists one up and gets elevated!',
    ],
    bong: [
        'clears a massive bong rip!',
        'takes a milky bong hit!',
        'packs a fat bowl and rips the bong!',
        'torches a bowl and milks the chamber!',
        'pulls a lung-buster from the bong!',
    ],
    pipe: [
        'packs a bowl and takes a hit!',
        'sparks up the trusty pipe!',
        'lights up the pipe for a quick session!',
        'hits the pipe like a pro!',
        'takes a smooth hit from the glass!',
    ],
    edible: [
        'munches on a tasty edible and waits for liftoff!',
        'enjoys a potent edible treat!',
        'eats a fire edible and prepares for the journey!',
        'pops an edible and plays the waiting game!',
        'consumes a delicious edible!',
    ],
    vape: [
        'takes a smooth vape hit!',
        'clouds up with the vape pen!',
        'hits the vape and exhales a cloud!',
        'puffs on the vape discretely!',
        'takes a tasty vape rip!',
    ],
    hookah: [
        'takes a relaxing hookah pull!',
        'enjoys some hookah with the crew!',
        'puffs on the hookah and chills!',
        'passes the hookah hose around!',
        'takes a big hookah cloud!',
    ],
    other: [
        'enjoys some green in their own way!',
        'gets lifted their own style!',
        'partakes in the herbal arts!',
        'blazes up!',
        'gets elevated!',
    ],
};

function getMethodEmoji(method) {
    const emojis = { dab: '🔥', blunt: '🟤', joint: '🚬', bong: '💨', pipe: '🪈', edible: '🍪', vape: '💭', hookah: '🫧', other: '🌿' };
    return emojis[method] || '🌿';
}

function getRarityEmoji(rarity) {
    const emojis = { common: '⚪', uncommon: '🟢', rare: '🔵', epic: '🟣', legendary: '🟠' };
    return emojis[rarity] || '';
}

function createProgressBar(current, max, length = 10) {
    const filled = Math.round((current / max) * length);
    const empty = length - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
}

async function checkAndGrantAchievements(connection, guildId, userId, stats) {
    const newAchievements = [];
    const [unlockedAchievements] = await connection.execute(
        'SELECT achievement_id FROM toke_user_achievements WHERE guild_id = ? AND user_id = ?',
        [guildId, userId]
    );
    const unlockedIds = new Set(unlockedAchievements.map(a => a.achievement_id));
    const [allAchievements] = await connection.execute('SELECT * FROM toke_achievements');

    for (const achievement of allAchievements) {
        if (unlockedIds.has(achievement.id)) continue;
        let qualified = false;

        switch (achievement.requirement_type) {
            case 'total_tokes': qualified = stats.total_tokes >= achievement.requirement_value; break;
            case 'dab_count': qualified = stats.dab_count >= achievement.requirement_value; break;
            case 'blunt_count': qualified = stats.blunt_count >= achievement.requirement_value; break;
            case 'joint_count': qualified = stats.joint_count >= achievement.requirement_value; break;
            case 'bong_count': qualified = stats.bong_count >= achievement.requirement_value; break;
            case 'pipe_count': qualified = stats.pipe_count >= achievement.requirement_value; break;
            case 'edible_count': qualified = stats.edible_count >= achievement.requirement_value; break;
            case 'vape_count': qualified = stats.vape_count >= achievement.requirement_value; break;
            case 'hookah_count': qualified = stats.hookah_count >= achievement.requirement_value; break;
            case 'current_streak': qualified = stats.current_streak >= achievement.requirement_value; break;
            case 'level': qualified = stats.level >= achievement.requirement_value; break;
            case 'methods_tried':
                const methodsTried = [
                    stats.dab_count > 0, stats.blunt_count > 0, stats.joint_count > 0,
                    stats.bong_count > 0, stats.pipe_count > 0, stats.edible_count > 0,
                    stats.vape_count > 0, stats.hookah_count > 0,
                ].filter(Boolean).length;
                qualified = methodsTried >= achievement.requirement_value;
                break;
        }

        if (qualified) {
            await connection.execute(
                'INSERT IGNORE INTO toke_user_achievements (guild_id, user_id, achievement_id) VALUES (?, ?, ?)',
                [guildId, userId, achievement.id]
            );
            await connection.execute(
                'UPDATE toke_user_stats SET xp = xp + ? WHERE guild_id = ? AND user_id = ?',
                [achievement.xp_reward, guildId, userId]
            );
            newAchievements.push(achievement);
        }
    }
    return newAchievements;
}

export async function handleToke(interaction, guildId, userId, method) {
    await interaction.deferReply();

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const [[prefs]] = await connection.execute(
            'SELECT custom_message FROM toke_preferences WHERE user_id = ?',
            [userId]
        );

        await connection.execute(
            'INSERT INTO toke_sessions (guild_id, user_id, method) VALUES (?, ?, ?)',
            [guildId, userId, method]
        );

        const [[currentStats]] = await connection.execute(
            'SELECT * FROM toke_user_stats WHERE guild_id = ? AND user_id = ?',
            [guildId, userId]
        );

        let newStreak = 1;
        let streakBroken = false;
        if (currentStats?.last_toke_at) {
            const lastToke = new Date(currentStats.last_toke_at);
            const now = new Date();
            const hoursSinceLastToke = (now - lastToke) / (1000 * 60 * 60);

            if (hoursSinceLastToke < 24) {
                newStreak = currentStats.current_streak;
            } else if (hoursSinceLastToke < 48) {
                newStreak = currentStats.current_streak + 1;
            } else {
                streakBroken = currentStats.current_streak > 1;
                newStreak = 1;
            }
        }

        const longestStreak = Math.max(newStreak, currentStats?.longest_streak || 0);

        let xpGained = XP_PER_TOKE;
        if (newStreak > 1) xpGained += STREAK_BONUS_XP;

        const newTotalXp = (currentStats?.xp || 0) + xpGained;
        const newLevel = Math.floor(newTotalXp / XP_PER_LEVEL) + 1;
        const leveledUp = newLevel > (currentStats?.level || 1);

        const methodColumn = `${method}_count`;
        await connection.execute(
            `INSERT INTO toke_user_stats (guild_id, user_id, total_tokes, ${methodColumn}, xp, level, current_streak, longest_streak, last_toke_at)
             VALUES (?, ?, 1, 1, ?, ?, ?, ?, NOW())
             ON DUPLICATE KEY UPDATE
             total_tokes = total_tokes + 1,
             ${methodColumn} = ${methodColumn} + 1,
             xp = ?,
             level = ?,
             current_streak = ?,
             longest_streak = ?,
             last_toke_at = NOW()`,
            [guildId, userId, xpGained, newLevel, newStreak, longestStreak,
             newTotalXp, newLevel, newStreak, longestStreak]
        );

        const [[updatedStats]] = await connection.execute(
            'SELECT * FROM toke_user_stats WHERE guild_id = ? AND user_id = ?',
            [guildId, userId]
        );

        const newAchievements = await checkAndGrantAchievements(connection, guildId, userId, updatedStats);
        await connection.commit();

        const responses = TOKE_RESPONSES[method] || TOKE_RESPONSES.other;
        const randomResponse = responses[Math.floor(Math.random() * responses.length)];
        const displayName = interaction.member?.displayName || interaction.user.username;
        let description = prefs?.custom_message
            ? `**${displayName}** ${prefs.custom_message}`
            : `**${displayName}** ${randomResponse}`;

        const embed = new EmbedBuilder()
            .setColor(0x4caf50)
            .setTitle(getMethodEmoji(method) + ' Toke Recorded!')
            .setDescription(description)
            .addFields(
                { name: '📊 Total Tokes', value: `**${updatedStats.total_tokes.toLocaleString()}**`, inline: true },
                { name: '🔥 Streak', value: `**${newStreak} day${newStreak !== 1 ? 's' : ''}**`, inline: true },
                { name: '⭐ Level', value: `**${newLevel}** (${newTotalXp % XP_PER_LEVEL}/${XP_PER_LEVEL} XP)`, inline: true }
            )
            .setFooter({ text: `+${xpGained} XP${newStreak > 1 ? ' (streak bonus!)' : ''}` })
            .setTimestamp();

        if (leveledUp) embed.addFields({ name: '🎉 LEVEL UP!', value: `You reached **Level ${newLevel}**!`, inline: false });
        if (streakBroken) embed.addFields({ name: '💔 Streak Lost', value: `Your ${currentStats.current_streak} day streak was broken!`, inline: false });

        if (newAchievements.length > 0) {
            const achievementText = newAchievements.map(a => `${a.emoji} **${a.name}** - ${a.description}`).join('\n');
            embed.addFields({ name: '🏆 Achievement Unlocked!', value: achievementText, inline: false });
        }

        await interaction.editReply({ embeds: [embed] });

    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
}

export async function handleTokeStats(interaction, guildId) {
    await interaction.deferReply();
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const userId = targetUser.id;

    const [[stats]] = await pool.execute(
        'SELECT * FROM toke_user_stats WHERE guild_id = ? AND user_id = ?',
        [guildId, userId]
    );

    if (!stats) {
        return interaction.editReply(`${targetUser.username} hasn't recorded any tokes yet! Use \`/cannabis toke <method>\` to get started.`);
    }

    const [[achievementCount]] = await pool.execute(
        'SELECT COUNT(*) as count FROM toke_user_achievements WHERE guild_id = ? AND user_id = ?',
        [guildId, userId]
    );
    const [[totalAchievements]] = await pool.execute('SELECT COUNT(*) as count FROM toke_achievements');
    const [[rankResult]] = await pool.execute(
        `SELECT COUNT(*) + 1 as rank FROM toke_user_stats WHERE guild_id = ? AND total_tokes > ?`,
        [guildId, stats.total_tokes]
    );

    const progressToNextLevel = stats.xp % XP_PER_LEVEL;
    const progressBar = createProgressBar(progressToNextLevel, XP_PER_LEVEL, 10);

    const embed = new EmbedBuilder()
        .setColor(0x2196f3)
        .setTitle(`📊 ${targetUser.username}'s Toke Stats`)
        .setThumbnail(targetUser.displayAvatarURL())
        .addFields(
            { name: '🏆 Server Rank', value: `#${rankResult.rank}`, inline: true },
            { name: '⭐ Level', value: `${stats.level}`, inline: true },
            { name: '✨ XP', value: `${stats.xp.toLocaleString()}`, inline: true },
            { name: '📈 Progress', value: `${progressBar} ${progressToNextLevel}/${XP_PER_LEVEL}`, inline: false },
            { name: '💨 Total Tokes', value: stats.total_tokes.toLocaleString(), inline: true },
            { name: '🔥 Current Streak', value: `${stats.current_streak} days`, inline: true },
            { name: '🏅 Best Streak', value: `${stats.longest_streak} days`, inline: true },
            { name: '🏆 Achievements', value: `${achievementCount.count}/${totalAchievements.count}`, inline: true }
        )
        .addFields({
            name: '📋 Breakdown by Method',
            value: [
                `🔥 Dabs: **${stats.dab_count}** | 🟤 Blunts: **${stats.blunt_count}**`,
                `🚬 Joints: **${stats.joint_count}** | 💨 Bongs: **${stats.bong_count}**`,
                `🪈 Pipes: **${stats.pipe_count}** | 🍪 Edibles: **${stats.edible_count}**`,
                `💭 Vapes: **${stats.vape_count}** | 🫧 Hookahs: **${stats.hookah_count}**`,
            ].join('\n'),
            inline: false
        })
        .setFooter({ text: 'Keep toking to level up and unlock achievements!' })
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

export async function handleTokeLeaderboard(interaction, guildId) {
    await interaction.deferReply();

    const [leaders] = await pool.execute(
        `SELECT user_id, total_tokes, level, xp FROM toke_user_stats
         WHERE guild_id = ? ORDER BY total_tokes DESC LIMIT 10`,
        [guildId]
    );

    if (leaders.length === 0) {
        return interaction.editReply('No tokes recorded in this server yet! Be the first with `/cannabis toke <method>`');
    }

    const leaderboardText = leaders.map((row, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        return `${medal} <@${row.user_id}> - **${row.total_tokes.toLocaleString()}** tokes (Lvl ${row.level})`;
    }).join('\n');

    const embed = new EmbedBuilder()
        .setColor(0xff9800)
        .setTitle('🏆 Server Toke Leaderboard')
        .setDescription(leaderboardText)
        .setFooter({ text: 'Use /cannabis toke <method> to climb the ranks!' })
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

export async function handleTokeGlobalStats(interaction) {
    await interaction.deferReply();

    const [[globalStats]] = await pool.execute(
        `SELECT
            SUM(total_tokes) as total_tokes,
            COUNT(DISTINCT guild_id) as server_count,
            COUNT(DISTINCT user_id) as unique_users,
            SUM(dab_count) as total_dabs, SUM(blunt_count) as total_blunts,
            SUM(joint_count) as total_joints, SUM(bong_count) as total_bongs,
            SUM(pipe_count) as total_pipes, SUM(edible_count) as total_edibles,
            SUM(vape_count) as total_vapes, SUM(hookah_count) as total_hookahs
         FROM toke_user_stats`
    );

    const [topGlobal] = await pool.execute(
        `SELECT user_id, SUM(total_tokes) as total FROM toke_user_stats
         GROUP BY user_id ORDER BY total DESC LIMIT 5`
    );

    const leaderboard = topGlobal.length > 0
        ? topGlobal.map((row, i) => {
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
            return `${medal} <@${row.user_id}> - **${row.total.toLocaleString()}** tokes`;
        }).join('\n')
        : 'No tokes recorded yet!';

    const embed = new EmbedBuilder()
        .setColor(0x9c27b0)
        .setTitle('🌍 Global Toke Statistics')
        .setDescription(leaderboard)
        .addFields(
            { name: '💨 Total Tokes', value: (globalStats.total_tokes || 0).toLocaleString(), inline: true },
            { name: '👥 Unique Tokers', value: (globalStats.unique_users || 0).toLocaleString(), inline: true },
            { name: '🌐 Servers', value: (globalStats.server_count || 0).toLocaleString(), inline: true }
        )
        .addFields({
            name: '📊 Method Breakdown',
            value: [
                `🔥 Dabs: **${(globalStats.total_dabs || 0).toLocaleString()}** | 🟤 Blunts: **${(globalStats.total_blunts || 0).toLocaleString()}**`,
                `🚬 Joints: **${(globalStats.total_joints || 0).toLocaleString()}** | 💨 Bongs: **${(globalStats.total_bongs || 0).toLocaleString()}**`,
                `🪈 Pipes: **${(globalStats.total_pipes || 0).toLocaleString()}** | 🍪 Edibles: **${(globalStats.total_edibles || 0).toLocaleString()}**`,
                `💭 Vapes: **${(globalStats.total_vapes || 0).toLocaleString()}** | 🫧 Hookahs: **${(globalStats.total_hookahs || 0).toLocaleString()}**`,
            ].join('\n'),
            inline: false
        })
        .setFooter({ text: 'Global statistics across all servers' })
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

export async function handleTokeAchievements(interaction, guildId) {
    await interaction.deferReply();
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const userId = targetUser.id;

    const [allAchievements] = await pool.execute('SELECT * FROM toke_achievements ORDER BY category, requirement_value');
    const [userAchievements] = await pool.execute(
        'SELECT achievement_id FROM toke_user_achievements WHERE guild_id = ? AND user_id = ?',
        [guildId, userId]
    );
    const unlockedIds = new Set(userAchievements.map(a => a.achievement_id));

    const categories = {};
    for (const achievement of allAchievements) {
        if (!categories[achievement.category]) categories[achievement.category] = [];
        categories[achievement.category].push({ ...achievement, unlocked: unlockedIds.has(achievement.id) });
    }

    const categoryEmojis = { milestone: '🎯', method: '💨', streak: '🔥', social: '👥', special: '⭐' };
    const embeds = [];

    for (const [category, achievements] of Object.entries(categories)) {
        const unlocked = achievements.filter(a => a.unlocked).length;
        const total = achievements.length;
        const achievementList = achievements.map(a => {
            const status = a.unlocked ? '✅' : '🔒';
            const rarityEmoji = getRarityEmoji(a.rarity);
            return `${status} ${a.emoji} **${a.name}** ${rarityEmoji}\n└ ${a.description}`;
        }).join('\n\n');

        embeds.push(new EmbedBuilder()
            .setColor(0xff9800)
            .setTitle(`${categoryEmojis[category] || '🏆'} ${category.charAt(0).toUpperCase() + category.slice(1)} Achievements`)
            .setDescription(achievementList || 'No achievements in this category.')
            .setFooter({ text: `${unlocked}/${total} unlocked | ${targetUser.username}'s achievements` }));
    }

    let currentPage = 0;
    const generateButtons = () => new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ach_prev').setLabel('◀').setStyle(ButtonStyle.Primary).setDisabled(currentPage === 0),
        new ButtonBuilder().setCustomId('ach_page').setLabel(`${currentPage + 1}/${embeds.length}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId('ach_next').setLabel('▶').setStyle(ButtonStyle.Primary).setDisabled(currentPage === embeds.length - 1)
    );

    const message = await interaction.editReply({
        embeds: [embeds[currentPage]],
        components: embeds.length > 1 ? [generateButtons()] : []
    });

    if (embeds.length > 1) {
        const collector = message.createMessageComponentCollector({ filter: i => i.user.id === interaction.user.id, time: 120000 });
        collector.on('collect', async i => {
            if (i.customId === 'ach_prev') currentPage--;
            else if (i.customId === 'ach_next') currentPage++;
            await i.update({ embeds: [embeds[currentPage]], components: [generateButtons()] });
        });
        collector.on('end', () => { message.edit({ components: [] }).catch(() => {}); });
    }
}

export async function handleTokeSetMessage(interaction, userId) {
    const message = interaction.options.getString('message');
    await pool.execute(
        `INSERT INTO toke_preferences (user_id, custom_message) VALUES (?, ?) ON DUPLICATE KEY UPDATE custom_message = ?`,
        [userId, message, message]
    );
    await interaction.reply({
        content: `✅ Your custom toke message has been set!\n\nPreview: **${interaction.user.username}** ${message}`,
        flags: 64
    });
}

export async function handleTokeClearMessage(interaction, userId) {
    await pool.execute('UPDATE toke_preferences SET custom_message = NULL WHERE user_id = ?', [userId]);
    await interaction.reply({ content: '✅ Your custom message has been cleared.', flags: 64 });
}

export async function handleTokeStartSesh(interaction, guildId, userId) {
    const [[existingSesh]] = await pool.execute(
        'SELECT id FROM toke_group_sesh WHERE guild_id = ? AND status = "active"',
        [guildId]
    );

    if (existingSesh) {
        return interaction.reply({ content: 'There\'s already an active sesh! Use `/cannabis sesh join` to join.', flags: 64 });
    }

    const [result] = await pool.execute(
        'INSERT INTO toke_group_sesh (guild_id, channel_id, host_id) VALUES (?, ?, ?)',
        [guildId, interaction.channel.id, userId]
    );

    await pool.execute(
        'INSERT INTO toke_sesh_participants (sesh_id, user_id) VALUES (?, ?)',
        [result.insertId, userId]
    );

    const embed = new EmbedBuilder()
        .setColor(0x4caf50)
        .setTitle('🌿 Group Sesh Started!')
        .setDescription(`**${interaction.user.username}** has started a group sesh!\n\nUse \`/cannabis sesh join\` to join the session.\nUse any \`/cannabis toke <method>\` command to toke with the group!`)
        .addFields(
            { name: '👥 Participants', value: '1', inline: true },
            { name: '💨 Total Tokes', value: '0', inline: true }
        )
        .setFooter({ text: 'The host can end the sesh with /cannabis sesh end' });

    await interaction.reply({ embeds: [embed] });
}

export async function handleTokeJoinSesh(interaction, guildId, userId) {
    const [[sesh]] = await pool.execute(
        'SELECT id, host_id FROM toke_group_sesh WHERE guild_id = ? AND status = "active"',
        [guildId]
    );

    if (!sesh) {
        return interaction.reply({ content: 'No active sesh! Start one with `/cannabis sesh start`', flags: 64 });
    }

    const [[existing]] = await pool.execute(
        'SELECT id FROM toke_sesh_participants WHERE sesh_id = ? AND user_id = ?',
        [sesh.id, userId]
    );

    if (existing) {
        return interaction.reply({ content: 'You\'re already in the sesh!', flags: 64 });
    }

    await pool.execute('INSERT INTO toke_sesh_participants (sesh_id, user_id) VALUES (?, ?)', [sesh.id, userId]);
    await pool.execute('UPDATE toke_group_sesh SET participant_count = participant_count + 1 WHERE id = ?', [sesh.id]);

    await interaction.reply(`🌿 **${interaction.user.username}** has joined the sesh!`);
}

export async function handleTokeEndSesh(interaction, guildId, userId) {
    const [[sesh]] = await pool.execute(
        'SELECT * FROM toke_group_sesh WHERE guild_id = ? AND status = "active"',
        [guildId]
    );

    if (!sesh) {
        return interaction.reply({ content: 'No active sesh to end!', flags: 64 });
    }

    if (sesh.host_id !== userId && !interaction.member.permissions.has('Administrator')) {
        return interaction.reply({ content: 'Only the host can end the sesh!', flags: 64 });
    }

    const [participants] = await pool.execute(
        'SELECT user_id, tokes_in_sesh FROM toke_sesh_participants WHERE sesh_id = ? ORDER BY tokes_in_sesh DESC',
        [sesh.id]
    );

    await pool.execute('UPDATE toke_group_sesh SET status = "completed", ended_at = NOW() WHERE id = ?', [sesh.id]);

    const participantList = participants.map((p, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        return `${medal} <@${p.user_id}> - ${p.tokes_in_sesh} tokes`;
    }).join('\n') || 'No tokes recorded';

    const duration = Math.round((Date.now() - new Date(sesh.started_at).getTime()) / 60000);

    const embed = new EmbedBuilder()
        .setColor(0xff9800)
        .setTitle('🌿 Group Sesh Ended!')
        .setDescription(`Thanks for toking together!\n\n**Participants:**\n${participantList}`)
        .addFields(
            { name: '⏱️ Duration', value: `${duration} minutes`, inline: true },
            { name: '👥 Participants', value: `${sesh.participant_count}`, inline: true },
            { name: '💨 Total Tokes', value: `${sesh.total_tokes}`, inline: true }
        )
        .setFooter({ text: 'Start another sesh with /cannabis sesh start' });

    await interaction.reply({ embeds: [embed] });
}
