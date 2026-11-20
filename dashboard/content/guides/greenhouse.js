// Checked against: dashboard/routes/greenhouse.js, services/cfx/ (config/game.js, domain/*, http/routes/*),
// commands/games/arcade.js + arcade-greenhouse-handler.js, dashboard/views/partials/manage/greenhouse.ejs,
// frontend/greenhouse/src/views/your-data.js (the Your data card, H-641), frontend/greenhouse/src/activity-host.js and
// frontend/activities/src/main.js (the Discord Activity).
export default {
    slug: 'greenhouse',
    title: 'Greenhouse Tycoon',
    area: 'games',
    summary: 'A plant-growing game you play on the website and check on from Discord, with seasons and weekly challenges.',
    result: {
        image: 'greenhouse-discord',
        caption: 'Checking a greenhouse from Discord with /arcade greenhouse status.',
    },
    steps: [
        {
            title: 'Start playing',
            text: [
                'Open [Greenhouse Tycoon](/greenhouse) and sign in with Discord, Twitch or Kick. You start with $500, two benches and seeds for the first three plants.',
                'Plant, water and harvest, then sell what you grow. Spend the money on upgrades and more benches, hire staff, and cross-breed new varieties.',
            ],
        },
        {
            title: 'Play inside Discord',
            text: [
                'Join a voice channel, press the Activities button (the rocket), choose CertiFried, then **Greenhouse Tycoon**. It signs you in with Discord and opens the same greenhouse as the website, and everyone in the channel can play their own at the same time.',
            ],
            image: 'activity-launcher',
        },
        {
            title: 'Check in from Discord',
            text: [
                'Type these as an ordinary message. `/arcade greenhouse status` shows your level, cash, benches, quests and season points. `/arcade greenhouse daily` collects the daily reward; there is one a day, whether you collect it in Discord or on the website.',
            ],
            command: '/arcade greenhouse status',
        },
        {
            title: 'Link your sign-ins to one save',
            text: [
                'If you play with more than one account (for example Discord and Twitch), link them so they share one greenhouse. `/arcade greenhouse link` sends you a code by DM; enter it on the website. To go the other way, make a code on the website (**Profile**, **Link another sign-in**) and type `/arcade greenhouse link` followed by the code. A code works once and only for 10 minutes.',
                'After linking or unlinking, you have to wait 7 days before doing it again.',
            ],
            command: '/arcade greenhouse link',
        },
        {
            title: 'Download or delete your game data',
            text: [
                'On the website, open **Profile**. Under **Your data**, **Download my data** saves a JSON file of everything the game keeps for your save and every sign-in linked to it.',
                '**Delete my save** deletes the save and every sign-in linked to it, then signs you out. You type DELETE to confirm, and it cannot be undone. This works with Discord, Twitch or Kick; Discord members can also use `/privacy`.',
            ],
        },
        {
            title: 'See who plays in your server',
            text: [
                'Admins can open **Economy & trading**, then **Greenhouse Tycoon**, on the dashboard. It shows the current season, this week\'s challenge and the members of the server who play, ranked by their season points.',
            ],
            image: 'greenhouse-page',
        },
    ],
    notes: [
        'Seasons last 30 days, with a challenge in each of the first four weeks; everyone who finishes a challenge is paid. A week\'s challenge starts once 3 people have played in the last 7 days, and is skipped if that has not happened by the end of the week.',
        'Staff keep working while you are away, for up to 12 hours.',
        'The Twitch panel extension is not released yet.',
    ],
    related: ['economy', 'levels'],
};
