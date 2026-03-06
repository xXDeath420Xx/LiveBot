/**
 * Seed script for stoner thoughts and trivia questions
 */

import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
});

// Stoner thoughts - philosophical, funny, mind-bending
const stonerThoughts = [
    // Philosophical
    "If you think about it, your future self is watching you right now through memories.",
    "The word 'bed' actually looks like a bed.",
    "We're all just the universe experiencing itself subjectively.",
    "Your stomach thinks all potatoes are mashed.",
    "Every book is just a different combination of 26 letters.",
    "Sand is called sand because it's between the sea and land.",
    "The brain named itself.",
    "You've never actually seen your own face, only reflections and pictures of it.",
    "We drink water, but we are also mostly water. We're just water drinking water.",
    "The youngest picture of you is also the oldest picture of you.",
    "If poison expires, is it more poisonous or less poisonous?",
    "Every mirror you buy is already used.",
    "Fire trucks are actually water trucks.",
    "The word 'incorrectly' is spelled incorrectly in almost every dictionary.",
    "Clapping is just hitting yourself because you're happy.",
    "At some point in your life, your parents put you down and never picked you up again.",
    "You've been on both sides of a locked door your entire life.",
    "Lasagna is just spaghetti flavored cake.",
    "The letter 'W' is the only letter that doesn't sound like it's spelled.",
    "If you clean a vacuum cleaner, you become the vacuum cleaner.",

    // Mind-bending
    "Nothing is ever on fire. Fire is on things.",
    "The object in your left hand is the eastern-most thing you've ever held.",
    "Every single decision you've ever made has led you to reading this sentence.",
    "You can't stand backwards on stairs.",
    "When you wait for a waiter, don't you become the waiter?",
    "If Cinderella's shoe fit perfectly, why did it fall off?",
    "Why is it called a building if it's already built?",
    "If you drop soap on the floor, is the floor clean or is the soap dirty?",
    "You can't hum while holding your nose closed.",
    "The youngest photo of you is also the oldest photo of you.",
    "If we evolved from monkeys, why are there still monkeys?",
    "Is water wet or does it just make things wet?",
    "If you try to fail and succeed, which have you done?",
    "Why do we drive on a parkway but park on a driveway?",
    "If tomatoes are fruits, is ketchup a smoothie?",

    // Cannabis specific
    "The person who discovered milk... what were they doing with that cow?",
    "Whoever invented the knock knock joke deserves a no bell prize.",
    "Maybe plants are farming us by giving us oxygen until we die and decompose.",
    "If everyone on earth jumped at the same time, would the earth move?",
    "Why do we say 'heads up' when we want people to duck?",
    "The word 'queue' is just 'Q' followed by four silent letters.",
    "If you're waiting for the waiter, aren't you the waiter?",
    "What if our entire reality is just a simulation running on someone's computer?",
    "Every time you eat, something died so you could live.",
    "The word 'swims' upside down is still 'swims'.",
    "Is a hotdog a sandwich?",
    "If you punch yourself and it hurts, are you strong or weak?",
    "Your bones are wet right now.",
    "We have no idea what the average IQ of all humans who ever lived was.",
    "When you drink water, you're just watering your meat suit.",
    "Oranges are called oranges but bananas aren't called yellows.",
    "Why is the word 'abbreviation' so long?",
    "Saying 'start now' is a paradox because by the time you finish saying it, now is already gone.",
    "If the world is round, shouldn't we be able to see the back of our heads with a good enough telescope?",
    "Dogs must think we go to work to hunt because we always bring back food.",

    // Deep thoughts
    "What if deja vu is from a past life?",
    "What if dreams are glimpses into alternate realities?",
    "Every exit is an entrance somewhere else.",
    "If money doesn't grow on trees, why do banks have branches?",
    "The word 'silent' contains the word 'listen'.",
    "How do you know if a word is misspelled in the dictionary?",
    "Sponges grow in the ocean... think how much deeper the ocean would be if they didn't.",
    "What if the light at the end of the tunnel is just the light to another womb?",
    "We're all just stories in the end. Better make it a good one.",
    "The universe is under no obligation to make sense to you.",
    "Maybe we're all just NPCs in someone else's game.",
    "Every person you meet knows something you don't.",
    "The cells in your body are constantly dying and being replaced. Are you still you?",
    "What if colors look different to everyone but we all call them the same name?",
    "You've never been in an empty room.",
    "If you hate haters, does that make you a hater?",
    "The only time 'incorrectly' isn't spelled incorrectly is when it's spelled incorrectly.",
    "What if this is actually the bad place?",
    "We're all just walking each other home.",
    "Maybe the aliens are avoiding us because they've seen our internet.",

    // Funny observations
    "Why isn't 'palindrome' spelled the same way backwards?",
    "If you're invisible and close your eyes, can you see through your eyelids?",
    "Do fish ever get thirsty?",
    "If you're in a competition by yourself, do you come in first or last?",
    "Why is 'phonetically' not spelled the way it sounds?",
    "If a vegetarian eats vegetables, what does a humanitarian eat?",
    "Can you cry underwater?",
    "If man evolved from monkeys, why do we still have monkeys?",
    "Why do they call it 'beauty sleep' when you wake up looking like a troll?",
    "If you're bald, what hair color do they put on your driver's license?",
    "Why is it called 'after dark' when it's really 'after light'?",
    "Do penguins have knees?",
    "If ghosts can walk through walls, why don't they fall through floors?",
    "Why do we press harder on the remote when the batteries are dying?",
    "If a word in the dictionary were misspelled, how would we know?",

    // Time and existence
    "You are the youngest you'll ever be right now.",
    "Nothing is created or destroyed, just rearranged. You're made of recycled stars.",
    "Every single person alive today will eventually be a memory.",
    "If you fold a paper in half 42 times, it would reach the moon.",
    "You can't actually remember what it felt like to be 5 years old.",
    "The atoms in your body are 13.7 billion years old.",
    "You're older now than you've ever been, and younger than you'll ever be again.",
    "There was a time when your parents put you down as a child and never picked you up again.",
    "A different version of you exists in the minds of everyone who knows you.",
    "History is just agreed upon fiction.",

    // Space and universe
    "There are more trees on Earth than stars in the Milky Way.",
    "The sun is 400 times larger than the moon but also 400 times farther away.",
    "If the sun exploded right now, we wouldn't know for 8 minutes.",
    "You are made of the same stuff as the stars.",
    "Every atom in your body is billions of years old.",
    "Space is completely silent. No one can hear you scream.",
    "A day on Venus is longer than a year on Venus.",
    "There are more possible iterations of a deck of cards than atoms on Earth.",
    "We are all on a giant rock flying through space at 67,000 mph.",
    "The universe is so big that there might be an exact copy of you somewhere out there.",

    // Language
    "Why do we park in driveways and drive on parkways?",
    "The word 'set' has the most definitions of any English word.",
    "Almost everything we say is a cover version. The first person to say it was the original.",
    "The word 'lol' looks like a drowning person.",
    "If you rip a hole in a net, there are actually fewer holes in it than before.",
    "The word 'bed' looks like a bed.",
    "The alphabet song, Twinkle Twinkle Little Star, and Baa Baa Black Sheep all have the same tune.",
    "You've never been in an empty room because you're in it.",
    "Saying 'I'm sorry' and 'I apologize' mean the same thing. Except at a funeral.",
    "Why is it called a 'near miss'? Shouldn't it be a 'near hit'?",

    // Food for thought
    "Your skeleton is always wet.",
    "Technically, every mirror is already used.",
    "Elevators are just mobile rooms.",
    "Hotels are just house subscriptions.",
    "Vending machines are just robot shopkeepers.",
    "Bicycles are just motorcycles with worse engines.",
    "Gloves are just socks for your hands.",
    "Socks are just foot prisons.",
    "A pillow is just a portable headrest.",
    "A shower is just rain that you control.",

    // Mind melters
    "If you're in a helicopter that's not moving and you hover for 12 hours, would you end up in a different place?",
    "Do crabs think fish can fly?",
    "What was the first guy to milk a cow even trying to do?",
    "If you clean the vacuum cleaner, you become a vacuum cleaner.",
    "Does a straw have one hole or two?",
    "Is cereal soup?",
    "Why do round pizzas come in square boxes?",
    "If corn oil comes from corn, where does baby oil come from?",
    "Why is it called a hot water heater if the water is already hot?",
    "If practice makes perfect but nobody's perfect, why practice?",

    // Random wisdom
    "You can't see your reflection in boiling water. You can't see the truth in a state of anger.",
    "The best time to plant a tree was 20 years ago. The second best time is now.",
    "We don't see things as they are. We see things as we are.",
    "The mind is like a parachute. It doesn't work unless it's open.",
    "Life is what happens when you're busy making other plans.",
    "The only thing we have to fear is fear itself... and spiders.",
    "Change is the only constant in life.",
    "You miss 100% of the shots you don't take.",
    "The early bird gets the worm, but the second mouse gets the cheese.",
    "A journey of a thousand miles begins with a single step.",

    // More cannabis-friendly
    "What if we're all just someone else's imaginary friend?",
    "Recipes are just spoilers for food.",
    "Someone had to be the first person to eat a crab. That's brave.",
    "How did humans decide what animals to eat and what to pet?",
    "The first person to hear a parrot talk must have freaked out.",
    "Coffee is just bean soup.",
    "Alcohol is just socially acceptable self-poisoning.",
    "Sleeping is just time travel to breakfast.",
    "Going to bed early is just procrastinating morning.",
    "WiFi connects us to everything but disconnects us from each other.",

    "Maybe oxygen is slowly killing us and it just takes 75-100 years.",
    "If you replace all the parts of a ship, is it still the same ship?",
    "You've already lived the good old days.",
    "The voice in your head has been reading this the whole time.",
    "You've eaten things that grew in actual dinosaur poop.",
    "Your future self is watching you through memories.",
    "Somewhere, someone is using your ideal username.",
    "You're the main character in your life but an NPC in everyone else's.",
    "Dogs don't know they're dogs.",
    "The letter 'e' appears in almost every sentence.",

    "What if life is just a loading screen?",
    "What happens when an unstoppable force meets an immovable object?",
    "If a tree falls in a forest and no one is around, does it make a sound?",
    "Are eyebrows considered facial hair?",
    "If you enjoy wasting time, is it really wasted?",
    "What if we could record our dreams and watch them later?",
    "The word 'nothing' is just 'something' with less letters.",
    "What if the universe is just an atom in something much bigger?",
    "Time is the only thing you can spend and never get back.",
    "You're living in someone else's nostalgia.",

    "When you close both eyes, you see black. When you close one eye, you see nothing.",
    "We can never run out of sand because we keep breaking big rocks into smaller ones.",
    "Sleeping is just death being shy.",
    "Birthdays are just annual maintenance reminders.",
    "Your eyeballs are the same size now as when you were born.",
    "Every odd number has the letter 'e' in it.",
    "You've spent your whole life training for the Olympics you'll never compete in.",
    "If the camera adds 10 pounds, do skinny people even exist?",
    "Your future self is probably watching this memory right now.",
    "Reading this has literally changed your brain forever.",

    "We're all just walking, talking skeletons in meat armor.",
    "Teeth are the only bones you clean.",
    "Why do they sterilize the needle for lethal injections?",
    "If a zombie attacks a zombie, does it create life?",
    "The last slice of bread is just the first slice flipped over.",
    "Why is cargo transported by ship and shipment by car?",
    "If you work at a calendar factory, do you get days off?",
    "Mountains are just the earth's way of showing off.",
    "Snowmen are just frozen water sculptures.",
    "Technically, you're always touching air.",

    "What if all your memories are just dreams you forgot to wake up from?",
    "Maybe we're all just thoughts in someone else's head.",
    "The past is just a present that's no longer here.",
    "Every sentence you've ever read was just the same 26 letters rearranged.",
    "You've never been the same person twice.",
    "What if the universe is just a snow globe?",
    "Time is just nature's way of keeping everything from happening at once.",
    "Maybe aliens have visited us and we just forgot.",
    "What if every time we die, we start over but don't remember?",
    "The best things in life aren't things.",

    "Why are apartments called apartments when they're all stuck together?",
    "If you're waiting for your food at a restaurant, you're a waiter.",
    "The first fart joke is over 4,000 years old.",
    "Clapping is just smacking yourself for someone else's achievement.",
    "Running a marathon is more about mental strength than physical.",
    "The average person walks past 36 murderers in their lifetime.",
    "Your brain is the only organ that named itself.",
    "You're the result of billions of years of evolution. No pressure.",
    "When you say 'forward' or 'back,' your lips move in those directions.",
    "Yawning is just your brain saying it needs more oxygen.",

    "What if your pillow could record your dreams?",
    "Every 'yo mama' joke has been made about a real mother.",
    "The word 'bed' is shaped like a bed.",
    "You've unknowingly set a world record for something.",
    "Every piece of paper you've ever touched was once a tree.",
    "Your tongue never sits comfortably in your mouth. Now you notice it.",
    "We never stop breathing, we just take really long breaks sometimes.",
    "If you dig straight down, you'll eventually go up.",
    "Paper cuts are trees getting their revenge.",
    "Your pet has a whole backstory you'll never know about.",

    // More trippy ones
    "What if the universe is just one big simulation?",
    "Maybe we're all just someone else's imagination.",
    "Every person is a main character in their own story.",
    "You're not stuck in traffic; you are traffic.",
    "Time flies, but remember: you're the pilot.",
    "Life is like a video game with no save points.",
    "Maybe deja vu is just a glitch in the matrix.",
    "We're all just cosmic dust that became conscious.",
    "The meaning of life is to give life meaning.",
    "We're all just walking, talking chemical reactions.",

    // Existential
    "Maybe we're all living in someone else's dream.",
    "What if the big bang was just the beginning of a cycle?",
    "Everything you see is in the past because light takes time to travel.",
    "You're reading this on a device that has more computing power than NASA used to go to the moon.",
    "The internet is just humans sharing thoughts through cables.",
    "Every photo of you is from when you were younger.",
    "You're the oldest you've ever been right now.",
    "We're all just carbon atoms arranged in a specific way.",
    "The universe is under no obligation to make sense.",
    "Maybe consciousness is just the universe's way of observing itself.",

    // Bonus batch to reach 500
    "If you had a superpower, you'd just be an X-Man in a world of humans.",
    "The word 'short' is shorter than the word 'long'.",
    "Your reflection looks right at you but it's always backwards.",
    "If you think about it, humans are Earth's way of exploring space.",
    "Every song you've ever heard was just vibrating air.",
    "The moon has earthquakes. They're called moonquakes.",
    "Technically, we're all astronauts traveling through space.",
    "Your brain is 73% water. You're thinking with liquid.",
    "Light travels faster than sound. That's why some people seem bright until they speak.",
    "Reality is just a crutch for people who can't handle drugs.",

    "What if our whole life is just the beginning of something bigger?",
    "Maybe consciousness continues after death but we just forget.",
    "Every person you pass has a life as vivid and complex as yours.",
    "The longest word in English without a vowel is 'rhythm'.",
    "Your future memories are being created right now.",
    "What if plants are actually the dominant species and we're just their caretakers?",
    "Every choice creates a new timeline where you made the other choice.",
    "You can't stand in the same river twice.",
    "The more you know, the more you realize you don't know.",
    "Maybe the universe is just information processing itself.",

    "Time is just a way to keep everything from happening at once.",
    "What if every star in the sky has its own planets with its own life?",
    "Your shadow is a confirmation that light has traveled nearly 93 million miles unobstructed.",
    "The word 'queue' sounds the same even if you remove the last four letters.",
    "History remembers kings and generals, but regular people built everything.",
    "Every person who ever lived thought they were living in modern times.",
    "The internet has more information than all libraries combined.",
    "Music is just organized air vibrations.",
    "What if gravity is just time pushing us toward the future?",
    "Your body replaces itself every 7-10 years. You're not the same person you were.",

    "Dogs have dreams. What do you think they dream about?",
    "Fish probably don't know they're wet.",
    "A cloud can weigh more than a million pounds.",
    "The first person to domesticate a wolf was incredibly brave or crazy.",
    "Somewhere right now, there's a dog being told it's a good boy.",
    "The keyboard isn't in alphabetical order and nobody questions it.",
    "Technically, we're all time travelers moving forward at one second per second.",
    "Your favorite song is just sounds arranged in a specific order.",
    "What if humans are the universe's way of experiencing itself?",
    "Maybe the real treasure was the friends we made along the way.",

    "Why do we say 'slept like a baby' when babies wake up every few hours?",
    "If life gives you lemons, that means life has access to lemons.",
    "The word 'OK' looks like a sideways stick figure.",
    "A different version of you exists in the minds of everyone you've met.",
    "Technically, you're a brain piloting a bone mech with meat armor.",
    "The average human blinks about 15-20 times per minute.",
    "You've never seen your own eyeballs directly, only reflections.",
    "What if colors are just our brain's interpretation of light waves?",
    "Every book ever written is just a remix of the alphabet.",
    "Maybe we're all just thoughts in someone else's meditation."
];

