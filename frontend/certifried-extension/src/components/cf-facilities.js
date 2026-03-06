/**
 * CertiFried Extension - Facilities Component
 * Comprehensive facility management with rooms, upgrades, and automation
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatCurrency, formatNumber } from '../utils/format.js';
import { api } from '../api/client.js';
import { store } from '../state/store.js';

// Facility room types
const ROOM_TYPES = {
    grow_room: {
        name: 'Grow Rooms',
        icon: '🌱',
        description: 'Expand your growing capacity',
        color: 'var(--color-success)'
    },
    drying_room: {
        name: 'Drying Rooms',
        icon: '🍂',
        description: 'Improve curing quality',
        color: 'var(--color-warning)'
    },
    storage: {
        name: 'Storage',
        icon: '📦',
        description: 'Increase inventory capacity',
        color: 'var(--color-primary)'
    },
    lab: {
        name: 'Laboratory',
        icon: '🧪',
        description: 'Extraction & research speed',
        color: 'var(--color-epic)'
    },
    security: {
        name: 'Security Office',
        icon: '🔒',
        description: 'Reduce heat & raid risk',
        color: 'var(--color-danger)'
    },
    office: {
        name: 'Business Office',
        icon: '💼',
        description: 'Worker & contract bonuses',
        color: 'var(--color-rare)'
    },
    power: {
        name: 'Power Grid',
        icon: '⚡',
        description: 'Efficiency & automation',
        color: 'var(--color-legendary)'
    },
    hvac: {
        name: 'Climate Control',
        icon: '❄️',
        description: 'Quality & consistency',
        color: 'var(--color-info)'
    }
};

// Upgrade categories
const UPGRADE_CATEGORIES = {
    capacity: { name: 'Capacity', icon: '📐' },
    efficiency: { name: 'Efficiency', icon: '⚡' },
    quality: { name: 'Quality', icon: '💎' },
    automation: { name: 'Automation', icon: '🤖' },
    security: { name: 'Security', icon: '🛡️' }
};

class CFFacilities extends CFBaseComponent {
    constructor() {
        super();
        this._facilityData = null;
        this._rooms = [];
        this._upgrades = [];
        this._stats = {};
        this._loading = true;
        this._error = null;
        this._activeTab = 'overview'; // 'overview' | 'rooms' | 'upgrades' | 'automation'
        this._selectedRoom = null;
    }

    _setupSubscriptions() {
        this.subscribe('player');
        this.subscribe('settings');
    }

    async onMount() {
        await this._loadFacilityData();

        // Tab switching
        this.on('click', '.cf-tab-btn', (e) => {
            const tab = e.target.closest('.cf-tab-btn');
            if (!tab) return;
            this._activeTab = tab.dataset.tab;
            this._selectedRoom = null;
            this.render();
        });

        // Select room
        this.on('click', '.cf-room-card', (e) => {
            const card = e.target.closest('.cf-room-card');
            if (!card) return;
            this._selectedRoom = card.dataset.roomKey;
            this.render();
        });

        // Back to rooms list
        this.on('click', '.cf-room-back', () => {
            this._selectedRoom = null;
            this.render();
        });

        // Upgrade facility
        this.on('click', '.cf-facility-upgrade', async (e) => {
            const btn = e.target.closest('.cf-facility-upgrade');
            if (!btn || btn.disabled) return;
            await this._purchaseUpgrade(btn.dataset.upgradeKey);
        });

        // Toggle automation
        this.on('change', '.cf-automation-toggle', async (e) => {
            const checkbox = e.target;
            const setting = checkbox.dataset.setting;
            await this._toggleAutomation(setting, checkbox.checked);
        });

        // Seed auto-buy config
        this.on('change', '.cf-seed-threshold', async (e) => {
            await this._toggleAutomation('autoBuySeedsThreshold', parseInt(e.target.value));
        });
        this.on('change', '.cf-seed-max-price', async (e) => {
            await this._toggleAutomation('autoBuySeedsMaxPrice', parseInt(e.target.value));
        });
    }

    async _loadFacilityData() {
        const isFirstLoad = !this._facilityData;

        if (isFirstLoad) {
            this._loading = true;
            this._error = null;
            this.render();
        }

        try {
            const response = await api.getFacilityInfo();
            this._facilityData = response.facility || response;
            this._upgrades = response.upgrades || [];
            this._rooms = response.rooms || this._generateRooms(this._facilityData);
            this._stats = response.stats || {};
        } catch (err) {
            this._error = err.message;
        }

        this._loading = false;
        this.scheduleRender();
    }

    _generateRooms(facility) {
        // Generate room data from facility info, using actual upgrade data for levels
        const rooms = [];
        Object.entries(ROOM_TYPES).forEach(([key, info]) => {
            // Get the actual upgrade data for this room's backend key
            const upgradeKey = this._roomToUpgradeKey(key);
            const upgrade = this._upgrades.find(u => u.key === upgradeKey);

            // Use actual levels from upgrade data, not guessed facility properties
            const level = upgrade?.currentLevel || 0;
            const maxLevel = upgrade?.maxLevel || 10;

            rooms.push({
                key,
                ...info,
                level,
                maxLevel,
                upgradeKey, // Store for reference
                bonuses: this._getRoomBonuses(key, level)
            });
        });
        return rooms;
    }

    _getRoomBonuses(roomKey, level) {
        const bonusMap = {
            grow_room: [{ type: 'grow_slots', value: level, label: 'Grow Slots' }],
            drying_room: [{ type: 'quality_bonus', value: level * 0.02, label: 'Quality' }],
            storage: [{ type: 'storage_capacity', value: level * 50, label: 'Capacity' }],
            lab: [{ type: 'extraction_speed', value: level * 0.05, label: 'Speed' }],
            security: [{ type: 'heat_reduction', value: level * 0.03, label: 'Heat Reduction' }],
            office: [{ type: 'worker_efficiency', value: level * 0.02, label: 'Worker Efficiency' }],
            power: [{ type: 'efficiency', value: level * 0.03, label: 'Efficiency' }],
            hvac: [{ type: 'consistency', value: level * 0.02, label: 'Consistency' }]
        };
        return bonusMap[roomKey] || [];
    }

    // Map room keys to backend upgrade keys
    _roomToUpgradeKey(roomKey) {
        const mapping = {
            grow_room: 'grow_slots',
            drying_room: 'lighting',
            storage: 'storage',
            lab: 'ventilation',
            security: 'security',
            office: 'irrigation',
            power: 'ventilation',
            hvac: 'irrigation'
        };
        return mapping[roomKey] || roomKey;
    }

    // Get the actual upgrade cost from API data (not local calculation)
    _getActualUpgradeCost(roomKey) {
        const upgradeKey = this._roomToUpgradeKey(roomKey);
        const upgrade = this._upgrades.find(u => u.key === upgradeKey);
        if (!upgrade) return null;
        return upgrade.nextCost ?? null;
    }

    async _purchaseUpgrade(upgradeKey) {
        // Handle room upgrade keys (e.g., "grow_room_level" -> "grow_slots")
        let actualKey = upgradeKey;
        if (upgradeKey.endsWith('_level')) {
            const roomKey = upgradeKey.replace('_level', '');
            actualKey = this._roomToUpgradeKey(roomKey);
        }

        const upgrade = this._upgrades.find(u => u.key === actualKey);
        if (!upgrade) {
            // If upgrade not found in cached list, try direct API call
            await this._purchaseRoomUpgrade(actualKey);
            return;
        }

        const player = this.getState('player') || {};
        // Check both currency and cash fields due to inconsistent state updates across codebase
        const playerCash = player.currency || player.cash || 0;
        if (playerCash < upgrade.nextCost) {
            this.emit('notification', {
                type: 'error',
                message: `Not enough cash (need ${formatCurrency(upgrade.nextCost)}, have ${formatCurrency(playerCash)})`
            });
            return;
        }

        // Optimistic update
        const oldUpgrades = [...this._upgrades];
        upgrade.currentLevel = (upgrade.currentLevel || 0) + 1;
        this.scheduleRender();

        try {
            // Use actualKey (the mapped backend key), not the original upgradeKey
            const result = await api.upgradeFacility(actualKey);
            if (result.success) {
                this.emit('notification', { type: 'success', message: result.message || 'Upgraded!' });
                await this._loadFacilityData();
            } else {
                throw new Error(result.error || 'Upgrade failed');
            }
        } catch (err) {
            this._upgrades = oldUpgrades;
            this.emit('notification', { type: 'error', message: err.message });
            this.scheduleRender();
        }
    }

    async _purchaseRoomUpgrade(upgradeKey) {
        // Direct room upgrade when not in cached upgrades list
        try {
            const result = await api.upgradeFacility(upgradeKey);
            if (result.success) {
                this.emit('notification', { type: 'success', message: result.message || 'Room upgraded!' });
                await this._loadFacilityData();
            } else {
                throw new Error(result.error || 'Upgrade failed');
            }
        } catch (err) {
            this.emit('notification', { type: 'error', message: err.message });
        }
    }

    async _toggleAutomation(setting, enabled) {
        // Update store immediately (all components see the change)
        store.set(`settings.${setting}`, enabled);

        try {
            const result = await api.updateSettings({ [setting]: enabled });
            // Merge full server response back to keep everything in sync
            if (result.settings) {
                store.loadServerSettings(result.settings);
            }
            this.emit('notification', {
                type: 'info',
                message: `${setting} ${enabled ? 'enabled' : 'disabled'}`
            });
        } catch (err) {
            // Rollback on failure
            store.set(`settings.${setting}`, !enabled);
            this.emit('notification', { type: 'error', message: err.message });
        }

        // Persist to localStorage backup
        store._persistSettings();
    }

    render() {
        this.className = 'cf-facilities';

        if (this._loading) {
            this.setContent(h('div', { class: 'cf-loading' }, h('div', { class: 'cf-spinner' })));
            return;
        }

        if (this._error) {
            this.setContent(
                h('div', { class: 'cf-error-message' },
                    h('p', {}, this._error),
                    h('button', {
                        class: 'cf-btn cf-btn--primary',
                        onclick: () => this._loadFacilityData()
                    }, 'Retry')
                )
            );
            return;
        }

        const player = this.getState('player') || {};
        const facility = this._facilityData || {};

        this.setContent(
            h('h2', { class: 'cf-section__title mb-3' }, '🏭 Facility Management'),

            // Summary stats
            this._renderFacilityStats(facility, player),

            // Tabs
            h('div', { class: 'cf-tabs mb-3' },
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'overview' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'overview' }
                }, 'Overview'),
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'rooms' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'rooms' }
                }, 'Rooms'),
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'upgrades' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'upgrades' }
                }, 'Upgrades'),
                h('button', {
                    class: `cf-tab cf-tab-btn ${this._activeTab === 'automation' ? 'cf-tab--active' : ''}`,
                    dataset: { tab: 'automation' }
                }, 'Automation')
            ),

            // Tab content
            this._activeTab === 'overview' && this._renderOverviewTab(facility),
            this._activeTab === 'rooms' && this._renderRoomsTab(),
            this._activeTab === 'upgrades' && this._renderUpgradesTab(player),
            this._activeTab === 'automation' && this._renderAutomationTab()
        );
    }

    _renderFacilityStats(facility, player) {
        return h('div', { class: 'cf-card mb-3' },
            h('div', { class: 'cf-card__body' },
                h('div', {
                    style: {
                        display: 'grid',
                        gridTemplateColumns: 'repeat(4, 1fr)',
                        gap: 'var(--space-2)',
                        textAlign: 'center'
                    }
                },
                    h('div', {},
                        h('div', { class: 'text-lg font-bold' }, facility.maxGrowSlots || 2),
                        h('div', { class: 'text-xs text-muted' }, 'Grow Slots')
                    ),
                    h('div', {},
                        h('div', { class: 'text-lg font-bold' }, facility.storageCapacity || 100),
                        h('div', { class: 'text-xs text-muted' }, 'Storage')
                    ),
                    h('div', {},
                        h('div', { class: 'text-lg font-bold', style: { color: 'var(--color-success)' } },
                            `${Math.round((facility.efficiency || 1) * 100)}%`
                        ),
                        h('div', { class: 'text-xs text-muted' }, 'Efficiency')
                    ),
                    h('div', {},
                        h('div', { class: 'text-lg font-bold', style: { color: 'var(--color-primary)' } },
                            formatCurrency(player.currency || 0, true)
                        ),
                        h('div', { class: 'text-xs text-muted' }, 'Cash')
                    )
                )
            )
        );
    }

    _renderOverviewTab(facility) {
        return h('div', { class: 'cf-facility-overview' },
            // Facility name and tier
            h('div', { class: 'cf-card mb-3' },
                h('div', { class: 'cf-card__body text-center' },
                    h('div', { class: 'text-xl font-bold mb-1' }, facility.name || 'My Grow Operation'),
                    h('div', { class: 'text-sm text-muted' },
                        `Tier ${facility.tier || 1} Facility • Level ${facility.level || 1}`
                    ),
                    facility.tier && h('div', {
                        style: {
                            marginTop: 'var(--space-2)',
                            padding: 'var(--space-1) var(--space-2)',
                            background: 'var(--color-primary-600)',
                            borderRadius: 'var(--radius-md)',
                            display: 'inline-block',
                            fontSize: 'var(--font-size-xs)'
                        }
                    }, `Next tier at level ${(facility.tier || 1) * 10 + 10}`)
                )
            ),

            // Quick room status
            h('h3', { class: 'text-sm font-semibold mb-2' }, 'Room Status'),
            h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 'var(--space-2)' } },
                ...this._rooms.slice(0, 4).map(room => {
                    const info = ROOM_TYPES[room.key] || {};
                    return h('div', {
                        class: 'cf-card',
                        style: { borderLeft: `3px solid ${info.color || 'var(--border-primary)'}` }
                    },
                        h('div', { class: 'cf-card__body' },
                            h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)' } },
                                h('span', { style: { fontSize: '1.25rem' } }, info.icon),
                                h('div', { style: { flex: 1 } },
                                    h('div', { class: 'text-sm font-semibold' }, info.name),
                                    h('div', { class: 'text-xs text-muted' }, `Level ${room.level}/${room.maxLevel}`)
                                )
                            )
                        )
                    );
                })
            ),

            // Active bonuses summary
            h('div', { class: 'cf-card mt-3' },
                h('div', { class: 'cf-card__header' },
                    h('h4', { class: 'cf-card__title' }, 'Facility Bonuses')
                ),
                h('div', { class: 'cf-card__body' },
                    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)' } },
                        this._renderBonusItem('Grow Speed', facility.growSpeedBonus || 0),
                        this._renderBonusItem('Yield', facility.yieldBonus || 0),
                        this._renderBonusItem('Quality', facility.qualityBonus || 0),
                        this._renderBonusItem('Heat Reduction', facility.heatReduction || 0)
                    )
                )
            )
        );
    }

    _renderBonusItem(label, value) {
        const displayValue = value > 0 ? `+${Math.round(value * 100)}%` : '--';
        return h('div', { class: 'text-sm' },
            h('span', { class: 'text-muted' }, `${label}: `),
            h('span', { style: { color: value > 0 ? 'var(--color-success)' : 'inherit' } }, displayValue)
        );
    }

    _renderRoomsTab() {
        if (this._selectedRoom) {
            return this._renderRoomDetail(this._selectedRoom);
        }

        return h('div', { class: 'cf-facility-rooms' },
            h('p', { class: 'text-sm text-muted mb-3' },
                'Expand and upgrade your facility rooms for permanent bonuses'
            ),
            ...this._rooms.map(room => this._renderRoomCard(room))
        );
    }

    _renderRoomCard(room) {
        const info = ROOM_TYPES[room.key] || { name: room.key, icon: '🏠', color: 'var(--text-muted)' };
        const progress = (room.level / room.maxLevel) * 100;

        return h('div', {
            class: 'cf-card cf-room-card mb-2',
            dataset: { roomKey: room.key },
            style: { cursor: 'pointer', borderLeft: `3px solid ${info.color}` }
        },
            h('div', { class: 'cf-card__body' },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-3)' } },
                    h('div', {
                        style: {
                            width: '48px',
                            height: '48px',
                            background: 'var(--bg-tertiary)',
                            borderRadius: 'var(--radius-md)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '1.5rem'
                        }
                    }, info.icon),
                    h('div', { style: { flex: 1 } },
                        h('div', { class: 'font-semibold' }, info.name),
                        h('div', { class: 'text-xs text-muted mb-1' }, info.description),
                        h('div', { class: 'cf-progress', style: { height: '4px' } },
                            h('div', {
                                class: 'cf-progress__bar',
                                style: { width: `${progress}%`, background: info.color }
                            })
                        ),
                        h('div', { class: 'text-xs text-muted mt-1' }, `Level ${room.level}/${room.maxLevel}`)
                    ),
                    h('span', { style: { color: 'var(--text-muted)' } }, '→')
                )
            )
        );
    }

    _renderRoomDetail(roomKey) {
        const room = this._rooms.find(r => r.key === roomKey);
        if (!room) {
            this._selectedRoom = null;
            return this._renderRoomsTab();
        }

        const info = ROOM_TYPES[roomKey] || {};
        const bonuses = room.bonuses || [];
        const player = this.getState('player') || {};
        // Use actual API cost, not local calculation (null = maxed or unavailable)
        const upgradeCost = this._getActualUpgradeCost(roomKey);
        const playerCash = player.currency || player.cash || 0;
        const canAfford = upgradeCost !== null && playerCash >= upgradeCost;
        const isMaxed = room.level >= room.maxLevel || upgradeCost === null;

        return h('div', { class: 'cf-room-detail' },
            h('button', { class: 'cf-btn cf-btn--ghost cf-room-back mb-3' },
                h('span', {}, '← Back to Rooms')
            ),

            // Room header
            h('div', { class: 'cf-card mb-3', style: { borderLeft: `4px solid ${info.color}` } },
                h('div', { class: 'cf-card__body text-center' },
                    h('div', { style: { fontSize: '3rem', marginBottom: 'var(--space-2)' } }, info.icon),
                    h('h3', { class: 'font-bold mb-1' }, info.name),
                    h('div', { class: 'text-muted mb-2' }, info.description),
                    h('div', {
                        style: {
                            display: 'inline-block',
                            padding: 'var(--space-1) var(--space-3)',
                            background: info.color,
                            borderRadius: 'var(--radius-full)',
                            fontSize: 'var(--font-size-sm)'
                        }
                    }, `Level ${room.level}/${room.maxLevel}`)
                )
            ),

            // Current bonuses
            h('div', { class: 'cf-card mb-3' },
                h('div', { class: 'cf-card__header' },
                    h('h4', { class: 'cf-card__title' }, 'Current Bonuses')
                ),
                h('div', { class: 'cf-card__body' },
                    bonuses.length > 0
                        ? h('div', {},
                            ...bonuses.map(bonus => {
                                const displayValue = bonus.type.includes('capacity') || bonus.type.includes('slots')
                                    ? `+${bonus.value}`
                                    : `+${Math.round(bonus.value * 100)}%`;
                                return h('div', {
                                    style: {
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        padding: 'var(--space-1) 0'
                                    }
                                },
                                    h('span', {}, bonus.label),
                                    h('span', { style: { color: 'var(--color-success)', fontWeight: 'bold' } }, displayValue)
                                );
                            })
                        )
                        : h('p', { class: 'text-muted' }, 'No bonuses at current level')
                )
            ),

            // Upgrade section
            !isMaxed && h('div', { class: 'cf-card' },
                h('div', { class: 'cf-card__header' },
                    h('h4', { class: 'cf-card__title' }, 'Upgrade to Level ' + (room.level + 1))
                ),
                h('div', { class: 'cf-card__body' },
                    h('p', { class: 'text-sm text-muted mb-3' },
                        'Upgrading will improve all bonuses from this room'
                    ),
                    h('button', {
                        class: `cf-btn cf-btn--lg cf-facility-upgrade ${canAfford ? 'cf-btn--primary' : ''}`,
                        dataset: { upgradeKey: `${roomKey}_level` },
                        disabled: !canAfford,
                        style: { width: '100%' }
                    }, canAfford
                        ? `Upgrade for ${formatCurrency(upgradeCost)}`
                        : `Need ${formatCurrency(upgradeCost || 0)}`
                    )
                )
            ),

            isMaxed && h('div', { class: 'cf-card' },
                h('div', { class: 'cf-card__body text-center' },
                    h('span', { style: { fontSize: '2rem' } }, '⭐'),
                    h('p', { class: 'font-bold mt-2' }, 'Max Level Reached!'),
                    h('p', { class: 'text-sm text-muted' }, 'This room is fully upgraded')
                )
            )
        );
    }

    _getRoomUpgradeCost(room) {
        const baseCost = 1000;
        return Math.floor(baseCost * Math.pow(2.5, room.level));
    }

    _renderUpgradesTab(player) {
        if (this._upgrades.length === 0) {
            return h('div', { class: 'cf-empty' },
                h('p', { class: 'cf-empty__title' }, 'No Upgrades Available'),
                h('p', { class: 'cf-empty__description' },
                    'Check back later for facility upgrades'
                )
            );
        }

        // Group upgrades by category
        const grouped = {};
        this._upgrades.forEach(upgrade => {
            const category = upgrade.category || 'misc';
            if (!grouped[category]) grouped[category] = [];
            grouped[category].push(upgrade);
        });

        return h('div', { class: 'cf-facility-upgrades' },
            h('p', { class: 'text-sm text-muted mb-3' },
                `Available: ${formatCurrency(player.currency || 0)}`
            ),
            ...Object.entries(grouped).map(([category, upgrades]) => {
                const catInfo = UPGRADE_CATEGORIES[category] || { name: category, icon: '🔧' };
                return h('div', { class: 'mb-4' },
                    h('h3', { class: 'text-sm font-semibold mb-2' },
                        h('span', { style: { marginRight: 'var(--space-1)' } }, catInfo.icon),
                        catInfo.name
                    ),
                    ...upgrades.map(upgrade => this._renderUpgradeItem(upgrade, player))
                );
            })
        );
    }

    _renderUpgradeItem(upgrade, player) {
        const canAfford = (player.currency || 0) >= (upgrade.nextCost || 0);
        const isMaxed = upgrade.currentLevel >= upgrade.maxLevel;
        const progress = (upgrade.currentLevel / upgrade.maxLevel) * 100;

        return h('div', {
            class: 'cf-card mb-2',
            style: { opacity: isMaxed ? 0.6 : 1 }
        },
            h('div', { class: 'cf-card__body' },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-3)' } },
                    h('div', { style: { flex: 1 } },
                        h('div', { class: 'font-semibold' }, upgrade.name),
                        h('div', { class: 'text-xs text-muted mb-1' }, upgrade.description),
                        h('div', { class: 'cf-progress', style: { height: '3px' } },
                            h('div', {
                                class: 'cf-progress__bar',
                                style: { width: `${progress}%` }
                            })
                        ),
                        h('div', { class: 'text-xs text-muted mt-1' },
                            `Level ${upgrade.currentLevel || 0}/${upgrade.maxLevel}`
                        )
                    ),
                    !isMaxed && h('button', {
                        class: `cf-btn cf-btn--sm cf-facility-upgrade ${canAfford ? 'cf-btn--primary' : ''}`,
                        dataset: { upgradeKey: upgrade.key },
                        disabled: !canAfford
                    }, formatCurrency(upgrade.nextCost || 0, true))
                )
            )
        );
    }

    _renderAutomationTab() {
        const automationSettings = [
            {
                key: 'autoHarvest',
                name: 'Auto-Harvest',
                description: 'Automatically harvest mature plants',
                icon: '🌾'
            },
            {
                key: 'autoReplant',
                name: 'Auto-Replant',
                description: 'Replant after harvesting',
                icon: '🌱'
            },
            {
                key: 'autoBuySeeds',
                name: 'Auto-Buy Seeds',
                description: 'Buy seeds when supply runs low',
                icon: '🛒'
            },
            {
                key: 'autoSell',
                name: 'Auto-Sell',
                description: 'Sell harvests via NPC market automatically',
                icon: '💰'
            },
            {
                key: 'autoBreed',
                name: 'Auto-Breed',
                description: 'Start breeding when slots available',
                icon: '🧬'
            },
            {
                key: 'autoCollect',
                name: 'Auto-Collect',
                description: 'Claim completed research and extractions',
                icon: '📦'
            }
        ];

        const settings = this.getState('settings') || {};

        return h('div', { class: 'cf-facility-automation' },
            h('p', { class: 'text-sm text-muted mb-3' },
                'Configure automated operations for your facility'
            ),

            ...automationSettings.map(setting =>
                h('div', { class: 'cf-card mb-2' },
                    h('div', { class: 'cf-card__body' },
                        h('div', { style: { display: 'flex', alignItems: 'center', gap: 'var(--space-3)' } },
                            h('span', { style: { fontSize: '1.5rem' } }, setting.icon),
                            h('div', { style: { flex: 1 } },
                                h('div', { class: 'font-semibold' }, setting.name),
                                h('div', { class: 'text-xs text-muted' }, setting.description)
                            ),
                            h('label', { class: 'cf-toggle' },
                                h('input', {
                                    type: 'checkbox',
                                    class: 'cf-automation-toggle',
                                    dataset: { setting: setting.key },
                                    checked: settings[setting.key] || false
                                }),
                                h('span', { class: 'cf-toggle__slider' })
                            )
                        )
                    )
                )
            ),

            // Auto-buy seeds config (show when enabled)
            settings.autoBuySeeds && h('div', { class: 'cf-card mb-2', style: { borderLeft: '3px solid var(--color-primary)' } },
                h('div', { class: 'cf-card__body' },
                    h('div', { class: 'font-semibold text-sm mb-2' }, 'Seed Purchase Settings'),
                    h('div', { style: { display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap' } },
                        h('div', { style: { flex: 1, minWidth: '120px' } },
                            h('label', { class: 'text-xs text-muted' }, 'Buy when seeds below'),
                            h('select', {
                                class: 'cf-select cf-seed-threshold',
                                style: { width: '100%', marginTop: 'var(--space-1)' }
                            },
                                ...[3, 5, 10, 20, 50].map(n =>
                                    h('option', {
                                        value: n.toString(),
                                        selected: (settings.autoBuySeedsThreshold || 5) === n
                                    }, `${n} seeds`)
                                )
                            )
                        ),
                        h('div', { style: { flex: 1, minWidth: '120px' } },
                            h('label', { class: 'text-xs text-muted' }, 'Max price per pack'),
                            h('select', {
                                class: 'cf-select cf-seed-max-price',
                                style: { width: '100%', marginTop: 'var(--space-1)' }
                            },
                                ...[200, 500, 1000, 2000, 5000].map(n =>
                                    h('option', {
                                        value: n.toString(),
                                        selected: (settings.autoBuySeedsMaxPrice || 500) === n
                                    }, `$${n.toLocaleString()}`)
                                )
                            )
                        )
                    )
                )
            ),

            h('div', { class: 'cf-card mt-3', style: { background: 'var(--bg-tertiary)' } },
                h('div', { class: 'cf-card__body' },
                    h('p', { class: 'text-sm text-muted text-center' },
                        'All automation runs via the idle tycoon engine every 10 seconds'
                    )
                )
            )
        );
    }
}

registerComponent('cf-facilities', CFFacilities);
export default CFFacilities;
