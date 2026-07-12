/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/passives/WeaponPoint.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import PassiveInterface from '../PassiveInterface.js';
import WeaponInterface from '../WeaponInterface.js';

/* +[5~20%] increase in wp*/

export default class WeaponPoint extends PassiveInterface {
	init() {
		this.id = 4;
		this.name = 'Weapon Point';
		this.basicDesc = 'Increases your Weapon Points';
		this.emojis = [
			'<:cwp:535290421207629825>',
			'<:uwp:535290422151610369>',
			'<:rwp:535290422335897600>',
			'<:ewp:535290421593636874>',
			'<:mwp:535290421807415297>',
			'<:lwp:535290421887369216>',
			'<:fwp:535290421237252107>',
		];
		this.statDesc = `Increases your ${WeaponInterface.wpEmoji}WP by **?%**`;
		this.qualityList = [[10, 30]];
	}

	alterStats(stats) {
		let bonus = stats.wp[1] * (this.stats[0] / 100);
		stats.wp[3] += bonus;
	}
};
