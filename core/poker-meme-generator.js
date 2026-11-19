import { EmbedBuilder } from 'discord.js';
import logger from '../utils/logger.js';
import { accessibleAttachment } from '../utils/accessible-attachment.js';
import { themeColor } from './guild-theme.js';
import { fetchSubredditPosts } from '../utils/reddit.js';

let Canvas, loadImage;
try {
  const canvasModule = await import('canvas');
  Canvas = canvasModule.default || canvasModule;
  loadImage = Canvas.loadImage;
  // Register fonts if available
  if (Canvas.registerFont) {
    try {
      Canvas.registerFont('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', { family: 'Impact' });
    } catch (e) {
      // Font registration failed, will use default
    }
  }
} catch (e) {
  logger.warn('[PokerMemeGenerator] Canvas module not available');
}

// Popular meme template URLs (using imgflip's common templates)
const MEME_TEMPLATES = {
  drake: {
    url: 'https://i.imgflip.com/30b1gx.jpg',
    width: 600,
    height: 600,
    textAreas: [
      { x: 300, y: 75, width: 280, height: 150, align: 'center' },  // Top right - "no"
      { x: 300, y: 375, width: 280, height: 150, align: 'center' }  // Bottom right - "yes"
    ],
    type: 'two-panel'
  },
  distracted: {
    url: 'https://i.imgflip.com/1ur9b0.jpg',
    width: 800,
    height: 533,
    textAreas: [
      { x: 640, y: 400, width: 150, height: 100, align: 'center', label: 'distraction' },
      { x: 450, y: 50, width: 200, height: 80, align: 'center', label: 'boyfriend' },
      { x: 150, y: 400, width: 150, height: 100, align: 'center', label: 'girlfriend' }
    ],
    type: 'labeled'
  },
  twoButtons: {
    url: 'https://i.imgflip.com/1g8my4.jpg',
    width: 600,
    height: 908,
    textAreas: [
      { x: 110, y: 100, width: 180, height: 120, align: 'center' },  // Left button
      { x: 370, y: 100, width: 180, height: 120, align: 'center' }   // Right button
    ],
    type: 'two-panel'
  },
  changeMyMind: {
    url: 'https://i.imgflip.com/24y43o.jpg',
    width: 600,
    height: 450,
    textAreas: [
      { x: 300, y: 380, width: 350, height: 60, align: 'center' }
    ],
    type: 'single'
  },
  exitRamp: {
    url: 'https://i.imgflip.com/22bdq6.jpg',
    width: 600,
    height: 519,
    textAreas: [
      { x: 150, y: 80, width: 200, height: 60, align: 'center' },   // Straight road label
      { x: 490, y: 120, width: 180, height: 50, align: 'center' },  // Exit label
      { x: 200, y: 450, width: 250, height: 50, align: 'center' }   // Car label
    ],
    type: 'labeled'
  },
  galaxyBrain: {
    url: 'https://i.imgflip.com/2fzchc.jpg',
    width: 600,
    height: 1000,
    textAreas: [
      { x: 150, y: 50, width: 280, height: 60, align: 'left' },
      { x: 150, y: 300, width: 280, height: 60, align: 'left' },
      { x: 150, y: 550, width: 280, height: 60, align: 'left' },
      { x: 150, y: 800, width: 280, height: 60, align: 'left' }
    ],
    type: 'progression'
  },
  thisIsFine: {
    url: 'https://i.imgflip.com/wxica.jpg',
    width: 580,
    height: 282,
    textAreas: [
      { x: 290, y: 30, width: 500, height: 50, align: 'center' }
    ],
    type: 'single'
  },
  waiting: {
    url: 'https://i.imgflip.com/2bwp4s.jpg',
    width: 500,
    height: 418,
    textAreas: [
      { x: 250, y: 380, width: 450, height: 50, align: 'center' }
    ],
    type: 'single'
  }
};

