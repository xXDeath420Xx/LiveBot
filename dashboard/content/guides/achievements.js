// Checked against: core/achievement-manager.js, commands/community/engage.js (achievement group),
// commands/community/engage-achievement-handler.js, events/messageCreate.js, events/guildMemberAdd.js,
// core/voice-activity-manager.js, commands/economy/economy-gamble-handler.js, commands/economy/economy-earn-handler.js,
// core/economy-manager.js (economyStatus), migrations/301_achievement_rewards_seed.js, migrations/432_trailblazer_achievement.js,
// dashboard/views/partials/manage/achievements.ejs, dashboard/routes/features/achievements.js, dashboard/public/js/cf-pagehead.js,
// core/page-help.js, core/manage-nav.js, core/universal-commands.js (describePath), docs/command-split-2026-11-18.md,
// core/achievement-hooks.js and its callers (H-817): commands/games/pokemon.js, handlers/critters-actions.js (quests, battles),
// commands/games/rpg/handlers/index.js (quest complete), core/rpg-pvp-manager.js (endMatch), handlers/music/lastfm.js,
// commands/fun/fun.js, commands/fun/fun-animals-handler.js, commands/info/info.js (fortune), commands/info/media/movie.js,
// commands/info/media/game.js, core/birthday-manager.js (announceBirthday).
export default {
    slug: 'achievements',
    title: 'Achievements',
    area: 'community',
    summary: 'Members earn badges for chatting, time in voice, the games and lookups they use and their birthday, and each one pays coins and XP.',
    result: {
        image: 'achievements-discord',
        caption: 'An achievement posted in the announcement channel when a member earns it, with the tier, the points and the rewards paid.',
    },
    before: [
        'Achievements work in every server without any setup: members earn them from the start. To announce them you need **Manage Server**; the page is on the dashboard under **Levels & engagement**, then **Achievements**.',
    ],
    steps: [
        {
            title: 'Announce them in a channel',
            text: [
                'Pick the **Announcement channel**, turn on **Announce unlocks** and select **Save**. Each achievement a member earns is then posted there, with a mention of the member.',
                'That switch only turns announcements on and off, so it is not at the top of the page. With it off, or with no channel set, nothing is posted, but members still earn achievements and their rewards.',
            ],
            command: '/engage achievement setup enabled:True announcement_channel:#level-ups',
            image: 'achievements-page',
        },
        {
            title: 'Know what members can earn',
            text: [
                'Achievements are counted per server, and all 26 can be earned. From chat and voice: **First Steps** (a first message), **Chatterbox** (1,000 messages), **Social Butterfly** (10,000 messages), **Voice Novice** (an hour in voice), **Voice Expert** (100 hours), **Early Adopter** and **Trailblazer** (joining while the server has at most 10 or 100 members) and **Night Owl** (a message between 2 and 5 AM, server time).',
                'From the economy: **Beginner Gambler** (a first bet), **Lucky Streak** (winning 1,000 coins or more in one bet), **Millionaire** (1,000,000 coins after a bet) and **Daily Dedication** (a 30-day daily reward streak).',
                'From the games: **Adventurer** and **Quest Master** (1 and 50 quests: a claimed `/owo quest` or a completed `/rpg quest`), **Pokemon Trainer** (a first Pokémon caught with `/pokemon catch` or found on `/pokemon adventure`; a starter does not count) and **Pokemon Master** (100 Pokémon), and **Duel Winner** (10 wins against other members in `/owo battle`, `/rpg pvp` or `/pokemon battle`).',
                'From everything else: **Music Lover** (linking Last.fm with `/music lastfm link`), **Dedicated Scrobbler** (10,000 scrobbles on a Last.fm account verified as yours: `/music lastfm link` shows **Open Last.fm** and **Verify**; checked when you verify and when you open your own `/music lastfm profile`), **Meme Lord** (100 memes from `/fun meme`, `/fun creatememe` or `/fun creative meme`), **Fortune Seeker** (30 readings from `/knowledge fortune` or `/fun astrology horoscope` and `tarot`), **Animal Lover** (50 pictures from `/fun animals search`), **Game Researcher** (25 lookups with `/media game search` or `info`), **Movie Buff** (50 lookups with `/media movie search`, `info`, `tv` or `tvinfo`), **Birthday Star** (your birthday announced by the server\'s [birthdays](/docs/guides/community)) and **Completionist** for earning 10 achievements.',
                'Each one counts only when the command worked: a search that found nothing or a game that is switched off in this server does not count. Pokémon, animal pictures and scrobbles count what you already had, so a long-time player can earn them on their next go.',
            ],
        },
        {
            title: 'Rewards',
            text: [
                'Every achievement pays coins by tier (bronze 100, silver 250, gold 500, platinum 1,000, diamond 2,500) and 10 XP for each of its points, so Chatterbox (silver, 25 points) pays 250 coins and 250 XP.',
                'Coins are paid only once you have saved the [economy](/docs/guides/economy) settings with the economy on, and XP only while [leveling](/docs/guides/levels) is on. A reward that is not paid is left off the announcement.',
            ],
        },
        {
            title: 'Check progress',
            text: [
                'Members see their badges with `/engage achievement list` (add `category:` or `user:`) and how far they are with `progress`. `leaderboard` shows the top 10 by points, `recent` the latest ones earned and `info name:` one achievement in detail. These are in the `/` menu; typing `/achievement list` as a message works too.',
            ],
            command: '/engage achievement list',
        },
    ],
    notes: [
        '`/engage achievement setup` needs Manage Server. With no options it shows the current settings; an option you leave out keeps what is saved.',
        'The dashboard **Leaderboard** ranks members by achievements earned, and **Recent unlocks** shows the last ten. Members who have left the server are left out of both.',
        'Each achievement is earned once; it does not pay again.',
    ],
    related: ['levels', 'economy', 'community'],
};
