/**
 * Local File Extractor - Native ES6 Module
 * Handles playback of local audio files (DJ commentary)
 */

import { BaseExtractor, Track } from 'discord-player';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// Only the bot's own generated/uploaded audio may be played from disk. Without this, any
// /music play query that was an absolute path (e.g. /etc/hostname) was accepted — a
// file-existence oracle, and ffmpeg would play any audio file on the box.
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWED_ROOTS = [...new Set([PROJECT_ROOT, '/tmp', os.tmpdir()].map(d => path.resolve(d) + path.sep))];
const AUDIO_EXT = /\.(wav|mp3|ogg|oga|flac|opus|m4a|aac|webm)$/i;

function isAllowedLocalAudio(p) {
    const resolved = path.resolve(p);
    return AUDIO_EXT.test(resolved) && ALLOWED_ROOTS.some(root => resolved.startsWith(root));
}

export class LocalFileExtractor extends BaseExtractor {
    static identifier = 'com.certifried.local-file';

    async validate(query, searchOptions) {
        console.log('[LocalFileExtractor] validate() called with:', query);

        // Only validate absolute file paths that exist
        if (typeof query !== 'string') {
            console.log('[LocalFileExtractor] Query is not a string:', typeof query);
            return false;
        }

        // Check if it's an absolute path
        if (!path.isAbsolute(query)) {
            console.log('[LocalFileExtractor] Path is not absolute:', query);
            return false;
        }

        if (!isAllowedLocalAudio(query)) return false;

        // Check if file exists
        const exists = fs.existsSync(query);
        console.log('[LocalFileExtractor] File exists check for', query, ':', exists);
        return exists;
    }

    async handle(query, searchOptions) {
        console.log('[LocalFileExtractor] handle() called with:', query);

        if (!isAllowedLocalAudio(query) || !fs.existsSync(query)) {
            console.log('[LocalFileExtractor] File does not exist in handle():', query);
            return { playlist: null, tracks: [] };
        }

        const stats = fs.statSync(query);
        const fileName = path.basename(query);

        const track = new Track(this.context.player, {
            title: fileName,
            description: 'Local file',
            author: 'Local',
            url: query,
            thumbnail: null,
            duration: '0:00',
            source: 'com.certifried.local-file',
            requestedBy: searchOptions.requestedBy,
            metadata: searchOptions.metadata
        });

        track.extractor = this;
        console.log('[LocalFileExtractor] Successfully created track:', fileName);
        return { playlist: null, tracks: [track] };
    }

    async stream(info) {
        const filePath = info.url;

        if (!isAllowedLocalAudio(filePath) || !fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        console.log('[LocalFileExtractor] Creating read stream for WAV file:', filePath);

        // Return a readable stream directly from the WAV file
        // discord-player will handle the FFmpeg conversion to PCM
        return fs.createReadStream(filePath);
    }
}
