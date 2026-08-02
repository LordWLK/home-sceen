/* ============================================================
   écran maison · serveur
   un seul process : régénère les données, sert la page, pilote spotify
   node >= 18 requis (fetch natif) · dépendance unique : node-ical
   ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const ical = require('node-ical');

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const TEMPLATE = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
const TZ = 'Europe/Paris';

/* ---------- état en mémoire ---------- */
const donnees = {
  meteo: { html: 'météo indisponible', soleil: null, previsions: '' },
  agenda: {
    auj: '<div class="it">chargement</div>',
    venir: '<div class="it">chargement</div>',
    semaines: [],
  },
  sport: { html: '', detail: '' },
  studio: { html: '' },
  cinema: { html: '', detailJours: [], joursLabel: [] },
  menage: { compact: '', planning: '' },
};
const musique = {
  playing: false, title: '', artist: '',
  artUrl: '', artBuf: null, artType: 'image/jpeg',
};
let spotifyAccess = { token: '', exp: 0 };

/* ---------- santé des sources : horodatage de la dernière réussite ----------
   permet de repérer une source figée (scraper cassé, api muette) sans lire
   les logs. seuils larges = 8× l'intervalle de rafraîchissement. */
const sante = { meteo: 0, agenda: 0, sport: 0, cinema: 0, studio: 0 };
const SEUILS = { // ms au-delà desquels une source est considérée figée
  meteo: 16 * 60000, agenda: 16 * 60000, sport: 16 * 60000,
  cinema: 14 * 3600000, studio: 14 * 3600000,
};
const NOMS_FR = { meteo: 'météo', agenda: 'agenda', sport: 'sport', cinema: 'ciné', studio: 'studio' };
function sourcesFigees() {
  const maintenant = Date.now();
  return Object.keys(sante)
    .filter(k => maintenant - sante[k] > SEUILS[k])
    .map(k => NOMS_FR[k]);
}

/* ============================================================
   petits utilitaires date (tout en heure de paris)
   ============================================================ */
