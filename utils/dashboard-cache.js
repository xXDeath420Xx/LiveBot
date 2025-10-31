"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
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
exports.getCacheStats = getCacheStats;
exports.getCacheHitRate = getCacheHitRate;
exports.getCachedOrFetch = getCachedOrFetch;
exports.invalidateCache = invalidateCache;
exports.invalidateGuildCache = invalidateGuildCache;
exports.invalidateCacheType = invalidateCacheType;
exports.getCachedManagePageData = getCachedManagePageData;
exports.getCachedGuildStructure = getCachedGuildStructure;
exports.getCachedUserData = getCachedUserData;
exports.getCachedStatistics = getCachedStatistics;
exports.warmGuildCache = warmGuildCache;
exports.createCacheInvalidationMiddleware = createCacheInvalidationMiddleware;
var cache_1 = require("./cache");
var logger_1 = require("./logger");
var CACHE_CONFIGS = {
    // Page data cache - moderate TTL, frequently invalidated
    pageData: {
        ttl: 120, // 2 minutes - increased for better performance
        prefix: 'dashboard:page:',
        invalidateOn: ['config:*', 'subscription:*', 'guild:*']
    },
    // Static data cache - longer TTL, rarely changes
    staticData: {
        ttl: 300, // 5 minutes
        prefix: 'dashboard:static:',
        invalidateOn: ['guild:structure']
    },
    // User data cache - short TTL for accuracy
    userData: {
        ttl: 30,
        prefix: 'dashboard:user:',
        invalidateOn: ['user:*']
    },
    // Statistics cache - moderate TTL
    statistics: {
        ttl: 60,
        prefix: 'dashboard:stats:',
        invalidateOn: ['stats:*']
    },
    // Economy data cache - short TTL for transactions
    economy: {
        ttl: 20,
        prefix: 'dashboard:economy:',
        invalidateOn: ['economy:*', 'transaction:*']
    }
};
// ============================================================================
// CACHE KEY GENERATION
// ============================================================================
function generateCacheKey(type, identifier) {
    var parts = [];
    for (var _i = 2; _i < arguments.length; _i++) {
        parts[_i - 2] = arguments[_i];
    }
    var config = CACHE_CONFIGS[type];
    if (!config) {
        logger_1.logger.warn("[Dashboard Cache] Unknown cache type: ".concat(type));
        return "dashboard:unknown:".concat(identifier, ":").concat(parts.join(':'));
    }
    var key = __spreadArray([config.prefix + identifier], parts, true).filter(Boolean).join(':');
    return key;
}
var cacheStats = new Map();
function recordHit(type) {
    var stats = cacheStats.get(type) || { hits: 0, misses: 0, errors: 0, invalidations: 0 };
    stats.hits++;
    stats.lastHit = new Date();
    cacheStats.set(type, stats);
}
function recordMiss(type) {
    var stats = cacheStats.get(type) || { hits: 0, misses: 0, errors: 0, invalidations: 0 };
    stats.misses++;
    stats.lastMiss = new Date();
    cacheStats.set(type, stats);
}
function recordError(type) {
    var stats = cacheStats.get(type) || { hits: 0, misses: 0, errors: 0, invalidations: 0 };
    stats.errors++;
    cacheStats.set(type, stats);
}
function recordInvalidation(type) {
    var stats = cacheStats.get(type) || { hits: 0, misses: 0, errors: 0, invalidations: 0 };
    stats.invalidations++;
    cacheStats.set(type, stats);
}
function getCacheStats() {
    var result = {};
    cacheStats.forEach(function (stats, type) {
        result[type] = __assign({}, stats);
    });
    return result;
}
function getCacheHitRate(type) {
    if (type) {
        var stats = cacheStats.get(type);
        if (!stats || (stats.hits + stats.misses) === 0)
            return 0;
        return (stats.hits / (stats.hits + stats.misses)) * 100;
    }
    // Overall hit rate
    var totalHits = 0;
    var totalMisses = 0;
    cacheStats.forEach(function (stats) {
        totalHits += stats.hits;
        totalMisses += stats.misses;
    });
    if ((totalHits + totalMisses) === 0)
        return 0;
    return (totalHits / (totalHits + totalMisses)) * 100;
}
// ============================================================================
// CORE CACHE OPERATIONS
// ============================================================================
/**
 * Get data from cache or execute the provided function and cache the result
 */
