import { EmbedBuilder } from 'discord.js';
import pool from '../../utils/db.js';

// Helper function
function pickRandom(array) {
  return array[Math.floor(Math.random() * array.length)];
}

// Battle event generator
function generateBattleEvent(players, weapons, locations) {
  const eventTypes = [
    { type: 'elimination', weight: 40 },
    { type: 'combat', weight: 30 },
    { type: 'discovery', weight: 20 },
    { type: 'survival', weight: 10 }
  ];

  const totalWeight = eventTypes.reduce((sum, e) => sum + e.weight, 0);
  let random = Math.random() * totalWeight;
  let selectedType = eventTypes[0].type;

  for (const event of eventTypes) {
    if (random < event.weight) {
      selectedType = event.type;
      break;
    }
    random -= event.weight;
  }

  const p1 = pickRandom(players);
  const p2 = pickRandom(players.filter(p => p !== p1));
  const weapon = pickRandom(weapons);
  const location = pickRandom(locations);

  switch (selectedType) {
    case 'elimination':
      const eliminationTexts = [
        `${p1} defeats ${p2} in combat at the ${location}!`,
        `${p2} falls to ${p1}'s ${weapon}!`,
        `${p1} ambushes ${p2} from the shadows!`,
        `${p2} is eliminated by ${p1}'s clever trap!`,
        `${p1} outmaneuvers ${p2} and claims victory!`
      ];
      return {
        text: pickRandom(eliminationTexts),
        eliminated: p2
      };

    case 'combat':
      const combatTexts = [
        `${p1} and ${p2} clash near the ${location}, both survive.`,
        `${p1} throws a ${weapon} at ${p2}, narrowly missing!`,
        `${p1} and ${p2} exchange blows but retreat to heal.`
      ];
      return { text: pickRandom(combatTexts), eliminated: null };

    case 'discovery':
      const discoveryTexts = [
        `${p1} discovers a legendary ${weapon} in the ${location}.`,
        `${p1} finds a safe haven in the ${location}.`,
        `${p1} uncovers a secret passage through the ${location}.`
      ];
      return { text: pickRandom(discoveryTexts), eliminated: null };

    case 'survival':
      const survivalTexts = [
        `${p1} barely escapes the closing storm.`,
        `${p1} uses quick thinking to survive a trap.`,
        `${p1} finds supplies just in time.`
      ];
      return { text: pickRandom(survivalTexts), eliminated: null };

    default:
      return { text: `${p1} survives another round.`, eliminated: null };
  }
}