// Function to generate trivia from strains
async function generateStrainTrivia() {
    const [strains] = await pool.execute(`
        SELECT name, strain_type, thc_min, thc_max, effects, description, parent_1, parent_2
        FROM tokes_strains
        WHERE (description IS NOT NULL AND description != '')
           OR (parent_1 IS NOT NULL AND parent_2 IS NOT NULL)
           OR (effects IS NOT NULL AND effects != '[]')
        LIMIT 1000
    `);

    const questions = [];
    const usedQuestions = new Set();

    // Get all strain names for wrong answers
    const [allStrains] = await pool.execute('SELECT DISTINCT name FROM tokes_strains ORDER BY RAND() LIMIT 500');
    const strainNames = allStrains.map(s => s.name);

    const strainTypes = ['sativa', 'indica', 'hybrid'];
    const effects = ['euphoric', 'relaxed', 'happy', 'creative', 'uplifted', 'focused', 'energetic', 'sleepy', 'hungry', 'giggly', 'talkative', 'tingly'];

    for (const strain of strains) {
        // Skip if we have enough questions
        if (questions.length >= 500) break;

        // Question type 1: What type is this strain?
        if (strain.strain_type && strain.strain_type !== 'unknown' && !usedQuestions.has(`type-${strain.name}`)) {
            const wrongTypes = strainTypes.filter(t => t !== strain.strain_type);
            questions.push({
                category: 'strains',
                question: `What type of strain is ${strain.name}?`,
                correct_answer: strain.strain_type.charAt(0).toUpperCase() + strain.strain_type.slice(1),
                wrong_answer_1: wrongTypes[0].charAt(0).toUpperCase() + wrongTypes[0].slice(1),
                wrong_answer_2: wrongTypes[1].charAt(0).toUpperCase() + wrongTypes[1].slice(1),
                wrong_answer_3: 'Ruderalis',
                difficulty: 'easy'
            });
            usedQuestions.add(`type-${strain.name}`);
        }

        // Question type 2: THC content
        if (strain.thc_min && strain.thc_max && !usedQuestions.has(`thc-${strain.name}`)) {
            const thcRange = `${strain.thc_min}-${strain.thc_max}%`;
            const correctAvg = (parseFloat(strain.thc_min) + parseFloat(strain.thc_max)) / 2;

            // Generate plausible wrong answers
            const wrongRanges = [
                `${Math.max(1, correctAvg - 10).toFixed(0)}-${Math.max(5, correctAvg - 5).toFixed(0)}%`,
                `${(correctAvg + 5).toFixed(0)}-${(correctAvg + 10).toFixed(0)}%`,
                `${Math.max(1, correctAvg - 15).toFixed(0)}-${Math.max(3, correctAvg - 12).toFixed(0)}%`
            ];

            questions.push({
                category: 'strains',
                question: `What is the typical THC range for ${strain.name}?`,
                correct_answer: thcRange,
                wrong_answer_1: wrongRanges[0],
                wrong_answer_2: wrongRanges[1],
                wrong_answer_3: wrongRanges[2],
                difficulty: 'medium'
            });
            usedQuestions.add(`thc-${strain.name}`);
        }

        // Question type 3: Lineage/parents
        if (strain.parent_1 && strain.parent_2 && !usedQuestions.has(`lineage-${strain.name}`)) {
            const wrongParents = strainNames.filter(n => n !== strain.parent_1 && n !== strain.parent_2 && n !== strain.name);
            if (wrongParents.length >= 3) {
                questions.push({
                    category: 'strains',
                    question: `${strain.name} is a cross between ${strain.parent_1} and which other strain?`,
                    correct_answer: strain.parent_2,
                    wrong_answer_1: wrongParents[Math.floor(Math.random() * wrongParents.length)],
                    wrong_answer_2: wrongParents[Math.floor(Math.random() * wrongParents.length)],
                    wrong_answer_3: wrongParents[Math.floor(Math.random() * wrongParents.length)],
                    difficulty: 'hard'
                });
                usedQuestions.add(`lineage-${strain.name}`);
            }
        }

        // Question type 4: Effects
        if (strain.effects && !usedQuestions.has(`effect-${strain.name}`)) {
            try {
                const strainEffects = JSON.parse(strain.effects);
                if (strainEffects.length > 0) {
                    const mainEffect = strainEffects[0];
                    const wrongEffects = effects.filter(e => !strainEffects.includes(e));

                    if (wrongEffects.length >= 3) {
                        questions.push({
                            category: 'effects',
                            question: `Which is a primary effect of ${strain.name}?`,
                            correct_answer: mainEffect.charAt(0).toUpperCase() + mainEffect.slice(1),
                            wrong_answer_1: wrongEffects[0].charAt(0).toUpperCase() + wrongEffects[0].slice(1),
                            wrong_answer_2: wrongEffects[1].charAt(0).toUpperCase() + wrongEffects[1].slice(1),
                            wrong_answer_3: wrongEffects[2].charAt(0).toUpperCase() + wrongEffects[2].slice(1),
                            difficulty: 'medium'
                        });
                        usedQuestions.add(`effect-${strain.name}`);
                    }
                }
            } catch (e) {}
        }
    }

    // Add general cannabis trivia
    const generalTrivia = [
        {
            category: 'history',
            question: 'In what year was cannabis first criminalized in the United States at the federal level?',
            correct_answer: '1937',
            wrong_answer_1: '1920',
            wrong_answer_2: '1952',
            wrong_answer_3: '1971',
            difficulty: 'medium'
        },
        {
            category: 'science',
            question: 'What is the main psychoactive compound in cannabis?',
            correct_answer: 'THC (Tetrahydrocannabinol)',
            wrong_answer_1: 'CBD (Cannabidiol)',
            wrong_answer_2: 'CBN (Cannabinol)',
            wrong_answer_3: 'Terpinolene',
            difficulty: 'easy'
        },
        {
            category: 'science',
            question: 'What are terpenes?',
            correct_answer: 'Aromatic compounds that give cannabis its smell',
            wrong_answer_1: 'A type of cannabinoid',
            wrong_answer_2: 'Synthetic additives',
            wrong_answer_3: 'A pesticide',
            difficulty: 'easy'
        },
        {
            category: 'science',
            question: 'Which terpene is known for its pine-like aroma?',
            correct_answer: 'Pinene',
            wrong_answer_1: 'Limonene',
            wrong_answer_2: 'Myrcene',
            wrong_answer_3: 'Linalool',
            difficulty: 'medium'
        },
        {
            category: 'science',
            question: 'Which terpene smells like citrus?',
            correct_answer: 'Limonene',
            wrong_answer_1: 'Pinene',
            wrong_answer_2: 'Myrcene',
            wrong_answer_3: 'Caryophyllene',
            difficulty: 'easy'
        },
        {
            category: 'science',
            question: 'What is the most common terpene found in cannabis?',
            correct_answer: 'Myrcene',
            wrong_answer_1: 'Limonene',
            wrong_answer_2: 'Pinene',
            wrong_answer_3: 'Linalool',
            difficulty: 'medium'
        },
        {
            category: 'history',
            question: 'Which country was the first to legalize recreational cannabis nationwide?',
            correct_answer: 'Uruguay',
            wrong_answer_1: 'Netherlands',
            wrong_answer_2: 'Canada',
            wrong_answer_3: 'Jamaica',
            difficulty: 'medium'
        },
        {
            category: 'history',
            question: 'In what year did Colorado legalize recreational cannabis?',
            correct_answer: '2012',
            wrong_answer_1: '2014',
            wrong_answer_2: '2010',
            wrong_answer_3: '2016',
            difficulty: 'medium'
        },
        {
            category: 'culture',
            question: 'What date is celebrated as "Weed Day"?',
            correct_answer: 'April 20th (4/20)',
            wrong_answer_1: 'April 10th (4/10)',
            wrong_answer_2: 'March 20th (3/20)',
            wrong_answer_3: 'May 20th (5/20)',
            difficulty: 'easy'
        },
        {
            category: 'science',
            question: 'What is the name of the system in the human body that interacts with cannabinoids?',
            correct_answer: 'Endocannabinoid System',
            wrong_answer_1: 'Nervous System',
            wrong_answer_2: 'Cannabinoid Receptor System',
            wrong_answer_3: 'Immune System',
            difficulty: 'medium'
        },
        {
            category: 'science',
            question: 'What temperature (°F) does THC begin to vaporize?',
            correct_answer: '315°F',
            wrong_answer_1: '250°F',
            wrong_answer_2: '400°F',
            wrong_answer_3: '450°F',
            difficulty: 'hard'
        },
        {
            category: 'science',
            question: 'What is decarboxylation?',
            correct_answer: 'The process of activating THC through heat',
            wrong_answer_1: 'Removing carbon from cannabis',
            wrong_answer_2: 'A drying technique',
            wrong_answer_3: 'A type of extraction',
            difficulty: 'medium'
        },
        {
            category: 'culture',
            question: 'What does "indica" typically refer to in terms of effects?',
            correct_answer: 'Relaxing, body-focused effects',
            wrong_answer_1: 'Energizing, cerebral effects',
            wrong_answer_2: 'No psychoactive effects',
            wrong_answer_3: 'Hallucinogenic effects',
            difficulty: 'easy'
        },
        {
            category: 'culture',
            question: 'What does "sativa" typically refer to in terms of effects?',
            correct_answer: 'Energizing, cerebral effects',
            wrong_answer_1: 'Relaxing, sedating effects',
            wrong_answer_2: 'No psychoactive effects',
            wrong_answer_3: 'Paranoid effects',
            difficulty: 'easy'
        },
        {
            category: 'science',
            question: 'What is CBD primarily known for?',
            correct_answer: 'Non-psychoactive therapeutic benefits',
            wrong_answer_1: 'Getting you high',
            wrong_answer_2: 'Increasing appetite',
            wrong_answer_3: 'Causing paranoia',
            difficulty: 'easy'
        },
        {
            category: 'history',
            question: 'The term "marijuana" was popularized in the US during which era?',
            correct_answer: '1930s (Prohibition era)',
            wrong_answer_1: '1960s (Hippie era)',
            wrong_answer_2: '1970s (Nixon era)',
            wrong_answer_3: '1950s (Post-war era)',
            difficulty: 'hard'
        },
        {
            category: 'science',
            question: 'What part of the cannabis plant contains the most THC?',
            correct_answer: 'Trichomes on flowers',
            wrong_answer_1: 'Leaves',
            wrong_answer_2: 'Stems',
            wrong_answer_3: 'Roots',
            difficulty: 'easy'
        },
        {
            category: 'culture',
            question: 'What is a "dab"?',
            correct_answer: 'A concentrated cannabis extract',
            wrong_answer_1: 'A type of joint',
            wrong_answer_2: 'A cannabis seed',
            wrong_answer_3: 'A rolling technique',
            difficulty: 'easy'
        },
        {
            category: 'science',
            question: 'What is "kief"?',
            correct_answer: 'Collected trichome crystals',
            wrong_answer_1: 'Cannabis leaves',
            wrong_answer_2: 'A type of hash',
            wrong_answer_3: 'Cannabis seeds',
            difficulty: 'easy'
        },
        {
            category: 'science',
            question: 'How many known cannabinoids are there in the cannabis plant?',
            correct_answer: 'Over 100',
            wrong_answer_1: 'Just 2 (THC and CBD)',
            wrong_answer_2: 'About 20',
            wrong_answer_3: 'Exactly 50',
            difficulty: 'medium'
        },
        {
            category: 'history',
            question: 'Which ancient civilization has the earliest recorded use of cannabis?',
            correct_answer: 'China (around 2700 BCE)',
            wrong_answer_1: 'Egypt (around 1500 BCE)',
            wrong_answer_2: 'India (around 1000 BCE)',
            wrong_answer_3: 'Greece (around 500 BCE)',
            difficulty: 'hard'
        },
        {
            category: 'science',
            question: 'What is the "entourage effect"?',
            correct_answer: 'Cannabinoids and terpenes working together synergistically',
            wrong_answer_1: 'The social aspect of smoking together',
            wrong_answer_2: 'A type of high from edibles',
            wrong_answer_3: 'Tolerance building over time',
            difficulty: 'medium'
        },
        {
            category: 'culture',
            question: 'What is a "spliff"?',
            correct_answer: 'A joint mixed with tobacco',
            wrong_answer_1: 'A pure cannabis joint',
            wrong_answer_2: 'A type of bong',
            wrong_answer_3: 'Cannabis-infused drink',
            difficulty: 'easy'
        },
        {
            category: 'science',
            question: 'What does CBN (Cannabinol) typically come from?',
            correct_answer: 'Aged/oxidized THC',
            wrong_answer_1: 'Fresh cannabis plants',
            wrong_answer_2: 'Cannabis seeds',
            wrong_answer_3: 'Synthetic production',
            difficulty: 'hard'
        },
        {
            category: 'culture',
            question: 'What is "rosin"?',
            correct_answer: 'Solventless concentrate made with heat and pressure',
            wrong_answer_1: 'A type of cannabis strain',
            wrong_answer_2: 'Cannabis-infused resin art',
            wrong_answer_3: 'A cleaning product for pipes',
            difficulty: 'medium'
        }
    ];

    questions.push(...generalTrivia);

    return questions.slice(0, 520);
}

