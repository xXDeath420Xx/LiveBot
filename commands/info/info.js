import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import axios from 'axios';
import * as cryptoHandler from './knowledge-crypto-handler.js';
import * as githubHandler from './knowledge-github-handler.js';
import * as recipeHandler from './knowledge-recipe-handler.js';

const NASA_API_KEY = process.env.NASA_API_KEY || 'DEMO_KEY';

// Local fallback facts for when the Numbers API is unavailable
const FALLBACK_FACTS = {
  trivia: [
    "42 is the answer to the Ultimate Question of Life, the Universe, and Everything in Douglas Adams' The Hitchhiker's Guide to the Galaxy.",
    "7 is considered lucky in many cultures and appears frequently in mythology and religion.",
    "13 is considered unlucky in Western culture, a superstition called triskaidekaphobia.",
    "8 is considered lucky in Chinese culture because it sounds similar to the word for prosperity.",
    "3 is the first odd prime number and represents harmony in many philosophies.",
    "9 is the highest single-digit number and is considered sacred in many traditions.",
    "108 is a sacred number in Hinduism, Buddhism, and yoga practices.",
    "365 is the number of days in a common year, representing Earth's orbit around the Sun.",
    "52 is the number of weeks in a year and also the number of playing cards in a standard deck.",
    "100 is the basis of our decimal system and represents completeness in many contexts."
  ],
  math: [
    "0 is the only number that cannot be represented in Roman numerals.",
    "1 is the multiplicative identity and the only number that divides all other numbers.",
    "2 is the only even prime number.",
    "Pi (approximately 3.14159) is an irrational number representing the ratio of a circle's circumference to its diameter.",
    "The Fibonacci sequence (0, 1, 1, 2, 3, 5, 8, 13...) appears frequently in nature.",
    "The golden ratio (approximately 1.618) is considered aesthetically pleasing and appears in art and architecture.",
    "Infinity (∞) is not a number but a concept representing something without bound.",
    "e (approximately 2.71828) is the base of natural logarithms and appears in compound interest calculations.",
    "The square root of 2 (approximately 1.414) was the first known irrational number.",
    "Perfect numbers like 6 and 28 equal the sum of their proper divisors."
  ],
  date: [
    "January 1st marks New Year's Day in the Gregorian calendar.",
    "February 14th is celebrated as Valentine's Day in many countries.",
    "March 14th is celebrated as Pi Day (3.14) by mathematics enthusiasts.",
    "April 1st is known as April Fools' Day in many Western cultures.",
    "July 4th is Independence Day in the United States.",
    "October 31st is celebrated as Halloween in many countries.",
    "December 25th is Christmas Day in Christian traditions.",
    "The summer solstice (around June 21) is the longest day of the year in the Northern Hemisphere.",
    "The vernal equinox (around March 20) marks the beginning of spring.",
    "Leap Day (February 29) occurs every four years to keep our calendar synchronized with Earth's orbit."
  ],
  year: [
    "1969 was the year humans first walked on the Moon during the Apollo 11 mission.",
    "1989 marked the fall of the Berlin Wall, symbolizing the end of the Cold War.",
    "2000 was celebrated worldwide with millennium celebrations and Y2K concerns.",
    "1945 marked the end of World War II.",
    "1776 was the year the United States declared independence.",
    "1492 was the year Christopher Columbus reached the Americas.",
    "476 CE marked the fall of the Western Roman Empire.",
    "1215 was the year the Magna Carta was signed in England.",
    "1991 saw the dissolution of the Soviet Union.",
    "2008 marked the global financial crisis."
  ]
};

