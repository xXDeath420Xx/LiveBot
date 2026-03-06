import 'dotenv/config';
import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { writeFile } from 'fs/promises';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '877253051994501130';
const BOT_ID = '1473622894138491007';
const OUTPUT_PATH = '/home/death/CertiFriedUtility/scripts/cafe-integrations-audit.json';

// Channels to audit
const CHANNELS = {
  reactRoles:    '904428293846098011',  // 😎┊react-roles
  welcome:       '877253668133552240',  // 👋┊welcome
  rules:         '877254515244552232',  // 📄┊rules
  announcements: '877254930585518161',  // 📢┊announcements
  cruciIsLive:   '1249719945286385746', // cruci-is-live
  leveling:      '919349483874181190',  // 🏆┊leveling
};

const KNOWN_BOT_IDS = {
  '159985870458322944': 'MEE6',
  '155149108183695360': 'Dyno',
  '375805687529209857': 'Streamcord',
  '235148962103951360': 'Carl-bot',
  '292953664492929025': 'ProBot',
};

function identifyBot(author) {
  if (!author) return null;
  if (!author.bot) return null;
  const known = KNOWN_BOT_IDS[author.id];
  if (known) return known;
  // Fuzzy match on username
  const name = (author.username || author.tag || '').toLowerCase();
  for (const botName of ['mee6', 'dyno', 'streamcord', 'carl', 'probot']) {
    if (name.includes(botName)) return botName.charAt(0).toUpperCase() + botName.slice(1);
  }
  return author.bot ? `Unknown Bot (${author.username || author.id})` : null;
}

function serializeEmbed(embed) {
  return {
    title: embed.title || null,
    description: embed.description ? embed.description.substring(0, 500) : null,
    color: embed.color,
    author: embed.author ? { name: embed.author.name, iconURL: embed.author.iconURL } : null,
    footer: embed.footer ? { text: embed.footer.text } : null,
    fields: embed.fields?.map(f => ({ name: f.name, value: f.value.substring(0, 200) })) || [],
    image: embed.image?.url || null,
    thumbnail: embed.thumbnail?.url || null,
  };
}

function serializeMessage(msg) {
  return {
    id: msg.id,
    author: {
      id: msg.author.id,
      username: msg.author.username,
      tag: msg.author.tag,
      bot: msg.author.bot,
      identifiedAs: identifyBot(msg.author),
    },
    content: msg.content ? msg.content.substring(0, 1000) : null,
    embeds: msg.embeds.map(serializeEmbed),
    reactions: [],
    timestamp: msg.createdAt.toISOString(),
    components: msg.components?.length || 0,
  };
}

async function fetchChannelMessages(guild, channelId, limit = 50) {
  try {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) {
      return { error: `Channel ${channelId} not found or inaccessible` };
    }
    if (!channel.isTextBased()) {
      return { error: `Channel ${channel.name} is not text-based (type: ${channel.type})` };
    }

    const messages = await channel.messages.fetch({ limit });
    const results = [];

    for (const [, msg] of messages) {
      const serialized = serializeMessage(msg);

      // Fetch reactions with user info
      if (msg.reactions.cache.size > 0) {
        for (const [, reaction] of msg.reactions.cache) {
          const emoji = reaction.emoji;
          serialized.reactions.push({
            emoji: emoji.id ? `<:${emoji.name}:${emoji.id}>` : emoji.name,
            emojiName: emoji.name,
            emojiId: emoji.id || null,
            count: reaction.count,
          });
        }
      }

      results.push(serialized);
    }

    return {
      channelName: channel.name,
      channelId: channel.id,
      messageCount: results.length,
      messages: results,
    };
  } catch (err) {
    return { error: `Failed to fetch channel ${channelId}: ${err.message}` };
  }
}

