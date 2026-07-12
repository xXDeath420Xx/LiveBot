/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/passives/Knowledge.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import PassiveInterface from '../PassiveInterface.js';

export default class Snail extends PassiveInterface {
	init() {
		this.id = 21;
		this.name = 'Knowledge';
		this.basicDesc = '';
		this.emojis = [
			'<:ckno:1155427304663691294>',
			'<:ukno:1155427316000886794>',
			'<:rkno:1155427313857605652>',
			'<:ekno:1155427306437873848>',
			'<:mkno:1155427312234418236>',
			'<:lkno:1155427310355353610>',
			'<:fkno:1155427308480503808>',
		];
		this.statDesc =
			'This passive does not do anything in battle. However, it will give this animal **?%** extra xp after each battle.';
		this.qualityList = [[5, 15]];
	}
};