// Card generator
function generateCard(rarityChoice) {
  const cardTypes = ['Warrior', 'Mage', 'Rogue', 'Paladin', 'Druid', 'Necromancer', 'Beast', 'Dragon', 'Elemental', 'Artifact'];

  // Determine rarity based on choice and RNG
  let rarity;
  const rand = Math.random() * 100;

  if (rarityChoice === 'legendary') {
    rarity = 'legendary';
  } else if (rarityChoice === 'epic') {
    rarity = rand < 20 ? 'legendary' : rand < 70 ? 'epic' : 'rare';
  } else if (rarityChoice === 'rare') {
    rarity = rand < 5 ? 'legendary' : rand < 20 ? 'epic' : rand < 70 ? 'rare' : 'uncommon';
  } else {
    // Any rarity
    if (rand < 1) rarity = 'mythic';
    else if (rand < 5) rarity = 'legendary';
    else if (rand < 15) rarity = 'epic';
    else if (rand < 35) rarity = 'rare';
    else if (rand < 65) rarity = 'uncommon';
    else rarity = 'common';
  }

  const rarityMultipliers = {
    common: { min: 10, max: 30 },
    uncommon: { min: 30, max: 60 },
    rare: { min: 60, max: 100 },
    epic: { min: 100, max: 150 },
    legendary: { min: 150, max: 200 },
    mythic: { min: 200, max: 300 }
  };

  const type = pickRandom(cardTypes);
  const multiplier = rarityMultipliers[rarity];
  const power = Math.floor(Math.random() * (multiplier.max - multiplier.min + 1)) + multiplier.min;

  const names = {
    Warrior: ['Blade', 'Iron', 'Steel', 'Battle', 'War', 'Sword', 'Shield', 'Valor'],
    Mage: ['Arcane', 'Mystic', 'Crystal', 'Storm', 'Flame', 'Frost', 'Shadow', 'Light'],
    Rogue: ['Shadow', 'Silent', 'Swift', 'Stealth', 'Night', 'Dagger', 'Venom', 'Ghost'],
    Paladin: ['Holy', 'Divine', 'Sacred', 'Righteous', 'Blessed', 'Radiant', 'Pure', 'Noble'],
    Druid: ['Nature', 'Wild', 'Ancient', 'Forest', 'Earth', 'Vine', 'Root', 'Grove'],
    Necromancer: ['Death', 'Bone', 'Soul', 'Grave', 'Undead', 'Dark', 'Curse', 'Reaper'],
    Beast: ['Savage', 'Primal', 'Feral', 'Wild', 'Alpha', 'Dire', 'Great', 'Elder'],
    Dragon: ['Ancient', 'Sky', 'Fire', 'Storm', 'Elder', 'Wyrm', 'Crimson', 'Azure'],
    Elemental: ['Flame', 'Frost', 'Storm', 'Earth', 'Void', 'Primal', 'Pure', 'Eternal'],
    Artifact: ['Ancient', 'Legendary', 'Cursed', 'Blessed', 'Mystical', 'Eternal', 'Forgotten', 'Lost']
  };

  const suffixes = ['of Power', 'of Destiny', 'of the Ancients', 'of Legends', 'of Eternity',
                    'of the Storm', 'of Fire', 'of Ice', 'of Shadows', 'of Light'];

  const prefix = pickRandom(names[type] || names.Warrior);
  const suffix = rarity !== 'common' ? ' ' + pickRandom(suffixes) : '';
  const cardName = `${prefix} ${type}${suffix}`;

  const descriptions = {
    common: 'A common card found throughout the realm.',
    uncommon: 'An uncommon find with decent power.',
    rare: 'A rare and valuable addition to any collection.',
    epic: 'An epic card of tremendous power!',
    legendary: 'A legendary card of immense power! Few possess such treasures.',
    mythic: 'A MYTHIC card of unimaginable power! This is an extremely rare find!'
  };

  return {
    name: cardName,
    type: type,
    rarity: rarity,
    power: power,
    description: descriptions[rarity]
  };
}

