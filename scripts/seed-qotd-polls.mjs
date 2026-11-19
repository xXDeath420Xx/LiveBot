/*
 * Seed the Poll of the Day cards.
 *
 * These live in `qotd_library` beside the 895 open questions, with
 * `card_type = 'poll'` and an options array, so they share the themes, the
 * variant groups and the 90-day no-repeat window rather than running on a
 * parallel track.
 *
 * Discord's limits shape the writing: the prompt is capped at 300 characters and
 * every answer at 55, so options are short by necessity. They are also written to
 * be *arguable* — a poll where one answer is obviously correct gets one vote and
 * no conversation.
 *
 * Idempotent: re-running updates the text of existing slugs and adds new ones.
 */
import dotenv from 'dotenv'; dotenv.config();
import pool from '../utils/db.js';

const POLLS = [
    // ── gaming ────────────────────────────────────────────────────────────
    ['pol-game-respawn', 'gaming', 'You die on the final boss. What actually happens next?', ['Straight back in, no hesitation', 'One deep breath, then back in', 'Alt-tab and "take a break"', 'Uninstall. Reinstall Thursday']],
    ['pol-game-difficulty', 'gaming', 'Be honest about the difficulty you pick first', ['Easy, I am here for the story', 'Normal, as intended', 'Hard, suffering is the point', 'Whatever the game recommends']],
    ['pol-game-loot', 'gaming', 'A legendary drops and it is not your class. Go.', ['Give it to whoever needs it', 'Roll anyway, it is fair game', 'Hold it in case I reroll', 'Sell it immediately']],
    ['pol-game-squad', 'gaming', 'Best squad size for a good night?', ['Solo, my own chaos', 'Duo, one trusted goblin', 'Trio, the sweet spot', 'Full squad, absolute anarchy']],
    ['pol-game-build', 'gaming', 'In any game with building, you are:', ['A cracked builder', 'Functional boxes only', 'I panic and place one wall', 'I do not build, I run']],
    ['pol-game-tutorial', 'gaming', 'Tutorials: what do you really do?', ['Read every word', 'Skim it', 'Skip and learn by dying', 'Skip, then google it later']],
    ['pol-game-mic', 'gaming', 'Voice chat with randoms?', ['Mic on, let us talk', 'Listen only', 'Text chat or nothing', 'Full silence, pure vibes']],
    ['pol-game-backlog', 'gaming', 'How big is the backlog, truthfully?', ['Under 10, I am tidy', '10 to 50, manageable', '50 to 200, a problem', 'I stopped counting years ago']],
    ['pol-game-revive', 'gaming', 'Teammate goes down in the open. You:', ['Rez them, obviously', 'Clear the threat first', 'Ping and hope', 'Sorry. You are the distraction']],
    ['pol-game-remake', 'gaming', 'Which deserves a remake most?', ['An old platformer', 'A forgotten RPG', 'A childhood racing game', 'Nothing. Leave them alone']],

    // ── food ──────────────────────────────────────────────────────────────
    ['pol-food-pineapple', 'food', 'Settle it. Pineapple on pizza.', ['Yes, and it is delicious', 'No, and I am upset', 'Only with something salty', 'I genuinely do not care']],
    ['pol-food-cereal', 'food', 'Cereal or milk first?', ['Cereal first, like a person', 'Milk first, I am built different', 'Neither, I skip breakfast', 'Depends on the cereal']],
    ['pol-food-snack', 'food', 'Best gaming snack, one answer only', ['Something crunchy and salty', 'Something sweet', 'Just an energy drink', 'Whatever is within reach']],
    ['pol-food-leftovers', 'food', 'Cold leftover pizza for breakfast?', ['Elite. Superior to fresh', 'Fine, but I would reheat it', 'Only if desperate', 'Absolutely not']],
    ['pol-food-order', 'food', 'Takeaway night. What lands?', ['Pizza', 'Something with noodles', 'Burgers and chips', 'Whatever is fastest']],
    ['pol-food-coffee', 'food', 'Your relationship with caffeine is:', ['Multiple a day, no notes', 'One, ritually', 'Only when I am desperate', 'None. I am naturally like this']],
    ['pol-food-toast', 'food', 'Correct toast topping?', ['Butter and nothing else', 'Something sweet', 'Beans or eggs', 'Toast is a vehicle, anything goes']],
    ['pol-food-sauce', 'food', 'Chips without sauce is:', ['A crime', 'Fine, honestly', 'Depends on the chips', 'Better. Sauce is a distraction']],

    // ── hot takes ─────────────────────────────────────────────────────────
    ['pol-hot-socks', 'hot-takes', 'Socks in bed?', ['Yes, always', 'Never, feet must breathe', 'Only if freezing', 'One on, one off. Do not ask']],
    ['pol-hot-tabs', 'hot-takes', 'How many browser tabs right now?', ['Under 5, I am well', '5 to 20', '20 to 100', 'The little numbers stopped showing']],
    ['pol-hot-alarm', 'hot-takes', 'Snooze button: how many times?', ['Zero, up on the first', 'Once, for dignity', 'Two or three', 'I have nine alarms set']],
    ['pol-hot-shower', 'hot-takes', 'Morning shower or night shower?', ['Morning, to wake up', 'Night, to sleep clean', 'Both, I am thorough', 'Whenever it happens']],
    ['pol-hot-subs', 'hot-takes', 'Subtitles on, even in your own language?', ['Always on', 'Only when it is mumbly', 'Never, they distract me', 'Only for accents I miss']],
    ['pol-hot-spoiler', 'hot-takes', 'Is it a spoiler after a year?', ['Yes, forever', 'One year is plenty', 'A week is plenty', 'Spoilers do not bother me']],
    ['pol-hot-tempo', 'hot-takes', 'Walking pace on a busy street:', ['Fast, everyone is in my way', 'Normal human speed', 'Slow, I am looking around', 'Depends who I am with']],

    // ── rankings / this-or-that ───────────────────────────────────────────
    ['pol-rank-season', 'rankings', 'Best season, no negotiation', ['Spring', 'Summer', 'Autumn', 'Winter']],
    ['pol-rank-daytime', 'rankings', 'When are you actually at your best?', ['Early morning', 'Afternoon', 'Evening', 'Some unholy hour past 1am']],
    ['pol-rank-pet', 'rankings', 'Cats, dogs, or?', ['Cats', 'Dogs', 'Both, obviously', 'Something smaller and weirder']],
    ['pol-rank-weather', 'rankings', 'Perfect weather to stay in and game:', ['Heavy rain', 'Snow', 'Grey and windy', 'Blazing sun, curtains shut']],
    ['pol-rank-sweet', 'rankings', 'Sweet, salty, sour or spicy?', ['Sweet', 'Salty', 'Sour', 'Spicy']],
    ['pol-rank-travel', 'rankings', 'Window, aisle, or middle?', ['Window, every time', 'Aisle, I need to escape', 'Middle, I am a martyr', 'I do not travel']],

    // ── absurd ────────────────────────────────────────────────────────────
    ['pol-abs-ducks', 'absurd', 'One horse-sized duck or a hundred duck-sized horses?', ['One horse-sized duck', 'A hundred duck-sized horses', 'Neither, I am leaving', 'Both. I want the chaos']],
    ['pol-abs-power', 'absurd', 'Pick the most useful mildly rubbish superpower', ['Always know what time it is', 'Never lose anything again', 'Always pick the fastest queue', 'Perfect parallel parking']],
    ['pol-abs-invisible', 'absurd', 'Invisible for one hour. Realistically:', ['Harmless mischief', 'Spy on my own friends', 'Sneak into something expensive', 'Nap. Nobody can find me']],
    ['pol-abs-animal', 'absurd', 'You must fight one. Choose.', ['A goose', 'A raccoon', 'A swan', 'Ten angry pigeons']],
    ['pol-abs-name', 'absurd', 'You must rename yourself after a food. Which?', ['Something sweet', 'Something spicy', 'Something beige and comforting', 'Whatever is in the fridge']],
    ['pol-abs-time', 'absurd', 'Time machine, one trip only', ['Back, to see something', 'Forward, to see how it ends', 'Back, to fix one thing', 'I am not getting in that']],

    // ── nostalgia ─────────────────────────────────────────────────────────
    ['pol-nost-console', 'nostalgia', 'The console that actually raised you', ['Something Nintendo', 'Something PlayStation', 'Something Xbox', 'A hand-me-down PC']],
    ['pol-nost-afterschool', 'nostalgia', 'After school, you went straight to:', ['A game', 'The TV', 'Outside, actually outside', 'The family computer']],
    ['pol-nost-music', 'nostalgia', 'How did you first own music?', ['CDs', 'Downloads of dubious origin', 'Radio and a tape', 'I was born into streaming']],
    ['pol-nost-phone', 'nostalgia', 'Your first phone was:', ['An indestructible brick', 'A flip phone', 'A slider with a keyboard', 'Already a smartphone']],
    ['pol-nost-sleepover', 'nostalgia', 'Sleepover activity of choice, back then:', ['Two-player on one screen', 'Films until 3am', 'Talking absolute nonsense', 'Pretending to sleep, then not']],

    // ── screen (film + tv) ────────────────────────────────────────────────
    ['pol-scr-rewatch', 'screen', 'New thing or comfort rewatch tonight?', ['Something new', 'The comfort rewatch', 'New, then give up and rewatch', 'Nothing, I am doom-scrolling']],
    ['pol-scr-binge', 'screen', 'Weekly episodes or the whole season at once?', ['Weekly, let it breathe', 'All at once, immediately', 'Weekly, then binge the rest', 'I wait for it to finish airing']],
    ['pol-scr-cinema', 'screen', 'Cinema or sofa?', ['Cinema, big and loud', 'Sofa, pause whenever', 'Cinema for spectacle only', 'Sofa. Always sofa']],
    ['pol-scr-horror', 'screen', 'Horror films: where do you land?', ['Love them, lights off', 'Only with company', 'Only comedy horror', 'Absolutely not']],
    ['pol-scr-credits', 'screen', 'Do you sit through the credits?', ['Always, every time', 'Only if there is a scene', 'Never, I am gone', 'I read them for the music']],

    // ── music ─────────────────────────────────────────────────────────────
    ['pol-mus-loud', 'music', 'Music while gaming?', ['Game audio only', 'Music over everything', 'Depends on the game', 'A podcast, somehow']],
    ['pol-mus-concert', 'music', 'Front row or back of the room?', ['Barrier, obviously', 'Middle, best sound', 'Back, near the exit', 'I watch it on my phone later']],
    ['pol-mus-guilty', 'music', 'A song you love and will not defend:', ['A pop song', 'Something from 2009', 'A meme song', 'I defend everything I like']],
    ['pol-mus-discover', 'music', 'How do you find new music?', ['Algorithm playlists', 'Friends and this server', 'Whatever a game used', 'I have listened to the same 40 songs since 2016']],

    // ── daily life ────────────────────────────────────────────────────────
    ['pol-life-bed', 'daily-life', 'Bed made this morning?', ['Yes, always', 'Sometimes', 'No, and I will not', 'I am still in it']],
    ['pol-life-dishes', 'daily-life', 'Washing up happens:', ['Immediately after eating', 'Later today, honestly', 'When there is nothing left clean', 'The machine handles it']],
    ['pol-life-plan', 'daily-life', 'Your weekend plans are usually:', ['Planned well in advance', 'Decided that morning', 'Decided when someone messages', 'Plans? I am indoors']],
    ['pol-life-notif', 'daily-life', 'Unread notifications on your phone:', ['Zero. I clear everything', 'Under 20', 'Hundreds', 'A number I refuse to say']],
    ['pol-life-temp', 'daily-life', 'The thermostat argument. You are:', ['Always cold', 'Always too warm', 'Fine, everyone else is wrong', 'I just add or remove a hoodie']],

    // ── animals ───────────────────────────────────────────────────────────
    ['pol-ani-talk', 'animals', 'You can talk to one species. Pick.', ['Dogs', 'Cats', 'Birds', 'Something in the ocean']],
    ['pol-ani-voice', 'animals', 'Do you use a voice when you talk to pets?', ['Yes, a full silly voice', 'A small one, quietly', 'No, I speak normally', 'I do not talk to them at all']],
    ['pol-ani-adopt', 'animals', 'Unlimited space and money. You adopt:', ['A lot of dogs', 'A lot of cats', 'One extremely large animal', 'A farm. All of it']],

    // ── seasonal / cosy ───────────────────────────────────────────────────
    ['pol-seas-cosy', 'seasonal', 'Peak cosy is:', ['Blanket, rain, game', 'Candles and a book', 'Snow outside, warm inside', 'Everyone in voice chat at 2am']],
    ['pol-seas-decor', 'seasonal', 'When do decorations go up?', ['The first of December', 'Mid November, fight me', 'Christmas week', 'They never came down']],
    ['pol-seas-holiday', 'seasonal', 'Best part of any holiday?', ['The food', 'The time off', 'Seeing people', 'The days between, when nothing counts']],

    // ── places ────────────────────────────────────────────────────────────
    ['pol-plc-live', 'places', 'Where would you actually want to live?', ['A big city', 'A small town', 'Somewhere rural and quiet', 'By the sea']],
    ['pol-plc-trip', 'places', 'Dream trip, all expenses paid:', ['Somewhere hot', 'Somewhere cold and dramatic', 'A city with good food', 'Somewhere with nobody in it']],
    ['pol-plc-pack', 'places', 'Packing style?', ['Packed a week early', 'Night before, calmly', 'Two hours before, chaos', 'I forget something every time']],

    // ── internet ──────────────────────────────────────────────────────────
    ['pol-net-reply', 'internet', 'Someone is wrong online. You:', ['Reply, with sources', 'Reply with one word', 'Screenshot it for a friend', 'Scroll on, I am at peace']],
    ['pol-net-read', 'internet', 'Do you read the article before commenting?', ['Always', 'The first paragraph', 'The headline is enough', 'I do not comment']],
    ['pol-net-handle', 'internet', 'Your username came from:', ['Something I loved as a kid', 'Random words that sounded cool', 'A game character', 'It has been mine forever, no idea']],
    ['pol-net-emoji', 'internet', 'Most used emoji, be honest:', ['Something crying-laughing', 'A heart', 'The skull', 'I use words like an adult']],

    // ── people ────────────────────────────────────────────────────────────
    ['pol-ppl-call', 'people', 'Someone rings you with no warning:', ['Answer immediately', 'Let it ring, then text back', 'Panic, then answer', 'Decline. Text me like a normal person']],
    ['pol-ppl-plans', 'people', 'Plans get cancelled last minute. You feel:', ['Genuinely disappointed', 'Secretly relieved', 'Openly relieved', 'Depends entirely on the day']],
    ['pol-ppl-gift', 'people', 'You are better at:', ['Giving gifts', 'Receiving gifts', 'Neither, both are stressful', 'Both. I am a delight']],
    ['pol-ppl-group', 'people', 'In a group project you are:', ['The one doing everything', 'A solid contributor', 'The ideas person', 'Quietly hoping nobody notices me']],

    // ── craft / making ────────────────────────────────────────────────────
    ['pol-crf-start', 'craft', 'Unfinished projects in your house:', ['None, I finish things', 'One or two', 'Several, in a drawer', 'I am not discussing this']],
    ['pol-crf-instructions', 'craft', 'Flat-pack furniture. Instructions?', ['Read fully, then build', 'Glance, then build', 'Build first, read when it wobbles', 'Someone else does this']],
    ['pol-crf-learn', 'craft', 'You get one new skill instantly:', ['An instrument', 'Drawing or painting', 'Another language', 'Something practical and boring']],

    // ── curiosity ─────────────────────────────────────────────────────────
    ['pol-cur-know', 'curiosity', 'You can know one thing for certain:', ['How long you live', 'Whether we are alone out there', 'What people really think of you', 'None of it. Do not tell me']],
    ['pol-cur-rabbit', 'curiosity', 'Last 2am rabbit hole was about:', ['Something historical', 'Something space or ocean', 'A person I will never meet', 'Something deeply, deeply stupid']],
    ['pol-cur-mystery', 'curiosity', 'Which mystery would you most want solved?', ['Something in deep ocean', 'Something in deep space', 'An unsolved crime', 'Where my missing socks go']],

    // ── work / school ─────────────────────────────────────────────────────
    ['pol-wrk-focus', 'work', 'You focus best with:', ['Total silence', 'Music, no lyrics', 'Music, loud, lyrics included', 'Background noise or a video']],
    ['pol-wrk-deadline', 'work', 'Honest relationship with deadlines:', ['Done early, filed neatly', 'Done the day before', 'Done in the final hour', 'Deadline? What deadline']],
    ['pol-wrk-meeting', 'work', 'Camera on in a video call?', ['On, always', 'Off unless asked', 'Off. Permanently off', 'Depends who is in it']],

    // ── sports / outside ──────────────────────────────────────────────────
    ['pol-spt-watch', 'sports', 'Sport: where do you sit?', ['I play something', 'I watch, I do not play', 'Only the big events', 'None of it, ever']],
    ['pol-spt-outside', 'sports', 'Ideal amount of outside per day:', ['Hours, I need it', 'A walk, then home', 'To the shop and back', 'Outside is a rumour']],

    // ── creator / streaming ───────────────────────────────────────────────
    ['pol-cre-watch', 'creator', 'You watch streams mostly for:', ['The person', 'The game', 'The chat and the community', 'Background noise while I do things']],
    ['pol-cre-chat', 'creator', 'In a stream chat you are:', ['Chatting constantly', 'A few messages', 'Lurking, but present', 'Silent and happy']],
    ['pol-cre-time', 'creator', 'Best time for a stream to start?', ['Afternoon', 'Early evening', 'Late night', 'Whenever, I catch the VOD']],
    ['pol-cre-vod', 'creator', 'Missed the stream. Do you watch the VOD?', ['All of it', 'Skip to the good bits', 'Only clips', 'No, I catch the next one']],

    // ── reflective ────────────────────────────────────────────────────────
    ['pol-ref-advice', 'reflective', 'Best advice comes from:', ['People who have done it', 'People who know you well', 'Strangers with no stake', 'I work it out myself']],
    ['pol-ref-change', 'reflective', 'Given a free reset on one thing:', ['A choice I made', 'A thing I said', 'Something I did not do', 'Nothing. It all got me here']],
    ['pol-ref-proud', 'reflective', 'You are most proud of something you:', ['Made', 'Survived', 'Helped someone else with', 'Quit, and never went back to']],

    // ── hypothetical ──────────────────────────────────────────────────────
    ['pol-hyp-lottery', 'hypothetical', 'Huge lottery win. First real move?', ['Pay off everyone I love', 'Buy a house, quietly', 'Tell nobody and act normal', 'Quit immediately and vanish']],
    ['pol-hyp-island', 'hypothetical', 'One item on a deserted island:', ['Something practical', 'Something to keep me sane', 'A way to signal for help', 'A really long book']],
    ['pol-hyp-clone', 'hypothetical', 'Your clone appears. It does:', ['My job', 'My chores', 'My social obligations', 'Nothing. We game together']],

    // ── storytime ─────────────────────────────────────────────────────────
    ['pol-sto-scar', 'storytime', 'Your best scar story is from:', ['Something sporty', 'Something clumsy', 'Something genuinely stupid', 'I have no scars to report']],
    ['pol-sto-lost', 'storytime', 'Worst place you have been properly lost:', ['A foreign city', 'A shop or car park', 'Somewhere outdoors', 'I do not get lost']],
    ['pol-sto-embarrass', 'storytime', 'The memory that wakes you at 3am is from:', ['School', 'A job', 'A message I sent', 'All of them, on rotation']],
];

