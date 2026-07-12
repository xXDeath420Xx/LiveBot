/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/passives/Thorns.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import PassiveInterface from '../PassiveInterface.js';
import WeaponInterface from '../WeaponInterface.js';
import Log from '../util/logUtil.js';

/* +[10~25%] thorns*/

export default class Thorns extends PassiveInterface {
	init() {
		this.id = 8;
		this.name = 'Thorns';
		this.basicDesc = 'Reflect a percent of the damage dealt to you!';
		this.emojis = [
			'<:cthorns:548729308030566426>',
			'<:uthorns:548729400661639168>',
			'<:rthorns:548729400628346900>',
			'<:ethorns:548729400632410122>',
			'<:mthorns:548729400607113216>',
			'<:lthorns:548729400649187338>',
			'<:fthorns:548729400468963329>',
		];
		this.statDesc = 'Reflect **?**% of the damage dealt to you as true damage';
		this.qualityList = [[15, 35]];
	}

	postAttacked(animal, attacker, totalDamage, type, tags) {
		/* Ignore if tags.thorns flag is true */
		if (tags.has('thorns', animal)) return;
		if (animal.stats.hp[0] <= 0) return;
		let damage = (totalDamage * this.stats[0]) / 100;
		if (damage < 1) return;

		let logs = new Log();

		const tagsCopy = tags.copyAdd('thorns', animal);
		let dmg = WeaponInterface.inflictDamage(
			animal,
			attacker,
			damage,
			WeaponInterface.TRUE,
			tagsCopy
		);

		logs.push(
			`[THORNS] ${animal.nickname} damaged ${attacker.nickname} for ${dmg.amount} HP`,
			dmg.logs
		);

		return logs;
	}
};
