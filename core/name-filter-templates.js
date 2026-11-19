/*
 * Curated name-filter data, maintained here and shipped with the bot (pure data + small helpers,
 * unit-tested in tests/name-filters.test.js).
 *
 * TEMPLATE PACKS — keyword filters for the names scam accounts use. A server applies a pack from the
 * dashboard's Name Filters page or `/moderation namefilter template`; core/name-filters.js then keeps that
 * server's copy in step with the pack (rows in automod_patterns, origin 'template'), so an entry
 * added or fixed here reaches every server that applied the pack on the next restart. Entries a
 * server deleted stay deleted. Bump a pack's `version` whenever its entries change.
 *
 * Why in code and not a central database row set (guild '0', like core/image-blocklist.js): every
 * entry is a filter that can ban people in every server that applied the pack, so it should go
 * through review and the test suite (which checks each entry is valid and that none hits a list of
 * ordinary names) rather than be editable live.
 *
 * `{server}` in an entry is replaced by the server's own name ("Acme Support"); skipped when the
 * name is shorter than 4 letters, since a short name would make the entry match ordinary names.
 *
 * GENERATED-NAME VOCABULARY — the words scam-account generators glue together into usernames like
 * `fluffy_panda_4821` or `brave.otter.1234`. The detector (core/name-filter-logic.js
 * generatedUsername) only fires when BOTH words are in this list, so `john_smith_1234` and other
 * real people's names do not. It ships as log-only per server until the list has proved itself.
 */

