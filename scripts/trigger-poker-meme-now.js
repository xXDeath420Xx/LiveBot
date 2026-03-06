// Trigger a poker meme post to Flying Sharks channel
import PokerMemeGenerator from '../core/poker-meme-generator.js';
import { Client, GatewayIntentBits } from 'discord.js';
import dotenv from 'dotenv';
import pool from '../utils/db.js';

dotenv.config();

const FLYING_SHARKS_GUILD = '1307517872301670480';
const MEME_CHANNEL = '1307522084406038601';

async function main() {
  console.log('Connecting to Discord...');

  // Get Flying Sharks Utility token from database
  const [rows] = await pool.execute(
    'SELECT bot_token FROM custom_bots WHERE bot_id = ?',
    ['1462813232409612447']
  );

  if (rows.length === 0) {
    console.error('Flying Sharks Utility bot not found in database');
    process.exit(1);
  }

  // Decrypt token - it's stored as JSON
  const { default: encryption } = await import('../utils/encryption.js');
  let tokenData = rows[0].bot_token;
  if (typeof tokenData === 'string') {
    tokenData = JSON.parse(tokenData);
  }
  const token = encryption.decrypt(tokenData);

  // Create minimal client
  const client = new Client({
    intents: [GatewayIntentBits.Guilds]
  });

  client.once('ready', async () => {
    console.log(`Logged in as ${client.user.tag}`);
    console.log(`Posting poker meme to guild ${FLYING_SHARKS_GUILD}, channel ${MEME_CHANNEL}`);

    const generator = new PokerMemeGenerator(client);

    try {
      // Force use drake template which we know works
      const texts = ['Playing tight and patient', 'Going all-in with 7-2 suited'];
      const buffer = await generator.generateMeme('drake', texts);

      if (buffer) {
        const { AttachmentBuilder, EmbedBuilder } = await import('discord.js');
        const channel = client.channels.cache.get(MEME_CHANNEL);

        if (channel) {
          const attachment = new AttachmentBuilder(buffer, { name: 'poker-meme.png' });
          const embed = new EmbedBuilder()
            .setColor('#2ECC71')
            .setTitle('Daily Poker Meme')
            .setImage('attachment://poker-meme.png')
            .setFooter({ text: 'Generated for Flying Sharks' })
            .setTimestamp();

          await channel.send({ embeds: [embed], files: [attachment] });
          console.log('✅ Poker meme posted successfully!');
        } else {
          console.log('❌ Channel not found');
        }
      } else {
        console.log('❌ Failed to generate meme');
      }
    } catch (error) {
      console.error('Error:', error.message);
    }

    // Cleanup
    client.destroy();
    await pool.end();
    process.exit(0);
  });

  await client.login(token);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
