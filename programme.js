/* programme maison · le planning de chauffe pièce par pièce, préparamétré

   netatmo ne connaît qu'un planning pour toute la maison : une suite de créneaux
   (zone active, minutes depuis lundi 0 h), chaque zone portant une température par
   pièce. on décrit donc le programme pièce par pièce, comme on le pense (« la
   chambre à 21° du réveil à 11 h 30 »), et on le compile : chaque fois qu'une pièce
   change de température, un nouveau créneau commence, et chaque combinaison de
   températures devient une zone.

   heures : 'HH:MM' fixes, ou 'r-60' / 'r+90' en minutes autour du réveil (8 h en
   semaine, 9 h 30 le week-end par défaut). une plage qui finit après minuit déborde
   sur le lendemain ('25:00' = 1 h du matin). les plages s'appliquent dans l'ordre,
   la dernière l'emporte ; hors plage, la pièce est à sa température de base.

   limites d'un planning netatmo (legrand) : 12 ensembles de températures au plus,
   150 créneaux par semaine, 15 minutes minimum par créneau. */
'use strict';

const SEMAINE = 7 * 1440;
const PAS = 15;
const MAX_ZONES = 12, MAX_CRENEAUX = 150;
const BORNES = { min: 12, max: 28, pas: 0.5 };
const JOURS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

// le programme demandé par Antoine le 28/11/2026 (réveil 8 h en semaine, 9 h 30 le week-end,
// chauffe une heure avant pour que tout soit chaud au lever)
const DEFAUT = {
  nom: 'Programme maison',
  reveil: { semaine: '08:00', weekend: '09:30' },
  groupes: [
    { cle: 'chambre', nom: 'chambre', motifs: ['chambre'], types: ['bedroom'], base: 18,
      plages: [{ de: 'r-60', a: '11:30', t: 21 }, { de: '11:30', a: '21:00', t: 17 }] },
    { cle: 'bureau-doudou', nom: 'bureau de doudou', motifs: ['doudou'], base: 17,
      plages: [{ de: 'r-60', a: '11:30', t: 21 }, { de: '18:00', a: '24:00', t: 20 }] },
    { cle: 'bureau-nines', nom: 'bureau de ninès', motifs: ['nines'], base: 17,
      plages: [{ de: 'r-60', a: '20:00', t: 21 }] },
    { cle: 'salle-de-bain', nom: 'salle de bain', motifs: ['bain', 'sdb'], types: ['bathroom'], base: 17,
      plages: [{ de: 'r-60', a: 'r+90', t: 25 }, { de: 'r+90', a: '11:00', t: 22 }, { de: '11:00', a: '18:30', t: 20 },
        { de: '18:30', a: '23:00', t: 23 }, { de: '23:00', a: '25:00', t: 20 }] },
    { cle: 'vie', nom: 'pièce de vie', motifs: ['cuisine', 'salon', 'sejour', 'manger'],
      types: ['kitchen', 'livingroom', 'dining_room'], base: 17, defaut: true,
      plages: [{ de: 'r-60', a: 'r+90', t: 23 }, { de: 'r+90', a: '18:00', t: 20 }, { de: '18:00', a: '25:00', t: 21 }] },
  ],
};

const copie = o => JSON.parse(JSON.stringify(o));
const sansAccents = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
const hm = min => {
  min = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(min / 60), m = min % 60;
  return (h === 0 && m === 0 ? 'minuit' : h + ' h' + (m ? ' ' + String(m).padStart(2, '0') : ''));
};
const degres = t => String(Math.round(t * 10) / 10).replace('.', ',') + '°';
const hhmm = min => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');

// 'HH:MM' → minutes ; 'r±N' → réveil ± N minutes
function minutes(h, reveil) {
  const r = /^r([+-]\d+)$/.exec(String(h));
  if (r) return reveil + parseInt(r[1], 10);
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(h));
  if (!m) throw new Error('heure illisible dans le programme : ' + h);
  return +m[1] * 60 + +m[2];
}
const typeJour = j => (j < 5 ? 'semaine' : 'weekend');

/* ---------- pièces ----------
   pieces : [{ id, nom, type }] (salles chauffées lues dans homesdata).
   chaque pièce va au premier groupe dont un motif figure dans son nom (sans accents),
   sinon au premier dont le type netatmo correspond, sinon au groupe par défaut. */
function repartir(def, pieces) {
  const par = {}, liste = [];
  (pieces || []).forEach(p => {
    const n = sansAccents(p.nom);
    let g = def.groupes.find(x => (x.motifs || []).some(m => n.indexOf(m) >= 0)), comment = 'nom';
    if (!g) { g = def.groupes.find(x => (x.types || []).indexOf(p.type) >= 0); comment = 'type'; }
    if (!g) { g = def.groupes.find(x => x.defaut) || def.groupes[0]; comment = 'défaut'; }
    par[p.id] = g.cle;
    liste.push({ id: p.id, nom: p.nom, groupe: g.cle, comment: comment });
  });
  return { par: par, liste: liste };
}

