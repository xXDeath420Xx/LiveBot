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
exports.setupSystemJobs = setupSystemJobs;
var bullmq_1 = require("bullmq");
var logger_1 = __importDefault(require("../utils/logger"));
var cache_1 = require("../utils/cache");
var TEAM_SYNC_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
var STREAM_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute - check streams frequently for accurate live status
var OLD_STREAM_CHECK_JOB_ID = 'check-all-streams';
var NEW_STREAM_CHECK_JOB_ID = 'check-streamers-recurring';
var TEAM_SYNC_JOB_ID = 'sync-all-teams';
var systemQueue = new bullmq_1.Queue('system-tasks', { connection: cache_1.redisOptions });
function setupSystemJobs() {
    return __awaiter(this, void 0, void 0, function () {
        var repeatableJobs, _i, repeatableJobs_1, job, streamCheckJob, teamSyncJob, error_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    logger_1.default.info('[Scheduler] Setting up system jobs and cleaning up old ones...');
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 13, , 14]);
                    return [4 /*yield*/, systemQueue.getRepeatableJobs()];
                case 2:
                    repeatableJobs = _a.sent();
                    _i = 0, repeatableJobs_1 = repeatableJobs;
                    _a.label = 3;
                case 3:
                    if (!(_i < repeatableJobs_1.length)) return [3 /*break*/, 6];
                    job = repeatableJobs_1[_i];
                    if (!(job.id === OLD_STREAM_CHECK_JOB_ID || job.name === 'check-streams')) return [3 /*break*/, 5];
                    return [4 /*yield*/, systemQueue.removeRepeatableByKey(job.key)];
                case 4:
                    _a.sent();
                    logger_1.default.warn("[Scheduler] Found and removed obsolete job '".concat(job.name, "' (ID: ").concat(job.id, ")."));
                    _a.label = 5;
                case 5:
                    _i++;
                    return [3 /*break*/, 3];
                case 6:
                    streamCheckJob = repeatableJobs.find(function (job) { return job.id === NEW_STREAM_CHECK_JOB_ID; });
                    if (!!streamCheckJob) return [3 /*break*/, 8];
                    return [4 /*yield*/, systemQueue.add('check-streamers', {}, {
                            jobId: NEW_STREAM_CHECK_JOB_ID,
                            repeat: {
                                every: STREAM_CHECK_INTERVAL_MS,
                            },
                            removeOnComplete: true,
                            removeOnFail: 10,
                        })];
                case 7:
                    _a.sent();
                    logger_1.default.info("[Scheduler] Repeatable job '".concat(NEW_STREAM_CHECK_JOB_ID, "' scheduled (every ").concat(STREAM_CHECK_INTERVAL_MS / 1000, "s)."));
                    return [3 /*break*/, 9];
                case 8:
                    logger_1.default.info("[Scheduler] Stream check job already scheduled.");
                    _a.label = 9;
                case 9:
                    teamSyncJob = repeatableJobs.find(function (job) { return job.id === TEAM_SYNC_JOB_ID; });
                    if (!!teamSyncJob) return [3 /*break*/, 11];
                    return [4 /*yield*/, systemQueue.add('sync-teams', {}, {
                            jobId: TEAM_SYNC_JOB_ID,
                            repeat: {
                                every: TEAM_SYNC_INTERVAL_MS,
                            },
                            removeOnComplete: true,
                            removeOnFail: 10,
                        })];
                case 10:
                    _a.sent();
                    logger_1.default.info("[Scheduler] Repeatable job '".concat(TEAM_SYNC_JOB_ID, "' scheduled."));
                    return [3 /*break*/, 12];
                case 11:
                    logger_1.default.info("[Scheduler] Team sync job already scheduled.");
                    _a.label = 12;
                case 12: return [3 /*break*/, 14];
                case 13:
                    error_1 = _a.sent();
                    logger_1.default.error('[Scheduler] Failed during system job setup:', { error: error_1.stack });
                    return [3 /*break*/, 14];
                case 14: return [2 /*return*/];
            }
        });
    });
}
// Initialize scheduler on startup
setupSystemJobs().catch(function (error) {
    logger_1.default.error('[Scheduler] Fatal error during initialization:', { error: error.stack });
    process.exit(1);
});
