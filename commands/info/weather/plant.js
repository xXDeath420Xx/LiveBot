import { EmbedBuilder } from 'discord.js';

export async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand();

  try {
    switch (subcommand) {
      case 'identify':
        return await handleIdentify(interaction);
      case 'care':
        return await handleCare(interaction);
      case 'tips':
        return await handleTips(interaction);
    }
  } catch (error) {
    console.error('[Plant Command Error]', error);
    const method = interaction.deferred ? 'editReply' : 'reply';
    return interaction[method]({
      content: '❌ Failed to fetch plant information. Please try again later.',
      ephemeral: true
    });
  }
}

async function handleIdentify(interaction) {
  await interaction.deferReply();

  const description = interaction.options.getString('description').toLowerCase();

  // Simple keyword-based identification (in production, use Plant.id API or similar)
  let identified = null;

  if (description.includes('succulent') || description.includes('thick leaves') || description.includes('desert')) {
    identified = 'succulent';
  } else if (description.includes('snake') || description.includes('tall') && description.includes('striped')) {
    identified = 'snake';
  } else if (description.includes('pothos') || description.includes('vine') || description.includes('heart-shaped leaves')) {
    identified = 'pothos';
  } else if (description.includes('monstera') || description.includes('split leaves') || description.includes('holes in leaves')) {
    identified = 'monstera';
  } else if (description.includes('peace lily') || description.includes('white flowers') || description.includes('dark green leaves')) {
    identified = 'peacelily';
  } else if (description.includes('spider') || description.includes('striped leaves') || description.includes('babies')) {
    identified = 'spider';
  } else if (description.includes('aloe') || description.includes('spiky') || description.includes('gel')) {
    identified = 'aloe';
  }

  if (identified) {
    const careInfo = getPlantCare(identified);
    const embed = new EmbedBuilder()
      .setColor('#2ECC71')
      .setTitle(`🌿 Possible Match: ${careInfo.name}`)
      .setDescription(`Based on your description, this might be a ${careInfo.name}!`)
      .addFields(
        {
          name: '💧 Watering',
          value: careInfo.watering,
          inline: true
        },
        {
          name: '☀️ Light',
          value: careInfo.light,
          inline: true
        },
        {
          name: '🌡️ Difficulty',
          value: careInfo.difficulty,
          inline: true
        },
        {
          name: '📝 Care Tips',
          value: careInfo.tips,
          inline: false
        }
      )
      .setFooter({ text: 'Use /weather plant care for detailed care instructions' })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  } else {
    const embed = new EmbedBuilder()
      .setColor('#F39C12')
      .setTitle('🌿 Plant Identification')
      .setDescription('I couldn\'t identify the plant from your description.')
      .addFields({
        name: '💡 Tips for Better Identification',
        value: '• Describe leaf shape and color\n• Mention any flowers or fruits\n• Note the plant\'s size\n• Describe growing conditions\n• Mention any unique features',
        inline: false
      })
      .setFooter({ text: '🔬 For accurate identification, consider using a plant identification app with photos!' })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  }
}

async function handleCare(interaction) {
  const plantName = interaction.options.getString('plantname');
  const careInfo = getPlantCare(plantName);

  const embed = new EmbedBuilder()
    .setColor('#27AE60')
    .setTitle(`🌱 ${careInfo.name} Care Guide`)
    .setDescription(careInfo.description)
    .addFields(
      {
        name: '💧 Watering',
        value: careInfo.watering,
        inline: false
      },
      {
        name: '☀️ Light Requirements',
        value: careInfo.light,
        inline: false
      },
      {
        name: '🌡️ Temperature & Humidity',
        value: careInfo.temperature,
        inline: false
      },
      {
        name: '🌿 Soil & Fertilizer',
        value: careInfo.soil,
        inline: false
      },
      {
        name: '✂️ Pruning & Maintenance',
        value: careInfo.maintenance,
        inline: false
      },
      {
        name: '⚠️ Common Problems',
        value: careInfo.problems,
        inline: false
      },
      {
        name: '📊 Difficulty',
        value: careInfo.difficulty,
        inline: true
      },
      {
        name: '🐾 Pet Safe',
        value: careInfo.petSafe ? '✅ Yes' : '❌ No (Keep away from pets)',
        inline: true
      }
    )
    .setFooter({ text: 'Happy planting! 🌿' })
    .setTimestamp();

  return interaction.reply({ embeds: [embed] });
}

