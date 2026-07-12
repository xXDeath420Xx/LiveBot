/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/passives/Lifesteal.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import PassiveInterface from '../PassiveInterface.js';
import WeaponInterface from '../WeaponInterface.js';
import Log from '../util/logUtil.js';

/* +[10~25%] lifesteal*/

export default class Lifesteal extends PassiveInterface {
	init() {
		this.id = 7;
		this.name = 'Lifesteal';
		this.basicDesc = 'All attacks heal you!';
		this.emojis = [
			'<:clifesteal:548729308038955018>',
			'<:ulifesteal:548729400477089793>',
			'<:rlifesteal:548729400493867018>',
			'<:elifesteal:548729398644178944>',
			'<:mlifesteal:548729400078893057>',
			'<:llifesteal:548729400447729664>',
			'<:flifesteal:548729400473026560>',
		];
		this.statDesc = 'All damage you deal heals you for **?%** of the damage dealt!';
		this.qualityList = [[15, 35]];
	}

	postAttack(animal, attackee, totalDamage, type, tags) {
		if (tags.has('lifesteal', animal) || tags.has('kamikaze', animal) || animal.stats.hp[0] <= 0)
			return;

		let logs = new Log();
		let heal = (totalDamage * this.stats[0]) / 100;
		const tagsCopy = tags.copyAdd('lifesteal', animal);
		heal = WeaponInterface.heal(animal, heal, animal, tagsCopy);

		logs.push(`[LIFESTEAL] ${animal.nickname} heals for ${heal.amount} HP`, heal.logs);
		return logs;
	}
};
