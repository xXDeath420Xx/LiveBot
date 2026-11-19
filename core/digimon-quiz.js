/*
 * "Which Digital Monster are you today?" — the pure parts (unit-tested in tests/digimon-logic.test.js).
 *
 * No AI anywhere. The bank is split into categories; each day draws five different categories and one
 * question from each, by the date, so everyone gets the same five that day (UTC) and can compare. A server
 * can edit, turn off or add questions on the dashboard (table digimon_quiz_questions, see buildBank); servers
 * that have not keep the built-in bank. Every answer carries five tags:
 *
 *   a  attribute   Vaccine / Data / Virus / Free
 *   f  field       one of the nine fields (Virus Busters, Nature Spirits ...)
 *   t  family      one of FAMILIES, matched against the Digimon's own types (Dragon Man → dragon)
 *   c  crest       one of CRESTS, the result's Crest of the day
 *   p  power       0 (sleepy) to 3 (unstoppable), summed into the stage
 *
 * The result is a Digimon at the scored stage, ranked by how many of attribute, field and family it shares
 * with the answers; the last tie goes to a hash of the member and the day, so the same answers on the same
 * day always give the same Digimon.
 */
import { stableHash } from './digimon-logic.js';

export const QUESTIONS_PER_DAY = 5;
export const POWER_LEVELS = ['Baby II', 'Child', 'Adult', 'Perfect', 'Ultimate'];

// Power total of five answers (0-15) → stage. Measured over a year of question sets with random answers:
// roughly Baby II 13%, Child 32%, Adult 20%, Perfect 17%, Ultimate 19% (totals are whole numbers, so not exact).
const POWER_CUTS = [5, 7, 8, 9];

export const CATEGORIES = {
    daily: 'Daily life',
    adventure: 'Adventure',
    battle: 'Battle',
    friends: 'Friends and community',
    creative: 'Creative and streaming',
    digital: 'The Digital World',
};

/** Creature families, each matched by keywords in a Digimon's types. Order matters: first match wins. */
export const FAMILIES = [
    ['holy', 'holy', /angel|holy|cherub|seraph|ophan|god man|archangel|virtue|dominion|principality|power|monk|tath|avatar|god beast/i],
    ['dark', 'dark', /demon|devil|fallen|evil|undead|ghost|skeleton|dark|oni|wicked|puppet/i],
    ['aquatic', 'sea', /aquatic|marine|ocean|fish|mollusk|crustacean|plesiosaur/i],
    ['bird', 'sky', /bird|chick|pterosaur/i],
    ['dragon', 'dragon', /dragon|dinosaur|reptile|saur|ceratopsian|amphibian/i],
    ['insect', 'insect', /insect|larva|parasite/i],
    ['plant', 'nature', /plant|bulb|food/i],
    ['machine', 'machine', /cyborg|machine|mechanical|weapon|armor|card|mine\b|toy|instrument|enhancement|lcd/i],
    ['warrior', 'warrior', /knight|warrior|man\b/i],
    ['beast', 'beast', /beast|mammal/i],
    ['mystic', 'mystic', /./],
];

export const CRESTS = {
    courage: { name: 'Courage', line: 'You run toward the problem, not away from it.' },
    friendship: { name: 'Friendship', line: 'Your people are your power-up.' },
    love: { name: 'Love', line: 'You care loudly, and it shows.' },
    knowledge: { name: 'Knowledge', line: 'You want to know how everything works.' },
    sincerity: { name: 'Sincerity', line: 'What you say is what you mean.' },
    reliability: { name: 'Reliability', line: 'People count on you, and you show up.' },
    hope: { name: 'Hope', line: 'You see the way through before anyone else does.' },
    light: { name: 'Light', line: 'You make the room brighter just by being in it.' },
    kindness: { name: 'Kindness', line: 'Gentle, patient, and stronger than it looks.' },
    miracles: { name: 'Miracles', line: 'Things just seem to work out around you.' },
};

const O = (label, a, f, t, c, p) => ({ label, a, f, t, c, p });
const VB = 'Virus Busters', NS = 'Nature Spirits', ME = 'Metal Empire', NSo = 'Nightmare Soldiers', JT = 'Jungle Troopers',
    DS = 'Deep Savers', WG = 'Wind Guardians', DA = 'Dark Area', DR = "Dragon's Roar";

export const ATTRIBUTES = ['Vaccine', 'Data', 'Virus', 'Free'];
export const FIELDS = [VB, NS, ME, NSo, JT, DS, WG, DA, DR];
export const POWER_WORDS = ['Sleepy', 'Steady', 'Strong', 'Unstoppable'];   // what p 0-3 means, for the editor

