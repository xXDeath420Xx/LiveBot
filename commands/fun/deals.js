import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import logger from '../../utils/logger.js';

const ITAD_KEY = process.env.ITAD_API_KEY || '6b9242583257e269be351284c6a2333588e34ac5';
const GEMINI_KEY = process.env.GOOGLE_AI_KEY;

const data = new SlashCommandBuilder()
    .setName('deals')
    .setDescription('Search for game deals, free content, and giveaways')
    .addSubcommand(sub =>
        sub.setName('search')
            .setDescription('Search for deals on a specific game')
            .addStringOption(opt =>
                opt.setName('game')
                    .setDescription('Game name to search for')
                    .setRequired(true)
                    .setMaxLength(200)))
    .addSubcommand(sub =>
        sub.setName('codes')
            .setDescription('Find active promo codes, redeem codes, and free content for a game')
            .addStringOption(opt =>
                opt.setName('game')
                    .setDescription('Game name (e.g., Dead by Daylight, Genshin Impact, Fortnite)')
                    .setRequired(true)
                    .setMaxLength(200)))
    .addSubcommand(sub =>
        sub.setName('free')
            .setDescription('Show currently free games and giveaways'))
    .addSubcommand(sub =>
        sub.setName('top')
            .setDescription('Show top deals right now')
            .addIntegerOption(opt =>
                opt.setName('limit')
                    .setDescription('Number of deals to show (default 10)')
                    .setMinValue(1)
                    .setMaxValue(20)));

async function execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'search') return handleSearch(interaction);
    if (sub === 'codes') return handleCodes(interaction);
    if (sub === 'free') return handleFree(interaction);
    if (sub === 'top') return handleTop(interaction);
}

