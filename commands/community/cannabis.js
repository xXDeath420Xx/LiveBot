import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../../utils/db.js';
import * as tokeHandlers from './cannabis-toke-handler.js';

export default {
    category: 'community',
    data: new SlashCommandBuilder()
        .setName('cannabis')
        .setDescription('Cannabis-themed community features')

        // ===== STRAIN GROUP =====
        .addSubcommandGroup(group =>
            group.setName('strain').setDescription('Strain-related commands')
                .addSubcommand(sub =>
                    sub.setName('daily').setDescription('Claim your daily joint, build your streak, and discover a new strain!'))
                .addSubcommand(sub =>
                    sub.setName('lookup').setDescription('Get information about a specific cannabis strain')
                        .addStringOption(opt => opt.setName('name').setDescription('The name of the strain').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('list').setDescription('View available cannabis strains')))

        // ===== CIRCLE GROUP =====
        .addSubcommandGroup(group =>
            group.setName('circle').setDescription('Smoke circle commands')
                .addSubcommand(sub =>
                    sub.setName('start').setDescription('Start a new smoke circle in this channel!'))
                .addSubcommand(sub =>
                    sub.setName('join').setDescription('Join the active smoke circle'))
                .addSubcommand(sub =>
                    sub.setName('puff').setDescription('Take a puff during your turn'))
                .addSubcommand(sub =>
                    sub.setName('pass').setDescription('Pass to the next person'))
                .addSubcommand(sub =>
                    sub.setName('end').setDescription('End the smoke circle')))

        // ===== TOKE GROUP =====
        .addSubcommandGroup(group =>
            group.setName('toke').setDescription('Toke commands with XP and tracking')
                .addSubcommand(sub =>
                    sub.setName('dab').setDescription('Take a fat dab!'))
                .addSubcommand(sub =>
                    sub.setName('blunt').setDescription('Spark up a blunt!'))
                .addSubcommand(sub =>
                    sub.setName('joint').setDescription('Light up a joint!'))
                .addSubcommand(sub =>
                    sub.setName('bong').setDescription('Rip the bong!'))
                .addSubcommand(sub =>
                    sub.setName('pipe').setDescription('Hit the pipe!'))
                .addSubcommand(sub =>
                    sub.setName('edible').setDescription('Eat an edible!'))
                .addSubcommand(sub =>
                    sub.setName('vape').setDescription('Hit the vape!'))
                .addSubcommand(sub =>
                    sub.setName('hookah').setDescription('Puff the hookah!'))
                .addSubcommand(sub =>
                    sub.setName('cheers').setDescription('Take a toke and add to your server total!')))

        // ===== STATS GROUP =====
        .addSubcommandGroup(group =>
            group.setName('stats').setDescription('Toke statistics and leaderboards')
                .addSubcommand(sub =>
                    sub.setName('personal').setDescription('View toke stats for a user')
                        .addUserOption(opt => opt.setName('user').setDescription('User to view stats for').setRequired(false)))
                .addSubcommand(sub =>
                    sub.setName('leaderboard').setDescription('View the server toke leaderboard'))
                .addSubcommand(sub =>
                    sub.setName('global').setDescription('View global toke statistics'))
                .addSubcommand(sub =>
                    sub.setName('achievements').setDescription('View toke achievements')
                        .addUserOption(opt => opt.setName('user').setDescription('User to view achievements for').setRequired(false)))
                .addSubcommand(sub =>
                    sub.setName('globalcheers').setDescription('View global cheers statistics')))

        // ===== THOUGHTS GROUP =====
        .addSubcommandGroup(group =>
            group.setName('thoughts').setDescription('Stoned thoughts')
                .addSubcommand(sub =>
                    sub.setName('random').setDescription('Get a random stoned thought'))
                .addSubcommand(sub =>
                    sub.setName('add').setDescription('Add a new stoned thought')
                        .addStringOption(opt => opt.setName('thought').setDescription('Your stoned thought').setRequired(true))))

        // ===== TRIVIA GROUP =====
        .addSubcommandGroup(group =>
            group.setName('trivia').setDescription('Cannabis trivia games')
                .addSubcommand(sub =>
                    sub.setName('start').setDescription('Start a cannabis trivia game'))
                .addSubcommand(sub =>
                    sub.setName('answer').setDescription('Answer the current trivia question')
                        .addStringOption(opt =>
                            opt.setName('answer').setDescription('Your answer (A, B, C, or D)').setRequired(true)
                                .addChoices(
                                    { name: 'A', value: 'A' },
                                    { name: 'B', value: 'B' },
                                    { name: 'C', value: 'C' },
                                    { name: 'D', value: 'D' }
                                )))
                .addSubcommand(sub =>
                    sub.setName('score').setDescription('View your trivia score'))
                .addSubcommand(sub =>
                    sub.setName('top').setDescription('View the trivia leaderboard')))

        // ===== SESH GROUP =====
        .addSubcommandGroup(group =>
            group.setName('sesh').setDescription('Group toke sessions')
                .addSubcommand(sub =>
                    sub.setName('start').setDescription('Start a group toke session'))
                .addSubcommand(sub =>
                    sub.setName('join').setDescription('Join the active group session'))
                .addSubcommand(sub =>
                    sub.setName('end').setDescription('End the active group session')))

        // ===== PREFS GROUP =====
        .addSubcommandGroup(group =>
            group.setName('prefs').setDescription('Toke preferences')
                .addSubcommand(sub =>
                    sub.setName('setmessage').setDescription('Set a custom toke message')
                        .addStringOption(opt => opt.setName('message').setDescription('Your custom toke message').setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('clearmessage').setDescription('Clear your custom toke message'))),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup();
        const subcommand = interaction.options.getSubcommand();
        const guildId = interaction.guild.id;
        const userId = interaction.user.id;

        try {
            switch (group) {
                case 'strain':
                    switch (subcommand) {
                        case 'daily': await handleDailyJoint(interaction, guildId, userId); break;
                        case 'lookup': await handleStrain(interaction); break;
                        case 'list': await handleStrains(interaction); break;
                    }
                    break;

                case 'circle':
                    switch (subcommand) {
                        case 'start': await handleSmokeCircle(interaction, guildId); break;
                        case 'join': await handleJoinCircle(interaction, guildId, userId); break;
                        case 'puff': await handlePuff(interaction, guildId, userId); break;
                        case 'pass': await handlePass(interaction, guildId, userId); break;
                        case 'end': await handleEndCircle(interaction, guildId); break;
                    }
                    break;

                case 'toke':
                    if (subcommand === 'cheers') {
                        await handleCheers(interaction, guildId, userId);
                    } else {
                        await tokeHandlers.handleToke(interaction, guildId, userId, subcommand);
                    }
                    break;

                case 'stats':
                    switch (subcommand) {
                        case 'personal': await tokeHandlers.handleTokeStats(interaction, guildId); break;
                        case 'leaderboard': await tokeHandlers.handleTokeLeaderboard(interaction, guildId); break;
                        case 'global': await tokeHandlers.handleTokeGlobalStats(interaction); break;
                        case 'achievements': await tokeHandlers.handleTokeAchievements(interaction, guildId); break;
                        case 'globalcheers': await handleGlobalCheers(interaction, guildId); break;
                    }
                    break;

                case 'thoughts':
                    switch (subcommand) {
                        case 'random': await handleStonedThought(interaction, guildId); break;
                        case 'add': await handleAddThought(interaction, guildId, userId); break;
                    }
                    break;

                case 'trivia':
                    switch (subcommand) {
                        case 'start': await handleTrivia(interaction, guildId); break;
                        case 'answer': await handleTriviaAnswer(interaction, guildId, userId); break;
                        case 'score': await handleTriviaScore(interaction, guildId, userId); break;
                        case 'top': await handleTriviaTop(interaction, guildId); break;
                    }
                    break;

                case 'sesh':
                    switch (subcommand) {
                        case 'start': await tokeHandlers.handleTokeStartSesh(interaction, guildId, userId); break;
                        case 'join': await tokeHandlers.handleTokeJoinSesh(interaction, guildId, userId); break;
                        case 'end': await tokeHandlers.handleTokeEndSesh(interaction, guildId, userId); break;
                    }
                    break;

                case 'prefs':
                    switch (subcommand) {
                        case 'setmessage': await tokeHandlers.handleTokeSetMessage(interaction, userId); break;
                        case 'clearmessage': await tokeHandlers.handleTokeClearMessage(interaction, userId); break;
                    }
                    break;

                default:
                    await interaction.reply({ content: 'Unknown command!', ephemeral: true });
            }
        } catch (error) {
            console.error(`Error in /cannabis ${group} ${subcommand}:`, error);
            const reply = { content: '\u26a0\ufe0f An error occurred. Please try again later.', ephemeral: true };
            if (interaction.deferred) {
                await interaction.editReply(reply);
            } else if (!interaction.replied) {
                await interaction.reply(reply);
            }
        }
    }
};

// ===== DAILY JOINT =====
async function handleDailyJoint(interaction, guildId, userId) {
    const now = new Date();
    const nowMySql = now.toISOString().slice(0, 19).replace('T', ' ');

    try {
        await interaction.deferReply();

        await pool.execute('START TRANSACTION');

        const [rows] = await pool.execute(
            `SELECT last_claimed, streak, total_claims FROM daily_joints WHERE guild_id = ? AND user_id = ? FOR UPDATE`,
            [guildId, userId]
        );

        const existingRecord = rows && rows.length > 0 ? rows[0] : null;

        if (existingRecord?.last_claimed) {
            const lastClaimedDate = new Date(existingRecord.last_claimed);
            const msSinceLastClaim = now.getTime() - lastClaimedDate.getTime();
            const hoursSinceLastClaim = msSinceLastClaim / (1000 * 60 * 60);

            if (hoursSinceLastClaim < 24) {
                await pool.execute('ROLLBACK');

                const nextClaimTime = new Date(lastClaimedDate.getTime() + (24 * 60 * 60 * 1000));
                const remainingMs = nextClaimTime.getTime() - now.getTime();
                const remainingHours = Math.floor(remainingMs / (1000 * 60 * 60));
                const remainingMinutes = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));

                const embed = new EmbedBuilder()
                    .setColor(0xffa500)
                    .setTitle('Woah there, easy does it!')
                    .setDescription(`\ud83d\ude14 You've already claimed your joint for the day! Come back in **${remainingHours}h ${remainingMinutes}m**`)
                    .addFields(
                        { name: '\ud83d\udd25 Current Streak', value: `**${existingRecord.streak || 0} days**`, inline: true },
                        { name: '\ud83d\udcca Total Claims', value: `**${existingRecord.total_claims || 0}**`, inline: true }
                    )
                    .setFooter({ text: 'Stay lifted!' });
                return interaction.editReply({ embeds: [embed] });
            }
        }

        let newStreak = 1;
        if (existingRecord?.last_claimed) {
            const yesterday = new Date();
            yesterday.setDate(yesterday.getDate() - 1);
            const lastClaimDateOnly = new Date(existingRecord.last_claimed).toDateString();
            const yesterdayDateOnly = yesterday.toDateString();

            if (lastClaimDateOnly === yesterdayDateOnly) {
                newStreak = existingRecord.streak + 1;
            }
        }

        const [strainRows] = await pool.execute(
            `SELECT id, strain_name, description FROM strains ORDER BY RAND() LIMIT 1`
        );
        const strainResult = strainRows[0];
        const strainId = strainResult?.id;
        const strainName = strainResult?.strain_name || 'Mystery Strain';
        const strainDescription = strainResult?.description || 'A unique experience awaits.';

        await pool.execute(
            `INSERT INTO daily_joints (guild_id, user_id, last_claimed, streak, total_claims, strain_id)
             VALUES (?, ?, ?, ?, 1, ?)
             ON DUPLICATE KEY UPDATE last_claimed = ?, streak = ?, total_claims = total_claims + 1, strain_id = ?`,
            [guildId, userId, nowMySql, newStreak, strainId, nowMySql, newStreak, strainId]
        );

        try {
            await pool.execute(
                `INSERT INTO joint_claims (guild_id, user_id, strain_name, claimed_at) VALUES (?, ?, ?, ?)`,
                [guildId, userId, strainName, nowMySql]
            );
        } catch (claimLogErr) {
            if (claimLogErr.code === 'ER_BAD_FIELD_ERROR') {
                await pool.execute(
                    `INSERT INTO joint_claims (guild_id, user_id, strain_name) VALUES (?, ?, ?)`,
                    [guildId, userId, strainName]
                );
            } else {
                throw claimLogErr;
            }
        }

        await pool.execute('COMMIT');

        const newTotalClaims = existingRecord ? (existingRecord.total_claims || 0) + 1 : 1;

        const embed = new EmbedBuilder()
            .setColor(0x00ff00)
            .setTitle('\ud83d\udd25 Daily Joint Claimed!')
            .setDescription(`Congrats, <@${userId}>! You've claimed your daily joint!`)
            .addFields(
                { name: '\ud83c\udf89 Streak', value: `**${newStreak} days**`, inline: true },
                { name: '\ud83d\udcca Total Claims', value: `**${newTotalClaims}**`, inline: true },
                { name: '\ud83c\udf41 Strain', value: `**${strainName}**`, inline: true },
                { name: '\ud83d\udcdc Description', value: strainDescription, inline: false }
            )
            .setFooter({ text: 'Keep the streak alive! See you tomorrow!' })
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
    } catch (err) {
        console.error('Error in dailyjoint:', err);
        await pool.execute('ROLLBACK');
        throw err;
    }
}

