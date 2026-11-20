// Screenshots for the achievements guide. Formats copied from: core/achievement-manager.js (sendAchievementNotification),
// dashboard/views/partials/manage/achievements.ejs and dashboard/routes/features/achievements.js (the page and the
// GET /manage/:guildId/achievements answer it loads). The achievement names are the bot's own catalog.
export default async function ({ manage, discord, ctx, demo }) {
    const { channels, channel, member: M, D } = demo;

    const BOT = 'CertiFried Utility';
    const B = () => ctx.av('x').slice(0, -'/__demo/x.png'.length);
    const bot = (extra) => ({ username: BOT, avatarUrl: `${B()}/images/CertiFried.png`, ...extra });
    const ctxNames = {
        channels: channels.map((c) => ({ id: c.id, name: c.name })),
        roles: demo.roles.map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
        users: demo.members.map((m) => ({ id: m.id, name: m.displayName })),
    };

    // ── Discord: an unlock in the announcement channel (core/achievement-manager.js) ──
    discord('achievements-discord', () => ({
        channel: 'level-ups', ctx: ctxNames,
        messages: [bot({
            content: `<@${M.wren.id}>`,
            embeds: [{
                color: '#C0C0C0', title: '\u{1F5E3}\u{FE0F} Achievement Unlocked!', author: { name: M.wren.displayName, iconUrl: ctx.av('wren') },
                description: '**Chatterbox**\nSend 1,000 messages',
                fields: [
                    { name: 'Tier', value: 'Silver', inline: true },
                    { name: 'Points', value: '25 pts', inline: true },
                    { name: 'Rewards', value: '\u{1F4B0} 250 coins\n⭐ 250 XP' },
                ],
                timestamp: true,
            }],
        })],
    }), { alt: 'An achievement post in #level-ups: Wren Alder unlocked Chatterbox for sending 1,000 messages, a silver achievement worth 25 points, paying 250 coins and 250 XP.', guides: ['achievements'] });

    // ── Dashboard: Levels & engagement > Achievements ──
    const defs = [
        ['economy', 'Lucky Streak', 'Win 1,000 coins in a single gamble', '💰'], ['economy', 'Daily Dedication', 'Claim daily reward 30 days in a row', '📅'],
        ['economy', 'Beginner Gambler', 'Place your first bet', '🎰'], ['economy', 'Millionaire', 'Accumulate 1,000,000 coins', '💎'],
        ['fun', 'Animal Lover', 'View 50 animal pictures', '🐾'], ['fun', 'Fortune Seeker', 'Check your fortune 30 times', '🔮'], ['fun', 'Meme Lord', 'Generate 100 memes', '😂'],
        ['gaming', 'Game Researcher', 'Look up 25 games', '🎮'], ['gaming', 'Movie Buff', 'Search 50 movies/shows', '🎬'],
        ['music', 'Music Lover', 'Link your Last.fm account', '🎵'], ['music', 'Dedicated Scrobbler', 'Have 10,000+ scrobbles', '📻'],
        ['rpg', 'Duel Winner', 'Win 10 duels', '⚔️'], ['rpg', 'Adventurer', 'Complete your first quest', '🗺️'], ['rpg', 'Pokemon Master', 'Catch 100 Pokemon', '👑'],
        ['rpg', 'Pokemon Trainer', 'Catch your first Pokemon', '⚡'], ['rpg', 'Quest Master', 'Complete 50 quests', '🏅'],
        ['social', 'Chatterbox', 'Send 1,000 messages', '🗣️'], ['social', 'First Steps', 'Send your first message', '💬'], ['social', 'Social Butterfly', 'Send 10,000 messages', '🦋'],
        ['social', 'Voice Expert', 'Spend 100 hours in voice chat', '🎙️'], ['social', 'Voice Novice', 'Spend 1 hour in voice chat', '🎤'],
        ['special', 'Birthday Star', 'Celebrate your birthday', '🎂'], ['special', 'Completionist', 'Unlock 50 achievements', '🏆'], ['special', 'Early Adopter', 'Be one of the first 10 users', '⭐'],
        ['special', 'Night Owl', 'Be active between 2 AM and 5 AM', '🦉'], ['special', 'Trailblazer', 'Be one of the first 100 members', '🧭'],
    ].map(([category, name, description, icon_emoji], i) => ({ id: i + 1, category, name, description, icon_emoji }));
    const person = (k) => ({ user_id: M[k].id, username: M[k].displayName, avatar: null });
    ctx.stub(/^\/manage\/\d+\/achievements$/, () => ({
        config: { guild_id: demo.GUILD_ID, enabled: 1, announcement_channel_id: channel['level-ups'].id },
        achievements: defs,
        topUsers: [['pip', 6, 7], ['wren', 5, 6], ['hazel', 5, 7], ['thistle', 4, 5], ['rowan', 3, 4], ['sorrel', 3, 3]]
            .map(([k, done, total]) => ({ ...person(k), completed_achievements: done, total_achievements: total })),
        recentAchievements: [
            { ...person('wren'), name: 'Chatterbox', icon: '🗣️', completed_at: D(2026, 11, 18, 19, 40) },
            { ...person('pip'), name: 'Voice Novice', icon: '🎤', completed_at: D(2026, 11, 17, 22, 5) },
            { ...person('thistle'), name: 'First Steps', icon: '💬', completed_at: D(2026, 11, 16, 9, 12) },
        ],
        stats: { total_users: 212, total_progress: 980, total_completed: 641 },
    }));
    manage('achievements-page', 'achievements', {}, {
        alt: 'The Achievements page: the switch at the top on, unlocks announced in #level-ups, 26 achievements, 212 members tracked and 641 unlocks.',
        guides: ['achievements'],
    });
}
