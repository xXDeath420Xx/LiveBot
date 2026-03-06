import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import axios from 'axios';
import pool from '../../utils/db.js';

// Import existing entertainment handlers (games group)
import entertainmentCommand from './entertainment-handlers.js';

// Import new handler files
import * as animalsHandler from './fun-animals-handler.js';
import * as astrologyHandler from './fun-astrology-handler.js';
import * as confessHandler from './fun-confess-handler.js';
import * as creativeHandler from './fun-creative-handler.js';
import * as partygamesHandler from './fun-partygames-handler.js';
import * as quotesHandler from './fun-quotes-handler.js';
import * as randomHandler from './fun-random-handler.js';
import * as icebreakersHandler from './fun-icebreakers-handler.js';

export default {
  category: 'fun',
  data: new SlashCommandBuilder()
    .setName('fun')
    .setDescription('Fun commands for entertainment')

    // ── Existing: games group (card games from entertainment) ──
    .addSubcommandGroup(group =>
      group.setName('games').setDescription('Fun card games to play')
        .addSubcommand(sub => sub.setName('battle').setDescription('Start a text-based battle royale game')
          .addIntegerOption(opt => opt.setName('players').setDescription('Number of AI players (including you)').setRequired(false).setMinValue(5).setMaxValue(20)))
        .addSubcommand(sub => sub.setName('cardpull').setDescription('Pull a random collectible card')
          .addStringOption(opt => opt.setName('rarity').setDescription('Try for a specific rarity (costs more energy)').setRequired(false)
            .addChoices({ name: 'Any (1 energy)', value: 'any' }, { name: 'Rare+ (3 energy)', value: 'rare' }, { name: 'Epic+ (5 energy)', value: 'epic' }, { name: 'Legendary (10 energy)', value: 'legendary' })))
        .addSubcommand(sub => sub.setName('collection').setDescription('View your card collection and stats'))
        .addSubcommand(sub => sub.setName('trade').setDescription('Trade a card with another player')
          .addUserOption(opt => opt.setName('user').setDescription('User to trade with').setRequired(true))
          .addIntegerOption(opt => opt.setName('cardid').setDescription('Your card ID to trade').setRequired(true)))
        .addSubcommand(sub => sub.setName('trivia').setDescription('Quick trivia question')
          .addStringOption(opt => opt.setName('category').setDescription('Trivia category').setRequired(false)
            .addChoices({ name: 'General Knowledge', value: 'general' }, { name: 'Science', value: 'science' }, { name: 'History', value: 'history' }, { name: 'Geography', value: 'geography' }, { name: 'Pop Culture', value: 'popculture' })))
    )

    // ── NEW: animals group (from animals.js) ──
    .addSubcommandGroup(group =>
      group.setName('animals').setDescription('Animal pictures and stats')
        .addSubcommand(sub => sub.setName('search').setDescription('Search for an animal image')
          .addStringOption(opt => opt.setName('name').setDescription('The animal you want to see').setRequired(true))
          .addStringOption(opt => opt.setName('type').setDescription('Image type').setRequired(false).addChoices({ name: '📷 Photo', value: 'photo' }, { name: '🎬 GIF', value: 'gif' }))
          .addBooleanOption(opt => opt.setName('unique').setDescription('Only show images you haven\'t seen before').setRequired(false)))
        .addSubcommand(sub => sub.setName('stats').setDescription('View your animal search history'))
        .addSubcommand(sub => sub.setName('popular').setDescription('View most popular animals in this server'))
    )

    // ── NEW: astrology group (from astrology.js) ──
    .addSubcommandGroup(group =>
      group.setName('astrology').setDescription('Horoscopes, tarot, and mystical features')
        .addSubcommand(sub => sub.setName('horoscope').setDescription('Get your daily, weekly, or monthly horoscope')
          .addStringOption(opt => opt.setName('sign').setDescription('Your zodiac sign').setRequired(true)
            .addChoices({ name: '♈ Aries', value: 'aries' }, { name: '♉ Taurus', value: 'taurus' }, { name: '♊ Gemini', value: 'gemini' }, { name: '♋ Cancer', value: 'cancer' }, { name: '♌ Leo', value: 'leo' }, { name: '♍ Virgo', value: 'virgo' }, { name: '♎ Libra', value: 'libra' }, { name: '♏ Scorpio', value: 'scorpio' }, { name: '♐ Sagittarius', value: 'sagittarius' }, { name: '♑ Capricorn', value: 'capricorn' }, { name: '♒ Aquarius', value: 'aquarius' }, { name: '♓ Pisces', value: 'pisces' }))
          .addStringOption(opt => opt.setName('period').setDescription('Time period').setRequired(false)
            .addChoices({ name: 'Today', value: 'daily' }, { name: 'This Week', value: 'weekly' }, { name: 'This Month', value: 'monthly' })))
        .addSubcommand(sub => sub.setName('tarot').setDescription('Draw tarot cards for guidance')
          .addStringOption(opt => opt.setName('spread').setDescription('Type of reading').setRequired(false)
            .addChoices({ name: 'Single Card', value: 'single' }, { name: 'Three Card - Past, Present, Future', value: 'three' }, { name: 'Love Reading', value: 'love' }, { name: 'Career Reading', value: 'career' })))
        .addSubcommand(sub => sub.setName('numerology').setDescription('Calculate your life path number')
          .addStringOption(opt => opt.setName('birthdate').setDescription('Your birthdate (MM/DD/YYYY)').setRequired(true)))
        .addSubcommand(sub => sub.setName('compatibility').setDescription('Check zodiac compatibility')
          .addStringOption(opt => opt.setName('sign1').setDescription('First zodiac sign').setRequired(true)
            .addChoices({ name: 'Aries', value: 'aries' }, { name: 'Taurus', value: 'taurus' }, { name: 'Gemini', value: 'gemini' }, { name: 'Cancer', value: 'cancer' }, { name: 'Leo', value: 'leo' }, { name: 'Virgo', value: 'virgo' }, { name: 'Libra', value: 'libra' }, { name: 'Scorpio', value: 'scorpio' }, { name: 'Sagittarius', value: 'sagittarius' }, { name: 'Capricorn', value: 'capricorn' }, { name: 'Aquarius', value: 'aquarius' }, { name: 'Pisces', value: 'pisces' }))
          .addStringOption(opt => opt.setName('sign2').setDescription('Second zodiac sign').setRequired(true)
            .addChoices({ name: 'Aries', value: 'aries' }, { name: 'Taurus', value: 'taurus' }, { name: 'Gemini', value: 'gemini' }, { name: 'Cancer', value: 'cancer' }, { name: 'Leo', value: 'leo' }, { name: 'Virgo', value: 'virgo' }, { name: 'Libra', value: 'libra' }, { name: 'Scorpio', value: 'scorpio' }, { name: 'Sagittarius', value: 'sagittarius' }, { name: 'Capricorn', value: 'capricorn' }, { name: 'Aquarius', value: 'aquarius' }, { name: 'Pisces', value: 'pisces' })))
    )

    // ── NEW: creative group (from creative.js) ──
    .addSubcommandGroup(group =>
      group.setName('creative').setDescription('Creative tools for memes, stories, and art')
        .addSubcommand(sub => sub.setName('meme').setDescription('Generate a meme with popular templates')
          .addStringOption(opt => opt.setName('template').setDescription('Meme template').setRequired(true)
            .addChoices({ name: 'Drake', value: 'drake' }, { name: 'Distracted Boyfriend', value: 'boyfriend' }, { name: 'Two Buttons', value: 'buttons' }, { name: 'Expanding Brain', value: 'brain' }, { name: 'Change My Mind', value: 'changemymind' }, { name: 'Is This A Pigeon?', value: 'pigeon' }, { name: 'Woman Yelling at Cat', value: 'woman_cat' }, { name: 'Bernie Sanders', value: 'bernie' }, { name: 'Success Kid', value: 'success' }, { name: 'One Does Not Simply', value: 'mordor' }))
          .addStringOption(opt => opt.setName('text1').setDescription('First text line').setRequired(true))
          .addStringOption(opt => opt.setName('text2').setDescription('Second text line').setRequired(false))
          .addStringOption(opt => opt.setName('text3').setDescription('Third text line').setRequired(false)))
        .addSubcommand(sub => sub.setName('story').setDescription('Generate a creative story from a prompt')
          .addStringOption(opt => opt.setName('prompt').setDescription('Story prompt or theme').setRequired(true))
          .addStringOption(opt => opt.setName('genre').setDescription('Story genre').setRequired(false)
            .addChoices({ name: 'Fantasy', value: 'fantasy' }, { name: 'Sci-Fi', value: 'scifi' }, { name: 'Horror', value: 'horror' }, { name: 'Romance', value: 'romance' }, { name: 'Mystery', value: 'mystery' }, { name: 'Comedy', value: 'comedy' })))
        .addSubcommand(sub => sub.setName('prompt').setDescription('Get creative writing/art prompts')
          .addStringOption(opt => opt.setName('type').setDescription('Type of prompt').setRequired(true)
            .addChoices({ name: 'Writing', value: 'writing' }, { name: 'Art/Drawing', value: 'art' }, { name: 'Photography', value: 'photo' }, { name: 'Music', value: 'music' })))
        .addSubcommand(sub => sub.setName('color').setDescription('Generate color palettes')
          .addStringOption(opt => opt.setName('mood').setDescription('Mood or theme').setRequired(false)
            .addChoices({ name: 'Vibrant', value: 'vibrant' }, { name: 'Pastel', value: 'pastel' }, { name: 'Dark', value: 'dark' }, { name: 'Earth Tones', value: 'earth' }, { name: 'Ocean', value: 'ocean' }, { name: 'Sunset', value: 'sunset' }, { name: 'Random', value: 'random' })))
    )

    // ── NEW: partygames group (from games.js) ──
    .addSubcommandGroup(group =>
      group.setName('partygames').setDescription('Fun text-based party games and puzzles')
        .addSubcommand(sub => sub.setName('wouldyourather').setDescription('Would You Rather game'))
        .addSubcommand(sub => sub.setName('riddleme').setDescription('Solve a riddle')
          .addStringOption(opt => opt.setName('difficulty').setDescription('Riddle difficulty').setRequired(false)
            .addChoices({ name: 'Easy', value: 'easy' }, { name: 'Medium', value: 'medium' }, { name: 'Hard', value: 'hard' })))
        .addSubcommand(sub => sub.setName('truthordare').setDescription('Get a truth or dare question')
          .addStringOption(opt => opt.setName('choice').setDescription('Truth or Dare?').setRequired(true)
            .addChoices({ name: 'Truth', value: 'truth' }, { name: 'Dare', value: 'dare' })))
        .addSubcommand(sub => sub.setName('neverhaveiever').setDescription('Get a "Never Have I Ever" statement'))
        .addSubcommand(sub => sub.setName('trivia').setDescription('Quick trivia question')
          .addStringOption(opt => opt.setName('difficulty').setDescription('Question difficulty').setRequired(false)
            .addChoices({ name: 'Easy', value: 'easy' }, { name: 'Medium', value: 'medium' }, { name: 'Hard', value: 'hard' })))
        .addSubcommand(sub => sub.setName('anagram').setDescription('Solve an anagram puzzle'))
        .addSubcommand(sub => sub.setName('mathchallenge').setDescription('Quick math challenge')
          .addStringOption(opt => opt.setName('difficulty').setDescription('Math difficulty').setRequired(false)
            .addChoices({ name: 'Easy', value: 'easy' }, { name: 'Medium', value: 'medium' }, { name: 'Hard', value: 'hard' })))
    )

    // ── NEW: quotes group (from quote.js) ──
    .addSubcommandGroup(group =>
      group.setName('quotes').setDescription('Save and retrieve memorable quotes')
        .addSubcommand(sub => sub.setName('save').setDescription('Save a message as a quote')
          .addStringOption(opt => opt.setName('message_id').setDescription('The ID of the message to save').setRequired(true))
          .addStringOption(opt => opt.setName('name').setDescription('A name/tag for this quote').setRequired(false)))
        .addSubcommand(sub => sub.setName('get').setDescription('Get a specific quote by ID')
          .addIntegerOption(opt => opt.setName('id').setDescription('The quote ID').setRequired(true)))
        .addSubcommand(sub => sub.setName('random').setDescription('Get a random quote'))
        .addSubcommand(sub => sub.setName('search').setDescription('Search quotes by content or name')
          .addStringOption(opt => opt.setName('query').setDescription('Search term').setRequired(true)))
        .addSubcommand(sub => sub.setName('list').setDescription('List recent quotes')
          .addIntegerOption(opt => opt.setName('limit').setDescription('Number of quotes (default: 10)').setMinValue(1).setMaxValue(25).setRequired(false)))
        .addSubcommand(sub => sub.setName('delete').setDescription('Delete a quote (author or admin only)')
          .addIntegerOption(opt => opt.setName('id').setDescription('The quote ID to delete').setRequired(true)))
    )

    // ── NEW: random group (from random.js) ──
    .addSubcommandGroup(group =>
      group.setName('random').setDescription('Random generators and decision makers')
        .addSubcommand(sub => sub.setName('number').setDescription('Generate random number(s)')
          .addIntegerOption(opt => opt.setName('min').setDescription('Minimum value').setRequired(true))
          .addIntegerOption(opt => opt.setName('max').setDescription('Maximum value').setRequired(true))
          .addIntegerOption(opt => opt.setName('count').setDescription('How many numbers (default: 1)').setRequired(false).setMinValue(1).setMaxValue(20)))
        .addSubcommand(sub => sub.setName('choice').setDescription('Pick a random choice from a list')
          .addStringOption(opt => opt.setName('options').setDescription('Comma-separated list of options').setRequired(true)))
        .addSubcommand(sub => sub.setName('coin').setDescription('Flip a coin')
          .addIntegerOption(opt => opt.setName('count').setDescription('Number of coins (default: 1)').setRequired(false).setMinValue(1).setMaxValue(10)))
        .addSubcommand(sub => sub.setName('dice').setDescription('Roll dice')
          .addStringOption(opt => opt.setName('notation').setDescription('Dice notation (e.g., 2d6, 1d20)').setRequired(false)))
        .addSubcommand(sub => sub.setName('percent').setDescription('Random percentage (0-100%)'))
        .addSubcommand(sub => sub.setName('letter').setDescription('Random letter(s)')
          .addIntegerOption(opt => opt.setName('count').setDescription('Number of letters (default: 1)').setRequired(false).setMinValue(1).setMaxValue(20))
          .addBooleanOption(opt => opt.setName('uppercase').setDescription('Use uppercase (default: true)').setRequired(false)))
        .addSubcommand(sub => sub.setName('fact').setDescription('Random interesting fact')
          .addStringOption(opt => opt.setName('category').setDescription('Fact category').setRequired(false)
            .addChoices({ name: 'Random Number', value: 'number' }, { name: 'Random Date', value: 'date' }, { name: 'Random Year', value: 'year' })))
        .addSubcommand(sub => sub.setName('activity').setDescription('Get a random activity suggestion')
          .addStringOption(opt => opt.setName('type').setDescription('Activity type').setRequired(false)
            .addChoices({ name: 'Any', value: 'any' }, { name: 'Education', value: 'education' }, { name: 'Recreational', value: 'recreational' }, { name: 'Social', value: 'social' }, { name: 'DIY', value: 'diy' }, { name: 'Charity', value: 'charity' }, { name: 'Cooking', value: 'cooking' }, { name: 'Relaxation', value: 'relaxation' })))
        .addSubcommand(sub => sub.setName('yes-no').setDescription('Get a random yes/no answer')
          .addStringOption(opt => opt.setName('question').setDescription('Your yes/no question').setRequired(false)))
    )

    // ── NEW: icebreakers group (from social.js) ──
    .addSubcommandGroup(group =>
      group.setName('icebreakers').setDescription('Social connection and icebreaker features')
        .addSubcommand(sub => sub.setName('icebreaker').setDescription('Get a random icebreaker question')
          .addStringOption(opt => opt.setName('category').setDescription('Question category').setRequired(false)
            .addChoices({ name: 'Fun & Casual', value: 'fun' }, { name: 'Deep & Meaningful', value: 'deep' }, { name: 'Would You Rather', value: 'wyr' }, { name: 'This or That', value: 'tot' }, { name: 'Creative', value: 'creative' })))
        .addSubcommand(sub => sub.setName('profile').setDescription('Create or update your social profile')
          .addStringOption(opt => opt.setName('interests').setDescription('Your interests (comma-separated)').setRequired(true))
          .addStringOption(opt => opt.setName('bio').setDescription('Short bio (max 200 chars)').setRequired(false)))
        .addSubcommand(sub => sub.setName('viewprofile').setDescription('View someone\'s social profile')
          .addUserOption(opt => opt.setName('user').setDescription('User to view').setRequired(false)))
        .addSubcommand(sub => sub.setName('findmatch').setDescription('Find users with similar interests'))
    )

    // ── Existing flat subcommands ──
    .addSubcommand(sub => sub.setName('joke').setDescription('Get a random joke')
      .addStringOption(opt => opt.setName('category').setDescription('Joke category').setRequired(false)
        .addChoices({ name: 'Any', value: 'Any' }, { name: 'Programming', value: 'Programming' }, { name: 'Miscellaneous', value: 'Misc' }, { name: 'Dark', value: 'Dark' }, { name: 'Pun', value: 'Pun' })))
    .addSubcommand(sub => sub.setName('dadjoke').setDescription('Get a random dad joke'))
    .addSubcommand(sub => sub.setName('meme').setDescription('Get a random meme from Reddit')
      .addStringOption(opt => opt.setName('subreddit').setDescription('Subreddit to pull from').setRequired(false)
        .addChoices({ name: 'Random', value: 'random' }, { name: 'Memes', value: 'memes' }, { name: 'Dank Memes', value: 'dankmemes' }, { name: 'Wholesome Memes', value: 'wholesomememes' }, { name: 'Gaming Memes', value: 'gaming' }, { name: 'Anime Memes', value: 'animemes' })))
    .addSubcommand(sub => sub.setName('creatememe').setDescription('Create a custom meme with Imgflip')
      .addStringOption(opt => opt.setName('template').setDescription('Meme template').setRequired(true)
        .addChoices({ name: 'Drake', value: '181913649' }, { name: 'Distracted Boyfriend', value: '112126428' }, { name: 'Two Buttons', value: '87743020' }, { name: 'Expanding Brain', value: '93895088' }, { name: 'Change My Mind', value: '129242436' }, { name: 'Is This A Pigeon', value: '100777631' }, { name: 'Bernie Sanders', value: '222403160' }, { name: 'Success Kid', value: '61544' }))
      .addStringOption(opt => opt.setName('top_text').setDescription('Top text for the meme').setRequired(true))
      .addStringOption(opt => opt.setName('bottom_text').setDescription('Bottom text for the meme').setRequired(true)))
    .addSubcommand(sub => sub.setName('fact').setDescription('Get a random fact')
      .addStringOption(opt => opt.setName('category').setDescription('Fact category').setRequired(false)
        .addChoices({ name: 'Random', value: 'random' }, { name: 'Science', value: 'science' }, { name: 'History', value: 'history' }, { name: 'Animals', value: 'animals' })))
    .addSubcommand(sub => sub.setName('wouldyourather').setDescription('Get a would you rather question'))
    .addSubcommand(sub => sub.setName('8ball').setDescription('Ask the magic 8-ball a question')
      .addStringOption(opt => opt.setName('question').setDescription('Your yes/no question').setRequired(true)))
    // ── NEW flat: confess (from confess.js) ──
    .addSubcommand(sub => sub.setName('confess').setDescription('Submit an anonymous confession')),

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand();

    try {
      // ── Subcommand groups ──
      if (group === 'games') {
        switch (subcommand) {
          case 'battle': return await entertainmentCommand.handleBattle(interaction);
          case 'cardpull': return await entertainmentCommand.handleCardPull(interaction);
          case 'collection': return await entertainmentCommand.handleCollection(interaction);
          case 'trade': return await entertainmentCommand.handleTrade(interaction);
          case 'trivia': return await entertainmentCommand.handleTrivia(interaction);
        }
      }

      if (group === 'animals') {
        switch (subcommand) {
          case 'search': return await animalsHandler.handleSearch(interaction);
          case 'stats': return await animalsHandler.handleStats(interaction);
          case 'popular': return await animalsHandler.handlePopular(interaction);
        }
      }

      if (group === 'astrology') {
        switch (subcommand) {
          case 'horoscope': return await astrologyHandler.handleHoroscope(interaction);
          case 'tarot': return await astrologyHandler.handleTarot(interaction);
          case 'numerology': return await astrologyHandler.handleNumerology(interaction);
          case 'compatibility': return await astrologyHandler.handleCompatibility(interaction);
        }
      }

      if (group === 'creative') {
        switch (subcommand) {
          case 'meme': return await creativeHandler.handleMeme(interaction);
          case 'story': return await creativeHandler.handleStory(interaction);
          case 'prompt': return await creativeHandler.handlePrompt(interaction);
          case 'color': return await creativeHandler.handleColor(interaction);
        }
      }

      if (group === 'partygames') {
        switch (subcommand) {
          case 'wouldyourather': return await partygamesHandler.handleWouldYouRather(interaction);
          case 'riddleme': return await partygamesHandler.handleRiddle(interaction);
          case 'truthordare': return await partygamesHandler.handleTruthOrDare(interaction);
          case 'neverhaveiever': return await partygamesHandler.handleNeverHaveIEver(interaction);
          case 'trivia': return await partygamesHandler.handleTrivia(interaction);
          case 'anagram': return await partygamesHandler.handleAnagram(interaction);
          case 'mathchallenge': return await partygamesHandler.handleMathChallenge(interaction);
        }
      }

      if (group === 'quotes') {
        switch (subcommand) {
          case 'save': return await quotesHandler.handleSave(interaction);
          case 'get': return await quotesHandler.handleGet(interaction);
          case 'random': return await quotesHandler.handleRandom(interaction);
          case 'search': return await quotesHandler.handleSearchQuotes(interaction);
          case 'list': return await quotesHandler.handleListQuotes(interaction);
          case 'delete': return await quotesHandler.handleDelete(interaction);
        }
      }

      if (group === 'random') {
        switch (subcommand) {
          case 'number': return await randomHandler.handleNumber(interaction);
          case 'choice': return await randomHandler.handleChoice(interaction);
          case 'coin': return await randomHandler.handleCoin(interaction);
          case 'dice': return await randomHandler.handleDice(interaction);
          case 'percent': return await randomHandler.handlePercent(interaction);
          case 'letter': return await randomHandler.handleLetter(interaction);
          case 'fact': return await randomHandler.handleFact(interaction);
          case 'activity': return await randomHandler.handleActivity(interaction);
          case 'yes-no': return await randomHandler.handleYesNo(interaction);
        }
      }

      if (group === 'icebreakers') {
        switch (subcommand) {
          case 'icebreaker': return await icebreakersHandler.handleIcebreaker(interaction);
          case 'profile': return await icebreakersHandler.handleProfile(interaction);
          case 'viewprofile': return await icebreakersHandler.handleViewProfile(interaction);
          case 'findmatch': return await icebreakersHandler.handleFindMatch(interaction);
        }
      }

      // ── Flat subcommands (no group) ──

      // Confess — shows a modal, no defer
      if (subcommand === 'confess') {
        return await confessHandler.handleConfess(interaction);
      }

      // Everything below defers
      await interaction.deferReply();

      if (subcommand === 'joke') {
        const category = interaction.options.getString('category') || 'Any';
        const response = await axios.get(`https://v2.jokeapi.dev/joke/${category}`, { timeout: 10000 });
        const joke = response.data;
        const embed = new EmbedBuilder().setColor('#FFD700').setTitle('😂 Random Joke').setFooter({ text: `Category: ${joke.category}` }).setTimestamp();
        if (joke.type === 'single') embed.setDescription(joke.joke);
        else embed.addFields({ name: 'Setup', value: joke.setup }, { name: 'Delivery', value: joke.delivery });
        return interaction.editReply({ embeds: [embed] });

      } else if (subcommand === 'dadjoke') {
        const response = await axios.get('https://icanhazdadjoke.com/', { headers: { 'Accept': 'application/json' }, timeout: 10000 });
        const embed = new EmbedBuilder().setColor('#FF6B6B').setTitle('👨 Dad Joke').setDescription(response.data.joke).setFooter({ text: 'Powered by icanhazdadjoke.com' }).setTimestamp();
        return interaction.editReply({ embeds: [embed] });

      } else if (subcommand === 'meme') {
        const subreddit = interaction.options.getString('subreddit') || 'random';
        let apiUrl = 'https://meme-api.com/gimme';
        if (subreddit && subreddit !== 'random') apiUrl = `https://meme-api.com/gimme/${subreddit}`;
        const response = await axios.get(apiUrl, { timeout: 10000 });
        const meme = response.data;
        if (!meme.url) return interaction.editReply({ content: '❌ No meme found. Please try again.' });
        const embed = new EmbedBuilder().setColor('#FF4500').setTitle(meme.title.length > 256 ? meme.title.substring(0, 253) + '...' : meme.title).setURL(meme.postLink).setImage(meme.url).setFooter({ text: `👍 ${meme.ups} upvotes • r/${meme.subreddit}` }).setTimestamp();
        return interaction.editReply({ embeds: [embed] });

      } else if (subcommand === 'creatememe') {
        const templateId = interaction.options.getString('template');
        const topText = interaction.options.getString('top_text');
        const bottomText = interaction.options.getString('bottom_text');
        const response = await axios.post('https://api.imgflip.com/caption_image', new URLSearchParams({ template_id: templateId, text0: topText, text1: bottomText, username: 'imgflip_hubot', password: 'imgflip_hubot' }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 });
        if (!response.data.success) return interaction.editReply({ content: '❌ Failed to create meme. Please try again.' });
        const embed = new EmbedBuilder().setColor('#00D9FF').setTitle('🎨 Your Custom Meme').setImage(response.data.data.url).setFooter({ text: 'Created with Imgflip' }).setTimestamp();
        return interaction.editReply({ embeds: [embed] });

      } else if (subcommand === 'fact') {
        const category = interaction.options.getString('category') || 'random';
        const facts = {
          science: ['A day on Venus is longer than a year on Venus.', 'Bananas are berries, but strawberries aren\'t.', 'Honey never spoils. Archaeologists have found 3000-year-old honey that was still edible.', 'The Eiffel Tower can be 15 cm taller during the summer due to thermal expansion.', 'A teaspoon of neutron star would weigh 6 billion tons.'],
          history: ['Cleopatra lived closer in time to the Moon landing than to the construction of the Great Pyramid.', 'Oxford University is older than the Aztec Empire.', 'Nintendo was founded in 1889, originally selling handmade playing cards.', 'The shortest war in history was between Britain and Zanzibar. Zanzibar surrendered after 38 minutes.'],
          animals: ['Octopuses have three hearts and blue blood.', 'A group of flamingos is called a "flamboyance".', 'Sea otters hold hands when they sleep to keep from drifting apart.', 'Cows have best friends and get stressed when separated.', 'A shrimp\'s heart is in its head.']
        };
        let factText;
        if (category === 'random') { const allFacts = [...facts.science, ...facts.history, ...facts.animals]; factText = allFacts[Math.floor(Math.random() * allFacts.length)]; }
        else factText = facts[category][Math.floor(Math.random() * facts[category].length)];
        const embed = new EmbedBuilder().setColor('#4169E1').setTitle('💡 Random Fact').setDescription(factText).setFooter({ text: `Category: ${category.charAt(0).toUpperCase() + category.slice(1)}` }).setTimestamp();
        return interaction.editReply({ embeds: [embed] });

      } else if (subcommand === 'wouldyourather') {
        const [questions] = await pool.execute('SELECT * FROM would_you_rather_questions ORDER BY RAND() LIMIT 1');
        let questionText, option1, option2;
        if (questions.length > 0) { questionText = questions[0].question; option1 = questions[0].option1; option2 = questions[0].option2; }
        else {
          const hardcoded = [{ question: 'Would you rather...', option1: 'Fight 100 duck-sized horses', option2: 'Fight 1 horse-sized duck' }, { question: 'Would you rather...', option1: 'Always be 10 minutes late', option2: 'Always be 20 minutes early' }, { question: 'Would you rather...', option1: 'Have the ability to fly', option2: 'Have the ability to be invisible' }];
          const r = hardcoded[Math.floor(Math.random() * hardcoded.length)];
          questionText = r.question; option1 = r.option1; option2 = r.option2;
        }
        const embed = new EmbedBuilder().setColor('#9B59B6').setTitle('🤔 Would You Rather?').setDescription(questionText)
          .addFields({ name: '🅰️ Option A', value: option1, inline: true }, { name: '🅱️ Option B', value: option2, inline: true })
          .setFooter({ text: 'React with 🅰️ or 🅱️ to vote!' }).setTimestamp();
        const message = await interaction.editReply({ embeds: [embed] });
        await message.react('🅰️');
        await message.react('🅱️');

      } else if (subcommand === '8ball') {
        const question = interaction.options.getString('question');
        const responses = ['It is certain.', 'It is decidedly so.', 'Without a doubt.', 'Yes definitely.', 'You may rely on it.', 'As I see it, yes.', 'Most likely.', 'Outlook good.', 'Yes.', 'Signs point to yes.', 'Reply hazy, try again.', 'Ask again later.', 'Better not tell you now.', 'Cannot predict now.', 'Concentrate and ask again.', 'Don\'t count on it.', 'My reply is no.', 'My sources say no.', 'Outlook not so good.', 'Very doubtful.'];
        const answer = responses[Math.floor(Math.random() * responses.length)];
        const embed = new EmbedBuilder().setColor('#8B008B').setTitle('🎱 Magic 8-Ball')
          .addFields({ name: 'Question', value: question }, { name: 'Answer', value: answer }).setTimestamp();
        return interaction.editReply({ embeds: [embed] });
      }

    } catch (error) {
      console.error('[Fun Command Error]', error);
      const replyMethod = interaction.deferred ? 'editReply' : 'reply';
      return interaction[replyMethod]({ content: '❌ An error occurred while processing your fun command.', ephemeral: true });
    }
  },

  // Modal handler for confessions
  async handleModal(interaction) {
    try {
      return await confessHandler.handleConfessModal(interaction);
    } catch (error) {
      console.error('[Fun Modal Error]', error);
      return interaction.editReply({ content: '❌ An error occurred while submitting your confession.' });
    }
  }
};