export const QUESTION_BANK = [
    // ── Daily life
    { cat: 'daily', q: 'Your alarm goes off. What happens next?', options: [
        O('Up and moving before it stops', 'Vaccine', VB, 'warrior', 'courage', 3), O('Snooze. Snooze again.', 'Free', NS, 'plant', 'kindness', 0),
        O('I was already awake, planning', 'Data', ME, 'machine', 'knowledge', 2), O('What alarm? I never slept', 'Virus', NSo, 'dark', 'miracles', 1)] },
    { cat: 'daily', q: 'Choose a snack.', options: [
        O('Fresh fruit', 'Vaccine', NS, 'plant', 'kindness', 1), O('Sushi', 'Data', DS, 'aquatic', 'sincerity', 1),
        O('Something extremely spicy', 'Virus', DR, 'dragon', 'courage', 2), O('Whatever is closest', 'Free', JT, 'beast', 'reliability', 0)] },
    { cat: 'daily', q: 'What music fits your mood?', options: [
        O('Something heavy and loud', 'Virus', DR, 'dragon', 'courage', 3), O('Lo-fi beats', 'Data', DS, 'aquatic', 'sincerity', 0),
        O('An epic soundtrack', 'Vaccine', VB, 'holy', 'hope', 2), O('Birdsong and rain', 'Free', NS, 'bird', 'kindness', 0)] },
    { cat: 'daily', q: 'Pick a time of day.', options: [
        O('Sunrise', 'Vaccine', VB, 'holy', 'hope', 2), O('High noon', 'Free', WG, 'bird', 'light', 2),
        O('Sunset by the water', 'Data', DS, 'aquatic', 'love', 1), O('Three in the morning', 'Virus', NSo, 'dark', 'miracles', 1)] },
    { cat: 'daily', q: 'How do you handle a messy room?', options: [
        O('Clean it all, right now', 'Vaccine', VB, 'warrior', 'reliability', 2), O('Sort it into a system', 'Data', JT, 'insect', 'reliability', 1),
        O('It is a cozy nest, actually', 'Free', JT, 'beast', 'kindness', 0), O('Shut the door', 'Virus', NSo, 'dark', 'miracles', 1)] },
    { cat: 'daily', q: 'Choose a weather.', options: [
        O('A thunderstorm', 'Virus', DR, 'dragon', 'courage', 3), O('A breezy, clear day', 'Vaccine', WG, 'bird', 'hope', 1),
        O('Fog over the ocean', 'Data', DS, 'aquatic', 'sincerity', 1), O('Warm summer rain', 'Free', JT, 'plant', 'kindness', 0)] },
    { cat: 'daily', q: 'What gets you through a long day?', options: [
        O('Coffee, lots of it', 'Virus', DR, 'dragon', 'courage', 2), O('A good playlist', 'Data', WG, 'machine', 'sincerity', 1),
        O('A walk outside', 'Free', NS, 'plant', 'kindness', 1), O('Knowing I helped someone', 'Vaccine', VB, 'holy', 'love', 1)] },
    { cat: 'daily', q: 'Pick a season.', options: [
        O('Spring', 'Free', NS, 'plant', 'hope', 1), O('Summer', 'Vaccine', WG, 'bird', 'light', 2),
        O('Autumn', 'Data', JT, 'beast', 'reliability', 1), O('Winter', 'Virus', DS, 'mystic', 'sincerity', 2)] },
    { cat: 'daily', q: 'Your phone is at 3% battery. You...', options: [
        O('Find a charger like it is a quest', 'Vaccine', VB, 'warrior', 'courage', 2), O('Already carry a power bank', 'Data', ME, 'machine', 'reliability', 1),
        O('Let it die and enjoy the quiet', 'Free', NS, 'plant', 'kindness', 0), O('Push it to 0% for the thrill', 'Virus', DA, 'dark', 'miracles', 2)] },
    { cat: 'daily', q: 'Pick a drink.', options: [
        O('Iced coffee', 'Data', ME, 'machine', 'knowledge', 2), O('Hot cocoa', 'Free', NS, 'beast', 'love', 0),
        O('An energy drink', 'Virus', DR, 'dragon', 'courage', 3), O('Plain water, sensible', 'Vaccine', DS, 'aquatic', 'sincerity', 1)] },
    { cat: 'daily', q: 'Your ideal day off is...', options: [
        O('A full day out with no plan', 'Vaccine', WG, 'bird', 'hope', 2), O('Catching up on a long game', 'Data', ME, 'machine', 'knowledge', 1),
        O('Blankets, snacks, a show', 'Free', NS, 'beast', 'kindness', 0), O('Staying up very late', 'Virus', NSo, 'dark', 'miracles', 1)] },
    { cat: 'daily', q: 'You find money in an old jacket. You...', options: [
        O('Treat a friend', 'Vaccine', VB, 'holy', 'friendship', 1), O('Save it', 'Data', ME, 'machine', 'reliability', 1),
        O('Buy snacks immediately', 'Free', JT, 'beast', 'love', 1), O('Spend it on something chaotic', 'Virus', DA, 'dark', 'miracles', 2)] },

    // ── Adventure
    { cat: 'adventure', q: 'Pick a place to spend the afternoon.', options: [
        O('Deep in a forest', 'Free', JT, 'plant', 'kindness', 1), O('On a beach, or under the waves', 'Data', DS, 'aquatic', 'sincerity', 1),
        O('A rooftop with a strong wind', 'Vaccine', WG, 'bird', 'hope', 2), O('Somewhere dark and quiet', 'Virus', DA, 'dark', 'miracles', 2)] },
    { cat: 'adventure', q: 'Pick a way to travel.', options: [
        O('Flying', 'Vaccine', WG, 'bird', 'hope', 3), O('By submarine', 'Data', DS, 'aquatic', 'knowledge', 2),
        O('On foot, no hurry', 'Free', JT, 'beast', 'kindness', 0), O('Teleporting through shadows', 'Virus', DA, 'dark', 'miracles', 2)] },
    { cat: 'adventure', q: 'Which place would you guard?', options: [
        O('The sky above a city', 'Vaccine', WG, 'bird', 'reliability', 2), O('A sunken shipwreck', 'Data', DS, 'aquatic', 'knowledge', 1),
        O('An ancient forest', 'Free', JT, 'plant', 'kindness', 1), O('A haunted castle', 'Virus', NSo, 'dark', 'courage', 2)] },
    { cat: 'adventure', q: 'Choose a treasure.', options: [
        O('A shining sword', 'Vaccine', DR, 'warrior', 'courage', 3), O('An ancient computer', 'Data', ME, 'machine', 'knowledge', 2),
        O('A seed that grows anything', 'Free', JT, 'plant', 'hope', 1), O('A cursed crown', 'Virus', DA, 'dark', 'miracles', 2)] },
    { cat: 'adventure', q: 'You find a strange glowing egg. You...', options: [
        O('Protect it until it hatches', 'Vaccine', VB, 'holy', 'reliability', 1), O('Scan it to learn what it is', 'Data', ME, 'machine', 'knowledge', 2),
        O('Keep it warm and sing to it', 'Free', NS, 'beast', 'love', 0), O('Shake it. Just a little.', 'Virus', DA, 'mystic', 'miracles', 3)] },
    { cat: 'adventure', q: 'A map shows two paths. You take...', options: [
        O('The one with the dragon on it', 'Vaccine', DR, 'dragon', 'courage', 3), O('The one that is shorter on paper', 'Data', ME, 'machine', 'knowledge', 1),
        O('The pretty one by the river', 'Free', DS, 'aquatic', 'kindness', 0), O('Neither. I make my own.', 'Virus', DA, 'mystic', 'hope', 2)] },
    { cat: 'adventure', q: 'What do you pack first?', options: [
        O('A first-aid kit', 'Vaccine', VB, 'holy', 'reliability', 1), O('A map and a compass', 'Data', ME, 'machine', 'knowledge', 1),
        O('Snacks for everyone', 'Free', JT, 'beast', 'friendship', 0), O('Nothing. Adventure provides.', 'Virus', WG, 'bird', 'miracles', 2)] },
    { cat: 'adventure', q: 'You hear a noise in a cave. You...', options: [
        O('Go in first', 'Vaccine', VB, 'warrior', 'courage', 3), O('Throw a pebble and listen', 'Data', JT, 'insect', 'knowledge', 1),
        O('Call out hello, politely', 'Free', NS, 'beast', 'kindness', 0), O('Make a scarier noise back', 'Virus', NSo, 'dark', 'miracles', 2)] },
    { cat: 'adventure', q: 'Pick a landmark to visit.', options: [
        O('A volcano', 'Virus', DR, 'dragon', 'courage', 3), O('A floating island', 'Vaccine', WG, 'bird', 'hope', 2),
        O('A coral reef', 'Data', DS, 'aquatic', 'sincerity', 1), O('A giant tree', 'Free', JT, 'plant', 'kindness', 1)] },
    { cat: 'adventure', q: 'Lost in a new city, you...', options: [
        O('Ask the nearest person', 'Vaccine', VB, 'warrior', 'friendship', 1), O('Open the map and reroute', 'Data', ME, 'machine', 'knowledge', 1),
        O('Wander. Getting lost is the fun part.', 'Free', WG, 'bird', 'hope', 1), O('Follow the strangest alley', 'Virus', NSo, 'dark', 'miracles', 2)] },
    { cat: 'adventure', q: 'You find a hidden garden full of giant bugs. You...', options: [
        O('Make friends with the biggest one', 'Free', JT, 'insect', 'friendship', 1), O('Study how their hive works', 'Data', JT, 'insect', 'knowledge', 2),
        O('Guard it from anyone who would harm it', 'Vaccine', VB, 'warrior', 'reliability', 2), O('Ride the beetle. Obviously.', 'Virus', DR, 'insect', 'courage', 3)] },
    { cat: 'adventure', q: 'Choose a camping spot.', options: [
        O('Top of the mountain', 'Vaccine', WG, 'bird', 'courage', 3), O('Next to a lake', 'Data', DS, 'aquatic', 'sincerity', 1),
        O('Deep in the woods', 'Free', JT, 'beast', 'kindness', 1), O('In the ruins nobody visits', 'Virus', DA, 'mystic', 'miracles', 2)] },

    // ── Battle
    { cat: 'battle', q: 'A friend is in trouble. You...', options: [
        O('Charge in, no plan needed', 'Vaccine', DR, 'dragon', 'courage', 3), O('Work out the smartest fix first', 'Data', ME, 'machine', 'knowledge', 2),
        O('Bring snacks and a hug', 'Free', NS, 'beast', 'love', 1), O('Quietly make the problem disappear', 'Virus', NSo, 'dark', 'reliability', 2)] },
    { cat: 'battle', q: 'Someone challenges you to a game. You...', options: [
        O('Accept and play to win', 'Vaccine', DR, 'warrior', 'courage', 3), O('Read the rules twice first', 'Data', JT, 'insect', 'sincerity', 1),
        O('Play, but mostly for fun', 'Free', NS, 'beast', 'friendship', 1), O('Find the loophole', 'Virus', DA, 'dark', 'miracles', 2)] },
    { cat: 'battle', q: 'Pick a superpower.', options: [
        O('Flight', 'Vaccine', WG, 'bird', 'hope', 2), O('Talking to animals', 'Free', JT, 'beast', 'kindness', 1),
        O('Controlling machines', 'Data', ME, 'machine', 'knowledge', 3), O('Walking through shadows', 'Virus', NSo, 'dark', 'miracles', 2)] },
    { cat: 'battle', q: 'Pick an element.', options: [
        O('Fire', 'Vaccine', DR, 'dragon', 'courage', 3), O('Water', 'Data', DS, 'aquatic', 'sincerity', 1),
        O('Earth', 'Free', JT, 'plant', 'reliability', 1), O('Shadow', 'Virus', DA, 'dark', 'miracles', 2)] },
    { cat: 'battle', q: 'How do you like your games?', options: [
        O('Competitive, ranked, sweaty', 'Vaccine', DR, 'warrior', 'courage', 3), O('Strategy and puzzles', 'Data', ME, 'machine', 'knowledge', 2),
        O('Cozy farming and building', 'Free', NS, 'plant', 'kindness', 0), O('Horror, lights off', 'Virus', NSo, 'dark', 'miracles', 2)] },
    { cat: 'battle', q: 'Pick a creature.', options: [
        O('A dragon', 'Vaccine', DR, 'dragon', 'courage', 3), O('A robot', 'Data', ME, 'machine', 'knowledge', 2),
        O('A wolf', 'Free', JT, 'beast', 'friendship', 2), O('A ghost', 'Virus', NSo, 'dark', 'miracles', 1)] },
    { cat: 'battle', q: 'Your fighting style is...', options: [
        O('Hit hard, hit first', 'Virus', DR, 'dragon', 'courage', 3), O('Counter everything they do', 'Data', ME, 'machine', 'knowledge', 2),
        O('Protect the team, then strike', 'Vaccine', VB, 'holy', 'reliability', 2), O('Dodge until they get tired', 'Free', WG, 'bird', 'hope', 1)] },
    { cat: 'battle', q: 'Pick a weapon.', options: [
        O('A holy lance', 'Vaccine', VB, 'holy', 'light', 3), O('A laser cannon', 'Data', ME, 'machine', 'knowledge', 3),
        O('Claws and teeth', 'Free', JT, 'beast', 'courage', 2), O('A cursed scythe', 'Virus', NSo, 'dark', 'miracles', 3)] },
    { cat: 'battle', q: 'You lost a match. Next you...', options: [
        O('Queue again right away', 'Vaccine', DR, 'warrior', 'courage', 3), O('Watch the replay and take notes', 'Data', ME, 'machine', 'knowledge', 1),
        O('Shrug and have a snack', 'Free', NS, 'beast', 'kindness', 0), O('Plot revenge', 'Virus', DA, 'dark', 'miracles', 2)] },
    { cat: 'battle', q: 'Pick armor.', options: [
        O('Shining plate', 'Vaccine', VB, 'warrior', 'reliability', 2), O('Nano-tech suit', 'Data', ME, 'machine', 'knowledge', 2),
        O('Thick fur, no armor needed', 'Free', JT, 'beast', 'kindness', 1), O('Bone and shadow', 'Virus', NSo, 'dark', 'miracles', 3)] },
    { cat: 'battle', q: 'The final boss appears. You...', options: [
        O('Grin. Finally.', 'Virus', DR, 'dragon', 'courage', 3), O('Look for its weak point', 'Data', ME, 'machine', 'knowledge', 2),
        O('Rally everyone together', 'Vaccine', VB, 'holy', 'friendship', 2), O('Believe it will work out', 'Free', WG, 'bird', 'hope', 1)] },
    { cat: 'battle', q: 'What wins a battle?', options: [
        O('Raw power', 'Virus', DR, 'dragon', 'courage', 3), O('A better plan', 'Data', ME, 'machine', 'knowledge', 2),
        O('Teamwork', 'Vaccine', VB, 'warrior', 'friendship', 1), O('Heart', 'Free', NS, 'beast', 'love', 1)] },

    // ── Friends and community
    { cat: 'friends', q: 'Your ideal partner would be...', options: [
        O('Brave and loyal', 'Vaccine', DR, 'dragon', 'friendship', 2), O('Clever and calm', 'Data', DS, 'aquatic', 'knowledge', 1),
        O('Gentle and kind', 'Free', NS, 'plant', 'kindness', 0), O('A little bit chaotic', 'Virus', DA, 'dark', 'miracles', 2)] },
    { cat: 'friends', q: 'Your friends describe you as...', options: [
        O('The protector', 'Vaccine', VB, 'warrior', 'reliability', 2), O('The brain', 'Data', ME, 'machine', 'knowledge', 2),
        O('The heart', 'Free', NS, 'beast', 'love', 1), O('The wildcard', 'Virus', DA, 'dark', 'miracles', 3)] },
    { cat: 'friends', q: 'What do you bring to a team?', options: [
        O('Courage', 'Vaccine', VB, 'warrior', 'courage', 2), O('The plan', 'Data', ME, 'machine', 'knowledge', 2),
        O('Good vibes', 'Free', NS, 'insect', 'light', 1), O('The surprise move nobody saw coming', 'Virus', DA, 'dark', 'miracles', 3)] },
    { cat: 'friends', q: 'Someone is rude in chat. You...', options: [
        O('Step in and set it right', 'Vaccine', VB, 'holy', 'courage', 2), O('Screenshot it and tell a mod', 'Data', DS, 'aquatic', 'sincerity', 1),
        O('Change the subject with a joke', 'Free', NS, 'beast', 'kindness', 0), O('Roast them back', 'Virus', DR, 'dragon', 'courage', 3)] },
    { cat: 'friends', q: 'The server is quiet tonight. You...', options: [
        O('Start a game for everyone', 'Vaccine', VB, 'warrior', 'friendship', 2), O('Fix the channel list while it is calm', 'Data', JT, 'insect', 'reliability', 1),
        O('Enjoy the peace', 'Free', NS, 'plant', 'kindness', 0), O('Post a cursed meme to wake it up', 'Virus', NSo, 'dark', 'miracles', 2)] },
    { cat: 'friends', q: 'What would your Digimon partner say about you?', options: [
        O('Always has my back', 'Vaccine', VB, 'warrior', 'reliability', 2), O('Never runs out of ideas', 'Data', WG, 'bird', 'knowledge', 2),
        O('Feeds me too many snacks', 'Free', NS, 'beast', 'love', 0), O('A bit scary, honestly', 'Virus', NSo, 'dark', 'courage', 3)] },
    { cat: 'friends', q: 'Pick a sidekick.', options: [
        O('A tiny loyal bird', 'Vaccine', WG, 'bird', 'friendship', 1), O('A clever little drone', 'Data', ME, 'machine', 'knowledge', 1),
        O('A sleepy frog', 'Free', DS, 'aquatic', 'kindness', 0), O('A bat that only listens to you', 'Virus', NSo, 'dark', 'miracles', 2)] },
    { cat: 'friends', q: 'A new member joins. You...', options: [
        O('Welcome them first', 'Vaccine', VB, 'holy', 'light', 1), O('Point them to the rules and roles', 'Data', JT, 'insect', 'friendship', 1),
        O('Send a friendly emoji', 'Free', NS, 'beast', 'kindness', 0), O('Test them with a weird question', 'Virus', DA, 'mystic', 'miracles', 2)] },
    { cat: 'friends', q: 'Your group cannot pick a game. You...', options: [
        O('Pick one and lead the way', 'Vaccine', DR, 'warrior', 'courage', 2), O('Make a poll', 'Data', JT, 'insect', 'friendship', 1),
        O('Happy with whatever', 'Free', NS, 'plant', 'kindness', 0), O('Suggest the strangest one', 'Virus', DA, 'mystic', 'miracles', 2)] },
    { cat: 'friends', q: 'How do you cheer someone up?', options: [
        O('Take them on an adventure', 'Vaccine', WG, 'bird', 'hope', 2), O('Fix whatever went wrong', 'Data', ME, 'machine', 'reliability', 1),
        O('Listen and send a hug', 'Free', NS, 'beast', 'love', 0), O('Make them laugh until it hurts', 'Virus', DA, 'mystic', 'light', 2)] },
    { cat: 'friends', q: 'Your role in a group chat is...', options: [
        O('The one who organises', 'Vaccine', VB, 'warrior', 'reliability', 2), O('The one with the facts', 'Data', ME, 'machine', 'knowledge', 1),
        O('The one who reacts to everything', 'Free', NS, 'beast', 'friendship', 0), O('The meme supplier', 'Virus', DA, 'dark', 'light', 2)] },
    { cat: 'friends', q: 'A friend forgets your birthday. You...', options: [
        O('Remind them with a party', 'Vaccine', WG, 'bird', 'light', 2), O('It is fine, everyone is busy', 'Data', DS, 'aquatic', 'sincerity', 0),
        O('Celebrate anyway with snacks', 'Free', JT, 'beast', 'kindness', 1), O('Never let them forget it', 'Virus', NSo, 'dark', 'love', 2)] },

    // ── Creative and streaming
    { cat: 'creative', q: 'Your stream or project just hit a big milestone. You...', options: [
        O('Celebrate with everyone, loudly', 'Vaccine', VB, 'holy', 'friendship', 3), O('Check the numbers and plan the next one', 'Data', ME, 'machine', 'knowledge', 2),
        O('Say thanks and get back to it', 'Free', WG, 'bird', 'sincerity', 1), O('Act like it was always going to happen', 'Virus', DA, 'dark', 'miracles', 2)] },
    { cat: 'creative', q: 'You get a free afternoon. What do you make?', options: [
        O('Art, music or a stream', 'Free', NS, 'plant', 'love', 1), O('Something with code or tools', 'Data', ME, 'machine', 'knowledge', 2),
        O('A plan to help someone', 'Vaccine', VB, 'holy', 'kindness', 1), O('Mischief', 'Virus', DA, 'dark', 'miracles', 2)] },
    { cat: 'creative', q: 'Pick a stream setup.', options: [
        O('Three monitors and RGB everywhere', 'Data', ME, 'machine', 'knowledge', 3), O('Cozy lamp and plants', 'Free', NS, 'plant', 'kindness', 0),
        O('A camera, a mic and a big smile', 'Vaccine', WG, 'bird', 'light', 2), O('Lights off, one red glow', 'Virus', NSo, 'dark', 'miracles', 2)] },
    { cat: 'creative', q: 'Your favourite thing to create is...', options: [
        O('Drawings and art', 'Free', NS, 'plant', 'love', 1), O('Music', 'Vaccine', WG, 'bird', 'light', 2),
        O('Videos and edits', 'Data', ME, 'machine', 'knowledge', 2), O('Chaos, mostly', 'Virus', DA, 'mystic', 'miracles', 3)] },
    { cat: 'creative', q: 'A chatter asks for advice. You...', options: [
        O('Give it straight, kindly', 'Vaccine', VB, 'holy', 'love', 1), O('Write them a full guide', 'Data', ME, 'machine', 'knowledge', 2),
        O('Tell them they are doing great', 'Free', NS, 'beast', 'kindness', 0), O('Tell them to break the rules', 'Virus', DA, 'dark', 'courage', 2)] },
    { cat: 'creative', q: 'Pick a colour palette.', options: [
        O('Gold and white', 'Vaccine', VB, 'holy', 'light', 2), O('Neon blue and chrome', 'Data', ME, 'machine', 'knowledge', 2),
        O('Leaf green and sky blue', 'Free', NS, 'plant', 'hope', 1), O('Black and blood red', 'Virus', NSo, 'dark', 'courage', 3)] },
    { cat: 'creative', q: 'Your art style is...', options: [
        O('Bold and bright', 'Vaccine', DR, 'dragon', 'courage', 2), O('Clean and precise', 'Data', ME, 'machine', 'sincerity', 1),
        O('Soft and dreamy', 'Free', DS, 'aquatic', 'kindness', 0), O('Weird and spooky', 'Virus', NSo, 'dark', 'miracles', 2)] },
    { cat: 'creative', q: 'Your stream goes offline mid-game. You...', options: [
        O('Reboot fast and come back stronger', 'Vaccine', DR, 'warrior', 'courage', 3), O('Fix the settings so it never happens again', 'Data', ME, 'machine', 'reliability', 2),
        O('Take it as a sign to have a break', 'Free', NS, 'plant', 'kindness', 0), O('Make the outage part of the lore', 'Virus', DA, 'mystic', 'miracles', 2)] },
    { cat: 'creative', q: 'Pick a theme for your next project.', options: [
        O('Heroes and light', 'Vaccine', VB, 'holy', 'hope', 2), O('Robots and the future', 'Data', ME, 'machine', 'knowledge', 2),
        O('Animals and nature', 'Free', JT, 'beast', 'kindness', 1), O('Monsters and myths', 'Virus', NSo, 'mystic', 'courage', 2)] },
    { cat: 'creative', q: 'Someone copies your idea. You...', options: [
        O('Make something even better', 'Vaccine', DR, 'dragon', 'courage', 3), O('Keep receipts, calmly', 'Data', JT, 'insect', 'sincerity', 1),
        O('Take it as a compliment', 'Free', NS, 'plant', 'kindness', 0), O('Turn it into a rivalry arc', 'Virus', DA, 'dark', 'miracles', 2)] },
    { cat: 'creative', q: 'What makes a perfect collab?', options: [
        O('Big energy from both sides', 'Vaccine', WG, 'bird', 'light', 2), O('A clear plan and roles', 'Data', JT, 'insect', 'friendship', 1),
        O('Good friends, no pressure', 'Free', JT, 'beast', 'friendship', 0), O('No script at all', 'Virus', DA, 'mystic', 'miracles', 2)] },
    { cat: 'creative', q: 'Your emote would be...', options: [
        O('A thumbs up with sparkles', 'Vaccine', VB, 'holy', 'light', 1), O('A little robot nodding', 'Data', ME, 'machine', 'knowledge', 1),
        O('A sleepy cat', 'Free', NS, 'beast', 'kindness', 0), O('Glowing eyes in the dark', 'Virus', NSo, 'dark', 'miracles', 2)] },

    // ── The Digital World
    { cat: 'digital', q: 'You wake up in the Digital World. First move?', options: [
        O('Look for someone to protect', 'Vaccine', VB, 'holy', 'reliability', 2), O('Figure out how this world works', 'Data', ME, 'machine', 'knowledge', 2),
        O('Make friends with the first Digimon', 'Free', NS, 'beast', 'friendship', 1), O('Head straight for the forbidden zone', 'Virus', DA, 'dark', 'courage', 3)] },
    { cat: 'digital', q: 'Pick a Digivice colour.', options: [
        O('Orange', 'Vaccine', DR, 'dragon', 'courage', 2), O('Blue', 'Data', DS, 'aquatic', 'friendship', 1),
        O('Pink', 'Free', NS, 'plant', 'love', 1), O('Black', 'Virus', DA, 'dark', 'miracles', 2)] },
    { cat: 'digital', q: 'Your Digimon partner is hungry. You give it...', options: [
        O('A whole roast meat', 'Vaccine', DR, 'dragon', 'love', 2), O('Exactly the right nutrients', 'Data', ME, 'machine', 'knowledge', 1),
        O('Half of your own food', 'Free', JT, 'beast', 'kindness', 0), O('Something glowing and suspicious', 'Virus', NSo, 'mystic', 'miracles', 2)] },
    { cat: 'digital', q: 'Pick a home in the Digital World.', options: [
        O('File Island', 'Vaccine', VB, 'holy', 'hope', 1), O('A server tower city', 'Data', ME, 'machine', 'knowledge', 2),
        O('The Great Forest', 'Free', JT, 'plant', 'kindness', 1), O('The Dark Ocean', 'Virus', DA, 'aquatic', 'miracles', 2)] },
    { cat: 'digital', q: 'Your partner is about to digivolve. You shout...', options: [
        O('"You can do it!"', 'Vaccine', VB, 'holy', 'hope', 3), O('"Now, while its guard is down!"', 'Data', ME, 'machine', 'knowledge', 2),
        O('"Be careful!"', 'Free', NS, 'beast', 'love', 1), O('"Show them who we are!"', 'Virus', DR, 'dragon', 'courage', 3)] },
    { cat: 'digital', q: 'A wild Digimon blocks your path. You...', options: [
        O('Stand your ground', 'Vaccine', VB, 'warrior', 'courage', 3), O('Check its stats first', 'Data', JT, 'insect', 'knowledge', 1),
        O('Offer it a snack', 'Free', JT, 'beast', 'kindness', 0), O('Recruit it', 'Virus', DA, 'dark', 'miracles', 2)] },
    { cat: 'digital', q: 'Which Crest would you want?', options: [
        O('Courage', 'Vaccine', DR, 'dragon', 'courage', 3), O('Knowledge', 'Data', ME, 'machine', 'knowledge', 2),
        O('Kindness', 'Free', NS, 'beast', 'kindness', 1), O('Miracles', 'Virus', DA, 'mystic', 'miracles', 2)] },
    { cat: 'digital', q: 'Pick a sound your Digivice makes.', options: [
        O('A heroic fanfare', 'Vaccine', VB, 'holy', 'courage', 2), O('A precise beep-beep', 'Data', ME, 'machine', 'sincerity', 1),
        O('A soft chime', 'Free', NS, 'plant', 'kindness', 0), O('A glitchy static hiss', 'Virus', NSo, 'mystic', 'miracles', 2)] },
    { cat: 'digital', q: 'Pick a Digimon village to visit.', options: [
        O('Koromon Village', 'Free', NS, 'beast', 'kindness', 0), O('Toy Town', 'Data', ME, 'machine', 'light', 1),
        O('Primary Village, with all the eggs', 'Vaccine', VB, 'holy', 'hope', 1), O('Myotismon\'s castle', 'Virus', NSo, 'dark', 'courage', 3)] },
    { cat: 'digital', q: 'The Digital World is in danger. You...', options: [
        O('Lead the charge', 'Vaccine', DR, 'warrior', 'courage', 3), O('Hack the problem at its source', 'Data', ME, 'machine', 'knowledge', 3),
        O('Keep everyone safe', 'Free', NS, 'plant', 'reliability', 1), O('Make a deal with the villain', 'Virus', DA, 'dark', 'miracles', 2)] },
    { cat: 'digital', q: 'Pick a partner size.', options: [
        O('Pocket-sized', 'Free', NS, 'beast', 'love', 0), O('About as tall as me', 'Data', JT, 'warrior', 'friendship', 1),
        O('Big enough to ride', 'Vaccine', WG, 'bird', 'hope', 2), O('Bigger than a building', 'Virus', DR, 'dragon', 'courage', 3)] },
    { cat: 'digital', q: 'Your Digimon gets a cold. You...', options: [
        O('Stay by its side all night', 'Vaccine', VB, 'holy', 'love', 1), O('Find the right medicine', 'Data', NS, 'plant', 'love', 1),
        O('Make a blanket fort for two', 'Free', NS, 'beast', 'kindness', 0), O('Let it sneeze fireballs, it is fine', 'Virus', DR, 'dragon', 'miracles', 2)] },
];

