import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { PDFDocument, PDFName, PDFRef } = require('pdf-lib');

import axios from 'axios';
import logger from './logger.js';

// D&D Beyond supported classes (no mapping - use actual classes)
const DND_CLASSES = [
    'barbarian', 'bard', 'cleric', 'druid', 'fighter', 'monk',
    'paladin', 'ranger', 'rogue', 'sorcerer', 'warlock', 'wizard', 'artificer'
];

// Skill to ability mapping
const SKILL_ABILITIES = {
    'Acrobatics': 'DEX', 'Animal Handling': 'WIS', 'Arcana': 'INT',
    'Athletics': 'STR', 'Deception': 'CHA', 'History': 'INT',
    'Insight': 'WIS', 'Intimidation': 'CHA', 'Investigation': 'INT',
    'Medicine': 'WIS', 'Nature': 'INT', 'Perception': 'WIS',
    'Performance': 'CHA', 'Persuasion': 'CHA', 'Religion': 'INT',
    'Sleight of Hand': 'DEX', 'Stealth': 'DEX', 'Survival': 'WIS'
};

/**
 * Extract all form field values from D&D Beyond PDF
 * The PDF stores character data in Widget annotations
 */
async function extractPDFFields(pdfBuffer) {
    const doc = await PDFDocument.load(pdfBuffer);
    const context = doc.context;
    const fields = {};

    // Iterate all pages
    for (let p = 0; p < doc.getPageCount(); p++) {
        const page = doc.getPage(p);
        const annotsRef = page.node.Annots();
        if (!annotsRef) continue;

        const annots = annotsRef.asArray();
        for (const ref of annots) {
            if (ref instanceof PDFRef) {
                const obj = context.lookup(ref);
                if (obj && obj.get) {
                    const t = obj.get(PDFName.of('T'));
                    const v = obj.get(PDFName.of('V'));

                    if (t && v) {
                        const fieldName = t.decodeText ? t.decodeText() : t.toString();
                        const fieldValue = v.decodeText ? v.decodeText() : v.toString();
                        if (fieldValue && fieldValue.trim()) {
                            fields[fieldName] = fieldValue;
                        }
                    }
                }
            }
        }
    }

    return fields;
}

/**
 * Parse a D&D Beyond character sheet PDF - Full extraction
 * @param {Buffer} pdfBuffer - The PDF file buffer
 * @returns {Object} Complete parsed character data
 */
