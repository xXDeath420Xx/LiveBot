import fs from 'node:fs';
import pool from './utils/db.js';
import * as wordBank from './core/word-bank.js';
import { bindChannel, createSession } from './core/word-game-manager.js';
import { initState as llInit } from './core/games/last-letter.js';
import { initState as storyInit } from './core/games/one-word-story.js';
import { initState as coordleInit } from './core/games/coordle.js';
import { freshGridState } from './core/games/wordseek-runtime.js';
const G='1469931133981687873';
const ch=JSON.parse(fs.readFileSync('/tmp/gamechans.json','utf8'));
wordBank.load();

// 1) Counting
await pool.execute('INSERT INTO counting_channels (guild_id, channel_id, current_count, is_active) VALUES (?,?,0,1) ON DUPLICATE KEY UPDATE is_active=1',[G,ch.counting]);
console.log('counting enabled');

// 2) Word games (bind + persistent session so handleWordGameMessage finds them after rehydrate)
const wg=[['last_letter',ch.last_letter,()=>llInit()],['one_word_story',ch.one_word_story,()=>storyInit()],
         ['coordle',ch.coordle,()=>coordleInit(wordBank.randomAnswer(5)||'crane')],['wordseek',ch.wordseek,()=>freshGridState()]];
for(const [type,channelId,mk] of wg){
  await bindChannel({guildId:G, channelId, gameType:type, createdBy:'365905620060340224'});
  await createSession({guildId:G, channelId, gameType:type, mode:'persistent', hostUserId:'365905620060340224', state:mk()});
  console.log('word game bound:', type, '->', channelId);
}

// 3) OwO
await pool.execute(
 `INSERT INTO owo_config (guild_id, enabled, allowed_channel_ids) VALUES (?,1,?)
  ON DUPLICATE KEY UPDATE enabled=1, allowed_channel_ids=VALUES(allowed_channel_ids)`,
 [G, JSON.stringify([ch.owo])]);
console.log('owo enabled in', ch.owo);
process.exit(0);
