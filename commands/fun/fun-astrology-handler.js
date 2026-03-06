import { EmbedBuilder } from 'discord.js';

const ZODIAC_SIGNS = {
  'aries': { emoji: '♈', dates: 'Mar 21 - Apr 19', element: 'Fire' },
  'taurus': { emoji: '♉', dates: 'Apr 20 - May 20', element: 'Earth' },
  'gemini': { emoji: '♊', dates: 'May 21 - Jun 20', element: 'Air' },
  'cancer': { emoji: '♋', dates: 'Jun 21 - Jul 22', element: 'Water' },
  'leo': { emoji: '♌', dates: 'Jul 23 - Aug 22', element: 'Fire' },
  'virgo': { emoji: '♍', dates: 'Aug 23 - Sep 22', element: 'Earth' },
  'libra': { emoji: '♎', dates: 'Sep 23 - Oct 22', element: 'Air' },
  'scorpio': { emoji: '♏', dates: 'Oct 23 - Nov 21', element: 'Water' },
  'sagittarius': { emoji: '♐', dates: 'Nov 22 - Dec 21', element: 'Fire' },
  'capricorn': { emoji: '♑', dates: 'Dec 22 - Jan 19', element: 'Earth' },
  'aquarius': { emoji: '♒', dates: 'Jan 20 - Feb 18', element: 'Air' },
  'pisces': { emoji: '♓', dates: 'Feb 19 - Mar 20', element: 'Water' }
};

function seededRandom(seed) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash) + seed.charCodeAt(i);
    hash = hash & hash;
  }
  let value = Math.abs(hash);
  return () => { value = (value * 9301 + 49297) % 233280; return value / 233280; };
}

function getZodiacColor(sign) {
  const colors = {
    aries: '#FF6B6B', taurus: '#6BCF7F', gemini: '#FFD93D',
    cancer: '#A8DADC', leo: '#F4A261', virgo: '#8D6E63',
    libra: '#E9C46A', scorpio: '#8B0000', sagittarius: '#9B59B6',
    capricorn: '#2C3E50', aquarius: '#3498DB', pisces: '#1ABC9C'
  };
  return colors[sign] || '#9B59B6';
}

function generateHoroscope(sign, period) {
  const seed = new Date().toISOString().split('T')[0] + sign + period;
  const random = seededRandom(seed);

  const focuses = ['Communication and self-expression', 'Personal growth and reflection', 'Relationships and connections', 'Career advancement and ambition', 'Health and wellbeing', 'Creativity and passion', 'Financial planning', 'Adventure and new experiences'];
  const loveReadings = ['⭐⭐⭐⭐⭐ Excellent', '⭐⭐⭐⭐ Very Good', '⭐⭐⭐ Good', '⭐⭐ Fair'];
  const careerReadings = ['⭐⭐⭐⭐⭐ Outstanding', '⭐⭐⭐⭐ Strong', '⭐⭐⭐ Steady', '⭐⭐ Challenging'];
  const moods = ['Energetic', 'Calm', 'Confident', 'Reflective', 'Optimistic', 'Creative'];
  const colors = ['Red', 'Blue', 'Green', 'Yellow', 'Purple', 'Orange', 'Pink', 'Silver'];

  const descriptions = {
    daily: `Today brings opportunities for ${focuses[Math.floor(random() * focuses.length)].toLowerCase()}. Trust your instincts and stay open to unexpected developments.`,
    weekly: `This week emphasizes ${focuses[Math.floor(random() * focuses.length)].toLowerCase()}. Stay flexible and embrace changes that come your way.`,
    monthly: `This month highlights ${focuses[Math.floor(random() * focuses.length)].toLowerCase()}. Long-term planning will serve you well.`
  };

  return {
    description: descriptions[period],
    focus: focuses[Math.floor(random() * focuses.length)],
    love: loveReadings[Math.floor(random() * loveReadings.length)],
    career: careerReadings[Math.floor(random() * careerReadings.length)],
    finance: `${['Favorable', 'Stable', 'Cautious', 'Growing'][Math.floor(random() * 4)]}`,
    luckyNumber: `${Math.floor(random() * 99) + 1}`,
    luckyColor: colors[Math.floor(random() * colors.length)],
    mood: moods[Math.floor(random() * moods.length)]
  };
}