// Trivia question getter
function getTriviaQuestion(category) {
  const questions = {
    general: [
      {
        category: 'General Knowledge',
        question: 'What is the only mammal capable of true flight?',
        answer: 'Bats',
        hint: 'They navigate using echolocation',
        explanation: 'Bats are the only mammals naturally capable of sustained flight. Flying squirrels only glide!',
        difficulty: 'Medium'
      },
      {
        category: 'General Knowledge',
        question: 'How many hearts does an octopus have?',
        answer: 'Three hearts',
        hint: 'More than you!',
        explanation: 'Octopuses have three hearts: two pump blood to the gills, one pumps it to the rest of the body.',
        difficulty: 'Medium'
      },
      {
        category: 'General Knowledge',
        question: 'What is the smallest country in the world?',
        answer: 'Vatican City',
        hint: 'It\'s in Rome',
        explanation: 'Vatican City is the smallest country, measuring just 0.44 square kilometers (110 acres).',
        difficulty: 'Medium'
      }
    ],
    science: [
      {
        category: 'Science',
        question: 'What is the speed of light in a vacuum?',
        answer: '299,792,458 meters per second (approximately 300,000 km/s)',
        hint: 'About 300,000 km/s',
        explanation: 'The speed of light in a vacuum is exactly 299,792,458 m/s, denoted by the symbol "c".',
        difficulty: 'Hard'
      },
      {
        category: 'Science',
        question: 'What is the most abundant element in the universe?',
        answer: 'Hydrogen',
        hint: 'It\'s the first element on the periodic table',
        explanation: 'Hydrogen is the most abundant element in the universe, making up about 75% of all matter.',
        difficulty: 'Medium'
      },
      {
        category: 'Science',
        question: 'How many bones are in the adult human body?',
        answer: '206 bones',
        hint: 'Over 200',
        explanation: 'Adults have 206 bones. Babies are born with about 270 bones, but many fuse together as we grow.',
        difficulty: 'Medium'
      }
    ],
    history: [
      {
        category: 'History',
        question: 'In what year did World War II end?',
        answer: '1945',
        hint: 'Mid-1940s',
        explanation: 'World War II ended in 1945, with Germany surrendering in May and Japan in September.',
        difficulty: 'Medium'
      },
      {
        category: 'History',
        question: 'Who was the first person to walk on the moon?',
        answer: 'Neil Armstrong',
        hint: 'It happened in 1969',
        explanation: 'Neil Armstrong became the first human to walk on the moon on July 20, 1969, during the Apollo 11 mission.',
        difficulty: 'Easy'
      },
      {
        category: 'History',
        question: 'What ancient wonder of the world still stands today?',
        answer: 'The Great Pyramid of Giza',
        hint: 'It\'s in Egypt',
        explanation: 'The Great Pyramid of Giza is the oldest and only remaining ancient wonder of the world.',
        difficulty: 'Medium'
      }
    ],
    geography: [
      {
        category: 'Geography',
        question: 'What is the longest river in the world?',
        answer: 'The Nile River',
        hint: 'It\'s in Africa',
        explanation: 'The Nile River is the longest river in the world at approximately 6,650 km (4,130 miles).',
        difficulty: 'Medium'
      },
      {
        category: 'Geography',
        question: 'What is the tallest mountain in the world?',
        answer: 'Mount Everest',
        hint: 'It\'s in the Himalayas',
        explanation: 'Mount Everest stands at 8,848.86 meters (29,031.7 feet) above sea level.',
        difficulty: 'Easy'
      },
      {
        category: 'Geography',
        question: 'Which desert is the largest hot desert in the world?',
        answer: 'The Sahara Desert',
        hint: 'It\'s in Africa',
        explanation: 'The Sahara is the largest hot desert, covering approximately 9 million square kilometers.',
        difficulty: 'Medium'
      }
    ],
    popculture: [
      {
        category: 'Pop Culture',
        question: 'What is the highest-grossing film of all time?',
        answer: 'Avatar (2009)',
        hint: 'It\'s a blue alien movie',
        explanation: 'Avatar (2009) is the highest-grossing film of all time, earning over $2.9 billion worldwide.',
        difficulty: 'Medium'
      },
      {
        category: 'Pop Culture',
        question: 'Who is known as the "King of Pop"?',
        answer: 'Michael Jackson',
        hint: 'Moonwalk master',
        explanation: 'Michael Jackson earned the title "King of Pop" for his revolutionary impact on music and entertainment.',
        difficulty: 'Easy'
      },
      {
        category: 'Pop Culture',
        question: 'What year did the first iPhone release?',
        answer: '2007',
        hint: 'Late 2000s',
        explanation: 'The first iPhone was released by Apple on June 29, 2007, revolutionizing smartphones.',
        difficulty: 'Medium'
      }
    ]
  };

  const categoryQuestions = questions[category] || questions.general;
  return pickRandom(categoryQuestions);
}

