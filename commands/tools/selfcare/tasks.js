import { EmbedBuilder } from 'discord.js';
import pool from '../../../utils/db.js';

export async function execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
        case 'addtask':
            return handleAddTask(interaction);
        case 'tasks':
            return handleViewTasks(interaction);
        case 'complete':
            return handleCompleteTask(interaction);
        case 'delete':
            return handleDeleteTask(interaction);
        case 'clear':
            return handleClearCompleted(interaction);
        case 'stats':
            return handleStats(interaction);
    }
}

async function handleAddTask(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const task = interaction.options.getString('task');
    const priority = interaction.options.getString('priority') || 'medium';
    const dueDate = interaction.options.getString('due');
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    // Validate task length
    if (task.length > 500) {
        return interaction.editReply({
            content: '❌ Task description is too long. Please limit to 500 characters.'
        });
    }

    // Validate date format if provided
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
        return interaction.editReply({
            content: '❌ Invalid date format. Please use YYYY-MM-DD (e.g., 2024-12-31).'
        });
    }

    try {
        // Create tasks table if it doesn't exist
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS productivity_tasks (
                id INT AUTO_INCREMENT PRIMARY KEY,
                guild_id VARCHAR(20) NOT NULL,
                user_id VARCHAR(20) NOT NULL,
                task_description TEXT NOT NULL,
                priority VARCHAR(10) DEFAULT 'medium',
                due_date DATE,
                completed BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                completed_at TIMESTAMP NULL,
                INDEX idx_user_tasks (guild_id, user_id, completed)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);

        // Insert task
        const [result] = await pool.execute(
            'INSERT INTO productivity_tasks (guild_id, user_id, task_description, priority, due_date) VALUES (?, ?, ?, ?, ?)',
            [guildId, userId, task, priority, dueDate]
        );

        const priorityEmojis = {
            high: '🔴',
            medium: '🟡',
            low: '🟢'
        };

        const embed = new EmbedBuilder()
            .setColor('#2ECC71')
            .setTitle('✅ Task Added!')
            .addFields(
                {
                    name: '📝 Task',
                    value: task,
                    inline: false
                },
                {
                    name: '🎯 Priority',
                    value: `${priorityEmojis[priority]} ${priority.charAt(0).toUpperCase() + priority.slice(1)}`,
                    inline: true
                },
                {
                    name: '📅 Due Date',
                    value: dueDate || 'Not set',
                    inline: true
                },
                {
                    name: '🆔 Task ID',
                    value: `#${result.insertId}`,
                    inline: true
                }
            )
            .setFooter({ text: 'Use /selfcare tasks tasks to view all your tasks' })
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });

    } catch (error) {
        console.error('[Tasks Add Task Error]', error);
        return interaction.editReply({
            content: '❌ Failed to add task. Please try again later.'
        });
    }
}

async function handleViewTasks(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const filter = interaction.options.getString('filter') || 'active';
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    try {
        let query = 'SELECT id, task_description, priority, due_date, completed, created_at FROM productivity_tasks WHERE guild_id = ? AND user_id = ?';
        const params = [guildId, userId];

        // Apply filters
        if (filter === 'active') {
            query += ' AND completed = FALSE';
        } else if (filter === 'completed') {
            query += ' AND completed = TRUE';
        } else if (filter === 'high') {
            query += ' AND priority = "high" AND completed = FALSE';
        } else if (filter === 'overdue') {
            query += ' AND completed = FALSE AND due_date < CURDATE()';
        }

        query += ' ORDER BY priority DESC, due_date ASC, created_at ASC LIMIT 20';

        const [tasks] = await pool.execute(query, params);

        if (tasks.length === 0) {
            return interaction.editReply({
                content: filter === 'completed'
                    ? '📋 No completed tasks found. Complete some tasks to see them here!'
                    : '📋 No tasks found. Use `/selfcare tasks addtask` to add your first task!'
            });
        }

        const priorityEmojis = {
            high: '🔴',
            medium: '🟡',
            low: '🟢'
        };

        const embed = new EmbedBuilder()
            .setColor('#3498DB')
            .setTitle(`📋 Your Tasks - ${filter.charAt(0).toUpperCase() + filter.slice(1)}`)
            .setDescription(`Showing ${tasks.length} task${tasks.length > 1 ? 's' : ''}`)
            .setFooter({ text: 'Use /selfcare tasks complete <id> to mark tasks complete' })
            .setTimestamp();

        tasks.forEach(task => {
            const status = task.completed ? '✅' : '⬜';
            const priority = `${priorityEmojis[task.priority]}`;
            const dueDate = task.due_date ? new Date(task.due_date).toLocaleDateString() : 'No due date';
            const overdue = !task.completed && task.due_date && new Date(task.due_date) < new Date() ? ' ⚠️ OVERDUE' : '';

            embed.addFields({
                name: `${status} ${priority} #${task.id} - ${task.task_description.substring(0, 50)}${task.task_description.length > 50 ? '...' : ''}`,
                value: `**Due:** ${dueDate}${overdue}\n**Added:** ${new Date(task.created_at).toLocaleDateString()}`,
                inline: false
            });
        });

        return interaction.editReply({ embeds: [embed] });

    } catch (error) {
        console.error('[Tasks View Tasks Error]', error);
        return interaction.editReply({
            content: '❌ Failed to load tasks. Please try again later.'
        });
    }
}

