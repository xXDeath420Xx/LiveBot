import { EmbedBuilder } from 'discord.js';

function capitalizeFirst(str) { return str.charAt(0).toUpperCase() + str.slice(1); }
function randomHexColor() { return '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0').toUpperCase(); }

function getMemeTemplate(template) {
  const templates = {
    drake: { name: 'Drake Hotline Bling', description: 'Drake disapproving of one thing and approving of another. Perfect for comparisons!' },
    boyfriend: { name: 'Distracted Boyfriend', description: 'Man looking at another woman while his girlfriend looks disapproving. Great for "distraction" scenarios!' },
    buttons: { name: 'Two Buttons', description: 'Sweating person choosing between two buttons. Perfect for difficult decisions!' },
    brain: { name: 'Expanding Brain', description: 'Four levels of increasingly "galaxy brain" ideas. Great for showing escalating concepts!' },
    changemymind: { name: 'Change My Mind', description: 'Person sitting at table inviting debate. Perfect for hot takes and controversial opinions!' },
    pigeon: { name: 'Is This A Pigeon?', description: 'Butterfly labeled as something else. Perfect for misidentification humor!' },
    woman_cat: { name: 'Woman Yelling at Cat', description: 'Woman pointing and yelling, confused cat at dinner table. Great for arguments!' },
    bernie: { name: 'Bernie Sanders', description: 'Bernie sitting with mittens. Perfect for "waiting" or "not impressed" situations!' },
    success: { name: 'Success Kid', description: 'Baby with fist pump. Perfect for small victories and achievements!' },
    mordor: { name: 'One Does Not Simply', description: 'Boromir explaining something is not simple. Perfect for complex tasks!' }
  };
  return templates[template] || templates.drake;
}

export async function handleMeme(interaction) {
  await interaction.deferReply();
  const template = interaction.options.getString('template');
  const text1 = interaction.options.getString('text1');
  const text2 = interaction.options.getString('text2') || '';
  const text3 = interaction.options.getString('text3') || '';
  const memeInfo = getMemeTemplate(template);

  const embed = new EmbedBuilder()
    .setColor('#FF6B6B')
    .setTitle(`🎨 ${memeInfo.name} Meme`)
    .setDescription('Your custom meme has been generated!')
    .addFields(
      { name: '📝 Text Lines', value: `**Line 1:** ${text1}${text2 ? `\n**Line 2:** ${text2}` : ''}${text3 ? `\n**Line 3:** ${text3}` : ''}`, inline: false },
      { name: '💡 Tip', value: 'To create actual meme images, consider using online meme generators like Imgflip, Kapwing, or Meme Generator!', inline: false },
      { name: '🎭 Template Info', value: memeInfo.description, inline: false }
    )
    .setFooter({ text: 'Meme templates are just suggestions - get creative!' })
    .setTimestamp();
  return interaction.editReply({ embeds: [embed] });
}

export async function handleStory(interaction) {
  await interaction.deferReply();
  const prompt = interaction.options.getString('prompt');
  const genre = interaction.options.getString('genre') || 'fantasy';

  const storyTemplates = {
    fantasy: { starter: `In a realm where magic flows like rivers and ancient prophecies shape destiny, ${prompt.toLowerCase()}. `, middle: `The hero discovered an enchanted artifact that would change everything. As shadows gathered and mystical creatures stirred, `, end: `they realized that true power came not from magic, but from the bonds forged along the journey.`, tips: '• Build your magical system with clear rules\n• Create memorable characters with unique abilities\n• Add unexpected plot twists\n• End with an emotional resolution' },
    scifi: { starter: `In the year 2847, across distant star systems where technology has reshaped humanity, ${prompt.toLowerCase()}. `, middle: `The discovery of an alien signal changed everything. As quantum computers calculated impossible odds and spacecraft warped through dimensions, `, end: `humanity learned that the universe held wonders beyond even their most advanced simulations.`, tips: '• Ground technology in plausible science\n• Explore how tech affects society\n• Create unique alien cultures\n• Balance action with philosophical questions' },
    horror: { starter: `On a night when shadows seemed darker than usual and the air hung heavy with dread, ${prompt.toLowerCase()}. `, middle: `Strange sounds echoed from places that should have been silent. As reality itself seemed to twist and sanity became questionable, `, end: `they escaped, forever changed, knowing that some doors should never be opened.`, tips: '• Build tension gradually\n• Use sensory details to create atmosphere\n• The unknown is scarier than the revealed\n• Leave some mysteries unexplained' },
    romance: { starter: `In a moment when hearts aligned and fate seemed to conspire, ${prompt.toLowerCase()}. `, middle: `Two souls, once distant as stars, found themselves drawn together by forces they couldn't explain. Through laughter and tears, misunderstandings and revelations, `, end: `they discovered that love wasn't about finding perfection, but about finding someone perfect for them.`, tips: '• Develop chemistry through dialogue\n• Create realistic obstacles\n• Show emotional vulnerability\n• Balance romance with character growth' },
    mystery: { starter: `When the impossible became reality and questions outnumbered answers, ${prompt.toLowerCase()}. `, middle: `Clues emerged from unexpected places, each revelation raising more questions. As the detective pieced together fragments of truth, `, end: `the solution revealed itself in a way no one expected, proving once again that reality is stranger than fiction.`, tips: '• Plant clues early for readers to find\n• Red herrings should be plausible\n• Make the reveal satisfying but surprising\n• Tie up loose ends' },
    comedy: { starter: `In the most absurd turn of events imaginable, ${prompt.toLowerCase()}. `, middle: `Chaos ensued in ways that defied logic and good sense. As situations escalated from ridiculous to impossible, `, end: `everyone learned that sometimes life's greatest lessons come wrapped in the most hilarious packages.`, tips: '• Timing is everything in comedy\n• Exaggerate for effect\n• Use unexpected comparisons\n• Callback to earlier jokes for bigger laughs' }
  };

  const template = storyTemplates[genre] || storyTemplates.fantasy;
  const embed = new EmbedBuilder()
    .setColor('#9B59B6')
    .setTitle(`📖 ${capitalizeFirst(genre)} Story`)
    .setDescription(template.starter + template.middle + template.end)
    .addFields(
      { name: '🎭 Prompt Used', value: prompt, inline: false },
      { name: '✍️ Writing Tips', value: template.tips, inline: false }
    )
    .setFooter({ text: 'Keep writing and let your creativity flow!' })
    .setTimestamp();
  return interaction.editReply({ embeds: [embed] });
}

