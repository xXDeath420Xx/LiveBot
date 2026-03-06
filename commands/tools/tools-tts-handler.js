import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { synthesize, getAvailableVoices, getVoicesByLanguage, getVoiceInfo } from '../../utils/piper-tts.js';
import logger from '../../utils/logger.js';
import fs from 'fs';

function createTTSEmbed(voiceInfo, text) {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎙️ Text-to-Speech')
    .setDescription(`**Text:** ${text.substring(0, 200)}${text.length > 200 ? '...' : ''}`)
    .addFields(
      { name: 'Voice', value: `${voiceInfo.flag} ${voiceInfo.name}`, inline: true },
      { name: 'Language', value: voiceInfo.locale, inline: true },
      { name: 'Quality', value: voiceInfo.quality, inline: true },
      { name: 'Gender', value: voiceInfo.gender, inline: true },
      { name: 'Description', value: voiceInfo.description, inline: false }
    )
    .setFooter({ text: 'Powered by PiperTTS' })
    .setTimestamp();
}

async function sendTTSFile(interaction, audioPath, voiceInfo, text) {
  const attachment = new AttachmentBuilder(audioPath, {
    name: 'tts_output.wav',
    description: `TTS: ${text.substring(0, 100)}`
  });
  const embed = createTTSEmbed(voiceInfo, text);
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ embeds: [embed], files: [attachment] });
  } else {
    await interaction.reply({ embeds: [embed], files: [attachment] });
  }
}

export async function handleSpeak(interaction) {
  await interaction.deferReply();

  const text = interaction.options.getString('text');
  const voiceName = interaction.options.getString('voice') || 'ryan';
  const playInVoice = interaction.options.getBoolean('play') || false;

  const voiceInfo = getVoiceInfo(voiceName);
  if (!voiceInfo) {
    return await interaction.editReply({
      content: `❌ Voice "${voiceName}" not found. Use \`/tools tts voices\` to see available voices.`
    });
  }

  logger.info(`[TTS] Synthesizing text for ${interaction.user.tag}: "${text.substring(0, 50)}..." using voice: ${voiceName}`);

  try {
    const audioPath = await synthesize(text, voiceName);

    if (playInVoice) {
      const member = interaction.guild.members.cache.get(interaction.user.id);
      let voiceChannel = member?.voice?.channel;

      if (!voiceChannel && interaction.user.id === process.env.BOT_OWNER_ID) {
        const availableChannels = interaction.guild.channels.cache.filter(
          channel => channel.isVoiceBased() && channel.members.size > 0
        );
        if (availableChannels.size > 0) {
          voiceChannel = availableChannels.first();
          logger.info(`[TTS] Super-Admin override: Playing into ${voiceChannel.name} without being in channel`);
        } else {
          await sendTTSFile(interaction, audioPath, voiceInfo, text);
          await interaction.followUp({ content: '⚠️ No voice channels with users found in this server.', ephemeral: true });
          return;
        }
      } else if (!voiceChannel) {
        await sendTTSFile(interaction, audioPath, voiceInfo, text);
        await interaction.followUp({ content: '⚠️ You need to be in a voice channel to play TTS audio.', ephemeral: true });
        return;
      }

      try {
        const player = interaction.client.player;
        if (!player) throw new Error('Music player not initialized for this bot');

        await player.play(voiceChannel, audioPath, {
          nodeOptions: {
            metadata: { channel: interaction.channel, client: interaction.client, requestedBy: interaction.user }
          }
        });

        await interaction.editReply({
          content: `🔊 Playing TTS in ${voiceChannel.name}`,
          embeds: [createTTSEmbed(voiceInfo, text)]
        });
      } catch (playerError) {
        logger.error('[TTS] Voice playback error:', playerError);
        await sendTTSFile(interaction, audioPath, voiceInfo, text);
        await interaction.followUp({ content: '⚠️ Could not play in voice channel, sending audio file instead.', ephemeral: true });
      }
    } else {
      await sendTTSFile(interaction, audioPath, voiceInfo, text);
    }

    setTimeout(() => {
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    }, 30000);
  } catch (error) {
    logger.error('[TTS] Synthesis error:', error);
    throw new Error(`Failed to synthesize speech: ${error.message}`);
  }
}

export async function handleVoices(interaction) {
  const languageFilter = interaction.options.getString('language');
  const voicesByLang = getVoicesByLanguage();

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🎙️ Available TTS Voices')
    .setFooter({ text: 'Use /tools tts speak voice:<name> to use a voice' })
    .setTimestamp();

  if (languageFilter) {
    const voices = voicesByLang[languageFilter] || [];
    if (voices.length === 0) {
      return await interaction.reply({ content: `❌ No voices found for language: ${languageFilter}`, ephemeral: true });
    }
    const voiceList = voices.map(v => `• **${v.name}** - ${v.description} (${v.gender}, ${v.quality})`).join('\n');
    embed.setDescription(`**${voices[0].flag} ${languageFilter}**\n\n${voiceList}`);
  } else {
    const languageSummary = Object.entries(voicesByLang)
      .map(([locale, voices]) => `${voices[0]?.flag || ''} **${locale}**: ${voices.length} voice${voices.length > 1 ? 's' : ''}`)
      .join('\n');
    embed.setDescription(
      `**${Object.keys(voicesByLang).length} languages with ${getAvailableVoices().length} total voices**\n\n` +
      languageSummary + '\n\n*Use the language filter to see specific voices*'
    );
  }

  await interaction.reply({ embeds: [embed] });
}

