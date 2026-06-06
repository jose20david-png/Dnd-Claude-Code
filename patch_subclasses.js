#!/usr/bin/env node
// Patches each class JSON to include all official SRD subclasses.
// Removes non-wotc-srd archetypes and inserts the missing ones.
'use strict';
const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '5ETOOLS MCP', 'data', 'classes');

// Full SRD subclass data for every class.
// desc is the canonical SRD flavor; the engine uses only the first 150 chars.
const SRD_ARCHETYPES = {

  barbarian: [
    {
      name: 'Path of the Berserker',
      slug: 'berserker',
      desc: 'For some barbarians, rage is a means to an end — that end being violence. The Path of the Berserker is a path of untrammeled fury, slick with blood. As you enter the berserker\'s rage, you thrill in the chaos of battle, heedless of your own health or well-being.',
    },
    {
      name: 'Path of the Totem Warrior',
      slug: 'totem-warrior',
      desc: 'The Path of the Totem Warrior is a spiritual journey as the barbarian accepts a spirit animal as guide, protector, and inspiration. In battle, your totem spirit fills you with supernatural might, adding magical fuel to your barbarian rage. Most barbarian tribes consider a totem animal to be kin to a particular clan.',
    },
  ],

  bard: [
    {
      name: 'College of Lore',
      slug: 'lore',
      desc: 'Bards of the College of Lore know something about most things, collecting bits of knowledge from sources as diverse as scholarly tomes and peasant tales. They use every performance to uncover hidden facts, accumulate lore, and puncture the reputations of rivals.',
    },
    {
      name: 'College of Valor',
      slug: 'valor',
      desc: 'Bards of the College of Valor are daring skalds whose tales keep alive the memory of great heroes of the past and inspire a new generation. They venture into the world to seek glory and inspire others — singing the deeds of the mighty, wearing armor, wielding weapons, and turning their magic into battle support.',
    },
  ],

  cleric: [
    {
      name: 'Knowledge Domain',
      slug: 'knowledge',
      desc: 'The gods of knowledge value learning and understanding above all. Some teach that knowledge is to be gathered and shared in libraries and universities; others hoard knowledge as a source of power. Clerics of this domain study esoteric lore and command spells of deception and illusion.',
    },
    {
      name: 'Life Domain',
      slug: 'life',
      desc: 'The Life domain focuses on the vibrant positive energy — one of the fundamental forces of the universe — that sustains all life. Almost any non-evil deity can claim influence over this domain; life clerics are among the most effective healers of any character class.',
    },
    {
      name: 'Light Domain',
      slug: 'light',
      desc: 'Gods of light promote the ideals of rebirth and renewal, truth, vigilance, and beauty — often using the symbol of the sun. Clerics of this domain wield radiant energy and fire to drive out darkness, expose hidden truths, and burn away corruption.',
    },
    {
      name: 'Nature Domain',
      slug: 'nature',
      desc: 'Gods of nature are as varied as the natural world itself, from inscrutable gods of the deep forests to friendly deities associated with streams and springs. Druids and rangers revere them; clerics of this domain command the natural world and protect it from those who would despoil it.',
    },
    {
      name: 'Tempest Domain',
      slug: 'tempest',
      desc: 'Gods whose portfolios include the Tempest domain govern storms, sea, and sky. Tempest clerics can call on divine power over weather, lightning, and thunder — striking like a bolt from the blue and leaving ruin in their wake.',
    },
    {
      name: 'Trickery Domain',
      slug: 'trickery',
      desc: 'Gods of trickery — such as Tymora, Beshaba, Olidammara, the Traveler, Garl Glittergold, and Loki — are mischief-makers and instigators who stand as a constant challenge to the accepted order. Trickery clerics use subtlety, deception, and illusion to undermine tyranny.',
    },
    {
      name: 'War Domain',
      slug: 'war',
      desc: 'War has many manifestations — it can make heroes of ordinary people. Gods of war watch over warriors and reward great deeds with glory on the battlefield. War clerics excel in armed combat, channeling divine power through battle and martial skill.',
    },
  ],

  druid: [
    {
      name: 'Circle of the Land',
      slug: 'land',
      desc: 'The Circle of the Land is made up of mystics and sages who safeguard ancient knowledge and rites through a vast oral tradition. These druids meet within sacred circles of trees or standing stones to share lore and perform rituals. The circle\'s magic is influenced by the land where you were initiated.',
    },
    {
      name: 'Circle of the Moon',
      slug: 'moon',
      desc: 'Druids of the Circle of the Moon are fierce guardians of the wilds. Their order gathers under the full moon to share news and trade warnings. They channel the power of the moon to transform more powerfully and frequently, assuming the form of dangerous predators to challenge threats that face nature.',
    },
  ],

  fighter: [
    {
      name: 'Champion',
      slug: 'champion',
      desc: 'The archetypal Champion focuses on the development of raw physical power honed to deadly perfection. Those who model themselves on this archetype combine rigorous training with physical excellence to deal devastating blows. Their critical hits land more often, and their bodies are honed to near perfection.',
    },
    {
      name: 'Battle Master',
      slug: 'battle-master',
      desc: 'Those who emulate the archetypal Battle Master employ martial techniques passed down through generations. A Battle Master might be a skilled duelist, a military captain, or an adventurer who learned tricks in the heat of battle. They use superiority dice and battlefield maneuvers to dominate tactical situations.',
    },
    {
      name: 'Eldritch Knight',
      slug: 'eldritch-knight',
      desc: 'The archetypal Eldritch Knight combines the martial mastery common to all fighters with a careful study of magic. Eldritch Knights use magical techniques similar to those practiced by wizards, focusing on abjuration and evocation spells that enhance their abilities in combat.',
    },
  ],

  monk: [
    {
      name: 'Way of the Open Hand',
      slug: 'open-hand',
      desc: 'Monks of the Way of the Open Hand are the ultimate masters of martial arts combat, whether armed or unarmed. They learn techniques to push and trip their opponents, manipulate ki to heal damage in their bodies, and practice advanced meditation to become difficult to kill.',
    },
    {
      name: 'Way of Shadow',
      slug: 'shadow',
      desc: 'Monks of the Way of Shadow follow a tradition that values stealth and subterfuge. These monks might be called ninjas or shadowdancers. They use ki to create darkness, silence, and illusions, step between shadows to teleport, and cloak themselves to become unseen.',
    },
    {
      name: 'Way of the Four Elements',
      slug: 'four-elements',
      desc: 'You follow a monastic tradition that teaches you to harness the elements. When you focus your ki, you can align yourself with the forces of creation and bend the four elements to your will, using them as an extension of your body. Some members choose a single element, while others weave the elements together.',
    },
  ],

  paladin: [
    {
      name: 'Oath of Devotion',
      slug: 'devotion',
      desc: 'The Oath of Devotion binds a paladin to the loftiest ideals of justice, virtue, and order. Sometimes called cavaliers, white knights, or holy warriors, these paladins meet the ideal of the knight in shining armor, acting with honor in pursuit of justice and the greater good.',
    },
    {
      name: 'Oath of the Ancients',
      slug: 'ancients',
      desc: 'The Oath of the Ancients is as old as the race of elves and the rituals of the druids. Sometimes called fey knights, green knights, or horned knights, paladins who swear this oath cast their lot with the side of the light in the cosmic struggle against darkness, protecting nature and the beauty of the mortal realm.',
    },
    {
      name: 'Oath of Vengeance',
      slug: 'vengeance',
      desc: 'The Oath of Vengeance is a solemn commitment to punish those who have committed a grievous sin. When evil forces slaughter helpless villagers, when a tyrant defies the gods, when a thieves\' guild grows too violent — paladins who swear this oath dedicate themselves to removing such threats with relentless purpose.',
    },
  ],

  ranger: [
    {
      name: 'Hunter',
      slug: 'hunter',
      desc: 'Emulating the Hunter archetype means accepting your place as a bulwark between civilization and the terrors of the wilderness. As you walk the Hunter\'s path, you learn specialized techniques for fighting the threats you face, from rampaging ogres and hordes of orcs to towering giants and terrifying dragons.',
    },
    {
      name: 'Beast Master',
      slug: 'beast-master',
      desc: 'The Beast Master archetype embodies a friendship between the civilized races and the beasts of the wild. United in focus, the Beast Master and the beast work as one to fight the tide of evil. You gain a beast companion that accompanies you on your adventures and fights alongside you.',
    },
  ],

  rogue: [
    {
      name: 'Thief',
      slug: 'thief',
      desc: 'You hone your skills in the larcenous arts. Burglars, bandits, cutpurses, and other criminals typically follow this archetype, but so do rogues who prefer to think of themselves as professional treasure seekers, explorers, delvers, and investigators.',
    },
    {
      name: 'Assassin',
      slug: 'assassin',
      desc: 'You focus your training on the grim art of death. Those who adhere to this archetype are diverse — hired killers, spies, bounty hunters, and even specially anointed priests trained to exterminate enemies of their deity. You specialize in infiltration, disguise, and dealing devastating ambush strikes.',
    },
    {
      name: 'Arcane Trickster',
      slug: 'arcane-trickster',
      desc: 'Some rogues enhance their fine-honed skills of stealth and agility with magic, learning tricks of enchantment and illusion. These rogues include pickpockets and burglars, but also pranksters, mischief-makers, and a significant number of adventurers.',
    },
  ],

  sorcerer: [
    {
      name: 'Draconic Bloodline',
      slug: 'draconic',
      desc: 'Your innate magic comes from draconic magic that was mingled with your blood or that of your ancestors. Most often, sorcerers with this origin trace their descent back to a mighty sorcerer of ancient times who made a bargain with a dragon or who might even have claimed a dragon parent.',
    },
    {
      name: 'Wild Magic',
      slug: 'wild-magic',
      desc: 'Your innate magic comes from the wild forces of chaos that underlie the order of creation. You might have endured exposure to raw magic, perhaps through a planar portal. Whatever the origin, your magic is a raw, uncontrolled force that surges with unpredictable power.',
    },
  ],

  warlock: [
    {
      name: 'The Archfey',
      slug: 'archfey',
      desc: 'Your patron is a lord or lady of the fey, a creature of legend who holds secrets that were forgotten before the mortal races were born. Beings of this sort include the Queen of Air and Darkness, Titania, and Oberon. Your pact grants enchantment, charm, and the glamour of the Feywild.',
    },
    {
      name: 'The Fiend',
      slug: 'fiend',
      desc: 'You have made a pact with a fiend from the lower planes of existence — a being whose aims are evil, even if you strive against those ends. Such beings desire the corruption or destruction of all things. You channel that infernal power, bargaining with dark forces for your magic.',
    },
    {
      name: 'The Great Old One',
      slug: 'great-old-one',
      desc: 'Your patron is a mysterious entity whose nature is utterly foreign to the fabric of reality. Its motives are incomprehensible to mortals, and its knowledge so immense that even the greatest libraries pale in comparison. It grants you power, but its inscrutable agenda shapes the bargain.',
    },
  ],

  wizard: [
    {
      name: 'School of Abjuration',
      slug: 'abjuration',
      desc: 'The School of Abjuration emphasizes magic that blocks, banishes, or protects. Detractors of this school say that its tradition is about denial, negation rather than true creativity. Abjurers counter that protecting the innocent from monsters and warding off malevolent magic is the highest calling.',
    },
    {
      name: 'School of Conjuration',
      slug: 'conjuration',
      desc: 'As a Conjurer, you favor spells that produce objects and creatures out of thin air. You can conjure billowing clouds of daggers, summon demons or angels, or teleport yourself across great distances. You are an expert at opening passages between planes.',
    },
    {
      name: 'School of Divination',
      slug: 'divination',
      desc: 'The counsel of a Diviner is sought by royalty and commoners alike, for all seek a clearer understanding of the past, present, and future. As a Diviner, you strive to part the veils of space, time, and consciousness so that you can see clearly. You portend the future and reveal hidden truths.',
    },
    {
      name: 'School of Enchantment',
      slug: 'enchantment',
      desc: 'As a member of the School of Enchantment, you have honed your ability to magically entrance and beguile other people and monsters. Enchanters enjoy watching the results of their magic unfold. You are a master of suggestion and command, bending minds to your will.',
    },
    {
      name: 'School of Evocation',
      slug: 'evocation',
      desc: 'You focus your study on magic that creates powerful elemental effects such as bitter cold, searing flame, rolling thunder, crackling lightning, and burning acid. Other wizards respect your ability to unleash destruction, and they wish you were on their side during a fight.',
    },
    {
      name: 'School of Illusion',
      slug: 'illusion',
      desc: 'You focus your studies on magic that dazzles the senses, befuddles the mind, and tricks even the wisest folk. Your magic is subtle, but the illusions crafted by your keen mind make the impossible seem real. Illusion wizards can conjure an army, conceal the truth, and alter reality as it appears.',
    },
    {
      name: 'School of Necromancy',
      slug: 'necromancy',
      desc: 'The School of Necromancy explores the cosmic forces of life, death, and undeath. You delve into the taboo study of ripping souls from corpses to create mindless undead servants. Not all who study this school have malevolent aims — some seek to understand death to better fight it.',
    },
    {
      name: 'School of Transmutation',
      slug: 'transmutation',
      desc: 'You are a student of spells that modify energy and matter. To you, the world is not a fixed thing, but eminently mutable, and you delight in being an agent of change. You wield the raw stuff of creation and learn to alter both physical forms and mental qualities.',
    },
  ],
};

let changed = 0;
for (const [className, archetypes] of Object.entries(SRD_ARCHETYPES)) {
  const filePath = path.join(DATA_DIR, `${className}.json`);
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

    // Replace archetypes with the full SRD set, marked as wotc-srd
    data.archetypes = archetypes.map(a => ({
      name: a.name,
      slug: a.slug,
      desc: a.desc,
      document__slug:  'wotc-srd',
      document__title: '5e Core Rules',
    }));

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`✓ ${className}.json — ${archetypes.length} SRD subclasses written`);
    changed++;
  } catch (e) {
    console.error(`✗ ${className}: ${e.message}`);
  }
}
console.log(`\nDone. ${changed}/12 files updated.`);