function getCachedOrFetch(type, identifier, fetchFunction, options) {
    return __awaiter(this, void 0, void 0, function () {
        var cacheKey, cached, error_1, data, config, ttl, error_2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!(options === null || options === void 0 ? void 0 : options.skipCache)) return [3 /*break*/, 2];
                    return [4 /*yield*/, fetchFunction()];
                case 1: return [2 /*return*/, _a.sent()];
                case 2:
                    cacheKey = generateCacheKey.apply(void 0, __spreadArray([type, identifier], ((options === null || options === void 0 ? void 0 : options.parts) || []), false));
                    _a.label = 3;
                case 3:
                    _a.trys.push([3, 5, , 6]);
                    return [4 /*yield*/, (0, cache_1.getCache)(cacheKey)];
                case 4:
                    cached = _a.sent();
                    if (cached !== null) {
                        recordHit(type);
                        logger_1.logger.debug("[Dashboard Cache] Cache hit for ".concat(type, ":").concat(identifier));
                        return [2 /*return*/, JSON.parse(cached)];
                    }
                    recordMiss(type);
                    logger_1.logger.debug("[Dashboard Cache] Cache miss for ".concat(type, ":").concat(identifier));
                    return [3 /*break*/, 6];
                case 5:
                    error_1 = _a.sent();
                    recordError(type);
                    logger_1.logger.error("[Dashboard Cache] Error reading cache for ".concat(type, ":").concat(identifier), {
                        error: error_1.message,
                        stack: error_1.stack
                    });
                    return [3 /*break*/, 6];
                case 6: return [4 /*yield*/, fetchFunction()];
                case 7:
                    data = _a.sent();
                    _a.label = 8;
                case 8:
                    _a.trys.push([8, 10, , 11]);
                    config = CACHE_CONFIGS[type];
                    ttl = (options === null || options === void 0 ? void 0 : options.ttl) || (config === null || config === void 0 ? void 0 : config.ttl) || 60;
                    return [4 /*yield*/, (0, cache_1.setCache)(cacheKey, JSON.stringify(data), ttl)];
                case 9:
                    _a.sent();
                    logger_1.logger.debug("[Dashboard Cache] Cached ".concat(type, ":").concat(identifier, " with TTL ").concat(ttl, "s"));
                    return [3 /*break*/, 11];
                case 10:
                    error_2 = _a.sent();
                    recordError(type);
                    logger_1.logger.error("[Dashboard Cache] Error setting cache for ".concat(type, ":").concat(identifier), {
                        error: error_2.message
                    });
                    return [3 /*break*/, 11];
                case 11: return [2 /*return*/, data];
            }
        });
    });
}
/**
 * Invalidate cache entries matching a pattern
 */
function invalidateCache(pattern) {
    return __awaiter(this, void 0, void 0, function () {
        var connection, cursor, deletedCount, matchPattern, _a, newCursor, keys, _i, _b, type, error_3;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _c.trys.push([0, 7, , 8]);
                    return [4 /*yield*/, Promise.resolve().then(function () { return require('./cache'); })];
                case 1:
                    connection = (_c.sent()).connection;
                    cursor = '0';
                    deletedCount = 0;
                    matchPattern = pattern.includes('*') ? pattern : "".concat(pattern, "*");
                    _c.label = 2;
                case 2: return [4 /*yield*/, connection.scan(cursor, 'MATCH', matchPattern, 'COUNT', 100)];
                case 3:
                    _a = _c.sent(), newCursor = _a[0], keys = _a[1];
                    cursor = newCursor;
                    if (!(keys.length > 0)) return [3 /*break*/, 5];
                    return [4 /*yield*/, connection.del.apply(connection, keys)];
                case 4:
                    _c.sent();
                    deletedCount += keys.length;
                    _c.label = 5;
                case 5:
                    if (cursor !== '0') return [3 /*break*/, 2];
                    _c.label = 6;
                case 6:
                    if (deletedCount > 0) {
                        logger_1.logger.info("[Dashboard Cache] Invalidated ".concat(deletedCount, " cache entries matching pattern: ").concat(pattern));
                        // Record invalidation for stats
                        for (_i = 0, _b = Object.keys(CACHE_CONFIGS); _i < _b.length; _i++) {
                            type = _b[_i];
                            recordInvalidation(type);
                        }
                    }
                    return [2 /*return*/, deletedCount];
                case 7:
                    error_3 = _c.sent();
                    logger_1.logger.error("[Dashboard Cache] Error invalidating cache pattern ".concat(pattern), {
                        error: error_3.message,
                        stack: error_3.stack
                    });
                    return [2 /*return*/, 0];
                case 8: return [2 /*return*/];
            }
        });
    });
}
/**
 * Invalidate cache for a specific guild
 */
function invalidateGuildCache(guildId) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, invalidateCache("dashboard:*:".concat(guildId, ":*"))];
                case 1:
                    _a.sent();
                    return [4 /*yield*/, invalidateCache("dashboard:*:".concat(guildId))];
                case 2:
                    _a.sent();
                    logger_1.logger.debug("[Dashboard Cache] Invalidated all cache for guild ".concat(guildId));
                    return [2 /*return*/];
            }
        });
    });
}
/**
 * Invalidate specific cache type for a guild
 */
function invalidateCacheType(type, guildId) {
    return __awaiter(this, void 0, void 0, function () {
        var config;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    config = CACHE_CONFIGS[type];
                    if (!config) {
                        logger_1.logger.warn("[Dashboard Cache] Cannot invalidate unknown cache type: ".concat(type));
                        return [2 /*return*/];
                    }
                    return [4 /*yield*/, invalidateCache("".concat(config.prefix).concat(guildId, "*"))];
                case 1:
                    _a.sent();
                    logger_1.logger.debug("[Dashboard Cache] Invalidated ".concat(type, " cache for guild ").concat(guildId));
                    return [2 /*return*/];
            }
        });
    });
}
// ============================================================================
// SPECIALIZED CACHING FUNCTIONS
// ============================================================================
/**
 * Cache wrapper specifically for getManagePageData
 */
