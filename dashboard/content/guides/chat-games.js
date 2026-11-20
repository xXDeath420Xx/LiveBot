// Checked against: core/counting-manager.js, commands/games/arcade.js, commands/games/arcade-counting-handler.js,
// dashboard/views/partials/manage/counting.ejs, dashboard/routes/api/features/counting.js, migrations/150_counting_modes.js,
// commands/games/wordgame.js, core/word-game-manager.js, core/word-game-results.js, core/games/last-letter.js,
// core/games/coordle.js, core/feature-config-spec.js (wordgames, COMMAND_FEATURE_MAP), events/messageCreate.js,
// dashboard/views/partials/manage/games.ejs, core/trivia-manager.js, core/hangman-manager.js, core/manage-nav.js,
// core/universal-commands.js (describePath), docs/command-split-2026-11-18.md.
export default {
    slug: 'chat-games',
    title: 'Counting, word games and trivia',
    area: 'games',
    summary: 'Games members play by typing in chat: counting up together, word chains, a shared Wordle, word searches, trivia and hangman.',
    result: {
        image: 'chat-games-discord',
        caption: 'A counting channel. Correct numbers get a check mark; the same member posting twice in a row resets the count.',
    },
    before: [
        'You need **Manage Server** for the dashboard. The pages are under **Games**: **Counting**, **Word Games** and **Trivia and hangman**.',
        'These game commands are not in Discord\'s `/` menu: type them as an ordinary message, for example `/arcade counting stats`. Options go after the command as `name:value`.',
    ],
    steps: [
        {
            title: 'Start a counting channel',
            text: [
                'Open **Games**, then **Counting**. Choose the **Channel**, leave **First number** at 1, and select **Enable counting**. Taking over from another bot, set the first number to the one it expected next.',
                'Members post 1, 2, 3 and so on, one number per message. Nobody may count twice in a row: someone else has to post the next number. Each correct number gets a check mark.',
            ],
            command: '/arcade counting setup channel:#counting',
            image: 'chat-games-counting-page',
        },
        {
            title: 'Choose what a wrong number does',
            text: [
                'Under **When someone posts the wrong number**, **Reset to 0** is the classic game: the bot reacts with a cross, posts what went wrong, and the count starts again from 1. A second number in a row from the same member counts as wrong as well.',
                '**Delete it** removes the wrong number and keeps the count, so anyone can post the right one next. The bot needs Manage Messages in the channel for this. Then **Delete messages that are not numbers** keeps the channel to numbers only.',
                '**Announce milestones** posts at 25, 50, 100, 200, 500, 1,000 and so on. **Set count** moves the count to a number you choose without touching the stats or the record. Changes on this page save as soon as you make them.',
            ],
        },
        {
            title: 'Add word games',
            text: [
                'There are four. **Last Letter**: each word starts with the last letter of the one before, real words only and no repeats. **One Word Story**: one word per message, never twice in a row. **Coordle**: the channel guesses a 5-letter word together in 6 guesses. **WordSeek**: find the words hidden in a letter grid.',
                '`/wordgame <game> setup channel:` gives a game a channel of its own until you run `/wordgame <game> disable channel:`; both need Manage Server. Anyone can play a single round in the channel they are in with `/wordgame <game> start`, and stop it with `/wordgame <game> end`. A channel runs one word game at a time.',
                'On the **Word Games** page, **Announce results in** posts each finished game to a channel, and **Award role to the leader** gives a role to whoever is first on a game\'s leaderboard.',
            ],
            command: '/wordgame coordle setup channel:#coordle',
        },
        {
            title: 'Play trivia and hangman',
            text: [
                '`/arcade trivia start` asks 5 questions (up to 10 with `questions:`), answered with buttons. `/arcade hangman start` picks a word to guess with `/arcade hangman guess guess:e`: 6 lives, and a wrong guess at the whole word costs 2. Each game belongs to the member who started it; others start their own.',
                'On **Trivia and hangman**, **Add question** and **Add word** add your own. Your questions are asked alongside the built-in ones.',
            ],
            command: '/arcade trivia start category:geography',
        },
    ],
    notes: [
        'Counting commands from Discord (`setup`, `disable`, `reset`, `setcount` and `mode` under `/arcade counting`) need Manage Channels. `/arcade counting stats` and `/arcade counting leaderboard` are for everyone.',
        'Once the **Economy** page has been saved with the economy on, a counting milestone pays the member who reached it that many coins, and trivia and hangman pay coins for the score, also to members who have never used the economy.',
        'Turning **Enabled** off on the Word Games page stops the `/wordgame` commands, and games already running stop taking words.',
        'Hangman difficulties: easy is 4 to 5 letters, medium 6 to 8 and hard 9 or more. A trivia game ends 5 minutes after it starts, a hangman game after 10 minutes.',
    ],
    related: ['collecting-games', 'critters', 'economy', 'levels'],
};
