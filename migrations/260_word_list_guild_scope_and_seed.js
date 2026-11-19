/*
 * Migration 260: word_list — per-server custom words + a real global word set.
 *
 * WHY
 * ---
 * `/arcade hangman start` picks its word from `word_list` (core/hangman-manager.js), but the table
 * has always been empty, so every game ended at "No words found for the selected difficulty and
 * category". The dashboard's word manager also needs to add words for ONE server only.
 *
 * WHAT
 * ----
 *  - guild_id   VARCHAR(20) NULL — NULL = global word (everyone), otherwise that server's custom word.
 *  - added_by   VARCHAR(20) NULL — Discord user id of whoever added it from the dashboard.
 *  - created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP.
 *  - idx_guild (guild_id) for the `guild_id IS NULL OR guild_id = ?` reader.
 *  - A curated global seed: 20 words for every category x difficulty the command offers
 *    (7 categories x 3 difficulties = 420 words), each with the short definition the game reveals
 *    at the end. Lengths follow the command's own labels: easy 4-5 letters, medium 6-8,
 *    hard 9+ (all <= 14, inside the guess option's 20-char limit). Letters a-z only.
 *
 * Idempotent: columns/index are added only when missing (information_schema); the seed skips any
 * (word, category) that already exists as a global word, so re-running inserts nothing new.
 * `random` is not a stored category — the reader drops the category filter for it.
 */

