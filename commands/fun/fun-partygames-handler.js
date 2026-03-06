import { EmbedBuilder } from 'discord.js';

export async function handleWouldYouRather(interaction) {
  const questions = [
    { optionA: 'Have the ability to fly', optionB: 'Have the ability to become invisible' },
    { optionA: 'Travel 100 years into the past', optionB: 'Travel 100 years into the future' },
    { optionA: 'Always be 10 minutes late', optionB: 'Always be 20 minutes early' },
    { optionA: 'Never use social media again', optionB: 'Never watch another movie or TV show' },
    { optionA: 'Live without music', optionB: 'Live without movies' },
    { optionA: 'Be able to speak all foreign languages', optionB: 'Be able to talk to animals' },
    { optionA: 'Live in a world without art', optionB: 'Live in a world without science' },
    { optionA: 'Have unlimited money', optionB: 'Have unlimited time' },
    { optionA: 'Be famous but poor', optionB: 'Be rich but unknown' },
    { optionA: 'Live in the ocean', optionB: 'Live in outer space' },
    { optionA: 'Never have to sleep', optionB: 'Never have to eat' },
    { optionA: 'Be able to read minds', optionB: 'Be able to see the future' },
    { optionA: 'Have a personal chef', optionB: 'Have a personal chauffeur' },
    { optionA: 'Fight 100 duck-sized horses', optionB: 'Fight 1 horse-sized duck' },
    { optionA: 'Always have to say everything on your mind', optionB: 'Never speak again' }
  ];
  const question = questions[Math.floor(Math.random() * questions.length)];
  const embed = new EmbedBuilder()
    .setColor('#E91E63').setTitle('🤔 Would You Rather?').setDescription('Make your choice!')
    .addFields({ name: '🅰️ Option A', value: question.optionA, inline: false }, { name: '🅱️ Option B', value: question.optionB, inline: false })
    .setFooter({ text: 'Discuss your choice with others!' }).setTimestamp();
  return interaction.reply({ embeds: [embed] });
}

export async function handleRiddle(interaction) {
  const difficulty = interaction.options.getString('difficulty') || 'medium';
  const riddles = {
    easy: [
      { question: 'What has hands but can\'t clap?', answer: 'A clock', hint: 'It tells time' },
      { question: 'What has a head and a tail but no body?', answer: 'A coin', hint: 'You can flip it' },
      { question: 'What gets wet while drying?', answer: 'A towel', hint: 'Found in the bathroom' },
      { question: 'What has to be broken before you can use it?', answer: 'An egg', hint: 'You eat it for breakfast' },
      { question: 'I\'m tall when I\'m young, and I\'m short when I\'m old. What am I?', answer: 'A candle', hint: 'It gives light' }
    ],
    medium: [
      { question: 'What can travel around the world while staying in a corner?', answer: 'A stamp', hint: 'Found on mail' },
      { question: 'I have cities, but no houses. I have mountains, but no trees. I have water, but no fish. What am I?', answer: 'A map', hint: 'Used for navigation' },
      { question: 'The more you take, the more you leave behind. What am I?', answer: 'Footsteps', hint: 'Made when walking' },
      { question: 'What begins with T, ends with T, and has T in it?', answer: 'A teapot', hint: 'Used for drinks' },
      { question: 'I speak without a mouth and hear without ears. What am I?', answer: 'An echo', hint: 'Bounces back' }
    ],
    hard: [
      { question: 'I am not alive, but I grow; I don\'t have lungs, but I need air; water kills me. What am I?', answer: 'Fire', hint: 'Hot and bright' },
      { question: 'What disappears as soon as you say its name?', answer: 'Silence', hint: 'The opposite of noise' },
      { question: 'Turn me on my side and I am everything. Cut me in half and I am nothing. What am I?', answer: 'The number 8', hint: 'It\'s a number' },
      { question: 'I have keys but no locks. I have space but no room. You can enter, but you can\'t go inside. What am I?', answer: 'A keyboard', hint: 'Used for typing' },
      { question: 'What word: first two letters signify a male, first three a female, first four a great, entire word a great woman?', answer: 'Heroine', hint: 'Female hero' }
    ]
  };
  const riddle = (riddles[difficulty] || riddles.medium)[Math.floor(Math.random() * (riddles[difficulty] || riddles.medium).length)];
  const embed = new EmbedBuilder()
    .setColor('#9C27B0').setTitle(`🧩 Riddle (${capitalizeFirst(difficulty)})`).setDescription(riddle.question)
    .addFields({ name: '💡 Hint', value: riddle.hint }, { name: '📝 Answer', value: `||${riddle.answer}||` })
    .setFooter({ text: 'Click the spoiler to reveal the answer!' }).setTimestamp();
  return interaction.reply({ embeds: [embed] });
}