export async function handleHoroscope(interaction) {
  await interaction.deferReply();
  const sign = interaction.options.getString('sign');
  const period = interaction.options.getString('period') || 'daily';
  const signInfo = ZODIAC_SIGNS[sign];
  const horoscope = generateHoroscope(sign, period);
  const periodEmojis = { daily: '📅', weekly: '📆', monthly: '🗓️' };

  const embed = new EmbedBuilder()
    .setColor(getZodiacColor(sign))
    .setTitle(`${signInfo.emoji} ${sign.charAt(0).toUpperCase() + sign.slice(1)} ${periodEmojis[period]} ${period.charAt(0).toUpperCase() + period.slice(1)} Horoscope`)
    .setDescription(horoscope.description)
    .addFields(
      { name: '💫 Key Focus', value: horoscope.focus, inline: false },
      { name: '❤️ Love', value: horoscope.love, inline: true },
      { name: '💼 Career', value: horoscope.career, inline: true },
      { name: '💰 Finance', value: horoscope.finance, inline: true },
      { name: '🍀 Lucky Number', value: horoscope.luckyNumber, inline: true },
      { name: '🎨 Lucky Color', value: horoscope.luckyColor, inline: true },
      { name: '⭐ Mood', value: horoscope.mood, inline: true }
    )
    .setFooter({ text: `${signInfo.dates} • ${signInfo.element} Sign` })
    .setTimestamp();
  return interaction.editReply({ embeds: [embed] });
}

