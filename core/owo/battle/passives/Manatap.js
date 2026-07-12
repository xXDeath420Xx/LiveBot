/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/passives/Manatap.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import PassiveInterface from '../PassiveInterface.js';
import WeaponInterface from '../WeaponInterface.js';
import Log from '../util/logUtil.js';

export default class ManaTap extends PassiveInterface {
	init() {
		this.id = 9;
		this.name = 'Mana Tap';
		this.basicDesc = '';
		this.emojis = [
			'<:cmanatap:562175424742948865>',
			'<:umanatap:562175425028292618>',
			'<:rmanatap:562175424902332446>',
			'<:emanatap:562175424814120970>',
			'<:mmanatap:562175424918978580>',
			'<:lmanatap:562175425175093279>',
			'<:fmanatap:562175424403079199>',
		];
		this.statDesc =
			'All damage you deal replenishes your ' +
			WeaponInterface.wpEmoji +
			'WP for **?%** of the damage dealt!';
		this.qualityList = [[15, 30]];
	}

	postAttack(animal, attackee, totalDamage, type, tags) {
		let logs = new Log();

		let mana = (totalDamage * this.stats[0]) / 100;
		mana = WeaponInterface.replenish(animal, mana, animal, tags);

		logs.push(`[MTAP] ${animal.nickname} replenished ${mana.amount} WP`, mana.logs);
		return logs;
	}
};