export default {
    category: 'info',
  data: new SlashCommandBuilder()
    .setName('knowledge')
    .setDescription('Information, facts, entertainment and inspiration commands')
    .addSubcommandGroup(group =>
      group
        .setName('facts')
        .setDescription('Interesting facts about numbers, dates, and years')
        .addSubcommand(sub =>
          sub
            .setName('number')
            .setDescription('Get a fun fact about a specific number')
            .addIntegerOption(option =>
              option.setName('number').setDescription('The number to get a fact about').setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub
            .setName('random')
            .setDescription('Get a random number fact')
            .addStringOption(option =>
              option
                .setName('type')
                .setDescription('Type of fact')
                .addChoices(
                  { name: 'Trivia', value: 'trivia' },
                  { name: 'Math', value: 'math' },
                  { name: 'Date', value: 'date' },
                  { name: 'Year', value: 'year' }
                )
            )
        )
        .addSubcommand(sub =>
          sub
            .setName('date')
            .setDescription('Get a historical fact about a specific date')
            .addIntegerOption(option =>
              option.setName('month').setDescription('Month (1-12)').setRequired(true).setMinValue(1).setMaxValue(12)
            )
            .addIntegerOption(option =>
              option.setName('day').setDescription('Day (1-31)').setRequired(true).setMinValue(1).setMaxValue(31)
            )
        )
        .addSubcommand(sub =>
          sub
            .setName('year')
            .setDescription('Get a historical fact about a specific year')
            .addIntegerOption(option =>
              option.setName('year').setDescription('The year').setRequired(true).setMinValue(-10000).setMaxValue(3000)
            )
        )
        .addSubcommand(sub =>
          sub
            .setName('math')
            .setDescription('Get a mathematical fact about a number')
            .addIntegerOption(option =>
              option.setName('number').setDescription('The number').setRequired(true)
            )
        )
    )
    .addSubcommandGroup(group =>
      group
        .setName('knowledge')
        .setDescription('Daily learning and knowledge features')
        .addSubcommand(sub =>
          sub
            .setName('onthisday')
            .setDescription('Historical events that happened on this day')
            .addIntegerOption(option =>
              option.setName('month').setDescription('Month (1-12, defaults to today)').setMinValue(1).setMaxValue(12)
            )
            .addIntegerOption(option =>
              option.setName('day').setDescription('Day (1-31, defaults to today)').setMinValue(1).setMaxValue(31)
            )
        )
        .addSubcommand(sub =>
          sub.setName('wordofday').setDescription('Learn a new word with definition and examples')
        )
        .addSubcommand(sub =>
          sub
            .setName('dictionary')
            .setDescription('Look up word definitions, synonyms, and pronunciation')
            .addStringOption(option =>
              option.setName('word').setDescription('Word to look up').setRequired(true)
            )
        )
    )
    .addSubcommandGroup(group =>
      group
        .setName('nasa')
        .setDescription('NASA space content and data')
        .addSubcommand(sub =>
          sub
            .setName('apod')
            .setDescription('Astronomy Picture of the Day')
            .addStringOption(option =>
              option.setName('date').setDescription('Date in YYYY-MM-DD format (defaults to today)')
            )
        )
        .addSubcommand(sub =>
          sub
            .setName('mars')
            .setDescription('Latest Mars rover photos')
            .addStringOption(option =>
              option
                .setName('rover')
                .setDescription('Which Mars rover')
                .addChoices(
                  { name: 'Curiosity', value: 'curiosity' },
                  { name: 'Opportunity', value: 'opportunity' },
                  { name: 'Spirit', value: 'spirit' },
                  { name: 'Perseverance', value: 'perseverance' }
                )
            )
        )
        .addSubcommand(sub =>
          sub.setName('neo').setDescription('Near Earth Objects (asteroids) approaching Earth')
        )
        .addSubcommand(sub =>
          sub.setName('iss').setDescription('International Space Station live tracker')
        )
    )
    .addSubcommandGroup(group =>
      group
        .setName('fortune')
        .setDescription('Fortune telling, tarot, and horoscopes')
        .addSubcommand(sub =>
          sub.setName('daily').setDescription('Get your daily fortune')
        )
        .addSubcommand(sub =>
          sub
            .setName('tarot')
            .setDescription('Draw a tarot card')
            .addStringOption(option =>
              option
                .setName('spread')
                .setDescription('Type of tarot spread')
                .addChoices(
                  { name: 'Single Card', value: 'single' },
                  { name: 'Three Card (Past, Present, Future)', value: 'three' }
                )
            )
        )
        .addSubcommand(sub =>
          sub
            .setName('horoscope')
            .setDescription('Get your horoscope')
            .addStringOption(option =>
              option
                .setName('sign')
                .setDescription('Your zodiac sign')
                .setRequired(true)
                .addChoices(
                  { name: '♈ Aries', value: 'aries' },
                  { name: '♉ Taurus', value: 'taurus' },
                  { name: '♊ Gemini', value: 'gemini' },
                  { name: '♋ Cancer', value: 'cancer' },
                  { name: '♌ Leo', value: 'leo' },
                  { name: '♍ Virgo', value: 'virgo' },
                  { name: '♎ Libra', value: 'libra' },
                  { name: '♏ Scorpio', value: 'scorpio' },
                  { name: '♐ Sagittarius', value: 'sagittarius' },
                  { name: '♑ Capricorn', value: 'capricorn' },
                  { name: '♒ Aquarius', value: 'aquarius' },
                  { name: '♓ Pisces', value: 'pisces' }
                )
            )
        )
        .addSubcommand(sub =>
          sub.setName('lucky').setDescription('Get your lucky numbers for today')
        )
    )
    .addSubcommandGroup(group =>
      group
        .setName('urban')
        .setDescription('Urban Dictionary slang definitions')
        .addSubcommand(sub =>
          sub
            .setName('define')
            .setDescription('Define a slang term')
            .addStringOption(option =>
              option.setName('term').setDescription('The term to define').setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub.setName('random').setDescription('Get a random slang definition')
        )
    )
    .addSubcommandGroup(group =>
      group
        .setName('inspire')
        .setDescription('Inspirational quotes, facts, and positive vibes')
        .addSubcommand(sub =>
          sub
            .setName('quote')
            .setDescription('Get an inspirational quote')
            .addStringOption(option =>
              option
                .setName('category')
                .setDescription('Quote category')
                .addChoices(
                  { name: 'Inspirational', value: 'inspirational' },
                  { name: 'Motivational', value: 'motivational' },
                  { name: 'Life', value: 'life' },
                  { name: 'Success', value: 'success' },
                  { name: 'Wisdom', value: 'wisdom' },
                  { name: 'Random', value: 'random' }
                )
            )
        )
        .addSubcommand(sub =>
          sub
            .setName('fact')
            .setDescription('Get an interesting fact')
            .addStringOption(option =>
              option
                .setName('category')
                .setDescription('Fact category')
                .addChoices(
                  { name: 'Random', value: 'random' },
                  { name: 'Science', value: 'science' },
                  { name: 'Animals', value: 'animals' },
                  { name: 'Space', value: 'space' },
                  { name: 'History', value: 'history' }
                )
            )
        )
        .addSubcommand(sub =>
          sub
            .setName('compliment')
            .setDescription('Get or give a compliment')
            .addUserOption(option =>
              option.setName('user').setDescription('User to compliment (optional)')
            )
        )
        .addSubcommand(sub =>
          sub.setName('affirmation').setDescription('Daily positive affirmation')
        )
        .addSubcommand(sub =>
          sub.setName('advice').setDescription('Get random life advice')
        )
    )
    .addSubcommandGroup(group =>
      group
        .setName('jokes')
        .setDescription('Jokes from various categories')
        .addSubcommand(sub =>
          sub.setName('dad').setDescription('Get a random dad joke')
        )
        .addSubcommand(sub =>
          sub
            .setName('chucknorris')
            .setDescription('Get a random Chuck Norris joke')
            .addStringOption(option =>
              option
                .setName('category')
                .setDescription('Category of Chuck Norris joke')
                .addChoices(
                  { name: 'Random', value: 'random' },
                  { name: 'Animal', value: 'animal' },
                  { name: 'Career', value: 'career' },
                  { name: 'Celebrity', value: 'celebrity' },
                  { name: 'Dev (Programming)', value: 'dev' },
                  { name: 'Fashion', value: 'fashion' },
                  { name: 'Food', value: 'food' },
                  { name: 'History', value: 'history' },
                  { name: 'Money', value: 'money' },
                  { name: 'Movie', value: 'movie' },
                  { name: 'Music', value: 'music' },
                  { name: 'Political', value: 'political' },
                  { name: 'Religion', value: 'religion' },
                  { name: 'Science', value: 'science' },
                  { name: 'Sport', value: 'sport' },
                  { name: 'Travel', value: 'travel' }
                )
            )
        )
        .addSubcommand(sub =>
          sub.setName('programming').setDescription('Get a random programming joke')
        )
        .addSubcommand(sub =>
          sub.setName('general').setDescription('Get a random general joke')
        )
    )
    .addSubcommandGroup(group =>
      group
        .setName('crypto')
        .setDescription('Cryptocurrency price information and tracking')
        .addSubcommand(sub =>
          sub
            .setName('price')
            .setDescription('Get current price of a cryptocurrency')
            .addStringOption(option =>
              option.setName('coin').setDescription('Cryptocurrency symbol or name (e.g., bitcoin, btc, ethereum, eth)').setRequired(true)
            )
            .addStringOption(option =>
              option.setName('currency').setDescription('Currency to display price in')
                .addChoices(
                  { name: 'USD', value: 'usd' }, { name: 'EUR', value: 'eur' }, { name: 'GBP', value: 'gbp' },
                  { name: 'JPY', value: 'jpy' }, { name: 'AUD', value: 'aud' }, { name: 'CAD', value: 'cad' }
                )
            )
        )
        .addSubcommand(sub =>
          sub.setName('trending').setDescription('Get trending cryptocurrencies')
        )
        .addSubcommand(sub =>
          sub
            .setName('compare')
            .setDescription('Compare two cryptocurrencies')
            .addStringOption(option => option.setName('coin1').setDescription('First cryptocurrency').setRequired(true))
            .addStringOption(option => option.setName('coin2').setDescription('Second cryptocurrency').setRequired(true))
        )
        .addSubcommand(sub =>
          sub
            .setName('top')
            .setDescription('Get top cryptocurrencies by market cap')
            .addIntegerOption(option =>
              option.setName('limit').setDescription('Number of cryptocurrencies to show (1-10)').setMinValue(1).setMaxValue(10)
            )
        )
    )
    .addSubcommandGroup(group =>
      group
        .setName('github')
        .setDescription('GitHub repository and user information')
        .addSubcommand(sub =>
          sub
            .setName('repo')
            .setDescription('Get information about a GitHub repository')
            .addStringOption(option =>
              option.setName('repository').setDescription('Repository in format: owner/repo (e.g., discord/discord-api-docs)').setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub
            .setName('user')
            .setDescription('Get information about a GitHub user')
            .addStringOption(option =>
              option.setName('username').setDescription('GitHub username').setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub
            .setName('search')
            .setDescription('Search for GitHub repositories')
            .addStringOption(option =>
              option.setName('query').setDescription('Search query').setRequired(true)
            )
        )
        .addSubcommand(sub =>
          sub
            .setName('trending')
            .setDescription('View trending GitHub repositories')
            .addStringOption(option =>
              option.setName('language').setDescription('Filter by programming language (optional)')
                .addChoices(
                  { name: 'JavaScript', value: 'javascript' }, { name: 'Python', value: 'python' },
                  { name: 'TypeScript', value: 'typescript' }, { name: 'Java', value: 'java' },
                  { name: 'Go', value: 'go' }, { name: 'Rust', value: 'rust' },
                  { name: 'C++', value: 'cpp' }, { name: 'C#', value: 'csharp' },
                  { name: 'PHP', value: 'php' }, { name: 'Ruby', value: 'ruby' }
                )
            )
        )
    )
    .addSubcommandGroup(group =>
      group
        .setName('recipe')
        .setDescription('Search for recipes and cocktails')
        .addSubcommand(sub =>
          sub
            .setName('search')
            .setDescription('Search for a meal recipe')
            .addStringOption(option => option.setName('query').setDescription('Name of the dish to search for').setRequired(true))
        )
        .addSubcommand(sub =>
          sub.setName('random').setDescription('Get a random meal recipe')
        )
        .addSubcommand(sub =>
          sub
            .setName('ingredient')
            .setDescription('Find recipes by main ingredient')
            .addStringOption(option => option.setName('ingredient').setDescription('Main ingredient (e.g., chicken, beef, salmon)').setRequired(true))
        )
        .addSubcommand(sub =>
          sub
            .setName('cocktail')
            .setDescription('Search for a cocktail recipe')
            .addStringOption(option => option.setName('name').setDescription('Name of the cocktail').setRequired(true))
        )
        .addSubcommand(sub =>
          sub.setName('randomcocktail').setDescription('Get a random cocktail recipe')
        )
    ),

  async execute(interaction) {
    const group = interaction.options.getSubcommandGroup();
    const subcommand = interaction.options.getSubcommand();

    try {
      // Route to appropriate group handler
      switch (group) {
        case 'facts':
          return await this.handleFacts(interaction, subcommand);
        case 'knowledge':
          return await this.handleKnowledge(interaction, subcommand);
        case 'nasa':
          return await this.handleNASA(interaction, subcommand);
        case 'fortune':
          return await this.handleFortune(interaction, subcommand);
        case 'urban':
          return await this.handleUrban(interaction, subcommand);
        case 'inspire':
          return await this.handleInspire(interaction, subcommand);
        case 'jokes':
          return await this.handleJokes(interaction, subcommand);
        case 'crypto': {
          await interaction.deferReply();
          switch (subcommand) {
            case 'price': return await cryptoHandler.handlePrice(interaction);
            case 'trending': return await cryptoHandler.handleTrending(interaction);
            case 'compare': return await cryptoHandler.handleCompare(interaction);
            case 'top': return await cryptoHandler.handleTop(interaction);
          }
          break;
        }
        case 'github': {
          await interaction.deferReply();
          switch (subcommand) {
            case 'repo': return await githubHandler.handleRepo(interaction);
            case 'user': return await githubHandler.handleUser(interaction);
            case 'search': return await githubHandler.handleSearch(interaction);
            case 'trending': return await githubHandler.handleTrending(interaction);
          }
          break;
        }
        case 'recipe': {
          await interaction.deferReply();
          switch (subcommand) {
            case 'search': return await recipeHandler.handleSearch(interaction);
            case 'random': return await recipeHandler.handleRandom(interaction);
            case 'ingredient': return await recipeHandler.handleIngredient(interaction);
            case 'cocktail': return await recipeHandler.handleCocktail(interaction);
            case 'randomcocktail': return await recipeHandler.handleRandomCocktail(interaction);
          }
          break;
        }
      }
    } catch (error) {
      console.error('[Info Command Error]', error);
      const method = interaction.deferred ? 'editReply' : 'reply';
      return interaction[method]({
        content: '❌ Failed to process request. Please try again later.',
        ephemeral: true
      });
    }
  },

  // ==================== FACTS GROUP ====================
  async handleFacts(interaction, subcommand) {
    await interaction.deferReply();

    let url, factText, factType, factTitle;
    let usedFallback = false;

    try {
      switch (subcommand) {
        case 'number': {
          const number = interaction.options.getInteger('number');
          url = `http://numbersapi.com/${number}/trivia?json`;
          try {
            const response = await axios.get(url, { timeout: 5000 });
            factText = response.data.text;
          } catch (apiError) {
            // Fallback to local facts
            const facts = FALLBACK_FACTS.trivia;
            factText = facts[Math.abs(number) % facts.length];
            usedFallback = true;
          }
          factType = 'Number Trivia';
          factTitle = `Fact about ${number}`;
          break;
        }

        case 'random': {
          const type = interaction.options.getString('type') || 'trivia';
          url = `http://numbersapi.com/random/${type}?json`;
          try {
            const response = await axios.get(url, { timeout: 5000 });
            factText = response.data.text;
          } catch (apiError) {
            // Fallback to local facts
            const factCategory = type === 'date' ? 'date' : type === 'year' ? 'year' : type === 'math' ? 'math' : 'trivia';
            const facts = FALLBACK_FACTS[factCategory];
            factText = facts[Math.floor(Math.random() * facts.length)];
            usedFallback = true;
          }
          factType = type.charAt(0).toUpperCase() + type.slice(1);
          factTitle = `Random ${factType} Fact`;
          break;
        }

        case 'date': {
          const month = interaction.options.getInteger('month');
          const day = interaction.options.getInteger('day');
          url = `http://numbersapi.com/${month}/${day}/date?json`;
          try {
            const response = await axios.get(url, { timeout: 5000 });
            factText = response.data.text;
          } catch (apiError) {
            // Fallback to Wikipedia's "On This Day" API for date-specific facts
            try {
              const wikiUrl = `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/events/${month}/${day}`;
              const wikiResponse = await axios.get(wikiUrl, {
                headers: { 'User-Agent': 'DiscordBot/1.0 (Educational Purpose)' },
                timeout: 5000
              });

              if (wikiResponse.data.events && wikiResponse.data.events.length > 0) {
                const randomEvent = wikiResponse.data.events[Math.floor(Math.random() * Math.min(5, wikiResponse.data.events.length))];
                factText = `${randomEvent.year}: ${randomEvent.text}`;
              } else {
                factText = `No historical events found for ${month}/${day}.`;
              }
              usedFallback = true;
            } catch (wikiError) {
              return interaction.editReply({
                content: `❌ Unable to fetch facts for ${month}/${day}. Both Numbers API and Wikipedia are currently unavailable.`,
                ephemeral: true
              });
            }
          }
          factType = 'Date Fact';
          factTitle = `${month}/${day}`;
          break;
        }

        case 'year': {
          const year = interaction.options.getInteger('year');
          url = `http://numbersapi.com/${year}/year?json`;
          try {
            const response = await axios.get(url, { timeout: 5000 });
            factText = response.data.text;
          } catch (apiError) {
            // For year-specific requests, we can't provide accurate fallback data
            return interaction.editReply({
              content: `❌ Unable to fetch historical facts for the year ${year}. The Numbers API is currently unavailable. Please try again later.`,
              ephemeral: true
            });
          }
          factType = 'Year Fact';
          factTitle = `Year ${year}`;
          break;
        }

        case 'math': {
          const number = interaction.options.getInteger('number');
          url = `http://numbersapi.com/${number}/math?json`;
          try {
            const response = await axios.get(url, { timeout: 5000 });
            factText = response.data.text;
          } catch (apiError) {
            // Fallback to local facts
            const facts = FALLBACK_FACTS.math;
            factText = facts[Math.abs(number) % facts.length];
            usedFallback = true;
          }
          factType = 'Math Fact';
          factTitle = `Math fact about ${number}`;
          break;
        }
      }

      const embed = new EmbedBuilder()
        .setColor('#00AE86')
        .setTitle(`📚 ${factTitle}`)
        .setDescription(factText)
        .setFooter({ text: usedFallback ? `Type: ${factType} • Cached fact (API unavailable)` : `Type: ${factType} • Powered by Numbers API` })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('[Facts Error]', error);

      return interaction.editReply({
        content: '❌ An unexpected error occurred while fetching the fact. Please try again.',
        ephemeral: true
      });
    }
  },

  // ==================== KNOWLEDGE GROUP ====================
  async handleKnowledge(interaction, subcommand) {
    try {
      switch (subcommand) {
        case 'onthisday':
          return await this.knowledgeOnThisDay(interaction);
        case 'wordofday':
          return await this.knowledgeWordOfDay(interaction);
        case 'dictionary':
          return await this.knowledgeDictionary(interaction);
      }
    } catch (error) {
      console.error('[Knowledge Error]', error);
      const method = interaction.deferred ? 'editReply' : 'reply';
      return interaction[method]({
        content: '❌ Failed to fetch knowledge data. Please try again later.',
        ephemeral: true
      });
    }
  },

  async knowledgeOnThisDay(interaction) {
    await interaction.deferReply();

    const now = new Date();
    const month = interaction.options.getInteger('month') || (now.getMonth() + 1);
    const day = interaction.options.getInteger('day') || now.getDate();

    const daysInMonth = new Date(now.getFullYear(), month, 0).getDate();
    if (day > daysInMonth) {
      return interaction.editReply({
        content: `❌ Invalid date. Month ${month} only has ${daysInMonth} days.`,
        ephemeral: true
      });
    }

    try {
      const url = `https://api.wikimedia.org/feed/v1/wikipedia/en/onthisday/all/${month}/${day}`;

      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'DiscordBot/1.0 (Educational Purpose)'
        },
        timeout: 10000
      });

      const data = response.data;

      const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                          'July', 'August', 'September', 'October', 'November', 'December'];

      const embed = new EmbedBuilder()
        .setColor('#36C5F0')
        .setTitle(`📅 On This Day - ${monthNames[month - 1]} ${day}`)
        .setDescription('Historical events, births, and deaths that occurred on this day throughout history')
        .setFooter({ text: 'Powered by Wikipedia' })
        .setTimestamp();

      if (data.events && data.events.length > 0) {
        const events = data.events.slice(0, 5);
        const eventText = events.map(event =>
          `**${event.year}:** ${event.text.substring(0, 200)}${event.text.length > 200 ? '...' : ''}`
        ).join('\n\n');

        embed.addFields({
          name: '📰 Historical Events',
          value: eventText || 'No events found',
          inline: false
        });
      }

      if (data.births && data.births.length > 0) {
        const births = data.births.slice(0, 3);
        const birthText = births.map(birth =>
          `**${birth.year}:** ${birth.text.substring(0, 150)}${birth.text.length > 150 ? '...' : ''}`
        ).join('\n');

        embed.addFields({
          name: '🎂 Notable Births',
          value: birthText || 'No births found',
          inline: false
        });
      }

      if (data.deaths && data.deaths.length > 0) {
        const deaths = data.deaths.slice(0, 3);
        const deathText = deaths.map(death =>
          `**${death.year}:** ${death.text.substring(0, 150)}${death.text.length > 150 ? '...' : ''}`
        ).join('\n');

        embed.addFields({
          name: '🕊️ Notable Deaths',
          value: deathText || 'No deaths found',
          inline: false
        });
      }

      return interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('[On This Day Error]', error);
      return interaction.editReply({
        content: '❌ Failed to fetch historical data. Wikipedia API may be temporarily unavailable.',
        ephemeral: true
      });
    }
  },

  async knowledgeWordOfDay(interaction) {
    await interaction.deferReply();

    try {
      const interestingWords = [
        'serendipity', 'ephemeral', 'eloquent', 'luminous', 'ethereal',
        'mellifluous', 'ineffable', 'petrichor', 'solitude', 'nostalgia',
        'euphoria', 'resilience', 'wanderlust', 'perseverance', 'sublime',
        'quintessential', 'ubiquitous', 'paradigm', 'epiphany', 'paradox',
        'ambiguous', 'zenith', 'aesthetic', 'catalyst', 'eloquent'
      ];

      const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
      const wordOfDay = interestingWords[dayOfYear % interestingWords.length];

      const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${wordOfDay}`;
      const response = await axios.get(url, { timeout: 10000 });

      const data = response.data[0];
      const meaning = data.meanings[0];
      const definition = meaning.definitions[0];

      const embed = new EmbedBuilder()
        .setColor('#FF6B6B')
        .setTitle(`📚 Word of the Day: ${data.word}`)
        .setDescription(`**${meaning.partOfSpeech}** • ${data.phonetic || 'pronunciation varies'}`)
        .addFields({
          name: '📖 Definition',
          value: definition.definition,
          inline: false
        })
        .setFooter({ text: 'Expand your vocabulary daily!' })
        .setTimestamp();

      if (definition.example) {
        embed.addFields({
          name: '💬 Example',
          value: `"${definition.example}"`,
          inline: false
        });
      }

      if (definition.synonyms && definition.synonyms.length > 0) {
        embed.addFields({
          name: '🔄 Synonyms',
          value: definition.synonyms.slice(0, 5).join(', '),
          inline: true
        });
      }

      if (definition.antonyms && definition.antonyms.length > 0) {
        embed.addFields({
          name: '↔️ Antonyms',
          value: definition.antonyms.slice(0, 5).join(', '),
          inline: true
        });
      }

      if (data.phonetics && data.phonetics.length > 0) {
        const audioPhonetic = data.phonetics.find(p => p.audio);
        if (audioPhonetic && audioPhonetic.audio) {
          embed.addFields({
            name: '🔊 Pronunciation',
            value: `[Listen](${audioPhonetic.audio})`,
            inline: true
          });
        }
      }

      return interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('[Word of Day Error]', error);
      return interaction.editReply({
        content: '❌ Failed to fetch word of the day. Dictionary API may be temporarily unavailable.',
        ephemeral: true
      });
    }
  },

  async knowledgeDictionary(interaction) {
    await interaction.deferReply();

    const word = interaction.options.getString('word').toLowerCase().trim();

    if (word.length > 50 || !/^[a-z-]+$/i.test(word)) {
      return interaction.editReply({
        content: '❌ Invalid word. Please enter a single word using only letters and hyphens.',
        ephemeral: true
      });
    }

    try {
      const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${word}`;
      const response = await axios.get(url, { timeout: 10000 });

      const data = response.data[0];

      const embed = new EmbedBuilder()
        .setColor('#4ECDC4')
        .setTitle(`📖 Dictionary: ${data.word}`)
        .setDescription(data.phonetic || 'pronunciation varies')
        .setFooter({ text: 'Powered by Free Dictionary API' })
        .setTimestamp();

      if (data.phonetics && data.phonetics.length > 0) {
        const audioPhonetic = data.phonetics.find(p => p.audio);
        if (audioPhonetic && audioPhonetic.audio) {
          embed.setDescription(`${data.phonetic || ''} [🔊 Listen](${audioPhonetic.audio})`);
        }
      }

      data.meanings.slice(0, 3).forEach((meaning, index) => {
        const definition = meaning.definitions[0];
        let value = `**Definition:** ${definition.definition}`;

        if (definition.example) {
          value += `\n**Example:** "${definition.example}"`;
        }

        if (definition.synonyms && definition.synonyms.length > 0) {
          value += `\n**Synonyms:** ${definition.synonyms.slice(0, 5).join(', ')}`;
        }

        embed.addFields({
          name: `${index + 1}. ${meaning.partOfSpeech}`,
          value: value.substring(0, 1024),
          inline: false
        });
      });

      if (data.origin) {
        embed.addFields({
          name: '📜 Etymology',
          value: data.origin.substring(0, 1024),
          inline: false
        });
      }

      return interaction.editReply({ embeds: [embed] });

    } catch (error) {
      if (error.response?.status === 404) {
        return interaction.editReply({
          content: `❌ Word "${word}" not found in the dictionary. Please check the spelling.`,
          ephemeral: true
        });
      }

      console.error('[Dictionary Error]', error);
      return interaction.editReply({
        content: '❌ Failed to lookup word. Dictionary API may be temporarily unavailable.',
        ephemeral: true
      });
    }
  },

  // ==================== NASA GROUP ====================
  async handleNASA(interaction, subcommand) {
    await interaction.deferReply();

    try {
      switch (subcommand) {
        case 'apod':
          return await this.nasaAPOD(interaction);
        case 'mars':
          return await this.nasaMars(interaction);
        case 'neo':
          return await this.nasaNEO(interaction);
        case 'iss':
          return await this.nasaISS(interaction);
      }
    } catch (error) {
      console.error('[NASA Error]', error);
      return interaction.editReply({
        content: '❌ An error occurred while processing your NASA request.',
        ephemeral: true
      });
    }
  },

  async nasaAPOD(interaction) {
    const date = interaction.options.getString('date');

    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return interaction.editReply({
        content: '❌ Invalid date format. Please use YYYY-MM-DD (e.g., 2024-01-15).'
      });
    }

    try {
      const params = { api_key: NASA_API_KEY };
      if (date) params.date = date;

      const response = await axios.get('https://api.nasa.gov/planetary/apod', {
        params,
        timeout: 10000
      });

      const apod = response.data;

      const embed = new EmbedBuilder()
        .setColor('#0B3D91')
        .setTitle(apod.title)
        .setDescription(apod.explanation.length > 4096 ? apod.explanation.substring(0, 4093) + '...' : apod.explanation)
        .setFooter({ text: `Copyright: ${apod.copyright || 'Public Domain'} • ${apod.date}` })
        .setTimestamp();

      if (apod.media_type === 'image') {
        embed.setImage(apod.hdurl || apod.url);
      } else if (apod.media_type === 'video') {
        embed.addFields({ name: '📺 Video Link', value: apod.url });
      }

      return interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('[NASA APOD Error]', error);
      return interaction.editReply({
        content: '❌ Failed to fetch Astronomy Picture of the Day. Please try again later.'
      });
    }
  },

  async nasaMars(interaction) {
    const rover = interaction.options.getString('rover') || 'curiosity';

    try {
      const response = await axios.get(`https://api.nasa.gov/mars-photos/api/v1/rovers/${rover}/latest_photos`, {
        params: { api_key: NASA_API_KEY },
        timeout: 10000
      });

      if (!response.data.latest_photos || response.data.latest_photos.length === 0) {
        return interaction.editReply({
          content: `❌ No recent photos available from ${rover.charAt(0).toUpperCase() + rover.slice(1)} rover.`
        });
      }

      const photos = response.data.latest_photos;
      const photo = photos[Math.floor(Math.random() * Math.min(photos.length, 10))];

      const embed = new EmbedBuilder()
        .setColor('#CD5C5C')
        .setTitle(`🔴 Mars Rover: ${photo.rover.name}`)
        .setDescription(`Camera: ${photo.camera.full_name}`)
        .addFields(
          { name: 'Earth Date', value: photo.earth_date, inline: true },
          { name: 'Sol (Mars Day)', value: photo.sol.toString(), inline: true },
          { name: 'Rover Status', value: photo.rover.status, inline: true }
        )
        .setImage(photo.img_src)
        .setFooter({ text: `Photo ID: ${photo.id} • ${photos.length} photos available from this sol` })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('[NASA Mars Error]', error);

      const roverName = rover.charAt(0).toUpperCase() + rover.slice(1);
      const isApiDown = error.response?.status === 404 || error.message.includes('ENOTFOUND');

      if (isApiDown) {
        const embed = new EmbedBuilder()
          .setColor('#CD5C5C')
          .setTitle('🔴 Mars Rover Photos Temporarily Unavailable')
          .setDescription(`The NASA Mars Rover Photos API is currently experiencing issues. However, you can still view ${roverName} rover photos through these official sources:`)
          .addFields(
            {
              name: '🌐 Official NASA Sources',
              value: `**${roverName} Raw Images:**\n` +
                `• [NASA Mars Raw Images](https://mars.nasa.gov/mars2020/multimedia/raw-images/)\n` +
                `• [JPL Photojournal](https://photojournal.jpl.nasa.gov/)\n` +
                `• [Mars Science Laboratory](https://mars.nasa.gov/msl/multimedia/raw-images/)`,
              inline: false
            },
            {
              name: '📸 Latest Highlights',
              value: `• [Mars Perseverance Gallery](https://mars.nasa.gov/mars2020/multimedia/images/)\n` +
                `• [Curiosity Photo Album](https://mars.nasa.gov/msl/multimedia/images/)`,
              inline: false
            },
            {
              name: '💡 Try These Commands',
              value: '• `/info nasa apod` - Today\'s space image\n• `/info nasa iss` - Track the ISS\n• `/info nasa neo` - Nearby asteroids',
              inline: false
            }
          )
          .setFooter({ text: 'The Mars API should return to service soon. Check back later!' })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      } else {
        return interaction.editReply({
          content: `❌ Failed to fetch ${roverName} rover photos. Please try again later.\n\n**Tip:** Try the other NASA commands like \`/info nasa apod\` or \`/info nasa iss\``
        });
      }
    }
  },

  async nasaNEO(interaction) {
    try {
      const today = new Date().toISOString().split('T')[0];
      const response = await axios.get('https://api.nasa.gov/neo/rest/v1/feed', {
        params: {
          start_date: today,
          end_date: today,
          api_key: NASA_API_KEY
        },
        timeout: 10000
      });

      const neos = response.data.near_earth_objects[today];

      if (!neos || neos.length === 0) {
        return interaction.editReply({
          content: '❌ No Near Earth Objects approaching today.'
        });
      }

      neos.sort((a, b) => {
        const distA = parseFloat(a.close_approach_data[0].miss_distance.kilometers);
        const distB = parseFloat(b.close_approach_data[0].miss_distance.kilometers);
        return distA - distB;
      });

      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('☄️ Near Earth Objects Today')
        .setDescription(`**${neos.length} asteroids** passing near Earth today`)
        .setFooter({ text: 'Data from NASA NEO Web Service' })
        .setTimestamp();

      const topNeos = neos.slice(0, 5);

      for (const neo of topNeos) {
        const approach = neo.close_approach_data[0];
        const distKm = parseFloat(approach.miss_distance.kilometers).toLocaleString();
        const distLunar = parseFloat(approach.miss_distance.lunar).toFixed(2);
        const velocity = parseFloat(approach.relative_velocity.kilometers_per_hour).toLocaleString();
        const diameter = neo.estimated_diameter.meters;
        const avgDiameter = ((diameter.estimated_diameter_min + diameter.estimated_diameter_max) / 2).toFixed(0);

        const hazardous = neo.is_potentially_hazardous_asteroid ? '⚠️ ' : '';

        embed.addFields({
          name: `${hazardous}${neo.name}`,
          value: `**Distance:** ${distKm} km (${distLunar} lunar distances)\n**Velocity:** ${velocity} km/h\n**Diameter:** ~${avgDiameter} meters`,
          inline: false
        });
      }

      if (neos.length > 5) {
        embed.addFields({
          name: 'And more...',
          value: `Plus ${neos.length - 5} more asteroids approaching today.`
        });
      }

      return interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('[NASA NEO Error]', error);
      return interaction.editReply({
        content: '❌ Failed to fetch Near Earth Objects data. Please try again later.'
      });
    }
  },

  async nasaISS(interaction) {
    try {
      const locationResponse = await axios.get('http://api.open-notify.org/iss-now.json', {
        timeout: 10000
      });

      const issData = locationResponse.data;
      const latitude = parseFloat(issData.iss_position.latitude);
      const longitude = parseFloat(issData.iss_position.longitude);
      const timestamp = issData.timestamp;

      const peopleResponse = await axios.get('http://api.open-notify.org/astros.json', {
        timeout: 10000
      });

      const astronauts = peopleResponse.data.people.filter(p => p.craft === 'ISS');

      const issSpeed = '27,600 km/h (7.66 km/s)';
      const issAltitude = '~408 km (253 miles)';
      const orbitalPeriod = '~92 minutes';

      let locationDesc = 'Over the ocean';
      if (latitude > 0 && longitude > -180 && longitude < -30) {
        locationDesc = 'Over the Americas';
      } else if (latitude > 0 && longitude > -30 && longitude < 60) {
        locationDesc = 'Over Europe/Africa';
      } else if (longitude > 60 && longitude < 180) {
        locationDesc = 'Over Asia/Pacific';
      }

      const hemisphere = latitude >= 0 ? 'Northern' : 'Southern';

      const embed = new EmbedBuilder()
        .setColor('#1E90FF')
        .setTitle('🛰️ International Space Station - Live Tracker')
        .setDescription('Real-time position of the ISS orbiting Earth')
        .addFields(
          {
            name: '🌍 Current Position',
            value: `**Latitude:** ${latitude.toFixed(4)}°\n**Longitude:** ${longitude.toFixed(4)}°\n**Location:** ${locationDesc} (${hemisphere} Hemisphere)`,
            inline: false
          },
          {
            name: '📊 Orbital Data',
            value: `**Speed:** ${issSpeed}\n**Altitude:** ${issAltitude}\n**Orbital Period:** ${orbitalPeriod}`,
            inline: false
          },
          {
            name: '👨‍🚀 Crew on ISS',
            value: astronauts.length > 0
              ? `**${astronauts.length} astronaut${astronauts.length > 1 ? 's' : ''} aboard:**\n${astronauts.map(a => `• ${a.name}`).join('\n')}`
              : 'Crew data unavailable',
            inline: false
          },
          {
            name: '🗺️ Track the ISS',
            value: `[View on Map](https://www.google.com/maps?q=${latitude},${longitude})\n[ISS Tracker](https://www.n2yo.com/satellite/?s=25544)`,
            inline: false
          }
        )
        .setFooter({ text: `Last updated: ${new Date(timestamp * 1000).toUTCString()} • Powered by Open Notify API` })
        .setTimestamp();

      const latDirection = latitude >= 0 ? 'N' : 'S';
      const lonDirection = longitude >= 0 ? 'E' : 'W';
      embed.addFields({
        name: '🧭 Coordinates',
        value: `${Math.abs(latitude).toFixed(2)}° ${latDirection}, ${Math.abs(longitude).toFixed(2)}° ${lonDirection}`,
        inline: true
      });

      return interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('[NASA ISS Error]', error);
      return interaction.editReply({
        content: '❌ Failed to fetch ISS tracking data. Please try again later.'
      });
    }
  },

  // ==================== FORTUNE GROUP ====================
  async handleFortune(interaction, subcommand) {
    await interaction.deferReply();

    try {
      switch (subcommand) {
        case 'daily':
          return await this.fortuneDaily(interaction);
        case 'tarot':
          return await this.fortuneTarot(interaction);
        case 'horoscope':
          return await this.fortuneHoroscope(interaction);
        case 'lucky':
          return await this.fortuneLucky(interaction);
      }
    } catch (error) {
      console.error('[Fortune Error]', error);
      return interaction.editReply({
        content: '❌ An error occurred while consulting the spirits.',
        ephemeral: true
      });
    }
  },

  async fortuneDaily(interaction) {
    const fortunes = [
      'A pleasant surprise is waiting for you.',
      'Your creativity will lead to success.',
      'Good things come to those who wait.',
      'An exciting opportunity lies ahead.',
      'Your hard work will soon pay off.',
      'A new friendship will brighten your day.',
      'Trust your instincts today.',
      'Adventure awaits around the corner.',
      'Your kindness will be rewarded.',
      'Today is a perfect day for new beginnings.',
      'An old problem will resolve itself.',
      'You will make someone smile today.',
      'Great things come from small beginnings.',
      'Your positive attitude will attract good fortune.',
      'A moment of clarity is coming your way.',
      'Someone is thinking of you right now.',
      'Your talents will be recognized.',
      'Patience will bring great rewards.',
      'A dream may come true today.',
      'Happiness is in your future.',
      'An important message is on its way.',
      'Your wisdom will guide others.',
      'Success is within reach.',
      'Today brings new possibilities.',
      'Love is in the air.',
      'A journey will teach you something valuable.',
      'Your generosity will come back to you.',
      'Focus on what makes you happy.',
      'An answer you seek will reveal itself.',
      'Today is your lucky day!'
    ];

    const userId = interaction.user.id;
    const today = new Date().toDateString();
    const seed = parseInt(userId) + today.split('').reduce((a, b) => a + b.charCodeAt(0), 0);
    const fortune = fortunes[seed % fortunes.length];

    const luckyNumber = (seed % 100) + 1;

    const embed = new EmbedBuilder()
      .setColor('#FFD700')
      .setTitle('🔮 Your Daily Fortune')
      .setDescription(fortune)
      .addFields(
        { name: 'Lucky Number', value: luckyNumber.toString(), inline: true },
        { name: 'Lucky Color', value: ['Red', 'Blue', 'Green', 'Purple', 'Gold', 'Silver'][seed % 6], inline: true }
      )
      .setFooter({ text: 'Come back tomorrow for a new fortune!' })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  },

  async fortuneTarot(interaction) {
    const spread = interaction.options.getString('spread') || 'single';

    const tarotCards = [
      { name: 'The Fool', meaning: 'New beginnings, innocence, spontaneity', reversed: 'Recklessness, taken advantage of, inconsideration' },
      { name: 'The Magician', meaning: 'Manifestation, resourcefulness, power', reversed: 'Manipulation, poor planning, untapped talents' },
      { name: 'The High Priestess', meaning: 'Intuition, sacred knowledge, divine feminine', reversed: 'Secrets, disconnected from intuition, withdrawal' },
      { name: 'The Empress', meaning: 'Femininity, beauty, nature, abundance', reversed: 'Creative block, dependence on others' },
      { name: 'The Emperor', meaning: 'Authority, structure, control, fatherhood', reversed: 'Domination, excessive control, lack of discipline' },
      { name: 'The Hierophant', meaning: 'Spiritual wisdom, tradition, conformity', reversed: 'Personal beliefs, freedom, challenging the status quo' },
      { name: 'The Lovers', meaning: 'Love, harmony, relationships, values alignment', reversed: 'Self-love, disharmony, imbalance' },
      { name: 'The Chariot', meaning: 'Control, willpower, success, determination', reversed: 'Lack of control, lack of direction, aggression' },
      { name: 'Strength', meaning: 'Courage, persuasion, influence, compassion', reversed: 'Inner strength, self-doubt, low energy' },
      { name: 'The Hermit', meaning: 'Soul searching, introspection, inner guidance', reversed: 'Isolation, loneliness, withdrawal' },
      { name: 'Wheel of Fortune', meaning: 'Good luck, karma, life cycles, destiny', reversed: 'Bad luck, resistance to change, breaking cycles' },
      { name: 'Justice', meaning: 'Justice, fairness, truth, cause and effect', reversed: 'Unfairness, lack of accountability, dishonesty' },
      { name: 'The Hanged Man', meaning: 'Pause, surrender, letting go, new perspectives', reversed: 'Delays, resistance, stalling' },
      { name: 'Death', meaning: 'Endings, change, transformation, transition', reversed: 'Resistance to change, personal transformation' },
      { name: 'Temperance', meaning: 'Balance, moderation, patience, purpose', reversed: 'Imbalance, excess, self-healing' },
      { name: 'The Devil', meaning: 'Shadow self, attachment, addiction, restriction', reversed: 'Releasing limiting beliefs, exploring dark thoughts' },
      { name: 'The Tower', meaning: 'Sudden change, upheaval, chaos, revelation', reversed: 'Personal transformation, fear of change' },
      { name: 'The Star', meaning: 'Hope, faith, purpose, renewal, spirituality', reversed: 'Lack of faith, despair, disconnection' },
      { name: 'The Moon', meaning: 'Illusion, fear, anxiety, subconscious, intuition', reversed: 'Release of fear, repressed emotion' },
      { name: 'The Sun', meaning: 'Positivity, fun, warmth, success, vitality', reversed: 'Inner child, feeling down, overly optimistic' },
      { name: 'Judgement', meaning: 'Judgement, rebirth, inner calling, absolution', reversed: 'Self-doubt, inner critic, ignoring the call' },
      { name: 'The World', meaning: 'Completion, accomplishment, travel, achievement', reversed: 'Seeking personal closure, short-cuts' }
    ];

    if (spread === 'single') {
      const card = tarotCards[Math.floor(Math.random() * tarotCards.length)];
      const isReversed = Math.random() > 0.5;

      const embed = new EmbedBuilder()
        .setColor('#9B59B6')
        .setTitle(`🃏 ${card.name}${isReversed ? ' (Reversed)' : ''}`)
        .setDescription(isReversed ? card.reversed : card.meaning)
        .setFooter({ text: 'Meditate on this card\'s message' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });

    } else if (spread === 'three') {
      const drawn = [];
      const available = [...tarotCards];

      for (let i = 0; i < 3; i++) {
        const index = Math.floor(Math.random() * available.length);
        const card = available.splice(index, 1)[0];
        const isReversed = Math.random() > 0.5;
        drawn.push({ ...card, isReversed });
      }

      const positions = ['Past', 'Present', 'Future'];

      const embed = new EmbedBuilder()
        .setColor('#9B59B6')
        .setTitle('🃏 Three Card Tarot Spread')
        .setDescription('Past, Present, Future')
        .setFooter({ text: 'Reflect on the journey these cards reveal' })
        .setTimestamp();

      drawn.forEach((card, index) => {
        embed.addFields({
          name: `${positions[index]}: ${card.name}${card.isReversed ? ' (Reversed)' : ''}`,
          value: card.isReversed ? card.reversed : card.meaning,
          inline: false
        });
      });

      return interaction.editReply({ embeds: [embed] });
    }
  },

  async fortuneHoroscope(interaction) {
    const sign = interaction.options.getString('sign');

    const horoscopes = {
      general: [
        'Today brings opportunities for growth and self-discovery.',
        'Your energy is high - use it wisely and productively.',
        'A conversation today could lead to exciting possibilities.',
        'Focus on your goals and don\'t let distractions derail you.',
        'Someone close to you needs your support today.',
        'Trust your intuition when making important decisions.',
        'Financial matters require your attention today.',
        'Creative projects will flow easily for you now.',
        'It\'s a good day to reconnect with old friends.',
        'Pay attention to your health and well-being today.'
      ],
      love: [
        'Romance is in the air for you today.',
        'Communication is key in your relationships right now.',
        'A surprise could brighten your love life.',
        'Take time to show appreciation for your loved ones.',
        'Singles may meet someone interesting today.'
      ],
      career: [
        'Professional recognition may come your way.',
        'Collaboration with others will lead to success.',
        'It\'s a good time to pursue new opportunities.',
        'Your hard work is about to pay off.',
        'Consider taking on new responsibilities.'
      ]
    };

    const today = new Date().toDateString();
    const seed = sign.charCodeAt(0) + today.split('').reduce((a, b) => a + b.charCodeAt(0), 0);

    const generalIndex = seed % horoscopes.general.length;
    const loveIndex = (seed + 1) % horoscopes.love.length;
    const careerIndex = (seed + 2) % horoscopes.career.length;

    const signEmojis = {
      aries: '♈', taurus: '♉', gemini: '♊', cancer: '♋',
      leo: '♌', virgo: '♍', libra: '♎', scorpio: '♏',
      sagittarius: '♐', capricorn: '♑', aquarius: '♒', pisces: '♓'
    };

    const embed = new EmbedBuilder()
      .setColor('#E74C3C')
      .setTitle(`${signEmojis[sign]} ${sign.charAt(0).toUpperCase() + sign.slice(1)} Horoscope`)
      .addFields(
        { name: '✨ General', value: horoscopes.general[generalIndex] },
        { name: '💕 Love', value: horoscopes.love[loveIndex] },
        { name: '💼 Career', value: horoscopes.career[careerIndex] }
      )
      .setFooter({ text: 'Daily horoscope • Come back tomorrow!' })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  },

  async fortuneLucky(interaction) {
    const userId = interaction.user.id;
    const today = new Date().toDateString();
    const seed = parseInt(userId) + today.split('').reduce((a, b) => a + b.charCodeAt(0), 0);

    const luckyNumbers = [];
    let currentSeed = seed;

    for (let i = 0; i < 6; i++) {
      currentSeed = (currentSeed * 1103515245 + 12345) & 0x7fffffff;
      luckyNumbers.push((currentSeed % 50) + 1);
    }

    const embed = new EmbedBuilder()
      .setColor('#2ECC71')
      .setTitle('🍀 Your Lucky Numbers')
      .setDescription(`**${luckyNumbers.join(', ')}**`)
      .addFields(
        { name: 'Lucky Color', value: ['Red', 'Blue', 'Green', 'Purple', 'Gold', 'Silver', 'Orange', 'Pink'][seed % 8], inline: true },
        { name: 'Lucky Time', value: ['Morning', 'Afternoon', 'Evening', 'Night'][seed % 4], inline: true }
      )
      .setFooter({ text: 'Use these numbers wisely! • Generated daily' })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  },

  // ==================== URBAN GROUP ====================
  async handleUrban(interaction, subcommand) {
    await interaction.deferReply();

    try {
      switch (subcommand) {
        case 'define':
          return await this.urbanDefine(interaction);
        case 'random':
          return await this.urbanRandom(interaction);
      }
    } catch (error) {
      console.error('[Urban Error]', error);
      return interaction.editReply({
        content: '❌ An error occurred while processing your Urban Dictionary request.',
        ephemeral: true
      });
    }
  },

  async urbanDefine(interaction) {
    const term = interaction.options.getString('term');

    try {
      const response = await axios.get(`https://api.urbandictionary.com/v0/define`, {
        params: { term },
        timeout: 10000
      });

      if (!response.data.list || response.data.list.length === 0) {
        return interaction.editReply({
          content: `❌ No definition found for "${term}".`
        });
      }

      const definition = response.data.list[0];

      const cleanText = (text) => text.replace(/\[|\]/g, '');

      const maxLength = 1024;
      let def = cleanText(definition.definition);
      let example = cleanText(definition.example);

      if (def.length > maxLength) {
        def = def.substring(0, maxLength - 3) + '...';
      }

      if (example.length > maxLength) {
        example = example.substring(0, maxLength - 3) + '...';
      }

      const embed = new EmbedBuilder()
        .setColor('#1D2439')
        .setTitle(`📖 ${definition.word}`)
        .setURL(definition.permalink)
        .setDescription(def)
        .setFooter({
          text: `👍 ${definition.thumbs_up} | 👎 ${definition.thumbs_down} | By ${definition.author}`
        })
        .setTimestamp(new Date(definition.written_on));

      if (example) {
        embed.addFields({ name: 'Example', value: example });
      }

      return interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('[Urban Define Error]', error);
      return interaction.editReply({
        content: '❌ Failed to fetch definition. Please try again later.'
      });
    }
  },

  async urbanRandom(interaction) {
    try {
      const response = await axios.get('https://api.urbandictionary.com/v0/random', {
        timeout: 10000
      });

      if (!response.data.list || response.data.list.length === 0) {
        return interaction.editReply({
          content: '❌ Failed to fetch random definition.'
        });
      }

      const definition = response.data.list[0];

      const cleanText = (text) => text.replace(/\[|\]/g, '');

      const maxLength = 1024;
      let def = cleanText(definition.definition);
      let example = cleanText(definition.example);

      if (def.length > maxLength) {
        def = def.substring(0, maxLength - 3) + '...';
      }

      if (example.length > maxLength) {
        example = example.substring(0, maxLength - 3) + '...';
      }

      const embed = new EmbedBuilder()
        .setColor('#1D2439')
        .setTitle(`📖 ${definition.word}`)
        .setURL(definition.permalink)
        .setDescription(def)
        .setFooter({
          text: `👍 ${definition.thumbs_up} | 👎 ${definition.thumbs_down} | By ${definition.author}`
        })
        .setTimestamp(new Date(definition.written_on));

      if (example) {
        embed.addFields({ name: 'Example', value: example });
      }

      return interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('[Urban Random Error]', error);
      return interaction.editReply({
        content: '❌ Failed to fetch random definition. Please try again later.'
      });
    }
  },

  // ==================== INSPIRE GROUP ====================
  async handleInspire(interaction, subcommand) {
    try {
      switch (subcommand) {
        case 'quote':
          return await this.inspireQuote(interaction);
        case 'fact':
          return await this.inspireFact(interaction);
        case 'compliment':
          return await this.inspireCompliment(interaction);
        case 'affirmation':
          return await this.inspireAffirmation(interaction);
        case 'advice':
          return await this.inspireAdvice(interaction);
      }
    } catch (error) {
      console.error('[Inspire Error]', error);
      const method = interaction.deferred ? 'editReply' : 'reply';
      return interaction[method]({
        content: '❌ Failed to fetch inspiration. Please try again later.',
        ephemeral: true
      });
    }
  },

  async inspireQuote(interaction) {
    await interaction.deferReply();

    try {
      const response = await axios.get('https://zenquotes.io/api/random', {
        timeout: 10000
      });

      const quoteData = response.data[0];

      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('✨ Inspirational Quote')
        .setDescription(`*"${quoteData.q}"*`)
        .addFields({
          name: '👤 Author',
          value: quoteData.a || 'Unknown',
          inline: true
        })
        .setFooter({ text: 'Powered by ZenQuotes' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('[Quote Error]', error);

      const fallbackQuotes = [
        { text: 'The only way to do great work is to love what you do.', author: 'Steve Jobs' },
        { text: 'Believe you can and you\'re halfway there.', author: 'Theodore Roosevelt' },
        { text: 'It always seems impossible until it\'s done.', author: 'Nelson Mandela' },
        { text: 'The future belongs to those who believe in the beauty of their dreams.', author: 'Eleanor Roosevelt' },
        { text: 'Success is not final, failure is not fatal: it is the courage to continue that counts.', author: 'Winston Churchill' },
        { text: 'The only impossible journey is the one you never begin.', author: 'Tony Robbins' },
        { text: 'Your time is limited, don\'t waste it living someone else\'s life.', author: 'Steve Jobs' },
        { text: 'Whether you think you can or you think you can\'t, you\'re right.', author: 'Henry Ford' },
        { text: 'The best time to plant a tree was 20 years ago. The second best time is now.', author: 'Chinese Proverb' },
        { text: 'Don\'t watch the clock; do what it does. Keep going.', author: 'Sam Levenson' }
      ];

      const quote = fallbackQuotes[Math.floor(Math.random() * fallbackQuotes.length)];

      const embed = new EmbedBuilder()
        .setColor('#FFD700')
        .setTitle('✨ Inspirational Quote')
        .setDescription(`*"${quote.text}"*`)
        .addFields({
          name: '👤 Author',
          value: quote.author,
          inline: true
        })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }
  },

  async inspireFact(interaction) {
    await interaction.deferReply();

    const category = interaction.options.getString('category') || 'random';

    const facts = this.getInspireFacts(category);
    const fact = facts[Math.floor(Math.random() * facts.length)];

    const categoryEmojis = {
      random: '🎲',
      science: '🔬',
      animals: '🦁',
      space: '🌌',
      history: '📜'
    };

    const embed = new EmbedBuilder()
      .setColor('#9C27B0')
      .setTitle(`${categoryEmojis[category]} Interesting Fact`)
      .setDescription(fact)
      .addFields({
        name: '📚 Category',
        value: category.charAt(0).toUpperCase() + category.slice(1),
        inline: true
      })
      .setFooter({ text: 'Learn something new every day!' })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  },

  getInspireFacts(category) {
    const factCollections = {
      science: [
        'The speed of light is exactly 299,792,458 meters per second.',
        'Water can exist in three states at the same time, known as the triple point.',
        'A single bolt of lightning contains enough energy to toast 100,000 slices of bread.',
        'Honey never spoils. Archaeologists have found 3,000-year-old honey in Egyptian tombs that was still edible.',
        'The human brain uses 20% of the body\'s energy despite being only 2% of its mass.',
        'Diamond and graphite are both made of carbon, but have completely different structures.',
        'Sound travels 4.3 times faster in water than in air.',
        'The Earth\'s core is as hot as the surface of the sun.',
        'A teaspoon of neutron star material would weigh about 6 billion tons.',
        'Bananas are radioactive due to their potassium content.'
      ],
      animals: [
        'Octopuses have three hearts and blue blood.',
        'A group of flamingos is called a "flamboyance".',
        'Dolphins have names for each other.',
        'Elephants can\'t jump - they\'re the only mammal that can\'t.',
        'A snail can sleep for three years.',
        'Butterflies taste with their feet.',
        'A shrimp\'s heart is in its head.',
        'Sea otters hold hands while sleeping to avoid drifting apart.',
        'Cows have best friends and get stressed when separated.',
        'Ravens can learn to mimic human speech better than some parrots.'
      ],
      space: [
        'There are more stars in the universe than grains of sand on all Earth\'s beaches.',
        'A day on Venus is longer than its year.',
        'The footprints on the Moon will be there for 100 million years.',
        'Jupiter\'s Great Red Spot is a storm that has been raging for at least 400 years.',
        'Saturn\'s moon Titan has lakes, rivers, and seas of liquid methane.',
        'One million Earths could fit inside the Sun.',
        'The International Space Station travels at 17,500 mph.',
        'There\'s a planet made of diamond twice the size of Earth.',
        'Space is completely silent because there\'s no atmosphere for sound to travel.',
        'Neutron stars can spin 600 times per second.'
      ],
      history: [
        'Cleopatra lived closer in time to the Moon landing than to the construction of the Great Pyramid.',
        'Oxford University is older than the Aztec Empire.',
        'The Great Wall of China took over 1,800 years to build.',
        'The shortest war in history lasted 38 minutes (Anglo-Zanzibar War, 1896).',
        'Ancient Egyptians used slabs of stone as pillows.',
        'The first computer programmer was a woman: Ada Lovelace (1815-1852).',
        'Nintendo was founded in 1889 as a playing card company.',
        'The first email was sent in 1971 by Ray Tomlinson.',
        'The Library of Alexandria was destroyed over several incidents, not just one fire.',
        'Vikings never actually wore horned helmets - that\'s a myth from the 19th century.'
      ]
    };

    const allFacts = [
      ...factCollections.science,
      ...factCollections.animals,
      ...factCollections.space,
      ...factCollections.history
    ];

    return category === 'random' ? allFacts : (factCollections[category] || allFacts);
  },

  async inspireCompliment(interaction) {
    const targetUser = interaction.options.getUser('user');

    const compliments = [
      'You have a great sense of humor!',
      'Your positive energy is contagious!',
      'You bring out the best in people!',
      'You have excellent taste!',
      'You\'re incredibly thoughtful!',
      'Your creativity knows no bounds!',
      'You make difficult things look easy!',
      'You have impeccable timing!',
      'Your smile is infectious!',
      'You\'re a great listener!',
      'You have a unique perspective!',
      'You inspire others around you!',
      'Your kindness is a balm to all who encounter it!',
      'You\'re even better than a unicorn!',
      'You could survive a zombie apocalypse!',
      'Your presence lights up the room!',
      'You\'re someone\'s reason to smile!',
      'You make the world a better place!',
      'Your potential is limitless!',
      'You\'re braver than you believe!'
    ];

    const compliment = compliments[Math.floor(Math.random() * compliments.length)];

    const embed = new EmbedBuilder()
      .setColor('#FF69B4')
      .setTitle('💝 Compliment')
      .setDescription(targetUser ? `${targetUser}, ${compliment}` : compliment)
      .setFooter({ text: 'Spread positivity! 💕' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },

  async inspireAffirmation(interaction) {
    const affirmations = [
      'I am capable of achieving great things.',
      'I choose to be happy and grateful today.',
      'I am worthy of love and respect.',
      'I trust in my ability to overcome challenges.',
      'I am growing and learning every day.',
      'I embrace change and welcome new opportunities.',
      'I am confident in my decisions.',
      'I deserve success and happiness.',
      'I am surrounded by love and support.',
      'I have the power to create positive change.',
      'I am enough, just as I am.',
      'I choose progress over perfection.',
      'I am resilient, strong, and brave.',
      'I trust the journey, even when I don\'t understand it.',
      'I am creating the life I want to live.',
      'I release what I cannot control.',
      'I am proud of how far I\'ve come.',
      'I attract positive energy and abundance.',
      'I am deserving of all good things.',
      'I choose to see the good in every situation.'
    ];

    const affirmation = affirmations[Math.floor(Math.random() * affirmations.length)];

    const embed = new EmbedBuilder()
      .setColor('#00BCD4')
      .setTitle('🌟 Daily Affirmation')
      .setDescription(`*${affirmation}*`)
      .setFooter({ text: 'Repeat this to yourself throughout the day' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  },

  async inspireAdvice(interaction) {
    await interaction.deferReply();

    try {
      const response = await axios.get('https://api.adviceslip.com/advice', {
        timeout: 10000
      });

      const advice = response.data.slip.advice;

      const embed = new EmbedBuilder()
        .setColor('#FFC107')
        .setTitle('💡 Random Advice')
        .setDescription(advice)
        .setFooter({ text: 'Powered by Advice Slip API' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('[Advice Error]', error);

      const fallbackAdvice = [
        'Take time to reflect on your goals regularly.',
        'Don\'t be afraid to ask for help when you need it.',
        'Practice gratitude daily.',
        'Learn something new every day.',
        'Take care of your mental health.',
        'Surround yourself with positive people.',
        'Don\'t compare your journey to others.',
        'Save money for unexpected expenses.',
        'Exercise regularly, even if just a little.',
        'Read more books.',
        'Listen more than you speak.',
        'Be kind to yourself and others.',
        'Take breaks when you need them.',
        'Celebrate small victories.',
        'Stay curious and keep learning.'
      ];

      const advice = fallbackAdvice[Math.floor(Math.random() * fallbackAdvice.length)];

      const embed = new EmbedBuilder()
        .setColor('#FFC107')
        .setTitle('💡 Random Advice')
        .setDescription(advice)
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }
  },

  // ==================== JOKES GROUP ====================
  async handleJokes(interaction, subcommand) {
    await interaction.deferReply();

    try {
      let joke, jokeTitle, jokeColor;

      switch (subcommand) {
        case 'dad': {
          const response = await axios.get('https://icanhazdadjoke.com/', {
            headers: { 'Accept': 'application/json' },
            timeout: 5000
          });
          joke = response.data.joke;
          jokeTitle = '👨 Dad Joke';
          jokeColor = '#F39C12';
          break;
        }

        case 'chucknorris': {
          const category = interaction.options.getString('category');
          let url = 'https://api.chucknorris.io/jokes/random';

          if (category && category !== 'random') {
            url += `?category=${category}`;
          }

          const response = await axios.get(url, { timeout: 5000 });
          joke = response.data.value;
          jokeTitle = '🥋 Chuck Norris Joke';
          jokeColor = '#E74C3C';
          break;
        }

        case 'programming': {
          const response = await axios.get('https://official-joke-api.appspot.com/jokes/programming/random', {
            timeout: 5000
          });
          const jokeData = response.data[0];
          joke = `${jokeData.setup}\n\n||${jokeData.punchline}||`;
          jokeTitle = '💻 Programming Joke';
          jokeColor = '#3498DB';
          break;
        }

        case 'general': {
          const response = await axios.get('https://official-joke-api.appspot.com/random_joke', {
            timeout: 5000
          });
          joke = `${response.data.setup}\n\n||${response.data.punchline}||`;
          jokeTitle = '😄 General Joke';
          jokeColor = '#9B59B6';
          break;
        }
      }

      const embed = new EmbedBuilder()
        .setColor(jokeColor)
        .setTitle(jokeTitle)
        .setDescription(joke)
        .setFooter({ text: 'Click the spoiler to reveal the punchline!' })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('[Jokes Error]', error);
      return interaction.editReply({
        content: '❌ Failed to fetch joke. Please try again later.',
        ephemeral: true
      });
    }
  }
};