/* ---------- semaine minute par minute ----------
   pour un groupe : la température et la plage d'origine (-1 = base) de chaque minute
   de la semaine, lundi 0 h = 0 */
function semaineGroupe(def, g) {
  const t = new Array(SEMAINE).fill(g.base), src = new Array(SEMAINE).fill(-1);
  for (let j = 0; j < 7; j++) {
    const rv = minutes(def.reveil[typeJour(j)], 0);
    g.plages.forEach((p, i) => {
      const de = minutes(p.de, rv), a = minutes(p.a, rv);
      if (a <= de) return; // plage vide (réveil tardif) : on l'ignore
      for (let m = de; m < a; m++) {
        const k = ((j * 1440 + m) % SEMAINE + SEMAINE) % SEMAINE;
        t[k] = p.t; src[k] = i;
      }
    });
  }
  return { t: t, src: src };
}

/* ---------- vérifications de la définition ---------- */
function verifier(def) {
  const err = [];
  ['semaine', 'weekend'].forEach(k => {
    const m = minutes(def.reveil[k], 0);
    if (!(m >= 4 * 60 && m <= 12 * 60) || m % PAS) err.push('réveil ' + k + ' hors limites');
  });
  def.groupes.forEach(g => {
    [g.base].concat(g.plages.map(p => p.t)).forEach(t => {
      if (!(typeof t === 'number' && t >= BORNES.min && t <= BORNES.max)) err.push(g.nom + ' : température hors limites');
    });
    g.plages.forEach(p => {
      [p.de, p.a].forEach(h => { if (minutes(h, 480) % PAS) err.push(g.nom + ' : heure ' + h + ' hors quart d\'heure'); });
    });
  });
  return err;
}

/* ---------- compilation en planning netatmo ----------
   → { zones, timetable, hg_temp, away_temp, nbZones, nbCreneaux, erreur }
   les quatre zones standard de netatmo (0 confort, 1 nuit, 3 confort +, 4 éco)
   restent présentes, comme dans tous les plannings créés par l'appli :
   réveil → confort +, nuit → nuit, journée → éco, soirée → confort. les autres
   combinaisons deviennent des zones perso (type 4), nommées par leur heure de début. */
