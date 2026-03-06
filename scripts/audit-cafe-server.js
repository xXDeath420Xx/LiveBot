import 'dotenv/config';
import { Client, GatewayIntentBits, ChannelType, PermissionsBitField } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';

const GUILD_ID = '877253051994501130';
const BOT_ID = '1473622894138491007';
const KNOWN_BOTS = ['Dyno', 'MEE6', 'Streamcord'];

const channelTypeNames = {
  [ChannelType.GuildText]: 'Text',
  [ChannelType.DM]: 'DM',
  [ChannelType.GuildVoice]: 'Voice',
  [ChannelType.GroupDM]: 'GroupDM',
  [ChannelType.GuildCategory]: 'Category',
  [ChannelType.GuildAnnouncement]: 'Announcement',
  [ChannelType.AnnouncementThread]: 'AnnouncementThread',
  [ChannelType.PublicThread]: 'PublicThread',
  [ChannelType.PrivateThread]: 'PrivateThread',
  [ChannelType.GuildStageVoice]: 'StageVoice',
  [ChannelType.GuildDirectory]: 'Directory',
  [ChannelType.GuildForum]: 'Forum',
  [ChannelType.GuildMedia]: 'Media',
};

async function main() {
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
    ],
  });

  await client.login(token);

  await new Promise(resolve => {
    if (client.isReady()) return resolve();
    client.once('ready', resolve);
  });

  console.log(`Logged in as ${client.user.tag}`);

  // 3. Fetch guild
  const guild = await client.guilds.fetch(GUILD_ID);
  if (!guild) {
    console.error('Guild not found');
    client.destroy();
    await pool.end();
    process.exit(1);
  }

  // Fetch all needed data in parallel
  const [channels, roles, members, automodRules] = await Promise.all([
    guild.channels.fetch(),
    guild.roles.fetch(),
    guild.members.fetch(),
    guild.autoModerationRules.fetch().catch(() => new Map()),
  ]);

  // 4. Build audit result
  const audit = {};

  // Guild info
  audit.guild = {
    id: guild.id,
    name: guild.name,
    ownerId: guild.ownerId,
    memberCount: guild.memberCount,
    fetchedMemberCount: members.size,
  };

  // Channels - build categories map first
  const categories = new Map();
  channels.forEach(ch => {
    if (ch && ch.type === ChannelType.GuildCategory) {
      categories.set(ch.id, ch.name);
    }
  });

  audit.channels = [...channels.values()]
    .filter(ch => ch !== null && ch !== undefined)
    .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
    .map(ch => ({
      id: ch.id,
      name: ch.name,
      type: channelTypeNames[ch.type] || `Unknown(${ch.type})`,
      parentCategory: ch.parentId ? (categories.get(ch.parentId) || ch.parentId) : null,
      position: ch.rawPosition ?? null,
    }));

  // Roles
  audit.roles = [...roles.values()]
    .sort((a, b) => b.position - a.position)
    .map(r => ({
      id: r.id,
      name: r.name,
      color: r.hexColor,
      position: r.position,
      managed: r.managed,
      permissions: new PermissionsBitField(r.permissions.bitfield).toArray(),
    }));

  // Bots in server
  const botsInServer = [...members.values()]
    .filter(m => m.user.bot)
    .map(m => ({
      id: m.user.id,
      tag: m.user.tag,
      username: m.user.username,
    }));

  audit.bots = {
    total: botsInServer.length,
    list: botsInServer,
    knownBotCheck: {},
  };

  for (const name of KNOWN_BOTS) {
    const found = botsInServer.find(b =>
      b.username.toLowerCase().includes(name.toLowerCase()) ||
      b.tag.toLowerCase().includes(name.toLowerCase())
    );
    audit.bots.knownBotCheck[name] = found
      ? { present: true, tag: found.tag, id: found.id }
      : { present: false };
  }

  // Automod rules
  audit.automodRules = [];
  if (automodRules && automodRules.size > 0) {
    automodRules.forEach(rule => {
      audit.automodRules.push({
        id: rule.id,
        name: rule.name,
        enabled: rule.enabled,
        triggerType: rule.triggerType,
        eventType: rule.eventType,
        actions: rule.actions?.map(a => ({ type: a.type, metadata: a.metadata })) || [],
      });
    });
  }

  // Output
  console.log(JSON.stringify(audit, null, 2));

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
