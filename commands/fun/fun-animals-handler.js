import { EmbedBuilder } from 'discord.js';
import axios from 'axios';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CSE_ID = process.env.GOOGLE_CSE_ID;

// Track Google API health so we skip it entirely after a hard fail (403 etc.)
// until the process restarts. Avoids burning every /fun animals call on a
// dead API.
let googleDisabledUntilRestart = false;

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
  if (!GOOGLE_API_KEY || !GOOGLE_CSE_ID || googleDisabledUntilRestart) return [];
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
    const status = error.response?.status;
    const reason = error.response?.data?.error?.errors?.[0]?.reason;
    const msg = error.response?.data?.error?.message || error.message;
    // Kill-switch on hard configuration/quota errors so we don't keep hammering.
    if (status === 403 || status === 429 || reason === 'accessNotConfigured' || reason === 'quotaExceeded') {
      googleDisabledUntilRestart = true;
      logger.warn(`[Animal Command] Google CSE disabled for session (${status}/${reason}): ${String(msg).slice(0, 200)}`);
    } else {
      logger.warn(`[Animal Command] Google Search error: ${String(msg).slice(0, 200)}`);
    }
  }
  return [];
}

// Free fallback — Wikimedia Commons. No key, unlimited, has every animal.
// Returns image URLs via the File: namespace (ns 6). Fetches MORE than count
// then filters out any URLs that fail a HEAD check, so broken thumbnails don't
// slip into the embed.
async function searchWikimediaImages(animalName, imageType = 'photo', count = 10) {
  try {
    const searchQuery = imageType === 'gif' ? `${animalName} animation` : `${animalName} animal`;
    const searchRes = await axios.get('https://commons.wikimedia.org/w/api.php', {
      params: {
        action: 'query', format: 'json', origin: '*',
        generator: 'search',
        gsrsearch: `filetype:bitmap|drawing ${searchQuery}`,
        gsrnamespace: 6, gsrlimit: Math.max(count * 2, 20), // over-fetch so we can discard broken URLs
        prop: 'imageinfo', iiprop: 'url|mime|size',
        iiurlwidth: 800,
      },
      headers: { 'User-Agent': 'CertiFriedUtility-Bot/2.0 (discord bot; contact admin)' },
      timeout: 15000,
    });

    const pages = searchRes.data?.query?.pages;
    if (!pages) return [];
    const candidates = [];
    for (const page of Object.values(pages)) {
      const info = page.imageinfo?.[0];
      if (!info?.url) continue;
      const mime = info.mime || '';
      if (imageType === 'gif' && !/gif|webm|apng/.test(mime)) continue;
      if (imageType !== 'gif' && !/jpeg|jpg|png|webp/.test(mime)) continue;
      const url = info.thumburl || info.url;
      // Discord ignores URLs without an explicit image extension. Wikimedia
      // thumbnails end in the source extension so this holds for normal files.
      if (!/\.(jpg|jpeg|png|gif|webp)(\?|$)/i.test(url)) continue;
      // Filter out SVG-derived PNG thumbs that commonly 404 at some widths.
      if (/\/thumb\/.*\.svg\//i.test(url)) continue;
      candidates.push({
        url, title: page.title, source: 'Wikimedia Commons', isGif: imageType === 'gif',
      });
    }

    // HEAD-check concurrently and keep only URLs that return 200 + image mime.
    const checks = await Promise.all(candidates.map(c =>
      axios.head(c.url, {
        timeout: 5000,
        headers: { 'User-Agent': 'CertiFriedUtility-Bot/2.0' },
        validateStatus: s => s === 200,
      }).then(r => (r.headers['content-type'] || '').startsWith('image/') ? c : null)
        .catch(() => null)
    ));
    const good = checks.filter(Boolean);
    return good.slice(0, count);
  } catch (error) {
    logger.warn(`[Animal Command] Wikimedia fallback error: ${error.message?.slice(0, 200)}`);
    return [];
  }
}

async function searchAnimalImages(animalName, imageType, count) {
  // Primary: Google CSE. Fallback: Wikimedia Commons.
  const viaGoogle = await searchGoogleImages(animalName, imageType, count);
  if (viaGoogle.length) return viaGoogle;
  return searchWikimediaImages(animalName, imageType, count);
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

  const images = await searchAnimalImages(animalName, imageType, 10);
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