// Poker-themed content generators
const POKER_SCENARIOS = {
  drake: [
    { top: 'Folding pocket aces preflop', bottom: 'Going all-in with 7-2 offsuit' },
    { top: 'Playing tight and patient', bottom: 'Chasing every flush draw' },
    { top: 'Studying hand ranges', bottom: 'Trusting your gut feeling' },
    { top: 'Proper bankroll management', bottom: 'Yolo-ing your rent money' },
    { top: 'Reading pot odds', bottom: 'I have a feeling about this one' },
    { top: 'Position awareness', bottom: 'Cards look good, I call' },
    { top: 'Taking a break when tilted', bottom: 'Playing 10 more hours to get even' },
    { top: 'Folding to the 4-bet', bottom: 'They must be bluffing again' },
    { top: 'Small ball poker', bottom: 'Every hand is an all-in hand' },
    { top: 'Value betting thin', bottom: 'Check-calling with the nuts' }
  ],
  twoButtons: [
    { left: 'Fold and save chips', right: 'Call and pray' },
    { left: 'Play premium hands', right: 'Any two cards can win' },
    { left: 'Respect the raise', right: 'Hero call with ace high' },
    { left: 'Quit while ahead', right: 'Let it ride' },
    { left: 'Study GTO', right: 'Trust the vibes' }
  ],
  changeMyMind: [
    'Poker is 100% skill, the cards are just suggestions',
    'Limping UTG with suited connectors is a perfectly valid strategy',
    'Checking the nuts on the river is just next level thinking',
    'You can\'t lose if you never fold',
    'Pocket jacks are the best hand in poker',
    'Online poker is definitely rigged against me specifically',
    'Telling people about your bad beats makes you a better player',
    'Sunglasses at the table make you 50% better at bluffing',
    'The dealer is always out to get you',
    'Slow rolling is just building suspense'
  ],
  thisIsFine: [
    'Me watching my flush draw miss on the river',
    'Down 10 buy-ins but it\'s still early',
    'Getting sucked out on for the 5th time tonight',
    'My bankroll after a "quick session"',
    'Playing pocket kings against an ace on the board',
    'Calling station hitting their gutshot again'
  ],
  exitRamp: [
    { straight: 'Sensible fold', exit: 'Hero call', car: 'Me with middle pair' },
    { straight: 'Playing within bankroll', exit: 'Shot taking at higher stakes', car: 'My degenerate brain' },
    { straight: 'Good night\'s sleep', exit: 'One more orbit', car: 'Every poker player at 3am' }
  ],
  waiting: [
    'Still waiting for my pocket aces to hold up',
    'Me waiting for the fish to reload',
    'Waiting for variance to even out',
    'Me watching the bubble boy bust',
    'Waiting for my big blind to come around again'
  ]
};

export default class PokerMemeGenerator {
  // One warning per process, not one per scheduled post.
  static warnedNsfwUnavailable = false;

  static warnNsfwUnavailable() {
    if (PokerMemeGenerator.warnedNsfwUnavailable) return;
    PokerMemeGenerator.warnedNsfwUnavailable = true;
    logger.warn('[PokerMemeGenerator] Skipping Reddit content: the public feed carries no NSFW flag. ' +
      'Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET to re-enable.');
  }

  constructor(client) {
    this.client = client;
  }

  /**
   * Generate a meme image using canvas
   */
  async generateMeme(templateName, texts) {
    if (!Canvas) {
      logger.error('[PokerMemeGenerator] Canvas not available');
      return null;
    }

    const template = MEME_TEMPLATES[templateName];
    if (!template) {
      logger.error(`[PokerMemeGenerator] Template ${templateName} not found`);
      return null;
    }

    try {
      // Load the template image
      const image = await loadImage(template.url);

      // Create canvas
      const canvas = Canvas.createCanvas(template.width, template.height);
      const ctx = canvas.getContext('2d');

      // Draw base image
      ctx.drawImage(image, 0, 0, template.width, template.height);

      // Add text to each area
      for (let i = 0; i < template.textAreas.length && i < texts.length; i++) {
        const area = template.textAreas[i];
        const text = texts[i];

        if (text) {
          this.drawMemeText(ctx, text, area);
        }
      }

      // Convert to buffer
      return canvas.toBuffer('image/png');

    } catch (error) {
      logger.error('[PokerMemeGenerator] Error generating meme', {
        error: error.message,
        template: templateName
      });
      return null;
    }
  }

