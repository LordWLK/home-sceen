#!/usr/bin/env node
/* harnais de test local · lance server.js avec un faux réseau.
   toutes les sources (open-meteo, icloud, football-data, espn, allociné,
   instagram, spotify) sont remplacées par des fixtures générées à la volée,
   datées par rapport à aujourd'hui (heure de paris). aucun secret nécessaire,
   aucune requête ne sort de la machine.

   usage :  node test/mock.js                → http://localhost:8017/maison-mock/
            PORT=8099 node test/mock.js
            MOCK_MUSIQUE=0 node test/mock.js  (rien ne joue : capsule masquée)
            MOCK_VERBOSE=1 node test/mock.js  (trace chaque requête simulée)

   captures : NODE_PATH=$(npm root -g) node test/capture.js   (voir capture.js) */
'use strict';
process.env.TZ = 'Europe/Paris'; // les fixtures raisonnent en heure locale de paris
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ical = require('node-ical');

const RACINE = path.join(__dirname, '..');
const PORT = parseInt(process.env.PORT || '8017', 10);
const BASE = '/maison-mock';
const VERBOSE = process.env.MOCK_VERBOSE === '1';
const MUSIQUE = process.env.MOCK_MUSIQUE !== '0';

/* ---------- dates ---------- */
const pad = n => (n < 10 ? '0' : '') + n;
// AAAA-MM-JJ du jour + k (heure de paris)
function jourPlus(k) {
  const d = new Date(Date.now() + k * 86400000);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
// Date à une heure locale de paris d'un jour donné
function local(jourISO, hm) { return new Date(jourISO + 'T' + hm + ':00'); }
const icsUtc = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/* ---------- agenda (ics) ---------- */
function ics(events) {
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//mock//ecran maison//FR'];
  events.forEach((e, i) => {
    L.push('BEGIN:VEVENT', 'UID:mock-' + i + '@ecran', 'DTSTAMP:' + icsUtc(new Date()));
    if (e.allDay) {
      L.push('DTSTART;VALUE=DATE:' + e.jour.replace(/-/g, ''));
    } else {
      const d = local(e.jour, e.h);
      L.push('DTSTART:' + icsUtc(d), 'DTEND:' + icsUtc(new Date(d.getTime() + 3600000)));
    }
    if (e.rrule) L.push('RRULE:' + e.rrule);
    L.push('SUMMARY:' + e.titre, 'END:VEVENT');
  });
  L.push('END:VCALENDAR');
  return L.join('\r\n') + '\r\n';
}
// dernier mardi (pour une récurrence hebdo qui a déjà commencé)
function dernierMardi() {
  const d = new Date(); const back = (d.getDay() + 5) % 7 || 7;
  return jourPlus(-back);
}
const CALENDRIERS = {
  maison: [
    { jour: jourPlus(0), h: '19:30', titre: 'dîner chez les parents' },
    { jour: jourPlus(1), allDay: true, titre: 'livraison canapé' },
    { jour: dernierMardi(), h: '19:00', titre: 'poubelles', rrule: 'FREQ=WEEKLY;BYDAY=TU' },
    { jour: jourPlus(5), h: '20:45', titre: 'concert à l\'aéronef' },
    { jour: jourPlus(12), h: '11:00', titre: 'brunch avec léa et tom' },
  ],
  antoine: [
    { jour: jourPlus(1), h: '18:30', titre: 'futsal' },
    { jour: jourPlus(3), h: '10:00', titre: 'dentiste' },
  ],
};

/* ---------- météo (open-meteo) ---------- */
function meteo() {
  const codes = [2, 61, 3, 0, 1, 80, 3];
  const tmax = [21, 17, 19, 23, 25, 20, 18], tmin = [12, 11, 10, 12, 14, 13, 11];
  const daily = {
    time: [], temperature_2m_max: tmax, temperature_2m_min: tmin, weather_code: codes,
    sunrise: [], sunset: [], precipitation_probability_max: [10, 70, 30, 5, 10, 60, 40],
    wind_speed_10m_max: [22, 45, 30, 15, 18, 38, 25], uv_index_max: [4, 2, 5, 6, 6, 3, 4],
  };
  for (let k = 0; k < 7; k++) {
    daily.time.push(jourPlus(k));
    daily.sunrise.push(jourPlus(k) + 'T07:32');
    daily.sunset.push(jourPlus(k) + 'T19:58');
  }
  const hourly = { time: [], precipitation_probability: [], temperature_2m: [] };
  for (let k = 0; k < 2; k++) {
    for (let h = 0; h < 24; h++) {
      hourly.time.push(jourPlus(k) + 'T' + pad(h) + ':00');
      // averses en fin d'après-midi aujourd'hui, matinée pluvieuse demain
      hourly.precipitation_probability.push(k === 0 ? (h >= 17 && h <= 19 ? 65 : 10) : (h >= 8 && h <= 12 ? 75 : 20));
      hourly.temperature_2m.push(Math.round((tmin[k] + (tmax[k] - tmin[k]) * Math.max(0, Math.sin((h - 5) / 24 * Math.PI))) * 10) / 10);
    }
  }
  return { current: { temperature_2m: 18.4, weather_code: 2 }, daily: daily, hourly: hourly };
}

/* ---------- sport ---------- */
const T = (id, nom) => ({ id: id, shortName: nom, name: nom });
function match(off, hm, statut, comp, dom, ext, score) {
  return {
    utcDate: local(jourPlus(off), hm).toISOString(), status: statut, competition: { name: comp },
    homeTeam: dom, awayTeam: ext, score: { fullTime: score || { home: null, away: null } },
  };
}
function foot(id) {
  const m = {
    521: [match(-1, '21:00', 'FINISHED', 'Ligue 1', T(521, 'Lille'), T(546, 'Lens'), { home: 2, away: 1 }),
          match(3, '21:05', 'SCHEDULED', 'Ligue 1', T(516, 'Marseille'), T(521, 'Lille')),
          match(10, '21:00', 'TIMED', 'UEFA Europa League', T(521, 'Lille'), T(675, 'Roma'))],
    98:  [match(5, '20:45', 'SCHEDULED', 'Serie A', T(98, 'Milan'), T(108, 'Inter'))],
    64:  [match(2, '17:30', 'SCHEDULED', 'Premier League', T(62, 'Everton'), T(64, 'Liverpool'))],
    773: [],
  };
  return { matches: m[id] || [] };
}
function nba(abr) {
  const ev = (off, hm, moi, adv, nom) => ({
    date: local(jourPlus(off), hm).toISOString(),
    competitions: [{ competitors: [{ team: { id: moi } }, { team: { id: adv, shortDisplayName: nom } }] }],
  });
  if (abr === 'phx') return { team: { id: '21' }, events: [ev(4, '03:00', '21', '13', 'Lakers'), ev(7, '02:30', '21', '9', 'Warriors')] };
  if (abr === 'ny') return { team: { id: '18' }, events: [ev(6, '01:30', '18', '2', 'Celtics')] };
  return { team: { id: '0' }, events: [] };
}
const CARTES = {}; // jour → combattants (paires)
CARTES[jourPlus(9)] = ['Islam Makhachev', 'Justin Gaethje', 'Benoît Saint Denis', 'Renato Moicano'];
CARTES[jourPlus(16)] = ['Ciryl Gane', 'Tom Aspinall', 'Nassourdine Imavov', 'Brendan Allen'];
function mmaCalendrier(ligue) {
  if (ligue !== 'ufc') return { leagues: [{ calendar: [] }] };
  return { leagues: [{ calendar: [
    { startDate: local(jourPlus(9), '04:00').toISOString(), label: 'UFC 330: Makhachev vs. Gaethje' },
    { startDate: local(jourPlus(16), '22:00').toISOString(), label: 'UFC Fight Night: Gane vs. Aspinall' },
    { startDate: local(jourPlus(23), '22:00').toISOString(), label: "Dana White's Contender Series: Season 10, Week 3" },
  ] }] };
}
function mmaJour(ligue, ymd) {
  const jour = ymd.slice(0, 4) + '-' + ymd.slice(4, 6) + '-' + ymd.slice(6, 8);
  const noms = ligue === 'ufc' && CARTES[jour];
  if (!noms) return { events: [] };
  const comps = [];
  for (let i = 0; i < noms.length; i += 2) {
    comps.push({ competitors: [{ athlete: { displayName: noms[i] } }, { athlete: { displayName: noms[i + 1] } }] });
  }
  return { events: [{ date: local(jour, jour === jourPlus(9) ? '04:00' : '22:00').toISOString(), competitions: comps }] };
}

/* ---------- ciné (page horaires allociné) ---------- */
// [titre, presse, spect, cfilm, date de sortie, séances aujourd'hui, séances demain]
const FILMS = {
  traversee: ['La Traversée', 3.9, 4.2, 312345, '10 septembre 2026', ['14:00', '17:15', '20:30'], ['14:00', '20:30']],
  mepris:    ['Le Mépris', 4.5, 4.1, 1234, '20 décembre 1963', ['18:45'], ['18:45']],
  orage:     ['Nuit d\'orage', 2.8, 3.4, 312400, '3 septembre 2026', ['13:30', '16:00', '21:45'], ['16:00', '21:45']],
  toits:     ['Sous les toits', 4.0, 3.6, 312500, '17 septembre 2026', ['11:00', '15:30', '19:50'], ['15:30', '19:50', '22:10']],
  vertigo:   ['Vertigo', 4.7, 4.4, 2145, '15 mai 1958', ['20:00'], []],
  comete:    ['La Comète', 3.2, 3.9, 312600, '27 août 2026', ['13:00', '17:45', '21:15'], ['13:00', '21:15']],
  jardin:    ['Le Jardin des délices', 3.5, 2.9, 312650, '10 septembre 2026', ['16:20', '20:40'], ['20:40']],
};
const PROG = {
  P0086: ['traversee', 'mepris', 'orage', 'jardin'],
  P0047: ['traversee', 'toits', 'vertigo'],
  P0022: ['comete', 'toits', 'orage'],
  W5965: ['traversee', 'comete', 'jardin'],
};
function allocine(code) {
  const cartes = (PROG[code] || []).map(k => {
    const f = FILMS[k];
    const seances = (jour, hs) => hs.map(h =>
      '<span class="showtimes-hour-item" data-showtime-time="' + jour + 'T' + h + ':00+02:00">' + h + '</span>').join('');
    return '<div class="card entity-card entity-card-list movie-card-theater cf">' +
      '<h2 class="meta-title"><a class="meta-title-link" href="/film/fichefilm_gen_cfilm=' + f[3] + '.html">' + f[0] + '</a></h2>' +
      '<div class="meta-body-item">' + f[4] + ' · 1h 52min</div>' +
      '<div class="rating-holder">' +
      '<div class="rating-item"><span class="rating-title">Presse</span><span class="stareval-note">' + String(f[1]).replace('.', ',') + '</span></div>' +
      '<div class="rating-item"><span class="rating-title">Spectateurs</span><span class="stareval-note">' + String(f[2]).replace('.', ',') + '</span></div>' +
      '</div><div class="showtimes">' + seances(jourPlus(0), f[5]) + seances(jourPlus(1), f[6]) + '</div></div>';
  });
  return '<!doctype html><html><body><div class="theater-showtimes">' + cartes.join('\n') + '</div></body></html>';
}

/* ---------- pochette (png généré, deux tons chauds) ---------- */
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf);
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(w, h, pix) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = pix(x, y), o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = p[0]; raw[o + 1] = p[1]; raw[o + 2] = p[2];
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const POCHETTE = png(64, 64, (x, y) => (x + y) % 40 < 26 ? [176, 84, 48] : [232, 196, 120]);