function parisParts(d) {
  const p = new Intl.DateTimeFormat('fr-FR', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(d);
  const o = {};
  p.forEach(x => { o[x.type] = x.value; });
  return o; // { weekday:'jeu.', day:'16', month:'07', year:'2026', hour:'09', minute:'41' }
}
function jourCle(d) { const p = parisParts(d); return p.year + p.month + p.day; }

// libellé relatif : "ce soir", "demain 18 h", "sam 14 h", "dim 9 août"…
function quandLabel(d, allDay) {
  const p = parisParts(d);
  const aujourdhui = jourCle(new Date());
  const demain = jourCle(new Date(Date.now() + 86400000));
  const cle = jourCle(d);
  const heure = allDay ? '' : (parseInt(p.hour, 10) + ' h' + (p.minute !== '00' ? ' ' + p.minute : ''));
  if (cle === aujourdhui) {
    if (allDay) return "aujourd'hui";
    return parseInt(p.hour, 10) >= 18 ? 'ce soir · ' + heure : "aujourd'hui · " + heure;
  }
  if (cle === demain) return allDay ? 'demain' : 'demain · ' + heure;
  let jour = p.weekday.replace('.', '') + ' ' + p.day;
  if (d.getTime() - Date.now() > 6 * 86400000) {
    // au-delà d'une semaine, le mois lève l'ambiguïté (ufc, matchs lointains)
    jour = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' })
      .format(d).replace(/\./g, '');
  }
  return allDay ? jour : jour + ' · ' + heure;
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// décode les entités html d'un texte scrapé (apostrophes, accents…) avant qu'esc le ré-échappe
function decodeEntites(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, function (m, n) { return String.fromCharCode(parseInt(n, 10)); })
    .replace(/&#x([0-9a-f]+);/gi, function (m, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&rsquo;|&lsquo;/g, "'").replace(/&#8217;|&#8216;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    // apostrophes et guillemets typographiques → simples (rendu iOS 9 fiable)
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}
function item(titre, sous, next) {
  return '<div class="it' + (next ? ' next' : '') + '">' + esc(titre) +
    '<small>' + esc(sous) + '</small></div>';
}

/* ============================================================
   météo · open-meteo, gratuit et sans clé
   ============================================================ */
const CODES_METEO = [
  [0, 'ciel dégagé'], [1, 'éclaircies'], [2, 'éclaircies'], [3, 'couvert'],
  [45, 'brouillard'], [48, 'brouillard'], [51, 'bruine'], [55, 'bruine'],
  [61, 'pluie légère'], [63, 'pluie'], [65, 'pluie forte'], [66, 'pluie verglaçante'],
  [71, 'neige'], [75, 'neige'], [80, 'averses'], [82, 'averses'],
  [95, 'orage'], [99, 'orage'],
];
function libelleMeteo(code) {
  let lbl = 'météo';
  for (const [c, l] of CODES_METEO) { if (code >= c) lbl = l; }
  return lbl;
}
// famille d'icône css pour l'écran prévisions (dessinées dans le template)
function iconeMeteo(code) {
  if (code <= 1) return 'ico-soleil';
  if (code === 2) return 'ico-eclaircies';
  if (code === 3) return 'ico-couvert';
  if (code === 45 || code === 48) return 'ico-brouillard';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'ico-pluie';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'ico-neige';
  if (code >= 95) return 'ico-orage';
  return 'ico-couvert';
}
// conseil météo adaptatif et amical : « info · geste », toujours avec l'heure des choses.
// fonction pure et déterministe (pas d'aléatoire : la zone ne doit pas clignoter au poll).
// v = { h, tmax, tmin, ts, rhAuj, tmin2, tmax2, rhDem, lblDem }
//   h heure de paris · ts température prévue à 21 h (ou null)
//   rhAuj / rhDem prochaine heure de pluie aujourd'hui / demain (-1 si aucune)
function conseilMeteo(v) {
  const pluieProche = v.rhAuj >= 0 && v.rhAuj <= v.h;
  if (v.h < 12) {
    // le matin, cap sur la journée
    if (pluieProche) return "de la pluie dans l'heure · pense au parapluie";
    if (v.rhAuj >= 0) return 'averses vers ' + v.rhAuj + ' h · pense au parapluie';
    if (v.tmax >= 30) return "jusqu'à " + v.tmax + '° cet après-midi · sors léger, hydrate-toi';
    if (v.tmin <= 10) return 'frais ce matin (' + v.tmin + '°) · une petite laine, ' + v.tmax + '° cet après-midi';
    return 'journée au sec · ' + v.tmax + '° cet après-midi';
  }
  if (v.h < 18) {
    // l'après-midi, cap sur la soirée
    if (pluieProche) return "de la pluie dans l'heure · pense au parapluie";
    if (v.rhAuj >= 0) return 'averses vers ' + v.rhAuj + ' h · prends le parapluie';
    if (v.ts != null && (v.ts <= 16 || (v.tmax - v.ts >= 9 && v.ts <= 18))) return 'soirée à ' + v.ts + '° · prends un pull si tu sors';
    return 'soirée au sec · ' + (v.ts != null ? v.ts : v.tmin) + '° vers 21 h';
  }
  // le soir : la fin de soirée d'abord, sinon demain
  if (v.rhAuj >= 0) return 'ce soir, averses vers ' + v.rhAuj + ' h · parapluie si tu sors';
  if (v.rhDem >= 0) return 'demain, pluie vers ' + v.rhDem + ' h · parapluie au départ';
  if (v.tmax2 >= 30) return "demain jusqu'à " + v.tmax2 + '° · ferme les volets le matin';
  if (v.tmax2 <= v.tmax - 6) return 'demain plus frais (' + v.tmin2 + '° / ' + v.tmax2 + '°) · couvre-toi';
  return 'demain ' + v.tmin2 + '° / ' + v.tmax2 + '° · ' + v.lblDem;
}

async function majMeteo() {
  const u = 'https://api.open-meteo.com/v1/forecast?latitude=' + CFG.meteo.lat +
    '&longitude=' + CFG.meteo.lon +
    '&current=temperature_2m,weather_code' +
    '&daily=temperature_2m_max,temperature_2m_min,weather_code,sunrise,sunset,precipitation_probability_max,wind_speed_10m_max,uv_index_max' +
    '&hourly=precipitation_probability,temperature_2m' +
    '&forecast_days=7&timezone=' + encodeURIComponent(TZ);
  const r = await fetch(u);
  const j = await r.json();
  const t = Math.round(j.current.temperature_2m);
  const tmax = Math.round(j.daily.temperature_2m_max[0]);
  const tmin = Math.round(j.daily.temperature_2m_min[0]);
  const tmax2 = Math.round(j.daily.temperature_2m_max[1]);
  const tmin2 = Math.round(j.daily.temperature_2m_min[1]);
  const code2 = j.daily.weather_code[1];

  const n = parisParts(new Date());
  const h = parseInt(n.hour, 10);
  const cleAuj = n.year + '-' + n.month + '-' + n.day;
  const cleNow = cleAuj + 'T' + n.hour;
  // demain (clé AAAA-MM-JJ), calculé à midi utc pour éviter les bords d'heure d'été
  const dem = parisParts(new Date(Date.UTC(+n.year, +n.month - 1, +n.day, 12) + 86400000));
  const cleDem = dem.year + '-' + dem.month + '-' + dem.day;

  const H = (j.hourly && j.hourly.time) ? j.hourly
    : { time: [], precipitation_probability: [], temperature_2m: [] };
  // prochaine heure de pluie (proba ≥ 50 %) à partir de fromKey, limitée à un jour si fourni
  function prochainePluie(fromKey, jour) {
    for (let i = 0; i < H.time.length; i++) {
      if (H.time[i].slice(0, 13) < fromKey) continue;
      if (jour && H.time[i].slice(0, 10) !== jour) continue;
      if (H.precipitation_probability[i] >= 50) return parseInt(H.time[i].slice(11, 13), 10);
    }
    return -1;
  }
  // température prévue à une heure précise d'un jour donné
  function tempA(jour, heure) {
    const cible = jour + 'T' + (heure < 10 ? '0' + heure : heure);
    for (let i = 0; i < H.time.length; i++) {
      if (H.time[i].slice(0, 13) === cible) return Math.round(H.temperature_2m[i]);
    }
    return null;
  }

  const conseil = conseilMeteo({
    h: h, tmax: tmax, tmin: tmin,
    ts: tempA(cleAuj, 21),
    rhAuj: prochainePluie(cleNow, cleAuj),
    rhDem: prochainePluie(cleDem, cleDem),
    tmin2: tmin2, tmax2: tmax2,
    lblDem: libelleMeteo(code2),
  });

  // lever / coucher du soleil (heure locale paris) en minutes depuis minuit,
  // pour caler le mode nuit de l'ipad sur la vraie lumière du jour
  const enMinutes = s => {
    const m = String(s || '').match(/T(\d{2}):(\d{2})/);
    return m ? (+m[1]) * 60 + (+m[2]) : null;
  };
  const lever = enMinutes(j.daily.sunrise && j.daily.sunrise[0]);
  const coucher = enMinutes(j.daily.sunset && j.daily.sunset[0]);
  donnees.meteo.soleil = (lever != null && coucher != null) ? { lever: lever, coucher: coucher } : null;

  donnees.meteo.html = esc(libelleMeteo(j.current.weather_code)) + ' · <b>' + t + '°</b>' +
    '<span class="mdetail">' + tmin + '° / ' + tmax + '°</span>' +
    '<span class="mconseil">' + esc(conseil) + '</span>';

  // ---- écran prévisions : 7 colonnes pré-rendues (une par jour) ----
  const JSEM = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
  const base = Date.UTC(+n.year, +n.month - 1, +n.day, 12);
  const nbJours = Math.min(7, (j.daily.time || j.daily.temperature_2m_max || []).length);
  const cols = [];
  for (let k = 0; k < nbJours; k++) {
    const d = new Date(base + k * 86400000);
    const pk = parisParts(d);
    const etiq = k === 0 ? "aujourd'hui" : k === 1 ? 'demain' : JSEM[d.getUTCDay()] + ' ' + parseInt(pk.day, 10);
    const pp = (j.daily.precipitation_probability_max || [])[k];
    const vent = Math.round((j.daily.wind_speed_10m_max || [])[k] || 0);
    const uv = Math.round((j.daily.uv_index_max || [])[k] || 0);
    cols.push('<div class="pj' + (k === 0 ? ' today' : '') + '">' +
      '<div class="pjh">' + esc(etiq) + '</div>' +
      '<div class="pico ' + iconeMeteo(j.daily.weather_code[k]) + '"><i></i></div>' +
      '<div class="pjl">' + esc(libelleMeteo(j.daily.weather_code[k])) + '</div>' +
      '<div class="pjt">' + Math.round(j.daily.temperature_2m_max[k]) + '°</div>' +
      '<div class="pjm">' + Math.round(j.daily.temperature_2m_min[k]) + '°</div>' +
      (pp >= 30 ? '<div class="pjp">pluie ' + Math.round(pp) + ' %</div>' : '<div class="pjp vide">&nbsp;</div>') +
      '<div class="pjv' + (vent >= 40 ? ' fort' : '') + '">vent ' + vent + (uv >= 6 ? ' · uv ' + uv : '') + '</div>' +
      '</div>');
  }
  donnees.meteo.previsions = cols.join('');
  sante.meteo = Date.now();
}

/* ============================================================
   moments de l'année · petit clin d'œil sur la ligne de date
   (noël, nouvel an, saint-valentin + dates de config.moments)
   ============================================================ */
function momentDuJour() {
  const p = parisParts(new Date());
  const md = p.month + '-' + p.day; // "12-24"
  // les moments personnalisés (anniversaires…) priment sur les fêtes du calendrier
  const perso = (CFG.moments || []).find(m => m && m.jour === md && m.texte);
  if (perso) return { cls: 'm-fete', texte: String(perso.texte).toLowerCase() };
  if (md >= '12-20' && md <= '12-23') return { cls: 'm-noel', texte: "c'est bientôt noël" };
  if (md >= '12-24' && md <= '12-26') return { cls: 'm-noel', texte: 'joyeux noël' };
  if (md === '12-31') return { cls: 'm-fete', texte: 'bonne saint-sylvestre' };
  if (md === '01-01') return { cls: 'm-fete', texte: 'bonne année' };
  if (md === '02-14') return { cls: 'm-coeur', texte: 'joyeuse saint-valentin' };
  return null;
}

/* ============================================================
   watchdog · l'ipad interroge le serveur en continu ; s'il se tait
   trop longtemps (safari planté, ipad déchargé), on prévient via
   config.alerteUrl (webhook texte type ntfy.sh), une seule fois
   ============================================================ */
let dernierPoll = Date.now();
let ecranMuet = false;
const SEUIL_ECRAN = 30 * 60 * 1000;
async function alerte(texte) {
  console.log('[watchdog]', texte);
  if (!CFG.alerteUrl) return;
  try {
    await fetch(CFG.alerteUrl, { method: 'POST', headers: { Title: 'ecran maison' }, body: texte });
  } catch (e) { console.log('[watchdog] alerte impossible :', e.message); }
}
function verifieEcran() {
  const silence = Date.now() - dernierPoll;
  if (!ecranMuet && silence > SEUIL_ECRAN) {
    ecranMuet = true;
    alerte("l'écran ne répond plus depuis " + Math.round(silence / 60000) + ' min (safari planté ou ipad déchargé ?)');
  } else if (ecranMuet && silence < 2 * 60 * 1000) {
    ecranMuet = false;
    alerte("l'écran est de retour");
  }
}

/* ============================================================
   agenda · calendrier icloud publié (url ics), récurrences incluses
   ============================================================ */
// épingles : événements perso choisis à la main (tap dans la vue semaine) pour
// apparaître aussi dans l'arche. clé = ms de début + '|' + titre, persistées sur disque.
const EPINGLES_PATH = path.join(__dirname, 'epingles.json');
let epingles = {};
try { epingles = JSON.parse(fs.readFileSync(EPINGLES_PATH, 'utf8')); } catch (e) { /* premier passage */ }
function sauveEpingles() {
  // purge des épingles d'événements passés depuis longtemps
  const seuil = Date.now() - 45 * 86400000;
  Object.keys(epingles).forEach(k => { if (+k.split('|')[0] < seuil) delete epingles[k]; });
  try { fs.writeFileSync(EPINGLES_PATH, JSON.stringify(epingles)); } catch (e) { /* tant pis */ }
}

async function majAgenda() {
  // un ou plusieurs calendriers : config.agendas [{url, qui}], sinon l'ancien icsUrl seul.
  // qui : 'maison' (pas de signature), 'Antoine' ou 'Inès' (mêmes couleurs que le ménage)
  const cals = Array.isArray(CFG.agendas) && CFG.agendas.length
    ? CFG.agendas
    : [{ url: CFG.icsUrl, qui: 'maison' }];
  const charges = await Promise.allSettled(cals.map(c => ical.async.fromURL(c.url)));
  const jeux = [];
  charges.forEach((r, i) => {
    if (r.status === 'fulfilled') jeux.push({ data: r.value, qui: cals[i].qui || 'maison' });
    else console.log('[maj] agenda', cals[i].qui || '#' + i, 'en échec :', r.reason.message);
  });
  if (!jeux.length) throw new Error('aucun calendrier joignable');

  // occurrences de tous les calendriers dans une fenêtre, triées, signées par calendrier
  const collecte = (debut, fin) => {
    const out = [];
    for (const jx of jeux) {
      for (const k of Object.keys(jx.data)) {
        const ev = jx.data[k];
        if (!ev || ev.type !== 'VEVENT') continue;
        const allDay = ev.datetype === 'date';
        if (ev.rrule) {
          // occurrences des événements récurrents (poubelles hebdo, etc.)
          ev.rrule.between(debut, fin, true).forEach(d => {
            out.push({ date: d, titre: ev.summary, allDay: allDay, qui: jx.qui });
          });
        } else if (ev.start >= debut && ev.start <= fin) {
          out.push({ date: ev.start, titre: ev.summary, allDay: allDay, qui: jx.qui });
        }
      }
    }
    out.sort((a, b) => a.date - b.date);
    return out;
  };
  // signature d'un événement perso : suffixe texte (arche) et pastille (vue semaine)
  const signe = o => o.qui && o.qui !== 'maison' ? ' · ' + String(o.qui).toLowerCase() : '';
  const pastille = o => {
    if (!o.qui || o.qui === 'maison') return '';
    return '<span class="p ' + (String(o.qui).toLowerCase().charAt(0) === 'i' ? 'i' : 'a') + '"></span>';
  };
  const cleOcc = o => o.date.getTime() + '|' + o.titre;
  const estPerso = o => o.qui && o.qui !== 'maison';

  // l'arche ne montre que la maison + les événements perso épinglés à la main
  const occs = collecte(new Date(Date.now() - 2 * 3600000), // garde ce qui vient de commencer
    new Date(Date.now() + 7 * 86400000))
    .filter(o => !estPerso(o) || epingles[cleOcc(o)]);

  // la prochaine échéance à venir est mise en évidence (classe "next")
  const maintenant = Date.now();
  const prochaine = occs.find(o => o.date.getTime() >= maintenant);

  // deux sections dans l'arche : le jour même, puis les jours suivants
  const cleAuj = jourCle(new Date());
  const auj = occs.filter(o => jourCle(o.date) === cleAuj).slice(0, 2);
  const venir = occs.filter(o => jourCle(o.date) !== cleAuj).slice(0, 2);

  donnees.agenda.auj = auj.length
    ? auj.map(o => item(o.titre, heureLabel(o.date, o.allDay) + signe(o), o === prochaine)).join('\n')
    : item('rien de prévu', 'journée libre');
  donnees.agenda.venir = venir.length
    ? venir.map(o => item(o.titre, quandLabel(o.date, o.allDay) + signe(o), o === prochaine)).join('\n')
    : item('semaine calme', 'rien devant');

  // ---- vue détail : semaines -1 à +6, pré-rendues (iOS 9 n'a pas Intl client) ----
  const p0 = parisParts(new Date());
  const msBase = Date.UTC(+p0.year, +p0.month - 1, +p0.day, 12); // midi, à l'abri des bascules d'heure
  const dowAuj = new Date(Date.UTC(+p0.year, +p0.month - 1, +p0.day)).getUTCDay(); // 0=dim..6=sam
  const versLundi = (dowAuj === 0 ? -6 : 1 - dowAuj);
  const JSEM = ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];
  const MOISCOURT = ['janv', 'févr', 'mars', 'avr', 'mai', 'juin', 'juil', 'août', 'sept', 'oct', 'nov', 'déc'];
  const cleAujDetail = jourCle(new Date());

  // occurrences sur une large fenêtre (semaine -1 à +6), tous calendriers
  const occ2 = collecte(new Date(msBase + (versLundi - 8) * 86400000),
    new Date(msBase + (versLundi + 50) * 86400000));

  const semaines = [];
  for (let w = -1; w <= 6; w++) {
    const cols = [];
    let lab1 = '', lab2 = '';
    for (let jr = 0; jr < 7; jr++) {
      const sd = new Date(msBase + (versLundi + w * 7 + jr) * 86400000);
      const sp = parisParts(sd);
      const cle = jourCle(sd);
      const etiq = parseInt(sp.day, 10) + ' ' + MOISCOURT[+sp.month - 1];
      if (jr === 0) lab1 = etiq;
      if (jr === 6) lab2 = etiq;
      // la colonne défile en interne : on peut afficher la journée entière (plafond large par sécurité)
      const evs = occ2.filter(o => jourCle(o.date) === cle).sort((a, b) => a.date - b.date).slice(0, 12);
      const cellEvs = evs.map(o => {
        // un événement perso se touche pour l'épingler à l'accueil (ou l'en retirer)
        const epi = estPerso(o) && epingles[cleOcc(o)];
        const attr = estPerso(o)
          ? ' onclick="return epingler(\'' + encodeURIComponent(cleOcc(o)).replace(/'/g, '%27') + '\')"'
          : '';
        return '<div class="ev' + (o.allDay ? ' allday' : '') + (epi ? ' epingle' : '') + '"' + attr +
          '><div class="h">' + esc(o.allDay ? 'journée' : heureLabel(o.date, false)) +
          (epi ? " · à l'accueil" : '') + '</div><div class="t">' +
          pastille(o) + esc(o.titre) + '</div></div>';
      }).join('');
      cols.push('<div class="jour' + (cle === cleAujDetail ? ' today' : '') + '"><div class="jh">' +
        esc(JSEM[jr] + ' ' + parseInt(sp.day, 10)) + '</div>' + cellEvs + '</div>');
    }
    semaines.push({ label: lab1 + ' – ' + lab2, html: cols.join('') });
  }
  donnees.agenda.semaines = semaines;
  sante.agenda = Date.now();
}

// libellé court pour la section "aujourd'hui" (la date serait redondante)
function heureLabel(d, allDay) {
  if (allDay) return 'toute la journée';
  const p = parisParts(d);
  return parseInt(p.hour, 10) + ' h' + (p.minute !== '00' ? ' ' + p.minute : '');
}

/* ============================================================
   sport · trois sources mélangées puis triées par date :
   foot (football-data.org, clé), nba et ufc (espn public, sans clé)
   ============================================================ */
async function fdFetch(chemin) {
  const r = await fetch('https://api.football-data.org/v4' + chemin, {
    headers: { 'X-Auth-Token': CFG.footballDataKey },
  });
  return r.json();
}
async function espnJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('espn ' + r.status);
  return r.json();
}
function sansAccents(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// matchs de chaque équipe de foot suivie (losc, milan, liverpool, france…) :
// à venir (3 max par équipe) + résultats des 8 derniers jours (marqués resultat:true).
// une seule requête par équipe (fenêtre -8 j → +70 j), l'api limite à 10 req/min
async function footCandidats() {
  const out = [];
  if (!CFG.footballDataKey || !Array.isArray(CFG.equipesFoot)) return out;
  const iso = ms => new Date(ms).toISOString().slice(0, 10);
  const fenetre = '?dateFrom=' + iso(Date.now() - 8 * 86400000) + '&dateTo=' + iso(Date.now() + 70 * 86400000);
  for (const eq of CFG.equipesFoot) {
    try {
      const j = await fdFetch('/teams/' + eq.id + '/matches' + fenetre);
      let avenir = 0;
      (j.matches || []).forEach(m => {
        const comp = (m.competition && m.competition.name) ? m.competition.name.toLowerCase() : 'foot';
        const ft = m.score && m.score.fullTime;
        if (m.status === 'FINISHED' && ft && ft.home != null && ft.away != null) {
          // résultat : affiché dans l'ordre domicile-extérieur avec le score
          const nom = t => t.id === eq.id ? eq.nom : String(t.shortName || t.name || t.tla || '').toLowerCase();
          out.push({
            date: new Date(m.utcDate), disc: 'foot', comp: comp, resultat: true,
            titre: nom(m.homeTeam) + ' ' + ft.home + '-' + ft.away + ' ' + nom(m.awayTeam),
          });
        } else if (m.status !== 'FINISHED' && new Date(m.utcDate) > new Date() && avenir < 3) {
          avenir++;
          const adv = m.homeTeam.id === eq.id ? m.awayTeam : m.homeTeam;
          out.push({
            date: new Date(m.utcDate), disc: 'foot', comp: comp,
            titre: eq.nom + ' · ' + String(adv.shortName || adv.name || adv.tla || '').toLowerCase(),
          });
        }
      });
    } catch (e) { /* une équipe en échec ne bloque pas les autres */ }
  }
  return out;
}

// prochain match des équipes nba suivies (suns, knicks…)
async function nbaCandidats() {
  const out = [];
  if (!Array.isArray(CFG.nba)) return out;
  for (const eq of CFG.nba) {
    try {
      const j = await espnJson('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/' + eq.espn + '/schedule');
      const moi = String((j.team && j.team.id) || '');
      const prochains = (j.events || [])
        .filter(ev => new Date(ev.date) > new Date())
        .sort((a, b) => new Date(a.date) - new Date(b.date))
        .slice(0, 3);
      prochains.forEach(prochain => {
        let adv = '';
        const comp = prochain.competitions && prochain.competitions[0];
        if (comp && comp.competitors) {
          const c = comp.competitors.find(c => String(c.team && c.team.id) !== moi);
          if (c && c.team) adv = String(c.team.shortDisplayName || c.team.displayName || '').toLowerCase();
        }
        out.push({ date: new Date(prochain.date), disc: 'nba', comp: 'nba', titre: adv ? eq.nom + ' · ' + adv : eq.nom });
      });
    } catch (e) { /* espn muet : on passe */ }
  }
  return out;
}

// mma : tous les événements des organisations suivies (config.mma, par défaut ufc + pfl
// via l'api espn). titre = tête d'affiche du calendrier ("ufc 324 · makhachev-gaethje") ;
// un combattant de config.mmaFrancais (repli ufcFrancais) à la carte est signalé en plus
// s'il n'est pas déjà dans le titre. ksw / ares / hexagone : pas d'api fiable, passer
// par les événements manuels d'events.json (fusionnés dans majSport).
async function mmaCandidats() {
  const out = [];
  const ligues = Array.isArray(CFG.mma) && CFG.mma.length
    ? CFG.mma
    : [{ espn: 'ufc', nom: 'ufc' }, { espn: 'pfl', nom: 'pfl' }];
  const suivis = CFG.mmaFrancais || CFG.ufcFrancais || [];
  for (const lg of ligues) {
    try {
      const sb = await espnJson('https://site.api.espn.com/apis/site/v2/sports/mma/' + lg.espn + '/scoreboard');
      const cal = (((sb.leagues || [])[0] || {}).calendar) || [];
      for (const c of cal) {
        const brut = new Date(c.startDate || c);
        if (isNaN(brut) || brut < new Date(Date.now() - 12 * 3600000) ||
            brut > new Date(Date.now() + 35 * 86400000)) continue;
        const label = String(c.label || '');
        // l'émission hebdo de recrutement pollue le calendrier ufc ("Season 10, Week N")
        if (/contender series/i.test(label)) continue;
        const num = label.match(new RegExp('^' + lg.nom + '\\s+(\\d+)', 'i'));
        // tête d'affiche depuis le libellé du calendrier ("Org…: A vs. B")
        const tete = sansAccents(label.split(':')[1] || '').trim().toLowerCase()
          .replace(/\s+vs\.?\s+/i, '-').replace(/\./g, '');
        // carte du jour : date réelle de l'événement et détection d'un français suivi
        let date = brut, allDay = true, francais = '';
        try {
          const ymd = brut.toISOString().slice(0, 10).replace(/-/g, '');
          const jour = await espnJson('https://site.api.espn.com/apis/site/v2/sports/mma/' + lg.espn + '/scoreboard?dates=' + ymd);
          (jour.events || []).forEach(ev => {
            if (ev.date) { date = new Date(ev.date); allDay = false; }
            (ev.competitions || []).forEach(co => {
              (co.competitors || []).forEach(a => {
                const nom = sansAccents((a.athlete && a.athlete.displayName) || '').toLowerCase();
                const hit = suivis.find(f => nom.indexOf(sansAccents(f).toLowerCase()) !== -1);
                if (hit && !francais) francais = hit;
              });
            });
          });
        } catch (e) { /* on garde la date du calendrier, sans heure */ }
        const orgTag = num ? lg.nom + ' ' + num[1] : lg.nom;
        const titre = tete ? orgTag + ' · ' + tete : orgTag;
        out.push({
          date: date, titre: titre, allDay: allDay, disc: 'ufc',
          comp: lg.nom === 'ufc' ? (num ? 'ppv' : 'fight night') : lg.nom,
          // signalé seulement s'il n'est pas déjà la tête d'affiche
          francais: francais && titre.indexOf(sansAccents(francais).toLowerCase()) === -1 ? francais : '',
        });
      }
    } catch (e) { /* ligue muette (api absente ou en panne) : on passe */ }
  }
  return out;
}

// libellé relatif d'une date passée : "aujourd'hui", "hier", sinon "sam 26"
function labelPasse(d) {
  const cle = jourCle(d);
  if (cle === jourCle(new Date())) return "aujourd'hui";
  if (cle === jourCle(new Date(Date.now() - 86400000))) return 'hier';
  const p = parisParts(d);
  return p.weekday.replace('.', '') + ' ' + parseInt(p.day, 10);
}

async function majSport() {
  const cands = [];
  for (const source of [footCandidats, nbaCandidats, mmaCandidats]) {
    try { cands.push.apply(cands, await source()); } catch (e) { /* source muette */ }
  }
  // événements ajoutés à la main dans events.json (ksw, ares, hexagone… sans api) :
  // une entrée avec "date" est fusionnée au flux normal
  let manuels = [];
  try { manuels = JSON.parse(fs.readFileSync(path.join(__dirname, 'events.json'), 'utf8')); } catch (e) { /* pas de fichier */ }
  manuels.forEach(e => {
    if (!e || !e.date || !e.titre) return;
    const d = new Date(e.date);
    if (isNaN(d) || d < new Date(Date.now() - 12 * 3600000)) return;
    cands.push({ date: d, titre: e.titre, comp: e.comp || '', disc: e.disc || 'ufc', allDay: !/T\d/.test(String(e.date)) });
  });
  // résultats récents d'un côté (du plus frais au plus ancien), matchs à venir de l'autre
  const passes = cands.filter(c => c.resultat).sort((a, b) => b.date - a.date);
  const futurs = cands.filter(c => !c.resultat).sort((a, b) => a.date - b.date);
  // arche : le dernier résultat en tête (s'il y en a un), puis les prochains matchs
  const items = [];
  if (passes.length) {
    items.push(item(passes[0].titre, labelPasse(passes[0].date) + (passes[0].comp ? ' · ' + passes[0].comp : '')));
  }
  futurs.slice(0, 4 - items.length).forEach(c => items.push(
    item(c.titre, quandLabel(c.date, !!c.allDay) + (c.francais ? ' · ' + c.francais : ''))));
  if (!items.length) {
    // repli : les entrées sans date d'events.json
    try {
      const man = JSON.parse(fs.readFileSync(path.join(__dirname, 'events.json'), 'utf8'));
      man.filter(e => e && !e.date).slice(0, 2).forEach(e => items.push(item(e.titre, e.sous)));
    } catch (e) { /* rien */ }
  }
  donnees.sport.html = items.join('\n') || item('pas de match prévu', 'trêve');

  // ---- vue détail : liste complète groupée cette semaine / à venir ----
  const limite = Date.now() + 7 * 86400000;
  const ligneSport = c => {
    const p = parisParts(c.date);
    const loin = c.date.getTime() - Date.now() > 6 * 86400000;
    const jour = c.allDay
      ? (loin ? parseInt(p.day, 10) + '/' + parseInt(p.month, 10) : p.weekday.replace('.', '') + ' ' + parseInt(p.day, 10))
      : (loin ? parseInt(p.day, 10) + '/' + parseInt(p.month, 10) : p.weekday.replace('.', '') + ' ' + parseInt(p.day, 10));
    const heure = c.allDay ? '' : parseInt(p.hour, 10) + ' h' + (p.minute !== '00' ? ' ' + p.minute : '');
    return '<div class="match"><div class="cal"><div class="j">' + esc(jour) + '</div><div class="h">' + esc(heure || '—') + '</div></div>' +
      '<div class="aff"><span class="pastille ' + (c.disc || '') + '"></span>' + esc(c.titre) + '</div>' +
      '<div class="comp">' + esc((c.comp || '') + (c.francais ? ' · ' + c.francais : '')) + '</div></div>';
  };
  const sem = futurs.filter(c => c.date.getTime() <= limite);
  const apres = futurs.filter(c => c.date.getTime() > limite);
  let det = '';
  if (passes.length) det += '<div class="sect">derniers résultats</div>' + passes.slice(0, 4).map(ligneSport).join('');
  if (sem.length) det += '<div class="sect">cette semaine</div>' + sem.map(ligneSport).join('');
  if (apres.length) det += '<div class="sect">à venir</div>' + apres.map(ligneSport).join('');
  donnees.sport.detail = det || '<div class="sect">pas de match prévu</div>';
  sante.sport = Date.now();
}

/* ============================================================
   studio · endpoint netlify du media kit yum.ines
   >>> adapter les deux lignes de lecture au format réel du json <<<
   ============================================================ */
async function abonnesInstagram(compte) {
  // stratégie 1 : l'api web qu'utilise le site instagram lui-même (compte exact)
  try {
    const r = await fetch('https://i.instagram.com/api/v1/users/web_profile_info/?username=' + compte, {
      headers: { 'User-Agent': 'Instagram 219.0.0.12.117 Android', 'x-ig-app-id': '936619743392459' },
    });
    if (r.ok) {
      const j = await r.json();
      const n = j.data && j.data.user && j.data.user.edge_followed_by && j.data.user.edge_followed_by.count;
      if (n) return n;
    }
  } catch (e) { /* on tente la page html */ }
  // stratégie 2 : la page publique du profil
  try {
    const r = await fetch('https://www.instagram.com/' + compte + '/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        'Accept-Language': 'fr-FR,fr;q=0.9',
      },
    });
    if (!r.ok) return null;
    const html = await r.text();
    const m = html.match(/"edge_followed_by":\{"count":(\d+)/) ||
      html.match(/"follower_count":(\d+)/) ||
      html.match(/userInteractionCount[^\d]*(\d+)/);
    if (m) return parseInt(m[1], 10);
    // repli : le compte arrondi de la balise og:description ("12,8 k abonnés")
    const og = html.match(/([\d.,]+)\s*([km]?)\s*(?:followers|abonn)/i);
    if (og) {
      const mult = og[2].toLowerCase() === 'm' ? 1e6 : og[2].toLowerCase() === 'k' ? 1e3 : 1;
      return Math.round(parseFloat(og[1].replace(',', '.')) * mult);
    }
  } catch (e) { /* muet */ }
  return null;
}

const HIST_PATH = path.join(__dirname, 'studio-historique.json');
async function majStudio() {
  let abonnes = null, secours = false;

  // source 1 : endpoint dédié si un jour statsUrl est renseignée
  if (CFG.statsUrl) {
    const r = await fetch(CFG.statsUrl);
    const j = await r.json();
    abonnes = Number(j.followers || j.abonnes || (j.instagram && j.instagram.followers)) || null;
  }

  // source 2 : instagram, deux stratégies (l'api web du site, puis la page html)
  if (abonnes === null && CFG.instagram) abonnes = await abonnesInstagram(CFG.instagram);

  // source 3 : valeur manuelle de secours (config.abonnesManuel), mise à jour à la main
  if (abonnes === null && CFG.abonnesManuel) { abonnes = Number(CFG.abonnesManuel) || null; secours = true; }

  if (!abonnes) {
    if (CFG.instagram || CFG.statsUrl) throw new Error('instagram muet (renseigner abonnesManuel en secours)');
    return; // rien de configuré : pendentif masqué
  }

  // historique quotidien local pour le delta sur 7 jours
  let hist = {};
  try { hist = JSON.parse(fs.readFileSync(HIST_PATH, 'utf8')); } catch (e) { /* premier passage */ }
  hist[jourCle(new Date())] = abonnes;
  try { fs.writeFileSync(HIST_PATH, JSON.stringify(hist)); } catch (e) { /* tant pis */ }
  const cle7 = jourCle(new Date(Date.now() - 7 * 86400000));
  const anciennes = Object.keys(hist).filter(k => k <= cle7).sort();
  const ref = anciennes.length ? hist[anciennes[anciennes.length - 1]] : null;
  const delta = ref === null ? null : abonnes - ref;

  // affichage : chiffre exact quand il vient d'instagram/statsUrl,
  // arrondi « 13K » quand c'est la valeur de secours (à changer moins souvent)
  const affiche = secours ? formatAbonnes(abonnes) : abonnes.toLocaleString('fr-FR');
  donnees.studio.html =
    '<div class="p-lbl">yum.ines</div>' +
    '<div class="p-num">' + esc(affiche) + '</div>' +
    (delta ? '<div class="p-lbl">' + esc((delta > 0 ? '+' : '') + delta + ' sur 7 jours') + '</div>' : '');
  sante.studio = Date.now();
}

// nombre d'abonnés abrégé : 13100 → « 13K », 1250000 → « 1,3M » (le delta 7 j reste exact)
function formatAbonnes(n) {
  if (n >= 1000000) return String(Math.round(n / 100000) / 10).replace('.', ',') + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'K';
  return n.toLocaleString('fr-FR');
}

/* ============================================================
   ciné · films à l'affiche les mieux notés dans les cinémas
   configurés (pages horaires allociné, notes presse + spectateurs)
   ============================================================ */
// parse une page horaires allociné → films {titre, presse, spect, catalogue, score, seancesParDate}
// seancesParDate : { 'AAAA-MM-JJ': ['HH:MM', …] } — toutes les dates présentes sur la page
// (la page .html d'un cinéma contient en général aujourd'hui + demain, parfois plus)
function parseFilmsAllocine(html) {
  const anneeCourante = new Date().getFullYear();
  const films = [];
  const cartes = html.split(/class="[^"]*movie-card/).slice(1);
  for (const carte of cartes) {
    const t = carte.match(/meta-title-link[^>]*>\s*([^<]+?)\s*</) ||
      carte.match(/meta-title-link[^>]*title="([^"]+)"/);
    if (!t || !t[1].trim()) continue;
    const titre = decodeEntites(t[1].trim());
    let presse = 0, spect = 0;
    for (const bloc of carte.split(/class="[^"]*rating-item/).slice(1)) {
      const nidx = bloc.indexOf('stareval-note');
      if (nidx === -1) continue;
      const note = bloc.slice(nidx).match(/stareval-note[^>]*>\s*([\d,.]+)/);
      if (!note) continue;
      const val = parseFloat(note[1].replace(',', '.'));
      if (isNaN(val)) continue;
      const avant = bloc.slice(0, nidx).toLowerCase();
      if (avant.indexOf('spectateur') !== -1) spect = Math.max(spect, val);
      else if (avant.indexOf('presse') !== -1) presse = Math.max(presse, val);
    }
    const dm = carte.match(/(?:janvier|f[eé]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[eé]cembre)\s+(\d{4})/i);
    const annee = dm ? parseInt(dm[1], 10) : 0;
    const cf = carte.match(/cfilm=(\d+)/);
    const catalogue = /\breprise\b/i.test(carte.slice(0, 1500)) ||
      (cf && parseInt(cf[1], 10) < 20000) || (annee && annee <= anneeCourante - 2);
    const score = presse && spect ? (presse + spect) / 2 : (presse || spect);
    // séances : data-showtime-time="2026-07-26T10:45:00+02:00" (déjà en heure de Paris)
    const seancesParDate = {};
    const sre = /data-showtime-time="(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/g;
    let sm;
    while ((sm = sre.exec(carte))) {
      const arr = seancesParDate[sm[1]] || (seancesParDate[sm[1]] = []);
      if (arr.indexOf(sm[2]) === -1) arr.push(sm[2]);
    }
    Object.keys(seancesParDate).forEach(d => seancesParDate[d].sort());
    films.push({ titre, presse, spect, catalogue: !!catalogue, score, seancesParDate });
  }
  return films;
}

