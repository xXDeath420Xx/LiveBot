import { EmbedBuilder } from 'discord.js';
import axios from 'axios';

function formatNumber(num) {
  if (num >= 1e12) return (num / 1e12).toFixed(2) + 'T';
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(2) + 'K';
  if (num < 1) return num.toFixed(6);
  return num.toFixed(2);
}

function getCurrencySymbol(currency) {
  const symbols = { 'usd': '$', 'eur': '€', 'gbp': '£', 'jpy': '¥', 'aud': 'A$', 'cad': 'C$' };
  return symbols[currency] || '$';
}

async function searchCoin(query) {
  try {
    const symbolMap = {
      'btc': 'bitcoin', 'eth': 'ethereum', 'usdt': 'tether', 'bnb': 'binancecoin',
      'sol': 'solana', 'xrp': 'ripple', 'usdc': 'usd-coin', 'ada': 'cardano',
      'avax': 'avalanche-2', 'doge': 'dogecoin', 'trx': 'tron', 'dot': 'polkadot',
      'matic': 'matic-network', 'link': 'chainlink', 'ltc': 'litecoin', 'shib': 'shiba-inu',
      'uni': 'uniswap', 'atom': 'cosmos', 'etc': 'ethereum-classic', 'xlm': 'stellar'
    };
    if (symbolMap[query]) return symbolMap[query];
    try {
      await axios.get(`https://api.coingecko.com/api/v3/coins/${query}?localization=false&tickers=false`, { timeout: 5000 });
      return query;
    } catch (err) { /* continue to search */ }
    const searchResponse = await axios.get(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(query)}`, { timeout: 5000 });
    if (searchResponse.data.coins && searchResponse.data.coins.length > 0) return searchResponse.data.coins[0].id;
    return null;
  } catch (error) {
    console.error('[Crypto] Search error:', error.message);
    return null;
  }
}

export async function handlePrice(interaction) {
  const coinInput = interaction.options.getString('coin').toLowerCase();
  const currency = interaction.options.getString('currency') || 'usd';

  const coinId = await searchCoin(coinInput);
  if (!coinId) {
    return interaction.editReply({
      content: `❌ Cryptocurrency "${coinInput}" not found. Try using the full name (e.g., "bitcoin" instead of "btc").`
    });
  }

  const url = `https://api.coingecko.com/api/v3/coins/${coinId}?localization=false&tickers=false&community_data=false&developer_data=false`;
  const response = await axios.get(url, { timeout: 10000 });
  const data = response.data;

  const price = data.market_data.current_price[currency];
  const priceChange24h = data.market_data.price_change_percentage_24h;
  const priceChange7d = data.market_data.price_change_percentage_7d;
  const marketCap = data.market_data.market_cap[currency];
  const volume24h = data.market_data.total_volume[currency];
  const high24h = data.market_data.high_24h[currency];
  const low24h = data.market_data.low_24h[currency];

  const currencySymbol = getCurrencySymbol(currency);
  const changeEmoji = priceChange24h >= 0 ? '📈' : '📉';
  const changeColor = priceChange24h >= 0 ? '#27AE60' : '#E74C3C';

  const embed = new EmbedBuilder()
    .setColor(changeColor)
    .setTitle(`${changeEmoji} ${data.name} (${data.symbol.toUpperCase()})`)
    .setThumbnail(data.image.small)
    .addFields(
      { name: '💰 Current Price', value: `${currencySymbol}${formatNumber(price)}`, inline: true },
      { name: '📊 24h Change', value: `${priceChange24h >= 0 ? '+' : ''}${priceChange24h.toFixed(2)}%`, inline: true },
      { name: '📈 7d Change', value: priceChange7d ? `${priceChange7d >= 0 ? '+' : ''}${priceChange7d.toFixed(2)}%` : 'N/A', inline: true },
      { name: '📉 24h Low', value: `${currencySymbol}${formatNumber(low24h)}`, inline: true },
      { name: '📈 24h High', value: `${currencySymbol}${formatNumber(high24h)}`, inline: true },
      { name: '💎 Market Cap', value: `${currencySymbol}${formatNumber(marketCap)}`, inline: true },
      { name: '📊 24h Volume', value: `${currencySymbol}${formatNumber(volume24h)}`, inline: false }
    )
    .setFooter({ text: 'Powered by CoinGecko' })
    .setTimestamp();

  if (data.description?.en) {
    const description = data.description.en.substring(0, 200) + '...';
    embed.setDescription(description.replace(/<[^>]*>/g, ''));
  }

  return interaction.editReply({ embeds: [embed] });
}

export async function handleTrending(interaction) {
  const url = 'https://api.coingecko.com/api/v3/search/trending';
  const response = await axios.get(url, { timeout: 10000 });
  const trending = response.data.coins.slice(0, 7);

  const embed = new EmbedBuilder()
    .setColor('#F39C12')
    .setTitle('🔥 Trending Cryptocurrencies')
    .setDescription('Top trending coins on CoinGecko in the last 24 hours')
    .setFooter({ text: 'Powered by CoinGecko' })
    .setTimestamp();

  trending.forEach((item, index) => {
    const coin = item.item;
    embed.addFields({
      name: `${index + 1}. ${coin.name} (${coin.symbol})`,
      value: `Rank: #${coin.market_cap_rank || 'N/A'}\nPrice: $${coin.data?.price || 'N/A'}`,
      inline: true
    });
  });

  return interaction.editReply({ embeds: [embed] });
}

export async function handleCompare(interaction) {
  const coin1Input = interaction.options.getString('coin1').toLowerCase();
  const coin2Input = interaction.options.getString('coin2').toLowerCase();

  const [coin1, coin2] = await Promise.all([searchCoin(coin1Input), searchCoin(coin2Input)]);

  if (!coin1) return interaction.editReply({ content: `❌ Cryptocurrency "${coin1Input}" not found.` });
  if (!coin2) return interaction.editReply({ content: `❌ Cryptocurrency "${coin2Input}" not found.` });

  const [response1, response2] = await Promise.all([
    axios.get(`https://api.coingecko.com/api/v3/coins/${coin1}?localization=false&tickers=false&community_data=false&developer_data=false`, { timeout: 10000 }),
    axios.get(`https://api.coingecko.com/api/v3/coins/${coin2}?localization=false&tickers=false&community_data=false&developer_data=false`, { timeout: 10000 })
  ]);

  const data1 = response1.data;
  const data2 = response2.data;

  const embed = new EmbedBuilder()
    .setColor('#3498DB')
    .setTitle('⚖️ Cryptocurrency Comparison')
    .addFields(
      {
        name: `${data1.name} (${data1.symbol.toUpperCase()})`,
        value: `**Price:** $${formatNumber(data1.market_data.current_price.usd)}\n**24h Change:** ${data1.market_data.price_change_percentage_24h.toFixed(2)}%\n**Market Cap:** $${formatNumber(data1.market_data.market_cap.usd)}`,
        inline: true
      },
      { name: '🆚', value: '\u200B', inline: true },
      {
        name: `${data2.name} (${data2.symbol.toUpperCase()})`,
        value: `**Price:** $${formatNumber(data2.market_data.current_price.usd)}\n**24h Change:** ${data2.market_data.price_change_percentage_24h.toFixed(2)}%\n**Market Cap:** $${formatNumber(data2.market_data.market_cap.usd)}`,
        inline: true
      }
    )
    .setFooter({ text: 'Powered by CoinGecko' })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

export async function handleTop(interaction) {
  const limit = interaction.options.getInteger('limit') || 5;
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${limit}&page=1&sparkline=false`;
  const response = await axios.get(url, { timeout: 10000 });

  const embed = new EmbedBuilder()
    .setColor('#2ECC71')
    .setTitle('💎 Top Cryptocurrencies by Market Cap')
    .setFooter({ text: 'Powered by CoinGecko' })
    .setTimestamp();

  response.data.forEach((coin, index) => {
    const changeEmoji = coin.price_change_percentage_24h >= 0 ? '📈' : '📉';
    embed.addFields({
      name: `${index + 1}. ${coin.name} (${coin.symbol.toUpperCase()})`,
      value: `**Price:** $${formatNumber(coin.current_price)}\n**24h:** ${changeEmoji} ${coin.price_change_percentage_24h.toFixed(2)}%\n**Market Cap:** $${formatNumber(coin.market_cap)}`,
      inline: true
    });
  });

  return interaction.editReply({ embeds: [embed] });
}
