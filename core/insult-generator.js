/*
 * Built-in insults for `/fun insult`: playful roasts, never hateful.
 *
 * Several hundred hand-written parts — adjectives, nouns, "about as useful as" comparisons, whole
 * lines and sentence templates — are combined at random, so the same server sees tens of thousands
 * of different results rather than a short list on repeat. House rules for anything added here:
 * roast what someone does (their aim, their Wi-Fi, their jokes), never who they are — no bodies,
 * looks, race, religion, gender, sexuality, disability or health, no swearing, no threats.
 * tests/insult.test.js runs every part through core/hate-terms.js and a profanity check.
 *
 * Pure: pass an rng to get repeatable output in tests.
 */

export const ADJECTIVES = Object.freeze([
    'soggy', 'lukewarm', 'decaffeinated', 'unseasoned', 'expired', 'off-brand', 'knock-off', 'dial-up',
    'low-budget', 'half-charged', 'unbuttered', 'stale', 'crumpled', 'bargain-bin', 'clearance-rack',
    'unskippable', 'pre-owned', 'factory-reset', 'overcooked', 'undercooked', 'room-temperature',
    'store-brand', 'generic', 'beta', 'unpatched', 'deprecated', 'read-only', 'buffering', 'laggy',
    'discontinued', 'slightly damp', 'out-of-warranty', 'refurbished', 'dollar-store', 'airport-priced',
    'non-alcoholic', 'sugar-free', 'caffeine-free', 'bootleg', 'second-hand', 'misprinted',
    'low-resolution', '144p', 'pixelated', 'autocorrected', 'mislabelled', 'half-eaten', 'abandoned',
    'unsupervised', 'sleep-deprived', 'overconfident', 'under-qualified', 'uninvited', 'tutorial-level',
    'last-picked', 'rubber-banding', 'unranked', 'bronze-tier', 'AFK', 'permanently muted', 'sticky',
    'crusty', 'mildly irritating', 'wobbly', 'squeaky', 'rusty', 'leaky', 'dusty', 'tangled',
    'out-of-tune', 'malfunctioning', 'travel-sized', 'flat-pack', 'pre-microwaved', 'fun-sized',
    'ad-supported', 'trial-version', 'watermarked', 'copy-pasted', 'unsubscribed', 'unsaved',
    'auto-saved', 'lost-in-the-mail', 'returned-to-sender', 'out-of-stock', 'backordered',
    'unclaimed', 'reheated', 'freezer-burnt', 'mid-update', 'low-battery',
]);

export const NOUNS = Object.freeze([
    'potato', 'traffic cone', 'participation trophy', 'screensaver', 'pop-up ad', 'loading screen',
    'sock', 'unpaid intern', 'parking ticket', 'bowl of cereal', 'NPC', 'side quest', 'microwave burrito',
    'fax machine', 'printer', 'toaster', 'spork', 'rubber duck', 'shopping trolley', 'folding chair',
    'garden gnome', 'pigeon', 'houseplant', 'paperweight', 'doorstop', 'kazoo', 'flip phone',
    'floppy disk', 'captcha', 'cookie banner', 'software update', 'error message', 'spam email',
    'voicemail', 'reply-all email', 'out-of-office reply', 'elevator jingle', 'hold music',
    'tutorial popup', 'cutscene', 'escort mission', 'fetch quest', 'loot box', 'starter weapon',
    'practice dummy', 'respawn timer', 'waiting room', 'cheese grater', 'sandwich', 'pancake',
    'crouton', 'rice cake', 'jelly bean', 'breadstick', 'sticky note', 'paper clip', 'rubber band',
    'stapler', 'mouse pad', 'USB stick', 'extension cord', 'phone charger', 'TV remote', 'alarm clock',
    'snooze button', 'shopping list', 'receipt', 'coupon', 'umbrella', 'flip-flop', 'beanbag',
    'lawn chair', 'puddle', 'speed bump', 'pothole', 'car alarm', 'smoke alarm', 'sofa cushion',
    'jigsaw piece', 'board game manual', 'instruction leaflet', 'warranty card', 'packing peanut',
    'bubble wrap', 'cardboard box', 'yoghurt lid', 'teabag', 'ice cube', 'crisp packet', 'loading bar',
]);

