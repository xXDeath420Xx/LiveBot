/**
 * Grow Command Handlers
 * Handlers for all /grow subcommand groups
 */

import { EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';

// ===== STRAIN HANDLERS =====
export async function handleStrainAdd(interaction) {
    await interaction.deferReply();

    const name = interaction.options.getString('name');
    const breeder = interaction.options.getString('breeder');
    const type = interaction.options.getString('type');
    const flowerDays = interaction.options.getInteger('flower_days');
    const difficulty = interaction.options.getInteger('difficulty');
    const effects = interaction.options.getString('effects') || null;
    const flavors = interaction.options.getString('flavors') || null;
    const thc = interaction.options.getString('thc') || null;
    const notes = interaction.options.getString('notes') || null;

    try {
        const [result] = await pool.execute(
            `INSERT INTO strain_database
            (guild_id, user_id, name, breeder, type, flower_days, difficulty, effects, flavors, thc_range, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [interaction.guild.id, interaction.user.id, name, breeder, type, flowerDays, difficulty, effects, flavors, thc, notes]
        );

        const difficultyStars = '⭐'.repeat(difficulty) + '☆'.repeat(5 - difficulty);
        const typeDisplay = type.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase());

        const embed = new EmbedBuilder()
            .setColor(0x2ECC71)
            .setTitle(`Strain Added: ${name}`)
            .addFields(
                { name: 'Breeder', value: breeder, inline: true },
                { name: 'Type', value: typeDisplay, inline: true },
                { name: 'Flower Time', value: `${flowerDays} days`, inline: true },
                { name: 'Difficulty', value: difficultyStars, inline: true },
                { name: 'THC', value: thc || 'Not specified', inline: true },
                { name: 'Strain ID', value: `#${result.insertId}`, inline: true }
            )
            .setFooter({ text: `Added by ${interaction.user.tag}` })
            .setTimestamp();

        if (effects) embed.addFields({ name: 'Effects', value: effects, inline: false });
        if (flavors) embed.addFields({ name: 'Flavors', value: flavors, inline: false });
        if (notes) embed.addFields({ name: 'Grow Notes', value: notes, inline: false });

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[Strain] Add error:', error);
        await interaction.editReply('Failed to add strain. It may already exist.');
    }
}

export async function handleStrainSearch(interaction) {
    await interaction.deferReply();
    const query = interaction.options.getString('query');

    try {
        const [strains] = await pool.execute(
            `SELECT id, name, breeder, type, flower_days, difficulty
            FROM strain_database
            WHERE (guild_id = ? OR guild_id IS NULL)
            AND (name LIKE ? OR breeder LIKE ?)
            ORDER BY name LIMIT 10`,
            [interaction.guild.id, `%${query}%`, `%${query}%`]
        );

        if (strains.length === 0) {
            return await interaction.editReply(`No strains found matching "${query}". Add one with \`/grow strain add\`!`);
        }

        const embed = new EmbedBuilder()
            .setColor(0x3498DB)
            .setTitle(`Strain Search: "${query}"`)
            .setDescription(strains.map(s => {
                const diffStars = '⭐'.repeat(s.difficulty);
                const typeShort = s.type.charAt(0).toUpperCase();
                return `**#${s.id}** - ${s.name} (${s.breeder})\n${typeShort} | ${s.flower_days}d | ${diffStars}`;
            }).join('\n\n'))
            .setFooter({ text: `Use /grow strain info <id> for details • ${strains.length} result(s)` });

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[Strain] Search error:', error);
        await interaction.editReply('Search failed. Please try again.');
    }
}

export async function handleStrainInfo(interaction) {
    await interaction.deferReply();
    const id = interaction.options.getInteger('id');

    try {
        const [strains] = await pool.execute('SELECT * FROM strain_database WHERE id = ?', [id]);

        if (strains.length === 0) {
            return await interaction.editReply(`No strain found with ID #${id}`);
        }

        const s = strains[0];
        const difficultyStars = '⭐'.repeat(s.difficulty) + '☆'.repeat(5 - s.difficulty);
        const typeDisplay = s.type.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase());

        const embed = new EmbedBuilder()
            .setColor(0x9B59B6)
            .setTitle(`${s.name}`)
            .setDescription(`*by ${s.breeder}*`)
            .addFields(
                { name: 'Type', value: typeDisplay, inline: true },
                { name: 'Flower Time', value: `${s.flower_days} days`, inline: true },
                { name: 'Difficulty', value: difficultyStars, inline: true }
            );

        if (s.thc_range) embed.addFields({ name: 'THC', value: s.thc_range, inline: true });
        if (s.effects) embed.addFields({ name: 'Effects', value: s.effects, inline: false });
        if (s.flavors) embed.addFields({ name: 'Flavors/Terps', value: s.flavors, inline: false });
        if (s.notes) embed.addFields({ name: 'Grow Notes', value: s.notes, inline: false });

        embed.setFooter({ text: `Strain ID: #${s.id}` }).setTimestamp(new Date(s.created_at));
        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[Strain] Info error:', error);
        await interaction.editReply('Failed to get strain info.');
    }
}

