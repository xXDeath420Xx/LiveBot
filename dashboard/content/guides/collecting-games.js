// Checked against: dashboard/views/partials/manage/minigames.ejs, dashboard/routes/api/features/minigames.js,
// commands/games/cat.js, core/catbot/spawn-manager.js, core/catbot/constants.js, core/catbot/economy.js,
// commands/games/tree.js, core/growtree/formulas.js, core/growtree/manager.js, commands/games/fish.js,
// core/fishing-manager.js, core/feature-config.js (checkAccess), core/feature-config-spec.js (pokemon, digimon, fishing,
// COMMAND_FEATURE_MAP), commands/games/pokemon.js, events/messageCreate.js, commands/games/digimon.js,
// dashboard/views/partials/manage/digimon.ejs, core/digimon-logic.js, core/feature-flags.js, core/manage-nav.js,
// core/universal-commands.js (describePath), docs/command-split-2026-11-18.md.
export default {
    slug: 'collecting-games',
    title: 'Cats, fishing, Pokémon and Digimon',
    area: 'games',
    summary: 'Collecting games that run in chat: catch cats, grow a shared tree, go fishing, catch Pokémon and raise Digimon.',
    result: {
        image: 'collecting-games-discord',
        caption: 'A Good cat appears in chat. Pip types "cat" first, catches it and earns 8 Cat Coins.',
    },
    before: [
        'You need **Manage Server** for the dashboard. Each game has a page under **Games**: **Minigames** (cats and the tree), **Fishing**, **Pokémon** and **Digimon**.',
        '`/digimon` is in Discord\'s `/` menu. `/cat`, `/tree`, `/fish` and `/pokemon` are not: type them as an ordinary message, for example `/fish catch`.',
    ],
    steps: [
        {
            title: 'Let cats appear',
            text: [
                'Open **Games**, then **Minigames**. Under **Cat Bot**, pick a channel in **Add a spawn channel** and select **Add**. A cat appears every 60 to 600 seconds; a busy channel gets its cat sooner, but never before the shortest gap. Change the gap per channel (20 seconds at least).',
                'The first member to type `cat` catches it and earns Cat Coins: the rarer the cat, the more coins. Members spend them on catnip perks and the `/cat game` minigames, and see their cats with `/cat inventory`.',
                '**Cat Bot options** apply to every spawn channel, for example **Delete catch messages** and **One catch at a time**.',
            ],
            command: '/cat setup channel:#cat-cafe',
            image: 'collecting-games-minigames-page',
        },
        {
            title: 'Plant the server tree',
            text: [
                'In the channel the tree should live in, run `/tree plant name:` (Manage Server). Members water it with the **grow** button under its message. Each water adds a foot, nobody may water twice in a row, and the wait between waters gets longer as the tree grows.',
                '`/tree show` posts the tree with its button again, `/tree gardeners` shows who waters it most, and `/tree forest` compares the tallest trees across every server.',
            ],
            command: '/tree plant name:Old Maple',
        },
        {
            title: 'Go fishing',
            text: [
                'Fishing is on until you turn it off on the **Fishing** page. Members cast with `/fish catch`, sell with `/fish sell`, buy rods, bait, spots and pets in `/fish shop`, and keep their best catches in `/fish aquarium`.',
                '**Restrict to channels** keeps it to the channels you pick, and **Seconds between casts** sets the wait (3 by default). `/fish tournament start` (Manage Server) runs a timed contest, announced in **Tournament announcements** if you set it.',
            ],
            command: '/fish catch',
        },
        {
            title: 'Turn on Pokémon spawns',
            text: [
                'On the **Pokémon** page, turn on **Spawns enabled**; spawns are off until you do. Leave **Spawn channel** empty for Pokémon to appear wherever people are talking. Each message has a 5% chance of a spawn, rising to 25% when the server is busy, and a channel gets at most one a minute.',
                'Members start with `/pokemon start starter:`, then catch by guessing the name: `/pokemon catch name:`. A wild Pokémon stays until someone catches it or a new one appears.',
            ],
            command: '/pokemon catch name:pikachu',
        },
        {
            title: 'Turn Digimon on',
            text: [
                'Digimon is off by default. On the **Digimon** page, switch **Digimon** on; until then `/digimon` tells members it is turned off. You can also use `/digimon setup enabled:True`.',
                'Members pick their 3 starter Digi-Eggs with `/digimon start`. With **Wild Digimon appear in chat** on, each message has a 4% chance of a spawn (at most one per channel every 2 minutes), and the first member to name it with `/digimon tame` keeps it.',
            ],
            command: '/digimon start',
        },
    ],
    notes: [
        'Admin commands: `/cat setup`, `/cat timings` and `/tree plant` need Manage Server; `/pokemon setchannel` and `/pokemon spawnconfig` need Administrator.',
        'Cat Coins, Pokecoins, fishcoins and Digimon bits are separate from the server economy. Fishing balances, gear and the bestiary follow a member to every server.',
        'Some Digimon commands can also be typed short: `/tame`, `/partner`, `/train`, `/rarity` and `/today` (the daily "which Digimon are you" quiz).',
        'The **Digimon** page also has the market fee, a lifespan for partners, the strongest partners, quiz results and a reset for the whole server.',
    ],
    related: ['chat-games', 'critters', 'economy', 'greenhouse'],
};