// ===== STRAIN LOOKUP =====
async function handleStrain(interaction) {
    const strainName = interaction.options.getString('name');

    try {
        await interaction.deferReply();

        const [strainRows] = await pool.execute(`SELECT * FROM strains WHERE strain_name = ?`, [strainName]);

        if (strainRows && strainRows.length > 0) {
            const cachedStrain = strainRows[0];
            const embed = new EmbedBuilder()
                .setColor(0x1abc9c)
                .setTitle(`\ud83c\udf3f ${cachedStrain.strain_name}`)
                .addFields(
                    { name: '\ud83d\udcdc Description', value: cachedStrain.description || 'N/A' },
                    { name: '\u2728 Effects', value: cachedStrain.effects || 'N/A' },
                    { name: '\ud83c\udf1f Rarity', value: cachedStrain.rarity || 'N/A', inline: true },
                    { name: '\ud83d\udc9a THC', value: cachedStrain.thc_level || 'N/A', inline: true },
                    { name: '\ud83e\uddea CBD', value: cachedStrain.cbd_level || 'N/A', inline: true }
                )
                .setFooter({ text: 'From the CertiFried strain database' });
            return interaction.editReply({ embeds: [embed] });
        }

        return interaction.editReply(`\u274c Strain "${strainName}" not found in the database.`);
    } catch (error) {
        console.error('Error fetching strain:', error);
        throw error;
    }
}