// Handler functions
export async function handleBattle(interaction) {
  await interaction.deferReply();

  const playerCount = interaction.options.getInteger('players') || 10;
  const userName = interaction.user.username;

  // Generate player names
  const names = ['Shadow', 'Phoenix', 'Blade', 'Storm', 'Raven', 'Ghost', 'Viper', 'Wolf',
                 'Titan', 'Dragon', 'Hawk', 'Frost', 'Blaze', 'Thunder', 'Reaper',
                 'Venom', 'Wraith', 'Stealth', 'Fury', 'Chaos'];

  let players = [userName];
  for (let i = 1; i < playerCount; i++) {
    const randomName = names[Math.floor(Math.random() * names.length)] + Math.floor(Math.random() * 100);
    players.push(randomName);
  }

  // Shuffle players
  players = players.sort(() => Math.random() - 0.5);

  const events = [];
  const weapons = ['sword', 'bow', 'axe', 'spear', 'dagger', 'crossbow', 'mace', 'staff'];
  const items = ['healing potion', 'shield', 'armor', 'trap', 'smoke bomb'];
  const locations = ['forest', 'mountain', 'ruins', 'cave', 'lake', 'bridge', 'tower', 'village'];

  events.push(`**BATTLE ROYALE - ${playerCount} Players Enter!**`);
  events.push(`The arena is set. ${playerCount} warriors prepare for battle.\n`);

  // Initial scramble
  const initialEvents = [
    `${pickRandom(players)} grabs a ${pickRandom(weapons)}!`,
    `${pickRandom(players)} finds ${pickRandom(items)} in the ${pickRandom(locations)}.`,
    `${pickRandom(players)} and ${pickRandom(players)} form a temporary alliance.`,
    `${pickRandom(players)} hides in the ${pickRandom(locations)}.`
  ];
  events.push('**Initial Scramble:**');
  initialEvents.forEach(e => events.push(`- ${e}`));
  events.push('');

  // Battle rounds
  let round = 1;
  while (players.length > 1) {
    events.push(`**Round ${round}** - ${players.length} remaining`);

    const roundEvents = Math.min(3, Math.ceil(players.length / 3));

    for (let i = 0; i < roundEvents && players.length > 1; i++) {
      const event = generateBattleEvent(players, weapons, locations);
      events.push(`- ${event.text}`);

      if (event.eliminated) {
        players = players.filter(p => p !== event.eliminated);
      }
    }

    events.push('');
    round++;

    if (round > 10) break; // Safety limit
  }

  // Winner
  const winner = players[0];
  const isUserWinner = winner === userName;

  events.push(`\n**VICTORY!**`);
  events.push(isUserWinner
    ? `**${winner}** is the champion! You survived the battle royale!`
    : `**${winner}** is the champion! Better luck next time!`);

  const embed = new EmbedBuilder()
    .setColor(isUserWinner ? '#FFD700' : '#C0C0C0')
    .setTitle('Battle Royale Results')
    .setDescription(events.join('\n'))
    .setFooter({ text: `${playerCount} entered, 1 survived` })
    .setTimestamp();

  return interaction.editReply({ embeds: [embed] });
}

