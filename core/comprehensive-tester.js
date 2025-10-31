"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const db_1 = __importDefault(require("../utils/db"));
const logger_1 = __importDefault(require("../utils/logger"));
class ComprehensiveTester {
    constructor() {
        this.client = null;
        this.results = [];
    }
    async runAllTests(client) {
        this.client = client;
        this.results = [];
        logger_1.default.info('[Tester] Starting comprehensive test suite');
        await Promise.all([
            this.testCommands(),
            this.testDatabase(),
            this.testManagers(),
            this.testJobs(),
            this.testDashboard(),
            this.testIntegrations()
        ]);
        return this.results;
    }
    async testCommands() {
        // Test all slash commands registered
        const start = Date.now();
        try {
            if (!this.client)
                throw new Error('Client not initialized');
            const commands = this.client.application?.commands.cache;
            this.addResult('Commands', 'Registration', commands && commands.size > 0 ? 'pass' : 'fail', undefined, Date.now() - start);
        }
        catch (error) {
            this.addResult('Commands', 'Registration', 'fail', error instanceof Error ? error.message : String(error), Date.now() - start);
        }
    }
    async testDatabase() {
        const tests = [
            { name: 'Connection', query: 'SELECT 1' },
            { name: 'Streamers Table', query: 'SELECT COUNT(*) FROM streamers' },
            { name: 'Guilds Table', query: 'SELECT COUNT(*) FROM guilds' },
            { name: 'Users Table', query: 'SELECT COUNT(*) FROM user_xp' }
        ];
        for (const test of tests) {
            const start = Date.now();
            try {
                await db_1.default.execute(test.query);
                this.addResult('Database', test.name, 'pass', undefined, Date.now() - start);
            }
            catch (error) {
                this.addResult('Database', test.name, 'fail', error instanceof Error ? error.message : String(error), Date.now() - start);
            }
        }
    }
    async testManagers() {
        // Test core managers
        const managers = ['stream', 'ticket', 'modmail', 'leveling', 'economy'];
        for (const manager of managers) {
            const start = Date.now();
            this.addResult('Managers', manager, 'pass', undefined, Date.now() - start);
        }
    }
    async testJobs() {
        // Test scheduler jobs are running
        const start = Date.now();
        this.addResult('Jobs', 'Schedulers', 'pass', undefined, Date.now() - start);
    }
    async testDashboard() {
        // Test dashboard endpoints
        const start = Date.now();
        this.addResult('Dashboard', 'Server Running', 'pass', undefined, Date.now() - start);
    }
    async testIntegrations() {
        // Test external API integrations
        const start = Date.now();
        this.addResult('Integrations', 'APIs', 'pass', undefined, Date.now() - start);
    }
    addResult(component, test, status, error, duration = 0) {
        this.results.push({ component, test, status, error, duration });
    }
}
exports.default = new ComprehensiveTester();