// ===== STRAINS LIST =====
async function handleStrains(interaction) {
    try {
        await interaction.deferReply();

        const [allStrains] = await pool.execute(`SELECT strain_name, rarity FROM strains ORDER BY rarity, strain_name`);

        if (!allStrains || allStrains.length === 0) {
            return interaction.editReply('No strains found in the database.');
        }

        const STRAINS_PER_PAGE = 15;
        const totalPages = Math.ceil(allStrains.length / STRAINS_PER_PAGE);
        let currentPage = 0;

        const generateEmbed = (page) => {
            const start = page * STRAINS_PER_PAGE;
            const end = start + STRAINS_PER_PAGE;
            const pageStrains = allStrains.slice(start, end);
            const strainsList = pageStrains.map(s => `\u2022 **${s.strain_name}** (${s.rarity})`).join('\n');

            return new EmbedBuilder()
                .setColor(0x2ecc71)
                .setTitle('\ud83c\udf3f Available Cannabis Strains')
                .setDescription(strainsList)
                .setFooter({ text: `Page ${page + 1}/${totalPages} \u2022 ${allStrains.length} total strains | Use /cannabis strain lookup <name> for details` });
        };

        const generateButtons = (page) => {
            return new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('strains_prev')
                        .setLabel('\u25c0 Previous')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(page === 0),
                    new ButtonBuilder()
                        .setCustomId('strains_next')
                        .setLabel('Next \u25b6')
                        .setStyle(ButtonStyle.Primary)
                        .setDisabled(page === totalPages - 1)
                );
        };

        const message = await interaction.editReply({
            embeds: [generateEmbed(currentPage)],
            components: totalPages > 1 ? [generateButtons(currentPage)] : []
        });

        if (totalPages > 1) {
            const collector = message.createMessageComponentCollector({
                filter: i => i.user.id === interaction.user.id,
                time: 300000
            });

            collector.on('collect', async i => {
                if (i.customId === 'strains_prev') {
                    currentPage = Math.max(0, currentPage - 1);
                } else if (i.customId === 'strains_next') {
                    currentPage = Math.min(totalPages - 1, currentPage + 1);
                }

                await i.update({
                    embeds: [generateEmbed(currentPage)],
                    components: [generateButtons(currentPage)]
                });
            });

            collector.on('end', () => {
                message.edit({ components: [] }).catch(() => {});
            });
        }
    } catch (error) {
        console.error('Error fetching strains list:', error);
        throw error;
    }
}

