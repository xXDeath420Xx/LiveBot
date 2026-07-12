/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/passives/Absolve.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import PassiveInterface from '../PassiveInterface.js';
import WeaponInterface from '../WeaponInterface.js';
import Log from '../util/logUtil.js';

export default class Absolve extends PassiveInterface {
	init() {
		this.id = 10;
		this.name = 'Absolve';
		this.basicDesc = '';
		this.emojis = [
			'<:cabsolve:562175422343938059>',
			'<:uabsolve:562175424604536843>',
			'<:rabsolve:562175425556774912>',
			'<:eabsolve:562175424969310227>',
			'<:mabsolve:562175424625639435>',
			'<:labsolve:562175424747143209>',
			'<:fabsolve:562175424965115914>',
		];
		this.statDesc = `When healed, deal **?%** of the healed amount to a random enemy as ${WeaponInterface.magEmoji}MAG damage`;
		this.qualityList = [[60, 80]];
	}

	postHealed(animal, healer, amount, tags) {
		if (tags.has('absolve', animal)) return;
		let totalDamage = (amount.reduce((a, b) => a + b, 0) * this.stats[0]) / 100;
		if (totalDamage < 1) return;

		let logs = new Log();

		/* Grab an enemy that I'm attacking */
		const enemies = tags.getAnimalEnemies(animal);
		const allies = tags.getAnimalAllies(animal);
		let attacking = WeaponInterface.getAttacking(animal, allies, enemies, { ignoreChoose: true });
		if (!attacking) return;

		const tagsCopy = tags.copyAdd('absolve', animal);
		let dmg = WeaponInterface.inflictDamage(
			animal,
			attacking,
			totalDamage,
			WeaponInterface.MAGICAL,
			tagsCopy
		);

		logs.push(
			`[ABSV] ${animal.nickname} damaged ${attacking.nickname} for ${dmg.amount} HP`,
			dmg.logs
		);

		return logs;
	}
};