export const COMPARISONS = Object.freeze([
    'a screen door on a submarine', 'a chocolate teapot', 'a white crayon', 'a glass hammer',
    'a solar-powered flashlight', 'an umbrella made of tissue paper', 'a fork at a soup contest',
    'a waterproof teabag', 'an inflatable dartboard', 'a sundial in a cave', 'a lighthouse in the desert',
    'a GPS with no signal', 'a phone charger that only works at one angle', 'a pause button in an online game',
    'a skip button that does nothing', 'a mute button on a smoke alarm', 'a paper umbrella in a storm',
    'a revolving door on a phone box', 'an ashtray on a motorbike', 'a knitted kettle', 'a cardboard oven',
    'a soup sieve', 'a one-legged chair', 'a pencil with two erasers', 'a broken pencil — pointless',
    'a parachute that opens on impact', 'a jigsaw puzzle with half the pieces', 'a dictionary with no words',
    'a calculator that only does maths on Tuesdays', 'a vending machine that keeps the money',
    'a fire extinguisher full of petrol', 'a remote control with no batteries', 'a sponge made of rock',
    'a bike with square wheels', 'a ladder with one rung', 'a map of the wrong city',
    'a password hint that just says "password"', 'a sat-nav that says "you are lost"', 'a wet match',
    'decaf at the start of a night shift', 'a loading bar stuck at 99%', 'a keyboard with no space bar',
    'a mouse with no cursor', 'Wi-Fi in a lift', 'a hairdryer in the rain', 'a tea strainer for soup',
    'a cat flap on a fish tank', 'an alarm clock that snoozes itself', 'a lifeguard who cannot swim',
    'a compass that points at snacks', 'a fridge with no door', 'a single chopstick',
    'a bin bag full of holes', 'a two-piece jigsaw you still cannot finish', 'a tutorial you skipped',
    'a help desk that is closed forever', 'a glow stick that is already used', 'a paper boat in the bath — briefly',
    'a sandcastle at high tide', 'a candle in a hurricane', 'a whistle with no pea', 'an ice sculpture in July',
    'a spoon at a steak dinner', 'a trampoline in a basement', 'a submarine with a sunroof',
    'a hammock made of string cheese', 'a smoke detector that only beeps at 3 a.m.', 'an elevator with one floor',
    'a speed bump on a racetrack', 'a lottery ticket from last week',
]);

