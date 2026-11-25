/* netatmo · client minimal de l'api energy (thermostat), partagé par server.js et debug-netatmo.js

   jeton tournant : depuis mai 2024, netatmo invalide l'ancien jeton à chaque renouvellement.
   le jeton courant vit dans netatmo-jeton.json (gitignoré, à côté de config.json), jamais
   dans config.json, que le serveur réécrit en entier à la rotation spotify et où il
   écraserait un jeton tourné. config.netatmo.refreshToken ne sert qu'à démarrer une chaîne :
   s'il change (jeton régénéré et recollé), on repart de lui.
   le jeton d'accès (3 h) est réutilisé tant qu'il est valide : le serveur et le diagnostic
   peuvent tourner ensemble sans se voler le jeton. ne pas supprimer netatmo-jeton.json. */
'use strict';
const fs = require('fs');
const path = require('path');

const API = 'https://api.netatmo.com/';
const MARGE = 120000; // un jeton d'accès à moins de 2 min de sa fin est renouvelé

class ErreurNetatmo extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

/* ---------- jeton tournant ---------- */
const cheminJeton = configPath => path.join(path.dirname(configPath), 'netatmo-jeton.json');
function lireJeton(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; }
}
function ecrireJeton(f, j) {
  // écriture atomique : un fichier à moitié écrit ferait perdre la chaîne de jetons
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, f);
}
function duree(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  return m >= 60 ? Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0') : m + ' min';
}
const valide = j => !!(j.acces && Date.now() < j.expire - MARGE);

async function jetonAcces(cfg, f, forcer) {
  let j = lireJeton(f);
  // un refreshToken différent dans config.json = jeton fraîchement régénéré : on repart de lui
  if (j.depuis !== cfg.refreshToken) j = { depuis: cfg.refreshToken, refresh: cfg.refreshToken };
  if (!forcer && valide(j)) return { jeton: j.acces, etat: 'réutilisé, valide encore ' + duree(j.expire - Date.now()) };
  const utilise = j.refresh;
  let r, t;
  try {
    r = await fetch(API + 'oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: utilise,
        client_id: cfg.clientId, client_secret: cfg.clientSecret,
      }),
      signal: AbortSignal.timeout(15000),
    });
    t = await r.json().catch(() => ({}));
  } catch (e) { throw new ErreurNetatmo('netatmo injoignable (' + e.message + ')', 'reseau'); }
  if (!t.access_token) {
    const code = String(t.error || r.status);
    if (code === 'invalid_grant') {
      // course entre deux process (serveur et diagnostic) : l'autre vient peut-être de
      // tourner le jeton. si le fichier porte un jeton plus récent et valide, on le prend.
      const k = lireJeton(f);
      if (k.depuis === cfg.refreshToken && k.refresh !== utilise && valide(k)) {
        return { jeton: k.acces, etat: 'repris, renouvelé à l\'instant par un autre process' };
      }
      throw new ErreurNetatmo('netatmo refuse le jeton de renouvellement : il a expiré ou a déjà servi.\n' +
        'régénère-en un sur dev.netatmo.com (token generator, cases read_thermostat et\n' +
        'write_thermostat), puis relance bash outils/netatmo.sh.', 'invalid_grant');
    }
    if (code === 'invalid_client') {
      throw new ErreurNetatmo('identifiant ou secret de l\'application netatmo incorrect (clientId / clientSecret).', 'invalid_client');
    }
    throw new ErreurNetatmo('renouvellement du jeton refusé : ' + code, code);
  }
  j.acces = t.access_token;
  j.refresh = t.refresh_token || j.refresh;
  j.expire = Date.now() + (t.expires_in || 10800) * 1000;
  j.maj = new Date().toISOString();
  try { ecrireJeton(f, j); } catch (e) {
    throw new ErreurNetatmo('jeton renouvelé mais impossible de l\'enregistrer (' + e.message + ').\n' +
      'l\'ancien est désormais invalide : il faudra en régénérer un.', 'ecriture');
  }
  return { jeton: j.acces, etat: 'renouvelé, enregistré dans ' + path.basename(f) };
}

/* ---------- api ----------
   appel(cfg, fichierJeton, chemin, params, acces?, journal?) → { corps, acces }
   POST en formulaire. si netatmo refuse le jeton d'accès (codes 2 et 3), on le renouvelle
   une fois et on réessaie. les commandes (set…) répondent { status: 'ok' } sans corps. */