/** UTC date as YYYY-MM-DD, the "today" of the quiz. */
export function quizDay(now = Date.now()) {
    return new Date(now).toISOString().slice(0, 10);
}

/**
 * The questions for a day: five different categories, one question from each, both picked by the date, so
 * the set is the same for everyone and the categories vary from day to day.
 */
export function questionsForDay(day, bank = QUESTION_BANK, count = QUESTIONS_PER_DAY) {
    const indexed = bank.map((question, index) => ({ ...question, index }));
    const cats = [...new Set(indexed.map(q => q.cat))]
        .map(cat => ({ cat, h: stableHash(`${day}:cat:${cat}`) }))
        .sort((x, y) => x.h - y.h)
        .slice(0, count)
        .map(x => x.cat);
    return cats.map(cat => indexed
        .filter(q => q.cat === cat)
        // `key` keeps a question's draw stable when others are turned off or added: a built-in keeps its place in
        // QUESTION_BANK (the same hash as before servers could edit), a server's own question is `c<id>`.
        .map(q => ({ q, h: stableHash(`${day}:q:${q.key ?? q.index}`) }))
        .sort((x, y) => x.h - y.h)[0].q);
}

/** Lengths Discord allows: a button label is at most 80 characters; the question sits in an embed. */
export const QUESTION_LIMITS = { question: 300, label: 80, minOptions: 2, maxOptions: 4 };

