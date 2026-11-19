/**
 * CertiFried Extension E2E Tests
 * Tests all game systems via the API
 */

const BASE_URL = 'http://localhost:4020/api/v1';
let authToken = null;
let playerId = null;

async function apiCall(endpoint, method = 'GET', body = null) {
    const options = {
        method,
        headers: {
            'Content-Type': 'application/json',
        }
    };
    if (authToken) {
        options.headers['Authorization'] = `Bearer ${authToken}`;
    }
    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(`${BASE_URL}${endpoint}`, options);
    const data = await response.json();
    return { status: response.status, data };
}

const tests = [];
let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        tests.push({ name, status: 'PASS' });
        passed++;
        console.log(`✓ ${name}`);
    } catch (e) {
        tests.push({ name, status: 'FAIL', error: e.message });
        failed++;
        console.log(`✗ ${name}: ${e.message}`);
    }
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 100));
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function runTests() {
    console.log('=== CertiFried E2E Tests ===\n');

    // Auth
    await test('Auth - Dev login', async () => {
        const { status, data } = await apiCall('/auth/dev', 'POST', { testId: 'e2e_full_test' });
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Login failed');
        assert(data.token, 'No token returned');
        authToken = data.token;
        playerId = data.player.id;
    });

    // Game State
    await test('Game State - Get player state', async () => {
        const { status, data } = await apiCall('/game/state');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get game state');
        assert(data.player, 'No player data');
        assert(typeof data.player.level === 'number', 'Invalid level');
        assert(typeof data.player.cash === 'number', 'Invalid cash');
    });

    // Grow System
    await test('Grow - Get slots', async () => {
        const { status, data } = await apiCall('/grow/slots');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get slots');
        assert(Array.isArray(data.slots), 'Slots not an array');
        assert(data.slots.length > 0, 'No grow slots');
    });

    await test('Grow - Get available strains', async () => {
        const { status, data } = await apiCall('/grow/strains');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get strains');
        assert(Array.isArray(data.strains), 'Strains not an array');
    });

    // Inventory
    await test('Inventory - Get inventory', async () => {
        const { status, data } = await apiCall('/inventory');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get inventory');
        assert(Array.isArray(data.items), 'Items not an array');
    });

    // Market
    await test('Market - Get prices', async () => {
        const { status, data } = await apiCall('/market/prices');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get prices');
        assert(Array.isArray(data.prices), 'Prices not an array');
        assert(data.prices.length > 0, 'No market prices');
    });

    await test('Market - Get listings', async () => {
        const { status, data } = await apiCall('/market/listings');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get listings');
        assert(Array.isArray(data.listings), 'Listings not an array');
    });

    // Shop
    await test('Shop - Get items', async () => {
        const { status, data } = await apiCall('/shop/items');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get shop items');
    });

    await test('Shop - Get deals', async () => {
        const { status, data } = await apiCall('/shop/deals');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get shop deals');
    });

    // Breeding
    await test('Breeding - Get status', async () => {
        const { status, data } = await apiCall('/breed/operations');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get breeding status');
    });

    // Skills
    await test('Skills - Get tree', async () => {
        const { status, data } = await apiCall('/skills/tree');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get skill tree');
        assert(Array.isArray(data.nodes), 'Nodes not an array');
        assert(data.nodes.length > 0, 'No skill nodes');
    });

    // Research
    await test('Research - Get nodes', async () => {
        const { status, data } = await apiCall('/research/tree');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get research');
        assert(Array.isArray(data.allNodes), 'allNodes not an array');
        assert(data.tree, 'Missing tree categories');
    });

    // Quests
    await test('Quests - Get quests', async () => {
        const { status, data } = await apiCall('/quests');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get quests');
        assert(Array.isArray(data.quests), 'Quests not an array');
    });

    // Contracts
    await test('Contracts - Get contracts', async () => {
        const { status, data } = await apiCall('/contracts');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get contracts');
        assert(Array.isArray(data.available), 'Available not an array');
    });

    // Extraction
    await test('Extraction - Get status', async () => {
        const { status, data } = await apiCall('/extraction');
        assert(status === 200, `Expected 200, got ${status}`);
        // May be locked, that's OK
    });

    // Dispensary
    await test('Dispensary - Get status', async () => {
        const { status, data } = await apiCall('/dispensary');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get dispensary');
    });

    // Bosses
    await test('Bosses - Get bosses', async () => {
        const { status, data } = await apiCall('/bosses');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get bosses');
        assert(Array.isArray(data.bosses), 'Bosses not an array');
    });

    // Events
    await test('Events - Get events', async () => {
        const { status, data } = await apiCall('/events');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get events');
        assert(Array.isArray(data.events), 'Events not an array');
    });

    // Achievements
    await test('Achievements - Get achievements', async () => {
        const { status, data } = await apiCall('/achievements');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get achievements');
        assert(Array.isArray(data.achievements), 'Achievements not an array');
    });

    // Workers
    await test('Workers - Get status', async () => {
        const { status, data } = await apiCall('/workers/status');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get workers');
    });

    // Settings
    await test('Settings - Get settings', async () => {
        const { status, data } = await apiCall('/settings');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get settings');
    });

    // Notifications
    await test('Notifications - Get notifications', async () => {
        const { status, data } = await apiCall('/notifications');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get notifications');
    });

    // Stats
    await test('Stats - Get stats', async () => {
        const { status, data } = await apiCall('/stats');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get stats');
    });

    // Daily Rewards
    await test('Daily Rewards - Check status', async () => {
        const { status, data } = await apiCall('/daily-rewards/status');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get daily rewards');
    });

    // Vault
    await test('Vault - Get status', async () => {
        const { status, data } = await apiCall('/vault');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get vault');
    });

    // Prestige
    await test('Prestige - Get status', async () => {
        const { status, data } = await apiCall('/prestige/info');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get prestige');
    });

    // Territories
    await test('Territories - Get territories', async () => {
        const { status, data } = await apiCall('/territories');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get territories');
    });

    // Minigames
    await test('Minigames - Get minigames', async () => {
        const { status, data } = await apiCall('/minigames');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get minigames');
    });

    // Raid Status
    await test('Raid - Get status', async () => {
        const { status, data } = await apiCall('/raid/status');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get raid status');
    });

    // Locations
    await test('Locations - Get locations', async () => {
        const { status, data } = await apiCall('/locations');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get locations');
    });

    // Equipment
    await test('Equipment - Get equipment', async () => {
        const { status, data } = await apiCall('/equipment');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get equipment');
    });

    // Black Market
    await test('Black Market - Get status', async () => {
        const { status, data } = await apiCall('/black-market');
        assert(status === 200, `Expected 200, got ${status}`);
        // May be locked
    });

    // Cartels
    await test('Cartels - Get status', async () => {
        const { status, data } = await apiCall('/cartels');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get cartels');
    });

    // Favorites
    await test('Favorites - Get favorites', async () => {
        const { status, data } = await apiCall('/favorites');
        assert(status === 200, `Expected 200, got ${status}`);
        assert(data.success, 'Failed to get favorites');
    });

    // Summary
    console.log(`\n=== RESULTS ===`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    console.log(`Total: ${tests.length}`);

    if (failed > 0) {
        console.log('\nFailed tests:');
        tests.filter(t => t.status === 'FAIL').forEach(t => {
            console.log(`  - ${t.name}: ${t.error}`);
        });
    }
}

runTests().catch(console.error);
