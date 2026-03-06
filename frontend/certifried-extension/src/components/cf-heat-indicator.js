/**
 * Heat Indicator Component
 * Shows current DEA heat level and raid risk
 * Note: innerHTML is used safely here - all values are from the trusted game state, not user input
 */

import { CFBaseComponent } from './base-component.js';
import { h } from '../utils/dom.js';

const HEAT_COLORS = {
    cold: '#22c55e',      // green
    warm: '#eab308',      // yellow
    hot: '#f97316',       // orange
    scorching: '#ef4444', // red
    inferno: '#dc2626'    // dark red
};

const HEAT_ICONS = {
    cold: 'M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z',
    warm: 'M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z',
    hot: 'M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z',
    scorching: 'M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657z',
    inferno: 'M17.657 18.657A8 8 0 016.343 7.343S7 9 9 10c0-2 .5-5 2.986-7C14 5 16.09 5.777 17.656 7.343A7.975 7.975 0 0120 13a7.975 7.975 0 01-2.343 5.657zM9.879 16.121A3 3 0 1012.015 11L11 14H9c0 .768.293 1.536.879 2.121z'
};

class CFHeatIndicator extends CFBaseComponent {
    constructor() {
        super();
        this.attachShadow({ mode: 'open' });
        this._heat = null;
    }

    _setupSubscriptions() {
        // Subscribe to raid status changes
        this.subscribe('game.raidStatus', (value) => {
            if (value) {
                this._heat = value.heat;
                this.scheduleRender();
            }
        });
    }

    async onMount() {
        // Get initial raid status from store
        const raidStatus = this.getState('game.raidStatus');
        if (raidStatus) {
            this._heat = raidStatus.heat;
        }

        // If no heat data from store, fetch from API
        if (!this._heat) {
            try {
                const { api } = await import('../api/client.js');
                const response = await api.getRaidStatus();
                if (response && response.success !== false) {
                    this._heat = response.status?.heat || response.heat || {
                        current: response.heatLevel || 0,
                        status: response.heatStatus || 'cold',
                        actualChance: (response.raidChance || 0) / 100
                    };
                    // Also update store so other components can use it
                    const { store } = await import('../state/store.js');
                    store.set('game.raidStatus', response.status || response);
                    store.merge('heat', {
                        current: this._heat.current || 0,
                        status: this._heat.status || 'cold',
                        raidChance: Math.round((this._heat.actualChance || 0) * 100)
                    });
                    this.scheduleRender();
                }
            } catch (err) {
                // Raid endpoint may not be available, that's ok
            }
        }
    }

    render() {
        // Clear existing content
        while (this.shadowRoot.firstChild) {
            this.shadowRoot.removeChild(this.shadowRoot.firstChild);
        }

        if (!this._heat) {
            return;
        }

        const status = this._heat.status || 'cold';
        const current = this._heat.current || 0;
        const color = HEAT_COLORS[status] || HEAT_COLORS.cold;
        const iconPath = HEAT_ICONS[status] || HEAT_ICONS.cold;
        const percentage = Math.min(100, (current / 150) * 100);

        // Create styles
        const style = document.createElement('style');
        style.textContent = `
            :host {
                display: inline-flex;
                align-items: center;
                gap: 8px;
                padding: 4px 10px;
                background: rgba(0,0,0,0.4);
                border-radius: 6px;
                font-size: 12px;
                cursor: pointer;
                transition: all 0.2s;
                position: relative;
            }
            :host(:hover) {
                background: rgba(0,0,0,0.6);
            }
            .heat-icon {
                width: 18px;
                height: 18px;
                color: ${color};
            }
            .heat-bar {
                width: 50px;
                height: 6px;
                background: rgba(255,255,255,0.1);
                border-radius: 3px;
                overflow: hidden;
            }
            .heat-fill {
                height: 100%;
                width: ${percentage}%;
                background: ${color};
                transition: width 0.3s, background 0.3s;
            }
            .heat-label {
                color: ${color};
                font-weight: 600;
                text-transform: uppercase;
                font-size: 10px;
            }
            .tooltip {
                display: none;
                position: absolute;
                top: 100%;
                left: 50%;
                transform: translateX(-50%);
                margin-top: 8px;
                padding: 8px 12px;
                background: #1f2937;
                border: 1px solid #374151;
                border-radius: 6px;
                font-size: 11px;
                white-space: nowrap;
                z-index: 100;
            }
            :host(:hover) .tooltip {
                display: block;
            }
        `;

        // Create icon
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('class', 'heat-icon');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('stroke-width', '2');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('stroke-linecap', 'round');
        path.setAttribute('stroke-linejoin', 'round');
        path.setAttribute('d', iconPath);
        icon.appendChild(path);

        // Create bar
        const bar = document.createElement('div');
        bar.className = 'heat-bar';
        const fill = document.createElement('div');
        fill.className = 'heat-fill';
        bar.appendChild(fill);

        // Create label
        const label = document.createElement('span');
        label.className = 'heat-label';
        label.textContent = status;

        // Create tooltip
        const tooltip = document.createElement('div');
        tooltip.className = 'tooltip';
        tooltip.textContent = `Heat: ${current} | Raid Chance: ${Math.round((this._heat.actualChance || 0) * 100)}%`;

        // Append all elements
        this.shadowRoot.appendChild(style);
        this.shadowRoot.appendChild(icon);
        this.shadowRoot.appendChild(bar);
        this.shadowRoot.appendChild(label);
        this.shadowRoot.appendChild(tooltip);

        // Click handler
        this.onclick = () => {
            this.emit('navigate', { view: 'more', subview: 'vault' });
        };
    }
}

customElements.define('cf-heat-indicator', CFHeatIndicator);
export default CFHeatIndicator;