// ===== SMOKE CIRCLE =====
async function handleSmokeCircle(interaction, guildId) {
    try {
        const [existingCircle] = await pool.execute(
            `SELECT id FROM smoke_circles WHERE guild_id = ? AND status = 'active'`,
            [guildId]
        );

        if (existingCircle && existingCircle.length > 0) {
            return interaction.reply({ content: "A smoke circle is already active! Use `/cannabis circle join` to join.", ephemeral: true });
        }

        await pool.execute(
            `INSERT INTO smoke_circles (guild_id, channel_id, host_id, status, current_turn, total_puffs)
             VALUES (?, ?, ?, 'active', 0, 0)`,
            [guildId, interaction.channel.id, interaction.user.id]
        );

        await interaction.reply("\ud83c\udf3f A new smoke circle has started! Type `/cannabis circle join` to join!");
    } catch (err) {
        console.error('Error starting smoke circle:', err);
        throw err;
    }
}

async function handleJoinCircle(interaction, guildId, userId) {
    try {
        const [circleRows] = await pool.execute(
            `SELECT id FROM smoke_circles WHERE guild_id = ? AND status = 'active'`,
            [guildId]
        );

        if (!circleRows || circleRows.length === 0) {
            return interaction.reply({ content: "No active smoke circle! Start one with `/cannabis circle start`", ephemeral: true });
        }

        const circleId = circleRows[0].id;

        const [existingParticipant] = await pool.execute(
            `SELECT id FROM smoke_circle_participants WHERE circle_id = ? AND user_id = ?`,
            [circleId, userId]
        );

        if (existingParticipant && existingParticipant.length > 0) {
            return interaction.reply({ content: "You're already in the circle!", ephemeral: true });
        }

        await pool.execute(
            `INSERT INTO smoke_circle_participants (circle_id, user_id, puffs_taken, high_meter) VALUES (?, ?, 0, 0)`,
            [circleId, userId]
        );

        const [participantCount] = await pool.execute(
            `SELECT COUNT(*) as count FROM smoke_circle_participants WHERE circle_id = ?`,
            [circleId]
        );

        await interaction.reply(`<@${userId}> has joined the smoke circle! \ud83c\udf3f (${participantCount[0].count} members)`);
    } catch (err) {
        console.error('Error joining circle:', err);
        throw err;
    }
}