async function majCinema() {
  if (!Array.isArray(CFG.cinemas) || !CFG.cinemas.length) return;
  const notes = n => n.toFixed(1).replace('.', ',');
  const agg = {};        // titre → notes agrégées + salles (pour l'arche, jour même)

  // récupère chaque cinéma une fois (la page .html porte aujourd'hui + demain)
  const parCine = [];
  const datesPresentes = {};
  for (const cine of CFG.cinemas) {
    let films = [];
    try {
      const r = await fetch('https://www.allocine.fr/seance/salle_gen_csalle=' + cine.allocine + '.html', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          'Accept-Language': 'fr-FR,fr;q=0.9',
        },
      });
      if (!r.ok) throw new Error('allociné ' + r.status);
      films = parseFilmsAllocine(await r.text()).filter(f => f.score > 0);
    } catch (e) { /* un cinéma muet n'empêche pas les autres */ }
    parCine.push({ nom: cine.nom, films: films });
    films.forEach(f => Object.keys(f.seancesParDate).forEach(d => { datesPresentes[d] = true; }));
  }

  // jours à afficher : les dates réellement présentes, dans la fenêtre [aujourd'hui, +6],
  // triées, 3 max. Toujours au moins aujourd'hui, même sans séance.
  const JSEM = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
  const p0 = parisParts(new Date());
  const base = Date.UTC(+p0.year, +p0.month - 1, +p0.day, 12);
  const aujISO = p0.year + '-' + p0.month + '-' + p0.day;
  const fenetre = [];
  for (let k = 0; k < 7; k++) {
    const d = new Date(base + k * 86400000);
    const pk = parisParts(d);
    fenetre.push({ iso: pk.year + '-' + pk.month + '-' + pk.day, off: k, dow: d.getUTCDay(), day: +pk.day });
  }
  let jours = fenetre.filter(j => datesPresentes[j.iso]).slice(0, 3);
  if (!jours.length) jours = [fenetre[0]];
  const joursISO = jours.map(j => j.iso);
  const joursLabel = jours.map(j => j.off === 0 ? "aujourd'hui" : j.off === 1 ? 'demain' : JSEM[j.dow] + ' ' + j.day);

  // agrégat de l'arche : films réellement à l'affiche aujourd'hui
  parCine.forEach(c => c.films.forEach(f => {
    if (!f.seancesParDate[aujISO]) return;
    const a = agg[f.titre] || (agg[f.titre] = { presse: 0, spect: 0, catalogue: false, ou: [] });
    a.presse = Math.max(a.presse, f.presse);
    a.spect = Math.max(a.spect, f.spect);
    if (f.catalogue) a.catalogue = true;
    if (a.ou.indexOf(c.nom) === -1) a.ou.push(c.nom);
  }));
  if (!Object.keys(agg).length && !Object.keys(datesPresentes).length) throw new Error('aucune séance trouvée');

  // détail : pour chaque jour affiché, une colonne par cinéma (séances de ce jour, triées par note)
  const detailJours = joursISO.map(iso => {
    return parCine.map(c => {
      const html = c.films.filter(f => f.seancesParDate[iso] && f.seancesParDate[iso].length)
        .sort((a, b) => b.score - a.score)
        .map(f => {
          const no = [f.presse ? 'presse ' + notes(f.presse) : '', f.spect ? 'spect ' + notes(f.spect) : ''].filter(Boolean).join(' · ');
          return '<div class="film"><div class="n">' + esc(f.titre) + '</div>' +
            (f.catalogue ? '<span class="rep">reprise</span>' : '') +
            (no ? '<div class="no">' + esc(no) + '</div>' : '') +
            '<div class="se">' + esc(f.seancesParDate[iso].join(' · ')) + '</div></div>';
        }).join('');
      return '<div class="cine"><div class="ch">' + esc(c.nom) + '</div>' +
        (html || '<div class="film"><div class="no">—</div></div>') + '</div>';
    }).join('');
  });

  const tous = Object.keys(agg).map(titre => {
    const a = agg[titre];
    const score = a.presse && a.spect ? (a.presse + a.spect) / 2 : (a.presse || a.spect);
    return { titre, presse: a.presse, spect: a.spect, ou: a.ou, catalogue: a.catalogue, score };
  }).filter(f => f.score > 0).sort((a, b) => b.score - a.score);

  // arche : mix 2 meilleures nouveautés + 2 meilleures reprises
  const nouveautes = tous.filter(f => !f.catalogue).slice(0, 2);
  const reprises = tous.filter(f => f.catalogue).slice(0, 2);
  let sel = nouveautes.concat(reprises);
  sel = sel.concat(tous.filter(f => sel.indexOf(f) === -1).slice(0, 4 - sel.length));
  donnees.cinema.html = sel.map(f => {
    const salles = f.ou.length > 2 ? f.ou.length + ' salles' : f.ou.join(' + ');
    const sous = [f.catalogue ? 'reprise' : '', salles,
      f.presse ? 'presse ' + notes(f.presse) : '', f.spect ? 'spect ' + notes(f.spect) : '']
      .filter(Boolean).join(' · ');
    return item(f.titre.toLowerCase(), sous);
  }).join('\n');

  donnees.cinema.joursLabel = joursLabel;
  donnees.cinema.detailJours = detailJours;
  sante.cinema = Date.now();
}

