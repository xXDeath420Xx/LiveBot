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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCycleTLSInstance = getCycleTLSInstance;
exports.exitCycleTLSInstance = exitCycleTLSInstance;
var cycletls_1 = __importDefault(require("cycletls"));
var logger_1 = require("./logger");
var globalCycleTLSInstance = null;
var cycleTLSInitializationPromise = null;
// This module centralizes the creation and management of the global cycleTLS instance
// to prevent circular dependencies and ensure a single, shared instance.
function getCycleTLSInstance() {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            if (globalCycleTLSInstance) {
                return [2 /*return*/, globalCycleTLSInstance];
            }
            if (cycleTLSInitializationPromise) {
                return [2 /*return*/, cycleTLSInitializationPromise];
            }
            logger_1.logger.info('[CycleTLS] Initializing global CycleTLS instance...');
            cycleTLSInitializationPromise = (0, cycletls_1.default)({
                userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.60 Safari/537.36',
                timeout: 60000
            }).then(function (instance) {
                globalCycleTLSInstance = instance;
                cycleTLSInitializationPromise = null;
                logger_1.logger.info('[CycleTLS] Global CycleTLS instance initialized.');
                return instance;
            }).catch(function (error) {
                cycleTLSInitializationPromise = null;
                logger_1.logger.error('[CycleTLS] Error initializing global CycleTLS instance:', error);
                throw error;
            });
            return [2 /*return*/, cycleTLSInitializationPromise];
        });
    });
}
function exitCycleTLSInstance() {
    return __awaiter(this, void 0, void 0, function () {
        var error_1, errorMessage;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!globalCycleTLSInstance) return [3 /*break*/, 4];
                    logger_1.logger.info('[CycleTLS] Exiting global CycleTLS instance...');
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, globalCycleTLSInstance.exit()];
                case 2:
                    _a.sent();
                    globalCycleTLSInstance = null;
                    logger_1.logger.info('[CycleTLS] Global CycleTLS instance exited.');
                    return [3 /*break*/, 4];
                case 3:
                    error_1 = _a.sent();
                    errorMessage = error_1 instanceof Error ? error_1.message : 'Unknown error';
                    logger_1.logger.error('[CycleTLS] Error exiting global CycleTLS instance:', { message: errorMessage });
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/];
            }
        });
    });
}