async function appel(cfg, f, chemin, params, acces, journal) {
  acces = acces || await jetonAcces(cfg, f, false);
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
    } catch (e) { throw new ErreurNetatmo(chemin + ' : netatmo injoignable (' + e.message + ')', 'reseau'); }
    if (r.ok && (j.body || j.status === 'ok')) return { corps: j.body || {}, acces: acces };
    const code = j.error && j.error.code;
    if ((code === 2 || code === 3) && essai === 0) {
      Object.assign(acces, await jetonAcces(cfg, f, true));
      if (journal) journal('jeton d\'accès refusé par netatmo (code ' + code + '), ' + acces.etat);
      continue;
    }
    if (code === 13) throw new ErreurNetatmo(chemin + ' : jeton sans les droits thermostat. régénère-le en cochant read_thermostat et write_thermostat.', 13);
    if (code === 26 || r.status === 429) throw new ErreurNetatmo(chemin + ' : limite d\'appels netatmo atteinte, réessaie dans une heure.', 26);
    throw new ErreurNetatmo(chemin + ' : erreur ' + r.status + ' ' + JSON.stringify(j.error || j).slice(0, 200), r.status);
  }
}

/* ---------- lecture du programme ---------- */
const THERMIQUES = /^(NATherm1|NAPlug|NRV|OTH|OTM|BNS)$/;
const PILOTES = /^(NATherm1|OTM|BNS)$/; // modules qui pilotent la chaudière (boiler_status)
const TYPES_ZONE = { 0: 'confort', 1: 'nuit', 5: 'éco', 8: 'confort +' };
const nomZone = z => TYPES_ZONE[z.type] || String(z.name || 'zone ' + z.id).toLowerCase();
function tempZone(z, roomId) {
  const r = (z.rooms || []).find(x => x.id === roomId);
  if (r && r.therm_setpoint_temperature != null) return r.therm_setpoint_temperature;
  const rt = (z.rooms_temp || []).find(x => x.room_id === roomId);
  return rt ? (rt.temp != null ? rt.temp : rt.therm_setpoint_fp) : null;
}
// position dans la semaine du programme : lundi = 0 … dimanche = 6, minutes depuis minuit local
function semaine(tz, date) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'Europe/Paris', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(date || new Date()).forEach(x => { p[x.type] = x.value; });
  const jour = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday);
  return { jour: jour, min: (+p.hour % 24) * 60 + +p.minute };
}
const SEMAINE = 7 * 1440;
/* programme(sch, roomId, tz, date) → {
     jour : créneaux du jour [{ debut, fin (minutes locales, fin ≤ 1440), nom, temp, etat: passe|en-cours|a-venir }],
     actif : { nom, temp }, suivant : { nom, temp, dans (minutes), jours (0 aujourd'hui, 1 demain…), min (heure locale) },
     jourSemaine : 0 = lundi } */
function programme(sch, roomId, tz, date) {
  const zones = {};
  (sch.zones || []).forEach(z => { zones[z.id] = z; });
  const zone = c => { const z = zones[c.zone_id] || {}; return { nom: nomZone(z), temp: tempZone(z, roomId) }; };
  const tt = (sch.timetable || []).slice().sort((a, b) => a.m_offset - b.m_offset);
  if (!tt.length) return null;
  const now = semaine(tz, date);
  const debut = now.jour * 1440, ici = debut + now.min;
  // zone active à minuit : dernier créneau commencé avant le début du jour (sinon le dernier de la semaine)
  const avant = tt.filter(c => c.m_offset <= debut);
  const minuit = avant.length ? avant[avant.length - 1] : tt[tt.length - 1];
  // deux créneaux qui se suivent dans la même zone n'en font qu'un à l'écran
  const bornes = [{ zone_id: minuit.zone_id, m_offset: debut }]
    .concat(tt.filter(c => c.m_offset > debut && c.m_offset < debut + 1440))
    .filter((c, i, l) => i === 0 || c.zone_id !== l[i - 1].zone_id);
  const jour = bornes.map((c, i) => {
    const d = c.m_offset - debut, f = i + 1 < bornes.length ? bornes[i + 1].m_offset - debut : 1440;
    const z = zone(c);
    return { debut: d, fin: f, nom: z.nom, temp: z.temp, etat: f <= now.min ? 'passe' : d <= now.min ? 'en-cours' : 'a-venir' };
  });
  const actifs = tt.filter(c => c.m_offset <= ici);
  const actif = actifs.length ? actifs[actifs.length - 1] : tt[tt.length - 1];
  // prochain changement de zone (on saute les créneaux qui répètent la zone active)
  let suivant = null;
  for (let k = 0; k < tt.length * 2 && !suivant; k++) {
    const c = tt[k % tt.length], off = c.m_offset + (k >= tt.length ? SEMAINE : 0);
    if (off > ici && c.zone_id !== actif.zone_id) suivant = { c: c, off: off };
  }
  const res = { jour: jour, actif: zone(actif), suivant: null, jourSemaine: now.jour };
  if (suivant) {
    const z = zone(suivant.c);
    res.suivant = { nom: z.nom, temp: z.temp, dans: suivant.off - ici, jours: Math.floor(suivant.off / 1440) - now.jour, min: suivant.off % 1440 };
  }
  return res;
}

module.exports = {
  ErreurNetatmo, cheminJeton, jetonAcces, appel,
  THERMIQUES, PILOTES, TYPES_ZONE, nomZone, tempZone, semaine, programme,
};