const MAX_QUESTION = 300;
const MAX_OPTION = 55;

let bad = 0;
for (const [slug, theme, content, options] of POLLS) {
    if (content.length > MAX_QUESTION) { console.log(`TOO LONG (question) ${slug}: ${content.length}`); bad++; }
    if (options.length < 2 || options.length > 10) { console.log(`BAD OPTION COUNT ${slug}: ${options.length}`); bad++; }
    for (const o of options) {
        if (o.length > MAX_OPTION) { console.log(`TOO LONG (option ${o.length}) ${slug}: ${o}`); bad++; }
    }
}
const slugs = POLLS.map((p) => p[0]);
if (new Set(slugs).size !== slugs.length) { console.log('DUPLICATE SLUGS'); bad++; }
if (bad) { console.error(`\n${bad} problem(s) — nothing written`); process.exit(1); }

let added = 0, updated = 0;
for (const [slug, theme, content, options] of POLLS) {
    const [rows] = await pool.execute('SELECT library_id FROM qotd_library WHERE slug = ?', [slug]);
    if (rows.length) {
        await pool.execute(
            'UPDATE qotd_library SET content = ?, options = ?, theme = ?, card_type = ?, active = 1 WHERE slug = ?',
            [content, JSON.stringify(options), theme, 'poll', slug]);
        updated++;
    } else {
        await pool.execute(
            `INSERT INTO qotd_library (slug, content, options, theme, variant_group, card_type, weight, active)
             VALUES (?, ?, ?, ?, ?, 'poll', 100, 1)`,
            [slug, content, JSON.stringify(options), theme, slug]);
        added++;
    }
}
const [[{ n }]] = await pool.execute("SELECT COUNT(*) n FROM qotd_library WHERE card_type = 'poll' AND active = 1");
console.log(`polls: ${added} added, ${updated} updated — ${n} active poll cards across ` +
    `${new Set(POLLS.map((p) => p[1])).size} themes`);
process.exit(0);
