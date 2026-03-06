/**
 * RPG AI Dungeon Master
 * Core AI engine for running D&D campaigns using Google Gemini API
 * Handles narrative generation, NPC interactions, combat management, and world simulation
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { pool } from '../utils/db.js';
import logger from '../utils/logger.js';
import RPGDiceEngine from './rpg-dice-engine.js';
import RPGStateManager from './rpg-state-manager.js';

// Initialize Gemini client
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || '');
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });

// DM Personality templates
const DM_PERSONALITIES = {
    classic: {
        name: 'Classic DM',
        style: 'Traditional fantasy narration with vivid descriptions and fair challenges.',
        tone: 'Epic and adventurous, with moments of humor and drama.',
        narration: 'Third person, descriptive'
    },
    gritty: {
        name: 'Gritty Realist',
        style: 'Dark, realistic fantasy with consequences and moral ambiguity.',
        tone: 'Serious and tense, focusing on survival and difficult choices.',
        narration: 'Immersive, atmospheric'
    },
    comedic: {
        name: 'Comedic DM',
        style: 'Lighthearted adventures with humor, puns, and silly situations.',
        tone: 'Fun and playful, never taking itself too seriously.',
        narration: 'Witty, with occasional fourth-wall breaks'
    },
    horror: {
        name: 'Horror Master',
        style: 'Psychological horror with creeping dread and terrifying reveals.',
        tone: 'Ominous and unsettling, building tension slowly.',
        narration: 'Atmospheric, focusing on sensory details'
    },
    heroic: {
        name: 'Heroic Epic',
        style: 'High fantasy with legendary heroes and world-shaking events.',
        tone: 'Inspiring and grandiose, celebrating player achievements.',
        narration: 'Epic and dramatic'
    }
};

// Campaign settings/worlds
const CAMPAIGN_SETTINGS = {
    'forgotten_realms': {
        name: 'Forgotten Realms',
        description: 'The classic D&D setting with Waterdeep, Baldur\'s Gate, and the Sword Coast.',
        themes: ['adventure', 'magic', 'political intrigue'],
        startingLocations: ['Waterdeep', 'Baldur\'s Gate', 'Neverwinter', 'Phandalin']
    },
    'eberron': {
        name: 'Eberron',
        description: 'A world of noir intrigue, warforged, and magical technology.',
        themes: ['noir', 'intrigue', 'magitech'],
        startingLocations: ['Sharn', 'Stormreach', 'Korranberg']
    },
    'ravenloft': {
        name: 'Ravenloft',
        description: 'The Domains of Dread, ruled by dark lords and shrouded in mist.',
        themes: ['horror', 'gothic', 'survival'],
        startingLocations: ['Village of Barovia', 'Vallaki', 'Darkon']
    },
    'homebrew': {
        name: 'Homebrew World',
        description: 'A unique custom world generated based on player preferences.',
        themes: ['flexible', 'custom'],
        startingLocations: ['Generated based on story']
    },
    'custom': {
        name: 'Custom World',
        description: 'A unique world generated based on player preferences.',
        themes: ['flexible'],
        startingLocations: ['Generated']
    }
};

class RPGAiDungeonMaster {
    /**
     * Get session state (delegates to RPGStateManager)
     */
    static getSessionState(sessionId) {
        return RPGStateManager.getSessionState(sessionId);
    }

    /**
     * Generate the system prompt for the AI DM
     */
    static buildSystemPrompt(campaign, session, characters) {
        const personality = DM_PERSONALITIES[campaign.ai_personality] || DM_PERSONALITIES.classic;
        const setting = CAMPAIGN_SETTINGS[campaign.setting?.toLowerCase().replace(/ /g, '_')] || CAMPAIGN_SETTINGS.forgotten_realms;

        let prompt = `You are an expert Dungeon Master running a D&D 5th Edition campaign.

## Your Role
You are the AI Dungeon Master for "${campaign.campaign_name}", a ${campaign.campaign_type} campaign.
Your DM style is: ${personality.name} - ${personality.style}
Tone: ${personality.tone}
Narration style: ${personality.narration}

## Setting
World: ${setting.name}
${setting.description}
Campaign Theme: ${campaign.theme || 'Classic fantasy adventure'}
Difficulty: ${campaign.difficulty || 'Normal'}

## Core Rules - AUTHENTIC D&D 5E
1. NEVER break character as the DM
2. ALWAYS respect player agency - let them attempt anything reasonable
3. Use "Yes, and..." philosophy - build on player ideas
4. Keep responses concise but evocative (2-4 paragraphs for narration)
5. When a roll is needed, specify the EXACT skill/save and DC in this format: {{ROLL:skill_name:DC}}
6. Track and remember consequences - choices matter
7. Create memorable NPCs with distinct voices
8. Balance challenge with fun - use APPROPRIATE DCs from the table below
9. End scenes with hooks or questions to prompt player action
10. When giving rewards, use format: {{LOOT:item_name:quantity}} or {{GOLD:amount}} or {{XP:amount}}
11. When player SPENDS gold (buying items, paying fees, etc), use format: {{SPEND_GOLD:amount}}
12. When location changes, use format: {{LOCATION:new_location_name}}
13. When introducing an NPC, use format: {{NPC:name:brief_description}}

## D&D 5E DIFFICULTY CLASS (DC) GUIDELINES
- DC 5: Very Easy (nearly automatic)
- DC 10: Easy (simple task, moderate chance of failure)
- DC 15: Medium (challenging but achievable)
- DC 20: Hard (requires expertise or luck)
- DC 25: Very Hard (near-impossible for most)
- DC 30: Nearly Impossible (legendary feats)
USE APPROPRIATE DCs! Don't make everything DC 20+. A simple lock is DC 10-12, not DC 20.

## D&D 5E COMBAT RULES (CRITICAL)
- Attack rolls target AC (Armor Class), not DC
- Damage is separate from attack rolls - on a HIT, deal damage
- NAT 20 on attack = CRITICAL HIT (double damage dice!)
- NAT 1 on attack = AUTOMATIC MISS (regardless of bonuses)
- When player drops to 0 HP: They fall UNCONSCIOUS and must make death saves
- Death Saving Throws: At start of turn at 0 HP, roll d20. 10+ = success, below 10 = failure
  - 3 successes = STABLE (unconscious but not dying)
  - 3 failures = DEAD
  - NAT 20 = regain 1 HP and consciousness!
  - NAT 1 = counts as 2 failures
- Taking damage at 0 HP = 1 automatic death save failure (critical hit = 2 failures)

## D&D 5E ADVANTAGE/DISADVANTAGE
- Advantage: Roll 2d20, take HIGHER result. Grant when circumstances favor the player (surprise, help, clever tactics)
- Disadvantage: Roll 2d20, take LOWER result. Apply when circumstances hinder (blinded, restrained, difficult terrain)
- Multiple advantages/disadvantages: They cancel out (1 of each = normal roll)
- Use {{ROLL:skill:DC:ADVANTAGE}} or {{ROLL:skill:DC:DISADVANTAGE}} when appropriate

## D&D 5E EXHAUSTION (Track this!)
Level 1: Disadvantage on ability checks
Level 2: Speed halved
Level 3: Disadvantage on attacks and saves
Level 4: HP maximum halved
Level 5: Speed reduced to 0
Level 6: DEATH
Cause exhaustion from: Forced march, starvation, exposure, some spells/effects

## D&D 5E REST RULES
- Short Rest (1 hour): Can spend Hit Dice to heal (roll + CON mod per die)
- Long Rest (8 hours): Full HP recovery, recover half spent Hit Dice, reset abilities

## D&D 5E ABILITY CHECKS
- STR: Athletics, lifting, breaking, climbing
- DEX: Acrobatics, Sleight of Hand, Stealth, initiative
- CON: Maintaining concentration, resisting poison/disease, endurance
- INT: Arcana, History, Investigation, Nature, Religion
- WIS: Animal Handling, Insight, Medicine, Perception, Survival
- CHA: Deception, Intimidation, Performance, Persuasion

## Roll Format (CRITICAL - READ CAREFULLY)
When a check is needed, embed it EXACTLY like this in your narration:
- For skill checks: {{ROLL:perception:DC15}} or {{ROLL:stealth:DC12}}
- For saves: {{ROLL:dex_save:DC14}} or {{ROLL:con_save:DC16}}
- For attacks: {{ROLL:attack:AC15}}
- For initiative: {{ROLL:initiative:DC0}}

**IMPORTANT**: You do NOT know the roll result! The system rolls AFTER you write.
You MUST use conditional outcome tags to handle BOTH success AND failure:

Example format:
"You attempt to convince the guard. {{ROLL:persuasion:DC13}} {{SUCCESS:The guard nods and steps aside, allowing you passage.}} {{FAIL:The guard sees through your deception and reaches for his weapon.}}"

- {{SUCCESS:text}} - Text shown ONLY if the roll succeeds (total >= DC)
- {{FAIL:text}} - Text shown ONLY if the roll fails (total < DC)
- ALWAYS include BOTH {{SUCCESS:...}} and {{FAIL:...}} after EVERY {{ROLL:...}} tag
- NEVER write success/failure outcomes OUTSIDE of these tags - the system will strip them
- Describe the ATTEMPT before the roll, then provide conditional outcomes AFTER

## STATE TRACKING TAGS (CRITICAL - ALWAYS USE THESE)
The system automatically tracks game state. You MUST use these tags for ALL state changes:

### HP Tracking (CRITICAL - ALWAYS SPECIFY TARGET)
- Player takes damage: {{DAMAGE:Player:amount}} - e.g., "The goblin's blade slices your arm {{DAMAGE:Player:6}}"
- NPC/Ally takes damage: {{DAMAGE:NPCName:amount}} - e.g., "Zariel is struck {{DAMAGE:Zariel:15}}"
- Player heals: {{HEAL:Player:amount}} - e.g., "The potion restores your vitality {{HEAL:Player:8}}"
- NPC heals: {{HEAL:NPCName:amount}} - e.g., "Zariel recovers {{HEAL:Zariel:10}}"
- IMPORTANT: Always use "Player" for the player character, use NPC's actual name for NPCs
- NEVER use damage/heal tags without specifying the target name

### Inventory & Loot
- Player finds/receives item: {{ADD_ITEM:item_name:quantity}} - e.g., "You find {{ADD_ITEM:Healing Potion:2}}"
- Player uses/loses item: {{USE_ITEM:item_name}} - e.g., "You drink {{USE_ITEM:Healing Potion}}"
- Specify item rarity if special: {{ADD_ITEM:Vorpal Sword:1:legendary}}

### Enemy Tracking (ALWAYS use for combat)
- Introduce enemy: {{ENEMY:name:hp:ac}} - e.g., "A {{ENEMY:Goblin:15:13}} leaps from the shadows!"
- Enemy takes damage: {{ENEMY_DAMAGE:name:amount}} - e.g., "Your sword strikes true {{ENEMY_DAMAGE:Goblin:8}}"
- Enemy defeated: {{ENEMY_DEAD:name}} - e.g., "The goblin falls {{ENEMY_DEAD:Goblin}}"
- Multiple enemies: Use multiple {{ENEMY:}} tags

### Position/Movement
- Location change: {{LOCATION:place_name}} - e.g., "You enter {{LOCATION:The Dark Cavern}}"
- Position in combat: {{POSITION:target:location}} - e.g., "{{POSITION:Orc:30 feet away}}"

### Status Effects
- Apply condition: {{CONDITION:target:effect}} - e.g., "{{CONDITION:Player:poisoned}}"
- Remove condition: {{REMOVE_CONDITION:target:effect}}

### Combat Flow
- Start combat: {{COMBAT:START}}
- End combat: {{COMBAT:END}}
- Set initiative (comma-separated): {{INITIATIVE:Goblin:15,Player:12,Orc:8}}

### Environment
- Time change: {{TIME:dawn/day/dusk/night}}
- Weather: {{WEATHER:condition}}

### Game End
- When the character DIES or the quest ENDS (success or failure): {{GAME_OVER:reason}}
  - Examples: {{GAME_OVER:character_death}}, {{GAME_OVER:quest_complete}}, {{GAME_OVER:quest_failed}}
  - ALWAYS use this tag when the story reaches a definitive end
  - After using {{GAME_OVER}}, do NOT prompt for further actions

## Combat Rules
- Use D&D 5e rules for combat
- When combat starts, ALWAYS include {{COMBAT:START}} and spawn enemies with {{ENEMY:name:hp:ac}}
- Track ALL enemy damage with {{ENEMY_DAMAGE:name:amount}}
- Mark defeated enemies with {{ENEMY_DEAD:name}}
- Describe attacks cinematically but briefly
- ALWAYS use {{DAMAGE:Player:amount}} when the PLAYER takes damage
- ALWAYS use {{DAMAGE:NPCName:amount}} when an NPC/ally takes damage (e.g., {{DAMAGE:Zariel:15}})
- ALWAYS use {{HEAL:Player:amount}} when the PLAYER recovers HP
- ALWAYS use {{HEAL:NPCName:amount}} when an NPC heals
- CRITICAL: Never apply damage to Player when an NPC is hit - use the NPC's name!
- When combat ends, include {{COMBAT:END}}

## Current Party`;

        // Add character information
        if (characters && characters.length > 0) {
            for (const char of characters) {
                const stats = typeof char.stats === 'string' ? JSON.parse(char.stats) : (char.stats || {});
                prompt += `\n\n### ${char.character_name}
- Class: Level ${char.level} ${char.class}${char.subclass ? ` (${char.subclass})` : ''}
- Race: ${char.species || 'Unknown'}
- HP: ${char.health}/${char.max_health}
- AC: ${char.armor_class || 10}
- Key Stats: STR ${stats.strength || 10}, DEX ${stats.dexterity || 10}, CON ${stats.constitution || 10}, INT ${stats.intelligence || 10}, WIS ${stats.wisdom || 10}, CHA ${stats.charisma || 10}
${char.backstory ? `- Background: ${char.backstory.substring(0, 200)}...` : ''}`;
            }
        } else {
            prompt += '\n\nNo characters registered yet - create an engaging solo adventure for a new hero.';
        }

        // Add current scene context if available
        if (session?.current_scene) {
            prompt += `\n\n## Current Scene\n${session.current_scene}`;
        }

        if (session?.current_location) {
            prompt += `\n\n## Current Location\n${session.current_location}`;
        }

        // Add session state context
        if (session?.session_id) {
            const state = this.getSessionState(session.session_id);
            if (state.location !== 'Unknown Location') {
                prompt += `\n\n## Current Location: ${state.location}`;
            }
            if (state.npcsEncountered.length > 0) {
                prompt += `\n\n## NPCs Met: ${state.npcsEncountered.map(n => n.name).join(', ')}`;
            }
            if (state.inCombat) {
                prompt += `\n\n## IN COMBAT - Initiative Order: ${state.initiative.map((i, idx) =>
                    `${idx === state.currentTurn ? '→' : ''}${i.name}(${i.roll})`).join(', ')}`;
            }
        }

        // Add active quests
        if (session?.active_quests) {
            let quests = session.active_quests;
            if (typeof quests === 'string') {
                try { quests = JSON.parse(quests); } catch { quests = []; }
            }
            if (quests.length > 0) {
                prompt += '\n\n## Active Quests';
                quests.forEach(q => {
                    prompt += `\n- ${q.name}: ${q.description || 'No description'}`;
                });
            }
        }

        return prompt;
    }

    /**
     * Build message history for context
     */
    static async buildMessageHistory(sessionId, limit = 30) {
        const [messages] = await pool.execute(
            `SELECT message_type, character_id, content, metadata, created_at
             FROM dnd_session_messages
             WHERE session_id = ?
             ORDER BY created_at DESC
             LIMIT ?`,
            [sessionId, limit]
        );

        messages.reverse();

        let historyText = '';
        for (const msg of messages) {
            if (msg.message_type === 'dm_narration') {
                historyText += `\n\n**Dungeon Master:**\n${msg.content}`;
            } else if (['player_action', 'player_dialogue'].includes(msg.message_type)) {
                historyText += `\n\n**Player:**\n${msg.content}`;
            }
        }

        return historyText;
    }

    /**
     * Perform auto-roll and format result
     */
    static performAutoRoll(character, rollType, dc) {
        const skillMap = {
            'perception': 'perception', 'investigation': 'investigation', 'stealth': 'stealth',
            'insight': 'insight', 'persuasion': 'persuasion', 'deception': 'deception',
            'intimidation': 'intimidation', 'athletics': 'athletics', 'acrobatics': 'acrobatics',
            'arcana': 'arcana', 'history': 'history', 'nature': 'nature', 'religion': 'religion',
            'medicine': 'medicine', 'survival': 'survival', 'animal_handling': 'animal_handling',
            'sleight_of_hand': 'sleight_of_hand', 'performance': 'performance'
        };

        const saveMap = {
            'str_save': 'strength', 'strength_save': 'strength',
            'dex_save': 'dexterity', 'dexterity_save': 'dexterity',
            'con_save': 'constitution', 'constitution_save': 'constitution',
            'int_save': 'intelligence', 'intelligence_save': 'intelligence',
            'wis_save': 'wisdom', 'wisdom_save': 'wisdom',
            'cha_save': 'charisma', 'charisma_save': 'charisma'
        };

        const normalizedType = rollType.toLowerCase().replace(/ /g, '_');

        try {
            // Check for skill
            if (skillMap[normalizedType]) {
                const result = RPGDiceEngine.skillCheck(character, skillMap[normalizedType], 'normal', dc);
                const success = dc > 0 ? result.total >= dc : null;
                return {
                    type: 'skill',
                    name: result.skillName,
                    roll: result.d20.roll,
                    modifier: result.totalModifier,
                    total: result.total,
                    dc,
                    success,
                    critical: result.d20.isCritical,
                    fumble: result.d20.isFumble,
                    formatted: `🎲 **${result.skillName}**: [${result.d20.roll}] ${RPGDiceEngine.formatModifier(result.totalModifier)} = **${result.total}**${dc > 0 ? ` vs DC ${dc}` : ''}${result.d20.isCritical ? ' 🌟 NAT 20!' : result.d20.isFumble ? ' 💀 NAT 1!' : ''}${dc > 0 ? (success ? ' ✅' : ' ❌') : ''}`
                };
            }

            // Check for save
            if (saveMap[normalizedType]) {
                const result = RPGDiceEngine.savingThrow(character, saveMap[normalizedType], dc || 10, 'normal');
                return {
                    type: 'save',
                    name: `${result.abilityName} Save`,
                    roll: result.d20.roll,
                    modifier: result.totalModifier,
                    total: result.total,
                    dc,
                    success: result.success,
                    critical: result.d20.isCritical,
                    fumble: result.d20.isFumble,
                    formatted: `🎲 **${result.abilityName} Save**: [${result.d20.roll}] ${RPGDiceEngine.formatModifier(result.totalModifier)} = **${result.total}** vs DC ${dc}${result.d20.isCritical ? ' 🌟 NAT 20!' : result.d20.isFumble ? ' 💀 NAT 1!' : ''} ${result.success ? '✅' : '❌'}`
                };
            }

            // Attack roll
            if (normalizedType === 'attack') {
                const result = RPGDiceEngine.rollAttack(character, 'melee', null, 'normal', dc);
                return {
                    type: 'attack',
                    name: 'Attack',
                    roll: result.d20.roll,
                    modifier: result.totalModifier,
                    total: result.total,
                    dc,
                    success: result.hit,
                    critical: result.isCritical,
                    fumble: result.isFumble,
                    formatted: `🎲 **Attack Roll**: [${result.d20.roll}] ${RPGDiceEngine.formatModifier(result.totalModifier)} = **${result.total}** vs AC ${dc}${result.isCritical ? ' 🌟 CRITICAL HIT!' : result.isFumble ? ' 💀 FUMBLE!' : ''} ${result.hit ? '✅ HIT!' : '❌ MISS!'}`
                };
            }

            // Initiative
            if (normalizedType === 'initiative') {
                const result = RPGDiceEngine.rollInitiative(character);
                return {
                    type: 'initiative',
                    name: 'Initiative',
                    roll: result.d20.roll,
                    modifier: result.totalModifier,
                    total: result.total,
                    dc: 0,
                    success: null,
                    critical: result.d20.isCritical,
                    fumble: result.d20.isFumble,
                    formatted: `🎲 **Initiative**: [${result.d20.roll}] ${RPGDiceEngine.formatModifier(result.totalModifier)} = **${result.total}**`
                };
            }

            // Generic d20 roll
            return {
                type: 'check',
                name: rollType,
                roll: Math.floor(Math.random() * 20) + 1,
                modifier: 0,
                total: Math.floor(Math.random() * 20) + 1,
                dc,
                success: dc > 0 ? (Math.floor(Math.random() * 20) + 1) >= dc : null,
                formatted: `🎲 **${rollType}**: Roll made`
            };
        } catch (error) {
            logger.error('[AI DM] Auto-roll error:', { error: error.message, rollType });
            return null;
        }
    }

    /**
     * Process narration for auto-rolls and metadata
     * Comprehensive state tracking for all game elements
     */
    static async processNarrationTags(narration, character, sessionId) {
        const state = this.getSessionState(sessionId);
        const rolls = [];
        const loot = [];
        const itemsUsed = [];
        const enemiesSpawned = [];
        const enemyDamage = [];
        const enemiesKilled = [];
        let goldGained = 0;
        let goldSpent = 0;
        let xpGained = 0;
        let damageDealt = 0;
        let healingDone = 0;
        let processedNarration = narration;

        // Process ROLL tags with conditional SUCCESS/FAIL outcomes
        // Pattern matches: {{ROLL:type:DC#}} or {{ROLL:type:AC#}} optionally followed by {{SUCCESS:text}} and/or {{FAIL:text}}
        // Now handles both DC (difficulty class) and AC (armor class) formats
        const rollWithConditionalsPattern = /\{\{ROLL:\s*(\w+)\s*:\s*(?:DC|AC)?\s*(\d+)\}\}\s*(?:\{\{SUCCESS:([^}]*)\}\})?\s*(?:\{\{FAIL:([^}]*)\}\})?/gi;
        let lastRollSuccess = null; // Track last roll result for any standalone SUCCESS/FAIL tags

        processedNarration = processedNarration.replace(rollWithConditionalsPattern, (match, rollType, dc, successText, failText) => {
            const rollResult = this.performAutoRoll(character, rollType, parseInt(dc));
            if (rollResult) {
                rolls.push(rollResult);
                state.recentRolls.unshift(rollResult);
                if (state.recentRolls.length > 10) state.recentRolls.pop();
                lastRollSuccess = rollResult.success;

                // Build the output: roll result + appropriate conditional text
                let output = rollResult.formatted;
                if (rollResult.success && successText) {
                    output += ` ${successText.trim()}`;
                } else if (!rollResult.success && failText) {
                    output += ` ${failText.trim()}`;
                }
                return output;
            }
            return match;
        });

        // Handle any standalone SUCCESS/FAIL tags that weren't caught (use last roll result)
        processedNarration = processedNarration.replace(/\{\{SUCCESS:([^}]*)\}\}/gi, (match, text) => {
            return lastRollSuccess === true ? text.trim() : '';
        });
        processedNarration = processedNarration.replace(/\{\{FAIL:([^}]*)\}\}/gi, (match, text) => {
            return lastRollSuccess === false ? text.trim() : '';
        });

        // Process LOCATION tags: {{LOCATION:name}} (tolerant of missing closing braces)
        const locationPattern = /\{\{LOCATION:\s*([^}\s]+[^}]*?)\}?\}?(?=\s|$|[.,!?])/gi;
        processedNarration = processedNarration.replace(locationPattern, (match, location) => {
            state.location = location.trim();
            return `📍 **${location.trim()}**`;
        });

        // Process NPC tags: {{NPC:name:description}} (tolerant of missing closing braces)
        const npcPattern = /\{\{NPC:\s*([^:}]+)\s*:\s*([^}]+?)\}?\}?(?=\s|$|[.,!?])/gi;
        processedNarration = processedNarration.replace(npcPattern, (match, name, desc) => {
            const npc = { name: name.trim(), description: desc.trim(), metAt: new Date() };
            if (!state.npcsEncountered.find(n => n.name === npc.name)) {
                state.npcsEncountered.push(npc);
            }
            if (!state.npcsPresent.includes(name.trim())) {
                state.npcsPresent.push(name.trim());
            }
            return `**${name.trim()}** *(${desc.trim()})*`;
        });

        // Process ENEMY tags: {{ENEMY:name:hp:ac}} (tolerant of missing closing braces)
        const enemyPattern = /\{\{ENEMY:\s*([^:}]+)\s*:\s*(\d+)\s*:\s*(\d+)\}?\}?/gi;
        processedNarration = processedNarration.replace(enemyPattern, (match, name, hp, ac) => {
            const enemy = RPGStateManager.addEnemy(sessionId, {
                name: name.trim(),
                hp: parseInt(hp),
                ac: parseInt(ac)
            });
            enemiesSpawned.push(enemy);
            state.inCombat = true;
            return `**${name.trim()}** *(HP: ${hp}, AC: ${ac})*`;
        });

        // Process ENEMY_DAMAGE tags: {{ENEMY_DAMAGE:name:amount}} (tolerant of missing closing braces)
        const enemyDamagePattern = /\{\{ENEMY_DAMAGE:\s*([^:}]+)\s*:\s*(\d+)\}?\}?/gi;
        processedNarration = processedNarration.replace(enemyDamagePattern, (match, name, amount) => {
            const dmg = parseInt(amount);
            const enemy = RPGStateManager.updateEnemyHP(sessionId, name.trim(), -dmg);
            enemyDamage.push({ name: name.trim(), damage: dmg, newHP: enemy?.hp || 0 });
            if (enemy && enemy.hp <= 0) {
                return `💀 **${name.trim()}** takes **${dmg}** damage and falls!`;
            }
            return `⚔️ **${name.trim()}** takes **${dmg}** damage (${enemy?.hp || '?'}/${enemy?.maxHp || '?'} HP)`;
        });

        // Fallback: ENEMY_DAMAGE without braces - AI sometimes writes 💥 ENEMY_DAMAGE:Goblin:8 💥
        const enemyDamageNoBracesPattern = /[💥⚔️💀]?\s*ENEMY_DAMAGE:\s*([^:]+)\s*:\s*(\d+)\s*[💥⚔️💀]?/gi;
        processedNarration = processedNarration.replace(enemyDamageNoBracesPattern, (match, name, amount) => {
            const dmg = parseInt(amount);
            const enemy = RPGStateManager.updateEnemyHP(sessionId, name.trim(), -dmg);
            enemyDamage.push({ name: name.trim(), damage: dmg, newHP: enemy?.hp || 0 });
            logger.info('[AI DM] Caught ENEMY_DAMAGE tag without braces', { enemy: name.trim(), amount: dmg });
            if (enemy && enemy.hp <= 0) {
                return `💀 **${name.trim()}** takes **${dmg}** damage and falls!`;
            }
            return `⚔️ **${name.trim()}** takes **${dmg}** damage (${enemy?.hp || '?'}/${enemy?.maxHp || '?'} HP)`;
        });

        // Process ENEMY_DEAD tags: {{ENEMY_DEAD:name}} (tolerant of missing closing braces)
        const enemyDeadPattern = /\{\{ENEMY_DEAD:\s*([^}\s]+)\}?\}?/gi;
        processedNarration = processedNarration.replace(enemyDeadPattern, (match, name) => {
            RPGStateManager.updateEnemyHP(sessionId, name.trim(), -9999); // Ensure dead
            enemiesKilled.push(name.trim());
            return `💀 **${name.trim()}** is defeated!`;
        });

        // Process ADD_ITEM tags: {{ADD_ITEM:name:quantity:rarity?}} (tolerant of missing closing braces)
        const addItemPattern = /\{\{ADD_ITEM:\s*([^:}]+)\s*:\s*(\d+)(?:\s*:\s*(\w+))?\}?\}?/gi;
        processedNarration = processedNarration.replace(addItemPattern, (match, itemName, qty, rarity) => {
            const quantity = parseInt(qty) || 1;
            const item = { item: itemName.trim(), quantity, rarity: rarity?.trim() || 'common' };
            loot.push(item);
            state.loot.push(item);
            return `🎁 **${itemName.trim()}**${quantity > 1 ? ` x${quantity}` : ''}${rarity ? ` (${rarity})` : ''}`;
        });

        // Process USE_ITEM tags: {{USE_ITEM:name}} (tolerant of missing closing braces)
        const useItemPattern = /\{\{USE_ITEM:\s*([^}\s]+)\}?\}?/gi;
        processedNarration = processedNarration.replace(useItemPattern, (match, itemName) => {
            itemsUsed.push(itemName.trim());
            return `📦 *Used ${itemName.trim()}*`;
        });

        // Process LOOT tags (legacy support): {{LOOT:item:quantity}} (tolerant of missing closing braces)
        const lootPattern = /\{\{LOOT:\s*([^:}]+)\s*:?\s*(\d+)?\}?\}?/gi;
        processedNarration = processedNarration.replace(lootPattern, (match, item, qty) => {
            const quantity = parseInt(qty) || 1;
            loot.push({ item: item.trim(), quantity, rarity: 'common' });
            state.loot.push({ item: item.trim(), quantity });
            return `🎁 **${item.trim()}**${quantity > 1 ? ` x${quantity}` : ''}`;
        });

        // Process GOLD tags: {{GOLD:amount}} (tolerant of missing closing braces)
        const goldPattern = /\{\{GOLD:\s*(\d+)\}?\}?/gi;
        processedNarration = processedNarration.replace(goldPattern, (match, amount) => {
            goldGained += parseInt(amount);
            state.goldGained += parseInt(amount);
            return `💰 **+${amount} gold**`;
        });

        // Process SPEND_GOLD tags: {{SPEND_GOLD:amount}} (tolerant of missing closing braces)
        const spendGoldPattern = /\{\{SPEND_GOLD:\s*(\d+)\}?\}?/gi;
        processedNarration = processedNarration.replace(spendGoldPattern, (match, amount) => {
            goldSpent += parseInt(amount);
            state.goldSpent = (state.goldSpent || 0) + parseInt(amount);
            return `💸 **-${amount} gold**`;
        });

        // Clean up malformed tags where AI wrote placeholder words instead of values
        // e.g., {{GOLD:amount}} {{SPEND_GOLD:amount}} {{XP:amount}} {{DAMAGE:target:amount}}
        processedNarration = processedNarration.replace(/\{\{(?:GOLD|SPEND_GOLD|XP|DAMAGE|HEAL):(?:amount|target|item_name|name|quantity)[^}]*\}?\}?/gi, '');

        // Process XP tags: {{XP:amount}} (tolerant of missing closing braces)
        const xpPattern = /\{\{XP:\s*(\d+)\}?\}?/gi;
        processedNarration = processedNarration.replace(xpPattern, (match, amount) => {
            xpGained += parseInt(amount);
            state.xpGained += parseInt(amount);
            return `✨ **${amount} XP**`;
        });

        // Process DAMAGE tags: {{DAMAGE:Target:amount}} - only count player damage (tolerant of missing closing braces)
        // New format: {{DAMAGE:Player:6}} or {{DAMAGE:Zariel:15}}
        const damageWithTargetPattern = /\{\{DAMAGE:\s*([^:}]+)\s*:\s*(\d+)\}?\}?/gi;
        processedNarration = processedNarration.replace(damageWithTargetPattern, (match, target, amount) => {
            const dmg = parseInt(amount);
            const targetName = target.trim().toLowerCase();
            const playerName = character?.character_name?.toLowerCase() || '';

            // Only apply damage to player stats if target is "Player" or matches player name
            if (targetName === 'player' || targetName === playerName) {
                damageDealt += dmg;
                return `💔 **${character?.character_name || 'Player'} takes ${dmg} damage!**`;
            } else {
                // NPC/ally took damage - don't affect player HP
                return `💔 **${target.trim()} takes ${dmg} damage!**`;
            }
        });

        // Fallback: old format {{DAMAGE:amount}} - treat as player damage (tolerant of missing closing braces)
        const damageOldPattern = /\{\{DAMAGE:\s*(\d+)\}?\}?/gi;
        processedNarration = processedNarration.replace(damageOldPattern, (match, amount) => {
            const dmg = parseInt(amount);
            damageDealt += dmg;
            return `💔 **-${dmg} HP**`;
        });

        // Fallback: DAMAGE without braces - AI sometimes writes DAMAGE:Player:11 or 💔 DAMAGE:Player:13 💔 💔
        // More flexible pattern to catch various emoji combinations
        const damageNoBracesPattern = /[💔💥⚔️\s]*DAMAGE:\s*([^:\s]+)\s*:\s*(\d+)[💔💥⚔️\s]*/gi;
        processedNarration = processedNarration.replace(damageNoBracesPattern, (match, target, amount) => {
            const dmg = parseInt(amount);
            const targetName = target.trim().toLowerCase();
            const playerName = character?.character_name?.toLowerCase() || '';

            if (targetName === 'player' || targetName === playerName) {
                damageDealt += dmg;
                logger.info('[AI DM] Caught DAMAGE tag without braces', { target, amount: dmg });
                return `💔 **${character?.character_name || 'Player'} takes ${dmg} damage!**`;
            } else {
                return `💔 **${target.trim()} takes ${dmg} damage!**`;
            }
        });

        // Process HEAL tags: {{HEAL:Target:amount}} - only count player healing (tolerant of missing closing braces)
        const healWithTargetPattern = /\{\{HEAL:\s*([^:}]+)\s*:\s*(\d+)\}?\}?/gi;
        processedNarration = processedNarration.replace(healWithTargetPattern, (match, target, amount) => {
            const heal = parseInt(amount);
            const targetName = target.trim().toLowerCase();
            const playerName = character?.character_name?.toLowerCase() || '';

            // Only apply healing to player stats if target is "Player" or matches player name
            if (targetName === 'player' || targetName === playerName) {
                healingDone += heal;
                return `💚 **${character?.character_name || 'Player'} heals ${heal} HP!**`;
            } else {
                // NPC/ally healed - don't affect player HP
                return `💚 **${target.trim()} heals ${heal} HP!**`;
            }
        });

        // Fallback: old format {{HEAL:amount}} - treat as player healing (tolerant of missing closing braces)
        const healOldPattern = /\{\{HEAL:\s*(\d+)\}?\}?/gi;
        processedNarration = processedNarration.replace(healOldPattern, (match, amount) => {
            const heal = parseInt(amount);
            healingDone += heal;
            return `💚 **+${heal} HP**`;
        });

        // Fallback: HEAL without braces - AI sometimes writes HEAL:Player:9 💚 or 💚 HEAL:Player:9
        const healNoBracesPattern = /[💚💖✨🌟\s]*HEAL:\s*([^:\s]+)\s*:\s*(\d+)[💚💖✨🌟\s]*/gi;
        processedNarration = processedNarration.replace(healNoBracesPattern, (match, target, amount) => {
            const heal = parseInt(amount);
            const targetName = target.trim().toLowerCase();
            const playerName = character?.character_name?.toLowerCase() || '';

            if (targetName === 'player' || targetName === playerName) {
                healingDone += heal;
                logger.info('[AI DM] Caught HEAL tag without braces', { target, amount: heal });
                return `💚 **${character?.character_name || 'Player'} heals ${heal} HP!**`;
            } else {
                return `💚 **${target.trim()} heals ${heal} HP!**`;
            }
        });

        // NATURAL LANGUAGE FALLBACK - catch damage when AI doesn't use tags
        // Only apply if no damage was captured from tags
        if (damageDealt === 0 && character) {
            const playerName = character.character_name?.toLowerCase() || 'you';
            const narrationLower = processedNarration.toLowerCase();

            // Patterns that indicate PLAYER taking damage (not NPCs)
            const playerDamagePatterns = [
                /you\s+(?:take|receive|suffer)\s+(\d+)\s+(?:points?\s+of\s+)?damage/gi,
                /(?:deals?|does|inflicts?)\s+(\d+)\s+(?:points?\s+of\s+)?damage\s+to\s+you/gi,
                /you\s+(?:lose|lost)\s+(\d+)\s+(?:hit\s+points?|hp)/gi,
                /-(\d+)\s*hp(?:\s|$|!|\.|,)/gi,
                /you\s+are\s+(?:hit|struck|wounded).*?(\d+)\s+(?:points?\s+of\s+)?damage/gi,
                // More flexible patterns for "and take X damage", "take X damage", etc.
                /(?:and\s+)?take\s+(\d+)\s+(?:points?\s+of\s+)?damage/gi,
                /(?:taking|takes)\s+(\d+)\s+(?:points?\s+of\s+)?damage/gi,
                /(?:suffer|suffering)\s+(\d+)\s+(?:points?\s+of\s+)?damage/gi,
                /overwhelmed.*?(\d+)\s+damage/gi,
                /(\d+)\s+(?:points?\s+of\s+)?damage\s+(?:to\s+you|from)/gi,
            ];

            for (const pattern of playerDamagePatterns) {
                let match;
                while ((match = pattern.exec(processedNarration)) !== null) {
                    const dmg = parseInt(match[1]);
                    if (dmg > 0 && dmg < 500) { // Sanity check
                        damageDealt += dmg;
                        logger.info('[AI DM] Extracted player damage from natural language', { damage: dmg, pattern: pattern.source });
                    }
                }
            }
        }

        // NATURAL LANGUAGE FALLBACK - catch healing when AI doesn't use tags
        let fullHeal = false;

        if (healingDone === 0 && character) {
            // First check for "full heal" phrases - these heal to max
            const fullHealPatterns = [
                /(?:fully|completely)\s+(?:heal(?:ed|s)?|recover(?:ed|s)?|restore(?:d|s)?)/gi,
                /(?:heal(?:ed|s)?|recover(?:ed|s)?|restore(?:d|s)?)\s+(?:fully|completely)/gi,
                /restore(?:d|s)?\s+to\s+full\s+(?:health|hp|hit\s+points?)/gi,
                /(?:back|returned?)\s+to\s+full\s+(?:health|hp|hit\s+points?)/gi,
                /(?:regain|recover|restore)(?:ed|s)?\s+all\s+(?:of\s+)?(?:your\s+)?(?:health|hp|hit\s+points?)/gi,
                /all\s+(?:of\s+)?(?:your\s+)?(?:wounds?|injuries?)\s+(?:are\s+)?(?:healed|mended|closed)/gi,
                /(?:wounds?|injuries?)\s+(?:completely|fully)\s+(?:heal(?:ed)?|close(?:d)?|mend(?:ed)?)/gi,
                /you\s+(?:are\s+)?(?:now\s+)?(?:fully|completely)\s+(?:healed|restored|recovered)/gi,
                /(?:full|complete|total)\s+(?:healing|restoration|recovery)/gi,
            ];

            for (const pattern of fullHealPatterns) {
                if (pattern.test(processedNarration)) {
                    fullHeal = true;
                    // Calculate healing needed to reach max
                    const missingHP = (character.max_health || 14) - (character.health || 0);
                    if (missingHP > 0) {
                        healingDone = missingHP;
                        logger.info('[AI DM] Detected FULL HEAL from natural language', {
                            pattern: pattern.source,
                            healingToMax: healingDone,
                            currentHP: character.health,
                            maxHP: character.max_health
                        });
                    }
                    break;
                }
            }

            // If not a full heal, check for numeric healing patterns
            if (!fullHeal) {
                const healPatterns = [
                    /you\s+(?:heal|recover|regain|restore)\s+(\d+)\s+(?:hit\s+points?|hp|points?)?/gi,
                    /(?:heals?|restores?)\s+(\d+)\s+(?:hit\s+points?|hp|points?)?\s*(?:to\s+you)?/gi,
                    /\+(\d+)\s*hp(?:\s|$|!|\.|,)/gi,
                    // More flexible patterns for "heal X points", "healed for X", etc.
                    /heal\s+(\d+)\s+(?:hit\s+)?points?/gi,
                    /healed?\s+(?:for\s+)?(\d+)/gi,
                    /(?:recover|regain|restore)s?\s+(\d+)\s+(?:health|hp|hit\s+points?|points?)/gi,
                    /(\d+)\s+(?:health|hp|hit\s+points?)\s+(?:healed|restored|recovered)/gi,
                    /(?:healing|heals)\s+(?:you\s+)?(?:for\s+)?(\d+)/gi,
                ];

                for (const pattern of healPatterns) {
                    let match;
                    while ((match = pattern.exec(processedNarration)) !== null) {
                        const heal = parseInt(match[1]);
                        if (heal > 0 && heal < 500) { // Sanity check
                            healingDone += heal;
                            logger.info('[AI DM] Extracted player healing from natural language', { healing: heal, pattern: pattern.source });
                        }
                    }
                }
            }
        }

        // Process POSITION tags: {{POSITION:target:location}}
        const positionPattern = /\{\{POSITION:\s*([^:}]+)\s*:\s*([^}]+)\}\}/gi;
        processedNarration = processedNarration.replace(positionPattern, (match, target, location) => {
            state.positions.set(target.trim(), location.trim());
            return `📍 *${target.trim()} is now ${location.trim()}*`;
        });

        // Process CONDITION tags: {{CONDITION:target:effect}}
        const conditionPattern = /\{\{CONDITION:\s*([^:}]+)\s*:\s*([^}]+)\}\}/gi;
        processedNarration = processedNarration.replace(conditionPattern, (match, target, effect) => {
            RPGStateManager.addCondition(sessionId, target.trim(), effect.trim());
            return `⚠️ *${target.trim()} is now ${effect.trim()}*`;
        });

        // Process REMOVE_CONDITION tags: {{REMOVE_CONDITION:target:effect}}
        const removeConditionPattern = /\{\{REMOVE_CONDITION:\s*([^:}]+)\s*:\s*([^}]+)\}\}/gi;
        processedNarration = processedNarration.replace(removeConditionPattern, (match, target, effect) => {
            RPGStateManager.removeCondition(sessionId, target.trim(), effect.trim());
            return `✨ *${target.trim()} is no longer ${effect.trim()}*`;
        });

        // Process INITIATIVE tags: {{INITIATIVE:name:roll,name:roll,...}}
        const initiativePattern = /\{\{INITIATIVE:\s*([^}]+)\}\}/gi;
        processedNarration = processedNarration.replace(initiativePattern, (match, initString) => {
            const initiative = initString.split(',').map(entry => {
                const [name, roll] = entry.split(':').map(s => s.trim());
                return { name, roll: parseInt(roll) || 0, isPlayer: name.toLowerCase() === character?.character_name?.toLowerCase() };
            });
            RPGStateManager.setInitiative(sessionId, initiative);
            return `🎲 **Initiative:** ${initiative.sort((a, b) => b.roll - a.roll).map(i => `${i.name}(${i.roll})`).join(' > ')}`;
        });

        // Process TIME tags: {{TIME:period}}
        const timePattern = /\{\{TIME:\s*([^}]+)\}\}/gi;
        processedNarration = processedNarration.replace(timePattern, (match, time) => {
            state.timeOfDay = time.trim().toLowerCase();
            const icons = { dawn: '🌅', day: '☀️', dusk: '🌆', night: '🌙' };
            return `${icons[state.timeOfDay] || '🕐'} *It is now ${time.trim()}*`;
        });

        // Process WEATHER tags: {{WEATHER:condition}}
        const weatherPattern = /\{\{WEATHER:\s*([^}]+)\}\}/gi;
        processedNarration = processedNarration.replace(weatherPattern, (match, weather) => {
            state.weather = weather.trim().toLowerCase();
            const icons = { clear: '☀️', cloudy: '☁️', rain: '🌧️', storm: '⛈️', snow: '❄️', fog: '🌫️' };
            return `${icons[state.weather] || '🌤️'} *Weather: ${weather.trim()}*`;
        });

        // Process COMBAT tags
        if (/\{\{COMBAT:\s*START\s*\}\}/i.test(processedNarration)) {
            state.inCombat = true;
            state.combatRound = 1;
            processedNarration = processedNarration.replace(/\{\{COMBAT:\s*START\s*\}\}/gi, '⚔️ **COMBAT INITIATED!**');
        }
        if (/\{\{COMBAT:\s*END\s*\}\}/i.test(processedNarration)) {
            state.inCombat = false;
            state.initiative = [];
            state.currentTurn = 0;
            RPGStateManager.clearDeadEnemies(sessionId);
            processedNarration = processedNarration.replace(/\{\{COMBAT:\s*END\s*\}\}/gi, '🏆 **COMBAT ENDED!**');
        }

        // Process GAME_OVER tags: {{GAME_OVER:reason}}
        let gameOver = false;
        let gameOverReason = null;
        const gameOverPattern = /\{\{GAME_OVER:\s*([^}]+)\s*\}\}/gi;
        if (gameOverPattern.test(processedNarration)) {
            gameOver = true;
            const match = processedNarration.match(/\{\{GAME_OVER:\s*([^}]+)\s*\}\}/i);
            gameOverReason = match ? match[1].trim() : 'unknown';
            processedNarration = processedNarration.replace(/\{\{GAME_OVER:\s*([^}]+)\s*\}\}/gi, '🎭 **THE END**');
            logger.info('[AI DM] Game Over detected', { sessionId, reason: gameOverReason });
        }

        // Natural language detection for game over scenarios (fallback)
        if (!gameOver) {
            const gameOverPhrases = [
                /game\s+(?:is\s+)?over/i,
                /your\s+(?:tale|story|journey|adventure)\s+(?:has\s+)?(?:ended?|come\s+to\s+an?\s+end)/i,
                /(?:character|hero|you)\s+(?:has\s+)?(?:died|perished|fallen)/i,
                /thank\s+you\s+for\s+playing/i,
                /farewell.*until\s+(?:next\s+time|then)/i,
                /the\s+end\s*[.!]?$/i,
                /quest\s+(?:has\s+)?(?:ended|complete|failed)/i,
            ];
            for (const pattern of gameOverPhrases) {
                if (pattern.test(processedNarration)) {
                    gameOver = true;
                    gameOverReason = 'natural_language_detection';
                    logger.info('[AI DM] Game Over detected from natural language', { sessionId });
                    break;
                }
            }
        }

        // CRITICAL: Strip AI-hallucinated HP declarations from narrative
        // The AI often writes incorrect HP values like "Your HP is now 10/14!" that don't match reality
        // The footer shows the ACTUAL HP from the database, so we strip these false declarations
        const hpHallucinationPatterns = [
            // "Your HP is now X/Y" or "Your HP: X/Y"
            /your\s+(?:current\s+)?hp\s*(?:is\s+now|:)\s*\d+\s*\/\s*\d+[.!]?\s*/gi,
            // "HP: X/Y" or "HP is X/Y" standalone
            /(?:^|\s)hp\s*(?:is\s+(?:now\s+)?|:\s*)\d+\s*\/\s*\d+[.!]?\s*/gim,
            // "(HP: X/Y)" in parentheses
            /\(\s*hp\s*:\s*\d+\s*\/\s*\d+\s*\)/gi,
            // "You now have X/Y HP"
            /you\s+(?:now\s+)?have\s+\d+\s*\/\s*\d+\s*(?:hit\s+points?|hp)[.!]?\s*/gi,
            // "leaving you at X/Y HP" or "leaving you with X/Y HP"
            /leaving\s+you\s+(?:at|with)\s+\d+\s*\/\s*\d+\s*(?:hit\s+points?|hp)?[.!]?\s*/gi,
            // "bringing your HP to X/Y"
            /bringing\s+(?:your\s+)?(?:hp|hit\s+points?)\s+to\s+\d+\s*\/\s*\d+[.!]?\s*/gi,
            // "your health is now X/Y"
            /your\s+health\s+is\s+(?:now\s+)?\d+\s*\/\s*\d+[.!]?\s*/gi,
            // "Current HP: X/Y"
            /current\s+hp\s*:\s*\d+\s*\/\s*\d+[.!]?\s*/gi,
        ];

        for (const pattern of hpHallucinationPatterns) {
            const hadMatch = pattern.test(processedNarration);
            if (hadMatch) {
                processedNarration = processedNarration.replace(pattern, ' ');
                logger.info('[AI DM] Stripped hallucinated HP declaration from narrative', { pattern: pattern.source });
            }
        }

        // CRITICAL: Strip AI-hallucinated LEVEL declarations from narrative
        // The AI sometimes writes wrong level values - the footer shows the actual level
        const levelHallucinationPatterns = [
            // "You are now level X" / "You're now level X"
            /you(?:'re| are)\s+(?:now\s+)?level\s+\d+[.!]?\s*/gi,
            // "Level: X" or "Level X" standalone declarations
            /(?:^|\s)level\s*:\s*\d+[.!]?\s*/gim,
            // "(Level X)" in parentheses
            /\(\s*level\s+\d+\s*\)/gi,
            // "your level is now X"
            /your\s+level\s+is\s+(?:now\s+)?\d+[.!]?\s*/gi,
            // "you've reached level X" / "you have reached level X"
            /you(?:'ve| have)\s+reached\s+level\s+\d+[.!]?\s*/gi,
        ];

        for (const pattern of levelHallucinationPatterns) {
            const hadMatch = pattern.test(processedNarration);
            if (hadMatch) {
                processedNarration = processedNarration.replace(pattern, ' ');
                logger.info('[AI DM] Stripped hallucinated level declaration from narrative', { pattern: pattern.source });
            }
        }

        // CRITICAL: Strip success/failure phrases that contradict actual roll results
        // The AI sometimes writes "You succeed" when the roll failed, or vice versa
        if (rolls.length > 0) {
            // Check the most recent roll(s) for contradictions
            for (const roll of rolls) {
                if (roll.success === false) {
                    // Roll FAILED - strip success phrases that appear near the roll marker
                    const falseSuccessPatterns = [
                        /you\s+succeed(?:ed)?(?:\s+in)?/gi,
                        /(?:successful(?:ly)?|with\s+success)/gi,
                        /you\s+manage\s+to/gi,
                        /your\s+attempt\s+succeeds/gi,
                        /you\s+pass(?:ed)?(?:\s+the)?(?:\s+check)?/gi,
                        /the\s+check\s+(?:is\s+)?(?:a\s+)?success/gi,
                    ];
                    for (const pattern of falseSuccessPatterns) {
                        if (pattern.test(processedNarration)) {
                            // Only strip if it appears AFTER a roll result with ❌
                            const narrationAfterFail = processedNarration.split('❌').pop() || '';
                            if (pattern.test(narrationAfterFail)) {
                                processedNarration = processedNarration.replace(pattern, '');
                                logger.info('[AI DM] Stripped false SUCCESS phrase after failed roll', {
                                    roll: roll.name,
                                    total: roll.total,
                                    dc: roll.dc,
                                    pattern: pattern.source
                                });
                            }
                        }
                    }
                } else if (roll.success === true) {
                    // Roll SUCCEEDED - strip failure phrases that appear near the roll marker
                    const falseFailPatterns = [
                        /you\s+fail(?:ed)?(?:\s+to)?/gi,
                        /(?:unsuccessful(?:ly)?|without\s+success)/gi,
                        /you\s+are\s+unable\s+to/gi,
                        /your\s+attempt\s+fails/gi,
                        /you\s+don'?t\s+(?:manage|succeed)/gi,
                        /the\s+check\s+(?:is\s+)?(?:a\s+)?failure/gi,
                        /unfortunately,?\s+you/gi,
                    ];
                    for (const pattern of falseFailPatterns) {
                        if (pattern.test(processedNarration)) {
                            // Only strip if it appears AFTER a roll result with ✅
                            const narrationAfterSuccess = processedNarration.split('✅').pop() || '';
                            if (pattern.test(narrationAfterSuccess)) {
                                processedNarration = processedNarration.replace(pattern, '');
                                logger.info('[AI DM] Stripped false FAILURE phrase after successful roll', {
                                    roll: roll.name,
                                    total: roll.total,
                                    dc: roll.dc,
                                    pattern: pattern.source
                                });
                            }
                        }
                    }
                }
            }
        }

        // Clean up any double spaces left behind
        processedNarration = processedNarration.replace(/\s{2,}/g, ' ').trim();

        // Clean up orphan closing braces }} that weren't part of a tag
        processedNarration = processedNarration.replace(/\s*\}\}\s*/g, ' ').trim();

        // Clean up raw "Player:" or "Player: CharacterName:" prefixes the AI sometimes outputs
        processedNarration = processedNarration.replace(/\bPlayer:\s*(?:[A-Za-z0-9_]+:?\s*)?/gi, '').trim();

        // Clean up any leftover raw {{LOCATION:???}} style tags with special chars
        processedNarration = processedNarration.replace(/\{\{LOCATION:[^}]*\}\}/gi, (match) => {
            const loc = match.replace(/\{\{LOCATION:\s*/i, '').replace(/\}\}$/, '').trim();
            if (loc && loc !== '???' && !loc.match(/^\?+$/)) {
                state.location = loc;
                return `📍 **${loc}**`;
            }
            return ''; // Remove invalid location tags
        });

        return {
            narration: processedNarration,
            rolls,
            loot,
            itemsUsed,
            enemiesSpawned,
            enemyDamage,
            enemiesKilled,
            goldGained,
            goldSpent,
            xpGained,
            damageDealt,
            healingDone,
            fullHeal,
            location: state.location,
            inCombat: state.inCombat,
            combatStatus: RPGStateManager.buildCombatStatus(sessionId, character),
            gameOver,
            gameOverReason
        };
    }

    /**
     * Generate DM response using Gemini with auto-rolling
     */
    static async generateResponse(campaign, session, characters, playerInput, inputType = 'action') {
        try {
            const systemPrompt = this.buildSystemPrompt(campaign, session, characters);
            const historyText = session?.session_id
                ? await this.buildMessageHistory(session.session_id)
                : '';

            let formattedInput = playerInput;
            if (inputType === 'action') {
                formattedInput = `[Player Action] ${playerInput}`;
            } else if (inputType === 'dialogue') {
                formattedInput = `[Player speaks] "${playerInput}"`;
            } else if (inputType === 'examine') {
                formattedInput = `[Player examines] ${playerInput}`;
            } else if (inputType === 'combat') {
                formattedInput = `[Combat Action] ${playerInput}`;
            } else if (inputType === 'roll') {
                formattedInput = `[Player Roll Result] ${playerInput}`;
            }

            const fullPrompt = `${systemPrompt}

## Previous Events
${historyText || 'This is the beginning of the adventure.'}

## Current Player Input
${formattedInput}

---
Now respond as the Dungeon Master. Be engaging and descriptive.
Remember to use {{ROLL:skill:DC#}} format when checks are needed - the system will auto-roll.
Use {{LOCATION:name}} when moving to a new area.
Use {{NPC:name:description}} when introducing characters.
Use {{LOOT:item}}, {{GOLD:amount}}, {{XP:amount}} for rewards.
CRITICAL FOR DAMAGE/HEALING:
- If the PLAYER takes damage: {{DAMAGE:Player:amount}}
- If an NPC/ally takes damage: {{DAMAGE:NPCName:amount}} (e.g., {{DAMAGE:Zariel:15}})
- If the PLAYER heals: {{HEAL:Player:amount}}
- If an NPC heals: {{HEAL:NPCName:amount}}
- NEVER use damage tags without specifying WHO is hit!
End with a hook for the player's next action.`;

            const result = await model.generateContent(fullPrompt);
            const response = await result.response;
            let dmResponse = response.text();

            // Get the acting character for auto-rolls
            const actingChar = characters && characters.length > 0 ? characters[0] : null;

            // Process tags and perform auto-rolls (async for database operations)
            const processed = await this.processNarrationTags(
                dmResponse,
                actingChar,
                session?.session_id || 0
            );

            // Check if combat was initiated
            const combatInitiated = processed.inCombat ||
                                   dmResponse.toLowerCase().includes('roll initiative');

            logger.info('[AI DM] Generated response with auto-rolls', {
                campaignId: campaign?.campaign_id,
                inputType,
                rollsPerformed: processed.rolls.length,
                lootGiven: processed.loot.length
            });

            return {
                success: true,
                narration: processed.narration,
                rolls: processed.rolls,
                loot: processed.loot,
                goldGained: processed.goldGained,
                goldSpent: processed.goldSpent,
                xpGained: processed.xpGained,
                damageDealt: processed.damageDealt,
                healingDone: processed.healingDone,
                location: processed.location,
                combatInitiated,
                rollRequests: [], // No longer needed - rolls are automatic
                gameOver: processed.gameOver,
                gameOverReason: processed.gameOverReason
            };
        } catch (error) {
            logger.error('[AI DM] Error generating response:', { error: error.message, stack: error.stack });
            return {
                success: false,
                error: error.message,
                narration: '*The Dungeon Master pauses, gathering their thoughts...*\n\nThere was an issue processing your action. Please try again.',
                rolls: [],
                loot: [],
                goldGained: 0,
                goldSpent: 0,
                xpGained: 0,
                damageDealt: 0,
                healingDone: 0
            };
        }
    }

    /**
     * Get session state for status display
     */
    static async getSessionStatus(sessionId) {
        const state = this.getSessionState(sessionId);
        return {
            location: state.location,
            recentRolls: state.recentRolls.slice(0, 3),
            npcsEncountered: state.npcsEncountered.slice(-5),
            inCombat: state.inCombat,
            initiative: state.initiative,
            currentTurn: state.currentTurn,
            totalXP: state.xpGained,
            loot: state.loot
        };
    }

    /**
     * Build character status bar
     */
    static buildStatusBar(character, sessionId = null) {
        if (!character) return '';

        const hpPercent = Math.floor((character.health / character.max_health) * 100);
        const hpBar = hpPercent > 66 ? '💚' : hpPercent > 33 ? '💛' : '❤️';

        let status = `⭐ **Lv ${character.level}**`;
        status += ` | ${hpBar} **HP:** ${character.health}/${character.max_health}`;
        status += ` | 🛡️ **AC:** ${character.armor_class || 10}`;

        // Add mana if character has it
        if (character.max_mana && character.max_mana > 0) {
            status += ` | 🔮 **MP:** ${character.mana || 0}/${character.max_mana}`;
        }

        // Add gold
        if (character.gold !== undefined) {
            status += ` | 💰 ${character.gold}g`;
        }

        // Add conditions from session state
        if (sessionId) {
            const state = RPGStateManager.getSessionState(sessionId);
            const charConditions = state.playerConditions.get(character.character_name) || [];
            if (charConditions.length > 0) {
                status += ` | ⚠️ ${charConditions.join(', ')}`;
            }
        }

        return status;
    }

    /**
     * Start a new campaign session
     */
    static async startSession(campaignId, channelId = null) {
        const [campaigns] = await pool.execute(
            'SELECT * FROM dnd_campaigns WHERE campaign_id = ?',
            [campaignId]
        );

        if (campaigns.length === 0) {
            throw new Error('Campaign not found');
        }

        const campaign = campaigns[0];
        const sessionNumber = (campaign.session_count || 0) + 1;

        const [result] = await pool.execute(
            `INSERT INTO dnd_sessions (campaign_id, session_number, status)
             VALUES (?, ?, 'active')`,
            [campaignId, sessionNumber]
        );

        // Update campaign with session count and channel_id (if provided)
        if (channelId) {
            await pool.execute(
                `UPDATE dnd_campaigns SET session_count = ?, last_session_at = NOW(), status = 'active', channel_id = ?
                 WHERE campaign_id = ?`,
                [sessionNumber, channelId, campaignId]
            );
        } else {
            await pool.execute(
                `UPDATE dnd_campaigns SET session_count = ?, last_session_at = NOW(), status = 'active'
                 WHERE campaign_id = ?`,
                [sessionNumber, campaignId]
            );
        }

        const [players] = await pool.execute(
            `SELECT c.* FROM dnd_characters c
             JOIN dnd_campaign_players cp ON c.character_id = cp.character_id
             WHERE cp.campaign_id = ?`,
            [campaignId]
        );

        const session = {
            session_id: result.insertId,
            campaign_id: campaignId,
            session_number: sessionNumber,
            status: 'active'
        };

        // Initialize session state
        this.getSessionState(session.session_id);

        const opening = await this.generateOpeningNarration(campaign, session, players);

        await this.logMessage(session.session_id, 'dm_narration', null, opening.narration);

        await pool.execute(
            `UPDATE dnd_sessions SET current_scene = ?, title = ? WHERE session_id = ?`,
            [opening.narration.substring(0, 500), `Session ${sessionNumber}`, session.session_id]
        );

        return {
            session,
            opening: opening.narration,
            location: opening.location || 'Unknown Location',
            character: players[0] || null
        };
    }

    /**
     * Generate opening narration for a session
     */
    static async generateOpeningNarration(campaign, session, characters) {
        const isFirstSession = session.session_number === 1;

        let prompt;
        if (isFirstSession) {
            prompt = `This is the FIRST session of the campaign. Create an engaging opening that:
1. Sets the scene with {{LOCATION:starting_location_name}}
2. Introduces the setting atmosphere matching the theme: ${campaign.theme || 'classic fantasy'}
3. Gives the players a clear starting situation or hook
4. Ends with a prompt for what they want to do

Keep it to 3-4 paragraphs. Be vivid but concise.`;
        } else {
            prompt = `Begin session ${session.session_number}. Start with "When we last left our heroes..." and:
1. Briefly recap where we left off
2. Set the current scene
3. Present an immediate situation or choice
4. End with "What do you do?"

Keep it to 2-3 paragraphs.`;
        }

        return await this.generateResponse(campaign, session, characters, prompt, 'action');
    }

    /**
     * End a session with a recap
     */
    static async endSession(sessionId) {
        const [sessions] = await pool.execute(
            'SELECT * FROM dnd_sessions WHERE session_id = ?',
            [sessionId]
        );

        if (sessions.length === 0) {
            throw new Error('Session not found');
        }

        const session = sessions[0];
        const state = this.getSessionState(sessionId);

        const [campaigns] = await pool.execute(
            'SELECT * FROM dnd_campaigns WHERE campaign_id = ?',
            [session.campaign_id]
        );

        const campaign = campaigns[0];

        const [messageCount] = await pool.execute(
            'SELECT COUNT(*) as count FROM dnd_session_messages WHERE session_id = ?',
            [sessionId]
        );

        const summaryPrompt = `Generate a brief "Story So Far" summary for this session.
Mention key events, decisions made, NPCs met (${state.npcsEncountered.map(n => n.name).join(', ') || 'none'}), and any cliffhangers.
Keep it to 2-3 paragraphs that could serve as a recap for next session.`;

        const summary = await this.generateResponse(campaign, session, [], summaryPrompt, 'action');

        await pool.execute(
            `UPDATE dnd_sessions
             SET status = 'ended', ended_at = NOW(), summary = ?, message_count = ?
             WHERE session_id = ?`,
            [summary.narration, messageCount[0].count, sessionId]
        );

        // Clear session state
        sessionStateCache.delete(sessionId);

        return {
            summary: summary.narration,
            sessionNumber: session.session_number,
            messageCount: messageCount[0].count,
            xpGained: state.xpGained,
            npcsEncountered: state.npcsEncountered,
            loot: state.loot
        };
    }

    /**
     * Log a message to session history
     */
    static async logMessage(sessionId, messageType, characterId, content, metadata = null) {
        await pool.execute(
            `INSERT INTO dnd_session_messages
             (session_id, message_type, character_id, content, metadata)
             VALUES (?, ?, ?, ?, ?)`,
            [sessionId, messageType, characterId, content, metadata ? JSON.stringify(metadata) : null]
        );

        await pool.execute(
            'UPDATE dnd_sessions SET message_count = message_count + 1 WHERE session_id = ?',
            [sessionId]
        );
    }

    /**
     * Process a player action and get DM response
     */
    static async processPlayerAction(sessionId, characterId, action, actionType = 'action') {
        const [sessions] = await pool.execute(
            'SELECT s.*, c.* FROM dnd_sessions s JOIN dnd_campaigns c ON s.campaign_id = c.campaign_id WHERE s.session_id = ?',
            [sessionId]
        );

        if (sessions.length === 0) {
            throw new Error('Session not found');
        }

        const session = sessions[0];

        const [characters] = await pool.execute(
            `SELECT ch.* FROM dnd_characters ch
             JOIN dnd_campaign_players cp ON ch.character_id = cp.character_id
             WHERE cp.campaign_id = ?`,
            [session.campaign_id]
        );

        const actingChar = characters.find(c => c.character_id === characterId);

        await this.logMessage(sessionId, `player_${actionType}`, characterId,
            actingChar ? `${actingChar.character_name}: ${action}` : action);

        const response = await this.generateResponse(
            session,
            session,
            characters,
            actingChar ? `${actingChar.character_name} ${action}` : action,
            actionType
        );

        if (response.success) {
            await this.logMessage(sessionId, 'dm_narration', null, response.narration, {
                rolls: response.rolls,
                loot: response.loot,
                goldGained: response.goldGained,
                goldSpent: response.goldSpent,
                xpGained: response.xpGained,
                damageDealt: response.damageDealt,
                healingDone: response.healingDone,
                combatInitiated: response.combatInitiated,
                enemiesSpawned: response.enemiesSpawned,
                enemiesKilled: response.enemiesKilled
            });

            await pool.execute(
                'UPDATE dnd_sessions SET current_scene = ?, current_location = ? WHERE session_id = ?',
                [response.narration.substring(0, 1000), response.location || null, sessionId]
            );

            // Apply HP changes to the character
            if (actingChar && (response.damageDealt > 0 || response.healingDone > 0)) {
                const hpResult = await RPGStateManager.updateCharacterHealth(
                    actingChar.character_id,
                    response.healingDone - response.damageDealt
                );
                if (hpResult) {
                    actingChar.health = hpResult.newHealth;
                    logger.info('[AI DM] Updated character HP via StateManager', {
                        characterId: actingChar.character_id,
                        previousHP: hpResult.previousHealth,
                        newHP: hpResult.newHealth
                    });
                }
            }

            // Apply gold changes (gained minus spent)
            const netGold = (response.goldGained || 0) - (response.goldSpent || 0);
            if (actingChar && netGold !== 0) {
                await RPGStateManager.updateCharacterGold(actingChar.character_id, netGold);
            }

            // Apply XP changes
            if (actingChar && response.xpGained > 0) {
                const xpResult = await RPGStateManager.addCharacterXP(actingChar.character_id, response.xpGained);
                if (xpResult?.leveledUp) {
                    response.leveledUp = true;
                    response.newLevel = xpResult.newLevel;
                }
            }

            // Add loot to inventory
            if (actingChar && response.loot && response.loot.length > 0) {
                for (const item of response.loot) {
                    await RPGStateManager.addItemToInventory(
                        actingChar.character_id,
                        item.item,
                        item.quantity || 1,
                        { rarity: item.rarity || 'common' }
                    );
                }
                logger.info('[AI DM] Added loot to inventory', {
                    characterId: actingChar.character_id,
                    items: response.loot
                });
            }

            // Remove used items from inventory
            if (actingChar && response.itemsUsed && response.itemsUsed.length > 0) {
                for (const itemName of response.itemsUsed) {
                    await RPGStateManager.removeItemFromInventory(
                        actingChar.character_id,
                        itemName,
                        1
                    );
                }
                logger.info('[AI DM] Removed used items from inventory', {
                    characterId: actingChar.character_id,
                    items: response.itemsUsed
                });
            }

            // Update character location
            if (actingChar && response.location) {
                await RPGStateManager.updateCharacterLocation(actingChar.character_id, response.location);
            }
        }

        // CRITICAL: Refresh character from database to get accurate state after ALL updates
        // This ensures HP, level, gold, XP, max_health are all in sync with database
        if (actingChar) {
            const refreshedChar = await this.refreshCharacter(actingChar.character_id);
            if (refreshedChar) {
                Object.assign(actingChar, refreshedChar);
                logger.info('[AI DM] Refreshed character from database', {
                    characterId: actingChar.character_id,
                    health: actingChar.health,
                    maxHealth: actingChar.max_health,
                    level: actingChar.level,
                    gold: actingChar.gold
                });
            }
        }

        // Handle GAME OVER - end session and mark character as dead if applicable
        if (response.gameOver) {
            logger.info('[AI DM] Game Over - ending session', {
                sessionId,
                reason: response.gameOverReason,
                characterId: actingChar?.character_id
            });

            // Mark session as ended
            await pool.execute(
                `UPDATE dnd_sessions SET status = 'ended', ended_at = NOW() WHERE session_id = ?`,
                [sessionId]
            );

            // If character died, mark them as dead by setting health to 0
            if (response.gameOverReason === 'character_death' && actingChar) {
                await pool.execute(
                    `UPDATE dnd_characters SET health = 0 WHERE character_id = ?`,
                    [actingChar.character_id]
                );
                logger.info('[AI DM] Character marked as dead (HP set to 0)', { characterId: actingChar.character_id });
            }

            // Clear session state from cache
            sessionStateCache.delete(sessionId);
        }

        // Add character and session status to response
        response.character = actingChar;
        response.statusBar = this.buildStatusBar(actingChar, sessionId);
        response.sessionStatus = await this.getSessionStatus(sessionId);
        response.combatStatus = response.inCombat ? RPGStateManager.buildCombatStatus(sessionId, actingChar) : null;

        return response;
    }

    /**
     * Refresh character data from database
     * Call this after any database modifications to ensure in-memory object is in sync
     */
    static async refreshCharacter(characterId) {
        const [rows] = await pool.execute(
            'SELECT * FROM dnd_characters WHERE character_id = ?',
            [characterId]
        );
        return rows.length > 0 ? rows[0] : null;
    }

    /**
     * Get active session for a campaign
     */
    static async getActiveSession(campaignId) {
        const [sessions] = await pool.execute(
            `SELECT * FROM dnd_sessions WHERE campaign_id = ? AND status = 'active' ORDER BY session_id DESC LIMIT 1`,
            [campaignId]
        );
        return sessions.length > 0 ? sessions[0] : null;
    }

    /**
     * Get campaign for a user in a guild
     */
    static async getUserCampaign(userId, guildId) {
        const [campaigns] = await pool.execute(
            `SELECT c.* FROM dnd_campaigns c
             JOIN dnd_campaign_players cp ON c.campaign_id = cp.campaign_id
             WHERE cp.user_id = ? AND c.guild_id = ? AND c.status IN ('setup', 'active', 'paused')
             ORDER BY c.last_session_at DESC LIMIT 1`,
            [userId, guildId]
        );
        return campaigns.length > 0 ? campaigns[0] : null;
    }

    /**
     * Find active campaign in a channel
     */
    static async getActiveCampaignInChannel(channelId, guildId) {
        const [campaigns] = await pool.execute(
            `SELECT c.* FROM dnd_campaigns c
             WHERE c.guild_id = ? AND c.channel_id = ? AND c.status = 'active'
             ORDER BY c.last_session_at DESC LIMIT 1`,
            [guildId, channelId]
        );
        return campaigns.length > 0 ? campaigns[0] : null;
    }

    /**
     * Join an active session mid-adventure
     * @param {number} campaignId - Campaign to join
     * @param {string} userId - User joining
     * @param {number} characterId - Character to join with
     * @returns {object} Join result with narrative introduction
     */
    static async joinActiveSession(campaignId, userId, characterId) {
        // Get campaign
        const [campaigns] = await pool.execute(
            'SELECT * FROM dnd_campaigns WHERE campaign_id = ?',
            [campaignId]
        );

        if (campaigns.length === 0) {
            throw new Error('Campaign not found');
        }

        const campaign = campaigns[0];

        // Get active session
        const session = await this.getActiveSession(campaignId);
        if (!session) {
            throw new Error('No active session to join');
        }

        // Check if user already in campaign
        const [existing] = await pool.execute(
            'SELECT id FROM dnd_campaign_players WHERE campaign_id = ? AND user_id = ?',
            [campaignId, userId]
        );

        if (existing.length > 0) {
            throw new Error('You are already in this campaign');
        }

        // Check player count
        const [players] = await pool.execute(
            'SELECT COUNT(*) as count FROM dnd_campaign_players WHERE campaign_id = ?',
            [campaignId]
        );

        if (players[0].count >= campaign.max_players) {
            throw new Error('This campaign is full');
        }

        // Get character info
        const [characters] = await pool.execute(
            'SELECT * FROM dnd_characters WHERE character_id = ? AND user_id = ?',
            [characterId, userId]
        );

        if (characters.length === 0) {
            throw new Error('Character not found or does not belong to you');
        }

        const character = characters[0];

        // Check character isn't in another campaign
        if (character.active_campaign_id && character.active_campaign_id !== campaignId) {
            throw new Error('This character is already in another campaign');
        }

        // Add player to campaign
        await pool.execute(
            `INSERT INTO dnd_campaign_players (campaign_id, character_id, user_id, role)
             VALUES (?, ?, ?, 'player')`,
            [campaignId, characterId, userId]
        );

        // Update character's active campaign
        await pool.execute(
            'UPDATE dnd_characters SET active_campaign_id = ? WHERE character_id = ?',
            [campaignId, characterId]
        );

        // Get existing party members for context
        const existingPlayers = await this.getCampaignCharacters(campaignId);
        const otherCharacters = existingPlayers.filter(c => c.character_id !== characterId);

        // Generate narrative introduction
        const introPrompt = `A new adventurer joins the party mid-adventure!

New Character:
- Name: ${character.character_name}
- Class: ${character.class} (Level ${character.level})
- Race: ${character.species || 'Human'}
${character.backstory ? `- Brief backstory: ${character.backstory.substring(0, 200)}` : ''}

Existing Party Members: ${otherCharacters.map(c => `${c.character_name} (${c.class})`).join(', ') || 'None yet'}

Create a brief, natural introduction where this new character encounters the party. Consider:
1. A dramatic or interesting entrance fitting their class/background
2. Perhaps they were tracking the same objective, or met by chance
3. A reason for them to join forces
4. End with welcoming them to the adventure

Keep it to 2-3 paragraphs. Be cinematic but concise.`;

        const response = await this.generateResponse(campaign, session, [character], introPrompt, 'action');

        // Log the join event
        await this.logMessage(
            session.session_id,
            'system_event',
            characterId,
            `${character.character_name} (${character.class}) joined the adventure`
        );

        logger.info('[Session] Player joined mid-session', {
            campaignId,
            sessionId: session.session_id,
            userId,
            characterId: character.character_id,
            characterName: character.character_name
        });

        return {
            session,
            character,
            introduction: response.narration,
            existingPlayers: otherCharacters
        };
    }

    /**
     * Get characters in a campaign
     */
    static async getCampaignCharacters(campaignId) {
        const [characters] = await pool.execute(
            `SELECT c.*, cp.user_id, cp.role FROM dnd_characters c
             JOIN dnd_campaign_players cp ON c.character_id = cp.character_id
             WHERE cp.campaign_id = ?`,
            [campaignId]
        );
        return characters;
    }
}

export default RPGAiDungeonMaster;
export { RPGAiDungeonMaster, DM_PERSONALITIES, CAMPAIGN_SETTINGS };