  /**
   * Draw text with meme-style formatting
   */
  drawMemeText(ctx, text, area) {
    const { x, y, width, height, align } = area;

    // Calculate font size to fit
    let fontSize = 32;
    ctx.font = `bold ${fontSize}px Impact, Arial Black, sans-serif`;

    // Reduce font size until text fits
    while (ctx.measureText(text).width > width && fontSize > 12) {
      fontSize -= 2;
      ctx.font = `bold ${fontSize}px Impact, Arial Black, sans-serif`;
    }

    // Word wrap if still too long
    const words = text.split(' ');
    const lines = [];
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      if (ctx.measureText(testLine).width > width) {
        if (currentLine) {
          lines.push(currentLine);
          currentLine = word;
        } else {
          lines.push(word);
        }
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine) {
      lines.push(currentLine);
    }

    // Draw each line
    ctx.textAlign = align || 'center';
    ctx.textBaseline = 'middle';

    const lineHeight = fontSize * 1.2;
    const startY = y - ((lines.length - 1) * lineHeight) / 2;

    for (let i = 0; i < lines.length; i++) {
      const lineY = startY + (i * lineHeight);

      // Draw black outline
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 4;
      ctx.strokeText(lines[i], x, lineY);

      // Draw white fill
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(lines[i], x, lineY);
    }
  }

  /**
   * Get random poker content for Reddit
   */
  async fetchPokerContent() {
    const subreddits = ['poker', 'pokermemes'];
    const subreddit = subreddits[Math.floor(Math.random() * subreddits.length)];

    try {
      // Reddit 403s unauthenticated `hot.json` now — utils/reddit.js picks OAuth or
      // the public Atom feed. Without OAuth there's no NSFW flag, and these titles get
      // rendered onto images posted into guild channels, so decline rather than guess.
      const { posts: fetched, nsfwKnown } = await fetchSubredditPosts(subreddit, {
        sort: 'hot', limit: 50
      });

      if (!nsfwKnown) {
        PokerMemeGenerator.warnNsfwUnavailable();
        return [];
      }

      return fetched
        .filter(post =>
          !post.isStickied &&
          !post.isNsfw &&
          post.title.length > 10 &&
          post.title.length < 200
        )
        .map(post => ({
          title: post.title,
          selftext: post.selftext,
          score: post.score,
          id: post.id
        }));
    } catch (error) {
      logger.error('[PokerMemeGenerator] Error fetching poker content', { error: error.message });
      return [];
    }
  }

  /**
   * Generate a random poker meme
   */
  async generateRandomPokerMeme() {
    // Decide: use pre-made scenarios or Reddit content
    const useReddit = Math.random() < 0.3; // 30% chance to try Reddit titles

    let templateName, texts;

    if (useReddit) {
      const redditPosts = await this.fetchPokerContent();
      if (redditPosts.length > 0) {
        const post = redditPosts[Math.floor(Math.random() * redditPosts.length)];
        // Use Reddit title with "this is fine" or "change my mind" template
        const simpleTemplates = ['thisIsFine', 'changeMyMind'];
        templateName = simpleTemplates[Math.floor(Math.random() * simpleTemplates.length)];
        texts = [post.title];
      }
    }

    // Fall back to pre-made scenarios
    if (!templateName) {
      const templates = Object.keys(POKER_SCENARIOS);
      templateName = templates[Math.floor(Math.random() * templates.length)];
      const scenarios = POKER_SCENARIOS[templateName];
      const scenario = scenarios[Math.floor(Math.random() * scenarios.length)];

      // Convert scenario to text array based on template type
      if (typeof scenario === 'string') {
        texts = [scenario];
      } else if (scenario.top && scenario.bottom) {
        texts = [scenario.top, scenario.bottom];
      } else if (scenario.left && scenario.right) {
        texts = [scenario.left, scenario.right];
      } else if (scenario.straight && scenario.exit && scenario.car) {
        texts = [scenario.straight, scenario.exit, scenario.car];
      } else {
        texts = Object.values(scenario);
      }
    }

    // Generate the meme image
    const buffer = await this.generateMeme(templateName, texts);

    return {
      buffer,
      templateName,
      texts
    };
  }