/* ============================================================
   ménage · roulement fixe (config.menage), une personne par jour,
   week-end à deux ; le serveur calcule où on en est dans le cycle
   ============================================================ */
function joursDepuis(dateStr) {
  // nombre de jours entre dateStr (AAAA-MM-JJ) et aujourd'hui, en heure de paris
  const p = parisParts(new Date());
  const auj = Date.UTC(+p.year, +p.month - 1, +p.day);
  const m = String(dateStr).split('-');
  const dep = Date.UTC(+m[0], +m[1] - 1, +m[2]);
  return Math.round((auj - dep) / 86400000);
}
function cycleMenage() {
  // déplie les semaines en un tableau jour par jour (lun→dim), week-end à deux
  const cy = [];
  (CFG.menage.semaines || []).forEach(s => {
    (s.jours || []).forEach(j => cy.push({ qui: j[0], tache: j[1] }));
    cy.push({ qui: 'tous', tache: s.we });
    cy.push({ qui: 'tous', tache: s.we });
  });
  return cy; // 42 entrées pour 6 semaines
}
function entreeMenage(cy, offsetJours) {
  const n = cy.length;
  const idx = ((joursDepuis(CFG.menage.depart) + offsetJours) % n + n) % n;
  return cy[idx];
}
function dotsMenage(qui) {
  if (qui === 'tous') return { cls: 'we', nom: 'ensemble' };
  return { cls: qui === 'Inès' ? 'i' : 'a', nom: qui };
}
function majMenage() {
  if (!CFG.menage || !Array.isArray(CFG.menage.semaines) || !CFG.menage.semaines.length) return;
  const cy = cycleMenage();
  if (!cy.length) return;

  // ligne compacte de l'écran principal (aujourd'hui)
  const e = entreeMenage(cy, 0);
  const d = dotsMenage(e.qui);
  const pts = e.qui === 'tous'
    ? '<span class="dot a"></span><span class="dot i"></span>'
    : '<span class="dot ' + d.cls + '"></span>';
  donnees.menage.compact = '<span class="lab">ménage</span>' + pts +
    '<span class="nom">' + esc(d.nom) + '</span><span class="tache">' + esc(e.tache) + '</span>';

  // planning : semaine dernière · cette semaine (aujourd'hui) · semaine prochaine
  const jrs = ['lun', 'mar', 'mer', 'jeu', 'ven', 'sam', 'dim'];
  const titres = ['semaine dernière', 'cette semaine', 'semaine prochaine'];
  const jd = joursDepuis(CFG.menage.depart);
  const dow = ((jd % 7) + 7) % 7; // depart = lundi → 0
  let html = '';
  for (let w = -1; w <= 1; w++) {
    html += '<div class="sem"><div class="sh">' + titres[w + 1] + '</div>';
    for (let jour = 0; jour < 7; jour++) {
      const ent = entreeMenage(cy, w * 7 + (jour - dow));
      const dd = dotsMenage(ent.qui);
      let cls = 'row ' + dd.cls;
      if (w === 0 && jour === dow) cls += ' today';
      html += '<div class="' + cls + '"><div class="jr">' + jrs[jour] + '</div>' +
        '<div class="ct"><div class="nm">' + esc(dd.nom) + '</div>' +
        '<div class="tk">' + esc(ent.tache) + '</div></div></div>';
    }
    html += '</div>';
  }
  donnees.menage.planning = html;
}

