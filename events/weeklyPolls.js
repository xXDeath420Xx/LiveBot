/**
 * Weekly Auto-Polls
 * Posts engaging community polls on a schedule
 *
 * IMPORTANT: This feature is ONLY enabled for the Growmie server
 * Server ID: 1452972683867459657
 * Bot ID: 1452969400620683276
 */

import { EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';

// STRICT RESTRICTION: Only these IDs are allowed
const ALLOWED_GUILD_ID = '1452972683867459657';
const ALLOWED_BOT_ID = '1452969400620683276';

// Poll topics for the grow community
const POLL_TOPICS = [
    {
        question: "What's your preferred growing medium?",
        options: ['🌱 Soil', '🥥 Coco Coir', '💧 Hydro/DWC', '🪨 Rockwool']
    },
    {
        question: "What size tent/space do you grow in?",
        options: ['2x2 or smaller', '2x4 / 3x3', '4x4 / 4x8', '5x5 or larger']
    },
    {
        question: "How many plants do you typically run?",
        options: ['1-2 plants', '3-4 plants', '5-8 plants', '9+ plants']
    },
    {
        question: "What's your preferred light type?",
        options: ['💡 LED', '🔆 HPS/HID', '✨ CMH/LEC', '🌞 Sunlight (outdoor)']
    },
    {
        question: "How long do you typically veg?",
        options: ['2-3 weeks', '4-5 weeks', '6-8 weeks', '8+ weeks']
    },
    {
        question: "Do you grow photos or autos?",
        options: ['📸 Photoperiods only', '⚡ Autoflowers only', '🔄 Both', '🤔 Still deciding']
    },
    {
        question: "What's your biggest grow challenge?",
        options: ['🐛 Pests', '🍽️ Nutrients/Feeding', '🌡️ Environment', '⏰ Time/Patience']
    },
    {
        question: "Favorite training technique?",
        options: ['✂️ Topping/FIM', '🌿 LST only', '🕸️ SCROG', '🌳 Natural/None']
    },
    {
        question: "What nutrient line do you use?",
        options: ['🧪 Synthetic/Salt-based', '🌱 Organic/Living soil', '🔬 Hybrid approach', '💧 Just water']
    },
    {
        question: "Indoor or outdoor grower?",
        options: ['🏠 Indoor only', '🌳 Outdoor only', '🔄 Both', '🌿 Greenhouse']
    },
    {
        question: "How do you cure your harvest?",
        options: ['🫙 Mason jars', '🧺 Grove bags', '📦 Boveda packs', '🤷 Dry and done']
    },
    {
        question: "What's your grow priority?",
        options: ['📊 Maximum yield', '💎 Top quality', '⚡ Quick harvests', '🎨 Variety of strains']
    }
];

// Track which polls have been used recently
let recentPolls = [];
let lastPollDate = null;

export default {
    name: 'ready',
    once: true,
    async execute(client) {
        // Check every hour if it's time to post
        setInterval(() => checkAndPostPoll(client), 60 * 60 * 1000);

        // Initial check after 10 minutes
        setTimeout(() => checkAndPostPoll(client), 10 * 60 * 1000);

        logger.info('[WeeklyPolls] Weekly poll system initialized');
    }
};

async function checkAndPostPoll(client) {
    // STRICT CHECK: Only run for the allowed bot
    if (client.user.id !== ALLOWED_BOT_ID) {
        return; // Silently ignore - this bot is not allowed to post grow polls
    }

    const now = new Date();

    // Post on Sundays at 6PM UTC
    if (now.getUTCDay() !== 0 || now.getUTCHours() !== 18) return;

    // Check if we already posted this week
    const today = now.toISOString().split('T')[0];
    if (lastPollDate === today) return;

    // STRICT CHECK: Only post in the allowed guild
    const allowedGuild = client.guilds.cache.get(ALLOWED_GUILD_ID);
    if (!allowedGuild) {
        logger.warn(`[WeeklyPolls] Allowed guild ${ALLOWED_GUILD_ID} not found - skipping poll`);
        return;
    }

    try {
        await postWeeklyPoll(allowedGuild);
        lastPollDate = today;
    } catch (error) {
        logger.error(`[WeeklyPolls] Failed to post poll in ${allowedGuild.name}:`, error);
    }
}

async function postWeeklyPoll(guild) {
    // STRICT DOUBLE-CHECK: Only allowed guild
    if (guild.id !== ALLOWED_GUILD_ID) {
        logger.warn(`[WeeklyPolls] BLOCKED: Attempted to post poll in unauthorized guild ${guild.id} (${guild.name})`);
        return;
    }

    // Find appropriate channel
    const pollChannel = guild.channels.cache.find(c =>
        c.name.includes('poll') ||
        c.name.includes('general') ||
        c.name.includes('chat') ||
        c.name.includes('lounge')
    );

    if (!pollChannel || !pollChannel.isTextBased()) return;

    // Check if channel supports polls
    if (!pollChannel.permissionsFor(guild.members.me)?.has('SendMessages')) return;

    // Get a poll that hasn't been used recently
    let availablePolls = POLL_TOPICS.filter((_, i) => !recentPolls.includes(i));
    if (availablePolls.length === 0) {
        recentPolls = [];
        availablePolls = POLL_TOPICS;
    }

    const pollIndex = POLL_TOPICS.indexOf(availablePolls[Math.floor(Math.random() * availablePolls.length)]);
    const poll = POLL_TOPICS[pollIndex];

    recentPolls.push(pollIndex);
    if (recentPolls.length > Math.floor(POLL_TOPICS.length / 2)) {
        recentPolls.shift();
    }

    // Create the poll using Discord's native poll feature
    try {
        await pollChannel.send({
            poll: {
                question: { text: `🌿 Weekly Poll: ${poll.question}` },
                answers: poll.options.map(opt => ({ text: opt })),
                duration: 168, // 7 days (168 hours)
                allowMultiselect: false
            }
        });

        logger.info(`[WeeklyPolls] Posted poll in ${guild.name}: ${poll.question}`);
    } catch (error) {
        // Fallback to embed-based poll if native polls not supported
        const embed = new EmbedBuilder()
            .setColor(0x9B59B6)
            .setTitle(`📊 Weekly Poll`)
            .setDescription(`**${poll.question}**\n\n${poll.options.map((opt, i) => `${['1️⃣', '2️⃣', '3️⃣', '4️⃣'][i]} ${opt}`).join('\n')}`)
            .setFooter({ text: 'React to vote!' })
            .setTimestamp();

        const message = await pollChannel.send({ embeds: [embed] });

        // Add reactions for voting
        const reactions = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
        for (let i = 0; i < poll.options.length; i++) {
            await message.react(reactions[i]);
        }

        logger.info(`[WeeklyPolls] Posted fallback poll in ${guild.name}: ${poll.question}`);
    }
}

// Export function to manually trigger a poll
// STRICT: Only allowed in the specified guild
export async function postPollNow(channel) {
    // STRICT CHECK: Only allowed guild
    if (channel.guild?.id !== ALLOWED_GUILD_ID) {
        logger.warn(`[WeeklyPolls] BLOCKED postPollNow: Unauthorized guild ${channel.guild?.id}`);
        throw new Error('Weekly grow polls are only enabled for the Growmie server');
    }

    // STRICT CHECK: Only allowed bot
    if (channel.client?.user?.id !== ALLOWED_BOT_ID) {
        logger.warn(`[WeeklyPolls] BLOCKED postPollNow: Unauthorized bot ${channel.client?.user?.id}`);
        throw new Error('Weekly grow polls can only be posted by the designated bot');
    }

    const poll = POLL_TOPICS[Math.floor(Math.random() * POLL_TOPICS.length)];

    try {
        await channel.send({
            poll: {
                question: { text: `🌿 ${poll.question}` },
                answers: poll.options.map(opt => ({ text: opt })),
                duration: 24,
                allowMultiselect: false
            }
        });
        return true;
    } catch {
        // Fallback
        const embed = new EmbedBuilder()
            .setColor(0x9B59B6)
            .setTitle(`📊 Community Poll`)
            .setDescription(`**${poll.question}**\n\n${poll.options.map((opt, i) => `${['1️⃣', '2️⃣', '3️⃣', '4️⃣'][i]} ${opt}`).join('\n')}`)
            .setFooter({ text: 'React to vote!' });

        const message = await channel.send({ embeds: [embed] });
        const reactions = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
        for (let i = 0; i < poll.options.length; i++) {
            await message.react(reactions[i]);
        }
        return true;
    }
}