export async function handleStrainRandom(interaction) {
    await interaction.deferReply();

    try {
        const [strains] = await pool.execute(
            `SELECT * FROM strain_database WHERE guild_id = ? OR guild_id IS NULL ORDER BY RAND() LIMIT 1`,
            [interaction.guild.id]
        );

        if (strains.length === 0) {
            return await interaction.editReply('No strains in the database yet! Add one with `/grow strain add`');
        }

        const s = strains[0];
        const difficultyStars = '⭐'.repeat(s.difficulty) + '☆'.repeat(5 - s.difficulty);
        const typeDisplay = s.type.replace('_', ' ').replace(/\b\w/g, l => l.toUpperCase());

        const embed = new EmbedBuilder()
            .setColor(0xE91E63)
            .setTitle(`Random Strain: ${s.name}`)
            .setDescription(`*by ${s.breeder}*`)
            .addFields(
                { name: 'Type', value: typeDisplay, inline: true },
                { name: 'Flower Time', value: `${s.flower_days} days`, inline: true },
                { name: 'Difficulty', value: difficultyStars, inline: true }
            );

        if (s.thc_range) embed.addFields({ name: 'THC', value: s.thc_range, inline: true });
        if (s.effects) embed.addFields({ name: 'Effects', value: s.effects, inline: false });
        if (s.flavors) embed.addFields({ name: 'Flavors', value: s.flavors, inline: false });

        embed.setFooter({ text: `Strain ID: #${s.id} • Use /grow strain random for another` });
        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[Strain] Random error:', error);
        await interaction.editReply('Failed to get random strain.');
    }
}

export async function handleStrainTop(interaction) {
    await interaction.deferReply();

    try {
        const [strains] = await pool.execute(
            `SELECT id, name, breeder, type, difficulty, flower_days FROM strain_database
            WHERE guild_id = ? OR guild_id IS NULL ORDER BY created_at DESC LIMIT 10`,
            [interaction.guild.id]
        );

        if (strains.length === 0) {
            return await interaction.editReply('No strains in the database yet!');
        }

        const embed = new EmbedBuilder()
            .setColor(0xF1C40F)
            .setTitle('Recently Added Strains')
            .setDescription(strains.map((s, i) => {
                const diffStars = '⭐'.repeat(s.difficulty);
                return `**${i + 1}.** ${s.name} (${s.breeder}) - ${diffStars}`;
            }).join('\n'))
            .setFooter({ text: 'Use /grow strain search <name> for details' });

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[Strain] Top error:', error);
        await interaction.editReply('Failed to get top strains.');
    }
}