/* ============================================================
   spotify · web api (compte premium), token rafraîchi au besoin
   ============================================================ */
let tokenBloqueJusqua = 0; // backoff : ne pas marteler accounts.spotify.com à 2 s si ça échoue
async function tokenSpotify() {
  if (spotifyAccess.token && Date.now() < spotifyAccess.exp) return spotifyAccess.token;
  if (Date.now() < tokenBloqueJusqua) throw new Error('refresh en attente');
  const basic = Buffer.from(CFG.spotify.clientId + ':' + CFG.spotify.clientSecret).toString('base64');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + basic,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(CFG.spotify.refreshToken),
  });
  const j = await r.json();
  if (!j.access_token) {
    tokenBloqueJusqua = Date.now() + 60000;
    console.log('[spotify] refresh du token refusé :', JSON.stringify(j));
    throw new Error('refresh refusé');
  }
  spotifyAccess = { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  if (j.refresh_token && j.refresh_token !== CFG.spotify.refreshToken) {
    // spotify fait tourner les refresh tokens (durée de vie 180 j en mode development) :
    // on persiste le nouveau pour ne jamais casser la chaîne
    CFG.spotify.refreshToken = j.refresh_token;
    fs.writeFile(path.join(__dirname, 'config.json'), JSON.stringify(CFG, null, 2) + '\n',
      e => { if (e) console.log('[spotify] échec sauvegarde du refresh token :', e.message); });
  }
  return spotifyAccess.token;
}
async function spFetch(chemin, methode) {
  const t = await tokenSpotify();
  return fetch('https://api.spotify.com/v1' + chemin, {
    method: methode || 'GET',
    headers: { 'Authorization': 'Bearer ' + t },
  });
}
let musiqueEchecs = 0; // à 2 s de cadence, on ne masque pas la capsule au premier raté
let musiquePauseJusqua = 0;
async function majMusique() {
  if (Date.now() < musiquePauseJusqua) return;
  try {
    const r = await spFetch('/me/player/currently-playing');
    if (r.status === 429) {
      // limite de débit : on respecte le délai demandé par spotify
      const attente = parseInt(r.headers.get('retry-after') || '10', 10) + 1;
      musiquePauseJusqua = Date.now() + attente * 1000;
      console.log('[spotify] limite de débit, pause de', attente, 's');
      return;
    }
    if (r.status === 204) {
      // plus de session active : on efface tout, la capsule se masque
      musiqueEchecs = 0;
      musique.playing = false; musique.title = ''; musique.artist = '';
      return;
    }
    if (!r.ok) throw new Error('spotify ' + r.status);
    musiqueEchecs = 0;
    const j = await r.json();
    musique.playing = !!j.is_playing;
    if (j.item) {
      musique.title = j.item.name;
      musique.artist = j.item.artists.map(a => a.name).join(', ');
      const img = j.item.album && j.item.album.images && j.item.album.images[1];
      const url = img ? img.url : '';
      if (url && url !== musique.artUrl) {
        // pochette proxifiée : l'ipad la lira en http chez nous
        const ir = await fetch(url);
        musique.artBuf = Buffer.from(await ir.arrayBuffer());
        musique.artType = ir.headers.get('content-type') || 'image/jpeg';
        musique.artUrl = url;
      }
    }
  } catch (e) {
    // on garde le dernier état affiché pendant ~20 s d'échecs (réseau, token…)
    musiqueEchecs++;
    if (musiqueEchecs === 10) {
      console.log('[spotify] injoignable depuis 20 s (' + e.message + '), capsule masquée');
      musique.playing = false; musique.title = ''; musique.artist = '';
    }
  }
}