async function parseCharacterPDF(pdfBuffer) {
    try {
        // Extract all form fields from the PDF
        const fields = await extractPDFFields(pdfBuffer);

        logger.debug('[PDF Parser] Extracted fields:', Object.keys(fields).length);

        // Extract complete character data
        const character = {
            // Basic info
            name: fields['CharacterName'] || fields['CharacterName2'] || null,
            playerName: fields['PLAYER NAME'] || fields['PLAYER NAME2'] || null,

            // Class info
            class: extractClass(fields),
            subclass: extractSubclass(fields),
            level: extractLevel(fields),

            // Species/Race and Background
            species: fields['RACE'] || fields['RACE2'] || fields['SPECIES'] || null,
            background: fields['BACKGROUND'] || fields['BACKGROUND2'] || null,
            alignment: fields['Alignment'] || null,

            // Core stats
            stats: extractStats(fields),

            // Combat stats
            armorClass: parseInt(fields['AC'], 10) || 10,
            speed: fields['Speed'] || '30 ft.',
            initiative: parseInt(fields['Init'], 10) || 0,
            proficiencyBonus: parseInt(fields['ProfBonus']?.replace('+', ''), 10) || 2,
            hitDice: fields['Total'] || null,

            // HP
            hp: extractHP(fields),
            maxHp: extractHP(fields),
            tempHp: parseInt(fields['TempHP']?.replace('--', '0'), 10) || 0,

            // Saving throws
            savingThrows: extractSavingThrows(fields),

            // Skills
            skillProficiencies: extractSkillProficiencies(fields),

            // Languages and Proficiencies
            languages: extractLanguages(fields),
            weaponProficiencies: extractWeaponProficiencies(fields),
            armorProficiencies: extractArmorProficiencies(fields),
            toolProficiencies: extractToolProficiencies(fields),

            // Features and Traits
            features: extractFeatures(fields),
            racialTraits: extractRacialTraits(fields),
            classFeatures: extractClassFeatures(fields),

            // Spellcasting
            spellcasting: extractSpellcasting(fields),

            // Class resources (Sorcery Points, Ki, etc.)
            classResource: extractClassResource(fields),

            // Roleplay elements
            personalityTraits: fields['PersonalityTraits'] || null,
            ideals: fields['Ideals'] || null,
            bonds: fields['Bonds'] || null,
            flaws: fields['Flaws'] || null,
            backstory: fields['Backstory'] || fields['CHARACTER BACKSTORY'] || null,

            // Physical description
            appearance: {
                age: fields['AGE'] || null,
                height: fields['HEIGHT'] || null,
                weight: fields['WEIGHT'] || null,
                eyes: fields['EYES'] || null,
                skin: fields['SKIN'] || null,
                hair: fields['HAIR'] || null
            },

            // Defenses
            resistances: extractResistances(fields),
            immunities: extractImmunities(fields),
            senses: extractSenses(fields),

            // Actions and Attacks
            attacks: extractAttacks(fields),
            actions: extractActions(fields),

            // Equipment and Currency
            equipment: extractEquipment(fields),
            currency: {
                gold: parseInt(fields['GP'], 10) || 0,
                silver: parseInt(fields['SP'], 10) || 0,
                copper: parseInt(fields['CP'], 10) || 0,
                electrum: parseInt(fields['EP'], 10) || 0,
                platinum: parseInt(fields['PP'], 10) || 0
            },

            // Store raw fields for debugging/future use
            rawFields: fields
        };

        logger.info('[PDF Parser] Extracted full character:', {
            name: character.name,
            class: character.class,
            subclass: character.subclass,
            level: character.level,
            species: character.species
        });

        return character;

    } catch (error) {
        logger.error('[PDF Parser] Error parsing PDF:', error);
        throw new Error(`Failed to parse PDF: ${error.message}`);
    }
}

/**
 * Download PDF from URL and parse it
 */
async function parseCharacterFromURL(url) {
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 30000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        return await parseCharacterPDF(Buffer.from(response.data));
    } catch (error) {
        logger.error('[PDF Parser] Error downloading PDF:', error);
        throw new Error(`Failed to download PDF: ${error.message}`);
    }
}

// ============ Extraction Functions ============

function extractClass(fields) {
    const classLevel = fields['CLASS  LEVEL'] || fields['CLASS & LEVEL'] || '';
    const match = classLevel.match(/^([A-Za-z]+)/);
    if (match) {
        const className = match[1].toLowerCase();
        // Return the actual D&D class name
        if (DND_CLASSES.includes(className)) {
            return className;
        }
    }
    return 'fighter'; // Default
}

function extractSubclass(fields) {
    // D&D Beyond often includes subclass info in features or class features
    // Look for common subclass patterns
    const features = fields['FeaturesTraits1'] || fields['FeaturesTraits2'] || '';

    // Common subclass patterns
    const subclassPatterns = [
        // Sorcerer
        /Draconic\s+(?:Bloodline|Ancestry)/i,
        /Wild\s+Magic/i,
        /Divine\s+Soul/i,
        /Shadow\s+Magic/i,
        /Aberrant\s+Mind/i,
        /Clockwork\s+Soul/i,
        // Fighter
        /Champion/i,
        /Battle\s+Master/i,
        /Eldritch\s+Knight/i,
        // Rogue
        /Assassin/i,
        /Thief/i,
        /Arcane\s+Trickster/i,
        // Wizard
        /School\s+of\s+(\w+)/i,
        /Evocation/i,
        /Abjuration/i,
        /Necromancy/i,
        // Cleric
        /Life\s+Domain/i,
        /Light\s+Domain/i,
        /War\s+Domain/i,
        // Others
        /Circle\s+of\s+(\w+)/i, // Druid
        /Path\s+of\s+(?:the\s+)?(\w+)/i, // Barbarian
        /College\s+of\s+(\w+)/i, // Bard
        /Oath\s+of\s+(\w+)/i, // Paladin
        /Way\s+of\s+(?:the\s+)?(\w+)/i, // Monk
        /(\w+)\s+Patron/i, // Warlock
    ];

    for (const pattern of subclassPatterns) {
        const match = features.match(pattern);
        if (match) {
            return match[0].trim();
        }
    }

    return null;
}