async function handleCompleteTask(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const taskId = interaction.options.getInteger('taskid');
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    try {
        // Get task details
        const [[task]] = await pool.execute(
            'SELECT task_description, completed FROM productivity_tasks WHERE id = ? AND guild_id = ? AND user_id = ?',
            [taskId, guildId, userId]
        );

        if (!task) {
            return interaction.editReply({
                content: `❌ Task #${taskId} not found. Use \`/selfcare tasks tasks\` to see your task IDs.`
            });
        }

        if (task.completed) {
            return interaction.editReply({
                content: `❌ Task #${taskId} is already completed!`
            });
        }

        // Mark as completed
        await pool.execute(
            'UPDATE productivity_tasks SET completed = TRUE, completed_at = NOW() WHERE id = ?',
            [taskId]
        );

        const embed = new EmbedBuilder()
            .setColor('#2ECC71')
            .setTitle('🎉 Task Completed!')
            .setDescription(`**${task.task_description}**`)
            .addFields({
                name: '✅ Status',
                value: 'Marked as complete',
                inline: true
            })
            .setFooter({ text: 'Keep up the great work!' })
            .setTimestamp();

        return interaction.editReply({ embeds: [embed] });

    } catch (error) {
        console.error('[Tasks Complete Task Error]', error);
        return interaction.editReply({
            content: '❌ Failed to complete task. Please try again later.'
        });
    }
}

async function handleDeleteTask(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const taskId = interaction.options.getInteger('taskid');
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    try {
        // Delete task
        const [result] = await pool.execute(
            'DELETE FROM productivity_tasks WHERE id = ? AND guild_id = ? AND user_id = ?',
            [taskId, guildId, userId]
        );

        if (result.affectedRows === 0) {
            return interaction.editReply({
                content: `❌ Task #${taskId} not found. Use \`/selfcare tasks tasks\` to see your task IDs.`
            });
        }

        return interaction.editReply({
            content: `✅ Task #${taskId} has been deleted.`
        });

    } catch (error) {
        console.error('[Tasks Delete Task Error]', error);
        return interaction.editReply({
            content: '❌ Failed to delete task. Please try again later.'
        });
    }
}

async function handleClearCompleted(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    try {
        const [result] = await pool.execute(
            'DELETE FROM productivity_tasks WHERE guild_id = ? AND user_id = ? AND completed = TRUE',
            [guildId, userId]
        );

        if (result.affectedRows === 0) {
            return interaction.editReply({
                content: '📋 No completed tasks to clear.'
            });
        }

        return interaction.editReply({
            content: `✅ Cleared ${result.affectedRows} completed task${result.affectedRows > 1 ? 's' : ''} from your list.`
        });

    } catch (error) {
        console.error('[Tasks Clear Error]', error);
        return interaction.editReply({
            content: '❌ Failed to clear completed tasks. Please try again later.'
        });
    }
}

async function handleStats(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    try {
        // Get statistics
        const [[stats]] = await pool.execute(`
            SELECT
                COUNT(*) as total_tasks,
                SUM(completed) as completed_tasks,
                SUM(CASE WHEN completed = FALSE THEN 1 ELSE 0 END) as active_tasks,
                SUM(CASE WHEN completed = FALSE AND due_date < CURDATE() THEN 1 ELSE 0 END) as overdue_tasks,
                SUM(CASE WHEN priority = 'high' AND completed = FALSE THEN 1 ELSE 0 END) as high_priority
            FROM productivity_tasks
            WHERE guild_id = ? AND user_id = ?
        `, [guildId, userId]);

        if (!stats || stats.total_tasks === 0) {
            return interaction.editReply({
                content: '📊 No productivity data yet. Start adding tasks with `/selfcare tasks addtask`!'
            });
        }

        const completionRate = stats.total_tasks > 0
            ? Math.round((stats.completed_tasks / stats.total_tasks) * 100)
            : 0;

        const embed = new EmbedBuilder()
            .setColor('#9B59B6')
            .setTitle('📊 Your Productivity Statistics')
            .addFields(
                {
                    name: '📋 Tasks Overview',
                    value: `**Total Tasks:** ${stats.total_tasks}\n**Completed:** ${stats.completed_tasks}\n**Active:** ${stats.active_tasks}`,
                    inline: true
                },
                {
                    name: '📈 Performance',
                    value: `**Completion Rate:** ${completionRate}%\n**Overdue:** ${stats.overdue_tasks}\n**High Priority:** ${stats.high_priority}`,
                    inline: true
                }
            )
            .setFooter({ text: 'Keep track of your progress!' })
            .setTimestamp();

        // Add motivational message
        if (completionRate >= 80) {
            embed.setDescription('🌟 **Outstanding!** You\'re crushing your task list!');
        } else if (completionRate >= 60) {
            embed.setDescription('💪 **Great work!** You\'re making solid progress!');
        } else if (stats.overdue_tasks > 0) {
            embed.setDescription('⚠️ **Heads up!** You have overdue tasks. Focus on those first!');
        } else {
            embed.setDescription('📈 **Keep going!** Every completed task is progress!');
        }

        return interaction.editReply({ embeds: [embed] });

    } catch (error) {
        console.error('[Tasks Stats Error]', error);
        return interaction.editReply({
            content: '❌ Failed to load statistics. Please try again later.'
        });
    }
}