const SEED = {
    food: {
        easy: [
            ['apple', 'A round fruit with red, green or yellow skin'],
            ['bread', 'A baked food made from flour, water and yeast'],
            ['pizza', 'Flat baked dough topped with tomato sauce and cheese'],
            ['pasta', 'Italian dough food such as spaghetti or penne'],
            ['lemon', 'A sour yellow citrus fruit'],
            ['mango', 'A sweet tropical fruit with orange flesh'],
            ['honey', 'A sweet sticky food made by bees'],
            ['bacon', 'Salted, smoked meat from a pig, often fried in strips'],
            ['toast', 'Bread browned by heat'],
            ['salad', 'A dish of mixed raw vegetables or leaves'],
            ['grape', 'A small round fruit that grows in bunches on vines'],
            ['onion', 'A layered bulb vegetable with a strong taste'],
            ['peach', 'A soft, fuzzy-skinned fruit with a stone in the middle'],
            ['steak', 'A thick slice of meat, usually beef'],
            ['rice', 'Small grains that are boiled or steamed and eaten worldwide'],
            ['soup', 'A liquid food made by boiling meat or vegetables'],
            ['cake', 'A sweet baked dessert, often with frosting'],
            ['pear', 'A sweet fruit that is narrow at the top and wide at the bottom'],
            ['corn', 'A yellow grain that grows on cobs'],
            ['taco', 'A folded tortilla filled with meat, beans or vegetables'],
        ],
        medium: [
            ['banana', 'A long curved fruit with yellow skin'],
            ['cheese', 'A food made from pressed milk curds'],
            ['carrot', 'An orange root vegetable'],
            ['tomato', 'A red, juicy fruit used like a vegetable'],
            ['noodle', 'A long thin strip of dough, boiled before eating'],
            ['waffle', 'A crisp batter cake with a grid pattern'],
            ['muffin', 'A small, cup-shaped sweet bread'],
            ['custard', 'A sweet sauce or dessert made from milk and eggs'],
            ['cookie', 'A small, flat, sweet baked treat'],
            ['burrito', 'A tortilla wrapped around a filling of meat, rice or beans'],
            ['pancake', 'A thin, flat cake cooked in a pan'],
            ['popcorn', 'Corn kernels heated until they burst open'],
            ['sausage', 'Seasoned ground meat stuffed into a casing'],
            ['avocado', 'A green fruit with creamy flesh and a large pit'],
            ['lasagna', 'Baked layers of wide pasta, sauce and cheese'],
            ['broccoli', 'A green vegetable with a thick stalk and tree-like head'],
            ['pretzel', 'A knot-shaped bread, often salted'],
            ['meatball', 'A ball of ground meat, cooked and often served with pasta'],
            ['omelette', 'Beaten eggs cooked flat and folded over a filling'],
            ['dumpling', 'A small piece of dough wrapped around a filling'],
        ],
        hard: [
            ['pineapple', 'A tropical fruit with spiky skin and sweet yellow flesh'],
            ['blueberry', 'A small, round, dark blue berry'],
            ['cranberry', 'A sour red berry, often made into sauce or juice'],
            ['raspberry', 'A soft red berry made of tiny clustered segments'],
            ['spaghetti', 'Long, thin, round pasta'],
            ['guacamole', 'A dip made from mashed avocado'],
            ['cheesecake', 'A rich dessert made with soft cheese on a crust'],
            ['cauliflower', 'A vegetable with a dense white head'],
            ['watermelon', 'A large fruit with green rind and juicy red flesh'],
            ['pomegranate', 'A red fruit packed with juicy seeds'],
            ['asparagus', 'A vegetable with tender green spears'],
            ['artichoke', 'A thistle-like vegetable with edible leaves and heart'],
            ['croissant', 'A buttery, flaky, crescent-shaped pastry'],
            ['quesadilla', 'A tortilla folded over melted cheese and grilled'],
            ['strawberry', 'A sweet red fruit with seeds on its surface'],
            ['gingerbread', 'A spiced cake or cookie flavored with ginger'],
            ['marshmallow', 'A soft, spongy candy made from sugar and gelatin'],
            ['tangerine', 'A small, easy-to-peel orange citrus fruit'],
            ['butterscotch', 'A sweet made from brown sugar and butter'],
            ['mozzarella', 'A soft, mild white cheese used on pizza'],
        ],
    },
    nature: {
        easy: [
            ['river', 'A large natural stream of flowing water'],
            ['ocean', 'A vast body of salt water covering most of Earth'],
            ['cloud', 'A visible mass of water droplets floating in the sky'],
            ['storm', 'Violent weather with wind, rain, thunder or snow'],
            ['stone', 'A small piece of rock'],
            ['grass', 'Low green plants covering lawns and fields'],
            ['beach', 'A sandy or pebbly shore beside the sea'],
            ['cliff', 'A steep rock face, often at the edge of the sea'],
            ['coral', 'A hard sea structure built by tiny marine animals'],
            ['frost', 'A thin layer of ice crystals on cold surfaces'],
            ['creek', 'A small stream'],
            ['swamp', 'Wet, spongy land often covered with water'],
            ['moss', 'A small, soft green plant that grows in damp places'],
            ['leaf', 'A flat green part of a plant that grows from a stem'],
            ['lake', 'A large body of water surrounded by land'],
            ['rain', 'Water falling in drops from clouds'],
            ['wind', 'Moving air'],
            ['snow', 'Frozen water vapor falling as white flakes'],
            ['hill', 'A naturally raised area of land, smaller than a mountain'],
            ['fern', 'A green, feathery plant that reproduces by spores'],
        ],
        medium: [
            ['forest', 'A large area covered with trees'],
            ['meadow', 'A field of grass and wildflowers'],
            ['canyon', 'A deep valley with steep sides, often cut by a river'],
            ['desert', 'A dry region with very little rain'],
            ['island', 'Land completely surrounded by water'],
            ['valley', 'Low land between hills or mountains'],
            ['glacier', 'A slowly moving river of ice'],
            ['volcano', 'A mountain that can erupt lava, ash and gas'],
            ['thunder', 'The loud rumble that follows lightning'],
            ['rainbow', 'An arc of colors in the sky caused by sunlight through rain'],
            ['blossom', 'A flower, especially on a fruit tree'],
            ['sunrise', 'The moment the sun appears in the morning'],
            ['tundra', 'A cold, treeless plain with frozen subsoil'],
            ['lagoon', 'A shallow body of water separated from the sea'],
            ['prairie', 'A large, open area of grassland'],
            ['wildfire', 'A large, uncontrolled fire in a forest or grassland'],
            ['mountain', 'A very high, steep landform'],
            ['boulder', 'A very large rock'],
            ['pebble', 'A small, smooth, rounded stone'],
            ['seaweed', 'Plants and algae that grow in the sea'],
        ],
        hard: [
            ['waterfall', 'Water falling over the edge of a cliff or steep rock'],
            ['hurricane', 'A powerful tropical storm with very strong winds'],
            ['avalanche', 'A large mass of snow sliding down a mountain'],
            ['landscape', 'All the visible features of an area of land'],
            ['rainforest', 'A dense forest with very high rainfall'],
            ['earthquake', 'A sudden shaking of the ground'],
            ['wilderness', 'A wild area left untouched by people'],
            ['lightning', 'A bright flash of electricity in the sky during a storm'],
            ['sunflower', 'A tall plant with a large yellow flower head'],
            ['evergreen', 'A plant that keeps its leaves all year round'],
            ['peninsula', 'Land surrounded by water on three sides'],
            ['stalactite', 'A spike of minerals hanging from a cave ceiling'],
            ['photosynthesis', 'How plants turn sunlight, water and carbon dioxide into food'],
            ['thunderstorm', 'A storm with thunder, lightning and heavy rain'],
            ['archipelago', 'A group of islands'],
            ['wildflower', 'A flower that grows naturally without being planted'],
            ['atmosphere', 'The layer of gases surrounding the Earth'],
            ['riverbank', 'The land along the edge of a river'],
            ['hailstone', 'A pellet of ice that falls from a storm cloud'],
            ['snowflake', 'A single ice crystal that falls as snow'],
        ],
    },
    music: {
        easy: [
            ['drum', 'A percussion instrument played by hitting it'],
            ['song', 'A short piece of music with words that is sung'],
            ['beat', 'The steady pulse of a piece of music'],
            ['note', 'A single musical sound or the symbol for it'],
            ['harp', 'A large stringed instrument played by plucking'],
            ['tune', 'A melody'],
            ['band', 'A group of musicians who play together'],
            ['solo', 'A piece or passage performed by one musician'],
            ['flute', 'A woodwind instrument played by blowing across a hole'],
            ['piano', 'A keyboard instrument with hammers that strike strings'],
            ['cello', 'A large stringed instrument played upright with a bow'],
            ['banjo', 'A stringed instrument with a round drum-like body'],
            ['choir', 'An organized group of singers'],
            ['opera', 'A drama set to music and sung on stage'],
            ['tempo', 'The speed at which music is played'],
            ['chord', 'Three or more notes played together'],
            ['lyric', 'The words of a song'],
            ['blues', 'A soulful music style that began in the American South'],
            ['disco', 'Upbeat dance music popular in the 1970s'],
            ['viola', 'A stringed instrument slightly larger than a violin'],
        ],
        medium: [
            ['guitar', 'A stringed instrument played by strumming or plucking'],
            ['violin', 'A small four-stringed instrument played with a bow'],
            ['melody', 'A sequence of notes that forms a tune'],
            ['rhythm', 'The pattern of beats and timing in music'],
            ['trumpet', 'A brass instrument with three valves'],
            ['concert', 'A live performance of music for an audience'],
            ['harmony', 'Different notes sounding pleasantly together'],
            ['ukulele', 'A small four-stringed guitar from Hawaii'],
            ['clarinet', 'A woodwind instrument with a single reed'],
            ['trombone', 'A brass instrument with a sliding tube'],
            ['symphony', 'A long piece of music for a full orchestra'],
            ['keyboard', 'An electronic instrument with piano-style keys'],
            ['playlist', 'A list of songs chosen to be played'],
            ['karaoke', 'Singing along to recorded backing music'],
            ['anthem', 'A rousing song for a nation, team or group'],
            ['ballad', 'A slow song that tells a story'],
            ['chorus', 'The repeated part of a song'],
            ['encore', 'An extra song performed when the audience asks for more'],
            ['sonata', 'A classical piece for one or two instruments'],
            ['maestro', 'A distinguished conductor or musician'],
        ],
        hard: [
            ['orchestra', 'A large group of musicians playing classical instruments'],
            ['saxophone', 'A brass-bodied woodwind instrument popular in jazz'],
            ['xylophone', 'A percussion instrument of wooden bars struck with mallets'],
            ['harmonica', 'A small mouth instrument played by blowing and drawing air'],
            ['accordion', 'A bellows instrument with keys or buttons'],
            ['tambourine', 'A small hand drum with jingling metal discs'],
            ['conductor', 'The person who leads an orchestra or choir'],
            ['metronome', 'A device that ticks to keep a steady tempo'],
            ['microphone', 'A device that turns sound into an electrical signal'],
            ['headphones', 'A pair of small speakers worn over the ears'],
            ['percussion', 'Instruments played by striking, shaking or scraping'],
            ['soundtrack', 'The recorded music accompanying a film or game'],
            ['composition', 'A piece of music that has been written'],
            ['synthesizer', 'An electronic instrument that creates sounds'],
            ['instrumental', 'A piece of music without singing'],
            ['harpsichord', 'A keyboard instrument whose strings are plucked'],
            ['glockenspiel', 'A percussion instrument of tuned metal bars'],
            ['crescendo', 'A gradual increase in loudness'],
            ['amplifier', 'A device that makes an audio signal louder'],
            ['songwriter', 'A person who writes songs'],
        ],
    },
    sports: {
        easy: [
            ['golf', 'A sport of hitting a small ball into holes with clubs'],
            ['polo', 'A team sport played on horseback with mallets'],
            ['dart', 'A small pointed missile thrown at a board'],
            ['goal', 'Scoring by getting the ball into the net'],
            ['puck', 'The hard rubber disc used in ice hockey'],
            ['team', 'A group of players on the same side'],
            ['race', 'A contest of speed'],
            ['swim', 'To move through water using arms and legs'],
            ['judo', 'A Japanese martial art based on throws and holds'],
            ['dunk', 'Slamming a basketball down through the hoop'],
            ['rugby', 'A team sport played with an oval ball and hard tackles'],
            ['track', 'A course for running races'],
            ['skate', 'To glide on ice skates or roller skates'],
            ['relay', 'A race where team members run legs in turn'],
            ['coach', 'A person who trains athletes or a team'],
            ['medal', 'A metal disc awarded for winning or placing'],
            ['field', 'An area of grass where games are played'],
            ['match', 'A contest between two players or teams'],
            ['serve', 'Putting the ball into play in tennis or volleyball'],
            ['pitch', 'Throwing the ball to the batter in baseball'],
        ],
        medium: [
            ['soccer', 'A team sport where players kick a ball into a goal'],
            ['tennis', 'A racket sport played over a net'],
            ['hockey', 'A team sport played with sticks and a ball or puck'],
            ['boxing', 'A combat sport fought with padded gloves'],
            ['karate', 'A Japanese martial art using strikes and kicks'],
            ['squash', 'A racket sport played against the walls of a court'],
            ['rowing', 'Racing boats propelled by oars'],
            ['skiing', 'Sliding over snow on long narrow boards'],
            ['cricket', 'A bat-and-ball sport played by two teams of eleven'],
            ['archery', 'The sport of shooting arrows with a bow'],
            ['cycling', 'Riding or racing bicycles'],
            ['fencing', 'The sport of fighting with swords'],
            ['bowling', 'Rolling a heavy ball to knock down pins'],
            ['surfing', 'Riding ocean waves on a board'],
            ['stadium', 'A large venue where sports events are held'],
            ['referee', 'The official who enforces the rules of a game'],
            ['baseball', 'A bat-and-ball sport with four bases'],
            ['football', 'A team sport played with a ball, kicked or carried'],
            ['marathon', 'A long-distance running race of about 42 km'],
            ['lacrosse', 'A team sport using sticks with small nets'],
        ],
        hard: [
            ['basketball', 'A team sport of shooting a ball through a raised hoop'],
            ['volleyball', 'A team sport of hitting a ball over a high net'],
            ['badminton', 'A racket sport played with a shuttlecock'],
            ['wrestling', 'A combat sport of grappling and pinning an opponent'],
            ['gymnastics', 'A sport of flips, balance and strength routines'],
            ['snowboarding', 'Sliding down snowy slopes on a single board'],
            ['skateboarding', 'Riding and doing tricks on a board with wheels'],
            ['weightlifting', 'The sport of lifting heavy barbells'],
            ['quarterback', 'The football player who leads the offense'],
            ['touchdown', 'Carrying or catching the ball in the end zone'],
            ['triathlon', 'A race combining swimming, cycling and running'],
            ['decathlon', 'An athletics contest made up of ten events'],
            ['championship', 'A contest to decide the overall winner'],
            ['tournament', 'A series of games played to find a winner'],
            ['goalkeeper', 'The player who guards the goal'],
            ['racquetball', 'A fast racket sport played in an enclosed court'],
            ['equestrian', 'Relating to horse riding'],
            ['pentathlon', 'An athletic contest made up of five events'],
            ['sportsmanship', 'Fair and respectful behavior in sport'],
            ['scoreboard', 'A large board showing the score'],
        ],
    },
    animals: {
        easy: [
            ['bear', 'A large, heavy mammal with thick fur'],
            ['wolf', 'A wild member of the dog family that hunts in packs'],
            ['lion', 'A large wild cat known as the king of the jungle'],
            ['frog', 'A jumping amphibian with long back legs'],
            ['deer', 'A grazing animal; males often have antlers'],
            ['duck', 'A water bird with a flat bill and webbed feet'],
            ['goat', 'A hardy farm animal with horns and a beard'],
            ['seal', 'A sea mammal with flippers that lives on coasts'],
            ['crab', 'A shellfish with ten legs that walks sideways'],
            ['moth', 'A night-flying insect related to the butterfly'],
            ['tiger', 'A large wild cat with orange fur and black stripes'],
            ['zebra', 'An African horse with black and white stripes'],
            ['horse', 'A large hoofed animal used for riding'],
            ['mouse', 'A small rodent with a long thin tail'],
            ['sheep', 'A farm animal raised for its wool'],
            ['whale', 'The largest sea mammal'],
            ['shark', 'A large predatory fish with rows of sharp teeth'],
            ['eagle', 'A large bird of prey with sharp eyesight'],
            ['otter', 'A playful swimming mammal with thick fur'],
            ['koala', 'An Australian marsupial that eats eucalyptus leaves'],
        ],
        medium: [
            ['rabbit', 'A small mammal with long ears that hops'],
            ['monkey', 'A primate with a long tail that lives in trees'],
            ['turtle', 'A reptile with a hard shell'],
            ['parrot', 'A colorful bird that can mimic speech'],
            ['donkey', 'A domestic animal like a small horse with long ears'],
            ['jaguar', 'A large spotted wild cat of the Americas'],
            ['lizard', 'A reptile with four legs and a long tail'],
            ['beaver', 'A rodent that builds dams across streams'],
            ['walrus', 'A large Arctic sea mammal with long tusks'],
            ['giraffe', 'The tallest animal, with a very long neck'],
            ['dolphin', 'A smart sea mammal known for its playful behavior'],
            ['penguin', 'A flightless black and white bird that swims'],
            ['cheetah', 'The fastest land animal'],
            ['gorilla', 'The largest of the great apes'],
            ['hamster', 'A small rodent often kept as a pet'],
            ['raccoon', 'A nocturnal mammal with a black face mask'],
            ['elephant', 'The largest land animal, with a trunk and tusks'],
            ['kangaroo', 'An Australian marsupial that hops on strong back legs'],
            ['flamingo', 'A pink wading bird that often stands on one leg'],
            ['hedgehog', 'A small mammal covered in spines'],
        ],
        hard: [
            ['alligator', 'A large reptile with a broad snout, found in the Americas'],
            ['crocodile', 'A large reptile with a long, narrow snout'],
            ['butterfly', 'An insect with large colorful wings'],
            ['porcupine', 'A rodent covered in sharp quills'],
            ['armadillo', 'A mammal protected by a bony armored shell'],
            ['chameleon', 'A lizard that can change the color of its skin'],
            ['chimpanzee', 'A great ape that is closely related to humans'],
            ['salamander', 'A lizard-like amphibian with moist skin'],
            ['rhinoceros', 'A large, thick-skinned animal with horns on its nose'],
            ['hippopotamus', 'A huge African animal that spends its days in rivers'],
            ['orangutan', 'A red-haired great ape from Borneo and Sumatra'],
            ['wolverine', 'A fierce, stocky animal of the weasel family'],
            ['jellyfish', 'A soft sea creature with stinging tentacles'],
            ['dragonfly', 'An insect with a long body and two pairs of clear wings'],
            ['tarantula', 'A large, hairy spider'],
            ['woodpecker', 'A bird that drills into tree bark with its beak'],
            ['hummingbird', 'A tiny bird that can hover by beating its wings fast'],
            ['grasshopper', 'A jumping insect with long back legs'],
            ['caterpillar', 'The larva of a butterfly or moth'],
            ['kingfisher', 'A brightly colored bird that dives for fish'],
        ],
    },
    technology: {
        easy: [
            ['code', 'Instructions written for a computer'],
            ['byte', 'A unit of digital data, usually eight bits'],
            ['chip', 'A tiny electronic circuit on a piece of silicon'],
            ['disk', 'A device for storing computer data'],
            ['node', 'A single connection point in a network'],
            ['file', 'A named collection of data stored on a computer'],
            ['link', 'A clickable connection to another page or file'],
            ['data', 'Information stored or processed by a computer'],
            ['pixel', 'The smallest dot of color on a screen'],
            ['email', 'A message sent electronically over a network'],
            ['robot', 'A machine that can carry out tasks automatically'],
            ['modem', 'A device that connects a computer to the internet'],
            ['cable', 'An insulated wire that carries power or signals'],
            ['drone', 'An aircraft flown without a pilot on board'],
            ['laser', 'A device that produces a narrow, intense beam of light'],
            ['virus', 'Harmful software that copies itself to other files'],
            ['login', 'The act of signing in to an account'],
            ['cache', 'Fast storage that keeps recently used data'],
            ['debug', 'To find and fix errors in code'],
            ['radio', 'Sending sound through the air with electromagnetic waves'],
        ],
        medium: [
            ['laptop', 'A portable computer'],
            ['server', 'A computer that provides data or services to others'],
            ['router', 'A device that directs traffic between networks'],
            ['tablet', 'A flat, portable touchscreen computer'],
            ['backup', 'A spare copy of data kept in case of loss'],
            ['upload', 'To send a file from your device to the internet'],
            ['widget', 'A small app or control on a screen'],
            ['screen', 'The display surface of a computer, phone or TV'],
            ['browser', 'An app used to view websites'],
            ['monitor', 'A screen that displays a computer output'],
            ['printer', 'A machine that puts text or images on paper'],
            ['network', 'A group of connected computers'],
            ['website', 'A set of related pages on the internet'],
            ['gadget', 'A small, clever device'],
            ['battery', 'A device that stores electrical energy'],
            ['internet', 'The worldwide network of connected computers'],
            ['database', 'An organized collection of stored data'],
            ['software', 'Programs that run on a computer'],
            ['password', 'A secret word used to sign in'],
            ['firewall', 'A security system that blocks unwanted network traffic'],
        ],
        hard: [
            ['algorithm', 'A step-by-step set of rules for solving a problem'],
            ['processor', 'The chip that carries out a computer\'s instructions'],
            ['interface', 'The point where a user or system interacts with another'],
            ['smartphone', 'A mobile phone that works like a small computer'],
            ['programmer', 'A person who writes computer code'],
            ['encryption', 'Scrambling data so only authorized people can read it'],
            ['developer', 'A person who builds software'],
            ['motherboard', 'The main circuit board inside a computer'],
            ['application', 'A program designed for a specific task'],
            ['satellite', 'A device that orbits Earth to relay signals'],
            ['technology', 'Scientific knowledge put to practical use'],
            ['transistor', 'A tiny electronic switch inside chips'],
            ['touchscreen', 'A display you control by touching it'],
            ['microchip', 'A tiny integrated circuit'],
            ['spreadsheet', 'A grid of rows and columns for calculations'],
            ['cybersecurity', 'Protecting computers and networks from attack'],
            ['semiconductor', 'A material used to make computer chips'],
            ['bandwidth', 'How much data a connection can carry at once'],
            ['broadband', 'A high-speed internet connection'],
            ['screenshot', 'An image capture of what is on a screen'],
        ],
    },
    general: {
        easy: [
            ['house', 'A building where people live'],
            ['chair', 'A seat with a back, for one person'],
            ['table', 'A piece of furniture with a flat top and legs'],
            ['clock', 'A device that shows the time'],
            ['smile', 'A happy expression made with the mouth'],
            ['dream', 'Images and stories in your mind while you sleep'],
            ['light', 'What makes things visible, such as from the sun or a lamp'],
            ['money', 'Coins and notes used to buy things'],
            ['paper', 'Thin material used for writing and printing'],
            ['plant', 'A living thing that grows in soil, like a flower or tree'],
            ['book', 'Pages of writing bound together'],
            ['door', 'A movable panel used to enter or leave a room'],
            ['lamp', 'A device that gives off light'],
            ['ring', 'A circular band worn on a finger'],
            ['star', 'A ball of burning gas that shines in the night sky'],
            ['gift', 'Something given to someone without payment'],
            ['city', 'A large town where many people live and work'],
            ['road', 'A wide path for vehicles to travel on'],
            ['bell', 'A hollow metal object that rings when struck'],
            ['coin', 'A flat round piece of metal used as money'],
        ],
        medium: [
            ['window', 'An opening in a wall fitted with glass'],
            ['garden', 'A piece of ground where flowers or vegetables are grown'],
            ['castle', 'A large fortified building from the Middle Ages'],
            ['bridge', 'A structure built to cross over a river or road'],
            ['pencil', 'A writing tool with a graphite core'],
            ['mirror', 'A reflective glass surface'],
            ['wallet', 'A small folding case for money and cards'],
            ['ladder', 'A set of rungs used for climbing'],
            ['candle', 'A stick of wax with a wick that is burned for light'],
            ['basket', 'A container woven from strips of material'],
            ['blanket', 'A large warm cover for a bed'],
            ['library', 'A place where books are kept for people to borrow'],
            ['compass', 'An instrument that shows which way is north'],
            ['journey', 'A trip from one place to another'],
            ['kitchen', 'The room where food is cooked'],
            ['lantern', 'A portable light in a protective case'],
            ['treasure', 'A collection of valuable things like gold and jewels'],
            ['umbrella', 'A folding canopy that keeps off the rain'],
            ['birthday', 'The yearly anniversary of the day someone was born'],
            ['calendar', 'A chart showing the days, weeks and months of a year'],
        ],
        hard: [
            ['adventure', 'An exciting or unusual experience'],
            ['furniture', 'Movable items such as chairs, tables and beds'],
            ['happiness', 'The feeling of being happy'],
            ['invention', 'Something newly created or designed'],
            ['knowledge', 'Facts and skills learned through experience or study'],
            ['lighthouse', 'A tower with a bright light that guides ships'],
            ['friendship', 'A close bond between friends'],
            ['playground', 'An outdoor area where children play'],
            ['restaurant', 'A place where meals are cooked and served'],
            ['helicopter', 'An aircraft lifted by spinning overhead blades'],
            ['newspaper', 'A printed publication of news, usually daily'],
            ['dictionary', 'A book listing words and their meanings'],
            ['photograph', 'A picture taken with a camera'],
            ['imagination', 'The ability to form new ideas and pictures in your mind'],
            ['neighborhood', 'The area around where someone lives'],
            ['skyscraper', 'A very tall building'],
            ['telescope', 'An instrument that makes distant objects look closer'],
            ['passenger', 'A person traveling in a vehicle who is not driving'],
            ['staircase', 'A set of stairs inside a building'],
            ['fireplace', 'A space in a wall where a fire is built'],
        ],
    },
};