export async function handleCardPull(interaction) {
  await interaction.deferReply();

  const rarityChoice = interaction.options.getString('rarity') || 'any';
  const userId = interaction.user.id;
  const guildId = interaction.guild.id;

  try {
    // Create tables if they don't exist
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS card_collection (
        id INT AUTO_INCREMENT PRIMARY KEY,
        guild_id VARCHAR(20) NOT NULL,
        user_id VARCHAR(20) NOT NULL,
        card_name VARCHAR(255) NOT NULL,
        card_type VARCHAR(50) NOT NULL,
        rarity VARCHAR(20) NOT NULL,
        power INT NOT NULL,
        description TEXT,
        collected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_cards (guild_id, user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS card_energy (
        guild_id VARCHAR(20) NOT NULL,
        user_id VARCHAR(20) NOT NULL,
        energy INT DEFAULT 10,
        last_refill TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (guild_id, user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Get or create user energy
    let [[energy]] = await pool.execute(
      'SELECT energy, last_refill FROM card_energy WHERE guild_id = ? AND user_id = ?',
      [guildId, userId]
    );

    if (!energy) {
      await pool.execute(
        'INSERT INTO card_energy (guild_id, user_id, energy) VALUES (?, ?, 10)',
        [guildId, userId]
      );
      energy = { energy: 10, last_refill: new Date() };
    } else {
      // Refill energy (1 per hour, max 10)
      const hoursSinceRefill = (Date.now() - new Date(energy.last_refill).getTime()) / (1000 * 60 * 60);
      const refillAmount = Math.min(10 - energy.energy, Math.floor(hoursSinceRefill));

      if (refillAmount > 0) {
        energy.energy = Math.min(10, energy.energy + refillAmount);
        await pool.execute(
          'UPDATE card_energy SET energy = ?, last_refill = NOW() WHERE guild_id = ? AND user_id = ?',
          [energy.energy, guildId, userId]
        );
      }
    }

    // Check energy cost
    const energyCosts = { any: 1, rare: 3, epic: 5, legendary: 10 };
    const cost = energyCosts[rarityChoice];

    if (energy.energy < cost) {
      return interaction.editReply({
        content: `Not enough energy! You have ${energy.energy}/10, but need ${cost}.\nEnergy refills 1 per hour (max 10).`
      });
    }

    // Generate card based on rarity choice
    const card = generateCard(rarityChoice);

    // Deduct energy
    await pool.execute(
      'UPDATE card_energy SET energy = energy - ? WHERE guild_id = ? AND user_id = ?',
      [cost, guildId, userId]
    );

    // Add card to collection
    const [result] = await pool.execute(
      'INSERT INTO card_collection (guild_id, user_id, card_name, card_type, rarity, power, description) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [guildId, userId, card.name, card.type, card.rarity, card.power, card.description]
    );

    const rarityColors = {
      common: '#95A5A6',
      uncommon: '#2ECC71',
      rare: '#3498DB',
      epic: '#9B59B6',
      legendary: '#F1C40F',
      mythic: '#E74C3C'
    };

    const rarityEmojis = {
      common: 'Common',
      uncommon: 'Uncommon',
      rare: 'Rare',
      epic: 'Epic',
      legendary: 'Legendary',
      mythic: 'MYTHIC'
    };

    const embed = new EmbedBuilder()
      .setColor(rarityColors[card.rarity])
      .setTitle(`${card.name}`)
      .setDescription(card.description)
      .addFields(
        { name: 'Type', value: card.type, inline: true },
        { name: 'Rarity', value: rarityEmojis[card.rarity], inline: true },
        { name: 'Power', value: card.power.toString(), inline: true },
        { name: 'Card ID', value: `#${result.insertId}`, inline: true },
        { name: 'Energy Remaining', value: `${energy.energy - cost}/10`, inline: true }
      )
      .setFooter({ text: 'Use /fun games collection to view all your cards' })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });

  } catch (error) {
    console.error('[Card Pull Error]', error);
    return interaction.editReply({
      content: 'Failed to pull card. Please try again later.'
    });
  }
}

export async function handleCollection(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const userId = interaction.user.id;
  const guildId = interaction.guild.id;

  try {
    // Get user's cards
    const [cards] = await pool.execute(
      'SELECT id, card_name, card_type, rarity, power, collected_at FROM card_collection WHERE guild_id = ? AND user_id = ? ORDER BY power DESC, collected_at DESC LIMIT 20',
      [guildId, userId]
    );

    // Get energy
    const [[energy]] = await pool.execute(
      'SELECT energy FROM card_energy WHERE guild_id = ? AND user_id = ?',
      [guildId, userId]
    );

    if (!cards || cards.length === 0) {
      return interaction.editReply({
        content: 'Your collection is empty! Use `/fun games cardpull` to start collecting cards.'
      });
    }

    // Calculate stats
    const totalCards = cards.length;
    const totalPower = cards.reduce((sum, card) => sum + card.power, 0);
    const avgPower = Math.round(totalPower / totalCards);

    const rarityCounts = cards.reduce((acc, card) => {
      acc[card.rarity] = (acc[card.rarity] || 0) + 1;
      return acc;
    }, {});

    const rarityLabels = {
      common: 'Common',
      uncommon: 'Uncommon',
      rare: 'Rare',
      epic: 'Epic',
      legendary: 'Legendary',
      mythic: 'Mythic'
    };

    const embed = new EmbedBuilder()
      .setColor('#3498DB')
      .setTitle(`${interaction.user.username}'s Card Collection`)
      .setDescription(`You have collected ${totalCards} cards with a total power of ${totalPower}!`)
      .addFields(
        {
          name: 'Collection Stats',
          value: `**Total Cards:** ${totalCards}\n**Average Power:** ${avgPower}\n**Energy:** ${energy?.energy || 0}/10`,
          inline: true
        },
        {
          name: 'Rarity Breakdown',
          value: Object.entries(rarityCounts)
            .map(([rarity, count]) => `${rarityLabels[rarity]}: ${count}`)
            .join('\n') || 'No cards yet',
          inline: true
        }
      );

    // Show top 10 cards
    const topCards = cards.slice(0, 10);
    embed.addFields({
      name: 'Your Best Cards',
      value: topCards.map(card =>
        `**${card.card_name}** (ID: ${card.id})\n  ${card.card_type} - Power: ${card.power}`
      ).join('\n\n'),
      inline: false
    });

    embed.setFooter({ text: 'Energy refills 1 per hour (max 10) - Use /fun games trade to trade cards' });
    embed.setTimestamp();

    return interaction.editReply({ embeds: [embed] });

  } catch (error) {
    console.error('[Collection Error]', error);
    return interaction.editReply({
      content: 'Failed to load collection. Please try again later.'
    });
  }
}

export async function handleTrade(interaction) {
  await interaction.deferReply();

  const targetUser = interaction.options.getUser('user');
  const cardId = interaction.options.getInteger('cardid');
  const userId = interaction.user.id;
  const guildId = interaction.guild.id;

  if (targetUser.id === userId) {
    return interaction.editReply({
      content: 'You cannot trade with yourself!'
    });
  }

  if (targetUser.bot) {
    return interaction.editReply({
      content: 'You cannot trade with bots!'
    });
  }

  try {
    // Get the card
    const [[card]] = await pool.execute(
      'SELECT id, card_name, card_type, rarity, power FROM card_collection WHERE id = ? AND guild_id = ? AND user_id = ?',
      [cardId, guildId, userId]
    );

    if (!card) {
      return interaction.editReply({
        content: `Card #${cardId} not found in your collection. Use \`/fun games collection\` to see your cards.`
      });
    }

    const rarityLabels = {
      common: 'Common',
      uncommon: 'Uncommon',
      rare: 'Rare',
      epic: 'Epic',
      legendary: 'Legendary',
      mythic: 'Mythic'
    };

    const embed = new EmbedBuilder()
      .setColor('#E67E22')
      .setTitle('Trade Request Sent!')
      .setDescription(`You've offered to trade your card to ${targetUser}!`)
      .addFields(
        {
          name: 'Card Offered',
          value: `**${card.card_name}** (${rarityLabels[card.rarity]})\n${card.card_type} - Power: ${card.power}`,
          inline: false
        },
        {
          name: 'How Trading Works',
          value: 'Trading is currently in preview mode. The recipient will see your offer, but automatic trades are not yet enabled. Consider coordinating trades in your server!',
          inline: false
        }
      )
      .setFooter({ text: 'Trade system coming soon with full functionality!' })
      .setTimestamp();

    // Notify the target user
    try {
      await targetUser.send({
        content: `${interaction.user.username} wants to trade with you in ${interaction.guild.name}!`,
        embeds: [embed]
      });

      return interaction.editReply({
        content: `Trade offer sent to ${targetUser}!`,
        embeds: [embed]
      });
    } catch (dmError) {
      return interaction.editReply({
        content: `Trade prepared, but ${targetUser} has DMs disabled. Coordinate the trade in the server!`,
        embeds: [embed]
      });
    }

  } catch (error) {
    console.error('[Trade Error]', error);
    return interaction.editReply({
      content: 'Failed to process trade. Please try again later.'
    });
  }
}

export async function handleTrivia(interaction) {
  const category = interaction.options.getString('category') || 'general';
  const question = getTriviaQuestion(category);

  const embed = new EmbedBuilder()
    .setColor('#E74C3C')
    .setTitle(`${question.category} Trivia`)
    .setDescription(question.question)
    .addFields(
      { name: 'Difficulty', value: question.difficulty, inline: true },
      { name: 'Hint', value: question.hint, inline: true }
    )
    .setFooter({ text: 'Think you know the answer? Reply in chat!' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });

  // Post answer after 30 seconds
  setTimeout(async () => {
    const answerEmbed = new EmbedBuilder()
      .setColor('#2ECC71')
      .setTitle('Answer Revealed!')
      .setDescription(`**${question.answer}**`)
      .addFields({
        name: 'Explanation',
        value: question.explanation,
        inline: false
      });

    await interaction.followUp({ embeds: [answerEmbed] });
  }, 30000);
}

export default {
  handleBattle,
  handleCardPull,
  handleCollection,
  handleTrade,
  handleTrivia
};