export async function handlePrompt(interaction) {
  const type = interaction.options.getString('type');
  const prompts = {
    writing: [
      { prompt: 'Write a story where the protagonist wakes up with the ability to hear what objects are thinking.', tips: 'Give each object a unique personality.', difficulty: '⭐⭐ Medium', time: '30-60 minutes' },
      { prompt: 'The last person on Earth sits alone in a room. There is a knock on the door.', tips: 'This classic prompt has endless possibilities. Subvert expectations!', difficulty: '⭐⭐ Medium', time: '20-40 minutes' },
      { prompt: 'Write a letter from a villain explaining why they were actually the hero all along.', tips: 'Make their reasoning compelling.', difficulty: '⭐⭐⭐ Advanced', time: '30-45 minutes' },
      { prompt: 'Describe a color to someone who has been blind from birth.', tips: 'Focus on emotions, temperature, textures, sounds.', difficulty: '⭐⭐⭐ Advanced', time: '15-30 minutes' },
      { prompt: 'In a world where everyone can read minds, write about the only person who can\'t.', tips: 'Flip the perspective - is this a disability or a superpower?', difficulty: '⭐⭐ Medium', time: '30-60 minutes' }
    ],
    art: [
      { prompt: 'Draw a city where nature has reclaimed all the buildings.', tips: 'Think about vines on skyscrapers, trees through windows.', difficulty: '⭐⭐⭐ Advanced', time: '2-4 hours' },
      { prompt: 'Create a character design for an emotion. Pick one and personify it.', tips: 'Use color psychology and body language.', difficulty: '⭐⭐ Medium', time: '1-2 hours' },
      { prompt: 'Design a creature that\'s a combination of three random animals.', tips: 'Think about how the features would work together.', difficulty: '⭐⭐ Medium', time: '1-3 hours' }
    ],
    photo: [
      { prompt: 'Capture "time" without using clocks, watches, or calendars.', tips: 'Look for tree rings, weathered objects, shadows.', difficulty: '⭐⭐⭐ Advanced', time: '1-2 hours' },
      { prompt: 'Take photos that tell a story using only hands - no faces.', tips: 'Hands are incredibly expressive.', difficulty: '⭐⭐ Medium', time: '30-60 minutes' },
      { prompt: 'Find beauty in something typically considered ugly or mundane.', tips: 'Try macro photography or unusual angles.', difficulty: '⭐⭐⭐ Advanced', time: '1-2 hours' }
    ],
    music: [
      { prompt: 'Compose a 30-second piece using only three notes.', tips: 'Limitation breeds creativity. Use rhythm and dynamics.', difficulty: '⭐⭐ Medium', time: '30-60 minutes' },
      { prompt: 'Create a melody based on conversational speech rhythm.', tips: 'Natural speech has musicality.', difficulty: '⭐ Easy', time: '20-40 minutes' },
      { prompt: 'Create a piece using only sounds from everyday objects.', tips: 'Tap, scrape, shake - everything can be percussion.', difficulty: '⭐⭐ Medium', time: '1-3 hours' }
    ]
  };

  const categoryPrompts = prompts[type] || prompts.writing;
  const randomPrompt = categoryPrompts[Math.floor(Math.random() * categoryPrompts.length)];

  const embed = new EmbedBuilder()
    .setColor('#F39C12')
    .setTitle(`✨ ${capitalizeFirst(type)} Prompt`)
    .setDescription(randomPrompt.prompt)
    .addFields(
      { name: '💡 Tips', value: randomPrompt.tips, inline: false },
      { name: '🎯 Challenge Level', value: randomPrompt.difficulty, inline: true },
      { name: '⏱️ Suggested Time', value: randomPrompt.time, inline: true }
    )
    .setFooter({ text: 'Use this prompt as inspiration and make it your own!' })
    .setTimestamp();
  return interaction.reply({ embeds: [embed] });
}