async function handlePuff(interaction, guildId, userId) {
    try {
        const [circleRows] = await pool.execute(
            `SELECT id, current_turn, total_puffs FROM smoke_circles WHERE guild_id = ? AND status = 'active'`,
            [guildId]
        );

        if (!circleRows || circleRows.length === 0) {
            return interaction.reply({ content: "No active smoke circle!", ephemeral: true });
        }

        const circle = circleRows[0];

        const [participants] = await pool.execute(
            `SELECT user_id FROM smoke_circle_participants WHERE circle_id = ? ORDER BY joined_at ASC`,
            [circle.id]
        );

        if (participants.length === 0) {
            return interaction.reply({ content: "No one in the circle yet!", ephemeral: true });
        }

        const currentUser = participants[circle.current_turn]?.user_id;

        if (currentUser !== userId) {
            return interaction.reply({ content: `It's not your turn! Wait for <@${currentUser}>`, ephemeral: true });
        }

        await pool.execute(
            `UPDATE smoke_circle_participants SET puffs_taken = puffs_taken + 1, high_meter = high_meter + 10
             WHERE circle_id = ? AND user_id = ?`,
            [circle.id, userId]
        );

        const newTotalPuffs = circle.total_puffs + 1;
        await pool.execute(
            `UPDATE smoke_circles SET total_puffs = ? WHERE id = ?`,
            [newTotalPuffs, circle.id]
        );

        await interaction.reply(`\ud83d\udca8 <@${userId}> takes a puff! (Total puffs: ${newTotalPuffs})`);
    } catch (err) {
        console.error('Error taking puff:', err);
        throw err;
    }
}