function compiler(def, pieces, base) {
  const rep = repartir(def, pieces);
  const sem = {};
  def.groupes.forEach(g => { sem[g.cle] = semaineGroupe(def, g); });
  const cles = def.groupes.map(g => g.cle);
  const cle = k => cles.map(c => sem[c].t[k]).join('|');

  // créneaux : une entrée à lundi 0 h, puis à chaque changement de combinaison
  const runs = [];
  for (let k = 0; k < SEMAINE; k++) {
    const c = cle(k);
    if (!runs.length || runs[runs.length - 1].cle !== c) runs.push({ cle: c, debut: k });
  }
  for (let i = 0; i < runs.length; i++) {
    const fin = i + 1 < runs.length ? runs[i + 1].debut : SEMAINE;
    if (fin - runs[i].debut < PAS) return { erreur: 'un créneau dure moins de 15 minutes vers ' + JOURS[Math.floor(runs[i].debut / 1440)] + ' ' + hm(runs[i].debut % 1440) };
  }

  // zones : les standard d'abord, choisies par moment d'un lundi type
  const rv = minutes(def.reveil.semaine, 0);
  const standard = [
    { id: 1, type: 1, name: 'Nuit', k: 3 * 60 },
    { id: 3, type: 8, name: 'Réveil', k: rv },
    { id: 4, type: 5, name: 'Journée', k: 14 * 60 },
    { id: 0, type: 0, name: 'Soirée', k: 19 * 60 + 30 },
  ];
  const zoneDe = {}; // combinaison → id de zone
  const zones = [];
  standard.forEach(s => {
    const c = cle(s.k);
    // deux moments sur la même combinaison : la zone standard existe quand même, inutilisée
    if (!(c in zoneDe)) zoneDe[c] = s.id;
    zones.push({ id: s.id, type: s.type, name: s.name, cle: c });
  });
  const libres = [2, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  runs.forEach(r => {
    if (r.cle in zoneDe) return;
    const id = libres.shift();
    zoneDe[r.cle] = id;
    zones.push({ id: id, type: 4, name: 'Dès ' + hm(r.debut % 1440), cle: r.cle });
  });
  const timetable = runs.map(r => ({ zone_id: zoneDe[r.cle], m_offset: r.debut }));
  // le programme se suit d'une semaine à l'autre : si dimanche soir et lundi 0 h ont la même zone,
  // l'entrée de lundi 0 h reste (netatmo veut un créneau à 0) ; rien d'autre à recoller

  const groupeDe = rep.par;
  const zonesNetatmo = zones.map(z => {
    const temps = z.cle.split('|').map(Number);
    return {
      id: z.id, type: z.type, name: z.name,
      rooms: (pieces || []).map(p => ({ id: p.id, therm_setpoint_temperature: temps[cles.indexOf(groupeDe[p.id])] })),
    };
  });
  const res = {
    zones: zonesNetatmo, timetable: timetable,
    hg_temp: base && base.hg_temp != null ? base.hg_temp : 7,
    away_temp: base && base.away_temp != null ? base.away_temp : 12,
    nbZones: zones.length, nbCreneaux: timetable.length, repartition: rep.liste,
  };
  if (zones.length > MAX_ZONES) res.erreur = 'le programme demande ' + zones.length + ' ensembles de températures, netatmo en accepte ' + MAX_ZONES + ' : simplifie un horaire';
  else if (timetable.length > MAX_CRENEAUX) res.erreur = 'le programme demande ' + timetable.length + ' créneaux par semaine, netatmo en accepte ' + MAX_CRENEAUX;
  return res;
}

/* ---------- affichage ----------
   une journée type par groupe : mardi pour la semaine (la nuit d'avant est en semaine),
   dimanche pour le week-end. segments [{ de, a, t, i }] en minutes du jour, i = plage
   d'origine (-1 = base), avec les libellés prêts à afficher (l'ipad n'a pas Intl) */
function journee(def, g, quel) {
  const j = quel === 'weekend' ? 6 : 1, s = semaineGroupe(def, g), segs = [];
  for (let m = 0; m < 1440; m++) {
    const k = j * 1440 + m, t = s.t[k], i = s.src[k], d = segs[segs.length - 1];
    if (d && d.t === t && d.i === i) d.a = m + 1;
    else segs.push({ de: m, a: m + 1, t: t, i: i });
  }
  return segs.map(x => ({ de: x.de, a: x.a, t: x.t, i: x.i, tTxt: degres(x.t), deTxt: hm(x.de), aTxt: hm(x.a) }));
}

/* résumé envoyé à l'écran : groupes, pièces reconnues, journées types, réveils */
function apercu(def, pieces) {
  const rep = repartir(def, pieces);
  const comp = compiler(def, pieces || [], null);
  return {
    nom: def.nom,
    reveil: {
      semaine: minutes(def.reveil.semaine, 0), weekend: minutes(def.reveil.weekend, 0),
      semaineTxt: hm(minutes(def.reveil.semaine, 0)), weekendTxt: hm(minutes(def.reveil.weekend, 0)),
      chauffeSemaineTxt: hm(minutes(def.reveil.semaine, 0) - 60), chauffeWeekendTxt: hm(minutes(def.reveil.weekend, 0) - 60),
    },
    groupes: def.groupes.map((g, gi) => ({
      cle: g.cle, nom: g.nom, base: g.base,
      pieces: rep.liste.filter(p => p.groupe === g.cle).map(p => p.nom),
      semaine: journee(def, g, 'semaine'), weekend: journee(def, g, 'weekend'),
      plages: g.plages.length, ordre: gi,
    })),
    repartition: rep.liste,
    nbZones: comp.nbZones || 0, nbCreneaux: comp.nbCreneaux || 0,
    erreur: comp.erreur || null,
    bornes: BORNES,
  };
}

/* ---------- retouches depuis l'écran ---------- */
function changerTemp(def, cleGroupe, i, t) {
  const g = def.groupes.find(x => x.cle === cleGroupe);
  if (!g) throw new Error('groupe inconnu');
  if (!isFinite(t)) throw new Error('température invalide');
  t = Math.min(BORNES.max, Math.max(BORNES.min, Math.round(t * 2) / 2));
  if (i === -1) g.base = t;
  else if (g.plages[i]) g.plages[i].t = t;
  else throw new Error('plage inconnue');
  return t;
}
function changerReveil(def, quel, min) {
  if (quel !== 'semaine' && quel !== 'weekend') throw new Error('jour inconnu');
  min = Math.round(min / PAS) * PAS;
  if (!(min >= 5 * 60 && min <= 11 * 60)) throw new Error('réveil hors limites (5 h à 11 h)');
  def.reveil[quel] = hhmm(min);
  return min;
}

module.exports = {
  DEFAUT, BORNES, MAX_ZONES, MAX_CRENEAUX,
  copie, sansAccents, minutes, repartir, semaineGroupe, verifier, compiler, journee, apercu,
  changerTemp, changerReveil, hm, degres,
};