function getCachedManagePageData(guildId_1, page_1, fetchFunction_1) {
    return __awaiter(this, arguments, void 0, function (guildId, page, fetchFunction, skipCache) {
        if (skipCache === void 0) { skipCache = false; }
        return __generator(this, function (_a) {
            return [2 /*return*/, getCachedOrFetch('pageData', guildId, fetchFunction, {
                    parts: [page],
                    skipCache: skipCache
                })];
        });
    });
}
/**
 * Cache wrapper for roles and channels (static Discord data)
 */
function getCachedGuildStructure(guildId, fetchFunction) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, getCachedOrFetch('staticData', guildId, fetchFunction, {
                    parts: ['structure']
                })];
        });
    });
}
/**
 * Cache wrapper for user-specific data
 */
function getCachedUserData(guildId, userId, dataType, fetchFunction) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, getCachedOrFetch('userData', guildId, fetchFunction, {
                    parts: [userId, dataType]
                })];
        });
    });
}
/**
 * Cache wrapper for statistics
 */
function getCachedStatistics(guildId, statType, fetchFunction) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            return [2 /*return*/, getCachedOrFetch('statistics', guildId, fetchFunction, {
                    parts: [statType]
                })];
        });
    });
}
// ============================================================================
// CACHE WARMING
// ============================================================================
/**
 * Pre-warm cache for a guild by loading common pages
 */
function warmGuildCache(guildId, botGuild, getManagePageDataFn) {
    return __awaiter(this, void 0, void 0, function () {
        var error_4;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    logger_1.logger.info("[Dashboard Cache] Warming cache for guild ".concat(guildId));
                    // Load the main page data to warm the cache
                    return [4 /*yield*/, getCachedManagePageData(guildId, 'streamers', function () { return getManagePageDataFn(guildId, botGuild); })];
                case 1:
                    // Load the main page data to warm the cache
                    _a.sent();
                    logger_1.logger.info("[Dashboard Cache] Cache warmed for guild ".concat(guildId));
                    return [3 /*break*/, 3];
                case 2:
                    error_4 = _a.sent();
                    logger_1.logger.error("[Dashboard Cache] Error warming cache for guild ".concat(guildId), {
                        error: error_4.message
                    });
                    return [3 /*break*/, 3];
                case 3: return [2 /*return*/];
            }
        });
    });
}
// ============================================================================
// MIDDLEWARE FOR AUTOMATIC CACHE INVALIDATION
// ============================================================================
/**
 * Middleware to invalidate cache after POST operations
 */
function createCacheInvalidationMiddleware() {
    var _this = this;
    return function (req, res, next) { return __awaiter(_this, void 0, void 0, function () {
        var originalJson, originalRedirect, invalidateIfNeeded;
        var _this = this;
        return __generator(this, function (_a) {
            originalJson = res.json.bind(res);
            originalRedirect = res.redirect.bind(res);
            invalidateIfNeeded = function () { return __awaiter(_this, void 0, void 0, function () {
                var guildId;
                var _a;
                return __generator(this, function (_b) {
                    switch (_b.label) {
                        case 0:
                            if (!['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) return [3 /*break*/, 2];
                            guildId = (_a = req.params) === null || _a === void 0 ? void 0 : _a.guildId;
                            if (!guildId) return [3 /*break*/, 2];
                            return [4 /*yield*/, invalidateGuildCache(guildId)];
                        case 1:
                            _b.sent();
                            _b.label = 2;
                        case 2: return [2 /*return*/];
                    }
                });
            }); };
            // Override json response
            res.json = function (data) {
                invalidateIfNeeded().finally(function () {
                    originalJson(data);
                });
            };
            // Override redirect
            res.redirect = function () {
                var args = [];
                for (var _i = 0; _i < arguments.length; _i++) {
                    args[_i] = arguments[_i];
                }
                invalidateIfNeeded().finally(function () {
                    originalRedirect.apply(void 0, args);
                });
            };
            next();
            return [2 /*return*/];
        });
    }); };
}
// ============================================================================
// EXPORTS
// ============================================================================
exports.default = {
    getCachedOrFetch: getCachedOrFetch,
    getCachedManagePageData: getCachedManagePageData,
    getCachedGuildStructure: getCachedGuildStructure,
    getCachedUserData: getCachedUserData,
    getCachedStatistics: getCachedStatistics,
    invalidateCache: invalidateCache,
    invalidateGuildCache: invalidateGuildCache,
    invalidateCacheType: invalidateCacheType,
    warmGuildCache: warmGuildCache,
    createCacheInvalidationMiddleware: createCacheInvalidationMiddleware,
    getCacheStats: getCacheStats,
    getCacheHitRate: getCacheHitRate
};
