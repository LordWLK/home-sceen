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
  meteo: { html: 'météo indisponible' },
  agenda: { html: '<div class="it">agenda en cours de chargement</div>' },
  sport: { html: '' },
  studio: { html: '' },
};
const musique = {
  playing: false, title: '', artist: '',
  artUrl: '', artBuf: null, artType: 'image/jpeg',
};
let spotifyAccess = { token: '', exp: 0 };

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

// libellé relatif : "ce soir", "demain 18 h", "sam 14 h"…
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
  const j = p.weekday.replace('.', '');
  return allDay ? j + ' ' + p.day : j + ' ' + p.day + ' · ' + heure;
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function item(titre, sous) {
  return '<div class="it">' + esc(titre) + '<small>' + esc(sous) + '</small></div>';
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
async function majMeteo() {
  const u = 'https://api.open-meteo.com/v1/forecast?latitude=' + CFG.meteo.lat +
    '&longitude=' + CFG.meteo.lon + '&current=temperature_2m,weather_code&timezone=' +
    encodeURIComponent(TZ);
  const r = await fetch(u);
  const j = await r.json();
  const t = Math.round(j.current.temperature_2m);
  donnees.meteo.html = esc(libelleMeteo(j.current.weather_code)) + ' · <b>' + t + '°</b>';
}

/* ============================================================
   agenda · calendrier icloud publié (url ics), récurrences incluses
   ============================================================ */
async function majAgenda() {
  const data = await ical.async.fromURL(CFG.icsUrl);
  const debut = new Date(Date.now() - 2 * 3600000); // garde ce qui vient de commencer
  const fin = new Date(Date.now() + 7 * 86400000);
  const occs = [];

  for (const k of Object.keys(data)) {
    const ev = data[k];
    if (!ev || ev.type !== 'VEVENT') continue;
    const allDay = ev.datetype === 'date';
    if (ev.rrule) {
      // occurrences des événements récurrents (poubelles hebdo, etc.)
      ev.rrule.between(debut, fin, true).forEach(d => {
        occs.push({ date: d, titre: ev.summary, allDay: allDay });
      });
    } else if (ev.start >= debut && ev.start <= fin) {
      occs.push({ date: ev.start, titre: ev.summary, allDay: allDay });
    }
  }
  occs.sort((a, b) => a.date - b.date);
  const quatre = occs.slice(0, 4);
  donnees.agenda.html = quatre.length
    ? quatre.map(o => item(o.titre, quandLabel(o.date, o.allDay))).join('\n')
    : item('rien au programme', 'semaine calme');
}

/* ============================================================
   sport · football-data.org si clé fournie, sinon events.json manuel
   ============================================================ */
async function fdFetch(chemin) {
  const r = await fetch('https://api.football-data.org/v4' + chemin, {
    headers: { 'X-Auth-Token': CFG.footballDataKey },
  });
  return r.json();
}
const STAGES_FR = {
  FINAL: 'finale', SEMI_FINALS: 'demi-finale', THIRD_PLACE: 'petite finale',
  QUARTER_FINALS: 'quart de finale', LAST_16: 'huitième',
};
async function majSport() {
  const items = [];
  if (CFG.footballDataKey) {
    // prochain match de coupe du monde (s'éteint tout seul après la compétition)
    try {
      const wc = await fdFetch('/competitions/WC/matches?status=SCHEDULED');
      const m = wc.matches && wc.matches[0];
      if (m) {
        const nom = (STAGES_FR[m.stage] || 'match') +
          (m.homeTeam.tla ? ' · ' + m.homeTeam.tla + '-' + m.awayTeam.tla : '');
        items.push(item(nom, quandLabel(new Date(m.utcDate), false)));
      }
    } catch (e) { /* silencieux, on garde la place pour le losc */ }
    // prochain match du losc
    try {
      const lo = await fdFetch('/teams/' + CFG.loscTeamId + '/matches?status=SCHEDULED&limit=2');
      const m = lo.matches && lo.matches[0];
      if (m) {
        const adv = m.homeTeam.id === CFG.loscTeamId ? m.awayTeam.shortName : m.homeTeam.shortName;
        items.push(item('losc · ' + adv, quandLabel(new Date(m.utcDate), false)));
      }
    } catch (e) { /* idem */ }
  }
  if (!items.length) {
    // repli : petit fichier édité à la main
    try {
      const man = JSON.parse(fs.readFileSync(path.join(__dirname, 'events.json'), 'utf8'));
      man.slice(0, 2).forEach(e => items.push(item(e.titre, e.sous)));
    } catch (e) { /* rien */ }
  }
  donnees.sport.html = items.join('\n') || item('pas de match prévu', 'trêve');
}

/* ============================================================
   studio · endpoint netlify du media kit yum.ines
   >>> adapter les deux lignes de lecture au format réel du json <<<
   ============================================================ */
async function majStudio() {
  const r = await fetch(CFG.statsUrl);
  const j = await r.json();
  const abonnes = j.followers || j.abonnes || (j.instagram && j.instagram.followers);
  const delta = j.delta7 || j.weeklyGrowth || (j.instagram && j.instagram.delta7) || 0;
  donnees.studio.html =
    item(Number(abonnes).toLocaleString('fr-FR'), 'abonnés yum.ines') +
    item((delta >= 0 ? '+' : '') + delta, 'sur 7 jours');
}

/* ============================================================
   spotify · web api (compte premium), token rafraîchi au besoin
   ============================================================ */
async function tokenSpotify() {
  if (spotifyAccess.token && Date.now() < spotifyAccess.exp) return spotifyAccess.token;
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
  spotifyAccess = { token: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return spotifyAccess.token;
}
async function spFetch(chemin, methode) {
  const t = await tokenSpotify();
  return fetch('https://api.spotify.com/v1' + chemin, {
    method: methode || 'GET',
    headers: { 'Authorization': 'Bearer ' + t },
  });
}
async function majMusique() {
  try {
    const r = await spFetch('/me/player/currently-playing');
    if (r.status === 204) { musique.playing = false; return; }
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
  } catch (e) { musique.playing = false; }
}

/* ============================================================
   assemblage de la page
   ============================================================ */
function page() {
  return TEMPLATE
    .replace('{{METEO}}', donnees.meteo.html)
    .replace('{{AGENDA_ITEMS}}', donnees.agenda.html)
    .replace('{{SPORT_ITEMS}}', donnees.sport.html)
    .replace('{{STUDIO_ITEMS}}', donnees.studio.html)
    .replace('{{MUSIC_CLASS}}', musique.playing ? '' : 'off')
    .replace('{{MUSIC_TITLE}}', esc(musique.title))
    .replace('{{MUSIC_ARTIST}}', esc(musique.artist));
}

/* ============================================================
   serveur http · tout vit sous le chemin secret CFG.basePath
   ============================================================ */
function json(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page());

    } else if (route === '/musique/etat') {
      json(res, { playing: musique.playing, title: musique.title, artist: musique.artist });

    } else if (route === '/musique/pause') {
      await spFetch(musique.playing ? '/me/player/pause' : '/me/player/play', 'PUT');
      setTimeout(majMusique, 800);
      json(res, { ok: true });

    } else if (route === '/musique/suivant') {
      await spFetch('/me/player/next', 'POST');
      setTimeout(majMusique, 800);
      json(res, { ok: true });

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
  const taches = [majMeteo(), majAgenda(), majSport(), majStudio()];
  const noms = ['météo', 'agenda', 'sport', 'studio'];
  (await Promise.allSettled(taches)).forEach((r, i) => {
    if (r.status === 'rejected') console.log('[maj]', noms[i], 'en échec :', r.reason.message);
  });
}
rafraichirTout();
majMusique();
setInterval(rafraichirTout, 5 * 60 * 1000);   // données : toutes les 5 min
setInterval(majMusique, 30 * 1000);           // spotify : toutes les 30 s

serveur.listen(CFG.port, () => {
  console.log('écran maison prêt : http://<ip-du-vps>:' + CFG.port + CFG.basePath + '/');
});
