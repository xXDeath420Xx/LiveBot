/**
 * Local File Extractor - Native ES6 Module
 * Handles playback of local audio files (DJ commentary)
 */

import { BaseExtractor, Track } from 'discord-player';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

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

        // Check if file exists
        const exists = fs.existsSync(query);
        console.log('[LocalFileExtractor] File exists check for', query, ':', exists);
        return exists;
    }

    async handle(query, searchOptions) {
        console.log('[LocalFileExtractor] handle() called with:', query);

        if (!fs.existsSync(query)) {
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

        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        console.log('[LocalFileExtractor] Creating read stream for WAV file:', filePath);

        // Return a readable stream directly from the WAV file
        // discord-player will handle the FFmpeg conversion to PCM
        return fs.createReadStream(filePath);
    }
}