export const TEMPLATE_PACKS = Object.freeze([
    {
        id: 'staff-impersonation',
        version: 1,
        title: 'Staff & support impersonation',
        description: 'Names pretending to be server staff, Discord staff or a support desk.',
        entries: [
            { key: 'support-team', type: 'phrase', value: 'support team' },
            { key: 'support-staff', type: 'phrase', value: 'support staff' },
            { key: 'support-agent', type: 'phrase', value: 'support agent' },
            { key: 'customer-support', type: 'phrase', value: 'customer support' },
            { key: 'official-support', type: 'phrase', value: 'official support' },
            { key: 'help-desk', type: 'phrase', value: 'helpdesk' },
            { key: 'help-desk-2', type: 'phrase', value: 'help desk' },
            { key: 'help-center', type: 'phrase', value: 'help center' },
            { key: 'discord-support', type: 'phrase', value: 'discord support' },
            { key: 'discord-staff', type: 'phrase', value: 'discord staff' },
            { key: 'discord-team', type: 'phrase', value: 'discord team' },
            { key: 'discord-mod', type: 'phrase', value: 'discord mod' },
            { key: 'discord-admin', type: 'phrase', value: 'discord admin' },
            { key: 'trust-safety', type: 'regex', value: '\\btrust\\s*(?:and|&|n)\\s*safety\\b' },
            { key: 'system-message', type: 'phrase', value: 'system message' },
            { key: 'mod-team', type: 'phrase', value: 'mod team' },
            { key: 'moderation-team', type: 'phrase', value: 'moderation team' },
            { key: 'admin-team', type: 'phrase', value: 'admin team' },
            { key: 'staff-team', type: 'phrase', value: 'staff team' },
            { key: 'server-admin', type: 'phrase', value: 'server admin' },
            { key: 'server-mod', type: 'phrase', value: 'server moderator' },
            { key: 'head-admin', type: 'phrase', value: 'head admin' },
            { key: 'community-manager', type: 'phrase', value: 'community manager' },
            { key: 'server-support', type: 'phrase', value: '{server} support' },
            { key: 'server-staff', type: 'phrase', value: '{server} staff' },
            { key: 'server-admin-name', type: 'phrase', value: '{server} admin' },
            { key: 'server-mod-name', type: 'phrase', value: '{server} mod' },
            { key: 'server-team', type: 'phrase', value: '{server} team' },
            { key: 'server-official', type: 'phrase', value: '{server} official' },
        ],
    },
    {
        id: 'ticket-scam',
        version: 1,
        title: 'Ticket & appeal scams',
        description: 'The fake "open a ticket" / "appeal your ban" support accounts.',
        entries: [
            { key: 'ticket', type: 'phrase', value: 'ticket' },
            { key: 'modmail', type: 'phrase', value: 'modmail' },
            { key: 'mod-mail', type: 'phrase', value: 'mod mail' },
            { key: 'appeal', type: 'regex', value: '\\b(?:ban|account)\\s*appeals?\\b' },
            { key: 'report-center', type: 'phrase', value: 'report center' },
            { key: 'verify-bot', type: 'regex', value: '\\b(?:verify|verification|captcha|security)\\s*bot\\b' },
            { key: 'support-bot', type: 'phrase', value: 'support bot' },
            { key: 'support-ticket', type: 'phrase', value: 'support ticket' },
        ],
    },
    {
        id: 'nitro-giveaway',
        version: 1,
        title: 'Nitro & giveaway lures',
        description: 'Free Nitro, gift and giveaway bait accounts.',
        entries: [
            { key: 'free-nitro', type: 'phrase', value: 'free nitro' },
            { key: 'nitro-gift', type: 'phrase', value: 'nitro gift' },
            { key: 'nitro-giveaway', type: 'phrase', value: 'nitro giveaway' },
            { key: 'nitro-drop', type: 'phrase', value: 'nitro drop' },
            { key: 'steam-gift', type: 'phrase', value: 'steam gift' },
            { key: 'gift-drop', type: 'phrase', value: 'gift drop' },
            { key: 'giveaway-bot', type: 'phrase', value: 'giveaway bot' },
            { key: 'giveaway-host', type: 'phrase', value: 'giveaway host' },
            { key: 'claim-prize', type: 'regex', value: '\\bclaim\\s*(?:your\\s*)?(?:prize|reward|gift|nitro)\\b' },
        ],
    },
    {
        id: 'web3-wallet',
        version: 1,
        title: 'Web3 & crypto wallet lures',
        description: 'Airdrop, mint and wallet-support scams aimed at crypto and NFT communities.',
        entries: [
            { key: 'airdrop', type: 'phrase', value: 'airdrop' },
            { key: 'free-mint', type: 'phrase', value: 'free mint' },
            { key: 'mint-live', type: 'regex', value: '\\bmint(?:ing)?\\s*(?:is\\s*)?(?:live|now|open)\\b' },
            { key: 'metamask', type: 'phrase', value: 'metamask' },
            { key: 'wallet-connect', type: 'phrase', value: 'walletconnect' },
            { key: 'wallet-connect-2', type: 'phrase', value: 'wallet connect' },
            { key: 'wallet-support', type: 'phrase', value: 'wallet support' },
            { key: 'seed-phrase', type: 'phrase', value: 'seed phrase' },
            { key: 'opensea', type: 'phrase', value: 'opensea support' },
            { key: 'collab-manager', type: 'phrase', value: 'collab manager' },
            { key: 'web3-support', type: 'phrase', value: 'web3 support' },
            { key: 'crypto-support', type: 'phrase', value: 'crypto support' },
            { key: 'token-claim', type: 'regex', value: '\\b(?:token|reward|eth|btc|sol)\\s*claim\\b' },
            { key: 'coin-giveaway', type: 'regex', value: '\\b(?:eth|btc|sol|crypto|usdt)\\s*giveaway\\b' },
        ],
    },
]);

export const PACKS_BY_ID = new Map(TEMPLATE_PACKS.map(p => [p.id, p]));