export async function handleTruthOrDare(interaction) {
  const choice = interaction.options.getString('choice');
  const truths = ['What is your biggest fear?', 'What is the most embarrassing thing you\'ve ever done?', 'Have you ever told a lie that got you into trouble?', 'What is your worst habit?', 'What is something you\'re glad your parents don\'t know about you?', 'What is the most childish thing you still do?', 'What is your biggest insecurity?', 'Have you ever cheated on a test?', 'What is the worst gift you\'ve ever received?', 'What is your most embarrassing nickname?', 'What is the weirdest dream you\'ve ever had?', 'Who was your first crush?', 'What is something you do when nobody is watching?', 'What is the longest you\'ve gone without showering?', 'What is your guilty pleasure?'];
  const dares = ['Do 20 pushups right now', 'Post an embarrassing photo of yourself', 'Speak in an accent for the next 10 minutes', 'Send a silly message to a random contact', 'Do your best impression of someone in this server', 'Change your profile picture to something embarrassing for 24 hours', 'Share your most recent photo', 'Sing your favorite song out loud', 'Do a dance and record it', 'Talk in the third person for the next hour', 'Write a poem about the person to your left', 'Let someone else write your status for 24 hours', 'Do 30 jumping jacks', 'Speak without closing your mouth for 2 minutes', 'Act like your favorite animal for 1 minute'];
  const result = choice === 'truth' ? truths[Math.floor(Math.random() * truths.length)] : dares[Math.floor(Math.random() * dares.length)];
  const embed = new EmbedBuilder()
    .setColor(choice === 'truth' ? '#2196F3' : '#FF5722').setTitle(choice === 'truth' ? '🤐 Truth' : '🎭 Dare').setDescription(result)
    .setFooter({ text: 'Have fun, but be safe!' }).setTimestamp();
  return interaction.reply({ embeds: [embed] });
}

export async function handleNeverHaveIEver(interaction) {
  const statements = ['Never have I ever skipped school', 'Never have I ever told a lie to get out of trouble', 'Never have I ever eaten food that fell on the floor', 'Never have I ever stalked someone on social media', 'Never have I ever pretended to like a gift', 'Never have I ever laughed at an inappropriate moment', 'Never have I ever sung in the shower', 'Never have I ever talked to myself', 'Never have I ever re-gifted something', 'Never have I ever forgotten someone\'s name right after meeting them', 'Never have I ever binge-watched an entire series in one day', 'Never have I ever pretended to know something I didn\'t', 'Never have I ever accidentally sent a message to the wrong person', 'Never have I ever fallen asleep during a movie', 'Never have I ever googled myself'];
  const embed = new EmbedBuilder()
    .setColor('#4CAF50').setTitle('🙋 Never Have I Ever').setDescription(`**${statements[Math.floor(Math.random() * statements.length)]}**`)
    .setFooter({ text: 'React if you HAVE done this!' }).setTimestamp();
  return interaction.reply({ embeds: [embed] });
}

export async function handleTrivia(interaction) {
  const difficulty = interaction.options.getString('difficulty') || 'medium';
  const triviaQuestions = {
    easy: [{ question: 'What is the capital of France?', answer: 'Paris', options: ['London', 'Paris', 'Berlin', 'Madrid'] }, { question: 'How many continents are there?', answer: '7', options: ['5', '6', '7', '8'] }, { question: 'What is the largest planet in our solar system?', answer: 'Jupiter', options: ['Mars', 'Saturn', 'Jupiter', 'Neptune'] }],
    medium: [{ question: 'What year did World War II end?', answer: '1945', options: ['1943', '1944', '1945', '1946'] }, { question: 'What is the smallest country in the world?', answer: 'Vatican City', options: ['Monaco', 'Vatican City', 'San Marino', 'Liechtenstein'] }, { question: 'Who painted the Mona Lisa?', answer: 'Leonardo da Vinci', options: ['Michelangelo', 'Leonardo da Vinci', 'Raphael', 'Donatello'] }],
    hard: [{ question: 'What is the only metal that is liquid at room temperature?', answer: 'Mercury', options: ['Mercury', 'Gallium', 'Cesium', 'Francium'] }, { question: 'In what year was the first iPhone released?', answer: '2007', options: ['2005', '2006', '2007', '2008'] }, { question: 'What is the rarest blood type?', answer: 'AB negative', options: ['O negative', 'AB negative', 'B negative', 'A negative'] }]
  };
  const questions = triviaQuestions[difficulty] || triviaQuestions.medium;
  const trivia = questions[Math.floor(Math.random() * questions.length)];
  const embed = new EmbedBuilder()
    .setColor('#FFC107').setTitle(`🧠 Trivia (${capitalizeFirst(difficulty)})`).setDescription(trivia.question)
    .addFields({ name: '📋 Options', value: trivia.options.map((opt, i) => `${String.fromCharCode(65 + i)}. ${opt}`).join('\n') }, { name: '✅ Answer', value: `||${trivia.answer}||` })
    .setFooter({ text: 'Click the spoiler to reveal the answer!' }).setTimestamp();
  return interaction.reply({ embeds: [embed] });
}