function extractLevel(fields) {
    const classLevel = fields['CLASS  LEVEL'] || fields['CLASS & LEVEL'] || '';
    const match = classLevel.match(/(\d+)/);
    if (match) {
        const level = parseInt(match[1], 10);
        if (level >= 1 && level <= 20) {
            return level;
        }
    }
    return 1;
}

function extractStats(fields) {
    return {
        strength: parseInt(fields['STR'], 10) || 10,
        dexterity: parseInt(fields['DEX'], 10) || 10,
        constitution: parseInt(fields['CON'], 10) || 10,
        intelligence: parseInt(fields['INT'], 10) || 10,
        wisdom: parseInt(fields['WIS'], 10) || 10,
        charisma: parseInt(fields['CHA'], 10) || 10
    };
}

function extractHP(fields) {
    const hp = parseInt(fields['MaxHP'], 10);
    if (hp && hp >= 1 && hp <= 999) {
        return hp;
    }
    return 10; // Default
}

function extractSavingThrows(fields) {
    const saves = {};
    const abilities = ['Str', 'Dex', 'Con', 'Int', 'Wis', 'Cha'];

    for (const ability of abilities) {
        const profField = fields[`${ability}Prof`];
        const saveField = fields[`ST ${ability === 'Str' ? 'Strength' : ability === 'Dex' ? 'Dexterity' : ability === 'Con' ? 'Constitution' : ability === 'Int' ? 'Intelligence' : ability === 'Wis' ? 'Wisdom' : 'Charisma'}`];

        saves[ability.toLowerCase()] = {
            proficient: profField === '•' || profField === 'P',
            modifier: parseInt(saveField?.replace('+', ''), 10) || 0
        };
    }

    return saves;
}

function extractSkillProficiencies(fields) {
    const skills = {};
    const skillNames = Object.keys(SKILL_ABILITIES);

    for (const skill of skillNames) {
        const profField = fields[`${skill.replace(/\s+/g, '')}Prof`];
        const modField = fields[skill.replace(/\s+/g, '')];

        skills[skill.toLowerCase().replace(/\s+/g, '_')] = {
            proficient: profField === 'P' || profField === '•',
            expertise: profField === 'E',
            modifier: parseInt(modField?.replace('+', ''), 10) || 0
        };
    }

    return skills;
}

function extractLanguages(fields) {
    const profLang = fields['ProficienciesLang'] || '';
    const languageMatch = profLang.match(/LANGUAGES\s*===\s*\n?([\s\S]*?)(?:===|$)/i);

    if (languageMatch) {
        const langText = languageMatch[1].trim();
        return langText.split(/,\s*|\n/).filter(l => l.trim()).map(l => l.trim());
    }

    return ['Common'];
}

function extractWeaponProficiencies(fields) {
    const profLang = fields['ProficienciesLang'] || '';
    const weaponMatch = profLang.match(/WEAPONS\s*===\s*\n?([\s\S]*?)(?:===|$)/i);

    if (weaponMatch) {
        const weaponText = weaponMatch[1].trim();
        return weaponText.split(/,\s*|\n/).filter(w => w.trim()).map(w => w.trim());
    }

    return [];
}

function extractArmorProficiencies(fields) {
    const profLang = fields['ProficienciesLang'] || '';
    const armorMatch = profLang.match(/ARMOR\s*===\s*\n?([\s\S]*?)(?:===|$)/i);

    if (armorMatch) {
        const armorText = armorMatch[1].trim();
        return armorText.split(/,\s*|\n/).filter(a => a.trim()).map(a => a.trim());
    }

    return [];
}

function extractToolProficiencies(fields) {
    const profLang = fields['ProficienciesLang'] || '';
    const toolMatch = profLang.match(/TOOLS\s*===\s*\n?([\s\S]*?)(?:===|$)/i);

    if (toolMatch) {
        const toolText = toolMatch[1].trim();
        return toolText.split(/,\s*|\n/).filter(t => t.trim()).map(t => t.trim());
    }

    return [];
}