// ===== SEEDBANK HANDLERS =====
export async function handleSeedbankAdd(interaction) {
    await interaction.deferReply();

    const name = interaction.options.getString('name');
    const website = interaction.options.getString('website');
    const shipsTo = interaction.options.getString('ships_to');
    const rating = interaction.options.getInteger('rating');
    const payment = interaction.options.getString('payment') || null;
    const notes = interaction.options.getString('notes') || null;

    try {
        const [result] = await pool.execute(
            `INSERT INTO seedbank_directory (guild_id, user_id, name, website, ships_to, payment_methods, rating, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [interaction.guild.id, interaction.user.id, name, website, shipsTo, payment, rating, notes]
        );

        const ratingStars = '⭐'.repeat(rating) + '☆'.repeat(5 - rating);

        const embed = new EmbedBuilder()
            .setColor(0x2ECC71)
            .setTitle(`Seed Bank Added: ${name}`)
            .addFields(
                { name: 'Website', value: website, inline: false },
                { name: 'Ships To', value: shipsTo, inline: true },
                { name: 'Rating', value: ratingStars, inline: true }
            )
            .setFooter({ text: `Added by ${interaction.user.tag} • ID: #${result.insertId}` })
            .setTimestamp();

        if (payment) embed.addFields({ name: 'Payment Methods', value: payment, inline: false });
        if (notes) embed.addFields({ name: 'Notes', value: notes, inline: false });

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[Seedbank] Add error:', error);
        await interaction.editReply('Failed to add seed bank.');
    }
}

export async function handleSeedbankList(interaction) {
    await interaction.deferReply();

    try {
        const [banks] = await pool.execute(
            `SELECT id, name, website, ships_to, rating FROM seedbank_directory
            WHERE guild_id = ? OR guild_id IS NULL
            GROUP BY name ORDER BY AVG(rating) DESC, name LIMIT 15`,
            [interaction.guild.id]
        );

        if (banks.length === 0) {
            return await interaction.editReply('No seed banks in the directory yet! Add one with `/grow seedbank add`');
        }

        const embed = new EmbedBuilder()
            .setColor(0x3498DB)
            .setTitle('Seed Bank Directory')
            .setDescription(banks.map((b, i) => {
                const stars = '⭐'.repeat(Math.round(b.rating));
                return `**${i + 1}. ${b.name}** ${stars}\n└ ${b.ships_to} • [Website](${b.website})`;
            }).join('\n\n'))
            .setFooter({ text: 'Use /grow seedbank info <id> for details' });

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[Seedbank] List error:', error);
        await interaction.editReply('Failed to list seed banks.');
    }
}

export async function handleSeedbankSearch(interaction) {
    await interaction.deferReply();
    const query = interaction.options.getString('query');

    try {
        const [banks] = await pool.execute(
            `SELECT id, name, website, ships_to, rating FROM seedbank_directory
            WHERE (guild_id = ? OR guild_id IS NULL) AND name LIKE ?
            ORDER BY rating DESC LIMIT 10`,
            [interaction.guild.id, `%${query}%`]
        );

        if (banks.length === 0) {
            return await interaction.editReply(`No seed banks found matching "${query}".`);
        }

        const embed = new EmbedBuilder()
            .setColor(0x3498DB)
            .setTitle(`Seed Bank Search: "${query}"`)
            .setDescription(banks.map(b => {
                const stars = '⭐'.repeat(b.rating);
                return `**#${b.id}** - ${b.name} ${stars}\n└ ${b.ships_to}`;
            }).join('\n\n'))
            .setFooter({ text: `${banks.length} result(s) • Use /grow seedbank info <id> for details` });

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[Seedbank] Search error:', error);
        await interaction.editReply('Search failed.');
    }
}

export async function handleSeedbankInfo(interaction) {
    await interaction.deferReply();
    const id = interaction.options.getInteger('id');

    try {
        const [banks] = await pool.execute('SELECT * FROM seedbank_directory WHERE id = ?', [id]);

        if (banks.length === 0) {
            return await interaction.editReply(`No seed bank found with ID #${id}`);
        }

        const b = banks[0];
        const ratingStars = '⭐'.repeat(b.rating) + '☆'.repeat(5 - b.rating);

        const embed = new EmbedBuilder()
            .setColor(0x9B59B6)
            .setTitle(b.name)
            .addFields(
                { name: 'Website', value: b.website, inline: false },
                { name: 'Ships To', value: b.ships_to, inline: true },
                { name: 'Rating', value: ratingStars, inline: true }
            );

        if (b.payment_methods) embed.addFields({ name: 'Payment', value: b.payment_methods, inline: false });
        if (b.notes) embed.addFields({ name: 'Notes', value: b.notes, inline: false });

        embed.setFooter({ text: `ID: #${b.id}` }).setTimestamp(new Date(b.created_at));
        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[Seedbank] Info error:', error);
        await interaction.editReply('Failed to get seed bank info.');
    }
}

// ===== TIMER HANDLERS =====
export async function handleTimerStart(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const strain = interaction.options.getString('strain');
    const stage = interaction.options.getString('stage');
    const flowerDays = interaction.options.getInteger('flower_days') || 63;

    const today = new Date();
    let flipDate = null;
    let expectedHarvest = null;

    if (stage === 'flower') {
        flipDate = today;
        expectedHarvest = new Date(today.getTime() + (flowerDays * 24 * 60 * 60 * 1000));
    }

    try {
        const [result] = await pool.execute(
            `INSERT INTO grow_timers (guild_id, user_id, strain_name, start_date, flip_date, expected_harvest, stage, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [interaction.guild.id, interaction.user.id, strain, today, flipDate, expectedHarvest, stage, `${flowerDays} day flower expected`]
        );

        const stageEmojis = { seedling: '🌱', veg: '🌿', flower: '🌸' };

        const embed = new EmbedBuilder()
            .setColor(0x2ECC71)
            .setTitle(`${stageEmojis[stage]} Grow Timer Started!`)
            .addFields(
                { name: 'Strain', value: strain, inline: true },
                { name: 'Stage', value: stage.charAt(0).toUpperCase() + stage.slice(1), inline: true },
                { name: 'Grow ID', value: `#${result.insertId}`, inline: true },
                { name: 'Started', value: `<t:${Math.floor(today.getTime() / 1000)}:D>`, inline: true }
            );

        if (expectedHarvest) {
            embed.addFields({
                name: 'Expected Harvest',
                value: `<t:${Math.floor(expectedHarvest.getTime() / 1000)}:D> (<t:${Math.floor(expectedHarvest.getTime() / 1000)}:R>)`,
                inline: false
            });
        }

        embed.setFooter({ text: 'Use /grow timer flip when you switch to flower • /grow timer status to check progress' });
        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[Timer] Start error:', error);
        await interaction.editReply('Failed to start grow timer.');
    }
}

export async function handleTimerFlip(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const growId = interaction.options.getInteger('grow_id');

    try {
        const [grows] = await pool.execute(
            'SELECT * FROM grow_timers WHERE id = ? AND user_id = ?',
            [growId, interaction.user.id]
        );

        if (grows.length === 0) {
            return await interaction.editReply('Grow not found or not yours.');
        }

        const grow = grows[0];
        const today = new Date();

        const flowerDaysMatch = grow.notes?.match(/(\d+)\s*day\s*flower/i);
        const flowerDays = flowerDaysMatch ? parseInt(flowerDaysMatch[1]) : 63;
        const expectedHarvest = new Date(today.getTime() + (flowerDays * 24 * 60 * 60 * 1000));

        await pool.execute(
            'UPDATE grow_timers SET flip_date = ?, expected_harvest = ?, stage = ? WHERE id = ?',
            [today, expectedHarvest, 'flower', growId]
        );

        const vegDays = Math.floor((today - new Date(grow.start_date)) / (1000 * 60 * 60 * 24));

        const embed = new EmbedBuilder()
            .setColor(0xE91E63)
            .setTitle('🌸 Flipped to Flower!')
            .setDescription(`**${grow.strain_name}** is now flowering!`)
            .addFields(
                { name: 'Veg Time', value: `${vegDays} days`, inline: true },
                { name: 'Flip Date', value: `<t:${Math.floor(today.getTime() / 1000)}:D>`, inline: true },
                { name: 'Expected Harvest', value: `<t:${Math.floor(expectedHarvest.getTime() / 1000)}:D> (~${flowerDays} days)`, inline: false }
            )
            .setFooter({ text: 'Good luck! Check trichomes starting around day 50.' });

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[Timer] Flip error:', error);
        await interaction.editReply('Failed to update grow.');
    }
}

export async function handleTimerStatus(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
        const [grows] = await pool.execute(
            `SELECT * FROM grow_timers WHERE user_id = ? AND guild_id = ? AND stage != 'complete' ORDER BY start_date DESC`,
            [interaction.user.id, interaction.guild.id]
        );

        if (grows.length === 0) {
            return await interaction.editReply('No active grows! Start one with `/grow timer start`');
        }

        const stageEmojis = { seedling: '🌱', veg: '🌿', flower: '🌸', harvest: '✂️', complete: '🎉' };

        const embed = new EmbedBuilder()
            .setColor(0x3498DB)
            .setTitle('Your Active Grows')
            .setDescription(grows.map(g => {
                const startDate = new Date(g.start_date);
                const totalDays = Math.floor((Date.now() - startDate) / (1000 * 60 * 60 * 24));

                let flowerDay = '';
                if (g.flip_date) {
                    const flipDate = new Date(g.flip_date);
                    const daysInFlower = Math.floor((Date.now() - flipDate) / (1000 * 60 * 60 * 24));
                    flowerDay = ` (F${daysInFlower})`;
                }

                let harvestInfo = '';
                if (g.expected_harvest) {
                    const harvestDate = new Date(g.expected_harvest);
                    harvestInfo = `\n└ Harvest: <t:${Math.floor(harvestDate.getTime() / 1000)}:R>`;
                }

                return `${stageEmojis[g.stage]} **#${g.id} - ${g.strain_name}**\nDay ${totalDays}${flowerDay} • ${g.stage}${harvestInfo}`;
            }).join('\n\n'))
            .setFooter({ text: '/grow timer flip to mark flower • /grow timer update to change stage' });

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[Timer] Status error:', error);
        await interaction.editReply('Failed to get grow status.');
    }
}