export async function handleAnagram(interaction) {
  const words = [
    { word: 'LISTEN', anagram: 'SILENT', hint: 'Opposite of loud' },
    { word: 'EARTH', anagram: 'HEART', hint: 'Body organ' },
    { word: 'DESPERATION', anagram: 'A ROPE ENDS IT', hint: 'Extreme measure' },
    { word: 'THE MORSE CODE', anagram: 'HERE COME DOTS', hint: 'Communication system' },
    { word: 'ASTRONOMER', anagram: 'MOON STARER', hint: 'Someone who studies space' },
    { word: 'DORMITORY', anagram: 'DIRTY ROOM', hint: 'Messy sleeping place' },
    { word: 'CONVERSATION', anagram: 'VOICES RANT ON', hint: 'People talking' },
    { word: 'ELEVEN PLUS TWO', anagram: 'TWELVE PLUS ONE', hint: 'Both equal 13' },
    { word: 'DEBIT CARD', anagram: 'BAD CREDIT', hint: 'Financial problem' },
    { word: 'SLOT MACHINES', anagram: 'CASH LOST IN ME', hint: 'Casino warning' }
  ];
  const puzzle = words[Math.floor(Math.random() * words.length)];
  const embed = new EmbedBuilder()
    .setColor('#00BCD4').setTitle('🔤 Anagram Puzzle').setDescription(`Rearrange these letters:\n\n**${puzzle.word}**`)
    .addFields({ name: '💡 Hint', value: puzzle.hint }, { name: '✅ Answer', value: `||${puzzle.anagram}||` })
    .setFooter({ text: 'Click the spoiler to reveal the answer!' }).setTimestamp();
  return interaction.reply({ embeds: [embed] });
}

export async function handleMathChallenge(interaction) {
  const difficulty = interaction.options.getString('difficulty') || 'medium';
  let question, answer;

  if (difficulty === 'easy') {
    const num1 = Math.floor(Math.random() * 20) + 1;
    const num2 = Math.floor(Math.random() * 20) + 1;
    const operator = ['+', '-'][Math.floor(Math.random() * 2)];
    answer = operator === '+' ? num1 + num2 : num1 - num2;
    question = `${num1} ${operator} ${num2} = ?`;
  } else if (difficulty === 'medium') {
    let num1 = Math.floor(Math.random() * 15) + 1;
    const num2 = Math.floor(Math.random() * 12) + 1;
    const operator = ['×', '÷', '+', '-'][Math.floor(Math.random() * 4)];
    if (operator === '×') { answer = num1 * num2; question = `${num1} × ${num2} = ?`; }
    else if (operator === '÷') { answer = num1; num1 = num1 * num2; question = `${num1} ÷ ${num2} = ?`; }
    else if (operator === '+') { answer = num1 + num2; question = `${num1} + ${num2} = ?`; }
    else { answer = num1 - num2; question = `${num1} - ${num2} = ?`; }
  } else {
    const challengeTypes = [
      () => { const perfect = [1, 4, 9, 16, 25, 36, 49, 64, 81, 100, 121, 144]; const num = perfect[Math.floor(Math.random() * perfect.length)]; return { question: `√${num} = ?`, answer: Math.sqrt(num) }; },
      () => { const base = Math.floor(Math.random() * 10) + 2; const exp = Math.floor(Math.random() * 3) + 2; return { question: `${base}^${exp} = ?`, answer: Math.pow(base, exp) }; },
      () => { const whole = Math.floor(Math.random() * 200) + 50; const percent = [10, 20, 25, 50, 75][Math.floor(Math.random() * 5)]; return { question: `${percent}% of ${whole} = ?`, answer: (whole * percent) / 100 }; }
    ];
    const challenge = challengeTypes[Math.floor(Math.random() * challengeTypes.length)]();
    question = challenge.question;
    answer = challenge.answer;
  }

  const embed = new EmbedBuilder()
    .setColor('#673AB7').setTitle(`🧮 Math Challenge (${capitalizeFirst(difficulty)})`).setDescription(`Solve this:\n\n**${question}**`)
    .addFields({ name: '✅ Answer', value: `||${answer}||` })
    .setFooter({ text: 'Click the spoiler to reveal the answer!' }).setTimestamp();
  return interaction.reply({ embeds: [embed] });
}

function capitalizeFirst(str) { return str.charAt(0).toUpperCase() + str.slice(1); }