/** The words a server name contributes to `{server}` entries; null when too short to be safe. */
export function serverNameForTemplates(name) {
    const clean = String(name ?? '')
        .normalize('NFKC')
        .replace(/[^\p{L}\p{N}\s'&.-]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);
    return clean.replace(/[^\p{L}\p{N}]/gu, '').length >= 4 ? clean : null;
}

/**
 * The entries of a pack as this server gets them: `{server}` filled in (or the entry dropped).
 * @returns {Array<{ key:string, type:string, value:string }>}
 */
export function expandPack(pack, { serverName = null } = {}) {
    const server = serverNameForTemplates(serverName);
    const out = [];
    for (const e of pack.entries) {
        if (e.value.includes('{server}')) {
            if (!server) continue;
            out.push({ key: e.key, type: e.type, value: e.value.replaceAll('{server}', server) });
        } else {
            out.push({ ...e });
        }
    }
    return out;
}

// ── generated usernames ──────────────────────────────────────────────────────
// Adjectives and nouns from the stock lists random-name generators draw on. Keep entries lower case,
// letters only, at least three letters; no first names or surnames.
const ADJECTIVES = `
able agile amber ancient angry arctic azure bashful beige big bitter black blazing blue bold bouncy brave
breezy bright brisk bubbly busy calm candid cheeky cheerful chilly chubby clever cloudy clumsy cold cool cosmic
cozy crazy crimson crispy cuddly curious cute daring dark dizzy dreamy dusty eager early easy electric elegant
epic fancy fast fearless fierce fiery fluffy flying foggy fresh friendly frosty funky funny fuzzy gentle giant
giddy glad gleaming glowing golden goofy graceful grand green grumpy happy hasty hazy hidden hollow honest huge
humble hungry icy jazzy jolly joyful jumpy keen kind lazy little lively lonely loud lucky lunar magic majestic
mellow merry mighty misty modest moody mossy muddy mystic narrow neat nervous nimble noble noisy odd orange
peaceful perky pink plain playful plucky polite pretty proud purple quick quiet quirky rapid rare rusty sandy
sassy scary shiny shy silent silly silver sleepy slim slow sly small smart smooth snappy sneaky snowy soft solar
sour sparkly speedy spicy spooky stormy strange strong sturdy sunny super sweet swift tame tangy tender tidy tiny
tired tough tricky turbo vast velvet vivid wacky warm wild windy wise witty wobbly wooden young zany zealous zesty
`;
const NOUNS = `
acorn alpaca anchor apple badger bagel banana bean bear beaver bee beetle berry bison blossom boulder bubble
bucket buffalo bunny butter butterfly cactus camel candle canyon carrot cat cheetah cherry chicken chipmunk
cloud clover cobra coconut comet cookie coral cougar cow coyote crab crane cricket crow cupcake daisy deer dingo
dolphin donkey donut dove dragon duck eagle eel elk ember falcon fern ferret finch flamingo fox frog gazelle
gecko ghost giraffe goat goose gopher grape griffin hamster hare hawk hedgehog heron hippo hornet horse hound
husky iguana jackal jaguar jelly kangaroo kitten kiwi koala lemon lemur leopard lion lizard llama lobster lotus
lynx mango maple marmot meadow melon mole monkey moose moth mouse muffin mushroom narwhal newt nugget ocelot
octopus olive orca ostrich otter owl panda panther parrot peach peacock peanut pebble pelican penguin pepper
pigeon pine pixel plum pony poodle possum potato pretzel puffin puma pumpkin puppy quail rabbit raccoon
radish raven reindeer rhino river robin rocket salmon seal shark sheep shrimp skunk sloth snail snake sparrow
spider squid squirrel star storm stork sunflower swan taco tiger toad tomato tortoise toucan trout tulip turkey
turtle unicorn viper vulture waffle walrus wasp weasel whale wolf wombat yak zebra
`;
export const GENERATED_NAME_WORDS = Object.freeze(new Set(`${ADJECTIVES} ${NOUNS}`.split(/\s+/).filter(Boolean)));

export default { TEMPLATE_PACKS, PACKS_BY_ID, expandPack, serverNameForTemplates, GENERATED_NAME_WORDS };