async function main() {
  console.log('[Audit] Starting Cafe Utility integration audit...');

  // 1. Get and decrypt token
  const [bots] = await pool.execute('SELECT bot_token FROM custom_bots WHERE bot_id = ?', [BOT_ID]);
  if (!bots.length) {
    console.error('Bot not found in database');
    process.exit(1);
  }

  let token;
  try {
    token = encryption.decrypt(JSON.parse(bots[0].bot_token));
  } catch {
    token = bots[0].bot_token;
  }

  // 2. Login to Discord
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildWebhooks,
      GatewayIntentBits.AutoModerationConfiguration,
    ],
  });

  await client.login(token);

  await new Promise(resolve => {
    if (client.isReady()) return resolve();
    client.once('ready', resolve);
  });

  console.log(`[Audit] Logged in as ${client.user.tag}`);

  // 3. Fetch guild
  const guild = await client.guilds.fetch(GUILD_ID);
  if (!guild) {
    console.error('Guild not found');
    client.destroy();
    await pool.end();
    process.exit(1);
  }

  console.log(`[Audit] Connected to guild: ${guild.name}`);

  const audit = {
    timestamp: new Date().toISOString(),
    guild: { id: guild.id, name: guild.name, memberCount: guild.memberCount },
    webhooks: [],
    reactRoles: null,
    automodRules: [],
    welcomeChannel: null,
    additionalChannels: {},
  };

  // ============================================================
  // SECTION 1: Fetch ALL webhooks in the guild
  // ============================================================
  console.log('[Audit] Fetching webhooks...');
  try {
    const webhooks = await guild.fetchWebhooks();
    console.log(`[Audit] Found ${webhooks.size} webhooks`);

    for (const [, wh] of webhooks) {
      const channelName = wh.channel?.name || 'unknown';
      let creatorBot = null;
      if (wh.owner) {
        creatorBot = identifyBot(wh.owner) || (wh.owner.bot ? `Bot: ${wh.owner.username}` : `User: ${wh.owner.username}`);
      }

      audit.webhooks.push({
        id: wh.id,
        name: wh.name,
        channelId: wh.channelId,
        channelName,
        type: wh.type,
        creatorId: wh.owner?.id || null,
        creatorBot,
        creatorUsername: wh.owner?.username || null,
        avatar: wh.avatar ? `https://cdn.discordapp.com/avatars/${wh.id}/${wh.avatar}.png` : null,
        token: wh.token ? '[REDACTED]' : null,
      });
    }
  } catch (err) {
    console.error(`[Audit] Webhook fetch error: ${err.message}`);
    audit.webhooks = { error: err.message };
  }

  // ============================================================
  // SECTION 2: React-roles channel - messages with reactions
  // ============================================================
  console.log('[Audit] Fetching react-roles messages...');
  const reactRolesData = await fetchChannelMessages(guild, CHANNELS.reactRoles, 50);
  if (!reactRolesData.error) {
    // Filter to only messages with reactions
    const withReactions = reactRolesData.messages.filter(m => m.reactions.length > 0);
    audit.reactRoles = {
      channelName: reactRolesData.channelName,
      channelId: reactRolesData.channelId,
      totalMessages: reactRolesData.messageCount,
      messagesWithReactions: withReactions.length,
      messages: withReactions,
      allMessages: reactRolesData.messages, // Include all for context
    };
  } else {
    audit.reactRoles = reactRolesData;
  }

  // ============================================================
  // SECTION 3: Automod rules
  // ============================================================
  console.log('[Audit] Fetching automod rules...');
  try {
    const automodRules = await guild.autoModerationRules.fetch();
    console.log(`[Audit] Found ${automodRules.size} automod rules`);

    const triggerTypeNames = {
      1: 'Keyword',
      3: 'Spam',
      4: 'KeywordPreset',
      5: 'MentionSpam',
      6: 'MemberProfile',
    };

    const actionTypeNames = {
      1: 'BlockMessage',
      2: 'SendAlertMessage',
      3: 'Timeout',
      4: 'BlockMemberInteraction',
    };

    for (const [, rule] of automodRules) {
      let creatorInfo = null;
      if (rule.creatorId) {
        try {
          const creator = await guild.members.fetch(rule.creatorId).catch(() => null);
          if (creator) {
            creatorInfo = {
              id: creator.user.id,
              username: creator.user.username,
              tag: creator.user.tag,
              bot: creator.user.bot,
              identifiedAs: identifyBot(creator.user),
            };
          }
        } catch {
          creatorInfo = { id: rule.creatorId, note: 'Could not fetch member' };
        }
      }

      audit.automodRules.push({
        id: rule.id,
        name: rule.name,
        enabled: rule.enabled,
        triggerType: triggerTypeNames[rule.triggerType] || rule.triggerType,
        triggerTypeRaw: rule.triggerType,
        eventType: rule.eventType,
        actions: rule.actions?.map(a => ({
          type: actionTypeNames[a.type] || a.type,
          typeRaw: a.type,
          metadata: a.metadata || null,
        })) || [],
        triggerMetadata: {
          keywordFilter: rule.triggerMetadata?.keywordFilter || [],
          regexPatterns: rule.triggerMetadata?.regexPatterns || [],
          presets: rule.triggerMetadata?.presets || [],
          allowList: rule.triggerMetadata?.allowList || [],
          mentionTotalLimit: rule.triggerMetadata?.mentionTotalLimit || null,
        },
        exemptRoles: rule.exemptRoles?.map(r => ({ id: r.id, name: r.name })) || [],
        exemptChannels: rule.exemptChannels?.map(c => ({ id: c.id, name: c.name })) || [],
        creator: creatorInfo,
        createdByDynoOrMEE6: creatorInfo?.identifiedAs === 'Dyno' || creatorInfo?.identifiedAs === 'MEE6' || false,
      });
    }
  } catch (err) {
    console.error(`[Audit] Automod fetch error: ${err.message}`);
    audit.automodRules = { error: err.message };
  }

  // ============================================================
  // SECTION 4: Welcome channel
  // ============================================================
  console.log('[Audit] Fetching welcome channel messages...');
  const welcomeData = await fetchChannelMessages(guild, CHANNELS.welcome, 50);
  if (!welcomeData.error) {
    // Highlight MEE6 welcome messages
    const mee6Messages = welcomeData.messages.filter(m =>
      m.author.identifiedAs === 'MEE6' || m.author.username?.toLowerCase().includes('mee6')
    );
    audit.welcomeChannel = {
      channelName: welcomeData.channelName,
      channelId: welcomeData.channelId,
      totalMessages: welcomeData.messageCount,
      mee6Messages: mee6Messages.length,
      mee6WelcomeFormat: mee6Messages.length > 0 ? mee6Messages[0] : null,
      allMessages: welcomeData.messages,
    };
  } else {
    audit.welcomeChannel = welcomeData;
  }

  // ============================================================
  // SECTION 5: Additional channels - check for Dyno/MEE6/Streamcord embeds
  // ============================================================
  const additionalChannels = {
    rules: CHANNELS.rules,
    announcements: CHANNELS.announcements,
    cruciIsLive: CHANNELS.cruciIsLive,
    leveling: CHANNELS.leveling,
  };

  for (const [label, channelId] of Object.entries(additionalChannels)) {
    console.log(`[Audit] Fetching ${label} channel (${channelId})...`);
    const data = await fetchChannelMessages(guild, channelId, 50);
    if (!data.error) {
      // Filter messages from known bots (Dyno, MEE6, Streamcord)
      const botMessages = data.messages.filter(m => {
        const botName = m.author.identifiedAs;
        return botName === 'Dyno' || botName === 'MEE6' || botName === 'Streamcord' ||
               m.author.username?.toLowerCase().includes('dyno') ||
               m.author.username?.toLowerCase().includes('mee6') ||
               m.author.username?.toLowerCase().includes('streamcord');
      });

      audit.additionalChannels[label] = {
        channelName: data.channelName,
        channelId: data.channelId,
        totalMessages: data.messageCount,
        knownBotMessages: botMessages.length,
        botMessages,
        // Also include any messages with embeds from unknown bots
        otherBotEmbeds: data.messages.filter(m =>
          m.author.bot && m.embeds.length > 0 && !botMessages.includes(m)
        ),
      };
    } else {
      audit.additionalChannels[label] = data;
    }
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  console.log('\n[Audit] === SUMMARY ===');

  // Webhook summary
  const webhookArray = Array.isArray(audit.webhooks) ? audit.webhooks : [];
  console.log(`\nWebhooks: ${webhookArray.length} total`);
  for (const wh of webhookArray) {
    console.log(`  - "${wh.name}" in #${wh.channelName} (creator: ${wh.creatorBot || wh.creatorUsername || 'unknown'})`);
  }

  // React roles summary
  if (audit.reactRoles && !audit.reactRoles.error) {
    console.log(`\nReact Roles: ${audit.reactRoles.messagesWithReactions} messages with reactions out of ${audit.reactRoles.totalMessages}`);
    for (const msg of (audit.reactRoles.messages || [])) {
      const title = msg.embeds?.[0]?.title || msg.content?.substring(0, 80) || '[no content]';
      const bot = msg.author.identifiedAs || msg.author.username;
      const rxns = msg.reactions.map(r => `${r.emoji}(${r.count})`).join(', ');
      console.log(`  - [${bot}] "${title}" | Reactions: ${rxns}`);
    }
  }

  // Automod summary
  const automodArray = Array.isArray(audit.automodRules) ? audit.automodRules : [];
  console.log(`\nAutomod Rules: ${automodArray.length} total`);
  for (const rule of automodArray) {
    const creator = rule.creator?.identifiedAs || rule.creator?.username || 'unknown';
    console.log(`  - "${rule.name}" (${rule.triggerType}) | enabled: ${rule.enabled} | creator: ${creator} | dyno/mee6: ${rule.createdByDynoOrMEE6}`);
  }

  // Welcome summary
  if (audit.welcomeChannel && !audit.welcomeChannel.error) {
    console.log(`\nWelcome Channel: ${audit.welcomeChannel.totalMessages} messages, ${audit.welcomeChannel.mee6Messages} from MEE6`);
    if (audit.welcomeChannel.mee6WelcomeFormat) {
      const fmt = audit.welcomeChannel.mee6WelcomeFormat;
      const preview = fmt.content?.substring(0, 100) || fmt.embeds?.[0]?.description?.substring(0, 100) || '[embed only]';
      console.log(`  MEE6 format sample: "${preview}"`);
    }
  }

  // Additional channels summary
  for (const [label, data] of Object.entries(audit.additionalChannels)) {
    if (data.error) {
      console.log(`\n${label}: ERROR - ${data.error}`);
    } else {
      console.log(`\n${label} (#${data.channelName}): ${data.knownBotMessages} Dyno/MEE6/Streamcord messages, ${data.otherBotEmbeds.length} other bot embeds`);
    }
  }

  // Save to file
  await writeFile(OUTPUT_PATH, JSON.stringify(audit, null, 2));
  console.log(`\n[Audit] Full results saved to ${OUTPUT_PATH}`);

  // Cleanup
  client.destroy();
  await pool.end();
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  pool.end().catch(() => {});
  process.exit(1);
});
