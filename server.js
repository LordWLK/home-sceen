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
  agenda: {
    auj: '<div class="it">chargement</div>',
    venir: '<div class="it">chargement</div>',
  },
  sport: { html: '' },
  studio: { html: '' },
  cinema: { html: '' },
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

  // deux sections dans l'arche : le jour même, puis les jours suivants
  const cleAuj = jourCle(new Date());
  const auj = occs.filter(o => jourCle(o.date) === cleAuj).slice(0, 2);
  const venir = occs.filter(o => jourCle(o.date) !== cleAuj).slice(0, 2);

  donnees.agenda.auj = auj.length
    ? auj.map(o => item(o.titre, heureLabel(o.date, o.allDay))).join('\n')
    : item('rien de prévu', 'journée libre');
  donnees.agenda.venir = venir.length
    ? venir.map(o => item(o.titre, quandLabel(o.date, o.allDay))).join('\n')
    : item('semaine calme', 'rien devant');
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

// prochain match de chaque équipe de foot suivie (losc, milan, liverpool, france…)
async function footCandidats() {
  const out = [];
  if (!CFG.footballDataKey || !Array.isArray(CFG.equipesFoot)) return out;
  for (const eq of CFG.equipesFoot) {
    try {
      const j = await fdFetch('/teams/' + eq.id + '/matches?status=SCHEDULED&limit=1');
      const m = j.matches && j.matches[0];
      if (!m) continue;
      const adv = m.homeTeam.id === eq.id ? m.awayTeam : m.homeTeam;
      out.push({
        date: new Date(m.utcDate),
        titre: eq.nom + ' · ' + String(adv.shortName || adv.name || adv.tla || '').toLowerCase(),
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
      const prochain = (j.events || [])
        .filter(ev => new Date(ev.date) > new Date())
        .sort((a, b) => new Date(a.date) - new Date(b.date))[0];
      if (!prochain) continue; // hors saison
      let adv = '';
      const comp = prochain.competitions && prochain.competitions[0];
      if (comp && comp.competitors) {
        const c = comp.competitors.find(c => String(c.team && c.team.id) !== moi);
        if (c && c.team) adv = String(c.team.shortDisplayName || c.team.displayName || '').toLowerCase();
      }
      out.push({ date: new Date(prochain.date), titre: adv ? eq.nom + ' · ' + adv : eq.nom });
    } catch (e) { /* espn muet : on passe */ }
  }
  return out;
}

// ufc : les événements numérotés (gros combats) s'affichent toujours,
// les fight nights seulement si un combattant de CFG.ufcFrancais est à la carte
async function ufcCandidats() {
  const out = [];
  if (!Array.isArray(CFG.ufcFrancais)) return out;
  const sb = await espnJson('https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard');
  const cal = (((sb.leagues || [])[0] || {}).calendar) || [];
  for (const c of cal) {
    const brut = new Date(c.startDate || c);
    if (isNaN(brut) || brut < new Date(Date.now() - 12 * 3600000) ||
        brut > new Date(Date.now() + 35 * 86400000)) continue;
    const label = String(c.label || '');
    const ppv = label.match(/^(UFC\s+\d+)/i);
    // carte du jour : date réelle de l'événement et détection d'un français suivi
    let date = brut, allDay = true, francais = '';
    try {
      const ymd = brut.toISOString().slice(0, 10).replace(/-/g, '');
      const jour = await espnJson('https://site.api.espn.com/apis/site/v2/sports/mma/ufc/scoreboard?dates=' + ymd);
      (jour.events || []).forEach(ev => {
        if (ev.date) { date = new Date(ev.date); allDay = false; }
        (ev.competitions || []).forEach(co => {
          (co.competitors || []).forEach(a => {
            const nom = sansAccents((a.athlete && a.athlete.displayName) || '').toLowerCase();
            const hit = CFG.ufcFrancais.find(f => nom.indexOf(sansAccents(f).toLowerCase()) !== -1);
            if (hit && !francais) francais = hit;
          });
        });
      });
    } catch (e) { /* on garde la date du calendrier, sans heure */ }
    if (!ppv && !francais) continue;
    let titre;
    if (ppv && francais) {
      titre = ppv[1].toLowerCase() + ' · ' + francais;
    } else if (ppv) {
      const tete = sansAccents(label.split(':')[1] || '').trim().toLowerCase()
        .replace(/\s+vs\.?\s+/, '-').replace(/\./g, '');
      titre = tete ? ppv[1].toLowerCase() + ' · ' + tete : ppv[1].toLowerCase();
    } else {
      titre = 'ufc · ' + francais;
    }
    out.push({ date: date, titre: titre, allDay: allDay });
  }
  return out;
}

async function majSport() {
  const cands = [];
  for (const source of [footCandidats, nbaCandidats, ufcCandidats]) {
    try { cands.push.apply(cands, await source()); } catch (e) { /* source muette */ }
  }
  cands.sort((a, b) => a.date - b.date);
  const items = cands.slice(0, 4).map(c => item(c.titre, quandLabel(c.date, !!c.allDay)));
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
  let abonnes = null;

  // source 1 : endpoint dédié si un jour statsUrl est renseignée
  if (CFG.statsUrl) {
    const r = await fetch(CFG.statsUrl);
    const j = await r.json();
    abonnes = Number(j.followers || j.abonnes || (j.instagram && j.instagram.followers)) || null;
  }

  // source 2 : instagram, deux stratégies (l'api web du site, puis la page html)
  if (abonnes === null && CFG.instagram) abonnes = await abonnesInstagram(CFG.instagram);

  // source 3 : valeur manuelle de secours (config.abonnesManuel), mise à jour à la main
  if (abonnes === null && CFG.abonnesManuel) abonnes = Number(CFG.abonnesManuel) || null;

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

  donnees.studio.html =
    '<div class="p-lbl">yum.ines</div>' +
    '<div class="p-num">' + esc(abonnes.toLocaleString('fr-FR')) + '</div>' +
    (delta ? '<div class="p-lbl">' + esc((delta > 0 ? '+' : '') + delta + ' sur 7 jours') + '</div>' : '');
}

/* ============================================================
   ciné · films à l'affiche les mieux notés dans les cinémas
   configurés (pages horaires allociné, notes presse + spectateurs)
   ============================================================ */
async function majCinema() {
  if (!Array.isArray(CFG.cinemas) || !CFG.cinemas.length) return;
  const films = {}; // titre → meilleures notes vues dans les cinémas suivis
  for (const cine of CFG.cinemas) {
    try {
      const r = await fetch('https://www.allocine.fr/seance/salle_gen_csalle=' + cine.allocine + '.html', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          'Accept-Language': 'fr-FR,fr;q=0.9',
        },
      });
      if (!r.ok) throw new Error('allociné ' + r.status);
      const html = await r.text();
      // une "carte" par film sur la page horaires (classe tolérante : movie-card…)
      const cartes = html.split(/class="[^"]*movie-card/).slice(1);
      for (const carte of cartes) {
        const t = carte.match(/meta-title-link[^>]*>\s*([^<]+?)\s*</) ||
          carte.match(/meta-title-link[^>]*title="([^"]+)"/);
        if (!t || !t[1].trim()) continue;
        const titre = t[1].trim();
        const f = films[titre] || (films[titre] = { presse: 0, spect: 0, ou: [] });
        if (f.ou.indexOf(cine.nom) === -1) f.ou.push(cine.nom);
        // année et mention « reprise » pour distinguer nouveautés et classiques
        const entete = carte.slice(0, 1200);
        if (/\breprise\b/i.test(entete)) f.reprise = true;
        const an = entete.match(/\b(19[2-9]\d|20[0-3]\d)\b/);
        if (an) f.annee = Math.min(f.annee || 9999, parseInt(an[1], 10));
        // pour chaque note, le libellé (presse/spectateurs) est loin derrière,
        // séparé par une rangée d'icônes d'étoiles : on remonte 600 caractères
        // et on prend le dernier libellé rencontré
        for (const nm of carte.matchAll(/stareval-note[^>]*>\s*([\d,.]+)/g)) {
          const val = parseFloat(nm[1].replace(',', '.'));
          if (isNaN(val)) continue;
          const avant = carte.slice(Math.max(0, nm.index - 600), nm.index).toLowerCase();
          const p = avant.lastIndexOf('presse');
          const s = avant.lastIndexOf('spectateur');
          if (p === -1 && s === -1) continue;
          if (p > s) f.presse = Math.max(f.presse, val);
          else f.spect = Math.max(f.spect, val);
        }
      }
    } catch (e) { /* un cinéma muet n'empêche pas les autres */ }
  }
  const notes = n => n.toFixed(1).replace('.', ',');
  const anneeCourante = new Date().getFullYear();
  const tous = Object.keys(films)
    .map(titre => {
      const f = films[titre];
      const score = f.presse && f.spect ? (f.presse + f.spect) / 2 : (f.presse || f.spect);
      const classique = !!f.reprise || (f.annee && f.annee <= anneeCourante - 2);
      return { titre, presse: f.presse, spect: f.spect, ou: f.ou, annee: f.annee, classique, score };
    })
    .filter(f => f.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!tous.length) throw new Error('aucun film noté trouvé');

  // mix : les 2 meilleures nouveautés + les 2 meilleures reprises,
  // complété par le meilleur reste si une catégorie manque
  const nouveautes = tous.filter(f => !f.classique).slice(0, 2);
  const classiques = tous.filter(f => f.classique).slice(0, 2);
  let sel = nouveautes.concat(classiques);
  const reste = tous.filter(f => sel.indexOf(f) === -1);
  sel = sel.concat(reste.slice(0, 4 - sel.length));

  donnees.cinema.html = sel.map(f => {
    const salles = f.ou.length > 2 ? f.ou.length + ' salles' : f.ou.join(' + ');
    // l'année d'un classique s'affiche dans le titre, la ligne du bas reste courte
    const titre = f.titre.toLowerCase() + ((f.classique && f.annee) ? ' · ' + f.annee : '');
    const sous = [salles,
      f.presse ? 'presse ' + notes(f.presse) : '',
      f.spect ? 'spect ' + notes(f.spect) : '']
      .filter(Boolean).join(' · ');
    return item(titre, sous);
  }).join('\n');
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
      json(res, { playing: musique.playing, title: musique.title, artist: musique.artist });

    } else if (route === '/contenu') {
      // toutes les zones de la page, pour rafraîchir sans recharger
      json(res, {
        meteo: donnees.meteo.html,
        agendaAuj: donnees.agenda.auj,
        agendaVenir: donnees.agenda.venir,
        sport: donnees.sport.html,
        studio: donnees.studio.html,
        cinema: donnees.cinema.html,
      });

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

rafraichirTout();
majMusique();
rafraichirLent();
setInterval(rafraichirTout, 2 * 60 * 1000);   // données : toutes les 2 min
// spotify : 5 s. ne pas descendre : à 2 s l'api punit par des pauses
// forcées de 90 min et plus (vécu), la capsule devient moins réactive, pas plus
setInterval(majMusique, 5 * 1000);
setInterval(rafraichirLent, 6 * 3600 * 1000); // ciné + stats : toutes les 6 h

serveur.listen(CFG.port, () => {
  console.log('écran maison prêt : http://<ip-du-vps>:' + CFG.port + CFG.basePath + '/');
});