async function handleSearch(interaction) {
    await interaction.deferReply();
    const query = interaction.options.getString('game');

    try {
        // Step 1: Search ITAD for the game
        const searchRes = await fetch(`https://api.isthereanydeal.com/games/search/v1?title=${encodeURIComponent(query)}&key=${ITAD_KEY}`).then(r => r.json()).catch(() => []);

        if (!Array.isArray(searchRes) || searchRes.length === 0) {
            return interaction.editReply({ content: `No games found matching **${query}**. Try a different name.` });
        }

        // Take top 3 matches
        const games = searchRes.slice(0, 3);
        const gameIds = games.map(g => g.id);

        // Step 2: Fetch prices, history low, and giveaways in parallel
        const [pricesRes, historyRes, giveawaysRes] = await Promise.all([
            fetch(`https://api.isthereanydeal.com/games/prices/v3?key=${ITAD_KEY}&country=US`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(gameIds),
            }).then(r => r.json()).catch(() => []),
            fetch(`https://api.isthereanydeal.com/games/historylow/v1?key=${ITAD_KEY}&country=US`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(gameIds),
            }).then(r => r.json()).catch(() => []),
            fetch(`https://www.gamerpower.com/api/giveaways?sort-by=popularity`).then(r => r.json()).catch(() => []),
        ]);

        // Build price map
        const priceMap = {};
        if (Array.isArray(pricesRes)) {
            pricesRes.forEach(g => { priceMap[g.id] = g; });
        }
        const historyMap = {};
        if (Array.isArray(historyRes)) {
            historyRes.forEach(g => { historyMap[g.id] = g; });
        }

        // Filter giveaways matching query
        const giveaways = (Array.isArray(giveawaysRes) ? giveawaysRes : [])
            .filter(g => g.title?.toLowerCase().includes(query.toLowerCase()))
            .slice(0, 3);

        // Build embed for each game
        const embeds = [];
        for (const game of games) {
            const priceData = priceMap[game.id];
            const histData = historyMap[game.id];
            const deals = priceData?.deals || [];
            const histLow = histData?.low;

            if (deals.length === 0 && !histLow) continue;

            const embed = new EmbedBuilder()
                .setColor(deals.some(d => d.cut === 100) ? 0x22c55e : 0x3498db)
                .setTitle(game.title)
                .setURL(`https://isthereanydeal.com/game/${game.slug}/info/`);

            if (game.assets?.banner400) embed.setThumbnail(game.assets.banner400);

            // Current best deals (top 5 unique stores)
            if (deals.length > 0) {
                const seenStores = new Set();
                const dealLines = [];
                for (const d of deals) {
                    if (seenStores.has(d.shop.name)) continue;
                    seenStores.add(d.shop.name);
                    const isFree = d.price.amount === 0;
                    const price = isFree ? '**FREE**' : `**$${d.price.amount.toFixed(2)}**`;
                    const voucher = d.voucher ? ` 🏷️ \`${d.voucher}\`` : '';
                    dealLines.push(`${isFree ? '🎁' : '💰'} ${price} ~~$${d.regular.amount.toFixed(2)}~~ (**${d.cut}% off**) — ${d.shop.name}${voucher}`);
                    if (dealLines.length >= 6) break;
                }
                embed.addFields({ name: '🏷️ Current Deals', value: dealLines.join('\n') });
            }

            // Historical low
            if (histLow) {
                const date = new Date(histLow.timestamp).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
                embed.addFields({
                    name: '📉 Historical Low',
                    value: `**$${histLow.price.amount.toFixed(2)}** (${histLow.cut}% off) at ${histLow.shop.name} — ${date}`,
                    inline: true,
                });
            }

            // All-time + recent lows from prices endpoint
            if (priceData?.historyLow) {
                const hl = priceData.historyLow;
                const parts = [];
                if (hl.all) parts.push(`All-time: **$${hl.all.amount.toFixed(2)}**`);
                if (hl.y1) parts.push(`Past year: **$${hl.y1.amount.toFixed(2)}**`);
                if (hl.m3) parts.push(`Past 3mo: **$${hl.m3.amount.toFixed(2)}**`);
                if (parts.length) embed.addFields({ name: '📊 Price History', value: parts.join(' │ '), inline: true });
            }

            embed.setFooter({ text: 'Data from IsThereAnyDeal • Prices in USD' });
            embeds.push(embed);
        }

        // Add giveaways if found
        if (giveaways.length > 0) {
            const giveEmbed = new EmbedBuilder()
                .setColor(0xFFD700)
                .setTitle('🎁 Active Giveaways');
            const lines = giveaways.map(g => {
                const worth = g.worth && g.worth !== 'N/A' ? ` (worth ${g.worth})` : '';
                return `🎮 **${g.title}**${worth}\n${g.platforms} — [Claim Free](${g.open_giveaway_url})`;
            });
            giveEmbed.setDescription(lines.join('\n\n'));
            embeds.push(giveEmbed);
        }

        if (embeds.length === 0) {
            return interaction.editReply({ content: `Found **${games[0].title}** but no current deals or giveaways.` });
        }

        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('View on ITAD')
                .setURL(`https://isthereanydeal.com/game/${games[0].slug}/info/`)
                .setStyle(ButtonStyle.Link),
            new ButtonBuilder()
                .setLabel('Price History')
                .setURL(`https://isthereanydeal.com/game/${games[0].slug}/history/`)
                .setStyle(ButtonStyle.Link),
        );

        await interaction.editReply({ embeds: embeds.slice(0, 4), components: [buttons] });
    } catch (error) {
        logger.error('[Deals] Search error:', { error: error.message, query });
        await interaction.editReply({ content: 'Failed to search for deals. Please try again later.' });
    }
}