export const LINES = Object.freeze([
    'If brains were Wi-Fi, you would be on one bar in the basement.',
    'You bring everyone so much joy. Mostly when you leave the voice channel.',
    'Your aim is so bad the bullets file a missing-person report.',
    'You are the reason the tutorial has a tutorial.',
    'You type "lol" with a completely straight face, and everyone can tell.',
    'You have the reaction time of a sloth on a dial-up connection.',
    'Somewhere, a calculator is embarrassed it has to share the word "smart" with your phone.',
    'You are proof that autocorrect cannot fix everything.',
    'You are not the dumbest person in the world, but you had better hope they do not log off.',
    'Your opinions come with an unskippable ad.',
    'You make loading screens feel productive.',
    'You are the human equivalent of a group chat on mute.',
    'Even your shadow tries to leave early.',
    'You have the strategic depth of a puddle.',
    'Your jokes have been sent back to the factory twice.',
    'You are like a software update: nobody asked for you and you take forever.',
    'Your game sense is so lost it is asking the sat-nav for directions.',
    'You could get outsmarted by a revolving door.',
    'Your K/D ratio is a cry for help.',
    'You are the kind of person who claps when the plane lands in a video game.',
    'Your cooking could set off a smoke alarm in the house next door.',
    'You have the charisma of a damp tea towel.',
    'Your Wi-Fi is not lagging. That is just how you think.',
    'You are like a cloud. When you disappear, it is a beautiful day.',
    'You have two brain cells and they are both fighting over third place.',
    'You are the participation trophy of this server.',
    'You have an unmatched talent for being the background character in your own story.',
    'If laziness were a sport, you would come fourth so you did not have to walk up to the podium.',
    'Your playlist is just ads.',
    'You are like a Monday that turned up on a Friday.',
    'NPCs have more dialogue options than you.',
    'You read the terms and conditions and still got it wrong.',
    'You would lose a staring contest with a screensaver.',
    'Your best move is the alt-F4.',
    'Your sense of direction is so bad you get lost on a loading screen.',
    'You are the reason the instructions say "do not eat".',
    'You make the hold music sound exciting.',
    'Your plans have the structural integrity of wet cardboard.',
    'You are as sharp as a beach ball.',
    'Your memes were already old when the dinosaurs posted them.',
    'You have the stealth of a marching band.',
    'Your reflexes are on a seven-day delivery.',
    'You are the human form of "this meeting could have been an email".',
    'You fall for the same trap so often the trap feels bad.',
    'Your build is held together by hope and duct tape.',
    'You are like a pop-up ad: loud, unwanted and impossible to close.',
    'You bring a spoon to every knife fight and still lose the spoon.',
    'Your rizz is still in early access.',
    'You are the default skin of people.',
    'You are the friend who says "one more game" at 4 a.m. and then loses it.',
    'Your excuses have patch notes.',
    'You get carried so often you should pay rent to the team.',
    'Your takes are so cold they come with frost warnings.',
    'If there were an award for trying, you would still miss the deadline.',
    'You are as useful as the "close" button on a cookie banner.',
    'Your internet history is just searches for "how to win".',
    'You have the patience of a toddler at a red light.',
    'Even your echo gets bored.',
    'You are so slow, the snails lapped you twice.',
    'You think "strategy" is a type of cheese.',
    'Your keyboard has a dent shaped like your forehead.',
    'You have been in more lobbies than wins.',
    'You are the background noise in your own podcast.',
    'Your bio says "gamer". Your stats say "spectator".',
    'You confuse "fashionably late" with "never arrived".',
    'You are a limited edition: limited skill, limited timing.',
    'Your brain has too many tabs open and all of them are playing music.',
    'You are the human version of a "low battery" warning.',
    'Your vibe is a printer that says "paper jam" with no paper in it.',
    'You pressed the elevator button seven times and it still does not respect you.',
    'Your fan club meets in a phone box and still has room.',
    'You are so forgettable your own reflection asks for a name.',
    'Your victory dance is just a practice routine at this point.',
    'You make a broken clock look reliable.',
    'Your thought process has a buffering icon.',
    'You are the spare part left over after building flat-pack furniture.',
    'You are the reason shampoo bottles have instructions.',
    'Your dramatic exit was so slow everyone waved twice.',
    'You came, you saw, you got distracted.',
    'Your search history is just "why is my team losing".',
    'Your best feature is the mute button.',
    'You are the human version of a "reply all".',
    'You bring nothing to the table and then complain about the menu.',
    'Your aim is so far off, the enemy team sends a thank-you card.',
    'You run on the same battery life as a 2009 laptop.',
    'Your idea of multitasking is panicking in two windows.',
    'You are allergic to good decisions.',
    'Your common sense has been out of stock since launch.',
    'You are the reason the "are you sure?" button exists.',
    'You light up a room just by switching off the light on your way out.',
    'Your comebacks arrive by snail mail.',
    'You are as quick as a sloth filling in a tax form.',
    'Your speedrun of getting lost is a world record.',
    'Your ideas have the shelf life of milk on a sunny windowsill.',
    'Your laugh buffers before it plays.',
    'You are the main character in a story nobody finished reading.',
    'You are as unpredictable as a cereal box toy: disappointing, every time.',
    'You are sharp as a marble.',
    'You treat every instruction manual as a suggestion and every suggestion as a mystery.',
    'Your team calls you "the tutorial" because everyone learns from your mistakes.',
    'You got lost in a straight corridor.',
    'You talk in the voice channel like you are paid by the word and the pay is terrible.',
    'You are like a printer: never there when you are needed and always out of ideas.',
    'You have the confidence of a lion and the results of a houseplant.',
    'Your secret talent is staying secret.',
    'You are so behind the times your memes need a museum ticket.',
]);