function extractFeatures(fields) {
    const features = [];

    // Combine all feature fields
    for (let i = 1; i <= 4; i++) {
        const featField = fields[`FeaturesTraits${i}`];
        if (featField) {
            // Clean up the garbled text and extract meaningful content
            const cleaned = cleanFeatureText(featField);
            if (cleaned) {
                features.push(cleaned);
            }
        }
    }

    return features;
}

function cleanFeatureText(text) {
    // D&D Beyond PDFs sometimes have encoding issues
    // Remove garbled characters and clean up
    return text
        .replace(/[\u0000-\u001F\u0080-\u009F]/g, '')
        .replace(/[ༀ-\u0FFF]/g, '')
        .replace(/[\u1000-\u109F]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractRacialTraits(fields) {
    const traits = [];
    const features = fields['FeaturesTraits2'] || fields['FeaturesTraits3'] || '';

    // Look for racial trait patterns
    const speciesSection = features.match(/SPECIES\s+FEATURES[\s\S]*?(?:===|$)/i);
    if (speciesSection) {
        traits.push(cleanFeatureText(speciesSection[0]));
    }

    // Extract specific traits
    if (fields['Defenses']) {
        traits.push(`Defenses: ${fields['Defenses']}`);
    }
    if (fields['AdditionalSenses']) {
        traits.push(`Senses: ${fields['AdditionalSenses']}`);
    }

    return traits;
}

function extractClassFeatures(fields) {
    const features = [];

    // Look for class feature sections
    const feat1 = fields['FeaturesTraits1'] || '';
    const classSection = feat1.match(/===\s*\w+\s+FEATURES\s*===[\s\S]*?(?:===|$)/i);

    if (classSection) {
        features.push(cleanFeatureText(classSection[0]));
    }

    return features;
}

function extractSpellcasting(fields) {
    const spellcasting = {
        ability: fields['spellCastingAbility0'] || null,
        saveDC: parseInt(fields['spellSaveDC0'], 10) || null,
        attackBonus: parseInt(fields['spellAtkBonus0']?.replace('+', ''), 10) || null,
        class: fields['spellCastingClass0'] || null,
        slots: {},
        cantrips: [],
        spells: []
    };

    // Extract spell slots
    for (let level = 1; level <= 9; level++) {
        const slotField = fields[`spellSlotHeader${level}`];
        if (slotField) {
            const match = slotField.match(/(\d+)\s*Slots/i);
            if (match) {
                spellcasting.slots[level] = parseInt(match[1], 10);
            }
        }
    }

    // Extract spells (cantrips and leveled)
    for (let i = 0; i < 50; i++) {
        const spellName = fields[`spellName${i}`];
        if (!spellName) continue;

        const spell = {
            name: spellName,
            level: determineSpellLevel(fields, i),
            source: fields[`spellSource${i}`] || null,
            prepared: fields[`spellPrepared${i}`] === 'O',
            castingTime: fields[`spellCastingTime${i}`] || null,
            range: fields[`spellRange${i}`] || null,
            components: fields[`spellComponents${i}`] || null,
            duration: fields[`spellDuration${i}`] || null,
            notes: fields[`spellNotes${i}`] || null
        };

        if (spell.level === 0) {
            spellcasting.cantrips.push(spell);
        } else {
            spellcasting.spells.push(spell);
        }
    }

    return spellcasting;
}

function determineSpellLevel(fields, index) {
    // Check headers to determine spell level
    const header = fields[`spellHeader${index}`];
    if (header && header.includes('CANTRIPS')) return 0;

    // Check by position relative to level headers
    for (let level = 0; level <= 9; level++) {
        const levelHeader = fields[`spellHeader${level}`];
        if (levelHeader && levelHeader.includes(`${level === 0 ? 'CANTRIPS' : level + (level === 1 ? 'st' : level === 2 ? 'nd' : level === 3 ? 'rd' : 'th')}`)) {
            // This spell is at this level
        }
    }

    return 1; // Default to 1st level
}

function extractClassResource(fields) {
    // Look for Sorcery Points, Ki, etc.
    if (fields['SP'] !== undefined) {
        return {
            name: 'Sorcery Points',
            current: parseInt(fields['SP'], 10) || 0,
            max: extractMaxClassResource(fields, 'SP')
        };
    }

    return null;
}

function extractMaxClassResource(fields, type) {
    // Calculate based on level for different classes
    return 0;
}

function extractResistances(fields) {
    const defenses = fields['Defenses'] || '';
    const resistances = [];

    const resistMatch = defenses.match(/Resistances?\s*[-–]\s*([\w\s,]+)/i);
    if (resistMatch) {
        resistances.push(...resistMatch[1].split(/,\s*/).map(r => r.trim()));
    }

    return resistances;
}

function extractImmunities(fields) {
    const defenses = fields['Defenses'] || '';
    const immunities = [];

    const immuneMatch = defenses.match(/Immunit(?:y|ies)\s*[-–]\s*([\w\s,]+)/i);
    if (immuneMatch) {
        immunities.push(...immuneMatch[1].split(/,\s*/).map(i => i.trim()));
    }

    return immunities;
}

function extractSenses(fields) {
    const senses = [];

    if (fields['AdditionalSenses']) {
        senses.push(fields['AdditionalSenses']);
    }

    // Passive senses
    if (fields['Passive1']) senses.push(`Passive Perception: ${fields['Passive1']}`);
    if (fields['Passive2']) senses.push(`Passive Insight: ${fields['Passive2']}`);
    if (fields['Passive3']) senses.push(`Passive Investigation: ${fields['Passive3']}`);

    return senses;
}

function extractAttacks(fields) {
    const attacks = [];

    // Extract weapon attacks
    for (let i = 0; i < 10; i++) {
        const wpnName = fields[`Wpn Name${i === 0 ? '' : i}`] || fields[`Wpn${i} Name`];
        if (!wpnName) continue;

        attacks.push({
            name: wpnName,
            attackBonus: fields[`Wpn${i === 0 ? '1' : i} AtkBonus`] || null,
            damage: fields[`Wpn${i === 0 ? '1' : i} Damage`] || null
        });
    }

    return attacks;
}

function extractActions(fields) {
    const actions = [];

    // Extract from Actions fields
    if (fields['Actions1']) {
        actions.push(cleanFeatureText(fields['Actions1']));
    }
    if (fields['Actions2']) {
        actions.push(cleanFeatureText(fields['Actions2']));
    }

    return actions;
}

function extractEquipment(fields) {
    const equipment = [];

    // Extract equipment items
    for (let i = 0; i < 30; i++) {
        const name = fields[`Eq Name${i}`];
        if (!name) continue;

        equipment.push({
            name: name,
            quantity: parseInt(fields[`Eq Qty${i}`], 10) || 1,
            weight: fields[`Eq Weight${i}`] || null
        });
    }

    return equipment;
}

/**
 * Convert parsed PDF data to database-ready character format
 */
function convertToRPGCharacter(parsedData) {
    // Calculate mana based on class and stats
    const intMod = Math.floor((parsedData.stats.intelligence - 10) / 2);
    const wisMod = Math.floor((parsedData.stats.wisdom - 10) / 2);
    const chaMod = Math.floor((parsedData.stats.charisma - 10) / 2);

    // Spellcasters get more mana
    const isSpellcaster = ['sorcerer', 'wizard', 'warlock', 'cleric', 'druid', 'bard', 'paladin', 'ranger'].includes(parsedData.class);
    const baseMana = isSpellcaster ? 10 + (parsedData.level * (4 + Math.max(intMod, wisMod, chaMod))) : 10;

    return {
        // Basic info
        character_name: parsedData.name || 'Unknown Hero',
        player_name: parsedData.playerName || null,

        // Class info (actual D&D class, not mapped)
        class: parsedData.class,
        subclass: parsedData.subclass || null,
        multiclass: null, // TODO: Multiclass support

        // Species and background
        species: parsedData.species || null,
        background: parsedData.background || null,
        alignment: parsedData.alignment || null,

        // Level and XP
        level: parsedData.level || 1,
        experience: 0,

        // Stats
        strength: parsedData.stats.strength,
        dexterity: parsedData.stats.dexterity,
        constitution: parsedData.stats.constitution,
        intelligence: parsedData.stats.intelligence,
        wisdom: parsedData.stats.wisdom,
        charisma: parsedData.stats.charisma,

        // Combat stats
        armor_class: parsedData.armorClass || 10,
        speed: parsedData.speed || '30 ft.',
        initiative: parsedData.initiative || 0,
        proficiency_bonus: parsedData.proficiencyBonus || 2,
        hit_dice: parsedData.hitDice || null,

        // HP
        health: parsedData.hp || parsedData.maxHp || 10,
        max_health: parsedData.maxHp || parsedData.hp || 10,
        temp_hp: parsedData.tempHp || 0,

        // Mana (for game mechanics)
        mana: baseMana,
        max_mana: baseMana,

        // Saves and skills
        saving_throws: JSON.stringify(parsedData.savingThrows),
        skill_proficiencies: JSON.stringify(parsedData.skillProficiencies),

        // Proficiencies
        languages: JSON.stringify(parsedData.languages),
        weapon_proficiencies: JSON.stringify(parsedData.weaponProficiencies),
        armor_proficiencies: JSON.stringify(parsedData.armorProficiencies),
        tool_proficiencies: JSON.stringify(parsedData.toolProficiencies),

        // Features
        features: JSON.stringify(parsedData.features),
        racial_traits: JSON.stringify(parsedData.racialTraits),
        class_features: JSON.stringify(parsedData.classFeatures),

        // Spellcasting
        spellcasting_ability: parsedData.spellcasting?.ability || null,
        spell_save_dc: parsedData.spellcasting?.saveDC || null,
        spell_attack_bonus: parsedData.spellcasting?.attackBonus || null,
        spell_slots: JSON.stringify(parsedData.spellcasting?.slots || {}),
        spells_known: JSON.stringify(parsedData.spellcasting?.spells || []),
        cantrips: JSON.stringify(parsedData.spellcasting?.cantrips || []),

        // Class resources
        class_resource: parsedData.classResource?.name || null,
        class_resource_max: parsedData.classResource?.max || 0,
        class_resource_current: parsedData.classResource?.current || 0,

        // Roleplay
        personality_traits: parsedData.personalityTraits || null,
        ideals: parsedData.ideals || null,
        bonds: parsedData.bonds || null,
        flaws: parsedData.flaws || null,
        backstory: parsedData.backstory || null,

        // Appearance
        age: parsedData.appearance?.age || null,
        height: parsedData.appearance?.height || null,
        weight: parsedData.appearance?.weight || null,
        eyes: parsedData.appearance?.eyes || null,
        skin: parsedData.appearance?.skin || null,
        hair: parsedData.appearance?.hair || null,

        // Defenses
        resistances: JSON.stringify(parsedData.resistances || []),
        immunities: JSON.stringify(parsedData.immunities || []),
        vulnerabilities: JSON.stringify([]),
        senses: JSON.stringify(parsedData.senses || []),

        // Actions
        attacks: JSON.stringify(parsedData.attacks || []),
        actions: JSON.stringify(parsedData.actions || []),
        bonus_actions: JSON.stringify([]),
        reactions: JSON.stringify([]),

        // Equipment
        equipment: JSON.stringify(parsedData.equipment || []),

        // Currency
        gold: parsedData.currency?.gold || 0,
        silver: parsedData.currency?.silver || 0,
        copper: parsedData.currency?.copper || 0,
        electrum: parsedData.currency?.electrum || 0,
        platinum: parsedData.currency?.platinum || 0,

        // Other
        death_save_successes: 0,
        death_save_failures: 0,
        inspiration: false,
        current_zone: 'town',

        // Import metadata
        imported_from: 'dndbeyond',
        import_data: JSON.stringify({
            importedAt: new Date().toISOString(),
            originalFields: Object.keys(parsedData.rawFields).length
        })
    };
}

export {
    parseCharacterPDF,
    parseCharacterFromURL,
    convertToRPGCharacter,
    extractPDFFields,
    DND_CLASSES
};