  /**
   * Post a generated poker meme to a channel
   */
  async postPokerMeme(guildId, channelId) {
    try {
      const guild = this.client.guilds.cache.get(guildId);
      if (!guild) {
        logger.warn(`[PokerMemeGenerator] Guild ${guildId} not found`);
        return false;
      }

      const channel = guild.channels.cache.get(channelId);
      if (!channel || !channel.isTextBased()) {
        logger.warn(`[PokerMemeGenerator] Channel ${channelId} not found or not text-based`);
        return false;
      }

      const meme = await this.generateRandomPokerMeme();

      if (!meme || !meme.buffer) {
        // Fallback: post a meme from r/pokermemes
        logger.info('[PokerMemeGenerator] Falling back to Reddit meme');
        return await this.postRedditPokerMeme(guildId, channelId);
      }

      // generateRandomPokerMeme hands back the exact caption lines it burned
      // into the image, which is the only part a screen reader cannot reach.
      const captions = (meme.texts || []).filter(Boolean).join(' — ');
      const attachment = accessibleAttachment(meme.buffer, {
        name: 'poker-meme.png',
        description: captions
          ? `Poker meme (${meme.templateName}): ${captions}`
          : `Poker meme (${meme.templateName}).`,
      });

      const embed = new EmbedBuilder()
        .setColor(themeColor(guildId, 'success')) // Poker green
        .setTitle('Daily Poker Meme')
        .setImage('attachment://poker-meme.png')
        .setFooter({ text: 'Generated for Flying Sharks' })
        .setTimestamp();

      await channel.send({ embeds: [embed], files: [attachment] });

      logger.info(`[PokerMemeGenerator] Posted poker meme to guild ${guildId}, channel ${channelId}`);
      return true;

    } catch (error) {
      logger.error('[PokerMemeGenerator] Error posting poker meme', {
        error: error.message,
        guildId,
        channelId
      });
      return false;
    }
  }

  /**
   * Fallback: post an existing meme from poker subreddits
   */
  async postRedditPokerMeme(guildId, channelId) {
    try {
      const guild = this.client.guilds.cache.get(guildId);
      const channel = guild?.channels.cache.get(channelId);

      if (!channel) return false;

      const subreddits = ['pokermemes', 'poker'];
      const subreddit = subreddits[Math.floor(Math.random() * subreddits.length)];

      const { posts: fetched, nsfwKnown } = await fetchSubredditPosts(subreddit, {
        sort: 'hot', limit: 50
      });

      // Same reasoning as fetchPokerContent: no NSFW flag means no posting.
      if (!nsfwKnown) {
        PokerMemeGenerator.warnNsfwUnavailable();
        return false;
      }

      const posts = fetched.filter(post => !post.isStickied && !post.isNsfw && post.isImage);

      if (posts.length === 0) return false;

      const meme = posts[Math.floor(Math.random() * posts.length)];

      const embed = new EmbedBuilder()
        .setColor('#FF4500')
        .setTitle(meme.title.length > 256 ? meme.title.substring(0, 253) + '...' : meme.title)
        .setURL(meme.permalink)
        .setImage(meme.mediaUrl)
        .setFooter({ text: `r/${subreddit} • Daily Poker Meme` })
        .setTimestamp();

      await channel.send({ embeds: [embed] });

      logger.info(`[PokerMemeGenerator] Posted Reddit poker meme to guild ${guildId}`);
      return true;

    } catch (error) {
      logger.error('[PokerMemeGenerator] Error posting Reddit poker meme', { error: error.message });
      return false;
    }
  }
}