/* Sentence templates. {adj} {noun} {cmp}, and {noun2} for a second, different noun. */
export const TEMPLATES = Object.freeze([
    'You have the energy of a {adj} {noun}.',
    'You are about as useful as {cmp}.',
    'You are the human version of a {adj} {noun}.',
    'Calling you a {adj} {noun} would be unfair to every {noun2} out there.',
    'Somewhere out there, a {adj} {noun} is doing better than you.',
    'You have the personality of a {adj} {noun}.',
    'You bring the same energy as {cmp}.',
    'I have met a {adj} {noun} with more charisma than you.',
    'Scientists finally found something less useful than {cmp}: you.',
    'You are like {cmp}, but with less ambition.',
    'You are the {adj} {noun} of this server.',
    'Your game plan has the depth of a {adj} {noun}.',
    'If you were a {noun}, you would be the {adj} one.',
    'Your vibe is strictly {adj} {noun}.',
    'Even a {adj} {noun} would have seen that coming.',
    'You have all the charm of a {adj} {noun}, and half the reliability.',
    'Your plans are as solid as {cmp}.',
    'Talking to you is like talking to a {adj} {noun}, but the {noun2} listens better.',
    'You are less helpful than {cmp}.',
    'You were put together like a {adj} {noun} and you play like {cmp}.',
    'Your excuses are as believable as {cmp}.',
    'Your best idea so far was a {adj} {noun}.',
    'You are what happens when a {noun} and a {noun2} have one {adj} afternoon.',
    'If they made a {adj} {noun} award, you would be robbed — by the {noun2}.',
    'Your skills are on par with a {adj} {noun}.',
    'Even the {noun2} has stopped waiting for you.',
    'You are as much use as {cmp}, and twice as loud.',
    'Your contribution to the team is a {adj} {noun}.',
    'Being around you feels like using {cmp}.',
    'You are the {adj} {noun} everyone pretends not to see.',
    'You are as dependable as {cmp}.',
    'Your sense of humour is a {adj} {noun} in joke form.',
    'History will remember you as a {adj} {noun}, if it remembers you at all.',
    'You have the leadership skills of a {adj} {noun}.',
    'You are as sharp as {cmp}.',
    'Your secret weapon is a {adj} {noun}, and it is still a secret why.',
]);

const pick = (list, rng) => list[Math.floor(rng() * list.length)];

/** One random insult in second person ("You …"). */
export function generateInsult(rng = Math.random) {
    if (rng() < 0.35) return pick(LINES, rng);
    const noun = pick(NOUNS, rng);
    let noun2 = pick(NOUNS, rng);
    for (let i = 0; i < 4 && noun2 === noun; i++) noun2 = pick(NOUNS, rng);
    return pick(TEMPLATES, rng)
        .replace(/\{adj\}/g, () => pick(ADJECTIVES, rng))
        .replace(/\{noun2\}/g, noun2)
        .replace(/\{noun\}/g, noun)
        .replace(/\{cmp\}/g, () => pick(COMPARISONS, rng))
        // "a" before a vowel sound: "a uninvited" → "an uninvited", but "a USB stick", "a one-legged".
        .replace(/\b([Aa]) (?=[aeiou]|AFK\b)(?!USB|us[eu]|uni[qtvf]|one[ -])/g, '$1n ');
}

/** Number of distinct parts — the "several hundred" this module promises. */
export const PART_COUNT = ADJECTIVES.length + NOUNS.length + COMPARISONS.length + LINES.length + TEMPLATES.length;

export const NOTHING_PASSED = "You got lucky: every insult I came up with tripped this server's word filter.";

/**
 * Pick a line that passes `reject` (core/hate-terms.js rejectReason bound to a server's filter),
 * re-rolling the built-in generator until one does. The Evil Insult source (core/evil-insults.js,
 * served from a local copy of its database) falls back to this when its own lines keep failing.
 * @param {object} o
 *   reject        (line) => reason|null
 * @returns {Promise<{ line: string, source: 'builtin'|'none', filtered: Array<{source, reason}> }>}
 */
export async function pickInsult({ reject = () => null, rng = Math.random, builtinTries = 8 } = {}) {
    const filtered = [];
    for (let i = 0; i < builtinTries; i++) {
        const line = generateInsult(rng);
        const reason = reject(line);
        if (!reason) return { line, source: 'builtin', filtered };
        filtered.push({ source: 'builtin', reason });
    }
    return { line: NOTHING_PASSED, source: 'none', filtered };
}

export default { ADJECTIVES, NOUNS, COMPARISONS, LINES, TEMPLATES, PART_COUNT, generateInsult, pickInsult };
