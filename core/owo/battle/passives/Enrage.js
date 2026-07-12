/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/passives/Enrage.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import PassiveInterface from '../PassiveInterface.js';
import Log from '../util/logUtil.js';

export default class Enrage extends PassiveInterface {
	init() {
		this.id = 18;
		this.name = 'Enrage';
		this.basicDesc = '';
		this.emojis = [
			'<:cenrage:621558016927596577>',
			'<:uenrage:621558017887830017>',
			'<:renrage:621558018210922527>',
			'<:eenrage:621558017933967360>',
			'<:menrage:621558018034761758>',
			'<:lenrage:621558017996881930>',
			'<:fenrage:621558017569062933>',
		];
		this.statDesc = 'Every 10% of missing health gives +**?%** damage';
		this.qualityList = [[1, 4]];
	}

	attack(animal, attackee, damage, _type, _tags) {
		let maxHP = animal.stats.hp[1] + animal.stats.hp[3];
		let currentHP = animal.stats.hp[0];
		if (currentHP >= maxHP) return;

		let logs = new Log();

		let percentMissing = (1 - currentHP / maxHP) * (100 / 10);
		let extraDamage = damage[0] * (this.stats[0] / 100) * percentMissing;
		if (Math.floor(extraDamage) <= 0) return;
		damage[1] += extraDamage;

		logs.push(`[ENRA] ${animal.nickname} dealt ${Math.round(extraDamage)} extra damage`);
		return logs;
	}
};
