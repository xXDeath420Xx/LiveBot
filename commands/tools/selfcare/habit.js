import { EmbedBuilder } from 'discord.js';
import pool from '../../../utils/db.js';

export async function execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
        case 'add':
            return handleAdd(interaction);
        case 'complete':
            return handleComplete(interaction);
        case 'list':
            return handleList(interaction);
        case 'delete':
            return handleDelete(interaction);
    }
}

async function handleAdd(interaction) {
    const name = interaction.options.getString('name');
    const description = interaction.options.getString('description');

    await interaction.deferReply({ ephemeral: true });

    await pool.execute(
        `INSERT INTO habits (user_id, guild_id, habit_name, description)
         VALUES (?, ?, ?, ?)`,
        [interaction.user.id, interaction.guild.id, name, description]
    );

    return interaction.editReply({
        content: `✅ Habit **${name}** added! Use \`/selfcare habit complete\` to mark it as done each day.`
    });
}

async function handleComplete(interaction) {
    const name = interaction.options.getString('name');

    await interaction.deferReply();

    // Get habit
    const [[habit]] = await pool.execute(
        'SELECT * FROM habits WHERE user_id = ? AND guild_id = ? AND habit_name = ?',
        [interaction.user.id, interaction.guild.id, name]
    );

    if (!habit) {
        return interaction.editReply({
            content: `❌ Habit **${name}** not found.`
        });
    }

    // Check if already completed today
    const [[existing]] = await pool.execute(
        'SELECT * FROM habit_completions WHERE habit_id = ? AND completed_date = CURDATE()',
        [habit.id]
    );

    if (existing) {
        return interaction.editReply({
            content: `❌ You already completed **${name}** today!`
        });
    }

    // Mark as completed
    await pool.execute(
        'INSERT INTO habit_completions (habit_id, completed_date) VALUES (?, CURDATE())',
        [habit.id]
    );

    // Update streak
    const newStreak = habit.streak + 1;
    const longestStreak = Math.max(newStreak, habit.longest_streak);

    await pool.execute(
        'UPDATE habits SET streak = ?, longest_streak = ?, total_completions = total_completions + 1 WHERE id = ?',
        [newStreak, longestStreak, habit.id]
    );

    return interaction.editReply({
        content: `✅ **${name}** completed!\n🔥 Current Streak: ${newStreak} days\n🏆 Longest Streak: ${longestStreak} days`
    });
}

async function handleList(interaction) {
    await interaction.deferReply();

    const [habits] = await pool.execute(
        'SELECT * FROM habits WHERE user_id = ? AND guild_id = ? ORDER BY streak DESC',
        [interaction.user.id, interaction.guild.id]
    );

    if (habits.length === 0) {
        return interaction.editReply({
            content: 'You don\'t have any habits yet! Add one with `/selfcare habit add`'
        });
    }

    const embed = new EmbedBuilder()
        .setColor('#57F287')
        .setTitle('🎯 Your Habits')
        .setTimestamp();

    const habitList = habits.map(h => {
        return `**${h.habit_name}**\n🔥 Streak: ${h.streak} days | 🏆 Best: ${h.longest_streak} days | ✅ Total: ${h.total_completions}`;
    }).join('\n\n');

    embed.setDescription(habitList);

    return interaction.editReply({ embeds: [embed] });
}

async function handleDelete(interaction) {
    const name = interaction.options.getString('name');

    await interaction.deferReply({ ephemeral: true });

    const [result] = await pool.execute(
        'DELETE FROM habits WHERE user_id = ? AND guild_id = ? AND habit_name = ?',
        [interaction.user.id, interaction.guild.id, name]
    );

    if (result.affectedRows > 0) {
        return interaction.editReply({
            content: `✅ Habit **${name}** deleted.`
        });
    } else {
        return interaction.editReply({
            content: `❌ Habit **${name}** not found.`
        });
    }
}
