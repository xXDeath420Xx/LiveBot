/*
 * CC-BY-NC-SA-4.0 derivative. Ported from upstream OwO Bot via
 * scripts/translate-owo-battle.mjs (2026-04-23).
 * Original: src/commands/commandList/battle/weapons/Orb.js
 * See /LICENSE-OWO-NOTICE.md.
 */
import WeaponInterface from '../WeaponInterface.js';

export default class Orb extends WeaponInterface {
	init() {
		this.id = 6;
		this.name = 'Orb of Potency';
		this.basicDesc = '';
		this.emojis = [
			'<:corb:548783035051409408>',
			'<:uorb:548783216669097994>',
			'<:rorb:548783216610246657>',
			'<:eorb:548783035168849930>',
			'<:morb:548783162646462464>',
			'<:lorb:548783162566901770>',
			'<:forb:548783035244478474>',
		];
		this.pristineEmojis = [
			'<:pcorb:1132227951245664398>',
			'<:puorb:1132229460935049257>',
			'<:prorb:1132229279426564156>',
			'<:peorb:1132228200966144060>',
			'<:pmorb:1132229031429935176>',
			'<:plorb:1132228607763288074>',
			'<:pforb:1132228359791837214>',
		];
		this.defaultEmoji = '<:orb:548783216379559966>';
		this.statDesc = 'This weapon has no active ability, but comes with two passives!';
		this.availablePassives = 'all';
		this.passiveCount = 2;
		this.qualityList = [];
	}
};
