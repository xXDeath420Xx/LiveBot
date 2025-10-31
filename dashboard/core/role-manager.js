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
exports.processRole = processRole;
exports.handleReactionAdd = handleReactionAdd;
exports.handleReactionRemove = handleReactionRemove;
exports.cleanupInvalidRole = cleanupInvalidRole;
var db_1 = __importDefault(require("../utils/db"));
var logger_1 = __importDefault(require("../utils/logger"));
function processRole(member, roleIds, action, guildId) {
    return __awaiter(this, void 0, void 0, function () {
        var rolesToProcess, _i, roleIds_1, roleId, role, clientMember, clientRole, isEditable, roleNames, rolesToAdd, rolesToRemove, error_1, errorMessage;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!member || !member.guild) {
                        logger_1.default.warn("Invalid or partial member object passed to processRole for guild ".concat(guildId, ". Aborting role action."), { guildId: guildId, category: 'role-manager' });
                        return [2 /*return*/];
                    }
                    if (!roleIds || roleIds.length === 0)
                        return [2 /*return*/];
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 12, , 13]);
                    rolesToProcess = [];
                    _i = 0, roleIds_1 = roleIds;
                    _a.label = 2;
                case 2:
                    if (!(_i < roleIds_1.length)) return [3 /*break*/, 6];
                    roleId = roleIds_1[_i];
                    return [4 /*yield*/, member.guild.roles.fetch(roleId).catch(function () { return null; })];
                case 3:
                    role = _a.sent();
                    if (!role) {
                        logger_1.default.warn("Role ".concat(roleId, " not found in guild ").concat(guildId, ". It may have been deleted. Triggering cleanup."), { guildId: guildId, category: 'role-manager' });
                        cleanupInvalidRole(guildId, roleId);
                        return [3 /*break*/, 5];
                    }
                    return [4 /*yield*/, member.guild.members.fetch(member.guild.client.user.id).catch(function () { return null; })];
                case 4:
                    clientMember = _a.sent();
                    if (!clientMember) {
                        logger_1.default.warn("Could not find bot's member object in guild ".concat(guildId, ". Cannot process roles."), { guildId: guildId, category: 'role-manager' });
                        return [3 /*break*/, 5];
                    }
                    clientRole = clientMember.roles.highest;
                    logger_1.default.info("[RoleManager Debug] Checking role: ".concat(role.name, " (").concat(role.id, ") in guild ").concat(guildId), {
                        guildId: guildId,
                        category: 'role-manager',
                        targetRole: {
                            name: role.name,
                            id: role.id,
                            managed: role.managed,
                            position: role.position
                        },
                        botRole: {
                            name: clientRole.name,
                            id: clientRole.id,
                            position: clientRole.position
                        },
                        compareResult: clientRole.comparePositionTo(role),
                        botHighestRoleName: clientRole.name, // Added for clarity
                        botHighestRolePosition: clientRole.position // Added for clarity
                    });
                    isEditable = !role.managed && clientRole.comparePositionTo(role) > 0;
                    if (isEditable) {
                        rolesToProcess.push(role);
                    }
                    else {
                        logger_1.default.warn("Role ".concat(role.name, " (").concat(role.id, ") is not editable in guild ").concat(guildId, ". It's either managed or higher than the bot's highest role."), { guildId: guildId, category: 'role-manager' });
                    }
                    _a.label = 5;
                case 5:
                    _i++;
                    return [3 /*break*/, 2];
                case 6:
                    if (rolesToProcess.length === 0) {
                        return [2 /*return*/];
                    }
                    roleNames = rolesToProcess.map(function (r) { return r.name; }).join(', ');
                    if (!(action === 'add')) return [3 /*break*/, 9];
                    rolesToAdd = rolesToProcess.filter(function (role) { return !member.roles.cache.has(role.id); });
                    if (!(rolesToAdd.length > 0)) return [3 /*break*/, 8];
                    return [4 /*yield*/, member.roles.add(rolesToAdd, 'LiveBot Role Management: User went live')];
                case 7:
                    _a.sent();
                    logger_1.default.info("Successfully added roles [".concat(roleNames, "] to ").concat(member.user.tag, "."), { guildId: guildId, category: 'role-manager' });
                    _a.label = 8;
                case 8: return [3 /*break*/, 11];
                case 9:
                    if (!(action === 'remove')) return [3 /*break*/, 11];
                    rolesToRemove = rolesToProcess.filter(function (role) { return member.roles.cache.has(role.id); });
                    if (!(rolesToRemove.length > 0)) return [3 /*break*/, 11];
                    return [4 /*yield*/, member.roles.remove(rolesToRemove, 'LiveBot Role Management: User is no longer live')];
                case 10:
                    _a.sent();
                    logger_1.default.info("Successfully removed roles [".concat(roleNames, "] from ").concat(member.user.tag, "."), { guildId: guildId, category: 'role-manager' });
                    _a.label = 11;
                case 11: return [3 /*break*/, 13];
                case 12:
                    error_1 = _a.sent();
                    if (error_1.code === 10007) { // Unknown Member
                        logger_1.default.warn("Failed to process roles for user ".concat(member.id, " as they are no longer in the guild."), { guildId: guildId, category: 'role-manager' });
                    }
                    else if (error_1.code === 50013) { // Missing Permissions
                        logger_1.default.error("Missing Permissions to process roles for ".concat(member.user.tag, " in guild ").concat(guildId, "."), { guildId: guildId, category: 'role-manager', error: 'Check bot role hierarchy and permissions.' });
                    }
                    else {
                        errorMessage = error_1 instanceof Error ? error_1.stack : String(error_1);
                        logger_1.default.error("An unexpected error occurred while processing roles for ".concat(member.user.tag, "."), { guildId: guildId, category: 'role-manager', error: errorMessage });
                    }
                    return [3 /*break*/, 13];
                case 13: return [2 /*return*/];
            }
        });
    });
}
function cleanupInvalidRole(guildId, roleId) {
    return __awaiter(this, void 0, void 0, function () {
        var error_2, errorMessage;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!guildId || !roleId)
                        return [2 /*return*/];
                    logger_1.default.warn("[RoleCleanup] Purging invalid role ".concat(roleId, " from all configurations for guild ").concat(guildId, "."), { guildId: guildId, category: 'role-manager' });
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 5, , 6]);
                    return [4 /*yield*/, db_1.default.execute("UPDATE guilds SET live_role_id = NULL WHERE guild_id = ? AND live_role_id = ?", [guildId, roleId])];
                case 2:
                    _a.sent();
                    return [4 /*yield*/, db_1.default.execute("UPDATE twitch_teams SET live_role_id = NULL WHERE guild_id = ? AND live_role_id = ?", [guildId, roleId])];
                case 3:
                    _a.sent();
                    return [4 /*yield*/, db_1.default.execute("UPDATE subscriptions SET live_role_id = NULL WHERE guild_id = ? AND live_role_id = ?", [guildId, roleId])];
                case 4:
                    _a.sent();
                    logger_1.default.info("[RoleCleanup] Successfully purged invalid role ".concat(roleId, " for guild ").concat(guildId, "."), { guildId: guildId, category: 'role-manager' });
                    return [3 /*break*/, 6];
                case 5:
                    error_2 = _a.sent();
                    errorMessage = _error instanceof Error ? _error.stack : String(_error);
                    logger_1.default.error("[RoleCleanup] Failed to purge invalid role ".concat(roleId, " for guild ").concat(guildId, ":"), { guildId: guildId, category: 'role-manager', error: errorMessage });
                    return [3 /*break*/, 6];
                case 6: return [2 /*return*/];
            }
        });
    });
}
function handleReactionAdd(reaction, user) {
    return __awaiter(this, void 0, void 0, function () {
        var message, guildId, panel, emojiIdentifier, mapping, member, role_1, allMappings, rolesOnPanel_1, rolesToRemove, error_3, errorMessage;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!reaction.message.partial) return [3 /*break*/, 2];
                    return [4 /*yield*/, reaction.message.fetch()];
                case 1:
                    _b.sent();
                    _b.label = 2;
                case 2:
                    if (user.bot)
                        return [2 /*return*/];
                    message = reaction.message;
                    guildId = (_a = message.guild) === null || _a === void 0 ? void 0 : _a.id;
                    if (!guildId || !message.guild)
                        return [2 /*return*/];
                    _b.label = 3;
                case 3:
                    _b.trys.push([3, 13, , 14]);
                    return [4 /*yield*/, db_1.default.execute('SELECT * FROM reaction_role_panels WHERE message_id = ?', [message.id])];
                case 4:
                    panel = (_b.sent())[0][0];
                    if (!panel)
                        return [2 /*return*/];
                    emojiIdentifier = reaction.emoji.id || reaction.emoji.name;
                    return [4 /*yield*/, db_1.default.execute('SELECT role_id FROM reaction_role_mappings WHERE panel_id = ? AND emoji_id = ?', [panel.id, emojiIdentifier])];
                case 5:
                    mapping = (_b.sent())[0][0];
                    if (!mapping)
                        return [2 /*return*/];
                    return [4 /*yield*/, message.guild.members.fetch(user.id)];
                case 6:
                    member = _b.sent();
                    return [4 /*yield*/, message.guild.roles.fetch(mapping.role_id).catch(function () { return null; })];
                case 7:
                    role_1 = _b.sent();
                    if (!role_1 || !role_1.permissions || !role_1.editable) {
                        logger_1.default.warn("Role not found, not editable, or has null permissions for mapping in panel ".concat(panel.id), { guildId: guildId, category: 'reaction-roles' });
                        return [2 /*return*/];
                    }
                    if (!(panel.panel_mode === 'unique')) return [3 /*break*/, 10];
                    return [4 /*yield*/, db_1.default.execute('SELECT role_id FROM reaction_role_mappings WHERE panel_id = ?', [panel.id])];
                case 8:
                    allMappings = (_b.sent())[0];
                    rolesOnPanel_1 = allMappings.map(function (m) { return m.role_id; });
                    rolesToRemove = member.roles.cache.filter(function (r) { return rolesOnPanel_1.includes(r.id) && r.id !== role_1.id; });
                    if (!(rolesToRemove.size > 0)) return [3 /*break*/, 10];
                    return [4 /*yield*/, member.roles.remove(rolesToRemove, 'Reaction Role: Unique mode')];
                case 9:
                    _b.sent();
                    _b.label = 10;
                case 10:
                    if (!!member.roles.cache.has(role_1.id)) return [3 /*break*/, 12];
                    return [4 /*yield*/, member.roles.add(role_1, 'Reaction Role: Role added')];
                case 11:
                    _b.sent();
                    logger_1.default.info("Added role ".concat(role_1.name, " to ").concat(user.tag), { guildId: guildId, category: 'reaction-roles' });
                    _b.label = 12;
                case 12: return [3 /*break*/, 14];
                case 13:
                    error_3 = _b.sent();
                    errorMessage = _error instanceof Error ? _error.stack : String(_error);
                    logger_1.default.error("Failed to process reaction add for user ".concat(user.tag), { guildId: guildId, category: 'reaction-roles', error: errorMessage });
                    return [3 /*break*/, 14];
                case 14: return [2 /*return*/];
            }
        });
    });
}
function handleReactionRemove(reaction, user) {
    return __awaiter(this, void 0, void 0, function () {
        var message, guildId, panel, emojiIdentifier, mapping, member, role, error_4, errorMessage;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    if (!reaction.message.partial) return [3 /*break*/, 2];
                    return [4 /*yield*/, reaction.message.fetch()];
                case 1:
                    _b.sent();
                    _b.label = 2;
                case 2:
                    if (user.bot)
                        return [2 /*return*/];
                    message = reaction.message;
                    guildId = (_a = message.guild) === null || _a === void 0 ? void 0 : _a.id;
                    if (!guildId || !message.guild)
                        return [2 /*return*/];
                    _b.label = 3;
                case 3:
                    _b.trys.push([3, 10, , 11]);
                    return [4 /*yield*/, db_1.default.execute('SELECT * FROM reaction_role_panels WHERE message_id = ?', [message.id])];
                case 4:
                    panel = (_b.sent())[0][0];
                    if (!panel || panel.panel_mode === 'unique')
                        return [2 /*return*/];
                    emojiIdentifier = reaction.emoji.id || reaction.emoji.name;
                    return [4 /*yield*/, db_1.default.execute('SELECT role_id FROM reaction_role_mappings WHERE panel_id = ? AND emoji_id = ?', [panel.id, emojiIdentifier])];
                case 5:
                    mapping = (_b.sent())[0][0];
                    if (!mapping)
                        return [2 /*return*/];
                    return [4 /*yield*/, message.guild.members.fetch(user.id)];
                case 6:
                    member = _b.sent();
                    return [4 /*yield*/, message.guild.roles.fetch(mapping.role_id).catch(function () { return null; })];
                case 7:
                    role = _b.sent();
                    if (!role || !role.permissions || !role.editable) {
                        return [2 /*return*/];
                    }
                    if (!member.roles.cache.has(role.id)) return [3 /*break*/, 9];
                    return [4 /*yield*/, member.roles.remove(role, 'Reaction Role: Role removed')];
                case 8:
                    _b.sent();
                    logger_1.default.info("Removed role ".concat(role.name, " from ").concat(user.tag), { guildId: guildId, category: 'reaction-roles' });
                    _b.label = 9;
                case 9: return [3 /*break*/, 11];
                case 10:
                    error_4 = _b.sent();
                    if (error_4.code === 10007)
                        return [2 /*return*/];
                    errorMessage = error_4 instanceof Error ? error_4.stack : String(error_4);
                    logger_1.default.error("Failed to process reaction remove for user ".concat(user.tag), { guildId: guildId, category: 'reaction-roles', error: errorMessage });
                    return [3 /*break*/, 11];
                case 11: return [2 /*return*/];
            }
        });
    });
}