/**
 * Check a question from the editor. Returns { value } (cleaned) or { error } in plain words.
 * input { cat, q, options: [{ label, a, f, t, c, p }] }; field, family and Crest may be empty.
 */
export function validateQuestion(input) {
    const L = QUESTION_LIMITS;
    const cat = String(input?.cat ?? '');
    if (!CATEGORIES[cat]) return { error: 'Choose a category.' };
    const q = String(input?.q ?? '').trim();
    if (!q) return { error: 'Write the question.' };
    if (q.length > L.question) return { error: `The question is ${q.length} characters; the most is ${L.question}.` };
    const raw = Array.isArray(input?.options) ? input.options : [];
    if (raw.length < L.minOptions || raw.length > L.maxOptions) return { error: `Give ${L.minOptions} to ${L.maxOptions} answers.` };
    const familyKeys = FAMILIES.map(([k]) => k);
    const options = [];
    for (const [i, o] of raw.entries()) {
        const n = i + 1;
        const label = String(o?.label ?? '').trim();
        if (!label) return { error: `Answer ${n} has no text.` };
        if (label.length > L.label) return { error: `Answer ${n} is ${label.length} characters; buttons hold ${L.label}.` };
        if (!ATTRIBUTES.includes(o?.a)) return { error: `Choose an attribute for answer ${n}.` };
        const f = o?.f || null, t = o?.t || null, c = o?.c || null;
        if (f && !FIELDS.includes(f)) return { error: `Answer ${n} has an unknown field.` };
        if (t && !familyKeys.includes(t)) return { error: `Answer ${n} has an unknown family.` };
        if (c && !CRESTS[c]) return { error: `Answer ${n} has an unknown Crest.` };
        const p = Number(o?.p);
        if (!Number.isInteger(p) || p < 0 || p > 3) return { error: `Answer ${n} needs a power from 0 to 3.` };
        options.push({ label, a: o.a, f, t, c, p });
    }
    if (new Set(options.map(o => o.label.toLowerCase())).size !== options.length) return { error: 'Two answers have the same text.' };
    return { value: { cat, q, options } };
}