/* ---------- spotify ---------- */
function enCours() {
  return {
    is_playing: true,
    item: {
      name: 'Les Cactus', artists: [{ name: 'Jacques Dutronc' }],
      album: { images: [{ url: 'https://i.scdn.co/image/mock-large' }, { url: 'https://i.scdn.co/image/mock-medium' }] },
    },
  };
}

/* ---------- faux fetch ---------- */
const json = o => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
const html = s => new Response(s, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const vide = code => new Response(null, { status: code });
const ROUTES = [
  [/api\.open-meteo\.com/, () => json(meteo())],
  [/football-data\.org\/v4\/teams\/(\d+)\/matches/, m => json(foot(+m[1]))],
  [/espn\.com\/.*\/basketball\/nba\/teams\/(\w+)\/schedule/, m => json(nba(m[1]))],
  [/espn\.com\/.*\/mma\/(\w+)\/scoreboard\?dates=(\d{8})/, m => json(mmaJour(m[1], m[2]))],
  [/espn\.com\/.*\/mma\/(\w+)\/scoreboard/, m => json(mmaCalendrier(m[1]))],
  [/allocine\.fr\/seance\/salle_gen_csalle=(\w+)\.html/, m => html(allocine(m[1]))],
  [/instagram\.com/, () => vide(403)], // bloqué comme depuis le vps : repli abonnesManuel
  [/accounts\.spotify\.com\/api\/token/, () => json({ access_token: 'mock', expires_in: 3600 })],
  [/api\.spotify\.com\/v1\/me\/player\/currently-playing/, () => MUSIQUE ? json(enCours()) : vide(204)],
  [/api\.spotify\.com\/v1\/me\/player\/volume/, () => vide(204)],
  [/api\.spotify\.com\/v1\/me\/player\/(pause|play|next|previous)/, () => vide(204)],
  [/api\.spotify\.com\/v1\/me\/player$/, () => json({ device: { volume_percent: 40 } })],
  [/i\.scdn\.co\//, () => new Response(POCHETTE, { status: 200, headers: { 'content-type': 'image/png' } })],
];
global.fetch = async function (url) {
  const u = String(url);
  for (const [re, fn] of ROUTES) {
    const m = u.match(re);
    if (m) { if (VERBOSE) console.log('[mock] ' + u); return fn(m); }
  }
  if (VERBOSE) console.log('[mock] 404 ' + u);
  return vide(404);
};
// calendriers : node-ical lit les urls lui-même → on court-circuite fromURL
ical.async.fromURL = async function (url) {
  const cal = /antoine/.test(url) ? CALENDRIERS.antoine : CALENDRIERS.maison;
  if (VERBOSE) console.log('[mock] ics ' + url);
  return ical.async.parseICS(ics(cal));
};

/* ---------- config du harnais, puis lancement du vrai serveur ---------- */
const CFG = JSON.parse(fs.readFileSync(path.join(RACINE, 'config.example.json'), 'utf8'));
Object.assign(CFG, {
  port: PORT, basePath: BASE,
  agendas: [{ url: 'https://mock.icloud/maison.ics', qui: 'maison' }, { url: 'https://mock.icloud/antoine.ics', qui: 'Antoine' }],
  footballDataKey: 'mock', abonnesManuel: 13100, statsUrl: '', alerteUrl: '',
  moments: [{ jour: '12-23', texte: 'joyeux anniversaire inès' }, { jour: '08-22', texte: 'joyeux anniversaire antoine' }],
  spotify: { clientId: 'mock', clientSecret: 'mock', refreshToken: 'mock' },
});
const TMP = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP, { recursive: true });
const cfgPath = path.join(TMP, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify(CFG, null, 2) + '\n');
process.env.ECRAN_CONFIG = cfgPath;
console.log('[mock] réseau simulé, config ' + path.relative(RACINE, cfgPath) + ' · http://localhost:' + PORT + BASE + '/');
require(path.join(RACINE, 'server.js'));
