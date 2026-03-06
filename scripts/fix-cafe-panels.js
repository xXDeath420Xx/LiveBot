/**
 * Fix: Delete orphaned reaction role panel messages from the failed step 4,
 * then re-create them properly with the fixed ReactionRoleManager.
 */

import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import pool from '../utils/db.js';
import encryption from '../utils/encryption.js';
import ReactionRoleManager from '../core/reaction-role-manager.js';

const GUILD_ID  = '877253051994501130';
const BOT_ID    = '1473622894138491007';
const REACT_ROLES_CH = '904428293846098011';

async function getBotToken() {
  const [bots] = await pool.execute(
    'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
    [BOT_ID]
  );
  if (!bots.length) throw new Error(`Bot ${BOT_ID} not found`);
  return encryption.decrypt(JSON.parse(bots[0].bot_token));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) { console.error('Not in guild'); process.exit(1); }

  const channel = await guild.channels.fetch(REACT_ROLES_CH);

  // Step 1: Find and delete the orphaned bot messages (sent by this bot, with embeds + buttons)
  console.log('\nFetching recent messages in #react-roles...');
  const messages = await channel.messages.fetch({ limit: 10 });
  const orphanedMsgs = messages.filter(m =>
    m.author.id === BOT_ID &&
    m.embeds.length > 0 &&
    m.components.length > 0
  );

  console.log(`Found ${orphanedMsgs.size} orphaned panel message(s) from this bot`);
  for (const [id, msg] of orphanedMsgs) {
    const title = msg.embeds[0]?.title || 'unknown';
    try {
      await msg.delete();
      console.log(`  DELETED orphaned message ${id} (${title})`);
    } catch (e) {
      console.error(`  Failed to delete ${id}: ${e.message}`);
    }
    await sleep(500);
  }

  // Step 2: Re-create panels with fixed ReactionRoleManager
  const rrManager = new ReactionRoleManager(client);

  console.log('\nCreating Streamer panel...');
  const streamerPanel = await rrManager.createReactionPanel(
    GUILD_ID,
    REACT_ROLES_CH,
    'Streamer Role',
    'toggle',
    'button',
    [
      {
        roleId: '916381900065628200',
        emoji: '🎮',
        label: 'Streamer',
        name: 'Streamer',
        description: 'Get the Streamer role to let us know you stream!',
      },
    ],
    {
      title: 'Are you a Streamer?',
      description: "Click below to get the Streamer role and let everyone know when you're live!",
      color: '#f51111',
    }
  );
  if (streamerPanel) {
    console.log(`  SUCCESS: message ${streamerPanel.messageId}, panel ${streamerPanel.panelId}`);
  } else {
    console.error('  FAILED');
  }

  await sleep(1000);

  console.log('Creating Color Roles panel...');
  const colorPanel = await rrManager.createReactionPanel(
    GUILD_ID,
    REACT_ROLES_CH,
    'Color Roles',
    'toggle',
    'button',
    [
      { roleId: '896495546053836861', emoji: '🔴', label: 'Red', name: 'Red' },
      { roleId: '896495711233917059', emoji: '🟠', label: 'Orange', name: 'Orange' },
      { roleId: '896495743618146324', emoji: '🔵', label: 'Blue', name: 'Blue' },
      { roleId: '896495764086353950', emoji: '🟣', label: 'Purple', name: 'Purple' },
      { roleId: '904429530167521321', emoji: '🟢', label: 'Green', name: 'Green' },
      { roleId: '904429670781575220', emoji: '🟡', label: 'Yellow', name: 'Yellow' },
    ],
    {
      title: 'Color Roles',
      description: 'Pick a color to display in the member list!',
      color: '#5865F2',
    }
  );
  if (colorPanel) {
    console.log(`  SUCCESS: message ${colorPanel.messageId}, panel ${colorPanel.panelId}`);
  } else {
    console.error('  FAILED');
  }

  console.log('\nDone!');
  client.destroy();
  await pool.end();
  process.exit(0);
});

(async () => {
  try {
    const token = await getBotToken();
    await client.login(token);
  } catch (err) {
    console.error('Failed to start:', err);
    process.exit(1);
  }
})();
