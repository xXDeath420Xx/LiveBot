import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import pool from '../../utils/db.js';
import logger from '../../utils/logger.js';
import { themeColor } from '../../core/guild-theme.js';
import { getConfig as getFeatureConfig } from '../../core/feature-config.js';

/*
 * GamerPower was removed from this command along with its scraper. Its links are
 * `gamerpower.com/open/...` redirects into third-party giveaway sites that ask a member to
 * register an account or download an archive before they get a key — not something to hand a
 * server's members. Free offers now come from the four storefronts the bot tracks itself
 * (Steam, Epic, GOG, Amazon Prime Gaming), which the free-games scrapers already keep current
 * in `free_games_products`, plus IsThereAnyDeal's 100%-off listings.
 */

/** Stores this bot will surface a free offer for. Matches core/free-games-manager.js. */
const TRACKED_STORES = ['steam', 'epic', 'gog', 'prime'];

const STORE_LABELS = {
    steam: 'Steam',
    epic: 'Epic Games',
    gog: 'GOG',
    prime: 'Prime Gaming',
};

/**
 * Free offers the bot is currently tracking, newest first.
 * Reads the same rows the notifier announces from, so /deals free and the alert channel can
 * never disagree about what is free right now.
 */
async function currentlyFree(limit = 12) {
    const [rows] = await pool.execute(
        `SELECT title, store, url, org_price_usd, until_date, kind
           FROM free_games_products
          WHERE is_active = 1
            AND store IN (?, ?, ?, ?)
            AND (until_date IS NULL OR until_date > NOW())
       ORDER BY created_at DESC
          LIMIT ${Number(limit)}`,
        TRACKED_STORES
    );
    return rows;
}

const ITAD_KEY = process.env.ITAD_API_KEY || '';
// The Game Deals page's "Price region" (core/feature-config-spec.js deals.region): IsThereAnyDeal prices
// for that country, shown in its currency. Unknown or unset is US.
const DEAL_REGIONS = ['US', 'GB', 'DE', 'CA', 'AU', 'BR', 'JP'];
export async function dealsRegion(guildId) {
    if (!guildId) return 'US';
    const cfg = await getFeatureConfig('deals', guildId).catch(() => ({}));
    const region = String(cfg?.region || 'US').toUpperCase();
    return DEAL_REGIONS.includes(region) ? region : 'US';
}
/** An IsThereAnyDeal price ({ amount, currency }) in its own currency. */
export function dealMoney(p) {
    const amount = Number(p?.amount) || 0;
    const currency = /^[A-Z]{3}$/.test(p?.currency || '') ? p.currency : 'USD';
    try { return new Intl.NumberFormat('en', { style: 'currency', currency }).format(amount); } catch { return `${amount.toFixed(2)} ${currency}`; }
}