function getPlantCare(plantKey) {
  const plants = {
    snake: {
      name: 'Snake Plant (Sansevieria)',
      description: 'Nearly indestructible plant perfect for beginners. Known for air-purifying qualities.',
      watering: 'Every 2-3 weeks. Water when soil is completely dry. Less in winter.',
      light: 'Low to bright indirect light. Tolerates almost any light condition.',
      temperature: 'Room temperature (60-80°F). Tolerates most conditions.',
      soil: 'Well-draining cactus/succulent mix. Fertilize monthly in growing season.',
      maintenance: 'Remove dead leaves at base. Wipe leaves occasionally to remove dust.',
      problems: 'Overwatering causes root rot. Yellow leaves = too much water.',
      difficulty: '⭐ Very Easy',
      petSafe: false,
      tips: 'One of the easiest plants to care for. Can go weeks without water.'
    },
    pothos: {
      name: 'Pothos (Epipremnum aureum)',
      description: 'Versatile trailing vine with heart-shaped leaves. Great for beginners.',
      watering: 'Weekly, when top 1-2 inches of soil are dry. Leaves droop when thirsty.',
      light: 'Low to bright indirect light. Variegated varieties need more light.',
      temperature: 'Room temperature (60-80°F). Average household humidity.',
      soil: 'Well-draining potting mix. Fertilize monthly in spring/summer.',
      maintenance: 'Prune to encourage bushiness. Can propagate cuttings in water.',
      problems: 'Brown tips = inconsistent watering. Yellow leaves = overwatering.',
      difficulty: '⭐ Very Easy',
      petSafe: false,
      tips: 'Extremely forgiving and grows fast. Perfect for hanging baskets.'
    },
    monstera: {
      name: 'Monstera Deliciosa (Swiss Cheese Plant)',
      description: 'Iconic plant with dramatic split leaves. A statement piece.',
      watering: 'Weekly when top 2 inches of soil are dry. Increase in summer.',
      light: 'Bright indirect light. Avoid direct sun which burns leaves.',
      temperature: 'Warm (65-85°F). Prefers higher humidity (60%+).',
      soil: 'Rich, well-draining potting mix with peat. Fertilize monthly in growing season.',
      maintenance: 'Wipe leaves regularly. Provide moss pole or support for climbing.',
      problems: 'No splits = needs more light. Brown tips = low humidity or inconsistent watering.',
      difficulty: '⭐⭐ Easy',
      petSafe: false,
      tips: 'Larger leaves develop more splits. Be patient with young plants.'
    },
    succulent: {
      name: 'Succulents (Various Species)',
      description: 'Water-storing plants with thick leaves. Hundreds of varieties.',
      watering: 'Every 2-3 weeks. Soak thoroughly then let dry completely.',
      light: 'Bright light, some direct sun. South-facing window ideal.',
      temperature: 'Warm, dry conditions (60-80°F). Low humidity preferred.',
      soil: 'Cactus/succulent mix with excellent drainage. Fertilize sparingly.',
      maintenance: 'Minimal. Remove dead leaves. Rotate for even growth.',
      problems: 'Stretching = needs more light. Soft/mushy = overwatering (root rot).',
      difficulty: '⭐ Very Easy',
      petSafe: true,
      tips: 'When in doubt, underwater. They store water in their leaves.'
    },
    peacelily: {
      name: 'Peace Lily (Spathiphyllum)',
      description: 'Elegant plant with glossy leaves and white flower-like blooms.',
      watering: 'Weekly. Likes consistent moisture but not soggy. Droops when thirsty.',
      light: 'Low to medium indirect light. Tolerates shade well.',
      temperature: 'Warm (65-80°F). Prefers higher humidity.',
      soil: 'Rich, well-draining potting mix. Fertilize monthly in growing season.',
      maintenance: 'Remove spent blooms. Wipe leaves occasionally.',
      problems: 'Brown tips = chlorine in tap water (use filtered). Yellow leaves = too much light.',
      difficulty: '⭐ Very Easy',
      petSafe: false,
      tips: 'Excellent air purifier. Tells you when it needs water by drooping.'
    },
    spider: {
      name: 'Spider Plant (Chlorophytum comosum)',
      description: 'Fast-growing plant with arching leaves and baby plantlets.',
      watering: 'Weekly, when soil is slightly dry. Prefers even moisture.',
      light: 'Bright indirect light. Tolerates various light conditions.',
      temperature: 'Room temperature (60-75°F). Average humidity.',
      soil: 'Well-draining potting mix. Light fertilizer monthly.',
      maintenance: 'Remove brown tips. Propagate babies in water or soil.',
      problems: 'Brown tips = fluoride in tap water (use filtered). Pale leaves = needs fertilizer.',
      difficulty: '⭐ Very Easy',
      petSafe: true,
      tips: 'Produces many babies that can be potted. Great for hanging baskets.'
    },
    aloe: {
      name: 'Aloe Vera',
      description: 'Medicinal succulent with thick, gel-filled leaves.',
      watering: 'Every 2-3 weeks. Water deeply then let dry completely.',
      light: 'Bright indirect to direct light. South or west-facing window.',
      temperature: 'Warm (60-75°F). Low humidity.',
      soil: 'Cactus/succulent mix with excellent drainage.',
      maintenance: 'Remove dead outer leaves. Can harvest gel from mature leaves.',
      problems: 'Brown/soft = overwatering. Red/brown = too much sun.',
      difficulty: '⭐ Very Easy',
      petSafe: false,
      tips: 'The gel inside leaves can soothe minor burns. Medicinal properties!'
    },
    fiddle: {
      name: 'Fiddle Leaf Fig (Ficus lyrata)',
      description: 'Trendy tree with large, violin-shaped leaves.',
      watering: 'Weekly when top inch of soil is dry. Consistent schedule important.',
      light: 'Bright indirect light. Rotate for even growth.',
      temperature: 'Warm (60-75°F). Prefers humidity 30-65%.',
      soil: 'Well-draining potting mix. Fertilize monthly in growing season.',
      maintenance: 'Wipe leaves regularly. Prune to shape. Stake for support.',
      problems: 'Brown spots = inconsistent watering or pests. Dropping leaves = environment change.',
      difficulty: '⭐⭐⭐ Moderate',
      petSafe: false,
      tips: 'Doesn\'t like to be moved. Find a spot and keep it there.'
    },
    zz: {
      name: 'ZZ Plant (Zamioculcas zamiifolia)',
      description: 'Glossy-leaved plant that thrives on neglect. Extremely hardy.',
      watering: 'Every 2-3 weeks. Prefers to dry out between waterings.',
      light: 'Low to bright indirect light. Very adaptable.',
      temperature: 'Room temperature (60-75°F). Average humidity.',
      soil: 'Well-draining potting mix. Fertilize 2-3 times per year.',
      maintenance: 'Minimal. Wipe leaves occasionally. Very slow growing.',
      problems: 'Yellow leaves = overwatering. Stalks falling = severe overwatering.',
      difficulty: '⭐ Very Easy',
      petSafe: false,
      tips: 'Perfect for low-light spaces and forgetful waterers.'
    },
    rubber: {
      name: 'Rubber Plant (Ficus elastica)',
      description: 'Bold plant with large, glossy, burgundy or green leaves.',
      watering: 'Weekly in summer, less in winter. When top inch of soil is dry.',
      light: 'Bright indirect light. Some morning sun okay.',
      temperature: 'Warm (60-75°F). Prefers humidity 40-50%.',
      soil: 'Well-draining potting mix with peat. Fertilize monthly in growing season.',
      maintenance: 'Wipe leaves regularly to remove dust. Prune to control size.',
      problems: 'Dropping leaves = overwatering or temperature shock. Leggy = needs more light.',
      difficulty: '⭐⭐ Easy',
      petSafe: false,
      tips: 'Grows quite large over time. Can be pruned to maintain size.'
    }
  };

  return plants[plantKey] || plants.pothos;
}