/**
 * A server's question bank from its digimon_quiz_questions rows ({ id, builtin_index, cat, q, options, enabled }).
 * A row with builtin_index replaces that built-in question (its wording and tags, or turns it off); a row
 * without one is the server's own question. No rows → the built-in bank. Each question gets a stable `key`.
 */
export function buildBank(rows = []) {
    const parse = v => (typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v);
    const overrides = new Map(rows.filter(r => r.builtin_index !== null && r.builtin_index !== undefined).map(r => [Number(r.builtin_index), r]));
    const bank = [];
    QUESTION_BANK.forEach((q, i) => {
        const o = overrides.get(i);
        if (o && !Number(o.enabled)) return;
        const options = o ? parse(o.options) : null;
        bank.push(o && options ? { cat: o.cat, q: o.q, options, key: i } : { ...q, key: i });
    });
    for (const r of rows) {
        if (r.builtin_index !== null && r.builtin_index !== undefined) continue;
        const options = parse(r.options);
        if (Number(r.enabled) && options) bank.push({ cat: r.cat, q: r.q, options, key: `c${r.id}` });
    }
    // A server that turned every question off still gets a quiz: the built-in one.
    return bank.length ? bank : QUESTION_BANK.map((q, i) => ({ ...q, key: i }));
}

