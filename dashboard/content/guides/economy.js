// Checked against: commands/economy/economy.js and its handlers, core/economy-manager.js (defaults),
// core/gambling-manager.js, core/universal-commands.js (text options), dashboard/views/partials/manage/economy.ejs.
export default {
    slug: 'economy',
    title: 'Server economy',
    area: 'games',
    summary: 'A currency members earn, bank, spend in your shop, gamble and trade.',
    result: {
        image: 'economy-discord',
        caption: 'A member claims the daily reward and checks their balance.',
    },
    before: [
        'Economy commands are not in Discord\'s `/` menu: type them as an ordinary message, for example `/economy bank balance`. Options go after the command as `name:value`, or in order.',
    ],
    steps: [
        {
            title: 'Name your currency and set the rewards',
            text: [
                'On the dashboard, open **Economy & trading**, then **Economy**. Set the **Currency name** and **Currency icon**, the **Starting balance**, the **Daily reward**, **Weekly reward** and **Work pays**. Leave the **Economy** switch on when you save.',
                'Until you save, the economy is on with the built-in defaults, and the page shows them: 💰 coins, 1,000 to start, 500 a day, 3,500 a week, 100 to 500 for work once an hour, and crime paying 200 to 1,000 with a 60% chance (caught, it costs half that).',
            ],
            image: 'economy-page',
        },
        {
            title: 'Earn',
            text: [
                'Members earn with `/economy earn daily`, `weekly`, `work` and `crime`. Claiming the daily reward on consecutive days adds a streak bonus of 50 a day, up to 1,000.',
            ],
            command: '/economy earn daily',
        },
        {
            title: 'Bank and pay',
            text: [
                '`/economy bank balance` shows the wallet, the bank and the total. `deposit` and `withdraw` move money between them, and `transfer` pays another member.',
            ],
            command: '/economy bank deposit amount:500',
        },
        {
            title: 'Stock the shop',
            text: [
                'In **Shop** on the dashboard, select **Add item**: a **Name**, **Price**, **Type** (a role, a consumable, a collectible and more), the **Role given** for role items, and **Stock** (leave it empty for unlimited).',
                'Members browse with `/economy shop browse` and buy with the item\'s ID.',
            ],
            command: '/economy shop buy item_id:3',
        },
        {
            title: 'Play with it',
            text: [
                'Gambling games (`/economy gamble coinflip`, `dice`, `slots`, `blackjack`, `roulette` and `highlow`), heists with a crew, pets, and trades between members all use the same currency. `/economy social leaderboard` shows the richest members.',
            ],
            command: '/economy gamble coinflip amount:100 choice:heads',
        },
    ],
    notes: [
        'The highest bet is 10,000 unless you change **Largest bet** on the **Gambling** page.',
        'Giving or removing money (`/economy social give` and `remove`) and creating shop items from Discord need Administrator.',
        'Greenhouse Tycoon has its own money and does not use the server economy.',
    ],
    related: ['greenhouse', 'levels', 'music'],
};