async function handleTips(interaction) {
  const embed = new EmbedBuilder()
    .setColor('#1ABC9C')
    .setTitle('🌿 General Plant Care Tips')
    .setDescription('Essential knowledge for keeping your plants healthy and happy!')
    .addFields(
      {
        name: '💧 Watering 101',
        value: '• Check soil moisture before watering\n• Most plants prefer soil to dry slightly between waterings\n• Use room temperature water\n• Water until it drains from bottom\n• Never let plants sit in water',
        inline: false
      },
      {
        name: '☀️ Lighting Guide',
        value: '• **Bright direct:** South-facing window\n• **Bright indirect:** Near east/west window\n• **Medium:** Few feet from window\n• **Low:** North-facing or far from windows\n• Rotate plants for even growth',
        inline: false
      },
      {
        name: '🐛 Common Pests',
        value: '• Spider mites: Fine webbing, yellow spots\n• Fungus gnats: Small flies in soil\n• Mealybugs: White cotton-like spots\n• Scale: Brown bumps on stems\n• Treat with neem oil or insecticidal soap',
        inline: false
      },
      {
        name: '⚠️ Problem Diagnosis',
        value: '• **Yellow leaves:** Overwatering or nutrient deficiency\n• **Brown tips:** Low humidity or fluoride in water\n• **Drooping:** Under or overwatering\n• **Leggy growth:** Needs more light\n• **No growth:** Needs fertilizer or more light',
        inline: false
      },
      {
        name: '🌱 Pro Tips',
        value: '• Repot when roots are crowded (every 1-2 years)\n• Use filtered water if tap water causes issues\n• Group plants to increase humidity\n• Clean leaves regularly for better photosynthesis\n• Quarantine new plants for 2 weeks',
        inline: false
      }
    )
    .setFooter({ text: 'Happy growing! 🌿' })
    .setTimestamp();

  return interaction.reply({ embeds: [embed] });
}