/**
 * How a bank covers what the quiz can say: answers per attribute, field, family, Crest and power, and plain
 * warnings for what can never or only rarely come out. Used by the dashboard editor.
 */
export function bankBalance(bank) {
    const options = bank.flatMap(q => q.options);
    const count = (key, keys) => Object.fromEntries(keys.map(k => [k, options.filter(o => o[key] === k).length]));
    const families = FAMILIES.map(([k]) => k);
    const counts = {
        attribute: count('a', ATTRIBUTES), field: count('f', FIELDS), family: count('t', families),
        crest: count('c', Object.keys(CRESTS)), power: Object.fromEntries([0, 1, 2, 3].map(p => [p, options.filter(o => o.p === p).length])),
    };
    const warnings = [];
    const cats = new Set(bank.map(q => q.cat));
    if (cats.size < QUESTIONS_PER_DAY) {
        warnings.push(`Only ${cats.size} of ${Object.keys(CATEGORIES).length} categories have questions, so the quiz will have ${cats.size} question${cats.size === 1 ? '' : 's'} a day instead of ${QUESTIONS_PER_DAY}.`);
    }
    const none = (label, tally, name = k => k) => {
        const missing = Object.entries(tally).filter(([, n]) => n === 0).map(([k]) => name(k));
        if (missing.length) warnings.push(`No answer gives ${label} ${missing.join(', ')}, so ${missing.length === 1 ? 'it' : 'they'} can never be a result.`);
    };
    none('the attribute', counts.attribute);
    none('the Crest', counts.crest, k => CRESTS[k].name);
    none('the family', counts.family, k => familyWord(k));
    if (!counts.power[3]) warnings.push('No answer has power 3, so results will rarely reach Perfect and never Ultimate.');
    if (!counts.power[0]) warnings.push('No answer has power 0, so results will rarely be Baby II.');
    return { questions: bank.length, answers: options.length, categories: cats.size, counts, warnings };
}