async function handleCodes(interaction) {
    await interaction.deferReply();
    const game = interaction.options.getString('game');

    try {
        if (!GEMINI_KEY) {
            return interaction.editReply({ content: 'Code search requires AI configuration. Please contact an admin.' });
        }

        const now = new Date();
        const monthYear = now.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

        // Use Gemini with grounding (Google Search) to find current active codes
        const prompt = `Search the web for currently active promo codes, redeem codes, free DLC codes, and promotional content for the video game "${game}" as of ${monthYear}.

Find and compile:
1. All currently ACTIVE redemption/promo codes with what each code gives you (cosmetics, items, currency, etc.)
2. Any codes that recently expired (within last 2 weeks) so users know NOT to try them
3. How to redeem codes in this game (menu location, website URL if applicable)
4. Any active limited-time free content, crossover events, or promotional giveaways

IMPORTANT RULES:
- Only include codes confirmed active from sources updated within the last 30 days
- Mark expired codes clearly as EXPIRED
- Include the source/website where you found each code if possible
- If no active codes exist for this game, say so clearly
- Format codes in ALL CAPS or exactly as they should be entered
- Group codes by category (general, cosmetic, event-specific, pride/identity, etc.)

Respond in this exact format for Discord (use markdown):
**Game:** [game name]
**Last verified:** [date from your sources]
**Sources:** [list sites you found codes on]

**Active Codes:**
• \`CODE\` — Reward description (expires: date or "no known expiry")

**Recently Expired:**
• ~~\`CODE\`~~ — Was: reward description (expired: date)

**How to Redeem:**
[Instructions for this specific game]

**Other Free Content:**
[Any active promotions, free DLC, crossover events, etc.]

If there are many codes (10+), organize them into logical categories with headers.`;

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                tools: [{ googleSearch: {} }],
                generationConfig: { temperature: 0.2, maxOutputTokens: 4000 },
            }),
        });

        const data = await response.json();
        let text = '';

        if (data.candidates?.[0]?.content?.parts) {
            for (const part of data.candidates[0].content.parts) {
                if (part.text) text += part.text;
            }
        }

        if (!text || text.length < 50) {
            return interaction.editReply({ content: `Couldn't find code information for **${game}**. The game may not have a redemption code system, or no codes are currently active.` });
        }

        // Split into chunks for Discord (max 4096 per embed description, 2000 per field)
        const chunks = [];
        let remaining = text;
        while (remaining.length > 0) {
            if (remaining.length <= 4000) {
                chunks.push(remaining);
                break;
            }
            // Find a good break point (newline near 4000 chars)
            let breakPoint = remaining.lastIndexOf('\n', 4000);
            if (breakPoint < 2000) breakPoint = 4000;
            chunks.push(remaining.substring(0, breakPoint));
            remaining = remaining.substring(breakPoint);
        }

        const embeds = chunks.map((chunk, i) => {
            const embed = new EmbedBuilder()
                .setColor(0xa78bfa)
                .setDescription(chunk);
            if (i === 0) {
                embed.setTitle(`🔑 Active Codes — ${game}`);
            }
            if (i === chunks.length - 1) {
                embed.setFooter({ text: 'Powered by Gemini AI + Google Search • Codes may expire without notice • Always verify before redeeming' });
                embed.setTimestamp();
            }
            return embed;
        });

        // Extract source URLs from grounding metadata if available
        const sources = data.candidates?.[0]?.groundingMetadata?.groundingChunks
            ?.map(c => c.web?.uri)
            ?.filter(Boolean)
            ?.slice(0, 3) || [];

        const buttons = new ActionRowBuilder();
        if (sources.length > 0) {
            sources.forEach((url, i) => {
                try {
                    const hostname = new URL(url).hostname.replace('www.', '');
                    buttons.addComponents(
                        new ButtonBuilder().setLabel(hostname).setURL(url).setStyle(ButtonStyle.Link)
                    );
                } catch {}
            });
        }
        // Always add a generic search button
        buttons.addComponents(
            new ButtonBuilder()
                .setLabel(`Search "${game} codes"`)
                .setURL(`https://www.google.com/search?q=${encodeURIComponent(game + ' active codes ' + monthYear)}`)
                .setStyle(ButtonStyle.Link)
        );

        await interaction.editReply({
            embeds: embeds.slice(0, 4),
            components: buttons.components.length > 0 ? [buttons] : [],
        });
    } catch (error) {
        logger.error('[Deals] Codes error:', { error: error.message, game });
        await interaction.editReply({ content: 'Failed to search for codes. Please try again later.' });
    }
}