export async function handleTimerUpdate(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const growId = interaction.options.getInteger('grow_id');
    const stage = interaction.options.getString('stage');

    try {
        const [result] = await pool.execute(
            'UPDATE grow_timers SET stage = ? WHERE id = ? AND user_id = ?',
            [stage, growId, interaction.user.id]
        );

        if (result.affectedRows === 0) {
            return await interaction.editReply('Grow not found or not yours.');
        }

        const stageEmojis = { seedling: '🌱', veg: '🌿', flower: '🌸', harvest: '✂️', complete: '🎉' };
        await interaction.editReply(`${stageEmojis[stage]} Grow #${growId} updated to **${stage}**!`);
    } catch (error) {
        console.error('[Timer] Update error:', error);
        await interaction.editReply('Failed to update grow.');
    }
}

export async function handleTimerEnd(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const growId = interaction.options.getInteger('grow_id');

    try {
        const [result] = await pool.execute(
            'DELETE FROM grow_timers WHERE id = ? AND user_id = ?',
            [growId, interaction.user.id]
        );

        if (result.affectedRows === 0) {
            return await interaction.editReply('Grow not found or not yours.');
        }

        await interaction.editReply(`Grow #${growId} removed.`);
    } catch (error) {
        console.error('[Timer] End error:', error);
        await interaction.editReply('Failed to remove grow.');
    }
}

