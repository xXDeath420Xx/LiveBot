/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/weapons/HealStaff.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import WeaponInterface from '../WeaponInterface.js';
import Logs from '../util/logUtil.js';

export default class HealStaff extends WeaponInterface {
	init() {
		this.id = 2;
		this.name = 'Healing Staff';
		this.basicDesc = 'A staff that can heal allies!';
		this.emojis = [
			'<:chealstaff:535283616016498688>',
			'<:uhealstaff:535283616096321547>',
			'<:rhealstaff:535283616100646912>',
			'<:ehealstaff:535283615664439300>',
			'<:mhealstaff:535283616242991115>',
			'<:lhealstaff:535283616209567764>',
			'<:fhealstaff:535283617019068426>',
		];
		this.pristineEmojis = [
			'<:pchstaff:1132227787709747231>',
			'<:puhstaff:1132229457852256317>',
			'<:prhstaff:1132229199457951745>',
			'<:pehstaff:1132228197505839215>',
			'<:pmhstaff:1132229028204519474>',
			'<:plhstaff:1132228557133844541>',
			'<:pfhstaff:1132228356201513040>',
		];
		this.defaultEmoji = '<:healstaff:538196865410138125>';
		this.statDesc = `Heals **?%** of your ${WeaponInterface.magEmoji}MAG to the lowest health ally. This weapon can overheal up to 50% of max ${WeaponInterface.hpEmoji}HP.`;
		this.availablePassives = 'all';
		this.passiveCount = 1;
		this.qualityList = [[100, 150]];
		this.manaRange = [225, 150];
	}

	attackWeapon(me, team, enemy) {
		if (me.stats.hp[0] <= 0) return;

		/* No mana */
		if (me.stats.wp[0] < this.manaCost) return this.attackPhysical(me, team, enemy);

		let logs = new Logs();

		/* Grab lowest hp */
		let lowest = WeaponInterface.getLowestHp(team);
		if (!lowest || WeaponInterface.isMaxHp(lowest, { overheal: true }))
			return this.attackPhysical(me, team, enemy);

		/* Calculate heal */
		let heal = WeaponInterface.getDamage(me.stats.mag, this.stats[0] / 100);

		/* deplete weapon points*/
		let mana = WeaponInterface.useMana(me, this.manaCost, me, {
			me,
			allies: team,
			enemies: enemy,
		});
		let manaLogs = new Logs();
		manaLogs.push(`[HSTAFF] ${me.nickname} used ${mana.amount} WP`, mana.logs);

		/* Heal ally */
		heal = WeaponInterface.heal(
			lowest,
			heal,
			me,
			{
				me,
				allies: team,
				enemies: enemy,
			},
			{ overheal: true }
		);
		logs.push(`[HSTAFF] ${me.nickname} healed ${lowest.nickname} for ${heal.amount} HP`, heal.logs);

		logs.addSubLogs(manaLogs);

		return logs;
	}
};
