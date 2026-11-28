#!/usr/bin/env node
/* vérifie le programme maison préparamétré (programme.js) tel qu'Antoine l'a demandé le 28/11/2026,
   et qu'il tient dans les limites d'un planning netatmo. aucun réseau.
   usage : node test/programme.js */
'use strict';
const assert = require('assert');
const programme = require('../programme');

const PIECES = [
  { id: 'chambre', nom: 'Chambre', type: 'bedroom' },
  { id: 'doudou', nom: 'Bureau de Doudou', type: 'custom' },
  { id: 'nines', nom: 'Bureau de Ninès', type: 'custom' },
  { id: 'sdb', nom: 'Salle de bain', type: 'bathroom' },
  { id: 'cuisine', nom: 'Cuisine', type: 'kitchen' },
  { id: 'salon', nom: 'Salon', type: 'livingroom' },
  { id: 'sam', nom: 'Salle à manger', type: 'dining_room' },
];
const comp = programme.compiler(programme.copie(programme.DEFAUT), PIECES, { hg_temp: 7, away_temp: 12 });
assert.ok(!comp.erreur, comp.erreur);
assert.ok(comp.nbZones <= programme.MAX_ZONES, comp.nbZones + ' zones');
assert.ok(comp.nbCreneaux <= programme.MAX_CRENEAUX, comp.nbCreneaux + ' créneaux');
assert.strictEqual(comp.timetable[0].m_offset, 0);
[0, 1, 3, 4].forEach(id => assert.ok(comp.zones.some(z => z.id === id), 'zone standard ' + id));

// température d'une pièce à un moment de la semaine (j : 0 = lundi, 'HH:MM')
function temp(piece, j, h) {
  const k = j * 1440 + programme.minutes(h, 0);
  let c = comp.timetable[0];
  comp.timetable.forEach(x => { if (x.m_offset <= k) c = x; });
  const z = comp.zones.find(x => x.id === c.zone_id);
  return z.rooms.find(r => r.id === piece).therm_setpoint_temperature;
}
const attendu = (piece, j, liste) => liste.forEach(([h, t]) => assert.strictEqual(temp(piece, j, h), t, piece + ' jour ' + j + ' à ' + h));

// mardi (réveil 8 h, chauffe dès 7 h)
attendu('chambre', 1, [['06:59', 18], ['07:00', 21], ['11:29', 21], ['11:30', 17], ['20:59', 17], ['21:00', 18], ['23:59', 18]]);
attendu('doudou', 1, [['06:59', 17], ['07:00', 21], ['11:30', 17], ['18:00', 20], ['23:59', 20]]);
attendu('doudou', 2, [['00:00', 17]]);
attendu('nines', 1, [['06:59', 17], ['07:00', 21], ['19:59', 21], ['20:00', 17]]);
attendu('sdb', 1, [['00:59', 20], ['01:00', 17], ['07:00', 25], ['09:29', 25], ['09:30', 22], ['11:00', 20], ['18:30', 23], ['22:59', 23], ['23:00', 20]]);
['cuisine', 'salon', 'sam'].forEach(p => attendu(p, 1, [['00:59', 21], ['01:00', 17], ['07:00', 23], ['09:30', 20], ['17:59', 20], ['18:00', 21]]));
// samedi (réveil 9 h 30, chauffe dès 8 h 30 ; salon et salle de bain au chaud jusqu'à 11 h)
attendu('chambre', 5, [['08:29', 18], ['08:30', 21], ['11:30', 17]]);
attendu('nines', 5, [['08:29', 17], ['08:30', 21], ['20:00', 17]]);
attendu('sdb', 5, [['08:29', 17], ['08:30', 25], ['10:59', 25], ['11:00', 20], ['18:30', 23]]);
attendu('salon', 5, [['00:30', 21], ['08:30', 23], ['10:59', 23], ['11:00', 20], ['18:00', 21]]);
// la nuit de dimanche à lundi suit le dimanche soir
attendu('salon', 0, [['00:30', 21], ['01:00', 17]]);

// reconnaissance des pièces : nom sans accents, sinon type, sinon pièce de vie
const rep = programme.repartir(programme.DEFAUT, [
  { id: 'a', nom: 'Salle de bains', type: 'custom' }, { id: 'b', nom: 'Séjour', type: 'custom' },
  { id: 'c', nom: 'Chambre d\'amis', type: 'bedroom' }, { id: 'd', nom: 'Entrée', type: 'lobby' },
  { id: 'e', nom: 'Bureau de Ninès', type: 'custom' }, { id: 'f', nom: 'SDB haut', type: 'custom' },
]).par;
assert.deepStrictEqual(rep, { a: 'salle-de-bain', b: 'vie', c: 'chambre', d: 'vie', e: 'bureau-nines', f: 'salle-de-bain' });

// retouches : bornes, réveil au quart d'heure, et trop de combinaisons refusées
const def = programme.copie(programme.DEFAUT);
assert.strictEqual(programme.changerTemp(def, 'salle-de-bain', 0, 40), programme.BORNES.max);
assert.strictEqual(programme.changerReveil(def, 'semaine', 7 * 60 + 40), 7 * 60 + 45);
assert.throws(() => programme.changerReveil(def, 'semaine', 3 * 60));
assert.deepStrictEqual(programme.verifier(def), []);
const touffu = programme.copie(programme.DEFAUT);
touffu.groupes[2].plages = [];
for (let h = 6; h < 22; h++) touffu.groupes[2].plages.push({ de: h + ':00', a: h + ':30', t: 18 + (h % 3) });
assert.ok(programme.compiler(touffu, PIECES, null).erreur, 'trop de zones devrait être refusé');

// aperçu envoyé à l'écran : une journée type complète par ligne
const a = programme.apercu(programme.DEFAUT, PIECES);
a.groupes.forEach(g => ['semaine', 'weekend'].forEach(q => {
  assert.strictEqual(g[q][0].de, 0);
  assert.strictEqual(g[q][g[q].length - 1].a, 1440);
}));

console.log('programme maison : ' + comp.nbZones + ' zones, ' + comp.nbCreneaux + ' créneaux par semaine · tout est conforme');
