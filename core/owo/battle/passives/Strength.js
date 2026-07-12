/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/passives/Strength.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import PassiveInterface from '../PassiveInterface.js';
import WeaponInterface from '../WeaponInterface.js';

/* +[5~20%] increase in strength */

export default class Strength extends PassiveInterface {
	init() {
		this.id = 1;
		this.name = 'Strength';
		this.basicDesc = 'Increases your Strength';
		this.emojis = [
			'<:catt:535290412143738880>',
			'<:uatt:535290420822016010>',
			'<:ratt:535290420255522855>',
			'<:eatt:535290419722977280>',
			'<:matt:535290420150665216>',
			'<:latt:535290420029030400>',
			'<:fatt:535290419903463436>',
		];
		this.statDesc = `Increases your ${WeaponInterface.strEmoji}STR by **?%**`;
		this.qualityList = [[5, 20]];
	}

	alterStats(stats) {
		let bonus = stats.att[0] * (this.stats[0] / 100);
		stats.att[1] += bonus;
	}
};