/* ============================================================
   assemblage de la page
   ============================================================ */
function page() {
  return TEMPLATE
    .replace('{{METEO}}', donnees.meteo.html)
    .replace('{{AGENDA_AUJ}}', donnees.agenda.auj)
    .replace('{{AGENDA_VENIR}}', donnees.agenda.venir)
    .replace('{{SPORT_ITEMS}}', donnees.sport.html)
    .replace('{{STUDIO_ITEMS}}', donnees.studio.html)
    .replace('{{PEND_CLASS}}', donnees.studio.html ? '' : 'off')
    .replace('{{CINEMA_ITEMS}}', donnees.cinema.html)
    .replace('{{MENAGE_COMPACT}}', donnees.menage.compact)
    .replace('{{MENAGE_CLASS}}', donnees.menage.compact ? '' : 'off')
    .replace('{{MENAGE_PLANNING}}', donnees.menage.planning)
    .replace('{{MUSIC_CLASS}}', musique.title ? (musique.playing ? '' : 'paused') : 'off')
    .replace('{{MUSIC_TITLE}}', esc(musique.title))
    .replace('{{MUSIC_ARTIST}}', esc(musique.artist));
}

/* ============================================================
   serveur http · tout vit sous le chemin secret CFG.basePath
   ============================================================ */
