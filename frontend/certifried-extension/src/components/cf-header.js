/**
 * CertiFried Extension - Header Component
 * Displays level, XP bar, and currency
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { formatCurrency, formatXpProgress } from '../utils/format.js';
import { h } from '../utils/dom.js';
import { app } from '../app.js';

class CFHeader extends CFBaseComponent {
    _setupSubscriptions() {
        // Subscribe to player changes and update specific elements
        // Note: store.merge('player', {...}) sends full object, so we extract the field we need
        this.subscribe('player', (value, oldValue, path) => {
            // Get current player state (handles both direct set and merge)
            const player = this.getState('player') || {};

            // Update currency
            this.updateText('[data-bind="currency"]', formatCurrency(player.currency || 0, true));

            // Update premium currency
            this.updateText('[data-bind="premium"]', formatCurrency(player.premiumCurrency || 0, true));
            const premiumEl = this.$('[data-bind="premium-container"]');
            if (premiumEl) premiumEl.style.display = player.premiumCurrency > 0 ? 'flex' : 'none';

            // Update level
            this.updateText('[data-bind="level"]', `Lv.${player.level || 1}`);

            // Update XP bar
            this._updateXpBar();
        });

        this.subscribe('ui.isConnected', (value) => {
            const dot = this.$('.cf-connection__dot');
            if (dot) {
                dot.classList.toggle('cf-connection__dot--offline', !value);
                dot.style.background = value ? 'var(--color-success)' : 'var(--color-error)';
            }
        });
    }

    _updateXpBar() {
        const player = this.getState('player') || {};
        const xp = formatXpProgress(player.xpInLevel || 0, player.xpToNextLevel || 100);
        this.updateAttr('.cf-header__xp-bar', 'style', { width: `${xp.percent}%` });
    }

    onMount() {
        // Logout button handler
        this.on('click', '.cf-header__logout', () => {
            if (confirm('Logout and switch account?')) {
                app.logout();
                window.location.reload();
            }
        });
    }

    render() {
        const player = this.getState('player') || {};
        const isConnected = this.getState('ui.isConnected');

        // Use xpInLevel for progress within current level
        const xp = formatXpProgress(player.xpInLevel || 0, player.xpToNextLevel || 100);

        this.className = 'cf-header';
        this.setContent(
            // Left side: Logo + Level
            h('div', { class: 'cf-header__left' },
                h('span', { class: 'cf-header__title' }, 'CertiFried'),
                h('div', { class: 'cf-header__level' },
                    h('span', { 'data-bind': 'level' }, `Lv.${player.level || 1}`),
                    this._renderConnectionDot(isConnected)
                )
            ),

            // Right side: Currency + Logout
            h('div', { class: 'cf-header__right' },
                // Regular currency
                h('div', { class: 'cf-header__currency' },
                    this._renderCurrencyIcon(),
                    h('span', { 'data-bind': 'currency' }, formatCurrency(player.currency || 0, true))
                ),
                // Premium currency (if any)
                h('div', {
                    class: 'cf-header__currency cf-header__currency--premium',
                    'data-bind': 'premium-container',
                    style: { display: player.premiumCurrency > 0 ? 'flex' : 'none' }
                },
                    this._renderPremiumIcon(),
                    h('span', { 'data-bind': 'premium' }, formatCurrency(player.premiumCurrency || 0, true))
                ),
                // Logout button
                h('button', {
                    class: 'cf-header__logout',
                    title: 'Logout',
                    style: {
                        background: 'none',
                        border: 'none',
                        padding: '4px',
                        cursor: 'pointer',
                        color: 'var(--text-muted)',
                        display: 'flex',
                        alignItems: 'center'
                    }
                }, this._renderLogoutIcon())
            )
        );

        // Add XP bar below main header content
        this._renderXpBar(xp);
    }

    _renderConnectionDot(isConnected) {
        return h('span', {
            class: `cf-connection__dot ${isConnected ? '' : 'cf-connection__dot--offline'}`,
            style: {
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: isConnected ? 'var(--color-success)' : 'var(--color-error)',
                marginLeft: '4px'
            }
        });
    }

    _renderCurrencyIcon() {
        // Simple dollar/coin icon
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'cf-header__currency-icon');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'var(--color-accent-500)');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-1h2v1zm0-3h-2v-1h-1v-2h1v-1h2v1h1v2h-1v1zm0-6h-2V8h-1V6h1V5h2v1h1v2h-1v1z');
        svg.appendChild(path);
        return svg;
    }

    _renderPremiumIcon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'cf-header__currency-icon');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'var(--color-rarity-epic)');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71z');
        svg.appendChild(path);
        return svg;
    }

    _renderLogoutIcon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', '16');
        svg.setAttribute('height', '16');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        // Logout door icon
        const path1 = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path1.setAttribute('d', 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4');
        const path2 = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        path2.setAttribute('points', '16 17 21 12 16 7');
        const path3 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        path3.setAttribute('x1', '21');
        path3.setAttribute('y1', '12');
        path3.setAttribute('x2', '9');
        path3.setAttribute('y2', '12');
        svg.appendChild(path1);
        svg.appendChild(path2);
        svg.appendChild(path3);
        return svg;
    }

    _renderXpBar(xp) {
        // XP bar container
        const xpContainer = h('div', {
            class: 'cf-header__xp',
            style: {
                position: 'absolute',
                bottom: '0',
                left: '0',
                right: '0',
                height: '3px',
                background: 'var(--bg-tertiary)'
            }
        });

        const xpBar = h('div', {
            class: 'cf-header__xp-bar',
            style: {
                height: '100%',
                width: `${xp.percent}%`,
                background: 'linear-gradient(90deg, var(--color-primary-600), var(--color-primary-400))',
                transition: 'width 0.3s ease'
            }
        });

        xpContainer.appendChild(xpBar);
        this.appendChild(xpContainer);

        // Make header relative for absolute XP bar
        this.style.position = 'relative';
    }
}

registerComponent('cf-header', CFHeader);
export default CFHeader;