const LENGTH_RULES = { easy: [4, 5], medium: [6, 8], hard: [9, 20] };

/** Flattened, validated seed rows: [word, difficulty, category, definition]. */
export function seedRows() {
    const rows = [];
    for (const [category, byDifficulty] of Object.entries(SEED)) {
        for (const [difficulty, words] of Object.entries(byDifficulty)) {
            const [min, max] = LENGTH_RULES[difficulty];
            for (const [word, definition] of words) {
                if (!/^[a-z]+$/.test(word) || word.length < min || word.length > max) {
                    throw new Error(`[260] bad seed word "${word}" for ${category}/${difficulty}`);
                }
                rows.push([word, difficulty, category, definition]);
            }
        }
    }
    return rows;
}

async function hasColumn(db, table, column) {
    const [rows] = await db.execute(
        `SELECT 1 FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [table, column]);
    return rows.length > 0;
}

async function hasIndex(db, table, index) {
    const [rows] = await db.execute(
        `SELECT 1 FROM information_schema.STATISTICS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
        [table, index]);
    return rows.length > 0;
}

export async function up(db) {
    if (!(await hasColumn(db, 'word_list', 'guild_id'))) {
        await db.execute('ALTER TABLE word_list ADD COLUMN guild_id VARCHAR(20) NULL DEFAULT NULL');
    }
    if (!(await hasColumn(db, 'word_list', 'added_by'))) {
        await db.execute('ALTER TABLE word_list ADD COLUMN added_by VARCHAR(20) NULL DEFAULT NULL');
    }
    if (!(await hasColumn(db, 'word_list', 'created_at'))) {
        await db.execute('ALTER TABLE word_list ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
    }
    if (!(await hasIndex(db, 'word_list', 'idx_guild'))) {
        await db.execute('ALTER TABLE word_list ADD INDEX idx_guild (guild_id)');
    }

    // Seed global words that are not already present. word_list has no unique key (and a NULL
    // guild_id would defeat one anyway), so dedupe against what is there before inserting.
    const [existing] = await db.execute('SELECT word, category FROM word_list WHERE guild_id IS NULL');
    const have = new Set(existing.map(r => `${String(r.word).toLowerCase()}|${r.category}`));
    const missing = seedRows().filter(([word, , category]) => !have.has(`${word}|${category}`));

    const CHUNK = 100;
    for (let i = 0; i < missing.length; i += CHUNK) {
        const chunk = missing.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '(?, ?, ?, ?, 1, NULL, NULL)').join(', ');
        await db.execute(
            `INSERT IGNORE INTO word_list (word, difficulty, category, definition, is_active, guild_id, added_by)
             VALUES ${placeholders}`,
            chunk.flat());
    }
}

export async function down(db) {
    // Remove only the global words this migration seeded, then the columns it added.
    if (await hasColumn(db, 'word_list', 'guild_id')) {
        for (const [word, difficulty, category] of seedRows()) {
            await db.execute(
                'DELETE FROM word_list WHERE guild_id IS NULL AND word = ? AND difficulty = ? AND category = ?',
                [word, difficulty, category]);
        }
    }
    if (await hasIndex(db, 'word_list', 'idx_guild')) {
        await db.execute('ALTER TABLE word_list DROP INDEX idx_guild');
    }
    for (const column of ['created_at', 'added_by', 'guild_id']) {
        if (await hasColumn(db, 'word_list', column)) {
            await db.execute(`ALTER TABLE word_list DROP COLUMN ${column}`);
        }
    }
}