export async function handleTarot(interaction) {
  await interaction.deferReply();
  const spread = interaction.options.getString('spread') || 'single';

  const tarotCards = [
    { name: 'The Fool', meaning: 'New beginnings, innocence, spontaneity', reversed: 'Recklessness, fear of change' },
    { name: 'The Magician', meaning: 'Manifestation, resourcefulness, power', reversed: 'Manipulation, poor planning' },
    { name: 'The High Priestess', meaning: 'Intuition, sacred knowledge, divine feminine', reversed: 'Secrets, disconnection' },
    { name: 'The Empress', meaning: 'Femininity, beauty, nature, abundance', reversed: 'Creative block, dependence' },
    { name: 'The Emperor', meaning: 'Authority, structure, control, fatherhood', reversed: 'Domination, excessive control' },
    { name: 'The Hierophant', meaning: 'Spiritual wisdom, religious beliefs, tradition', reversed: 'Rebellion, subversiveness' },
    { name: 'The Lovers', meaning: 'Love, harmony, relationships, choices', reversed: 'Self-love, disharmony' },
    { name: 'The Chariot', meaning: 'Control, willpower, success, determination', reversed: 'Lack of direction' },
    { name: 'Strength', meaning: 'Strength, courage, persuasion, compassion', reversed: 'Inner weakness, self-doubt' },
    { name: 'The Hermit', meaning: 'Soul searching, introspection, inner guidance', reversed: 'Isolation, loneliness' },
    { name: 'Wheel of Fortune', meaning: 'Good luck, karma, life cycles, destiny', reversed: 'Bad luck, resistance to change' },
    { name: 'Justice', meaning: 'Justice, fairness, truth, law', reversed: 'Unfairness, lack of accountability' },
    { name: 'The Hanged Man', meaning: 'Pause, surrender, letting go, new perspectives', reversed: 'Delays, resistance' },
    { name: 'Death', meaning: 'Endings, change, transformation, transition', reversed: 'Resistance to change, stagnation' },
    { name: 'Temperance', meaning: 'Balance, moderation, patience, purpose', reversed: 'Imbalance, excess' },
    { name: 'The Devil', meaning: 'Shadow self, attachment, addiction, restriction', reversed: 'Releasing limiting beliefs' },
    { name: 'The Tower', meaning: 'Sudden change, upheaval, chaos, revelation', reversed: 'Personal transformation, fear of change' },
    { name: 'The Star', meaning: 'Hope, faith, purpose, renewal, spirituality', reversed: 'Lack of faith, despair' },
    { name: 'The Moon', meaning: 'Illusion, fear, anxiety, subconscious, intuition', reversed: 'Release of fear, clarity' },
    { name: 'The Sun', meaning: 'Positivity, fun, warmth, success, vitality', reversed: 'Inner child, overly optimistic' },
    { name: 'Judgement', meaning: 'Judgement, rebirth, inner calling, absolution', reversed: 'Self-doubt, inner critic' },
    { name: 'The World', meaning: 'Completion, integration, accomplishment, travel', reversed: 'Seeking closure, delays' }
  ];

  const embed = new EmbedBuilder().setColor('#9B59B6').setFooter({ text: 'Tarot guidance for reflection and insight' }).setTimestamp();

  if (spread === 'single') {
    const card = tarotCards[Math.floor(Math.random() * tarotCards.length)];
    const isReversed = Math.random() < 0.3;
    embed.setTitle('🔮 Single Card Reading')
      .setDescription(`Your card: **${card.name}${isReversed ? ' (Reversed)' : ''}**`)
      .addFields({ name: '💫 Interpretation', value: isReversed ? card.reversed : card.meaning, inline: false });
  } else if (spread === 'three') {
    const cards = Array.from({ length: 3 }, () => tarotCards[Math.floor(Math.random() * tarotCards.length)]);
    embed.setTitle('🔮 Three Card Reading: Past, Present, Future')
      .addFields(
        { name: '📖 Past', value: `**${cards[0].name}**\n${cards[0].meaning}`, inline: false },
        { name: '🎯 Present', value: `**${cards[1].name}**\n${cards[1].meaning}`, inline: false },
        { name: '🔭 Future', value: `**${cards[2].name}**\n${cards[2].meaning}`, inline: false }
      );
  } else if (spread === 'love') {
    const card = tarotCards[Math.floor(Math.random() * tarotCards.length)];
    embed.setTitle('💖 Love Reading').setDescription(`**${card.name}**`)
      .addFields({ name: '💫 Love Guidance', value: `${card.meaning}\n\nThis card suggests focusing on the heart and emotional connections in your relationships.`, inline: false });
  } else if (spread === 'career') {
    const card = tarotCards[Math.floor(Math.random() * tarotCards.length)];
    embed.setTitle('💼 Career Reading').setDescription(`**${card.name}**`)
      .addFields({ name: '💫 Career Guidance', value: `${card.meaning}\n\nApply this energy to your professional life and career decisions.`, inline: false });
  }
  return interaction.editReply({ embeds: [embed] });
}

