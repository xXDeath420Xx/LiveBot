/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/passives/MagicResist.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import PassiveInterface from '../PassiveInterface.js';
import WeaponInterface from '../WeaponInterface.js';

/* +[5~20%] increase in magical resistance*/

export default class MagicalResistance extends PassiveInterface {
	init() {
		this.id = 6;
		this.name = 'Magical Resistance';
		this.basicDesc = 'Increases your Magical Resistance';
		this.emojis = [
			'<:cmr:535290422503800832>',
			'<:umr:535290422919036938>',
			'<:rmr:535290422810116097>',
			'<:emr:535290422226845697>',
			'<:mmr:535290422243622913>',
			'<:lmr:535290422688219146>',
			'<:fmr:535290422252273675>',
		];
		this.statDesc = `Increases your ${WeaponInterface.mrEmoji}MR by **?%**`;
		this.qualityList = [[15, 35]];
	}

	alterStats(stats) {
		let bonus = stats.mr[0] * (this.stats[0] / 100);
		stats.mr[1] += bonus;
	}
};
