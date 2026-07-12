/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/passives/Discharge.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import PassiveInterface from '../PassiveInterface.js';
import WeaponInterface from '../WeaponInterface.js';
import Log from '../util/logUtil.js';

export default class Discharge extends PassiveInterface {
	init() {
		this.id = 13;
		this.name = 'Discharge';
		this.basicDesc = '';
		this.emojis = [
			'<:cdischarge:572285186864185344>',
			'<:udischarge:572285186897739777>',
			'<:rdischarge:572285186599944204>',
			'<:edischarge:572285187044671489>',
			'<:mdischarge:572285187048734722>',
			'<:ldischarge:572285187023699988>',
			'<:fdischarge:572285187002466364>',
		];
		this.statDesc = `When ${WeaponInterface.wpEmoji}WP is replenished, deal **?%** of the replenished amount to a random enemy as ${WeaponInterface.magEmoji}MAG damage`;
		this.qualityList = [[100, 140]];
	}

	postReplenished(animal, from, amount, tags) {
		/* Ignore if tags.thorns flag is true */
		if (tags.has('discharge', animal)) return;
		let totalDamage = (amount.reduce((a, b) => a + b, 0) * this.stats[0]) / 100;
		if (totalDamage < 1) return;

		let logs = new Log();

		/* Grab an enemy that I'm attacking */
		const enemies = tags.getAnimalEnemies(animal);
		const allies = tags.getAnimalAllies(animal);
		let attacking = WeaponInterface.getAttacking(animal, allies, enemies, { ignoreChoose: true });
		if (!attacking) return;

		const tagsCopy = tags.copyAdd('discharge', animal);
		let dmg = WeaponInterface.inflictDamage(
			animal,
			attacking,
			totalDamage,
			WeaponInterface.MAGICAL,
			tagsCopy
		);

		logs.push(
			`[DISCH] ${animal.nickname} damaged ${attacking.nickname} for ${dmg.amount} HP`,
			dmg.logs
		);

		return logs;
	}
};
