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
exports.isSuperAdmin = isSuperAdmin;
exports.checkSuperAdmin = checkSuperAdmin;
exports.requireSuperAdmin = requireSuperAdmin;
exports.addSuperAdmin = addSuperAdmin;
exports.removeSuperAdmin = removeSuperAdmin;
exports.getAllSuperAdmins = getAllSuperAdmins;
var db_1 = __importDefault(require("./db"));
var logger_1 = __importDefault(require("./logger"));
/**
 * Check if a user is a super admin
 * @param userId - Discord user ID
 * @returns Promise<boolean>
 */
function isSuperAdmin(userId) {
    return __awaiter(this, void 0, void 0, function () {
        var rows, error_1, errorMessage;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!userId)
                        return [2 /*return*/, false];
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, db_1.default.execute('SELECT user_id FROM super_admins WHERE user_id = ?', [userId])];
                case 2:
                    rows = (_a.sent())[0];
                    return [2 /*return*/, rows.length > 0];
                case 3:
                    error_1 = _a.sent();
                    errorMessage = error_1 instanceof Error ? error_1.message : 'Unknown error';
                    logger_1.default.error("[Super Admin] Error checking super admin status for ".concat(userId, ": ").concat(errorMessage));
                    return [2 /*return*/, false];
                case 4: return [2 /*return*/];
            }
        });
    });
}
/**
 * Middleware to check if authenticated user is a super admin
 * Sets req.user.isSuperAdmin = true if they are
 */
function checkSuperAdmin(req, res, next) {
    return __awaiter(this, void 0, void 0, function () {
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!(req.isAuthenticated() && req.user && req.user.id)) return [3 /*break*/, 2];
                    _a = req.user;
                    return [4 /*yield*/, isSuperAdmin(req.user.id)];
                case 1:
                    _a.isSuperAdmin = _b.sent();
                    _b.label = 2;
                case 2:
                    next();
                    return [2 /*return*/];
            }
        });
    });
}
/**
 * Middleware to require super admin access
 */
function requireSuperAdmin(req, res, next) {
    if (!req.isAuthenticated() || !req.user) {
        res.redirect('/auth/discord');
        return;
    }
    if (!req.user.isSuperAdmin) {
        res.status(403).render('error', {
            message: 'Access Denied',
            details: 'You do not have permission to access this page.',
            user: req.user
        });
        return;
    }
    next();
}
/**
 * Add a user as super admin
 * @param userId - Discord user ID to add
 * @param addedBy - Discord user ID of person adding them
 * @param notes - Optional notes
 * @returns Promise<boolean>
 */
function addSuperAdmin(userId_1, addedBy_1) {
    return __awaiter(this, arguments, void 0, function (userId, addedBy, notes) {
        var error_2, errorMessage;
        if (notes === void 0) { notes = ''; }
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, db_1.default.execute('INSERT INTO super_admins (user_id, added_by, notes) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE notes = ?', [userId, addedBy, notes, notes])];
                case 1:
                    _a.sent();
                    logger_1.default.info("[Super Admin] User ".concat(userId, " added as super admin by ").concat(addedBy));
                    return [2 /*return*/, true];
                case 2:
                    error_2 = _a.sent();
                    errorMessage = error_2 instanceof Error ? error_2.message : 'Unknown error';
                    logger_1.default.error("[Super Admin] Error adding super admin ".concat(userId, ": ").concat(errorMessage));
                    return [2 /*return*/, false];
                case 3: return [2 /*return*/];
            }
        });
    });
}
/**
 * Remove a user as super admin
 * @param userId - Discord user ID to remove
 * @returns Promise<boolean>
 */
function removeSuperAdmin(userId) {
    return __awaiter(this, void 0, void 0, function () {
        var error_3, errorMessage;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, db_1.default.execute('DELETE FROM super_admins WHERE user_id = ?', [userId])];
                case 1:
                    _a.sent();
                    logger_1.default.info("[Super Admin] User ".concat(userId, " removed as super admin"));
                    return [2 /*return*/, true];
                case 2:
                    error_3 = _a.sent();
                    errorMessage = error_3 instanceof Error ? error_3.message : 'Unknown error';
                    logger_1.default.error("[Super Admin] Error removing super admin ".concat(userId, ": ").concat(errorMessage));
                    return [2 /*return*/, false];
                case 3: return [2 /*return*/];
            }
        });
    });
}
/**
 * Get all super admins
 * @returns Promise<SuperAdminRow[]>
 */
function getAllSuperAdmins() {
    return __awaiter(this, void 0, void 0, function () {
        var rows, error_4, errorMessage;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, db_1.default.execute('SELECT * FROM super_admins ORDER BY added_at DESC')];
                case 1:
                    rows = (_a.sent())[0];
                    return [2 /*return*/, rows];
                case 2:
                    error_4 = _a.sent();
                    errorMessage = error_4 instanceof Error ? error_4.message : 'Unknown error';
                    logger_1.default.error("[Super Admin] Error fetching super admins: ".concat(errorMessage));
                    return [2 /*return*/, []];
                case 3: return [2 /*return*/];
            }
        });
    });
}
exports.default = {
    isSuperAdmin: isSuperAdmin,
    checkSuperAdmin: checkSuperAdmin,
    requireSuperAdmin: requireSuperAdmin,
    addSuperAdmin: addSuperAdmin,
    removeSuperAdmin: removeSuperAdmin,
    getAllSuperAdmins: getAllSuperAdmins
};
