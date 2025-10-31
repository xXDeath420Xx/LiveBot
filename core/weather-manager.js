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
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
var axios_1 = require("axios");
var db_1 = require("../utils/db");
var logger_1 = require("../utils/logger");
var discord_js_1 = require("discord.js");
var WeatherManager = /** @class */ (function () {
    function WeatherManager(client) {
        this.client = client;
        this.processedAlerts = new Set();
        this.checkInterval = null;
        // Alert type to color mapping
        this.alertColors = {
            'Tornado Watch': 0xFFCC00,
            'Tornado Warning': 0xFF0000,
            'Severe Thunderstorm Watch': 0xFFAA00,
            'Severe Thunderstorm Warning': 0xFF6600,
            'Tropical Storm Watch': 0x00AAFF,
            'Tropical Storm Warning': 0x0077FF,
            'Hurricane Watch': 0xFF00AA,
            'Hurricane Warning': 0xAA0000,
            'Flash Flood Watch': 0x00FF00,
            'Flash Flood Warning': 0x00AA00,
            'Winter Storm Watch': 0xAACCFF,
            'Winter Storm Warning': 0x6699FF,
            'Blizzard Warning': 0x0000FF
        };
    }
    WeatherManager.prototype.start = function () {
        return __awaiter(this, arguments, void 0, function (intervalSeconds) {
            var _this = this;
            if (intervalSeconds === void 0) { intervalSeconds = 60; }
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (this.checkInterval) {
                            logger_1.default.warn('[WeatherManager] Weather checker already running');
                            return [2 /*return*/];
                        }
                        logger_1.default.info("[WeatherManager] Starting weather alert checker (interval: ".concat(intervalSeconds, "s)"));
                        // Check immediately
                        return [4 /*yield*/, this.checkAlerts()];
                    case 1:
                        // Check immediately
                        _a.sent();
                        // Then check on interval
                        this.checkInterval = setInterval(function () { return _this.checkAlerts(); }, intervalSeconds * 1000);
                        return [2 /*return*/];
                }
            });
        });
    };
    WeatherManager.prototype.stop = function () {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
            logger_1.default.info('[WeatherManager] Stopped weather alert checker');
        }
    };
    WeatherManager.prototype.checkAlerts = function () {
        return __awaiter(this, void 0, void 0, function () {
            var response, alerts, _i, alerts_1, alert_1, alertsArray, error_1;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 6, , 7]);
                        return [4 /*yield*/, axios_1.default.get('https://api.weather.gov/alerts/active', {
                                headers: {
                                    'User-Agent': 'CertiFriedMultitool Discord Bot',
                                    'Accept': 'application/geo+json'
                                },
                                timeout: 10000
                            })];
                    case 1:
                        response = _a.sent();
                        alerts = response.data.features || [];
                        logger_1.default.info("[WeatherManager] Fetched ".concat(alerts.length, " active alerts"));
                        _i = 0, alerts_1 = alerts;
                        _a.label = 2;
                    case 2:
                        if (!(_i < alerts_1.length)) return [3 /*break*/, 5];
                        alert_1 = alerts_1[_i];
                        return [4 /*yield*/, this.processAlert(alert_1)];
                    case 3:
                        _a.sent();
                        _a.label = 4;
                    case 4:
                        _i++;
                        return [3 /*break*/, 2];
                    case 5:
                        // Clean old alerts from memory (keep last 1000)
                        if (this.processedAlerts.size > 1000) {
                            alertsArray = Array.from(this.processedAlerts);
                            this.processedAlerts = new Set(alertsArray.slice(-500));
                        }
                        return [3 /*break*/, 7];
                    case 6:
                        error_1 = _a.sent();
                        logger_1.default.error("[WeatherManager] Error fetching weather alerts: ".concat(error_1.message));
                        return [3 /*break*/, 7];
                    case 7: return [2 /*return*/];
                }
            });
        });
    };
    WeatherManager.prototype.processAlert = function (alert) {
        return __awaiter(this, void 0, void 0, function () {
            var id, properties, event_1, severity, headline, areaDesc, description, instruction, expires, link, ugcs, affectedUsers, error_2;
            var _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        _b.trys.push([0, 4, , 5]);
                        id = alert.id;
                        properties = alert.properties;
                        event_1 = properties.event;
                        severity = properties.severity;
                        headline = properties.headline;
                        areaDesc = properties.areaDesc;
                        description = properties.description;
                        instruction = properties.instruction;
                        expires = properties.expires;
                        link = properties.uri || "https://api.weather.gov/alerts/".concat(id);
                        ugcs = ((_a = properties.geocode) === null || _a === void 0 ? void 0 : _a.UGC) || [];
                        // Skip if we've already processed this alert
                        if (this.processedAlerts.has(id)) {
                            return [2 /*return*/];
                        }
                        // Only process alerts we care about
                        if (!Object.keys(this.alertColors).includes(event_1)) {
                            return [2 /*return*/];
                        }
                        this.processedAlerts.add(id);
                        // Save to database
                        return [4 /*yield*/, db_1.default.execute("INSERT INTO weather_alerts (alert_id, event, severity, headline, areas, description, instruction, expires_at, link, timestamp)\n                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())\n                 ON DUPLICATE KEY UPDATE event = VALUES(event)", [id, event_1, severity, headline, areaDesc, description, instruction, expires ? new Date(expires) : null, link])];
                    case 1:
                        // Save to database
                        _b.sent();
                        return [4 /*yield*/, this.getUsersInZones(ugcs)];
                    case 2:
                        affectedUsers = _b.sent();
                        // Send alerts to configured channels
                        return [4 /*yield*/, this.sendAlertNotifications(event_1, {
                                id: id,
                                severity: severity,
                                headline: headline,
                                areaDesc: areaDesc,
                                description: description,
                                instruction: instruction,
                                expires: expires,
                                link: link
                            }, affectedUsers)];
                    case 3:
                        // Send alerts to configured channels
                        _b.sent();
                        logger_1.default.info("[WeatherManager] Processed alert: ".concat(event_1, " - ").concat(headline));
                        return [3 /*break*/, 5];
                    case 4:
                        error_2 = _b.sent();
                        logger_1.default.error("[WeatherManager] Error processing alert: ".concat(error_2.message));
                        return [3 /*break*/, 5];
                    case 5: return [2 /*return*/];
                }
            });
        });
    };
    WeatherManager.prototype.getUsersInZones = function (ugcs) {
        return __awaiter(this, void 0, void 0, function () {
            var placeholders, users, error_3;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!ugcs || ugcs.length === 0) {
                            return [2 /*return*/, []];
                        }
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        placeholders = ugcs.map(function () { return '?'; }).join(',');
                        return [4 /*yield*/, db_1.default.execute("SELECT DISTINCT user_id FROM user_alert_zones WHERE zone_code IN (".concat(placeholders, ")"), __spreadArray([], ugcs, true))];
                    case 2:
                        users = (_a.sent())[0];
                        return [2 /*return*/, users.map(function (u) { return u.user_id; })];
                    case 3:
                        error_3 = _a.sent();
                        logger_1.default.error("[WeatherManager] Error getting users in zones: ".concat(error_3.message));
                        return [2 /*return*/, []];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    WeatherManager.prototype.sendAlertNotifications = function (eventType, alertData, affectedUsers) {
        return __awaiter(this, void 0, void 0, function () {
            var configs, _loop_1, this_1, _i, configs_1, guild_id, error_4;
            var _a, _b;
            return __generator(this, function (_c) {
                switch (_c.label) {
                    case 0:
                        _c.trys.push([0, 6, , 7]);
                        return [4 /*yield*/, db_1.default.execute('SELECT guild_id FROM weather_config WHERE enabled = TRUE')];
                    case 1:
                        configs = (_c.sent())[0];
                        _loop_1 = function (guild_id) {
                            var guild, channel, guildAffectedUsers, embed, mentions;
                            return __generator(this, function (_d) {
                                switch (_d.label) {
                                    case 0: return [4 /*yield*/, this_1.client.guilds.fetch(guild_id).catch(function () { return null; })];
                                    case 1:
                                        guild = _d.sent();
                                        if (!guild)
                                            return [2 /*return*/, "continue"];
                                        channel = guild.channels.cache.find(function (ch) {
                                            return ch.isTextBased() && (ch.name.includes('weather') ||
                                                ch.name.includes('alert') ||
                                                ch.name.includes('emergency') ||
                                                ch.name === 'general');
                                        });
                                        if (!channel)
                                            return [2 /*return*/, "continue"];
                                        guildAffectedUsers = affectedUsers.filter(function (userId) {
                                            var member = guild.members.cache.get(userId);
                                            return member !== undefined;
                                        });
                                        embed = new discord_js_1.EmbedBuilder()
                                            .setTitle("\u26A0\uFE0F ".concat(eventType))
                                            .setDescription(alertData.headline || ((_b = (_a = alertData.description) === null || _a === void 0 ? void 0 : _a.slice(0, 1500)) !== null && _b !== void 0 ? _b : 'No description provided'))
                                            .addFields({ name: 'Areas Affected', value: alertData.areaDesc || 'Unknown' }, { name: 'Severity', value: alertData.severity || 'N/A', inline: true }, { name: 'Expires', value: alertData.expires ? "<t:".concat(Math.floor(new Date(alertData.expires).getTime() / 1000), ":R>") : 'Unknown', inline: true })
                                            .setColor(this_1.alertColors[eventType] || 0xFFAA00)
                                            .setURL(alertData.link || 'https://www.weather.gov')
                                            .setFooter({ text: 'National Weather Service' })
                                            .setTimestamp();
                                        if (alertData.instruction) {
                                            embed.addFields({ name: 'Instructions', value: alertData.instruction.slice(0, 1024) });
                                        }
                                        mentions = guildAffectedUsers.length > 0
                                            ? guildAffectedUsers.map(function (id) { return "<@".concat(id, ">"); }).join(' ')
                                            : undefined;
                                        return [4 /*yield*/, channel.send({
                                                content: mentions,
                                                embeds: [embed]
                                            })];
                                    case 2:
                                        _d.sent();
                                        return [2 /*return*/];
                                }
                            });
                        };
                        this_1 = this;
                        _i = 0, configs_1 = configs;
                        _c.label = 2;
                    case 2:
                        if (!(_i < configs_1.length)) return [3 /*break*/, 5];
                        guild_id = configs_1[_i].guild_id;
                        return [5 /*yield**/, _loop_1(guild_id)];
                    case 3:
                        _c.sent();
                        _c.label = 4;
                    case 4:
                        _i++;
                        return [3 /*break*/, 2];
                    case 5: return [3 /*break*/, 7];
                    case 6:
                        error_4 = _c.sent();
                        logger_1.default.error("[WeatherManager] Error sending alert notifications: ".concat(error_4.message));
                        return [3 /*break*/, 7];
                    case 7: return [2 /*return*/];
                }
            });
        });
    };
    WeatherManager.prototype.setUserLocation = function (userId, zipCode) {
        return __awaiter(this, void 0, void 0, function () {
            var zipInfo, place, latitude, longitude, city, state, pointData, zoneId, countyId, error_5;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 4, , 5]);
                        // Validate ZIP code format
                        if (!/^[0-9]{5}$/.test(zipCode)) {
                            throw new Error('Invalid ZIP code format. Use 5-digit US ZIP only.');
                        }
                        return [4 /*yield*/, axios_1.default.get("https://api.zippopotam.us/us/".concat(zipCode), { timeout: 5000 })];
                    case 1:
                        zipInfo = _a.sent();
                        place = zipInfo.data.places[0];
                        latitude = place.latitude;
                        longitude = place.longitude;
                        city = place['place name'];
                        state = place['state abbreviation'];
                        return [4 /*yield*/, axios_1.default.get("https://api.weather.gov/points/".concat(latitude, ",").concat(longitude), {
                                headers: {
                                    'User-Agent': 'CertiFriedMultitool Discord Bot',
                                    'Accept': 'application/geo+json'
                                },
                                timeout: 5000
                            })];
                    case 2:
                        pointData = _a.sent();
                        zoneId = pointData.data.properties.forecastZone.split('/').pop();
                        countyId = pointData.data.properties.county.split('/').pop();
                        // Save to database
                        return [4 /*yield*/, db_1.default.execute("REPLACE INTO user_alert_zones (user_id, guild_id, zone_code, zone_name)\n                 VALUES (?, ?, ?, ?)", [userId, userId, zoneId, "".concat(city, ", ").concat(state)])];
                    case 3:
                        // Save to database
                        _a.sent();
                        logger_1.default.info("[WeatherManager] Set location for user ".concat(userId, ": ").concat(city, ", ").concat(state, " (").concat(zoneId, ")"));
                        return [2 /*return*/, { zoneId: zoneId, countyId: countyId, city: city, state: state }];
                    case 4:
                        error_5 = _a.sent();
                        logger_1.default.error("[WeatherManager] Error setting user location: ".concat(error_5.message));
                        throw error_5;
                    case 5: return [2 /*return*/];
                }
            });
        });
    };
    WeatherManager.prototype.getUserLocation = function (userId) {
        return __awaiter(this, void 0, void 0, function () {
            var rows, error_6;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 2, , 3]);
                        return [4 /*yield*/, db_1.default.execute('SELECT zone_code, zone_name FROM user_alert_zones WHERE user_id = ?', [userId])];
                    case 1:
                        rows = (_a.sent())[0];
                        return [2 /*return*/, rows[0] || null];
                    case 2:
                        error_6 = _a.sent();
                        logger_1.default.error("[WeatherManager] Error getting user location: ".concat(error_6.message));
                        return [2 /*return*/, null];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    WeatherManager.prototype.removeUserLocation = function (userId) {
        return __awaiter(this, void 0, void 0, function () {
            var error_7;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 2, , 3]);
                        return [4 /*yield*/, db_1.default.execute('DELETE FROM user_alert_zones WHERE user_id = ?', [userId])];
                    case 1:
                        _a.sent();
                        logger_1.default.info("[WeatherManager] Removed location for user ".concat(userId));
                        return [2 /*return*/, true];
                    case 2:
                        error_7 = _a.sent();
                        logger_1.default.error("[WeatherManager] Error removing user location: ".concat(error_7.message));
                        return [2 /*return*/, false];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    WeatherManager.prototype.configureGuild = function (guildId_1) {
        return __awaiter(this, arguments, void 0, function (guildId, enabled, checkInterval) {
            var error_8;
            if (enabled === void 0) { enabled = true; }
            if (checkInterval === void 0) { checkInterval = 60; }
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        _a.trys.push([0, 2, , 3]);
                        return [4 /*yield*/, db_1.default.execute("INSERT INTO weather_config (guild_id, enabled, check_interval)\n                 VALUES (?, ?, ?)\n                 ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), check_interval = VALUES(check_interval)", [guildId, enabled, checkInterval])];
                    case 1:
                        _a.sent();
                        logger_1.default.info("[WeatherManager] Configured weather for guild ".concat(guildId, ": enabled=").concat(enabled));
                        return [2 /*return*/, true];
                    case 2:
                        error_8 = _a.sent();
                        logger_1.default.error("[WeatherManager] Error configuring guild: ".concat(error_8.message));
                        return [2 /*return*/, false];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    return WeatherManager;
}());
exports.default = WeatherManager;