// ===== CALC HANDLERS =====
export async function handleCalcTent(interaction) {
    const sizeInput = interaction.options.getString('size').toLowerCase();

    const match = sizeInput.match(/(\d+(?:\.\d+)?)\s*[x×']\s*(\d+(?:\.\d+)?)/);
    if (!match) {
        return await interaction.reply({ content: 'Invalid tent size format. Use format like `4x4`, `2x4`, `5x5`', ephemeral: true });
    }

    const length = parseFloat(match[1]);
    const width = parseFloat(match[2]);
    const sqft = length * width;

    const minWatts = Math.round(sqft * 30);
    const maxWatts = Math.round(sqft * 40);
    const assumedHeight = 6.5;
    const volume = sqft * assumedHeight;
    const baseCFM = Math.round(volume * 1.5);
    const withFilterCFM = Math.round(baseCFM * 1.25);
    const maxPlants = Math.floor(sqft / 4) || 1;
    const sogPlants = Math.floor(sqft);

    let budgetLow, budgetMid, budgetHigh;
    if (sqft <= 4) { budgetLow = '$300-500'; budgetMid = '$500-800'; budgetHigh = '$800-1200'; }
    else if (sqft <= 9) { budgetLow = '$500-800'; budgetMid = '$800-1200'; budgetHigh = '$1200-2000'; }
    else if (sqft <= 16) { budgetLow = '$800-1200'; budgetMid = '$1200-2000'; budgetHigh = '$2000-3500'; }
    else { budgetLow = '$1500-2500'; budgetMid = '$2500-4000'; budgetHigh = '$4000+'; }

    const embed = new EmbedBuilder()
        .setColor(0x2ECC71)
        .setTitle(`${length}x${width} Tent Setup Guide`)
        .setDescription(`**${sqft} sq ft** grow area`)
        .addFields(
            { name: 'Lighting', value: `**${minWatts}-${maxWatts}W** quality LED\nBudget: Single ${Math.round(sqft * 25)}W+ LED`, inline: false },
            { name: 'Ventilation', value: `**${baseCFM} CFM** minimum\n**${withFilterCFM} CFM** with carbon filter`, inline: false },
            { name: 'Plant Count', value: `**${maxPlants}** with LST/topping\n**${sogPlants}** for SOG style`, inline: true },
            { name: 'Pot Size', value: `3-5 gal for trained\n5-7 gal for natural`, inline: true },
            { name: 'Budget Estimate', value: `Entry: ${budgetLow}\nMid: ${budgetMid}\nPremium: ${budgetHigh}`, inline: false }
        )
        .setFooter({ text: 'Starting recommendations - adjust based on your needs' });

    await interaction.reply({ embeds: [embed] });
}

export async function handleCalcCfm(interaction) {
    const length = interaction.options.getInteger('length');
    const width = interaction.options.getInteger('width');
    const height = interaction.options.getInteger('height');
    const hasFilter = interaction.options.getBoolean('carbon_filter') ?? false;
    const hasHPS = interaction.options.getBoolean('hps_lights') ?? false;

    const volume = length * width * height;
    let multiplier = 1;
    let notes = [];

    if (hasFilter) { multiplier += 0.25; notes.push('Carbon filter: +25%'); }
    if (hasHPS) { multiplier += 0.20; notes.push('HPS/HID heat: +20%'); }

    const minCFM = Math.round(volume * 1 * multiplier);
    const recommendedCFM = Math.round(volume * 1.5 * multiplier);
    const maxCFM = Math.round(volume * 3 * multiplier);

    let fanSize;
    if (recommendedCFM <= 100) fanSize = '4"';
    else if (recommendedCFM <= 250) fanSize = '4"-6"';
    else if (recommendedCFM <= 400) fanSize = '6"';
    else if (recommendedCFM <= 700) fanSize = '6"-8"';
    else fanSize = '8"+';

    const embed = new EmbedBuilder()
        .setColor(0x3498DB)
        .setTitle('Exhaust Fan Calculator')
        .setDescription(`**${length}x${width}x${height}ft** = **${volume} cubic feet**`)
        .addFields(
            { name: 'Minimum CFM', value: `${minCFM} CFM`, inline: true },
            { name: 'Recommended CFM', value: `**${recommendedCFM} CFM**`, inline: true },
            { name: 'Optimal CFM', value: `${maxCFM} CFM`, inline: true },
            { name: 'Fan Size', value: fanSize, inline: true }
        );

    if (notes.length > 0) embed.addFields({ name: 'Adjustments', value: notes.join('\n'), inline: false });
    embed.addFields({ name: 'Tips', value: '• Run exhaust 24/7 for fresh CO2\n• Negative pressure prevents smell leaks', inline: false });

    await interaction.reply({ embeds: [embed] });
}

export async function handleCalcLight(interaction) {
    const sqft = interaction.options.getInteger('sqft');
    const lightType = interaction.options.getString('light_type');

    const wpsfRanges = {
        led: { min: 25, optimal: 35, max: 50, name: 'LED', efficiency: 'High' },
        hps: { min: 40, optimal: 50, max: 65, name: 'HPS/HID', efficiency: 'Medium' },
        cmh: { min: 35, optimal: 45, max: 55, name: 'CMH/LEC', efficiency: 'Medium-High' },
        fluoro: { min: 60, optimal: 80, max: 100, name: 'Fluorescent', efficiency: 'Low' }
    };

    const specs = wpsfRanges[lightType];
    const minWatts = sqft * specs.min;
    const optimalWatts = sqft * specs.optimal;
    const maxWatts = sqft * specs.max;

    const embed = new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle(`${specs.name} Light Calculator`)
        .setDescription(`**${sqft} sq ft** grow area`)
        .addFields(
            { name: 'Minimum', value: `${minWatts}W`, inline: true },
            { name: 'Optimal', value: `**${optimalWatts}W**`, inline: true },
            { name: 'Maximum', value: `${maxWatts}W`, inline: true },
            { name: 'Efficiency', value: specs.efficiency, inline: true },
            { name: 'Hang Height', value: lightType === 'led' ? '12-24"' : '18-36"', inline: true }
        );

    if (lightType === 'led') {
        embed.addFields({ name: 'LED Tips', value: '• Look for Samsung LM301 diodes\n• Full spectrum > blurple', inline: false });
    }

    await interaction.reply({ embeds: [embed] });
}

export async function handleCalcPot(interaction) {
    const medium = interaction.options.getString('medium');
    const style = interaction.options.getString('style');
    const vegWeeks = interaction.options.getInteger('veg_weeks') || 4;

    const styleSizes = {
        sog: { min: 0.5, max: 2, name: 'SOG' },
        natural: { min: 5, max: 10, name: 'Natural' },
        lst: { min: 3, max: 7, name: 'LST/Topped' },
        scrog: { min: 5, max: 15, name: 'SCROG' }
    };

    const mediumMult = {
        soil: { mult: 1, name: 'Soil', note: 'Larger pots = less watering' },
        coco: { mult: 0.7, name: 'Coco', note: 'Can go smaller, feed more often' },
        hydro: { mult: 0.5, name: 'Hydro', note: 'Bucket size less critical' }
    };

    const baseSize = styleSizes[style];
    const mediumInfo = mediumMult[medium];
    const vegMult = 1 + (vegWeeks - 4) * 0.1;

    let minSize = Math.max(Math.round(baseSize.min * mediumInfo.mult * vegMult * 10) / 10, 0.5);
    let maxSize = Math.round(baseSize.max * mediumInfo.mult * vegMult * 10) / 10;

    let transplantGuide;
    if (maxSize <= 3) transplantGuide = 'Solo cup → Final pot';
    else if (maxSize <= 7) transplantGuide = 'Solo cup → 1 gal → Final pot';
    else transplantGuide = 'Solo cup → 1 gal → 3 gal → Final pot';

    const embed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle('Pot Size Calculator')
        .setDescription(`**${mediumInfo.name}** + **${baseSize.name}** style\n${vegWeeks} weeks veg`)
        .addFields(
            { name: 'Recommended Size', value: `**${minSize} - ${maxSize} gallons**`, inline: false },
            { name: 'Medium Notes', value: mediumInfo.note, inline: false },
            { name: 'Transplant Path', value: transplantGuide, inline: false }
        );

    await interaction.reply({ embeds: [embed] });
}

export async function handleCalcYield(interaction) {
    const watts = interaction.options.getInteger('watts');
    const lightType = interaction.options.getString('light_type');
    const skill = interaction.options.getString('skill');

    const gpwRanges = {
        led_good: { low: 1.0, mid: 1.5, high: 2.0, name: 'Quality LED' },
        led_budget: { low: 0.5, mid: 0.8, high: 1.2, name: 'Budget LED' },
        hps: { low: 0.8, mid: 1.0, high: 1.5, name: 'HPS' },
        cmh: { low: 0.9, mid: 1.2, high: 1.5, name: 'CMH/LEC' }
    };

    const skillMult = {
        beginner: { mult: 0.6, name: 'First Grow', tip: 'Focus on keeping plants alive!' },
        intermediate: { mult: 0.85, name: 'A Few Grows', tip: 'Dial in environment and feeding' },
        advanced: { mult: 1.0, name: 'Experienced', tip: 'Optimize VPD, DLI, train heavily' }
    };

    const lightInfo = gpwRanges[lightType];
    const skillInfo = skillMult[skill];

    const lowYield = Math.round(watts * lightInfo.low * skillInfo.mult);
    const midYield = Math.round(watts * lightInfo.mid * skillInfo.mult);
    const highYield = Math.round(watts * lightInfo.high * skillInfo.mult);

    const lowOz = (lowYield / 28.35).toFixed(1);
    const midOz = (midYield / 28.35).toFixed(1);
    const highOz = (highYield / 28.35).toFixed(1);

    const embed = new EmbedBuilder()
        .setColor(0xE91E63)
        .setTitle('Yield Estimator')
        .setDescription(`**${watts}W ${lightInfo.name}**\nSkill: ${skillInfo.name}`)
        .addFields(
            { name: 'Conservative', value: `${lowYield}g (${lowOz} oz)`, inline: true },
            { name: 'Realistic', value: `**${midYield}g (${midOz} oz)**`, inline: true },
            { name: 'Optimistic', value: `${highYield}g (${highOz} oz)`, inline: true },
            { name: 'Tip', value: skillInfo.tip, inline: false }
        )
        .setFooter({ text: 'Actual yield depends on genetics, environment, and technique' });

    await interaction.reply({ embeds: [embed] });
}

// ===== MENTOR HANDLERS =====
export async function handleMentorRegister(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const specialties = interaction.options.getString('specialties');

    try {
        const [existing] = await pool.execute(
            'SELECT * FROM mentors WHERE guild_id = ? AND user_id = ?',
            [interaction.guild.id, interaction.user.id]
        );

        if (existing.length > 0) {
            await pool.execute(
                'UPDATE mentors SET specialties = ? WHERE guild_id = ? AND user_id = ?',
                [specialties, interaction.guild.id, interaction.user.id]
            );
            return await interaction.editReply(`Updated your specialties to: **${specialties}**`);
        }

        await pool.execute(
            'INSERT INTO mentors (guild_id, user_id, specialties) VALUES (?, ?, ?)',
            [interaction.guild.id, interaction.user.id, specialties]
        );

        const embed = new EmbedBuilder()
            .setColor(0x2ECC71)
            .setTitle('Mentor Registered!')
            .setDescription(`Thank you for volunteering to help fellow growers!`)
            .addFields(
                { name: 'Specialties', value: specialties, inline: false },
                { name: 'Status', value: 'Available', inline: true }
            )
            .setFooter({ text: 'Use /grow mentor status to toggle availability' });

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[Mentor] Register error:', error);
        await interaction.editReply('Failed to register as mentor.');
    }
}

export async function handleMentorList(interaction) {
    await interaction.deferReply();

    try {
        const [mentors] = await pool.execute(
            `SELECT * FROM mentors WHERE guild_id = ? AND available = 1 ORDER BY mentee_count ASC, created_at ASC`,
            [interaction.guild.id]
        );

        if (mentors.length === 0) {
            return await interaction.editReply('No mentors available. Be the first with `/grow mentor register`!');
        }

        const mentorList = await Promise.all(mentors.map(async (m, i) => {
            const member = await interaction.guild.members.fetch(m.user_id).catch(() => null);
            const name = member?.displayName || 'Unknown';
            return `**${i + 1}. ${name}**\n└ ${m.specialties}`;
        }));

        const embed = new EmbedBuilder()
            .setColor(0x3498DB)
            .setTitle('Available Mentors')
            .setDescription(mentorList.join('\n\n'))
            .setFooter({ text: 'DM a mentor or use /grow mentor find <topic>' });

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[Mentor] List error:', error);
        await interaction.editReply('Failed to list mentors.');
    }
}

export async function handleMentorFind(interaction) {
    await interaction.deferReply();
    const topic = interaction.options.getString('topic').toLowerCase();

    try {
        const [mentors] = await pool.execute(
            `SELECT * FROM mentors WHERE guild_id = ? AND available = 1 AND LOWER(specialties) LIKE ? ORDER BY mentee_count ASC LIMIT 5`,
            [interaction.guild.id, `%${topic}%`]
        );

        if (mentors.length === 0) {
            const [anyMentors] = await pool.execute(
                `SELECT * FROM mentors WHERE guild_id = ? AND available = 1 LIMIT 3`,
                [interaction.guild.id]
            );

            if (anyMentors.length === 0) {
                return await interaction.editReply(`No mentors found for "${topic}". None available.`);
            }

            const mentorList = await Promise.all(anyMentors.map(async m => {
                const member = await interaction.guild.members.fetch(m.user_id).catch(() => null);
                return member ? `• ${member} - ${m.specialties}` : null;
            }));

            return await interaction.editReply({
                content: `No mentors specialize in "${topic}", but these are available:\n\n${mentorList.filter(Boolean).join('\n')}`
            });
        }

        const mentorList = await Promise.all(mentors.map(async m => {
            const member = await interaction.guild.members.fetch(m.user_id).catch(() => null);
            return member ? `• ${member} - ${m.specialties}` : null;
        }));

        const embed = new EmbedBuilder()
            .setColor(0x9B59B6)
            .setTitle(`Mentors for: ${topic}`)
            .setDescription(mentorList.filter(Boolean).join('\n'))
            .setFooter({ text: 'Send them a DM to start learning!' });

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[Mentor] Find error:', error);
        await interaction.editReply('Search failed.');
    }
}

export async function handleMentorStatus(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
        const [mentors] = await pool.execute(
            'SELECT * FROM mentors WHERE guild_id = ? AND user_id = ?',
            [interaction.guild.id, interaction.user.id]
        );

        if (mentors.length === 0) {
            return await interaction.editReply('You\'re not registered as a mentor. Use `/grow mentor register` first!');
        }

        const newStatus = mentors[0].available ? 0 : 1;

        await pool.execute(
            'UPDATE mentors SET available = ? WHERE guild_id = ? AND user_id = ?',
            [newStatus, interaction.guild.id, interaction.user.id]
        );

        const statusText = newStatus ? 'Available' : 'Unavailable';
        await interaction.editReply(`Your mentor status is now: **${statusText}**`);
    } catch (error) {
        console.error('[Mentor] Status error:', error);
        await interaction.editReply('Failed to update status.');
    }
}

export async function handleMentorUnregister(interaction) {
    await interaction.deferReply({ ephemeral: true });

    try {
        const [result] = await pool.execute(
            'DELETE FROM mentors WHERE guild_id = ? AND user_id = ?',
            [interaction.guild.id, interaction.user.id]
        );

        if (result.affectedRows === 0) {
            return await interaction.editReply('You\'re not registered as a mentor.');
        }

        await interaction.editReply('You\'ve been removed from the mentor list. Thanks for your help!');
    } catch (error) {
        console.error('[Mentor] Unregister error:', error);
        await interaction.editReply('Failed to unregister.');
    }
}

// ===== COMPETITION HANDLERS =====
import { PermissionFlagsBits } from 'discord.js';

export async function handleCompetitionCreate(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        return await interaction.reply({ content: 'You need Manage Messages permission to create competitions.', ephemeral: true });
    }

    await interaction.deferReply();

    const title = interaction.options.getString('title');
    const days = interaction.options.getInteger('days');
    const description = interaction.options.getString('description') || 'Share your best grow photos!';

    const endDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    try {
        const [existing] = await pool.execute(
            'SELECT * FROM grow_competitions WHERE guild_id = ? AND is_active = 1',
            [interaction.guild.id]
        );

        if (existing.length > 0) {
            return await interaction.editReply('There\'s already an active competition. End it first with `/grow competition end`');
        }

        const [result] = await pool.execute(
            `INSERT INTO grow_competitions (guild_id, channel_id, title, description, end_date) VALUES (?, ?, ?, ?, ?)`,
            [interaction.guild.id, interaction.channel.id, title, description, endDate]
        );

        const embed = new EmbedBuilder()
            .setColor(0xF1C40F)
            .setTitle(title)
            .setDescription(description)
            .addFields(
                { name: 'How to Enter', value: 'Use `/grow competition enter` with your best photo!', inline: false },
                { name: 'Ends', value: `<t:${Math.floor(endDate.getTime() / 1000)}:R>`, inline: true },
                { name: 'Competition ID', value: `#${result.insertId}`, inline: true }
            )
            .setFooter({ text: 'Good luck everyone!' })
            .setTimestamp();

        const message = await interaction.editReply({ embeds: [embed] });

        await pool.execute('UPDATE grow_competitions SET message_id = ? WHERE id = ?', [message.id, result.insertId]);
    } catch (error) {
        console.error('[Competition] Create error:', error);
        await interaction.editReply('Failed to create competition.');
    }
}

