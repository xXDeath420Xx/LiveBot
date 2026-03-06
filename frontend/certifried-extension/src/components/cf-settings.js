/**
 * CertiFried Extension - Settings Component
 * User preferences and configuration
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';
import { store } from '../state/store.js';
import { api } from '../api/client.js';

class CFSettings extends CFBaseComponent {
    constructor() {
        super();
        this._settings = {
            notifications: true,
            sound: true,
            autoHarvest: false,
            autoReplant: false,
            workersEnabled: true,
            compactView: false,
            theme: 'dark',
            // Offline automation
            offlineHarvestEnabled: true,
            offlineSellEnabled: false,
            offlinePlantEnabled: false,
            offlineSellMinQuality: 0
        };
        this._isSaving = false;
    }

    _setupSubscriptions() {
        this.subscribe('settings');
    }

    onMount() {
        // Load settings from store (may have localStorage values)
        const storedSettings = this.getState('settings') || {};
        this._settings = { ...this._settings, ...storedSettings };

        // Fetch authoritative settings from server
        this._loadFromServer();

        // Toggle handlers
        this.on('change', '.cf-setting-toggle', async (e) => {
            const setting = e.target.dataset.setting;
            const value = e.target.checked;
            await this._updateSetting(setting, value);
        });

        // Select handlers
        this.on('change', '.cf-setting-select', async (e) => {
            const setting = e.target.dataset.setting;
            const value = e.target.value;
            await this._updateSetting(setting, value);
        });

        // Clear data buttons
        this.on('click', '#clear-cache', () => this._clearCache());
        this.on('click', '#logout', () => this._logout());
    }

    async _loadFromServer() {
        try {
            const result = await api.getSettings();
            if (result.settings) {
                this._settings = { ...this._settings, ...result.settings };
                store.loadServerSettings(result.settings);
            }
        } catch (e) {
            // Fall back to localStorage values already in store
        }
        this.render();
    }

    async _updateSetting(key, value) {
        this._settings[key] = value;

        // Update store (all components reading store.settings will see this)
        store.set(`settings.${key}`, value);

        // Sync to server and merge response back
        try {
            const result = await api.updateSettings({ [key]: value });
            if (result.settings) {
                this._settings = { ...this._settings, ...result.settings };
                store.loadServerSettings(result.settings);
            }
        } catch (e) {
            console.warn('[Settings] Server sync failed:', e);
        }

        // Persist to localStorage as backup
        store._persistSettings();
        this.render();
    }

    _clearCache() {
        localStorage.removeItem('cfx_settings');
        this.emit('notification', {
            type: 'success',
            message: 'Cache cleared. Refresh to apply.'
        });
    }

    _logout() {
        localStorage.removeItem('cfx_token');
        localStorage.removeItem('cfx_settings');
        store.reset();
        window.location.reload();
    }

    render() {
        const player = this.getState('player') || {};

        this.className = 'cf-section cf-settings';
        this.setContent(
            // Header
            h('div', { class: 'cf-section__header' },
                h('h2', { class: 'cf-section__title' }, 'Settings')
            ),

            // Gameplay Settings
            h('div', { class: 'cf-settings-group' },
                h('h3', { class: 'cf-settings-group__title' }, 'Gameplay'),

                this._renderToggle('autoHarvest', 'Auto-Harvest',
                    'Automatically harvest plants when ready'),
                this._renderToggle('autoReplant', 'Auto-Replant',
                    'Automatically replant after harvesting (requires seeds)'),
                this._renderToggle('workersEnabled', 'Enable Workers',
                    'Allow NPC workers to perform automated tasks')
            ),

            // Offline Automation Settings
            h('div', { class: 'cf-settings-group' },
                h('h3', { class: 'cf-settings-group__title' }, 'Offline Automation'),
                h('p', { class: 'text-xs text-muted mb-3' },
                    'These actions happen while you\'re away from the game'
                ),

                this._renderToggle('offlineHarvestEnabled', 'Offline Harvesting',
                    'Automatically harvest ready plants while offline'),
                this._renderToggle('offlineSellEnabled', 'Offline Auto-Sell',
                    'Automatically sell harvested product while offline'),
                this._renderToggle('offlinePlantEnabled', 'Offline Auto-Plant',
                    'Automatically plant seeds in empty slots while offline'),

                this._settings.offlineSellEnabled && h('div', { class: 'cf-setting cf-setting--nested' },
                    h('div', { class: 'cf-setting__info' },
                        h('div', { class: 'cf-setting__label' }, 'Minimum Sell Quality'),
                        h('div', { class: 'cf-setting__desc text-xs text-muted' },
                            'Only sell products at or above this quality'
                        )
                    ),
                    h('select', {
                        class: 'cf-select cf-setting-select',
                        dataset: { setting: 'offlineSellMinQuality' }
                    },
                        h('option', { value: '0', selected: this._settings.offlineSellMinQuality === 0 }, 'Any Quality'),
                        h('option', { value: '25', selected: this._settings.offlineSellMinQuality === 25 }, '25+'),
                        h('option', { value: '50', selected: this._settings.offlineSellMinQuality === 50 }, '50+'),
                        h('option', { value: '75', selected: this._settings.offlineSellMinQuality === 75 }, '75+'),
                        h('option', { value: '90', selected: this._settings.offlineSellMinQuality === 90 }, '90+ (Premium)')
                    )
                )
            ),

            // Notification Settings
            h('div', { class: 'cf-settings-group' },
                h('h3', { class: 'cf-settings-group__title' }, 'Notifications'),

                this._renderToggle('notifications', 'Show Notifications',
                    'Display toast notifications for game events'),
                this._renderToggle('sound', 'Sound Effects',
                    'Play sounds for notifications and actions')
            ),

            // Display Settings
            h('div', { class: 'cf-settings-group' },
                h('h3', { class: 'cf-settings-group__title' }, 'Display'),

                this._renderToggle('compactView', 'Compact View',
                    'Use smaller card sizes to fit more on screen'),
                this._renderSelect('theme', 'Theme', [
                    { value: 'dark', label: 'Dark (Default)' },
                    { value: 'light', label: 'Light' },
                    { value: 'system', label: 'System' }
                ])
            ),

            // Account Info
            h('div', { class: 'cf-settings-group' },
                h('h3', { class: 'cf-settings-group__title' }, 'Account'),

                h('div', { class: 'cf-account-info' },
                    h('div', { class: 'cf-account-info__row' },
                        h('span', { class: 'text-muted' }, 'Player ID'),
                        h('span', {}, player.id || 'Unknown')
                    ),
                    h('div', { class: 'cf-account-info__row' },
                        h('span', { class: 'text-muted' }, 'Display Name'),
                        h('span', {}, player.displayName || 'Unknown')
                    ),
                    h('div', { class: 'cf-account-info__row' },
                        h('span', { class: 'text-muted' }, 'Level'),
                        h('span', {}, `${player.level || 1}`)
                    ),
                    h('div', { class: 'cf-account-info__row' },
                        h('span', { class: 'text-muted' }, 'Prestige'),
                        h('span', {}, `P${player.prestigeLevel || 0}`)
                    )
                )
            ),

            // Danger Zone
            h('div', { class: 'cf-settings-group cf-settings-group--danger' },
                h('h3', { class: 'cf-settings-group__title' }, 'Data'),

                h('div', { class: 'cf-settings-actions' },
                    h('button', {
                        id: 'clear-cache',
                        class: 'cf-btn cf-btn--secondary cf-btn--sm'
                    }, 'Clear Cache'),
                    h('button', {
                        id: 'logout',
                        class: 'cf-btn cf-btn--danger cf-btn--sm'
                    }, 'Logout')
                )
            ),

            // Version info
            h('div', { class: 'cf-settings-footer' },
                h('p', { class: 'text-xs text-muted text-center' },
                    'CertiFried Extension v2.0.0'
                )
            )
        );
    }

    _renderToggle(key, label, description) {
        const value = this._settings[key];

        return h('div', { class: 'cf-setting' },
            h('div', { class: 'cf-setting__info' },
                h('div', { class: 'cf-setting__label' }, label),
                h('div', { class: 'cf-setting__desc text-xs text-muted' }, description)
            ),
            h('label', { class: 'cf-toggle' },
                h('input', {
                    type: 'checkbox',
                    class: 'cf-setting-toggle',
                    dataset: { setting: key },
                    checked: value
                }),
                h('span', { class: 'cf-toggle__slider' })
            )
        );
    }

    _renderSelect(key, label, options) {
        const value = this._settings[key];

        return h('div', { class: 'cf-setting' },
            h('div', { class: 'cf-setting__info' },
                h('div', { class: 'cf-setting__label' }, label)
            ),
            h('select', {
                class: 'cf-select cf-setting-select',
                dataset: { setting: key }
            },
                ...options.map(opt =>
                    h('option', {
                        value: opt.value,
                        selected: value === opt.value
                    }, opt.label)
                )
            )
        );
    }
}

registerComponent('cf-settings', CFSettings);
export default CFSettings;