const top = tally => Object.entries(tally).sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0] ?? null;

/*
 * A vote counts more for a rarer tag. Without this the common tags won most days: over 4,800 takes Courage
 * was 32% of Crests and Light 1%, beast 27% of families and mystic 0.6%, because a tag on 44 answers turns
 * up in a day's five far more often than one on 14. Each vote is weighted by (mean / count) ** WEIGHT_POWER.
 */
// Full inverse weighting (power 1) overcorrected: Friendship rose to 22% and Courage fell to 4%. The square root
// lands in between (measured, see tests).
const WEIGHT_POWER = 0.5;
function tagWeights(key, bank) {
    const counts = {};
    for (const o of bank.flatMap(q => q.options)) if (o[key]) counts[o[key]] = (counts[o[key]] ?? 0) + 1;
    const mean = Object.values(counts).reduce((a, b) => a + b, 0) / Object.keys(counts).length;
    return Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, (mean / n) ** WEIGHT_POWER]));
}
/** Vote weights for a bank: a server that edits its questions gets weights from its own answers. */
export const weightsFor = bank => ({ f: tagWeights('f', bank), t: tagWeights('t', bank), c: tagWeights('c', bank) });
const WEIGHT = weightsFor(QUESTION_BANK);

/** Answers ([{ a, f, t, c, p }]) → { attribute, field, family, crest, level }. `weight` from weightsFor(bank). */
export function scoreAnswers(answers, weight = WEIGHT) {
    const attr = {}, field = {}, fam = {}, crest = {};
    const vote = (tally, key, tag) => { if (tag) tally[tag] = (tally[tag] ?? 0) + (weight[key][tag] ?? 1); };
    let power = 0;
    for (const ans of answers) {
        attr[ans.a] = (attr[ans.a] ?? 0) + 1;
        vote(field, 'f', ans.f);
        vote(fam, 't', ans.t);
        vote(crest, 'c', ans.c);
        power += ans.p;
    }
    // Scaled so a different number of questions keeps the same spread.
    const total = answers.length ? power * QUESTIONS_PER_DAY / answers.length : 0;
    const tier = POWER_CUTS.filter(cut => total > cut).length;
    return { attribute: top(attr), field: top(field), family: top(fam), crest: top(crest), level: POWER_LEVELS[tier] };
}

