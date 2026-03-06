import { EmbedBuilder } from 'discord.js';
import axios from 'axios';

const JUDGE0_API = 'https://judge0-ce.p.rapidapi.com';
const RAPID_API_KEY = '6aa4e1ee14msh96901c3b253a297p12f7aajsn180f4c79f042';
const RAPID_API_HOST = 'judge0-ce.p.rapidapi.com';

const LANGUAGES = {
  'javascript': { id: 63, name: 'JavaScript (Node.js 12.14.0)' },
  'python': { id: 71, name: 'Python (3.8.1)' },
  'java': { id: 62, name: 'Java (OpenJDK 13.0.1)' },
  'cpp': { id: 54, name: 'C++ (GCC 9.2.0)' },
  'c': { id: 50, name: 'C (GCC 9.2.0)' },
  'csharp': { id: 51, name: 'C# (Mono 6.6.0.161)' },
  'go': { id: 60, name: 'Go (1.13.5)' },
  'rust': { id: 73, name: 'Rust (1.40.0)' },
  'php': { id: 98, name: 'PHP (8.3.11)' },
  'php7': { id: 68, name: 'PHP (7.4.1)' },
  'ruby': { id: 72, name: 'Ruby (2.7.0)' },
  'swift': { id: 83, name: 'Swift (5.2.3)' },
  'kotlin': { id: 78, name: 'Kotlin (1.3.70)' },
  'typescript': { id: 74, name: 'TypeScript (3.7.4)' },
  'r': { id: 80, name: 'R (4.0.0)' },
  'perl': { id: 85, name: 'Perl (5.28.1)' },
  'lua': { id: 64, name: 'Lua (5.3.5)' },
  'bash': { id: 46, name: 'Bash (5.0.0)' },
  'sql': { id: 82, name: 'SQL (SQLite 3.27.2)' },
  'scala': { id: 81, name: 'Scala (2.13.2)' }
};

export async function handleRun(interaction) {
  await interaction.deferReply();

  const language = interaction.options.getString('language');
  const code = interaction.options.getString('code');
  const stdin = interaction.options.getString('input') || '';

  const langConfig = LANGUAGES[language];
  if (!langConfig) {
    return interaction.editReply({ content: '❌ Invalid language selected.', ephemeral: true });
  }

  if (code.length > 5000) {
    return interaction.editReply({ content: '❌ Code is too long. Please limit to 5000 characters.', ephemeral: true });
  }

  try {
    const submitResponse = await axios.post(
      `${JUDGE0_API}/submissions`,
      {
        source_code: Buffer.from(code).toString('base64'),
        language_id: langConfig.id,
        stdin: stdin ? Buffer.from(stdin).toString('base64') : '',
        base64_encoded: true
      },
      {
        headers: { 'Content-Type': 'application/json', 'X-RapidAPI-Key': RAPID_API_KEY, 'X-RapidAPI-Host': RAPID_API_HOST },
        params: { base64_encoded: 'true', wait: 'false' }
      }
    );

    const token = submitResponse.data.token;
    if (!token) throw new Error('No submission token received');

    let result = null;
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const resultResponse = await axios.get(
        `${JUDGE0_API}/submissions/${token}`,
        {
          headers: { 'X-RapidAPI-Key': RAPID_API_KEY, 'X-RapidAPI-Host': RAPID_API_HOST },
          params: { base64_encoded: 'true', fields: 'stdout,stderr,status,time,memory,compile_output' }
        }
      );
      result = resultResponse.data;
      if (result.status && result.status.id > 2) break;
    }

    if (!result) throw new Error('Execution timed out');

    const stdout = result.stdout ? Buffer.from(result.stdout, 'base64').toString('utf-8') : '';
    const stderr = result.stderr ? Buffer.from(result.stderr, 'base64').toString('utf-8') : '';
    const compileOutput = result.compile_output ? Buffer.from(result.compile_output, 'base64').toString('utf-8') : '';
    const hasError = result.status.id > 3 || stderr || compileOutput;

    const embed = new EmbedBuilder()
      .setColor(hasError ? '#E74C3C' : '#2ECC71')
      .setTitle(`💻 Code Execution - ${langConfig.name}`)
      .setDescription('**Code:**\n```' + language + '\n' + (code.length > 500 ? code.substring(0, 497) + '...' : code) + '\n```')
      .setFooter({ text: `Status: ${result.status.description} • Powered by Judge0` })
      .setTimestamp();

    if (stdout) embed.addFields({ name: '📤 Output', value: '```\n' + (stdout.length > 1000 ? stdout.substring(0, 997) + '...' : stdout) + '\n```' });
    if (stderr) embed.addFields({ name: '⚠️ Stderr', value: '```\n' + (stderr.length > 1000 ? stderr.substring(0, 997) + '...' : stderr) + '\n```' });
    if (compileOutput) embed.addFields({ name: '🔧 Compile Output', value: '```\n' + (compileOutput.length > 1000 ? compileOutput.substring(0, 997) + '...' : compileOutput) + '\n```' });
    if (!stdout && !stderr && !compileOutput) embed.addFields({ name: '📤 Output', value: '```\n(No output)\n```' });
    if (result.time) embed.addFields({ name: '⏱️ Time', value: `${result.time}s`, inline: true });
    if (result.memory) embed.addFields({ name: '💾 Memory', value: `${(result.memory / 1024).toFixed(2)} MB`, inline: true });

    return interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error('[Code Execution Error]', error);
    return interaction.editReply({
      content: `❌ Code execution failed: ${error.message}\n\nThe code may contain errors or the service is temporarily unavailable.`,
      ephemeral: true
    });
  }
}

export async function handleLanguages(interaction) {
  const embed = new EmbedBuilder()
    .setColor('#5865F2')
    .setTitle('🌐 Supported Programming Languages')
    .setDescription('Execute code in any of these languages using `/tools code run`')
    .addFields(
      { name: '🔥 Popular Languages', value: '• JavaScript (Node.js)\n• Python 3\n• Java\n• C++\n• C\n• C#\n• Go\n• Rust', inline: true },
      { name: '💎 Modern Languages', value: '• TypeScript\n• Swift\n• Kotlin\n• Scala\n• PHP\n• Ruby\n• R\n• Lua', inline: true },
      { name: '🛠️ Scripting & Others', value: '• Bash\n• Perl\n• SQL (SQLite)\n• And 30+ more!', inline: true }
    )
    .addFields(
      { name: '📚 Usage Example', value: '```\n/tools code run language:Python code:print("Hello World!")\n```' },
      { name: '⚡ Features', value: '• Safe sandboxed execution\n• Support for standard input\n• Execution time tracking\n• Error reporting\n• 5000 character code limit' }
    )
    .setFooter({ text: 'Perfect for learning, testing snippets, and code sharing!' })
    .setTimestamp();

  return interaction.reply({ embeds: [embed] });
}
