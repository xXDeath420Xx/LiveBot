// Checked against: dashboard/views/partials/manage/throne.ejs (tracked creators, Alerts, Extras, Featured wishlist, Instant gift alerts),
// core/throne-manager.js (the gift post and View Wishlist button), utils/scrapers/throne-scraper.js (Purchased or Crowdfunded),
// commands/community/throne.js and throne-handler.js (track needs Manage Server), dashboard/views/partials/manage/kofi.ejs,
// dashboard/routes/api/features/kofi.js and core/kofi-manager.js (31 days, 1 to 365), dashboard/views/partials/manage/fourthwall.ejs,
// dashboard/routes/api/features/fourthwall.js, core/fourthwall-shop-tracker.js (every 10 minutes, public pages), migrations/113 and 341
// (switch defaults), commands/community/fourthwall.js and fourthwall-handler.js (setup modal, route categories), core/command-mounts.js
// (kofi and throne under /creator), core/manage-nav.js (Social feeds & creators), docs/command-split-2026-11-18.md.
export default {
    slug: 'supporter-alerts',
    title: 'Throne, Ko-fi and Fourthwall alerts',
    area: 'streams',
    summary: 'Post Throne wishlist gifts and changes, thank Ko-fi supporters with a post and a role, and announce changes in a Fourthwall shop.',
    result: {
        image: 'supporter-alerts-discord',
        caption: 'A Throne gift alert: who gifted which item, its value, and a button to the wishlist.',
    },
    before: [
        'You need **Manage Server**. The pages are on the dashboard under **Social feeds & creators**: **Throne wishlists**, **Ko-fi** and **Fourthwall shop**.',
        'CertiFried only reads these notifications. It never handles payments or sees payment details.',
    ],
    steps: [
        {
            title: 'Track a Throne wishlist',
            text: [
                'On **Throne wishlists**, under **Tracked creators**, type the **Throne username**, choose where to **Post in**, tick **New items**, **Gifts** and **Contributions** as you like, and choose **Track creator**. Wishlists are checked about every two minutes.',
                'Under **Alerts**, pick what is posted for every tracked creator: **New wishlist items**, **Removed items**, **Gifts**, **Contributions**, **Milestones** (every 10th gift, and a crowdfunded item being fully funded) and **Price changes** of at least the **Price change threshold** (1 to 50 percent). **Post every alert in** sends them all to one channel. These switches save as you change them.',
            ],
            command: '/creator throne track username:sorrelquinnart channel:#announcements',
            image: 'supporter-alerts-throne',
        },
        {
            title: 'Add Throne extras',
            text: [
                'Under **Extras**: **Preview Throne links** replies with a wishlist card when someone posts a throne.com link, **Birthday reminders** posts 1 to 14 days before a tracked creator\'s birthday (when their Throne profile shows one), and **Monthly spotlight** posts a recap of the month on the 1st.',
                'For gift alerts within seconds instead of minutes, choose **Create URL** under **Instant gift alerts** and give the address to the creator privately. They paste it into throne.com under Settings, Integrations, Webhooks. The regular check keeps running as a backup.',
            ],
        },
        {
            title: 'Thank Ko-fi supporters and give them a role',
            text: [
                'On **Ko-fi**, open Ko-fi\'s Settings, then API. Paste the **Verification token** on the dashboard and save, then copy the **Webhook URL** shown into Ko-fi\'s webhook field and turn on **Process Ko-fi payments**.',
                'Under **Thank-you post**, choose the **Channel** and, if you like, a **Message** with `{user}`, `{amount}` and `{tier}`. Supporters who asked Ko-fi to keep their payment private are shown as "Someone".',
                'Under **Tiers and roles**, choose a **Role to give** and either the **Ko-fi tier name** (it must match the membership exactly) or **Or a minimum amount** for one-off tips. Each payment keeps the role for **How long a perk lasts** (31 days unless you change it, up to 365), and it is removed when that runs out.',
                'Members link their Ko-fi with `/creator kofi link`, which gives them a one-time code to put in their Ko-fi message. After that, renewals are matched by email.',
            ],
        },
        {
            title: 'Announce changes in a Fourthwall shop',
            text: [
                'On **Fourthwall shop**, type the **Shop address** (for example `name-shop.fourthwall.com`), choose where to **Post in** and choose **Track shop**. It works from the shop\'s public pages, so any shop can be tracked without a login. Shops are checked every 10 minutes; the first check only records what is there.',
                'Each shop has switches for **Products** (new products, sold out, back in stock, price drops and sales, price rises), **Sizes and variants** and **Listing changes**. Price rises, sold-out products, sizes added or removed, name changes and new images start off.',
            ],
            command: '/fourthwall track shop:name-shop channel:#announcements',
        },
    ],
    notes: [
        '`/creator throne featured` shows the wishlist set under **Featured wishlist**; members can browse any wishlist with `/creator throne wishlist`.',
        'If you own a Fourthwall shop, `/fourthwall setup` connects it with your Fourthwall platform API username and password, and `/fourthwall route` sends orders, donations, memberships and other kinds of event to the channels you choose.',
        'The Ko-fi supporters list on the dashboard shows the 25 most recent supporters. Treat the Ko-fi webhook URL and the Throne instant alert URL like passwords.',
        'For your own stream, the same Ko-fi, Fourthwall and Throne events can start automations in the [Stream bot](/docs/guides/stream-bot).',
    ],
    related: ['stream-bot', 'twitch-tools', 'social-feeds'],
};