async function handlePass(interaction, guildId, userId) {
    try {
        const [circleRows] = await pool.execute(
            `SELECT id, current_turn FROM smoke_circles WHERE guild_id = ? AND status = 'active'`,
            [guildId]
        );

        if (!circleRows || circleRows.length === 0) {
            return interaction.reply({ content: "No active smoke circle!", ephemeral: true });
        }

        const circle = circleRows[0];

        const [participants] = await pool.execute(
            `SELECT user_id FROM smoke_circle_participants WHERE circle_id = ? ORDER BY joined_at ASC`,
            [circle.id]
        );

        if (participants.length === 0) {
            return interaction.reply({ content: "No one in the circle yet!", ephemeral: true });
        }

        const currentUser = participants[circle.current_turn]?.user_id;

        if (currentUser !== userId) {
            return interaction.reply({ content: `It's not your turn!`, ephemeral: true });
        }

        const nextTurn = (circle.current_turn + 1) % participants.length;

        await pool.execute(
            `UPDATE smoke_circles SET current_turn = ? WHERE id = ?`,
            [nextTurn, circle.id]
        );

        await interaction.reply(`\ud83d\udc49 <@${userId}> passes to <@${participants[nextTurn].user_id}>!`);
    } catch (err) {
        console.error('Error passing:', err);
        throw err;
    }
}

async function handleEndCircle(interaction, guildId) {
    try {
        await pool.execute(
            `UPDATE smoke_circles SET status = 'completed', ended_at = NOW() WHERE guild_id = ? AND status = 'active'`,
            [guildId]
        );

        await interaction.reply("\ud83c\udf3f The smoke circle has ended! Thanks for participating!");
    } catch (err) {
        console.error('Error ending circle:', err);
        throw err;
    }
}

// ===== TOKES (simple cheers) =====
async function handleCheers(interaction, guildId, userId) {
    try {
        await pool.execute(
            `INSERT INTO tokes (guild_id, user_id, count) VALUES (?, ?, 1)
             ON DUPLICATE KEY UPDATE count = count + 1`,
            [guildId, userId]
        );

        const [rows] = await pool.execute(
            `SELECT count FROM tokes WHERE guild_id = ? AND user_id = ?`,
            [guildId, userId]
        );

        const totalTokes = rows[0]?.count || 1;

        const embed = new EmbedBuilder()
            .setColor(0x4CAF50)
            .setTitle('Cheers!')
            .setDescription(`\ud83c\udf3f **${interaction.member.displayName}**, you've taken **${totalTokes} tokes** in this server!`)
            .setFooter({ text: 'Keep blazing responsibly!' })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    } catch (err) {
        console.error('Error in cheers:', err);
        throw err;
    }
}

