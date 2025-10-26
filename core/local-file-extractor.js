const { BaseExtractor, Track } = require('discord-player');
const fs = require('fs');
const path = require('path');

class LocalFileExtractor extends BaseExtractor {
    static identifier = 'com.certifried.local-file';

    async validate(query, searchOptions) {
        // Only validate absolute file paths that exist
        if (typeof query !== 'string') return false;

        // Check if it's an absolute path
        if (!path.isAbsolute(query)) return false;

        // Check if file exists
        return fs.existsSync(query);
    }

    async handle(query, searchOptions) {
        if (!fs.existsSync(query)) {
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
        return { playlist: null, tracks: [track] };
    }

    async stream(info) {
        const filePath = info.url;
        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        return fs.createReadStream(filePath);
    }
}

module.exports = { LocalFileExtractor };
