#!/usr/bin/env node
/**
 * Generate preview audio files for all installed Piper TTS voices
 * Creates a demo audio file for each voice using a standardized message
 */

const piperTTS = require('../utils/piper-tts.cjs');
const fs = require('fs');
const path = require('path');

const PREVIEWS_DIR = path.join(__dirname, '..', 'piper_models', 'previews');
const PREVIEW_TEXT = "Hello, I'm {VOICE_NAME}. This is how I'd sound if I were your AI DJ. Select me to have your music experience enhanced by commentary with my voice.";

// Ensure previews directory exists
if (!fs.existsSync(PREVIEWS_DIR)) {
    fs.mkdirSync(PREVIEWS_DIR, { recursive: true });
    console.log(`✓ Created previews directory: ${PREVIEWS_DIR}`);
}

async function generatePreviews() {
    console.log('========================================');
    console.log('Voice Preview Generator');
    console.log('========================================\n');

    const installedVoices = piperTTS.getInstalledVoices();
    const voiceIds = Object.keys(installedVoices);
    const totalVoices = voiceIds.length;

    console.log(`Found ${totalVoices} installed voices\n`);
    console.log('Generating preview audio files...\n');

    let successCount = 0;
    let skipCount = 0;
    let errorCount = 0;

    for (let i = 0; i < voiceIds.length; i++) {
        const voiceId = voiceIds[i];
        const voiceData = installedVoices[voiceId];
        const progress = `[${i + 1}/${totalVoices}]`;

        // Format voice name for the text
        const formattedName = voiceId
            .split('_')
            .map(word => word.charAt(0).toUpperCase() + word.slice(1))
            .join(' ');

        const text = PREVIEW_TEXT.replace('{VOICE_NAME}', formattedName);
        const previewFileName = `${voiceId}.wav`;
        const previewPath = path.join(PREVIEWS_DIR, previewFileName);

        // Check if preview already exists
        if (fs.existsSync(previewPath)) {
            console.log(`${progress} ⏭  ${voiceData.flag} ${formattedName} - Already exists`);
            skipCount++;
            continue;
        }

        try {
            // Generate audio
            const audioPath = await piperTTS.synthesize(text, voiceId);

            // Move to previews directory
            fs.renameSync(audioPath, previewPath);

            console.log(`${progress} ✓  ${voiceData.flag} ${formattedName} (${voiceData.locale}, ${voiceData.quality})`);
            successCount++;

        } catch (err) {
            console.error(`${progress} ✗  ${formattedName} - Error: ${err.message}`);
            errorCount++;
        }

        // Small delay to avoid overwhelming the system
        if (i < voiceIds.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    console.log('\n========================================');
    console.log('Generation Complete!');
    console.log('========================================');
    console.log(`✓ Generated: ${successCount} previews`);
    console.log(`⏭ Skipped: ${skipCount} (already existed)`);
    if (errorCount > 0) {
        console.log(`✗ Errors: ${errorCount}`);
    }
    console.log(`\nPreviews directory: ${PREVIEWS_DIR}`);
    console.log(`Total size: ${getDirectorySize(PREVIEWS_DIR)}`);
}

function getDirectorySize(dirPath) {
    if (!fs.existsSync(dirPath)) {
        return '0 MB';
    }

    let totalSize = 0;
    const files = fs.readdirSync(dirPath);

    for (const file of files) {
        const filePath = path.join(dirPath, file);
        const stats = fs.statSync(filePath);
        if (stats.isFile()) {
            totalSize += stats.size;
        }
    }

    const sizeMB = (totalSize / (1024 * 1024)).toFixed(2);
    return `${sizeMB} MB`;
}

// Run the generator
generatePreviews()
    .then(() => {
        console.log('\nDone!');
        process.exit(0);
    })
    .catch(err => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
