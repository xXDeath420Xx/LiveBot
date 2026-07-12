/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/passives/Safeguard.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import PassiveInterface from '../PassiveInterface.js';
import WeaponInterface from '../WeaponInterface.js';
import Log from '../util/logUtil.js';

export default class Safeguard extends PassiveInterface {
	init() {
		this.id = 11;
		this.name = 'Safeguard';
		this.basicDesc = '';
		this.emojis = [
			'<:csafeguard:562175426026405913>',
			'<:usafeguard:562175424852000788>',
			'<:rsafeguard:562175425112178688>',
			'<:esafeguard:562175424701136917>',
			'<:msafeguard:562175425112047626>',
			'<:lsafeguard:562175425061715978>',
			'<:fsafeguard:562175424793411586>',
		];
		this.statDesc = `Negate **?**% of the damage dealt to you with ${WeaponInterface.wpEmoji}WP`;
		this.qualityList = [[20, 40]];
	}

	attacked(animal, attacker, damage, type, tags) {
		if (tags.has('safeguard', animal)) return;

		let negate = (damage[0] * this.stats[0]) / 100;

		/* check if we have enough mana */
		if (animal.stats.wp[0] < negate) negate = animal.stats.wp[0];
		if (negate <= 0) return;

		let logs = new Log();

		const tagsCopy = tags.copyAdd('safeguard', animal);
		let mana = WeaponInterface.useMana(animal, negate, animal, tagsCopy);
		damage[1] -= mana.amount;

		logs.push(`[SGUARD] ${animal.nickname} used mana to negate ${mana.amount} damage`, mana.logs);

		return logs;
	}
};