function json(res, obj) {
  // no-store indispensable : safari ios 9 met en cache les xhr get sinon
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}
const serveur = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  if (!url.startsWith(CFG.basePath)) { res.writeHead(404); res.end(); return; }
  const route = url.slice(CFG.basePath.length);
  if (route === '') {
    // barre oblique finale obligatoire pour que les urls relatives de la page fonctionnent
    res.writeHead(301, { Location: CFG.basePath + '/' });
    res.end(); return;
  }

  try {
    if (route === '' || route === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store', // le rechargement des 10 min doit repartir du serveur
      });
      res.end(page());

    } else if (route === '/musique/etat') {
      dernierPoll = Date.now(); // l'ipad interroge toutes les 2 s : signe de vie
      json(res, { playing: musique.playing, title: musique.title, artist: musique.artist });

    } else if (route === '/contenu') {
      dernierPoll = Date.now();
      // toutes les zones de la page, pour rafraîchir sans recharger
      json(res, {
        meteo: donnees.meteo.html,
        agendaAuj: donnees.agenda.auj,
        agendaVenir: donnees.agenda.venir,
        sport: donnees.sport.html,
        studio: donnees.studio.html,
        cinema: donnees.cinema.html,
        menageCompact: donnees.menage.compact,
        menagePlanning: donnees.menage.planning,
        agendaSemaines: donnees.agenda.semaines,
        sportDetail: donnees.sport.detail,
        cinemaJours: donnees.cinema.detailJours,
        cinemaLabels: donnees.cinema.joursLabel,
        soleil: donnees.meteo.soleil,
        meteoPrevisions: donnees.meteo.previsions,
        moment: momentDuJour(),
        figees: sourcesFigees(),
      });

    } else if (route === '/agenda/epingle') {
      // bascule l'épinglage d'un événement perso (clé passée encodée par la vue semaine)
      const m = req.url.match(/[?&]k=([^&]+)/);
      const k = m ? decodeURIComponent(m[1]) : '';
      if (k) {
        if (epingles[k]) delete epingles[k]; else epingles[k] = 1;
        sauveEpingles();
        majAgenda().catch(e => console.log('[maj] agenda en échec :', e.message));
      }
      json(res, { ok: !!k });

    } else if (route === '/musique/pause') {
      await spFetch(musique.playing ? '/me/player/pause' : '/me/player/play', 'PUT');
      setTimeout(majMusique, 800);
      json(res, { ok: true });

    } else if (route === '/musique/suivant') {
      await spFetch('/me/player/next', 'POST');
      setTimeout(majMusique, 800);
      json(res, { ok: true });

    } else if (route === '/musique/precedent') {
      await spFetch('/me/player/previous', 'POST');
      setTimeout(majMusique, 800);
      json(res, { ok: true });

    } else if (route === '/musique/volume/plus' || route === '/musique/volume/moins') {
      // lit le volume courant de l'appareil actif puis l'ajuste de ±10 %
      let vol = null;
      try {
        const pr = await spFetch('/me/player');
        if (pr.status === 200) {
          const pj = await pr.json();
          if (pj && pj.device && typeof pj.device.volume_percent === 'number') vol = pj.device.volume_percent;
        }
      } catch (e) { /* on retombe sur 50 % */ }
      if (vol === null) vol = 50;
      vol = route.slice(-4) === 'plus' ? Math.min(100, vol + 10) : Math.max(0, vol - 10);
      const vr = await spFetch('/me/player/volume?volume_percent=' + vol, 'PUT');
      if (!vr.ok) console.log('[spotify] volume refusé (' + vr.status + ') — appareil sans contrôle de volume ?');
      json(res, { ok: vr.ok, volume: vol });

    } else if (route === '/musique/pochette') {
      if (musique.artBuf) {
        res.writeHead(200, { 'Content-Type': musique.artType, 'Cache-Control': 'no-store' });
        res.end(musique.artBuf);
      } else { res.writeHead(404); res.end(); }

    } else { res.writeHead(404); res.end(); }
  } catch (e) {
    res.writeHead(500); res.end('erreur : ' + e.message);
  }
});

