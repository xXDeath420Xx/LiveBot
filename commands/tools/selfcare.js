import { SlashCommandBuilder } from 'discord.js';
import { execute as handleHabit } from './selfcare/habit.js';
import { execute as handleChallenges } from './selfcare/challenges.js';
import { execute as handleWellness } from './selfcare/wellness.js';
import { execute as handleTasks } from './selfcare/tasks.js';
import logger from '../../utils/logger.js';

export default {
    category: 'tools',
    data: new SlashCommandBuilder()
        .setName('selfcare')
        .setDescription('Self-care toolkit — habits, challenges, wellness & task management')

        // ── Habit Tracking Group ──
        .addSubcommandGroup(group =>
            group.setName('habit')
                .setDescription('Track your daily habits')
                .addSubcommand(sub =>
                    sub.setName('add')
                        .setDescription('Add a new habit to track')
                        .addStringOption(opt =>
                            opt.setName('name')
                                .setDescription('Habit name')
                                .setRequired(true)
                                .setMaxLength(100))
                        .addStringOption(opt =>
                            opt.setName('description')
                                .setDescription('Description (optional)')
                                .setRequired(false)
                                .setMaxLength(500)))
                .addSubcommand(sub =>
                    sub.setName('complete')
                        .setDescription('Mark a habit as completed for today')
                        .addStringOption(opt =>
                            opt.setName('name')
                                .setDescription('Habit name')
                                .setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('list')
                        .setDescription('View your habits and streaks'))
                .addSubcommand(sub =>
                    sub.setName('delete')
                        .setDescription('Delete a habit')
                        .addStringOption(opt =>
                            opt.setName('name')
                                .setDescription('Habit name')
                                .setRequired(true))))

        // ── Daily Challenges Group ──
        .addSubcommandGroup(group =>
            group.setName('challenges')
                .setDescription('View and manage your daily challenges')
                .addSubcommand(sub =>
                    sub.setName('view')
                        .setDescription('View your daily challenges'))
                .addSubcommand(sub =>
                    sub.setName('stats')
                        .setDescription('View your challenge statistics')
                        .addUserOption(opt =>
                            opt.setName('user')
                                .setDescription('User to view stats for (defaults to you)')
                                .setRequired(false)))
                .addSubcommand(sub =>
                    sub.setName('claim')
                        .setDescription('Claim rewards for a completed challenge')
                        .addIntegerOption(opt =>
                            opt.setName('challenge')
                                .setDescription('Challenge number to claim (1, 2, or 3)')
                                .setRequired(true)
                                .setMinValue(1)
                                .setMaxValue(3))))

        // ── Wellness Group ──
        .addSubcommandGroup(group =>
            group.setName('wellness')
                .setDescription('Mental health and wellness tools')
                .addSubcommand(sub =>
                    sub.setName('affirmation')
                        .setDescription('Get a daily positive affirmation')
                        .addStringOption(opt =>
                            opt.setName('category')
                                .setDescription('Affirmation category')
                                .setRequired(false)
                                .addChoices(
                                    { name: 'General', value: 'general' },
                                    { name: 'Confidence', value: 'confidence' },
                                    { name: 'Success', value: 'success' },
                                    { name: 'Love', value: 'love' },
                                    { name: 'Health', value: 'health' },
                                    { name: 'Gratitude', value: 'gratitude' }
                                )))
                .addSubcommand(sub =>
                    sub.setName('mood')
                        .setDescription('Track your current mood')
                        .addStringOption(opt =>
                            opt.setName('feeling')
                                .setDescription('How are you feeling?')
                                .setRequired(true)
                                .addChoices(
                                    { name: 'Great', value: 'great' },
                                    { name: 'Good', value: 'good' },
                                    { name: 'Okay', value: 'okay' },
                                    { name: 'Down', value: 'down' },
                                    { name: 'Terrible', value: 'terrible' }
                                ))
                        .addStringOption(opt =>
                            opt.setName('note')
                                .setDescription('Optional note about your mood')
                                .setRequired(false)))
                .addSubcommand(sub =>
                    sub.setName('moodstats')
                        .setDescription('View your mood tracking statistics')
                        .addIntegerOption(opt =>
                            opt.setName('days')
                                .setDescription('Number of days to look back (default: 7)')
                                .setRequired(false)
                                .setMinValue(1)
                                .setMaxValue(30)))
                .addSubcommand(sub =>
                    sub.setName('breathe')
                        .setDescription('Guided breathing exercise')
                        .addStringOption(opt =>
                            opt.setName('type')
                                .setDescription('Breathing technique')
                                .setRequired(false)
                                .addChoices(
                                    { name: '4-7-8 Relaxing Breath', value: '478' },
                                    { name: 'Box Breathing (4-4-4-4)', value: 'box' },
                                    { name: 'Simple Deep Breathing', value: 'simple' }
                                )))
                .addSubcommand(sub =>
                    sub.setName('pomodoro')
                        .setDescription('Start a Pomodoro focus timer session')
                        .addIntegerOption(opt =>
                            opt.setName('duration')
                                .setDescription('Work duration in minutes (default: 25)')
                                .setRequired(false)
                                .setMinValue(1)
                                .setMaxValue(60))
                        .addIntegerOption(opt =>
                            opt.setName('break')
                                .setDescription('Break duration in minutes (default: 5)')
                                .setRequired(false)
                                .setMinValue(1)
                                .setMaxValue(30)))
                .addSubcommand(sub =>
                    sub.setName('pomostat')
                        .setDescription('View your Pomodoro session statistics')))

        // ── Tasks Group (from productivity) ──
        .addSubcommandGroup(group =>
            group.setName('tasks')
                .setDescription('Task management and productivity tools')
                .addSubcommand(sub =>
                    sub.setName('addtask')
                        .setDescription('Add a task to your todo list')
                        .addStringOption(opt =>
                            opt.setName('task')
                                .setDescription('Task description')
                                .setRequired(true))
                        .addStringOption(opt =>
                            opt.setName('priority')
                                .setDescription('Task priority')
                                .setRequired(false)
                                .addChoices(
                                    { name: 'High', value: 'high' },
                                    { name: 'Medium', value: 'medium' },
                                    { name: 'Low', value: 'low' }
                                ))
                        .addStringOption(opt =>
                            opt.setName('due')
                                .setDescription('Due date (YYYY-MM-DD format)')
                                .setRequired(false)))
                .addSubcommand(sub =>
                    sub.setName('tasks')
                        .setDescription('View your todo list')
                        .addStringOption(opt =>
                            opt.setName('filter')
                                .setDescription('Filter tasks')
                                .setRequired(false)
                                .addChoices(
                                    { name: 'All Tasks', value: 'all' },
                                    { name: 'Active Only', value: 'active' },
                                    { name: 'Completed Only', value: 'completed' },
                                    { name: 'High Priority', value: 'high' },
                                    { name: 'Overdue', value: 'overdue' }
                                )))
                .addSubcommand(sub =>
                    sub.setName('complete')
                        .setDescription('Mark a task as complete')
                        .addIntegerOption(opt =>
                            opt.setName('taskid')
                                .setDescription('Task ID number')
                                .setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('delete')
                        .setDescription('Delete a task')
                        .addIntegerOption(opt =>
                            opt.setName('taskid')
                                .setDescription('Task ID number')
                                .setRequired(true)))
                .addSubcommand(sub =>
                    sub.setName('clear')
                        .setDescription('Clear completed tasks from your list'))
                .addSubcommand(sub =>
                    sub.setName('stats')
                        .setDescription('View your productivity statistics'))),

    async execute(interaction) {
        const group = interaction.options.getSubcommandGroup();

        try {
            switch (group) {
                case 'habit':
                    return await handleHabit(interaction);
                case 'challenges':
                    return await handleChallenges(interaction);
                case 'wellness':
                    return await handleWellness(interaction);
                case 'tasks':
                    return await handleTasks(interaction);
            }
        } catch (error) {
            logger.error('[Selfcare Command] Error:', { error: error.message, group, stack: error.stack });

            const reply = { content: `Error: ${error.message}`, ephemeral: true };
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(reply);
            } else {
                await interaction.reply(reply);
            }
        }
    }
};