async function handleFree(interaction) {
    await interaction.deferReply();

    try {
        // Fetch free games from ITAD (100% off deals) and GamerPower in parallel
        const [itadFree, gpGames, gpDLC, gpLoot] = await Promise.all([
            fetch(`https://api.isthereanydeal.com/deals/v2?key=${ITAD_KEY}&limit=10&filter=N4IgLgngDgpgTgSwPYBcoHcAOYC2YA2AxgBYIgA0IANjAhAC4wXECMTLADAEwPMBsAdh4BmAUIDMYgBwBOSQFYALKICsTKerZA`).then(r => r.json()).catch(() => ({})),
            fetch('https://www.gamerpower.com/api/giveaways?type=game&sort-by=popularity').then(r => r.json()).catch(() => []),
            fetch('https://www.gamerpower.com/api/giveaways?type=dlc&sort-by=popularity').then(r => r.json()).catch(() => []),
            fetch('https://www.gamerpower.com/api/giveaways?type=loot&sort-by=popularity').then(r => r.json()).catch(() => []),
        ]);

        const embed = new EmbedBuilder()
            .setColor(0xFFD700)
            .setTitle('🎁 Free Games, DLC & Loot')
            .setDescription('Currently available for free across all platforms.')
            .setTimestamp();

        // ITAD free games (100% off)
        const itadGames = itadFree?.list?.filter(d => d.deal?.price?.amount === 0)?.slice(0, 8) || [];
        if (itadGames.length > 0) {
            const lines = itadGames.map(g =>
                `🎮 **${g.title}** — ~~$${g.deal.regular.amount.toFixed(2)}~~ → **FREE** (${g.deal.shop.name})`
            );
            embed.addFields({ name: '🏪 Free on Stores', value: lines.join('\n').substring(0, 1024) });
        }

        // GamerPower free games
        const games = (Array.isArray(gpGames) ? gpGames : []).slice(0, 6);
        if (games.length > 0) {
            const lines = games.map(g => {
                const worth = g.worth && g.worth !== 'N/A' ? ` (worth ${g.worth})` : '';
                return `🎁 **${g.title}**${worth}\n\u2003${g.platforms} — [Claim](${g.open_giveaway_url})`;
            });
            embed.addFields({ name: '🎮 Game Giveaways', value: lines.join('\n').substring(0, 1024) });
        }

        // Free DLC
        const dlc = (Array.isArray(gpDLC) ? gpDLC : []).slice(0, 5);
        if (dlc.length > 0) {
            const lines = dlc.map(g => `📦 **${g.title}** — ${g.platforms} — [Claim](${g.open_giveaway_url})`);
            embed.addFields({ name: '📦 Free DLC & Add-ons', value: lines.join('\n').substring(0, 1024) });
        }

        // Free loot
        const loot = (Array.isArray(gpLoot) ? gpLoot : []).slice(0, 5);
        if (loot.length > 0) {
            const lines = loot.map(g => `🎲 **${g.title}** — ${g.platforms} — [Claim](${g.open_giveaway_url})`);
            embed.addFields({ name: '🎲 Free Loot & In-Game Items', value: lines.join('\n').substring(0, 1024) });
        }

        const total = itadGames.length + games.length + dlc.length + loot.length;
        embed.setFooter({ text: `${total} free items found • IsThereAnyDeal + GamerPower` });

        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('IsThereAnyDeal').setURL('https://isthereanydeal.com/specials/#/filter:&giveaway').setStyle(ButtonStyle.Link),
            new ButtonBuilder().setLabel('GamerPower').setURL('https://www.gamerpower.com/giveaways').setStyle(ButtonStyle.Link),
        );

        await interaction.editReply({ embeds: [embed], components: [buttons] });
    } catch (error) {
        logger.error('[Deals] Free games error:', { error: error.message });
        await interaction.editReply({ content: 'Failed to fetch free games. Please try again later.' });
    }
}

async function handleTop(interaction) {
    await interaction.deferReply();
    const limit = interaction.options.getInteger('limit') || 10;

    try {
        const res = await fetch(`https://api.isthereanydeal.com/deals/v2?key=${ITAD_KEY}&limit=${limit}&sort=-cut`).then(r => r.json()).catch(() => ({}));
        const deals = res?.list || [];

        if (deals.length === 0) {
            return interaction.editReply({ content: 'No deals found right now.' });
        }

        const embed = new EmbedBuilder()
            .setColor(0xff6b35)
            .setTitle('🔥 Top Deals Right Now')
            .setTimestamp();

        const lines = deals.map((d, i) => {
            const deal = d.deal;
            const isFree = deal.price.amount === 0;
            const price = isFree ? '**FREE**' : `**$${deal.price.amount.toFixed(2)}**`;
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
            const voucher = deal.voucher ? ` 🏷️ \`${deal.voucher}\`` : '';
            return `${medal} ${price} ~~$${deal.regular.amount.toFixed(2)}~~ (**${deal.cut}% off**) — ${deal.shop.name}${voucher}\n\u2003*${d.title}*`;
        });

        // Split into fields if needed
        let current = '';
        let fieldNum = 1;
        for (const line of lines) {
            if (current.length + line.length > 1000) {
                embed.addFields({ name: fieldNum === 1 ? `💰 Top ${deals.length} Deals` : '\u200b', value: current });
                current = '';
                fieldNum++;
            }
            current += line + '\n';
        }
        if (current) embed.addFields({ name: fieldNum === 1 ? `💰 Top ${deals.length} Deals` : '\u200b', value: current });

        embed.setFooter({ text: 'Data from IsThereAnyDeal • Prices in USD' });

        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('Browse All Deals').setURL('https://isthereanydeal.com/specials/#/').setStyle(ButtonStyle.Link),
        );

        await interaction.editReply({ embeds: [embed], components: [buttons] });
    } catch (error) {
        logger.error('[Deals] Top deals error:', { error: error.message });
        await interaction.editReply({ content: 'Failed to fetch deals. Please try again later.' });
    }
}

export default { data, execute };