export async function handleNumerology(interaction) {
  await interaction.deferReply();
  const birthdate = interaction.options.getString('birthdate');
  const dateRegex = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
  const match = birthdate.match(dateRegex);
  if (!match) {
    return interaction.editReply({ content: '❌ Invalid date format. Please use MM/DD/YYYY (e.g., 03/15/1990).', ephemeral: true });
  }

  const [, month, day, year] = match;
  const reduceToSingle = (num) => {
    while (num > 9 && num !== 11 && num !== 22 && num !== 33) {
      num = num.toString().split('').reduce((sum, digit) => sum + parseInt(digit), 0);
    }
    return num;
  };
  const monthNum = reduceToSingle(parseInt(month));
  const dayNum = reduceToSingle(parseInt(day));
  const yearNum = reduceToSingle(year.toString().split('').reduce((sum, d) => sum + parseInt(d), 0));
  const lifePathNumber = reduceToSingle(monthNum + dayNum + yearNum);

  const descriptions = {
    1: { overview: 'The Leader - You are a born leader with a pioneering spirit and strong willpower.', strengths: 'Independence, leadership, innovation, determination, courage', purpose: 'To lead and inspire others while forging your own unique path', relationships: 'You need a partner who respects your independence and shares your ambition', career: 'Entrepreneur, CEO, inventor, military leader, athlete' },
    2: { overview: 'The Peacemaker - You are diplomatic, cooperative, and sensitive to others\' needs.', strengths: 'Diplomacy, cooperation, intuition, patience, sensitivity', purpose: 'To create harmony and bring people together through understanding', relationships: 'You thrive in partnerships and seek deep emotional connections', career: 'Counselor, diplomat, teacher, musician, mediator' },
    3: { overview: 'The Creative - You are expressive, optimistic, and gifted with communication.', strengths: 'Creativity, self-expression, optimism, social skills, imagination', purpose: 'To express yourself creatively and inspire joy in others', relationships: 'You need a playful partner who appreciates your creative spirit', career: 'Artist, writer, entertainer, designer, public speaker' },
    4: { overview: 'The Builder - You are practical, organized, and dedicated to building lasting foundations.', strengths: 'Stability, organization, dedication, practicality, reliability', purpose: 'To create order and build lasting structures that benefit others', relationships: 'You value loyalty and commitment in long-term partnerships', career: 'Engineer, architect, accountant, manager, builder' },
    5: { overview: 'The Freedom Seeker - You are adventurous, versatile, and embrace change.', strengths: 'Adaptability, curiosity, freedom, versatility, progressive thinking', purpose: 'To experience life fully and inspire others to embrace freedom', relationships: 'You need variety and freedom in relationships', career: 'Travel writer, salesperson, photographer, entrepreneur, journalist' },
    6: { overview: 'The Nurturer - You are compassionate, responsible, and devoted to caring for others.', strengths: 'Compassion, responsibility, healing, teaching, protection', purpose: 'To nurture and support your community with unconditional love', relationships: 'You are devoted and seek harmonious family relationships', career: 'Nurse, teacher, counselor, interior designer, chef' },
    7: { overview: 'The Seeker - You are analytical, spiritual, and always searching for deeper truth.', strengths: 'Analysis, spirituality, wisdom, intuition, introspection', purpose: 'To seek truth and share spiritual wisdom with the world', relationships: 'You need intellectual and spiritual connection', career: 'Researcher, scientist, philosopher, spiritual teacher, analyst' },
    8: { overview: 'The Powerhouse - You are ambitious, authoritative, and destined for material success.', strengths: 'Ambition, confidence, efficiency, power, financial success', purpose: 'To achieve material success while maintaining integrity', relationships: 'You seek a powerful partner who matches your ambition', career: 'Executive, financial advisor, banker, real estate developer' },
    9: { overview: 'The Humanitarian - You are compassionate, generous, and devoted to serving humanity.', strengths: 'Compassion, generosity, idealism, artistic talent, humanitarianism', purpose: 'To serve humanity and make the world a better place', relationships: 'You love deeply and seek soulful connections', career: 'Humanitarian worker, artist, healer, philanthropist, teacher' },
    11: { overview: 'The Illuminator (Master Number) - You are highly intuitive with a powerful spiritual mission.', strengths: 'Intuition, inspiration, idealism, spiritual insight, vision', purpose: 'To illuminate and inspire others with spiritual wisdom', relationships: 'You need a spiritually aware partner who supports your mission', career: 'Spiritual teacher, counselor, inventor, artist, inspirational speaker' },
    22: { overview: 'The Master Builder (Master Number) - You have the ability to turn dreams into reality on a grand scale.', strengths: 'Vision, practical idealism, discipline, leadership, manifestation', purpose: 'To build something of lasting value that benefits humanity', relationships: 'You need a practical yet visionary partner', career: 'Architect, politician, business leader, urban planner, social reformer' },
    33: { overview: 'The Master Teacher (Master Number) - You embody unconditional love and spiritual teaching.', strengths: 'Compassion, healing, teaching, self-sacrifice, spiritual mastery', purpose: 'To teach and heal through unconditional love', relationships: 'You give selflessly and seek a spiritually evolved partner', career: 'Spiritual healer, teacher, counselor, humanitarian, artist' }
  };

  const description = descriptions[lifePathNumber] || descriptions[1];

  const embed = new EmbedBuilder()
    .setColor('#FF6B9D')
    .setTitle(`🔢 Your Life Path Number: ${lifePathNumber}`)
    .setDescription(description.overview)
    .addFields(
      { name: '💫 Strengths', value: description.strengths, inline: false },
      { name: '🎯 Life Purpose', value: description.purpose, inline: false },
      { name: '❤️ Relationships', value: description.relationships, inline: false },
      { name: '💼 Career Paths', value: description.career, inline: false }
    )
    .setFooter({ text: `Birthdate: ${birthdate}` })
    .setTimestamp();
  return interaction.editReply({ embeds: [embed] });
}

