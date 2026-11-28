/* diagnostic du thermostat netatmo · à lancer sur le vps :
     node debug-netatmo.js
   lit config.netatmo { clientId, clientSecret, refreshToken } et résume ce que
   l'api renvoie : maisons, pièces, modules, état actuel, programme du jour.
   coller la sortie complète dans la conversation pour calibrer l'écran chauffage.

   jetons : depuis mai 2024, netatmo invalide l'ancien jeton à chaque renouvellement.
   le jeton courant vit donc dans netatmo-jeton.json (gitignoré, à côté de config.json),
   jamais dans config.json, que le serveur réécrit de son côté. le refreshToken de
   config.json ne sert qu'au premier démarrage, ou quand on en colle un nouveau.
   ne pas supprimer netatmo-jeton.json : il faudrait régénérer un jeton.

   n'affiche ni jeton, ni secret, ni l'adresse e-mail du compte. */
'use strict';
const fs = require('fs');
const path = require('path');
const netatmo = require('./netatmo');
const programme = require('./programme');

const CONFIG_PATH = process.env.ECRAN_CONFIG || path.join(__dirname, 'config.json');
const JETON_PATH = netatmo.cheminJeton(CONFIG_PATH);
const TZ = 'Europe/Paris';

function sortie(msg) { console.log(msg); process.exit(1); }

/* ---------- api : jeton tournant et appels via netatmo.js ---------- */
async function api(cfg, acces, chemin, params) {
  try {
    const r = await netatmo.appel(cfg, JETON_PATH, chemin, params, acces, console.log);
    return r.corps;
  } catch (e) { sortie(e.message); }
}

/* ---------- mise en forme ---------- */
const fr = n => (n == null ? '?' : String(Math.round(n * 10) / 10).replace('.', ',') + '°');
const hm = min => Math.floor(min / 60) + ' h' + (min % 60 ? ' ' + String(min % 60).padStart(2, '0') : '');
function quand(ts) {
  if (!ts) return '—';
  const p = {};
  new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(ts * 1000)).forEach(x => { p[x.type] = x.value; });
  return p.weekday.replace('.', '') + ' ' + p.day + ' · ' + hm(+p.hour * 60 + +p.minute);
}
const { nomZone, tempZone, THERMIQUES } = netatmo;
const JOURS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const NOMS_MODULE = { NATherm1: 'thermostat', NAPlug: 'relais', NRV: 'vanne', OTH: 'relais opentherm', OTM: 'thermostat opentherm', BNS: 'smarther' };

/* ---------- programme ---------- */
const MODES_PIECE = { schedule: 'programme', home: 'programme', manual: 'manuel', away: 'absent', hg: 'hors-gel', max: 'boost', off: 'arrêt' };
function resumeProgramme(sch, rooms, tz) {
  const zones = {};
  (sch.zones || []).forEach(z => { zones[z.id] = z; });
  console.log('programme actif « ' + (sch.name || 'sans nom') + ' » · ' + (sch.zones || []).length + ' zones · ' + (sch.timetable || []).length + ' créneaux/semaine');
  (sch.zones || []).forEach(z => {
    const t = rooms.map(r => (rooms.length > 1 ? r.name + ' ' : '') + fr(tempZone(z, r.id))).join(' · ');
    console.log('  zone ' + z.id + ' · ' + nomZone(z) + ' (type ' + z.type + ', « ' + (z.name || '') + ' ») · ' + t);
  });
  console.log('  hors-gel ' + fr(sch.hg_temp) + ' · absent ' + fr(sch.away_temp));
  const p = netatmo.programme(sch, rooms.length ? rooms[0].id : null, tz, new Date());
  if (!p) return;
  console.log('  aujourd\'hui (' + JOURS[p.jourSemaine] + ') : ' + p.jour.map(c => hm(c.debut) + ' ' + c.nom).join(' · '));
  console.log('  maintenant : ' + p.actif.nom + (p.suivant ? ' · puis ' + p.suivant.nom + ' ' + (p.suivant.jours === 0 ? '' : p.suivant.jours === 1 ? 'demain ' : 'dans ' + p.suivant.jours + ' jours ') + 'à ' + hm(p.suivant.min) : ''));
}

/* ---------- programme maison de l'écran, à blanc : rien n'est envoyé ----------
   montre dans quelle ligne du programme tombe chaque pièce, et si le planning tient
   dans les limites netatmo, avant d'appuyer sur « appliquer » sur l'ipad */