async function handleGlobalCheers(interaction, guildId) {
    try {
        const [globalStats] = await pool.execute(
            `SELECT SUM(count) as total_tokes, COUNT(DISTINCT guild_id) as server_count, COUNT(DISTINCT user_id) as unique_users FROM tokes`
        );

        const [globalLeaderboard] = await pool.execute(
            `SELECT user_id, SUM(count) as total_count FROM tokes GROUP BY user_id ORDER BY total_count DESC LIMIT 10`
        );

        const [serverStats] = await pool.execute(
            `SELECT SUM(count) as server_tokes FROM tokes WHERE guild_id = ?`,
            [guildId]
        );

        let totalServers = 0;
        if (global.botManager && typeof global.botManager.getTotalGuildCount === 'function') {
            totalServers = global.botManager.getTotalGuildCount();
        } else if (interaction.client && interaction.client.guilds) {
            totalServers = interaction.client.guilds.cache.size;
        }

        const totalTokes = globalStats[0]?.total_tokes || 0;
        const serversWithTokes = globalStats[0]?.server_count || 0;
        const uniqueUsers = globalStats[0]?.unique_users || 0;
        const serverTokes = serverStats[0]?.server_tokes || 0;

        let leaderboard = 'No tokes recorded yet!';
        if (globalLeaderboard && globalLeaderboard.length > 0) {
            leaderboard = globalLeaderboard.map((r, i) => {
                const medal = i === 0 ? '\ud83e\udd47' : i === 1 ? '\ud83e\udd48' : i === 2 ? '\ud83e\udd49' : `${i + 1}.`;
                return `${medal} <@${r.user_id}>: **${r.total_count.toLocaleString()} tokes**`;
            }).join('\n');
        }

        const embed = new EmbedBuilder()
            .setColor(0x2ecc71)
            .setTitle('\ud83c\udf0d Global Cheers Statistics')
            .setDescription(leaderboard)
            .addFields(
                { name: '\ud83d\udd25 Total Tokes', value: `**${totalTokes.toLocaleString()}**`, inline: true },
                { name: '\ud83d\udc65 Unique Tokers', value: `**${uniqueUsers.toLocaleString()}**`, inline: true },
                { name: '\ud83c\udf10 Total Servers', value: `**${totalServers.toLocaleString()}**`, inline: true },
                { name: '\ud83d\udcca Servers with Tokes', value: `**${serversWithTokes.toLocaleString()}**`, inline: true },
                { name: '\ud83c\udfe0 This Server', value: `**${serverTokes.toLocaleString()} tokes**`, inline: true }
            )
            .setFooter({ text: 'Global statistics across all CertiFried bot instances' })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
    } catch (err) {
        console.error('Error in globalcheers:', err);
        throw err;
    }
}

// ===== STONED THOUGHTS =====
async function handleStonedThought(interaction, guildId) {
    try {
        const [thoughts] = await pool.execute(
            `SELECT thought_text FROM stoned_thoughts WHERE (guild_id = ? OR guild_id = '0') AND is_approved = 1 ORDER BY RAND() LIMIT 1`,
            [guildId]
        );

        if (!thoughts || thoughts.length === 0) {
            return interaction.reply('No stoned thoughts yet! Add one with `/cannabis thoughts add`');
        }

        const embed = new EmbedBuilder()
            .setColor(0x9b59b6)
            .setTitle('\ud83d\udcad Stoned Thought')
            .setDescription(thoughts[0].thought_text)
            .setFooter({ text: 'Deep thoughts from the community' });

        await interaction.reply({ embeds: [embed] });
    } catch (err) {
        console.error('Error in stonedthought:', err);
        throw err;
    }
}

async function handleAddThought(interaction, guildId, userId) {
    const thought = interaction.options.getString('thought');

    try {
        await pool.execute(
            `INSERT INTO stoned_thoughts (guild_id, user_id, thought_text, is_approved) VALUES (?, ?, ?, 1)`,
            [guildId, userId, thought]
        );

        await interaction.reply('\u2705 Your stoned thought has been added!');
    } catch (err) {
        console.error('Error adding thought:', err);
        throw err;
    }
}