export async function handleCompatibility(interaction) {
  await interaction.deferReply();
  const sign1 = interaction.options.getString('sign1');
  const sign2 = interaction.options.getString('sign2');

  const elements = {
    aries: 'fire', leo: 'fire', sagittarius: 'fire',
    taurus: 'earth', virgo: 'earth', capricorn: 'earth',
    gemini: 'air', libra: 'air', aquarius: 'air',
    cancer: 'water', scorpio: 'water', pisces: 'water'
  };

  const element1 = elements[sign1];
  const element2 = elements[sign2];
  let score = 50;

  if (element1 === element2) score += 30;
  if ((element1 === 'fire' && element2 === 'air') || (element1 === 'air' && element2 === 'fire')) score += 25;
  if ((element1 === 'earth' && element2 === 'water') || (element1 === 'water' && element2 === 'earth')) score += 25;
  if ((element1 === 'fire' && element2 === 'water') || (element1 === 'water' && element2 === 'fire')) score -= 15;
  if ((element1 === 'earth' && element2 === 'air') || (element1 === 'air' && element2 === 'earth')) score -= 10;

  const hearts = score >= 90 ? '💖💖💖💖💖' : score >= 70 ? '💖💖💖💖' : score >= 50 ? '💖💖💖' : score >= 30 ? '💖💖' : '💖';

  const embed = new EmbedBuilder()
    .setColor(score >= 80 ? '#2ECC71' : score >= 60 ? '#F39C12' : '#E74C3C')
    .setTitle(`${ZODIAC_SIGNS[sign1].emoji} ${sign1.charAt(0).toUpperCase() + sign1.slice(1)} & ${ZODIAC_SIGNS[sign2].emoji} ${sign2.charAt(0).toUpperCase() + sign2.slice(1)}`)
    .setDescription(`**Compatibility Score: ${score}/100** ${hearts}`)
    .addFields(
      { name: '💫 Overall Compatibility', value: score >= 80 ? 'This is a highly compatible match with great potential!' : score >= 60 ? 'A promising pairing with good compatibility!' : score >= 40 ? 'A workable match that requires understanding and effort.' : 'This pairing faces challenges but can work with dedication.', inline: false },
      { name: '❤️ Love & Romance', value: score >= 80 ? '⭐⭐⭐⭐⭐ Excellent' : score >= 60 ? '⭐⭐⭐⭐ Very Good' : score >= 40 ? '⭐⭐⭐ Good' : '⭐⭐ Challenging', inline: true },
      { name: '🤝 Friendship', value: score >= 75 ? '⭐⭐⭐⭐⭐ Excellent' : score >= 55 ? '⭐⭐⭐⭐ Strong' : score >= 35 ? '⭐⭐⭐ Good' : '⭐⭐ Fair', inline: true },
      { name: '💬 Communication', value: score >= 70 ? '⭐⭐⭐⭐⭐ Excellent' : score >= 50 ? '⭐⭐⭐⭐ Good' : score >= 30 ? '⭐⭐⭐ Fair' : '⭐⭐ Needs Work', inline: true },
      { name: '✨ Strengths', value: score >= 70 ? 'Natural understanding, shared values, strong chemistry' : score >= 50 ? 'Mutual respect, complementary traits, growth potential' : 'Learning opportunities, different perspectives', inline: false },
      { name: '⚠️ Challenges', value: score < 50 ? 'Different communication styles, conflicting needs, requires patience' : score < 70 ? 'Occasional misunderstandings, needs compromise' : 'Minor differences that add interest', inline: false }
    )
    .setFooter({ text: 'Remember: All relationships require effort and understanding!' })
    .setTimestamp();
  return interaction.editReply({ embeds: [embed] });
}
