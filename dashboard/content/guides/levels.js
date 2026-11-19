// Checked against: core/leveling-manager.js, core/leveling-settings.js, commands/community/level.js,
// commands/community/rankcard.js, utils/rank-card-generator.js, dashboard/routes/public-leaderboard.js,
// jobs/leveling-monthly-reset.js, dashboard/views/partials/manage/leveling.ejs.
export default {
    slug: 'levels',
    title: 'Levels, role rewards and rank cards',
    area: 'community',
    summary: 'Members earn XP for chatting, level up, and get roles at the levels you choose.',
    result: {
        image: 'levels-discord',
        caption: 'A level-up post with a role reward, then the rank card a member gets from /level rank.',
    },
    steps: [
        {
            title: 'Turn on leveling',
            text: [
                'Leveling is off until you turn it on. On the dashboard, open **Levels & engagement**, then **Leveling**, and switch it on.',
                'Each message earns 15 XP plus a random 0 to 9, at most once every 60 seconds per member. Change both with `xp_per_message` and `cooldown`, or on the page.',
            ],
            command: '/level setup enabled:True',
            image: 'levels-page',
        },
        {
            title: 'Choose where level-ups are announced',
            text: [
                '**Announce level-ups in** can be the channel the member was talking in, a DM to the member, a fixed channel, or nowhere. The **Message** can use `{user}` (a mention), `{username}`, `{level}` and `{server}`; the default is "Congrats {user}! You reached **Level {level}**!".',
                '**Announce every** and **Only levels with a role reward** keep the channel quiet on busy servers.',
            ],
        },
        {
            title: 'Add role rewards',
            text: [
                'In **Role rewards**, enter a **Level** and a **Role to give**, then select **Add reward**. **Earlier rewards** decides whether members keep every reward role or only the highest.',
                'The bot needs Manage Roles, and can only give roles below its own highest role.',
            ],
            command: '/level role-reward add level:15 role:@Sapling',
        },
        {
            title: 'Show rank cards',
            text: [
                'Anyone can run `/level rank` for their card, or add `user:` for someone else\'s. Members style their own card with `/rankcard`: a preset such as `/rankcard background preset name:forest`, colours with `/rankcard color`, and `/rankcard preview` to check it.',
                'The **Rank Cards** page decides whether members may customise their card and from which level.',
            ],
            command: '/level rank',
            image: 'levels-rank-card',
        },
        {
            title: 'Share the leaderboard',
            text: [
                '`/level leaderboard` shows the top 10 per page in Discord. Every server with leveling on also has a public leaderboard page at `/lb/` followed by the server ID; members who opted out of leaderboards are left out.',
            ],
            command: '/level leaderboard',
        },
    ],
    notes: [
        'Going from level L to the next takes 5 × L² + 50 × L + 100 XP, so the first level takes 155 XP and the second 220.',
        'Members also earn voice XP (5 a minute by default). It is shown separately and does not change their level. Time in voice is counted per channel, so a no-XP or boosted voice channel applies only to the time spent in it, and a bot restart does not lose it.',
        'The cooldown can be 10 to 300 seconds, on the page and in `/level setup`.',
        'For a double-XP weekend, run `/level xp-event start multiplier:2 duration:2d`.',
        'Levels can reset on a schedule (off by default; every 30 days when on). `/level reset` needs Administrator.',
    ],
    related: ['reaction-roles', 'community', 'economy'],
};