/** A Digimon's family from its types, or null when it has none. */
export function familyOf(types = []) {
    if (!types.length) return null;
    const text = types.join(' ');
    return FAMILIES.find(([, , re]) => re.test(text))?.[0] ?? null;
}

/** Plain-words name of a family, for titles: "dragon", "sea", "sky"... */
export const familyWord = key => FAMILIES.find(([k]) => k === key)?.[1] ?? key;

/**
 * The Digimon for a result. `digimon` = [{ id, name, level, attributes: [..], fields: [..], types: [..] }].
 * Always at the scored stage when that stage has any Digimon; within it, the ones sharing the most of
 * attribute (3), field (2) and family (2) with the answers, then a stable hash of member and day.
 */
export function pickDigimon(result, digimon, userId, day) {
    const ties = bestMatches(result, digimon);
    if (!ties.length) return null;
    return ties
        .map(d => ({ d, h: stableHash(`${userId}:${day}:${d.id}`) }))
        .sort((x, y) => x.h - y.h)[0].d;
}

/**
 * The Digimon tied for the best match to a result; pickDigimon chooses among them by member and day, so each is
 * equally likely. Also used by core/digimon-quiz-odds.js, which is why it is separate.
 */
export function bestMatches(result, digimon) {
    const atStage = digimon.filter(d => d.level === result.level);
    const pool = atStage.length ? atStage : digimon;
    if (!pool.length) return [];
    // A Digimon listed in many fields matches almost any answer set (Patamon came up in 5.6% of results), so
    // a field match counts fully only for Digimon with three fields or fewer.
    const score = d => (d.attributes.includes(result.attribute) ? 3 : 0)
        + (d.fields.includes(result.field) ? (d.fields.length <= 3 ? 2 : 1) : 0)
        + (result.family && familyOf(d.types ?? []) === result.family ? 2 : 0);
    let best = -1, ties = [];
    for (const d of pool) {
        const s = score(d);
        if (s > best) { best = s; ties = [d]; } else if (s === best) ties.push(d);
    }
    return ties;
}

/** A signature move for the day, picked from the Digimon's own skills by member and day. */
export function signatureMove(d, userId, day) {
    const skills = d.skills ?? [];
    return skills.length ? skills[stableHash(`${userId}:${day}:move`) % skills.length] : null;
}
