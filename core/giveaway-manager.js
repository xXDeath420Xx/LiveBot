"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkGiveaways = checkGiveaways;
exports.endGiveaway = endGiveaway;
var db = require("../utils/db");
var logger_1 = require("../utils/logger");
var discord_js_1 = require("discord.js");
function checkGiveaways() {
    return __awaiter(this, void 0, void 0, function () {
        var activeGiveaways, _i, activeGiveaways_1, giveaway, error_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!global.client)
                        return [2 /*return*/];
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 7, , 8]);
                    return [4 /*yield*/, db.execute('SELECT * FROM giveaways WHERE is_active = 1 AND ends_at <= NOW()')];
                case 2:
                    activeGiveaways = (_a.sent())[0];
                    if (activeGiveaways.length === 0)
                        return [2 /*return*/];
                    logger_1.default.info("Found ".concat(activeGiveaways.length, " giveaways to end."), { category: 'giveaway' });
                    _i = 0, activeGiveaways_1 = activeGiveaways;
                    _a.label = 3;
                case 3:
                    if (!(_i < activeGiveaways_1.length)) return [3 /*break*/, 6];
                    giveaway = activeGiveaways_1[_i];
                    return [4 /*yield*/, endGiveaway(giveaway, false)];
                case 4:
                    _a.sent();
                    _a.label = 5;
                case 5:
                    _i++;
                    return [3 /*break*/, 3];
                case 6: return [3 /*break*/, 8];
                case 7:
                    error_1 = _a.sent();
                    logger_1.default.error('Error checking for giveaways to end.', { category: 'giveaway', error: error_1.stack });
                    return [3 /*break*/, 8];
                case 8: return [2 /*return*/];
            }
        });
    });
}
function endGiveaway(giveaway, isReroll) {
    return __awaiter(this, void 0, void 0, function () {
        var guildId, guild, channel, message, reaction, users, entrants, winners, winnersArray, winnerMentions, resultMessage, endedEmbed, error_2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    guildId = giveaway.guild_id;
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 14, , 15]);
                    guild = global.client.guilds.cache.get(guildId);
                    if (!guild) {
                        logger_1.default.warn("Guild not found for giveaway ".concat(giveaway.id, "."), { guildId: guildId, category: 'giveaway' });
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, guild.channels.fetch(giveaway.channel_id).catch(function () { return null; })];
                case 2:
                    channel = _a.sent();
                    if (!channel) {
                        logger_1.default.warn("Channel not found for giveaway ".concat(giveaway.id, "."), { guildId: guildId, category: 'giveaway' });
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, channel.messages.fetch(giveaway.message_id).catch(function () { return null; })];
                case 3:
                    message = _a.sent();
                    if (!message) {
                        logger_1.default.warn("Message not found for giveaway ".concat(giveaway.id, "."), { guildId: guildId, category: 'giveaway' });
                        return [2 /*return*/];
                    }
                    reaction = message.reactions.cache.get('🎉');
                    if (!!reaction) return [3 /*break*/, 6];
                    return [4 /*yield*/, channel.send("The giveaway for **".concat(giveaway.prize, "** ended with no entries."))];
                case 4:
                    _a.sent();
                    return [4 /*yield*/, db.execute('UPDATE giveaways SET is_active = 0 WHERE id = ?', [giveaway.id])];
                case 5:
                    _a.sent();
                    logger_1.default.info("Giveaway ".concat(giveaway.id, " ended with no reactions."), { guildId: guildId, category: 'giveaway' });
                    return [2 /*return*/];
                case 6: return [4 /*yield*/, reaction.users.fetch()];
                case 7:
                    users = _a.sent();
                    entrants = users.filter(function (user) { return !user.bot; });
                    if (!(entrants.size === 0)) return [3 /*break*/, 10];
                    return [4 /*yield*/, channel.send("The giveaway for **".concat(giveaway.prize, "** ended with no entries."))];
                case 8:
                    _a.sent();
                    return [4 /*yield*/, db.execute('UPDATE giveaways SET is_active = 0 WHERE id = ?', [giveaway.id])];
                case 9:
                    _a.sent();
                    logger_1.default.info("Giveaway ".concat(giveaway.id, " ended with no valid entries."), { guildId: guildId, category: 'giveaway' });
                    return [2 /*return*/];
                case 10:
                    winners = entrants.random(giveaway.winner_count);
                    winnersArray = Array.isArray(winners) ? winners : [winners];
                    winnerMentions = winnersArray.map(function (u) { return u.toString(); }).join(', ');
                    resultMessage = isReroll
                        ? "A new winner has been drawn! Congratulations ".concat(winnerMentions, "!")
                        : "Congratulations ".concat(winnerMentions, "! You won the **").concat(giveaway.prize, "**!");
                    return [4 /*yield*/, channel.send({ content: resultMessage, reply: { messageReference: message } })];
                case 11:
                    _a.sent();
                    endedEmbed = discord_js_1.EmbedBuilder.from(message.embeds[0])
                        .setColor('#95A5A6')
                        .setDescription("Giveaway has ended.\n\n**Winner(s):** ".concat(winnerMentions))
                        .setFields([]);
                    return [4 /*yield*/, message.edit({ embeds: [endedEmbed], components: [] })];
                case 12:
                    _a.sent();
                    // Update the database
                    return [4 /*yield*/, db.execute('UPDATE giveaways SET is_active = 0, winners = ? WHERE id = ?', [JSON.stringify(winnersArray.map(function (u) { return u.id; })), giveaway.id])];
                case 13:
                    // Update the database
                    _a.sent();
                    logger_1.default.info("".concat(isReroll ? 'Rerolled' : 'Ended', " giveaway ").concat(giveaway.id, ". Winners: ").concat(winnersArray.map(function (u) { return u.tag; }).join(', ')), { guildId: guildId, category: 'giveaway' });
                    return [3 /*break*/, 15];
                case 14:
                    error_2 = _a.sent();
                    logger_1.default.error("Error ending giveaway ".concat(giveaway.id, "."), { guildId: guildId, category: 'giveaway', error: error_2.stack });
                    return [3 /*break*/, 15];
                case 15: return [2 /*return*/];
            }
        });
    });
}