function resumeProgrammeMaison(rooms, sch) {
  let def = programme.copie(programme.DEFAUT);
  try {
    const j = JSON.parse(fs.readFileSync(path.join(path.dirname(CONFIG_PATH), 'programme-maison.json'), 'utf8'));
    if (j.modifie && j.def) def = j.def;
  } catch (e) { /* jamais retouché depuis l'écran : programme par défaut */ }
  const comp = programme.compiler(def, rooms.map(r => ({ id: r.id, nom: r.name, type: r.type })), sch);
  console.log('programme maison de l\'écran (à blanc, rien n\'est envoyé) : ' +
    (comp.erreur || comp.nbZones + ' zones · ' + comp.nbCreneaux + ' créneaux/semaine · réveil ' + def.reveil.semaine + ' en semaine, ' + def.reveil.weekend + ' le week-end'));
  (comp.repartition || []).forEach(p => {
    const g = def.groupes.find(x => x.cle === p.groupe) || {};
    console.log('  ' + p.nom + ' → ' + g.nom + (p.comment === 'nom' ? '' : ' (reconnue par ' + p.comment + ')'));
  });
}

(async () => {
  let CFG;
  try { CFG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { sortie('config.json illisible : ' + e.message); }
  const cfg = CFG.netatmo || {};
  if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) {
    sortie('bloc « netatmo » absent ou incomplet dans config.json (clientId, clientSecret, refreshToken).');
  }

  console.log('== jeton');
  let acces;
  try { acces = await netatmo.jetonAcces(cfg, JETON_PATH, false); } catch (e) { sortie(e.message); }
  console.log(acces.etat);

  const data = await api(cfg, acces, 'api/homesdata');
  const maisons = (data.homes || []).filter(h => (h.modules || []).some(m => THERMIQUES.test(m.type)));
  if (!maisons.length) sortie('aucune maison avec un thermostat sur ce compte (' + (data.homes || []).length + ' maison(s) en tout).');

  for (const h of maisons) {
    console.log('\n== maison « ' + h.name + ' » · fuseau ' + (h.timezone || '?'));
    console.log('mode ' + (MODES_PIECE[h.therm_mode] ? MODES_PIECE[h.therm_mode] + ' (' + h.therm_mode + ')' : h.therm_mode || '?') + (h.therm_mode_endtime ? ' jusqu\'à ' + quand(h.therm_mode_endtime) : '') +
      ' · réglage manuel par défaut ' + (h.therm_setpoint_default_duration || '?') + ' min' +
      ' · contrôle ' + (h.temperature_control_mode || '?'));
    const rooms = (h.rooms || []).filter(r => (r.module_ids || []).some(id => (h.modules || []).some(m => m.id === id && THERMIQUES.test(m.type))));
    const mods = (h.modules || []).filter(m => THERMIQUES.test(m.type));
    const st = await api(cfg, acces, 'api/homestatus', { home_id: h.id });
    const sh = st.home || {};
    console.log('pièces chauffées :');
    rooms.forEach(r => {
      const s = (sh.rooms || []).find(x => x.id === r.id) || {};
      console.log('  ' + r.name + ' (' + r.type + ') · mesuré ' + fr(s.therm_measured_temperature) +
        ' · consigne ' + fr(s.therm_setpoint_temperature) + ' en ' + (MODES_PIECE[s.therm_setpoint_mode] || s.therm_setpoint_mode || '?') +
        (s.therm_setpoint_end_time ? ' jusqu\'à ' + quand(s.therm_setpoint_end_time) : '') +
        (s.anticipating ? ' · préchauffe' : '') + (s.open_window ? ' · fenêtre ouverte' : '') +
        (s.humidity != null ? ' · humidité ' + s.humidity + ' %' : '') + (s.reachable === false ? ' · INJOIGNABLE' : ''));
    });
    console.log('modules :');
    mods.forEach(m => {
      const s = (sh.modules || []).find(x => x.id === m.id) || {};
      const piece = (h.rooms || []).find(r => r.id === m.room_id);
      console.log('  ' + (NOMS_MODULE[m.type] || m.type) + ' ' + m.type + ' « ' + (m.name || '') + ' »' +
        (piece ? ' · ' + piece.name : '') +
        (s.boiler_status != null ? ' · chaudière ' + (s.boiler_status ? 'EN CHAUFFE' : 'au repos') : '') +
        (s.battery_state ? ' · piles ' + s.battery_state : '') +
        (s.reachable === false ? ' · INJOIGNABLE' : ''));
    });
    const therm = (h.schedules || []).filter(s => !s.type || s.type === 'therm');
    const sch = therm.find(s => s.selected) || therm[0];
    if (sch) resumeProgramme(sch, rooms, h.timezone);
    else console.log('aucun programme de chauffage');
    const autres = therm.filter(s => s !== sch).map(s => '« ' + s.name + ' »');
    if (autres.length) console.log('autres programmes : ' + autres.join(', '));
    resumeProgrammeMaison(rooms, sch);
  }
})().catch(e => sortie('erreur inattendue : ' + e.message));
