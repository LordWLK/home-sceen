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

const CONFIG_PATH = process.env.ECRAN_CONFIG || path.join(__dirname, 'config.json');
const JETON_PATH = path.join(path.dirname(CONFIG_PATH), 'netatmo-jeton.json');
const API = 'https://api.netatmo.com/';
const TZ = 'Europe/Paris';

function sortie(msg) { console.log(msg); process.exit(1); }

/* ---------- jeton tournant ---------- */
function lireJeton() {
  try { return JSON.parse(fs.readFileSync(JETON_PATH, 'utf8')); } catch (e) { return {}; }
}
function ecrireJeton(j) {
  // écriture atomique : un fichier à moitié écrit ferait perdre la chaîne de jetons
  const tmp = JETON_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, JETON_PATH);
}
function duree(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60 ? Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') : m + ' min';
}
async function jetonAcces(cfg, forcer) {
  let j = lireJeton();
  // un refreshToken différent dans config.json = jeton fraîchement régénéré : on repart de lui
  if (j.depuis !== cfg.refreshToken) j = { depuis: cfg.refreshToken, refresh: cfg.refreshToken };
  if (!forcer && j.acces && Date.now() < j.expire - 120000) {
    return { jeton: j.acces, etat: 'réutilisé, valide encore ' + duree(j.expire - Date.now()) };
  }
  let r, t;
  try {
    r = await fetch(API + 'oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: j.refresh,
        client_id: cfg.clientId, client_secret: cfg.clientSecret,
      }),
      signal: AbortSignal.timeout(15000),
    });
    t = await r.json().catch(() => ({}));
  } catch (e) { sortie('netatmo injoignable (' + e.message + ')'); }
  if (!t.access_token) {
    const code = String(t.error || r.status);
    if (code === 'invalid_grant') {
      sortie('netatmo refuse le jeton de renouvellement : il a expiré ou a déjà servi.\n' +
        'régénère-en un sur dev.netatmo.com (token generator, cases read_thermostat et\n' +
        'write_thermostat), puis relance la commande de configuration.');
    }
    if (code === 'invalid_client') sortie('identifiant ou secret de l\'application netatmo incorrect (clientId / clientSecret).');
    sortie('renouvellement du jeton refusé : ' + code);
  }
  j.acces = t.access_token;
  j.refresh = t.refresh_token || j.refresh;
  j.expire = Date.now() + (t.expires_in || 10800) * 1000;
  j.maj = new Date().toISOString();
  try { ecrireJeton(j); } catch (e) {
    sortie('jeton renouvelé mais impossible de l\'enregistrer (' + e.message + ').\n' +
      'l\'ancien est désormais invalide : il faudra en régénérer un.');
  }
  return { jeton: j.acces, etat: 'renouvelé, enregistré dans ' + path.basename(JETON_PATH) };
}

/* ---------- api ---------- */
async function api(cfg, acces, chemin, params) {
  for (let essai = 0; essai < 2; essai++) {
    let r, j;
    try {
      r = await fetch(API + chemin, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + acces.jeton, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params || {}),
        signal: AbortSignal.timeout(15000),
      });
      j = await r.json().catch(() => ({}));
    } catch (e) { sortie(chemin + ' : netatmo injoignable (' + e.message + ')'); }
    if (r.ok && j.body) return j.body;
    const code = j.error && j.error.code;
    // 2 = jeton invalide, 3 = jeton expiré : on renouvelle une fois et on réessaie
    if ((code === 2 || code === 3) && essai === 0) {
      Object.assign(acces, await jetonAcces(cfg, true));
      console.log('jeton d\'accès refusé par netatmo (code ' + code + '), ' + acces.etat);
      continue;
    }
    if (code === 13) sortie(chemin + ' : jeton sans les droits thermostat. régénère-le en cochant read_thermostat et write_thermostat.');
    if (code === 26 || r.status === 429) sortie(chemin + ' : limite d\'appels netatmo atteinte, réessaie dans une heure.');
    sortie(chemin + ' : erreur ' + r.status + ' ' + JSON.stringify(j.error || j).slice(0, 200));
  }
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
const TYPES_ZONE = { 0: 'confort', 1: 'nuit', 5: 'éco', 8: 'confort +' };
const nomZone = z => TYPES_ZONE[z.type] || String(z.name || 'zone ' + z.id).toLowerCase();
function tempZone(z, roomId) {
  const r = (z.rooms || []).find(x => x.id === roomId);
  if (r && r.therm_setpoint_temperature != null) return r.therm_setpoint_temperature;
  const rt = (z.rooms_temp || []).find(x => x.room_id === roomId);
  return rt ? (rt.temp != null ? rt.temp : rt.therm_setpoint_fp) : null;
}
// lundi = 0 … dimanche = 6, minutes depuis minuit, en heure de paris
function maintenantSemaine(tz) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: tz || TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date()).forEach(x => { p[x.type] = x.value; });
  const jour = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday);
  return { jour: jour, min: (+p.hour % 24) * 60 + +p.minute };
}
const JOURS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const THERMIQUES = /^(NATherm1|NAPlug|NRV|OTH|OTM|BNS)$/;
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
  const tt = (sch.timetable || []).slice().sort((a, b) => a.m_offset - b.m_offset);
  if (!tt.length) return;
  const now = maintenantSemaine(tz);
  const debut = now.jour * 1440, ici = debut + now.min;
  // zone active à minuit : dernier créneau avant le début du jour (sinon le dernier de la semaine)
  const avant = tt.filter(c => c.m_offset <= debut);
  const minuit = avant.length ? avant[avant.length - 1] : tt[tt.length - 1];
  const duJour = [{ zone_id: minuit.zone_id, m_offset: debut }].concat(tt.filter(c => c.m_offset > debut && c.m_offset < debut + 1440));
  const actifs = tt.filter(c => c.m_offset <= ici);
  const actif = actifs.length ? actifs[actifs.length - 1] : tt[tt.length - 1];
  console.log('  aujourd\'hui (' + JOURS[now.jour] + ') : ' + duJour.map(c => hm(c.m_offset - debut) + ' ' + nomZone(zones[c.zone_id] || {})).join(' · '));
  console.log('  maintenant : ' + nomZone(zones[actif.zone_id] || {}));
}

(async () => {
  let CFG;
  try { CFG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { sortie('config.json illisible : ' + e.message); }
  const cfg = CFG.netatmo || {};
  if (!cfg.clientId || !cfg.clientSecret || !cfg.refreshToken) {
    sortie('bloc « netatmo » absent ou incomplet dans config.json (clientId, clientSecret, refreshToken).');
  }

  console.log('== jeton');
  const acces = await jetonAcces(cfg, false);
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
  }
})().catch(e => sortie('erreur inattendue : ' + e.message));
