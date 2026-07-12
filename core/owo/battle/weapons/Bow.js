/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/weapons/Bow.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import WeaponInterface from '../WeaponInterface.js';
import Logs from '../util/logUtil.js';

export default class Bow extends WeaponInterface {
	init() {
		this.id = 3;
		this.name = 'Bow';
		this.basicDesc = 'An accurate bow that will deal alot of damage to a single opponent';
		this.emojis = [
			'<:cbow:535283611260420096>',
			'<:ubow:535283613198188594>',
			'<:rbow:535283613374349316>',
			'<:ebow:535283614334844937>',
			'<:mbow:535283613802168323>',
			'<:lbow:535283613391126529>',
			'<:fbow:535283614099832872>',
		];
		this.pristineEmojis = [
			'<:pcbow:1132227780919165034>',
			'<:pubow:1132229449723678872>',
			'<:prbow:1132229191652347904>',
			'<:pebow:1132228078471479336>',
			'<:pmbow:1132229018855428177>',
			'<:plbow:1132228549663785050>',
			'<:pfbow:1132228241684447322>',
		];
		this.defaultEmoji = '<:bow:538196864277807105>';
		this.statDesc = 'Deals **?%** of your ' + WeaponInterface.strEmoji + 'STR to a random opponent';
		this.availablePassives = 'all';
		this.passiveCount = 1;
		this.qualityList = [[110, 160]];
		this.manaRange = [220, 120];
	}

	attackWeapon(me, team, enemy) {
		if (me.stats.hp[0] <= 0) return;

		/* No mana */
		if (me.stats.wp[0] < this.manaCost) return this.attackPhysical(me, team, enemy);

		/* Grab an enemy that I'm attacking */
		let attacking = WeaponInterface.getAttacking(me, team, enemy);
		if (!attacking) return;

		let logs = new Logs();

		/* deplete weapon points*/
		let mana = WeaponInterface.useMana(me, this.manaCost, me, {
			me,
			allies: team,
			enemies: enemy,
		});
		let manaLogs = new Logs();
		manaLogs.push(`[BOW] ${me.nickname} used ${mana.amount} WP`, mana.logs);

		/* Calculate damage */
		let damage = WeaponInterface.getDamage(me.stats.att, this.stats[0] / 100);

		/* Deal damage */
		damage = WeaponInterface.inflictDamage(me, attacking, damage, WeaponInterface.PHYSICAL, {
			me,
			allies: team,
			enemies: enemy,
		});
		logs.push(
			`[BOW] ${me.nickname} damaged ${attacking.nickname} for ${damage.amount} HP`,
			damage.logs
		);

		logs.addSubLogs(manaLogs);

		return logs;
	}
};