export async function handleCompetitionEnter(interaction) {
    await interaction.deferReply();

    const photo = interaction.options.getAttachment('photo');
    const description = interaction.options.getString('description') || '';

    if (!photo.contentType?.startsWith('image/')) {
        return await interaction.editReply('Please upload an image file.');
    }

    try {
        const [competitions] = await pool.execute(
            'SELECT * FROM grow_competitions WHERE guild_id = ? AND is_active = 1',
            [interaction.guild.id]
        );

        if (competitions.length === 0) {
            return await interaction.editReply('No active competition right now. Check back later!');
        }

        const comp = competitions[0];

        const [existing] = await pool.execute(
            'SELECT * FROM competition_entries WHERE competition_id = ? AND user_id = ?',
            [comp.id, interaction.user.id]
        );

        if (existing.length > 0) {
            await pool.execute(
                'UPDATE competition_entries SET image_url = ?, description = ? WHERE competition_id = ? AND user_id = ?',
                [photo.url, description, comp.id, interaction.user.id]
            );
            return await interaction.editReply('Your entry has been updated!');
        }

        await pool.execute(
            'INSERT INTO competition_entries (competition_id, user_id, image_url, description) VALUES (?, ?, ?, ?)',
            [comp.id, interaction.user.id, photo.url, description]
        );

        const embed = new EmbedBuilder()
            .setColor(0x2ECC71)
            .setTitle('Entry Submitted!')
            .setDescription(`You've entered **${comp.title}**`)
            .setImage(photo.url)
            .setFooter({ text: 'Good luck!' });

        if (description) embed.addFields({ name: 'Description', value: description, inline: false });

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[Competition] Enter error:', error);
        await interaction.editReply('Failed to submit entry.');
    }
}