export async function handlePreview(interaction) {
  await interaction.deferReply();

  const voiceName = interaction.options.getString('voice');
  const voiceInfo = getVoiceInfo(voiceName);

  if (!voiceInfo) {
    return await interaction.editReply({ content: `❌ Voice "${voiceName}" not found. Use \`/tools tts voices\` to see available voices.` });
  }

  const sampleTexts = {
    en_US: 'Hello! This is a sample of my voice. How do I sound?',
    en_GB: 'Hello! This is a sample of my voice. How do I sound?',
    ar_JO: 'مرحبا! هذه عينة من صوتي', ca_ES: 'Hola! Aquesta és una mostra de la meva veu',
    cs_CZ: 'Ahoj! Toto je ukázka mého hlasu', da_DK: 'Hej! Dette er en prøve af min stemme',
    de_DE: 'Hallo! Das ist eine Probe meiner Stimme', el_GR: 'Γεια σας! Αυτό είναι ένα δείγμα της φωνής μου',
    es_ES: '¡Hola! Esta es una muestra de mi voz', es_MX: '¡Hola! Esta es una muestra de mi voz',
    fi_FI: 'Hei! Tämä on näyte äänestäni', fr_FR: 'Bonjour! Ceci est un échantillon de ma voix',
    hu_HU: 'Helló! Ez egy minta a hangomból', is_IS: 'Halló! Þetta er sýnishorn af rödd minni',
    it_IT: 'Ciao! Questo è un campione della mia voce', ja_JP: 'こんにちは！これは私の声のサンプルです',
    ka_GE: 'გამარჯობა! ეს ჩემი ხმის ნიმუშია', kk_KZ: 'Сәлем! Бұл менің дауысымның үлгісі',
    ko_KR: '안녕하세요! 이것은 제 목소리의 샘플입니다', lb_LU: 'Moien! Dëst ass e Muster vun menger Stëmm',
    ne_NP: 'नमस्ते! यो मेरो आवाजको नमूना हो', nl_NL: 'Hallo! Dit is een voorbeeld van mijn stem',
    no_NO: 'Hei! Dette er en prøve av stemmen min', pl_PL: 'Cześć! To jest próbka mojego głosu',
    pt_BR: 'Olá! Esta é uma amostra da minha voz', pt_PT: 'Olá! Esta é uma amostra da minha voz',
    ro_RO: 'Bună! Aceasta este o mostră a vocii mele', ru_RU: 'Привет! Это образец моего голоса',
    sk_SK: 'Ahoj! Toto je ukážka môjho hlasu', sl_SI: 'Pozdravljeni! To je vzorec mojega glasu',
    sr_RS: 'Здраво! Ово је узорак мог гласа', sv_SE: 'Hej! Detta är ett prov på min röst',
    sw_CD: 'Habari! Hii ni sampuli ya sauti yangu', tr_TR: 'Merhaba! Bu benim sesimin bir örneği',
    uk_UA: 'Привіт! Це зразок мого голосу', vi_VN: 'Xin chào! Đây là mẫu giọng nói của tôi',
    zh_CN: '你好！这是我的声音样本'
  };

  const sampleText = sampleTexts[voiceInfo.locale] || sampleTexts.en_US;

  try {
    const audioPath = await synthesize(sampleText, voiceName);
    await sendTTSFile(interaction, audioPath, voiceInfo, sampleText);
    setTimeout(() => {
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    }, 30000);
  } catch (error) {
    logger.error('[TTS Preview] Error:', error);
    throw new Error(`Failed to generate preview: ${error.message}`);
  }
}

export async function handleAutocomplete(interaction) {
  const focusedOption = interaction.options.getFocused(true);

  if (focusedOption.name === 'voice') {
    const voices = getAvailableVoices();
    const searchTerm = focusedOption.value.toLowerCase();
    const priorityLocales = ['en_US', 'en_GB', 'de_DE', 'fr_FR', 'es_ES', 'it_IT', 'pt_BR', 'ru_RU', 'ja_JP', 'zh_CN'];

    let filtered;
    if (searchTerm.length === 0) {
      filtered = voices.sort((a, b) => {
        const aPriority = priorityLocales.indexOf(a.locale);
        const bPriority = priorityLocales.indexOf(b.locale);
        const aP = aPriority === -1 ? 999 : aPriority;
        const bP = bPriority === -1 ? 999 : bPriority;
        if (aP !== bP) return aP - bP;
        return a.name.localeCompare(b.name);
      });
    } else {
      filtered = voices.filter(voice =>
        voice.name.toLowerCase().includes(searchTerm) ||
        voice.description.toLowerCase().includes(searchTerm) ||
        voice.locale.toLowerCase().includes(searchTerm)
      );
    }

    await interaction.respond(
      filtered.slice(0, 25).map(voice => ({
        name: `${voice.flag} ${voice.name} - ${voice.description}`.substring(0, 100),
        value: voice.name
      }))
    );
  } else if (focusedOption.name === 'language') {
    const voicesByLang = getVoicesByLanguage();
    const languages = Object.keys(voicesByLang)
      .filter(locale => locale.toLowerCase().includes(focusedOption.value.toLowerCase()))
      .slice(0, 25)
      .map(locale => {
        const voices = voicesByLang[locale];
        return { name: `${voices[0]?.flag || ''} ${locale} (${voices.length} voice${voices.length > 1 ? 's' : ''})`, value: locale };
      });
    await interaction.respond(languages);
  }
}
