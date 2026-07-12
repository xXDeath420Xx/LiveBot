/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/passives/Kamikaze.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import PassiveInterface from '../PassiveInterface.js';
import WeaponInterface from '../WeaponInterface.js';
import Log from '../util/logUtil.js';

/* +[10~25%] thorns*/

export default class Kamikaze extends PassiveInterface {
	init() {
		this.id = 14;
		this.name = 'Kamikaze';
		this.basicDesc = '';
		this.emojis = [
			'<:ckkaze:619835003664072711>',
			'<:ukkaze:619834825486106624>',
			'<:rkkaze:619834825330655242>',
			'<:ekkaze:619834825293168650>',
			'<:mkkaze:619834825309814786>',
			'<:lkkaze:619834825699754004>',
			'<:fkkaze:619834825217671168>',
		];
		this.statDesc = `When the animal dies, deal **?%** of its max ${WeaponInterface.hpEmoji}HP as ${WeaponInterface.magEmoji}MAG dmg to the attacker`;
		this.qualityList = [[50, 75]];
	}

	postAttacked(animal, attacker, totalDamage, type, tags) {
		if (tags.has('kamikaze', animal)) return;
		// Only active when dead
		if (animal.stats.hp[0] > 0) return;

		let logs = new Log();

		let dmg = WeaponInterface.getDamageFromHpWp(animal.stats.hp, this.stats[0] / 100);
		const tagsCopy = tags.copyAdd('kamikaze', animal);
		dmg = WeaponInterface.inflictDamage(animal, attacker, dmg, WeaponInterface.MAGICAL, tagsCopy);

		logs.push(
			`[KKAZE] ${animal.nickname} died and damaged ${attacker.nickname} for ${dmg.amount} HP`,
			dmg.logs
		);

		return logs;
	}
};