export async function handleCompetitionView(interaction) {
    await interaction.deferReply();

    try {
        const [competitions] = await pool.execute(
            'SELECT * FROM grow_competitions WHERE guild_id = ? AND is_active = 1',
            [interaction.guild.id]
        );

        if (competitions.length === 0) {
            return await interaction.editReply('No active competition right now. Stay tuned!');
        }

        const comp = competitions[0];

        const [entries] = await pool.execute(
            'SELECT COUNT(*) as count FROM competition_entries WHERE competition_id = ?',
            [comp.id]
        );

        const embed = new EmbedBuilder()
            .setColor(0xF1C40F)
            .setTitle(comp.title)
            .setDescription(comp.description)
            .addFields(
                { name: 'Entries', value: `${entries[0].count} submitted`, inline: true },
                { name: 'Ends', value: `<t:${Math.floor(new Date(comp.end_date).getTime() / 1000)}:R>`, inline: true },
                { name: 'How to Enter', value: '`/grow competition enter` with your photo', inline: false }
            )
            .setFooter({ text: `Competition #${comp.id}` });

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[Competition] View error:', error);
        await interaction.editReply('Failed to load competition.');
    }
}

export async function handleCompetitionEntries(interaction) {
    await interaction.deferReply();

    try {
        const [competitions] = await pool.execute(
            'SELECT * FROM grow_competitions WHERE guild_id = ? AND is_active = 1',
            [interaction.guild.id]
        );

        if (competitions.length === 0) {
            return await interaction.editReply('No active competition right now.');
        }

        const comp = competitions[0];

        const [entries] = await pool.execute(
            'SELECT * FROM competition_entries WHERE competition_id = ? ORDER BY created_at ASC',
            [comp.id]
        );

        if (entries.length === 0) {
            return await interaction.editReply('No entries yet! Be the first with `/grow competition enter`');
        }

        const entryList = await Promise.all(entries.slice(0, 10).map(async (e, i) => {
            const member = await interaction.guild.members.fetch(e.user_id).catch(() => null);
            const name = member?.displayName || 'Unknown';
            return `**${i + 1}.** ${name}${e.description ? ` - "${e.description.slice(0, 50)}"` : ''}`;
        }));

        const embed = new EmbedBuilder()
            .setColor(0x9B59B6)
            .setTitle(`Entries for: ${comp.title}`)
            .setDescription(entryList.join('\n'))
            .setFooter({ text: `${entries.length} total entries` });

        if (entries[0]?.image_url) embed.setThumbnail(entries[0].image_url);

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[Competition] Entries error:', error);
        await interaction.editReply('Failed to load entries.');
    }
}