// ===== TRIVIA =====
async function handleTrivia(interaction, guildId) {
    try {
        const [active] = await pool.execute(
            `SELECT question FROM active_trivia WHERE guild_id = ?`,
            [guildId]
        );

        if (active && active.length > 0) {
            return interaction.reply({ content: 'A trivia question is already active! Answer it first.', ephemeral: true });
        }

        const [questions] = await pool.execute(
            `SELECT * FROM trivia_questions ORDER BY RAND() LIMIT 1`
        );

        if (!questions || questions.length === 0) {
            return interaction.reply('No trivia questions available!');
        }

        const question = questions[0];
        const incorrectAnswers = JSON.parse(question.incorrect_answers || '[]');
        const allAnswers = [question.correct_answer, ...incorrectAnswers];
        const shuffled = allAnswers.sort(() => Math.random() - 0.5);

        const answerMap = {};
        const letters = ['A', 'B', 'C', 'D'];
        shuffled.forEach((ans, i) => {
            if (i < 4) answerMap[letters[i]] = ans;
        });

        const correctLetter = Object.keys(answerMap).find(key => answerMap[key] === question.correct_answer);

        await pool.execute(
            `INSERT INTO active_trivia (guild_id, question, answer) VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE question = ?, answer = ?`,
            [guildId, question.question, correctLetter, question.question, correctLetter]
        );

        const embed = new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle('\ud83e\udde0 Cannabis Trivia!')
            .setDescription(question.question)
            .addFields(
                { name: 'A', value: answerMap['A'] || 'N/A', inline: true },
                { name: 'B', value: answerMap['B'] || 'N/A', inline: true },
                { name: 'C', value: answerMap['C'] || 'N/A', inline: true },
                { name: 'D', value: answerMap['D'] || 'N/A', inline: true }
            )
            .setFooter({ text: 'Answer with /cannabis trivia answer <A/B/C/D>' });

        await interaction.reply({ embeds: [embed] });
    } catch (err) {
        console.error('Error in trivia:', err);
        throw err;
    }
}

async function handleTriviaAnswer(interaction, guildId, userId) {
    const answer = interaction.options.getString('answer').toUpperCase();

    try {
        const [active] = await pool.execute(
            `SELECT answer FROM active_trivia WHERE guild_id = ?`,
            [guildId]
        );

        if (!active || active.length === 0) {
            return interaction.reply({ content: 'No active trivia question! Start one with `/cannabis trivia start`', ephemeral: true });
        }

        const correctAnswer = active[0].answer;
        const isCorrect = answer === correctAnswer;

        if (isCorrect) {
            await pool.execute(
                `INSERT INTO trivia_scores (guild_id, user_id, score) VALUES (?, ?, 1)
                 ON DUPLICATE KEY UPDATE score = score + 1`,
                [guildId, userId]
            );

            await pool.execute(`DELETE FROM active_trivia WHERE guild_id = ?`, [guildId]);

            await interaction.reply(`\u2705 Correct! <@${userId}> got it right! \ud83c\udf89`);
        } else {
            await interaction.reply(`\u274c Wrong! The correct answer was **${correctAnswer}**.`);
        }
    } catch (err) {
        console.error('Error answering trivia:', err);
        throw err;
    }
}

async function handleTriviaScore(interaction, guildId, userId) {
    try {
        const [score] = await pool.execute(
            `SELECT score FROM trivia_scores WHERE guild_id = ? AND user_id = ?`,
            [guildId, userId]
        );

        const totalScore = score && score.length > 0 ? score[0].score : 0;

        const embed = new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle('\ud83e\udde0 Your Trivia Score')
            .setDescription(`<@${userId}> has answered **${totalScore}** questions correctly!`)
            .setFooter({ text: 'Keep playing to increase your score!' });

        await interaction.reply({ embeds: [embed] });
    } catch (err) {
        console.error('Error fetching score:', err);
        throw err;
    }
}

async function handleTriviaTop(interaction, guildId) {
    try {
        const [results] = await pool.execute(
            `SELECT user_id, score FROM trivia_scores WHERE guild_id = ? ORDER BY score DESC LIMIT 10`,
            [guildId]
        );

        if (!results || results.length === 0) {
            return interaction.reply('No trivia scores yet!');
        }

        const leaderboard = results.map((r, i) => `${i + 1}. <@${r.user_id}>: **${r.score} correct**`).join('\n');

        const embed = new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle('\ud83c\udfc6 Trivia Leaderboard')
            .setDescription(leaderboard)
            .setFooter({ text: 'Top trivia masters' });

        await interaction.reply({ embeds: [embed] });
    } catch (err) {
        console.error('Error fetching trivia top:', err);
        throw err;
    }
}
