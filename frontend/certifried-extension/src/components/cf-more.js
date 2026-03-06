/**
 * CertiFried Extension - More Menu Component
 * Access to skills, facility, prestige, settings
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { formatCurrency } from '../utils/format.js';
import { app } from '../app.js';
import { store } from '../state/store.js';
import { api } from '../api/client.js';

const MENU_ITEMS = [
    { id: 'dashboard', label: 'Dashboard', icon: 'chart', description: 'Quick overview of everything' },
    { id: 'timers', label: 'Active Timers', icon: 'clock', description: 'View all countdowns' },
    { id: 'ai-assistant', label: 'AI Assistant', icon: 'robot', description: 'Tips and automation' },
    { id: 'daily-rewards', label: 'Daily Rewards', icon: 'gift', description: 'Claim your daily bonus!' },
    { id: 'facilities', label: 'Facilities', icon: 'factory', description: 'Manage rooms and automation' },
    { id: 'expansions', label: 'Properties', icon: 'home', description: 'Buy and upgrade properties' },
    { id: 'training', label: 'Training', icon: 'graduation', description: 'Train workers and learn traits' },
    { id: 'breeding-history', label: 'Breeding History', icon: 'dna', description: 'Past breeding results' },
    { id: 'upgrades', label: 'Upgrades Hub', icon: 'upgrade', description: 'All upgrade paths' },
    { id: 'permanent-unlocks', label: 'Permanent Unlocks', icon: 'unlock', description: 'What persists after prestige' },
    { id: 'favorites', label: 'Favorites', icon: 'heart', description: 'Quick access to favorite strains' },
    { id: 'market-alerts', label: 'Price Alerts', icon: 'alert', description: 'Get notified on price changes' },
    { id: 'vault', label: 'Vault', icon: 'vault', description: 'Protect assets from DEA raids' },
    { id: 'raids', label: 'Raids & Defense', icon: 'siren', description: 'DEA raid defense system' },
    { id: 'contracts', label: 'Contracts', icon: 'clipboard', description: 'Deliver orders for rewards' },
    { id: 'extraction', label: 'Extraction Lab', icon: 'flask', description: 'Make concentrated products' },
    { id: 'black-market', label: 'Black Market', icon: 'skull', description: 'High-risk, high-reward sales' },
    { id: 'mutations', label: 'Mutations', icon: 'dna', description: 'Discover strain mutations' },
    { id: 'research', label: 'Research Lab', icon: 'microscope', description: 'Unlock new technologies' },
    { id: 'equipment', label: 'Equipment', icon: 'wrench', description: 'Tools and upgrades' },
    { id: 'locations', label: 'Locations', icon: 'map', description: 'Expand to new grow sites' },
    { id: 'cartel', label: 'Cartel', icon: 'users', description: 'Join or create a cartel' },
    { id: 'territories', label: 'Territories', icon: 'flag', description: 'Capture turf for bonuses' },
    { id: 'tournaments', label: 'Tournaments', icon: 'tournament', description: 'Compete for prizes' },
    { id: 'reputation', label: 'Reputation', icon: 'shield', description: 'Faction standing & perks' },
    { id: 'dispensary', label: 'Dispensary', icon: 'store', description: 'Run your own dispensary' },
    { id: 'minigames', label: 'Minigames', icon: 'gamepad', description: 'Play games for rewards' },
    { id: 'bosses', label: 'Boss Battles', icon: 'boss', description: 'Challenge boss encounters' },
    { id: 'random-events', label: 'Events Log', icon: 'lightning', description: 'Active random events' },
    { id: 'events', label: 'Seasonal Events', icon: 'calendar', description: 'Seasonal events & rewards' },
    { id: 'stats', label: 'Statistics', icon: 'chart', description: 'View your lifetime stats' },
    { id: 'quality-guide', label: 'Quality Guide', icon: 'diamond', description: 'Quality tiers & bonuses' },
    { id: 'bonuses', label: 'Active Bonuses', icon: 'sparkle', description: 'View all your bonuses' },
    { id: 'trading', label: 'Trading', icon: 'trade', description: 'Trade with other players' },
    { id: 'workers', label: 'Workers', icon: 'worker', description: 'Manage automated helpers' },
    { id: 'strains', label: 'Strain Book', icon: 'book', description: 'Your strain collection' },
    { id: 'notifications', label: 'Notifications', icon: 'bell', description: 'View game alerts' },
    { id: 'skills', label: 'Skill Tree', icon: 'tree', description: 'Unlock permanent upgrades' },
    { id: 'facility', label: 'Facility', icon: 'building', description: 'Upgrade your grow operation' },
    { id: 'prestige', label: 'Prestige', icon: 'star', description: 'Reset for permanent bonuses' },
    { id: 'leaderboard', label: 'Leaderboard', icon: 'trophy', description: 'See top players' },
    { id: 'achievements', label: 'Achievements', icon: 'medal', description: 'Track your progress' },
    { id: 'settings', label: 'Settings', icon: 'gear', description: 'Customize your experience' }
];

class CFMore extends CFBaseComponent {
    constructor() {
        super();
        this._activeSubview = null;
        this._facilityData = null;
        this._facilityLoading = false;
    }

    async _loadFacilityData() {
        try {
            this._facilityLoading = true;
            const data = await api.getFacilityInfo();
            this._facilityData = data;
        } catch (error) {
            console.error('Failed to load facility data:', error);
        } finally {
            this._facilityLoading = false;
        }
    }

    _setupSubscriptions() {
        this.subscribe('player');
        // Listen for external navigation requests (from AI Assistant, Dashboard, etc.)
        this.subscribe('ui.moreSubview', (subview) => {
            if (subview && this._activeSubview !== subview) {
                this._activeSubview = subview;
                // Clear the store value after handling to allow re-navigation to same subview
                store.set('ui.moreSubview', null);
                this.render();
            }
        });
    }

    onMount() {
        this.on('click', '.cf-more-item', (e) => {
            const item = e.target.closest('.cf-more-item');
            if (!item) return;
            const itemId = item.dataset.id;
            this._openSubview(itemId);
        });

        this.on('click', '.cf-more__back', () => {
            this._activeSubview = null;
            this.render();
        });

        // Logout button handler
        this.on('click', '.cf-logout-btn', () => {
            if (confirm('Are you sure you want to logout?')) {
                app.logout();
                // Force page reload to show login screen
                window.location.reload();
            }
        });

        // Settings change handlers
        this.on('change', '.cf-setting-notifications', (e) => {
            this._updateSetting('notifications', e.target.checked);
        });

        this.on('change', '.cf-setting-sound', (e) => {
            this._updateSetting('sound', e.target.checked);
        });

        this.on('change', '.cf-setting-autoharvest', (e) => {
            this._updateSetting('autoHarvest', e.target.checked);
        });

        // Facility upgrade handler
        this.on('click', '.cf-facility-upgrade-btn', async (e) => {
            const btn = e.target.closest('.cf-facility-upgrade-btn');
            if (!btn) return;

            const upgradeKey = btn.dataset.upgradeKey;
            btn.disabled = true;
            btn.textContent = 'Upgrading...';

            try {
                const result = await api.upgradeFacility(upgradeKey);
                if (result.success) {
                    // Reload facility data
                    await this._loadFacilityData();

                    // Update player's max grow slots if it's a slot upgrade
                    if (upgradeKey === 'grow_slots') {
                        const player = store.get('player');
                        store.merge('player', {
                            maxPlots: (player.maxPlots || 2) + 1,
                            currency: result.newCash
                        });
                    } else {
                        store.merge('player', { currency: result.newCash });
                    }

                    this.emit('notification', {
                        type: 'success',
                        message: `Upgraded successfully!`
                    });
                    this.render();
                }
            } catch (err) {
                console.error('[CFX] Facility upgrade failed:', err);
                this.emit('notification', {
                    type: 'error',
                    message: err.message || 'Upgrade failed'
                });
            } finally {
                btn.disabled = false;
                btn.textContent = 'Upgrade';
            }
        });

        // Prestige reset handler
        this.on('click', '.cf-prestige-btn', async (e) => {
            const player = this.getState('player') || {};
            if ((player.level || 1) < 10) {
                alert('You must be level 10 or higher to prestige.');
                return;
            }
            if (!confirm('Are you sure? This will reset your progress but grant prestige tokens!')) {
                return;
            }

            const btn = e.currentTarget;
            btn.disabled = true;
            btn.textContent = 'Resetting...';

            try {
                const result = await api.performPrestige();
                if (result.success) {
                    // Reload entire game state after prestige
                    window.location.reload();
                }
            } catch (err) {
                console.error('[CFX] Prestige failed:', err);
                alert(err.message || 'Prestige failed');
            } finally {
                btn.disabled = false;
                btn.textContent = 'Prestige Reset';
            }
        });
    }

    async _updateSetting(key, value) {
        // Update shared store (all components see the change immediately)
        store.set(`settings.${key}`, value);

        // Sync to server
        try {
            const result = await api.updateSettings({ [key]: value });
            if (result.settings) {
                store.loadServerSettings(result.settings);
            }
        } catch (e) {
            console.warn('[More] Settings sync failed:', e);
        }

        // Persist to localStorage as backup
        store._persistSettings();
    }

    render() {
        this.className = 'cf-section cf-section--more';

        if (this._activeSubview) {
            this._renderSubview();
            return;
        }

        this.setContent(
            h('div', { class: 'cf-section__header' },
                h('h2', { class: 'cf-section__title' }, 'More')
            ),

            h('div', { class: 'cf-more-menu' },
                ...MENU_ITEMS.map(item => this._renderMenuItem(item))
            )
        );
    }

    _renderMenuItem(item) {
        return h('button', {
            class: 'cf-more-item',
            dataset: { id: item.id },
            style: {
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-3)',
                width: '100%',
                padding: 'var(--space-3)',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-primary)',
                borderRadius: 'var(--radius-lg)',
                marginBottom: 'var(--space-2)',
                textAlign: 'left'
            }
        },
            h('div', {
                style: {
                    width: '40px',
                    height: '40px',
                    background: 'var(--bg-tertiary)',
                    borderRadius: 'var(--radius-md)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                }
            }, this._renderIcon(item.icon)),

            h('div', { style: { flex: 1 } },
                h('div', { class: 'font-semibold' }, item.label),
                h('div', { class: 'text-xs text-muted' }, item.description)
            ),

            h('span', { style: { color: 'var(--text-muted)' } }, '→')
        );
    }

    _renderSubview() {
        const views = {
            'dashboard': () => this._renderDashboardView(),
            'timers': () => this._renderTimersView(),
            'ai-assistant': () => this._renderAIAssistantView(),
            'daily-rewards': () => this._renderDailyRewardsView(),
            'facilities': () => this._renderFacilitiesView(),
            'expansions': () => this._renderExpansionsView(),
            'training': () => this._renderTrainingView(),
            'breeding-history': () => this._renderBreedingHistoryView(),
            'upgrades': () => this._renderUpgradesView(),
            'permanent-unlocks': () => this._renderPermanentUnlocksView(),
            'favorites': () => this._renderFavoritesView(),
            'market-alerts': () => this._renderMarketAlertsView(),
            'vault': () => this._renderVaultView(),
            'raids': () => this._renderRaidsView(),
            'contracts': () => this._renderContractsView(),
            'extraction': () => this._renderExtractionView(),
            'black-market': () => this._renderBlackMarketView(),
            'mutations': () => this._renderMutationsView(),
            'research': () => this._renderResearchView(),
            'equipment': () => this._renderEquipmentView(),
            'locations': () => this._renderLocationsView(),
            'cartel': () => this._renderCartelView(),
            'territories': () => this._renderTerritoriesView(),
            'tournaments': () => this._renderTournamentsView(),
            'reputation': () => this._renderReputationView(),
            'dispensary': () => this._renderDispensaryView(),
            'minigames': () => this._renderMinigamesView(),
            'bosses': () => this._renderBossesView(),
            'random-events': () => this._renderRandomEventsView(),
            'events': () => this._renderEventsView(),
            'stats': () => this._renderStatsView(),
            'quality-guide': () => this._renderQualityGuideView(),
            'bonuses': () => this._renderBonusesView(),
            trading: () => this._renderTradingView(),
            workers: () => this._renderWorkersView(),
            strains: () => this._renderStrainsView(),
            notifications: () => this._renderNotificationsView(),
            skills: () => this._renderSkillsView(),
            facility: () => this._renderFacilityView(),
            prestige: () => this._renderPrestigeView(),
            leaderboard: () => this._renderLeaderboardView(),
            achievements: () => this._renderAchievementsView(),
            settings: () => this._renderSettingsView()
        };

        const viewRenderer = views[this._activeSubview];
        if (!viewRenderer) {
            this._activeSubview = null;
            this.render();
            return;
        }

        this.setContent(
            // Back button
            h('button', {
                class: 'cf-more__back cf-btn cf-btn--ghost mb-3',
                style: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }
            },
                h('span', {}, '←'),
                h('span', {}, 'Back')
            ),

            // Subview content
            viewRenderer()
        );
    }

    _renderTimersView() {
        return h('div', { class: 'cf-timers-view' },
            h('cf-timers')
        );
    }

    _renderAIAssistantView() {
        return h('div', { class: 'cf-ai-assistant-view' },
            h('cf-ai-assistant')
        );
    }

    _renderRaidsView() {
        return h('div', { class: 'cf-raids-view' },
            h('cf-raids')
        );
    }

    _renderQualityGuideView() {
        return h('div', { class: 'cf-quality-guide-view' },
            h('cf-quality-info')
        );
    }

    _renderBonusesView() {
        return h('div', { class: 'cf-bonuses-view' },
            h('cf-bonuses')
        );
    }

    _renderDailyRewardsView() {
        return h('div', { class: 'cf-daily-rewards-view' },
            h('cf-daily-rewards')
        );
    }

    _renderFacilitiesView() {
        return h('div', { class: 'cf-facilities-view' },
            h('cf-facilities')
        );
    }

    _renderExpansionsView() {
        return h('div', { class: 'cf-expansions-view' },
            h('cf-expansions')
        );
    }

    _renderTrainingView() {
        return h('div', { class: 'cf-training-view' },
            h('cf-training')
        );
    }

    _renderDashboardView() {
        return h('div', { class: 'cf-dashboard-view' },
            h('cf-dashboard')
        );
    }

    _renderBreedingHistoryView() {
        return h('div', { class: 'cf-breeding-history-view' },
            h('cf-breeding-history')
        );
    }

    _renderUpgradesView() {
        return h('div', { class: 'cf-upgrades-view' },
            h('cf-upgrades')
        );
    }

    _renderPermanentUnlocksView() {
        return h('div', { class: 'cf-permanent-unlocks-view' },
            h('cf-permanent-unlocks')
        );
    }

    _renderFavoritesView() {
        return h('div', { class: 'cf-favorites-view' },
            h('cf-favorites')
        );
    }

    _renderMarketAlertsView() {
        return h('div', { class: 'cf-market-alerts-view' },
            h('cf-market-alerts')
        );
    }

    _renderContractsView() {
        return h('div', { class: 'cf-contracts-view' },
            h('cf-contracts')
        );
    }

    _renderExtractionView() {
        return h('div', { class: 'cf-extraction-view' },
            h('cf-extraction')
        );
    }

    _renderBlackMarketView() {
        return h('div', { class: 'cf-black-market-view' },
            h('cf-black-market')
        );
    }

    _renderMutationsView() {
        return h('div', { class: 'cf-mutations-view' },
            h('cf-mutations')
        );
    }

    _renderResearchView() {
        return h('div', { class: 'cf-research-view' },
            h('cf-research')
        );
    }

    _renderEquipmentView() {
        return h('div', { class: 'cf-equipment-view' },
            h('cf-equipment')
        );
    }

    _renderLocationsView() {
        return h('div', { class: 'cf-locations-view' },
            h('cf-locations')
        );
    }

    _renderCartelView() {
        return h('div', { class: 'cf-cartel-view' },
            h('cf-cartel')
        );
    }

    _renderTerritoriesView() {
        return h('div', { class: 'cf-territories-view' },
            h('cf-territories')
        );
    }

    _renderTournamentsView() {
        return h('div', { class: 'cf-tournaments-view' },
            h('cf-tournaments')
        );
    }

    _renderReputationView() {
        return h('div', { class: 'cf-reputation-view' },
            h('cf-reputation')
        );
    }

    _renderDispensaryView() {
        return h('div', { class: 'cf-dispensary-view' },
            h('cf-dispensary')
        );
    }

    _renderMinigamesView() {
        return h('div', { class: 'cf-minigames-view' },
            h('cf-minigames')
        );
    }

    _renderBossesView() {
        return h('div', { class: 'cf-bosses-view' },
            h('cf-bosses')
        );
    }

    _renderRandomEventsView() {
        return h('div', { class: 'cf-random-events-view' },
            h('cf-random-events')
        );
    }

    _renderStatsView() {
        return h('div', { class: 'cf-stats-view' },
            h('cf-stats')
        );
    }

    _renderEventsView() {
        return h('div', { class: 'cf-events-view' },
            h('cf-events')
        );
    }

    _renderVaultView() {
        return h('div', { class: 'cf-vault-view' },
            h('cf-vault')
        );
    }

    _renderTradingView() {
        return h('div', { class: 'cf-trading-view' },
            h('cf-trading')
        );
    }

    _renderWorkersView() {
        return h('div', { class: 'cf-workers-view' },
            h('cf-workers')
        );
    }

    _renderStrainsView() {
        return h('div', { class: 'cf-strains-view' },
            h('cf-strains')
        );
    }

    _renderNotificationsView() {
        return h('div', { class: 'cf-notifications-view' },
            h('cf-notifications')
        );
    }

    _renderSkillsView() {
        return h('div', { class: 'cf-skills-view' },
            h('h2', { class: 'cf-section__title mb-3' }, 'Skill Tree'),
            h('cf-skills')
        );
    }

    _renderFacilityView() {
        const player = this.getState('player') || {};
        const playerCash = player.currency || 0;

        // Load facility data if not loaded
        if (!this._facilityData && !this._facilityLoading) {
            this._loadFacilityData().then(() => this.render());
            return h('div', { class: 'cf-loading' }, h('div', { class: 'cf-spinner' }));
        }

        if (this._facilityLoading) {
            return h('div', { class: 'cf-loading' }, h('div', { class: 'cf-spinner' }));
        }

        const facility = this._facilityData?.facility || {};
        const upgrades = this._facilityData?.upgrades || [];

        return h('div', { class: 'cf-facility-view' },
            h('h2', { class: 'cf-section__title mb-3' }, facility.name || 'My Grow Op'),

            // Current stats
            h('div', { class: 'cf-card mb-3' },
                h('div', { class: 'cf-card__body' },
                    h('div', { style: { display: 'flex', justifyContent: 'space-around', textAlign: 'center' } },
                        h('div', { class: 'cf-stat' },
                            h('span', { class: 'cf-stat__value' }, facility.maxGrowSlots || 2),
                            h('span', { class: 'cf-stat__label' }, 'Grow Slots')
                        ),
                        h('div', { class: 'cf-stat' },
                            h('span', { class: 'cf-stat__value' }, formatCurrency(playerCash, true)),
                            h('span', { class: 'cf-stat__label' }, 'Available')
                        )
                    )
                )
            ),

            // Upgrades list
            h('h3', { class: 'text-sm font-semibold text-muted mb-2' }, 'Upgrades'),
            ...upgrades.map(upgrade => this._renderUpgradeItem(upgrade, playerCash))
        );
    }

    _renderUpgradeItem(upgrade, playerCash) {
        const canAfford = upgrade.nextCost && playerCash >= upgrade.nextCost;
        const isMaxed = upgrade.currentLevel >= upgrade.maxLevel;

        return h('div', {
            class: 'cf-card mb-2',
            style: { opacity: isMaxed ? '0.6' : '1' }
        },
            h('div', {
                class: 'cf-card__body',
                style: { display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }
            },
                // Info
                h('div', { style: { flex: 1 } },
                    h('div', { class: 'font-semibold' }, upgrade.name),
                    h('div', { class: 'text-xs text-muted' }, upgrade.description),
                    h('div', { class: 'text-xs mt-1' },
                        `Level ${upgrade.currentLevel}/${upgrade.maxLevel}`,
                        upgrade.effect?.currentValue > 0 && ` (+${Math.round(upgrade.effect.currentValue * 100)}%)`
                    )
                ),

                // Upgrade button
                !isMaxed && h('button', {
                    class: 'cf-btn cf-btn--primary cf-btn--sm cf-facility-upgrade-btn',
                    dataset: { upgradeKey: upgrade.key },
                    disabled: !canAfford
                },
                    canAfford
                        ? formatCurrency(upgrade.nextCost, true)
                        : 'Need ' + formatCurrency(upgrade.nextCost, true)
                ),

                isMaxed && h('span', { class: 'text-xs text-muted' }, 'MAX')
            )
        );
    }

    _renderPrestigeView() {
        return h('div', { class: 'cf-prestige-view' },
            h('cf-prestige')
        );
    }

    _renderLeaderboardView() {
        return h('div', { class: 'cf-leaderboard-view' },
            h('h2', { class: 'cf-section__title mb-3' }, 'Leaderboard'),
            h('cf-leaderboard')
        );
    }

    _renderAchievementsView() {
        // Achievements are loaded by the cf-achievements component
        return h('div', { class: 'cf-achievements-view' },
            h('h2', { class: 'cf-section__title mb-3' }, 'Achievements'),
            h('cf-achievements')
        );
    }

    _renderSettingsView() {
        return h('div', { class: 'cf-settings-view' },
            h('cf-settings')
        );
    }

    _renderIcon(type) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '20');
        svg.setAttribute('height', '20');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');

        const paths = {
            gift: 'M20 12v10H4V12M22 7H2v5h20V7M12 22V7M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7M12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7',
            heart: 'M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z',
            alert: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9',
            vault: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z',
            clipboard: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01',
            flask: 'M9 3h6v4l4 8H5l4-8V3zM9 3h6M5 15h14',
            skull: 'M12 2a8 8 0 00-8 8c0 3.5 2.3 6.5 5.5 7.5V19a1 1 0 001 1h3a1 1 0 001-1v-1.5c3.2-1 5.5-4 5.5-7.5a8 8 0 00-8-8zm-2 8a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0zm5 0a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z',
            dna: 'M10 2v2a4 4 0 004 4h4v2h-4a4 4 0 00-4 4v2a4 4 0 004 4h4v2M14 2v2a4 4 0 01-4 4H6v2h4a4 4 0 014 4v2a4 4 0 01-4 4H6v2',
            microscope: 'M9 2v1M9 7v4M9 17v5M14 4a1 1 0 011 1v2a1 1 0 01-1 1h-4V4h4zM5 22h14M12 17a5 5 0 100-10 5 5 0 000 10z',
            wrench: 'M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z',
            map: 'M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4zM8 2v16M16 6v16',
            users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
            tournament: 'M6 9H4a2 2 0 01-2-2V5a2 2 0 012-2h2m12 6h2a2 2 0 002-2V5a2 2 0 00-2-2h-2M6 9V5a2 2 0 012-2h8a2 2 0 012 2v4m-12 0a6 6 0 0012 0m-6 6v6m-4-3h8',
            shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
            calendar: 'M19 4H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01M16 18h.01',
            chart: 'M18 20V10M12 20V4M6 20v-6',
            trade: 'M8 7h12l-4 4h4l-8 8 4-8h-4l4-4H8M4 17l-2 4h20l-2-4',
            worker: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
            book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 4.5A2.5 2.5 0 0 1 6.5 2H20v15H6.5A2.5 2.5 0 0 0 4 19.5v-15',
            bell: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0',
            tree: 'M12 2v10m0 0c-4 0-7 3-7 7m7-7c4 0 7 3 7 7M7 19v2m10-2v2',
            building: 'M3 21h18M9 21V12h6v9M9 12H3v9m18-9v9h-6M12 3l9 9H3l9-9z',
            star: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
            trophy: 'M6 9H4a2 2 0 01-2-2V5a2 2 0 012-2h2m12 6h2a2 2 0 002-2V5a2 2 0 00-2-2h-2M6 9V5a2 2 0 012-2h8a2 2 0 012 2v4m-12 0a6 6 0 0012 0m-6 6v6m-4-3h8',
            medal: 'M12 15a3 3 0 100-6 3 3 0 000 6zm0-12l3 3-3 3-3-3 3-3zm0 18v-3m-4-9l-4-4m12 4l4-4',
            gear: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
            store: 'M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2V9zM9 22V12h6v10',
            gamepad: 'M6 11h4M8 9v4M15 12h.01M18 10h.01M17.32 5H6.68a4 4 0 00-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 003 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 019.828 16h4.344a2 2 0 011.414.586L17 18c.5.5 1 1 2 1a3 3 0 003-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0017.32 5z',
            boss: 'M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2zM12 6.5l-1.5 3.5L7 10.5l2.5 2.5l-.5 3.5L12 15l3 1.5l-.5-3.5l2.5-2.5l-3.5-.5L12 6.5z',
            lightning: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
            flag: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7',
            clock: 'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10zM12 6v6l4 2',
            robot: 'M12 2a2 2 0 012 2v1h3a2 2 0 012 2v10a2 2 0 01-2 2H7a2 2 0 01-2-2V7a2 2 0 012-2h3V4a2 2 0 012-2zM9 10a1 1 0 100 2 1 1 0 000-2zm6 0a1 1 0 100 2 1 1 0 000-2zm-5 5h4',
            siren: 'M12 2v2M4.93 4.93l1.41 1.41M2 12h2M4.93 19.07l1.41-1.41M12 20v2M19.07 19.07l-1.41-1.41M22 12h-2M19.07 4.93l-1.41 1.41M12 6a6 6 0 016 6v4H6v-4a6 6 0 016-6z',
            diamond: 'M12 2l6 6-6 14-6-14 6-6zM2 8h20',
            sparkle: 'M12 3v2m0 14v2m9-9h-2M5 12H3m15.36-5.64l-1.41 1.41M7.05 16.95l-1.41 1.41m12.72 0l-1.41-1.41M7.05 7.05L5.64 5.64M12 8a4 4 0 100 8 4 4 0 000-8z',
            factory: 'M2 20V9l6 3V9l6 3V9l6 3v11H2zM6 16v4M10 16v4M14 16v4M18 16v4',
            home: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
            graduation: 'M12 14l9-5-9-5-9 5 9 5zM12 14v7M5 9v6c0 1.5 3.5 3 7 3s7-1.5 7-3V9',
            upgrade: 'M7 11l5-5 5 5M7 17l5-5 5 5',
            unlock: 'M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z'
        };

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', paths[type] || paths.gear);
        svg.appendChild(path);

        return svg;
    }

    _openSubview(id) {
        this._activeSubview = id;
        this.render();
    }
}

registerComponent('cf-more', CFMore);
export default CFMore;