export async function handleCompetitionEnd(interaction) {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        return await interaction.reply({ content: 'You need Manage Messages permission to end competitions.', ephemeral: true });
    }

    await interaction.deferReply();

    try {
        const [competitions] = await pool.execute(
            'SELECT * FROM grow_competitions WHERE guild_id = ? AND is_active = 1',
            [interaction.guild.id]
        );

        if (competitions.length === 0) {
            return await interaction.editReply('No active competition to end.');
        }

        const comp = competitions[0];

        const [entries] = await pool.execute(
            'SELECT * FROM competition_entries WHERE competition_id = ? ORDER BY votes DESC, RAND() LIMIT 3',
            [comp.id]
        );

        await pool.execute(
            'UPDATE grow_competitions SET is_active = 0, winner_user_id = ? WHERE id = ?',
            [entries[0]?.user_id || null, comp.id]
        );

        if (entries.length === 0) {
            return await interaction.editReply(`**${comp.title}** has ended with no entries!`);
        }

        const winner = await interaction.guild.members.fetch(entries[0].user_id).catch(() => null);

        const embed = new EmbedBuilder()
            .setColor(0xF1C40F)
            .setTitle(`${comp.title} - Results!`)
            .setDescription(`Congratulations to our winner!`)
            .addFields({ name: 'Winner', value: winner ? `${winner}` : 'Unknown member', inline: false })
            .setImage(entries[0].image_url)
            .setTimestamp();

        if (entries.length > 1) {
            const second = await interaction.guild.members.fetch(entries[1].user_id).catch(() => null);
            embed.addFields({ name: 'Second Place', value: second?.displayName || 'Unknown', inline: true });
        }
        if (entries.length > 2) {
            const third = await interaction.guild.members.fetch(entries[2].user_id).catch(() => null);
            embed.addFields({ name: 'Third Place', value: third?.displayName || 'Unknown', inline: true });
        }

        embed.addFields({ name: 'Total Entries', value: `${entries.length}`, inline: false });

        await interaction.editReply({ embeds: [embed] });
    } catch (error) {
        console.error('[Competition] End error:', error);
        await interaction.editReply('Failed to end competition.');
    }
}

// ===== TIP HANDLER =====
const categoryEmojis = {
    watering: '💧', nutrients: '🧪', environment: '🌡️', lighting: '💡', training: '✂️',
    harvest: '🌿', drying: '🍂', curing: '🫙', ph: '📊', genetics: '🧬'
};

const categoryColors = {
    watering: 0x3498DB, nutrients: 0x9B59B6, environment: 0xE74C3C, lighting: 0xF1C40F, training: 0x2ECC71,
    harvest: 0x1ABC9C, drying: 0xE67E22, curing: 0x95A5A6, ph: 0x34495E, genetics: 0xE91E63
};

export async function handleTip(interaction) {
    const category = interaction.options.getString('category');

    try {
        let query = 'SELECT * FROM grow_tips';
        let params = [];

        if (category) {
            query += ' WHERE category = ?';
            params.push(category);
        }

        query += ' ORDER BY RAND() LIMIT 1';

        const [tips] = await pool.execute(query, params);

        if (tips.length === 0) {
            return await interaction.reply({
                content: category ? `No tips found in the ${category} category.` : 'No tips in the database yet!',
                ephemeral: true
            });
        }

        const tip = tips[0];
        const emoji = categoryEmojis[tip.category] || '🌱';
        const color = categoryColors[tip.category] || 0x2ECC71;

        const embed = new EmbedBuilder()
            .setColor(color)
            .setTitle(`${emoji} ${tip.title}`)
            .setDescription(tip.content)
            .addFields({ name: 'Category', value: tip.category.charAt(0).toUpperCase() + tip.category.slice(1), inline: true })
            .setFooter({ text: 'Run /grow tip again for another tip!' });

        await interaction.reply({ embeds: [embed] });
    } catch (error) {
        console.error('[GrowTip] Error:', error);
        await interaction.reply({ content: 'Failed to get grow tip.', ephemeral: true });
    }
}