/* ---------- rafraîchissements périodiques ---------- */
async function rafraichirTout() {
  majMenage(); // calcul local, pas de réseau : recalculé à chaque tour (change chaque jour)
  const taches = [majMeteo(), majAgenda(), majSport()];
  const noms = ['météo', 'agenda', 'sport'];
  (await Promise.allSettled(taches)).forEach((r, i) => {
    if (r.status === 'rejected') console.log('[maj]', noms[i], 'en échec :', r.reason.message);
  });
}
// sources lentes, interrogées avec parcimonie : scraping allociné et instagram
function rafraichirLent() {
  majCinema().catch(e => console.log('[maj] ciné en échec :', e.message));
  majStudio().catch(e => console.log('[maj] studio en échec :', e.message));
}

// on part d'un état "frais" : une source n'est figée que si elle rate
// pendant tout son seuil après le démarrage
Object.keys(sante).forEach(k => { sante[k] = Date.now(); });
rafraichirTout();
majMusique();
rafraichirLent();
setInterval(rafraichirTout, 2 * 60 * 1000);   // données : toutes les 2 min
// spotify : 5 s. ne pas descendre : à 2 s l'api punit par des pauses
// forcées de 90 min et plus (vécu), la capsule devient moins réactive, pas plus
setInterval(majMusique, 5 * 1000);
setInterval(rafraichirLent, 6 * 3600 * 1000); // ciné + stats : toutes les 6 h
setInterval(verifieEcran, 5 * 60 * 1000);     // watchdog : l'ipad donne-t-il signe de vie ?

serveur.listen(CFG.port, () => {
  console.log('écran maison prêt : http://<ip-du-vps>:' + CFG.port + CFG.basePath + '/');
});
