import { EmbedBuilder } from 'discord.js';
import axios from 'axios';
import pool from '../../utils/db.js';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID;

const animalEmojis = {
  dog: '🐕', cat: '🐱', fox: '🦊', bird: '🐦', rabbit: '🐰', panda: '🐼',
  koala: '🐨', kangaroo: '🦘', raccoon: '🦝', whale: '🐋', pig: '🐷',
  horse: '🐴', elephant: '🐘', lion: '🦁', tiger: '🐯', bear: '🐻',
  monkey: '🐵', giraffe: '🦒', zebra: '🦓', hippo: '🦛', rhino: '🦏',
  wolf: '🐺', owl: '🦉', penguin: '🐧', dolphin: '🐬', shark: '🦈',
  snake: '🐍', turtle: '🐢', frog: '🐸', butterfly: '🦋', bee: '🐝',
  spider: '🕷️', octopus: '🐙', crab: '🦀', fish: '🐟', deer: '🦌',
  mouse: '🐭', hamster: '🐹', squirrel: '🐿️', hedgehog: '🦔', bat: '🦇',
  duck: '🦆', swan: '🦢', peacock: '🦚', parrot: '🦜', flamingo: '🦩',
  eagle: '🦅', chicken: '🐔', cow: '🐄', goat: '🐐', sheep: '🐑',
  camel: '🐪', llama: '🦙', sloth: '🦥', otter: '🦦', beaver: '🦫',
  seal: '🦭', gorilla: '🦍', orangutan: '🦧', leopard: '🐆', cheetah: '🐆',
  crocodile: '🐊', alligator: '🐊', lizard: '🦎', dinosaur: '🦕',
  dragon: '🐉', unicorn: '🦄', axolotl: '🦎', default: '🐾'
};

function getAnimalEmoji(animal) {
  const normalizedAnimal = animal.toLowerCase().trim();
  if (animalEmojis[normalizedAnimal]) return animalEmojis[normalizedAnimal];
  for (const [key, emoji] of Object.entries(animalEmojis)) {
    if (normalizedAnimal.includes(key) || key.includes(normalizedAnimal)) return emoji;
  }
  return animalEmojis.default;
}

async function searchGoogleImages(animalName, imageType = 'photo', count = 10) {
  if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID) return [];
  try {
    const params = {
      key: GOOGLE_API_KEY, cx: GOOGLE_CSE_ID,
      q: `${animalName} animal ${imageType === 'gif' ? 'gif' : 'photo'}`,
      searchType: 'image', num: count, safe: 'active', imgSize: 'large'
    };
    if (imageType === 'gif') { params.fileType = 'gif'; params.imgType = 'animated'; }
    else { params.imgType = 'photo'; }

    const response = await axios.get('https://www.googleapis.com/customsearch/v1', { params, timeout: 15000 });
    if (response.data.items?.length > 0) {
      return response.data.items.map(item => ({ url: item.link, title: item.title, source: item.displayLink, isGif: imageType === 'gif' }));
    }
  } catch (error) {
    console.error('[Animal Command] Google Search error:', error.response?.data?.error?.message || error.message);
  }
  return [];
}

async function getUserSeenImages(userId, animalName) {
  try {
    const [rows] = await pool.execute('SELECT image_url FROM animal_image_history WHERE user_id = ? AND LOWER(animal_name) = LOWER(?)', [userId, animalName]);
    return rows.map(r => r.image_url);
  } catch { return []; }
}

async function recordImageSeen(userId, guildId, animalName, imageUrl) {
  try {
    await pool.execute('INSERT INTO animal_image_history (user_id, guild_id, animal_name, image_url) VALUES (?, ?, ?, ?)', [userId, guildId, animalName, imageUrl]);
  } catch (error) { console.error('[Animal Command] Failed to record image:', error.message); }
}