export async function handleColor(interaction) {
  const mood = interaction.options.getString('mood') || 'random';
  const palettes = {
    vibrant: { name: 'Electric Dreams', description: 'Bold, energetic colors that demand attention.', primary: '#FF006E', colors: [{ hex: '#FF006E', name: 'Hot Magenta' }, { hex: '#FB5607', name: 'Orange Burst' }, { hex: '#FFBE0B', name: 'Electric Yellow' }, { hex: '#8338EC', name: 'Vivid Purple' }, { hex: '#3A86FF', name: 'Brilliant Blue' }], tips: 'Use these colors sparingly as accents.', bestFor: 'Youth brands, tech startups, music festivals', mood: '⚡ Energetic & Bold' },
    pastel: { name: 'Soft Whispers', description: 'Gentle, dreamy colors.', primary: '#FFB5E8', colors: [{ hex: '#FFB5E8', name: 'Blush Pink' }, { hex: '#B5DEFF', name: 'Baby Blue' }, { hex: '#C7FFDA', name: 'Mint Cream' }, { hex: '#FFF5BA', name: 'Butter Yellow' }, { hex: '#E7C6FF', name: 'Lavender Mist' }], tips: 'Perfect for backgrounds and large areas.', bestFor: 'Wellness, baby products, spring themes', mood: '🌸 Calm & Dreamy' },
    dark: { name: 'Midnight Mystery', description: 'Deep, sophisticated colors.', primary: '#1A1A2E', colors: [{ hex: '#0F0E17', name: 'Deep Space' }, { hex: '#1A1A2E', name: 'Midnight Blue' }, { hex: '#16213E', name: 'Navy Shadow' }, { hex: '#533483', name: 'Royal Purple' }, { hex: '#E94560', name: 'Crimson Accent' }], tips: 'Use light text on these backgrounds.', bestFor: 'Luxury brands, gaming, modern tech', mood: '🌙 Elegant & Mysterious' },
    earth: { name: 'Natural Harmony', description: 'Organic, grounding colors.', primary: '#8B7355', colors: [{ hex: '#8B7355', name: 'Clay Brown' }, { hex: '#A0937D', name: 'Warm Sand' }, { hex: '#C9B8A3', name: 'Desert Stone' }, { hex: '#6B8E6F', name: 'Sage Green' }, { hex: '#5D5D5A', name: 'Charcoal Gray' }], tips: 'These colors work beautifully together.', bestFor: 'Eco-friendly brands, coffee shops', mood: '🌿 Grounded & Natural' },
    ocean: { name: 'Deep Blue Sea', description: 'Cool, flowing colors.', primary: '#006BA6', colors: [{ hex: '#003566', name: 'Deep Ocean' }, { hex: '#006BA6', name: 'Pacific Blue' }, { hex: '#0496FF', name: 'Surf Blue' }, { hex: '#73D2DE', name: 'Aqua Splash' }, { hex: '#E8F4F8', name: 'Sea Foam' }], tips: 'Create depth with darker blues for backgrounds.', bestFor: 'Marine businesses, travel, wellness', mood: '🌊 Calm & Flowing' },
    sunset: { name: 'Golden Hour', description: 'Warm, nostalgic colors.', primary: '#F77F00', colors: [{ hex: '#780116', name: 'Wine Red' }, { hex: '#C1121F', name: 'Sunset Crimson' }, { hex: '#F77F00', name: 'Amber Orange' }, { hex: '#FCBF49', name: 'Golden Yellow' }, { hex: '#EAE2B7', name: 'Cream' }], tips: 'This gradient works beautifully from dark to light.', bestFor: 'Restaurants, hospitality, autumn themes', mood: '🌅 Warm & Nostalgic' },
    random: { name: 'Creative Chaos', description: 'Randomly generated palette.', primary: randomHexColor(), colors: Array.from({ length: 5 }, () => ({ hex: randomHexColor(), name: 'Mystery Color' })), tips: 'Sometimes the best designs come from unexpected combinations.', bestFor: 'Experimental projects, abstract art', mood: '🎲 Unexpected & Unique' }
  };

  const palette = palettes[mood] || palettes.random;
  const embed = new EmbedBuilder()
    .setColor(palette.primary)
    .setTitle(`🎨 ${palette.name} Color Palette`)
    .setDescription(palette.description)
    .addFields(
      { name: '🎨 Colors', value: palette.colors.map((c, i) => `**${i + 1}.** \`${c.hex}\` - ${c.name}`).join('\n'), inline: false },
      { name: '💡 Usage Tips', value: palette.tips, inline: false },
      { name: '🖌️ Best For', value: palette.bestFor, inline: true },
      { name: '🎭 Mood', value: palette.mood, inline: true }
    )
    .setFooter({ text: 'Use these hex codes in your designs!' })
    .setTimestamp();
  return interaction.reply({ embeds: [embed] });
}
