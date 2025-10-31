"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.LocalFileExtractor = void 0;
const discord_player_1 = require("discord-player");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class LocalFileExtractor extends discord_player_1.BaseExtractor {
    async validate(query, searchOptions) {
        // Only validate absolute file paths that exist
        if (typeof query !== 'string')
            return false;
        // Check if it's an absolute path
        if (!path.isAbsolute(query))
            return false;
        // Check if file exists
        return fs.existsSync(query);
    }
    async handle(query, searchOptions) {
        if (!fs.existsSync(query)) {
            return { playlist: null, tracks: [] };
        }
        const stats = fs.statSync(query);
        const fileName = path.basename(query);
        const track = new discord_player_1.Track(this.context.player, {
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
exports.LocalFileExtractor = LocalFileExtractor;
LocalFileExtractor.identifier = 'com.certifried.local-file';
