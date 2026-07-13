import dotenv from 'dotenv';
dotenv.config();

import pool from './utils/db.js';
import encryption from './utils/encryption.js';

const API_BASE = 'https://discord.com/api/v10';

// Reference channels to fetch
const REFERENCES = [
  {
    name: 'Reference 1 — Welcome Channel',
    channelId: '985116833193553933',
    guildId: '985116833193553930',
    botIds: ['1347122544376807557', '1438889625388060723']
  },
  {
    name: 'Reference 2 — Stream Signup Channel',
    channelId: '1381259664632582255',
    guildId: '844406178799943730',
    botIds: ['1438897897289552054']
  }
];

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function discordFetch(path, token, options = {}) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bot ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  
  if (res.status === 429) {
    const retry = res.headers.get('Retry-After');
    const waitMs = retry ? parseFloat(retry) * 1000 : 5000;
    console.log(`  [Rate Limited] Waiting ${Math.ceil(waitMs)}ms...`);
    await sleep(waitMs);
    return discordFetch(path, token, options);
  }
  
  if (!res.ok) {
    const text = await res.text();
    const error = new Error(`Discord API Error ${res.status}: ${text}`);
    error.status = res.status;
    throw error;
  }
  
  return res.json();
}

async function getCustomBotTokens(botIds) {
  const placeholders = botIds.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT bot_id, bot_name, bot_token FROM custom_bots WHERE bot_id IN (${placeholders})`,
    botIds
  );
  
  const tokens = {};
  for (const row of rows) {
    const decrypted = encryption.decrypt(JSON.parse(row.bot_token));
    tokens[row.bot_id] = {
      name: row.bot_name,
      token: decrypted
    };
  }
  return tokens;
}

async function fetchChannelMessages(channelId, token, limit = 20) {
  try {
    const messages = await discordFetch(
      `/channels/${channelId}/messages?limit=${limit}`,
      token
    );
    return messages;
  } catch (err) {
    console.error(`  [Error] Failed to fetch messages: ${err.message}`);
    return null;
  }
}

async function main() {
  console.log('=== Fetching Reference Channels ===\n');
  
  try {
    for (const ref of REFERENCES) {
      console.log(`\n${ref.name}`);
      console.log(`Channel: ${ref.channelId} | Guild: ${ref.guildId}`);
      console.log(`Looking for bots: ${ref.botIds.join(', ')}`);
      console.log('─'.repeat(70));
      
      // Get tokens for the bots
      const tokens = await getCustomBotTokens(ref.botIds);
      
      if (Object.keys(tokens).length === 0) {
        console.log('  [ERROR] No custom bot tokens found in database');
        continue;
      }
      
      let messages = null;
      let successBotId = null;
      
      // Try each bot token until one works
      for (const botId of ref.botIds) {
        if (!tokens[botId]) {
          console.log(`  [Skip] Bot ${botId} not in database`);
          continue;
        }
        
        console.log(`  [Try] Bot: ${tokens[botId].name} (${botId})`);
        messages = await fetchChannelMessages(ref.channelId, tokens[botId].token);
        
        if (messages) {
          successBotId = botId;
          console.log(`  [Success] Fetched ${messages.length} messages`);
          break;
        }
      }
      
      if (!messages || messages.length === 0) {
        console.log('  [ERROR] Could not fetch messages from any bot');
        continue;
      }
      
      // Reverse to get chronological order (API returns newest first)
      messages.reverse();
      
      // Dump each message with full fidelity
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        console.log(`\n  [Message ${i + 1}/${messages.length}]`);
        console.log(`  ID: ${msg.id} | Author: ${msg.author?.username || 'Unknown'}`);
        console.log(`  Content: ${msg.content || '(empty)'}`);
        
        if (msg.embeds && msg.embeds.length > 0) {
          console.log(`  Embeds (${msg.embeds.length}):`);
          for (const embed of msg.embeds) {
            console.log(`    ${JSON.stringify(embed, null, 2)}`);
          }
        }
        
        if (msg.components && msg.components.length > 0) {
          console.log(`  Components (${msg.components.length}):`);
          for (const comp of msg.components) {
            console.log(`    ${JSON.stringify(comp, null, 2)}`);
          }
        }
      }
    }
    
    console.log('\n=== Done ===');
  } catch (error) {
    console.error('[FATAL]', error.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