async function main() {
    console.log('Starting data seed...\n');

    try {
        // Insert stoner thoughts
        console.log(`Inserting ${stonerThoughts.length} stoner thoughts...`);
        let thoughtsInserted = 0;

        for (const thought of stonerThoughts) {
            try {
                await pool.execute(
                    'INSERT INTO tokes_thoughts (thought, submitted_by, is_approved) VALUES (?, ?, ?)',
                    [thought, 'CertiFriedUtility', 1]
                );
                thoughtsInserted++;
            } catch (e) {
                if (e.code !== 'ER_DUP_ENTRY') {
                    console.error(`Error inserting thought: ${e.message}`);
                }
            }
        }
        console.log(`✓ Inserted ${thoughtsInserted} thoughts\n`);

        // Generate and insert trivia
        console.log('Generating trivia questions from strains...');
        const triviaQuestions = await generateStrainTrivia();
        console.log(`Generated ${triviaQuestions.length} trivia questions`);

        let triviaInserted = 0;
        for (const q of triviaQuestions) {
            try {
                await pool.execute(
                    `INSERT INTO tokes_trivia_questions
                     (category, question, correct_answer, wrong_answer_1, wrong_answer_2, wrong_answer_3, difficulty, is_active)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
                    [q.category, q.question, q.correct_answer, q.wrong_answer_1, q.wrong_answer_2, q.wrong_answer_3, q.difficulty]
                );
                triviaInserted++;
            } catch (e) {
                if (e.code !== 'ER_DUP_ENTRY') {
                    console.error(`Error inserting trivia: ${e.message}`);
                }
            }
        }
        console.log(`✓ Inserted ${triviaInserted} trivia questions\n`);

        // Summary
        const [[thoughtCount]] = await pool.execute('SELECT COUNT(*) as cnt FROM tokes_thoughts');
        const [[triviaCount]] = await pool.execute('SELECT COUNT(*) as cnt FROM tokes_trivia_questions');

        console.log('=== Summary ===');
        console.log(`Total thoughts in database: ${thoughtCount.cnt}`);
        console.log(`Total trivia questions in database: ${triviaCount.cnt}`);

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await pool.end();
    }
}

main();