// Either key works for text; they carry separate quotas, so take whichever has one.
const GEMINI_KEY = process.env.GOOGLE_AI_KEY || process.env.GOOGLE_API_KEY;

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

        // Step 2: Fetch prices, history low, and our own tracked free offers in parallel
        const region = await dealsRegion(interaction.guildId);
        const [pricesRes, historyRes, tracked] = await Promise.all([
            fetch(`https://api.isthereanydeal.com/games/prices/v3?key=${ITAD_KEY}&country=${region}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(gameIds),
            }).then(r => r.json()).catch(() => []),
            fetch(`https://api.isthereanydeal.com/games/historylow/v1?key=${ITAD_KEY}&country=${region}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(gameIds),
            }).then(r => r.json()).catch(() => []),
            currentlyFree(40).catch(() => []),
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

        // Any of those that match what was searched for
        const giveaways = tracked
            .filter(g => String(g.title || '').toLowerCase().includes(query.toLowerCase()))
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
                    const price = isFree ? '**FREE**' : `**${dealMoney(d.price)}**`;
                    const voucher = d.voucher ? ` 🏷️ \`${d.voucher}\`` : '';
                    dealLines.push(`${isFree ? '🎁' : '💰'} ${price} ~~${dealMoney(d.regular)}~~ (**${d.cut}% off**) — ${d.shop.name}${voucher}`);
                    if (dealLines.length >= 6) break;
                }
                embed.addFields({ name: '🏷️ Current Deals', value: dealLines.join('\n') });
            }

            // Historical low
            if (histLow) {
                const date = new Date(histLow.timestamp).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
                embed.addFields({
                    name: '📉 Historical Low',
                    value: `**${dealMoney(histLow.price)}** (${histLow.cut}% off) at ${histLow.shop.name} — ${date}`,
                    inline: true,
                });
            }

            // All-time + recent lows from prices endpoint
            if (priceData?.historyLow) {
                const hl = priceData.historyLow;
                const parts = [];
                if (hl.all) parts.push(`All-time: **${dealMoney(hl.all)}**`);
                if (hl.y1) parts.push(`Past year: **${dealMoney(hl.y1)}**`);
                if (hl.m3) parts.push(`Past 3mo: **${dealMoney(hl.m3)}**`);
                if (parts.length) embed.addFields({ name: '📊 Price History', value: parts.join(' │ '), inline: true });
            }

            embed.setFooter({ text: `Data from IsThereAnyDeal • ${region} prices` });
            embeds.push(embed);
        }

        // Add giveaways if found
        if (giveaways.length > 0) {
            const giveEmbed = new EmbedBuilder()
                .setColor(themeColor(interaction.guildId, 'warning'))
                .setTitle('🎁 Active Giveaways');
            const lines = giveaways.map(g => {
                const worth = Number(g.org_price_usd) > 0 ? ` (worth $${Number(g.org_price_usd).toFixed(2)})` : '';
                const until = g.until_date ? ` — until <t:${Math.floor(new Date(g.until_date).getTime() / 1000)}:D>` : '';
                return `🎮 **${g.title}**${worth}\n${STORE_LABELS[g.store] || g.store}${until} — [Claim Free](${g.url})`;
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
        // Our own tracked storefront offers, plus ITAD's 100%-off listings.
        const [itadFree, tracked] = await Promise.all([
            fetch(`https://api.isthereanydeal.com/deals/v2?key=${ITAD_KEY}&limit=10&filter=N4IgLgngDgpgTgSwPYBcoHcAOYC2YA2AxgBYIgA0IANjAhAC4wXECMTLADAEwPMBsAdh4BmAUIDMYgBwBOSQFYALKICsTKerZA`).then(r => r.json()).catch(() => ({})),
            currentlyFree(24).catch(() => []),
        ]);

        const embed = new EmbedBuilder()
            .setColor(themeColor(interaction.guildId, 'warning'))
            .setTitle('🎁 Free Right Now')
            .setDescription('Claimed directly on the storefront — no third-party sign-ups, no downloads.')
            .setTimestamp();

        // One field per store, so it is obvious where each offer is claimed.
        let trackedCount = 0;
        for (const store of TRACKED_STORES) {
            const offers = tracked.filter(g => g.store === store).slice(0, 6);
            if (offers.length === 0) continue;
            trackedCount += offers.length;
            const lines = offers.map(g => {
                const worth = Number(g.org_price_usd) > 0 ? ` (worth $${Number(g.org_price_usd).toFixed(2)})` : '';
                const until = g.until_date ? ` · until <t:${Math.floor(new Date(g.until_date).getTime() / 1000)}:D>` : '';
                const tag = g.kind === 'dlc' ? '📦' : '🎮';
                return `${tag} **${g.title}**${worth}${until}\n\u2003[Claim](${g.url})`;
            });
            embed.addFields({ name: STORE_LABELS[store], value: lines.join('\n').substring(0, 1024) });
        }

        // ITAD free games (100% off) — anything the four scrapers have not picked up.
        const itadGames = itadFree?.list?.filter(d => d.deal?.price?.amount === 0)?.slice(0, 8) || [];
        if (itadGames.length > 0) {
            const lines = itadGames.map(g =>
                `🎮 **${g.title}** — ~~${dealMoney(g.deal.regular)}~~ → **FREE** (${g.deal.shop.name})`
            );
            embed.addFields({ name: '🏪 Also 100% off elsewhere', value: lines.join('\n').substring(0, 1024) });
        }

        const total = itadGames.length + trackedCount;
        if (total === 0) {
            embed.addFields({ name: 'Nothing right now', value: 'No free offers are live on Steam, Epic, GOG or Prime Gaming at the moment. Check back soon.' });
        }
        embed.setFooter({ text: `${total} free item(s) • Steam · Epic · GOG · Prime Gaming · IsThereAnyDeal` });

        const buttons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setLabel('Epic Free Games').setURL('https://store.epicgames.com/en-US/free-games').setStyle(ButtonStyle.Link),
            new ButtonBuilder().setLabel('Prime Gaming').setURL('https://gaming.amazon.com/home').setStyle(ButtonStyle.Link),
            new ButtonBuilder().setLabel('GOG Giveaway').setURL('https://www.gog.com/en/partner/free_games').setStyle(ButtonStyle.Link),
            new ButtonBuilder().setLabel('IsThereAnyDeal').setURL('https://isthereanydeal.com/specials/#/filter:&giveaway').setStyle(ButtonStyle.Link),
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
        const region = await dealsRegion(interaction.guildId);
        const res = await fetch(`https://api.isthereanydeal.com/deals/v2?key=${ITAD_KEY}&limit=${limit}&sort=-cut&country=${region}`).then(r => r.json()).catch(() => ({}));
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
            const price = isFree ? '**FREE**' : `**${dealMoney(deal.price)}**`;
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
            const voucher = deal.voucher ? ` 🏷️ \`${deal.voucher}\`` : '';
            return `${medal} ${price} ~~${dealMoney(deal.regular)}~~ (**${deal.cut}% off**) — ${deal.shop.name}${voucher}\n\u2003*${d.title}*`;
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

        embed.setFooter({ text: `Data from IsThereAnyDeal • ${region} prices` });

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
