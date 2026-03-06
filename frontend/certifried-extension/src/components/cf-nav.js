/**
 * CertiFried Extension - Navigation Component
 * Tab navigation between game sections
 */

import { CFBaseComponent, registerComponent } from './base-component.js';
import { h } from '../utils/dom.js';

const NAV_ITEMS = [
    { id: 'garden', label: 'Garden', icon: 'plant' },
    { id: 'shop', label: 'Shop', icon: 'shop' },
    { id: 'inventory', label: 'Items', icon: 'box' },
    { id: 'market', label: 'Market', icon: 'chart' },
    { id: 'breeding', label: 'Breed', icon: 'dna' },
    { id: 'quests', label: 'Quests', icon: 'star' },
    { id: 'more', label: 'More', icon: 'menu' }
];

class CFNav extends CFBaseComponent {
    _setupSubscriptions() {
        this.subscribe('ui.activeTab');
    }

    onMount() {
        this.on('click', '.cf-nav__item', (e) => {
            const navItem = e.target.closest('.cf-nav__item');
            if (!navItem) return;
            const tab = navItem.dataset.tab;
            this.setState('ui.activeTab', tab);
            this.emit('tab-change', { tab });
        });
    }

    render() {
        const activeTab = this.getState('ui.activeTab') || 'garden';

        this.className = 'cf-nav';
        this.setContent(
            ...NAV_ITEMS.map(item =>
                h('button', {
                    class: `cf-nav__item ${item.id === activeTab ? 'cf-nav__item--active' : ''}`,
                    dataset: { tab: item.id }
                },
                    this._renderIcon(item.icon),
                    h('span', {}, item.label)
                )
            )
        );
    }

    _renderIcon(type) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'cf-nav__icon');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '2');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');

        const paths = {
            plant: 'M12 2v10m0 0c-4 0-7 3-7 7m7-7c4 0 7 3 7 7M7 19v2m10-2v2',
            box: 'M21 8v13H3V8m18 0l-9-6-9 6m18 0H3m9 6v7',
            chart: 'M3 3v18h18M7 16l4-4 4 4 5-6',
            dna: 'M2 12h4m12 0h4M6 12a6 6 0 0112 0m-12 0a6 6 0 0012 0M9 6v12m6-12v12',
            star: 'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
            menu: 'M4 6h16M4 12h16M4 18h16',
            shop: 'M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z'
        };

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', paths[type] || paths.menu);
        svg.appendChild(path);

        return svg;
    }
}

registerComponent('cf-nav', CFNav);
export default CFNav;