async function getUserAnimalStats(userId) {
  try {
    const [rows] = await pool.execute(`SELECT animal_name, COUNT(*) as times_viewed, MAX(created_at) as last_viewed FROM animal_image_history WHERE user_id = ? GROUP BY animal_name ORDER BY times_viewed DESC LIMIT 10`, [userId]);
    return rows;
  } catch { return []; }
}

async function getGlobalAnimalStats(guildId) {
  try {
    const [rows] = await pool.execute(`SELECT animal_name, COUNT(*) as total_views, COUNT(DISTINCT user_id) as unique_users FROM animal_image_history WHERE guild_id = ? GROUP BY animal_name ORDER BY total_views DESC LIMIT 10`, [guildId]);
    return rows;
  } catch { return []; }
}

export async function handleSearch(interaction) {
  const animalName = interaction.options.getString('name');
  const imageType = interaction.options.getString('type') || 'photo';
  const uniqueOnly = interaction.options.getBoolean('unique') || false;

  await interaction.deferReply();

  const images = await searchGoogleImages(animalName, imageType, 10);
  if (images.length === 0) {
    return interaction.editReply({ content: `😔 Sorry, I couldn't find any pictures of "${animalName}". Try a different search term!` });
  }

  let selectedImage;
  if (uniqueOnly) {
    const seenUrls = await getUserSeenImages(interaction.user.id, animalName);
    const unseenImages = images.filter(img => !seenUrls.includes(img.url));
    if (unseenImages.length === 0) {
      return interaction.editReply({ content: `🔄 You've seen all available ${animalName} images! Try again without the unique flag, or search for a different animal.` });
    }
    selectedImage = unseenImages[Math.floor(Math.random() * unseenImages.length)];
  } else {
    selectedImage = images[Math.floor(Math.random() * images.length)];
  }

  await recordImageSeen(interaction.user.id, interaction.guild.id, animalName, selectedImage.url);
  const seenImages = await getUserSeenImages(interaction.user.id, animalName);
  const emoji = getAnimalEmoji(animalName);
  const typeIcon = imageType === 'gif' ? '🎬' : '📷';

  const embed = new EmbedBuilder()
    .setColor('#4CAF50')
    .setTitle(`${emoji} ${animalName.charAt(0).toUpperCase() + animalName.slice(1)}`)
    .setImage(selectedImage.url)
    .setFooter({ text: `${typeIcon} ${selectedImage.source} | Viewed ${seenImages.length}x${uniqueOnly ? ' | 🆕 New!' : ''}` });

  return interaction.editReply({ embeds: [embed] });
}

export async function handleStats(interaction) {
  await interaction.deferReply();
  const stats = await getUserAnimalStats(interaction.user.id);
  if (stats.length === 0) {
    return interaction.editReply({ content: '📊 You haven\'t searched for any animals yet! Try `/fun animals search name:cat`' });
  }
  const embed = new EmbedBuilder()
    .setColor('#4CAF50')
    .setTitle('🐾 Your Animal Search History')
    .setDescription(stats.map((s, i) => `**${i + 1}.** ${getAnimalEmoji(s.animal_name)} ${s.animal_name} - ${s.times_viewed} searches`).join('\n'))
    .setFooter({ text: `Total: ${stats.reduce((a, s) => a + s.times_viewed, 0)} animal searches` });
  return interaction.editReply({ embeds: [embed] });
}

export async function handlePopular(interaction) {
  await interaction.deferReply();
  const stats = await getGlobalAnimalStats(interaction.guild.id);
  if (stats.length === 0) {
    return interaction.editReply({ content: '📊 No animals have been searched in this server yet!' });
  }
  const embed = new EmbedBuilder()
    .setColor('#4CAF50')
    .setTitle('🏆 Most Popular Animals')
    .setDescription(stats.map((s, i) => `**${i + 1}.** ${getAnimalEmoji(s.animal_name)} ${s.animal_name} - ${s.total_views} views (${s.unique_users} users)`).join('\n'));
  return interaction.editReply({ embeds: [embed] });
}
