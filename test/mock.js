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
            MOCK_NETATMO=0 node test/mock.js  (pas de thermostat configuré)
            MOCK_NETATMO=panne node test/mock.js  (api netatmo injoignable)
            MOCK_DEDANS=16.8 node test/mock.js  (température mesurée du thermostat simulé)
            MOCK_PLANNING=form | refus          (plannings refusés en json, ou refusés tout court)
            MOCK_FENETRE=1, MOCK_PILES=1        (fenêtre ouverte en salle de bain, piles faibles)

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
const NETATMO = process.env.MOCK_NETATMO || '1'; // '1' simulé · '0' non configuré · 'panne' injoignable

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

/* ---------- netatmo (thermostat + vannes), calqué sur l'installation réelle ----------
   une maison, relais NAPlug + thermostat NATherm1 dans la salle à manger, et les 7 vannes
   posées fin novembre 2026 : 2 dans la chambre, bureau de doudou, bureau de ninès, salle de
   bain, cuisine, salon. programme « Mon planning de chauffe » au départ (nuit jusqu'à 8 h,
   confort jusqu'à 23 h) ; l'écran peut créer, mettre à jour et activer d'autres plannings.
   jetons tournants comme le vrai : seul le dernier refresh token émis est accepté.
   le faux vérifie les plannings reçus comme on attend de netatmo (12 zones au plus,
   150 créneaux, toutes les pièces dans chaque zone, créneaux triés depuis lundi 0 h). */
// MOCK_DEDANS=16.8 : salle à manger plus froide que la consigne, la chaudière chauffe
// MOCK_PLANNING=form : refuse les plannings en json (code 21), pour éprouver le repli en formulaire
// MOCK_PLANNING=refus : refuse tous les plannings · MOCK_FENETRE=1 : fenêtre ouverte en salle de bain
// MOCK_PILES=1 : piles faibles dans le bureau de ninès
const { programme: progNetatmo } = require(path.join(RACINE, 'netatmo.js'));
const NT_HOME = 'mock-home', NT_ROOM = 'mock-room', NT_THERM = '70:ee:50:00:00:01', NT_PLUG = '70:ee:50:00:00:02';
const NT_PIECES = [
  { id: 'mock-chambre', name: 'Chambre', type: 'bedroom', vannes: 2, mesure: 18.6 },
  { id: 'mock-doudou', name: 'Bureau de Doudou', type: 'custom', vannes: 1, mesure: 19.2 },
  { id: 'mock-nines', name: 'Bureau de Ninès', type: 'custom', vannes: 1, mesure: 20.4 },
  { id: 'mock-sdb', name: 'Salle de bain', type: 'bathroom', vannes: 1, mesure: 21.1 },
  { id: 'mock-cuisine', name: 'Cuisine', type: 'kitchen', vannes: 1, mesure: 19.8 },
  { id: 'mock-salon', name: 'Salon', type: 'livingroom', vannes: 1, mesure: 19.6 },
  { id: NT_ROOM, name: 'Salle à manger', type: 'dining_room', vannes: 0, mesure: parseFloat(process.env.MOCK_DEDANS) || 19.4 },
];
let nv = 0;
NT_PIECES.forEach(p => { p.modules = []; for (let i = 0; i < p.vannes; i++) p.modules.push('09:00:00:00:00:' + String(++nv).padStart(2, '0')); });
NT_PIECES[NT_PIECES.length - 1].modules = [NT_THERM];
const ntZone = (id, type, name, tv, tt) => ({ id: id, type: type, name: name,
  rooms: NT_PIECES.map(p => ({ id: p.id, therm_setpoint_temperature: p.id === NT_ROOM ? tt : tv })) });
const NT_TIMETABLE = [{ zone_id: 1, m_offset: 0 }];
for (let j = 0; j < 7; j++) NT_TIMETABLE.push({ zone_id: 0, m_offset: j * 1440 + 480 }, { zone_id: 1, m_offset: j * 1440 + 1380 });
const NT = {
  valide: 'mock-refresh-0', n: 0, acces: '', modeMaison: 'schedule', manuel: {}, choisi: 'mock-planning', nPlanning: 0,
  plannings: [{
    id: 'mock-planning', name: 'Mon planning de chauffe', type: 'therm', hg_temp: 7, away_temp: 12,
    // les vannes ajoutées prennent les températures par défaut de l'appli (19 / 16)
    zones: [ntZone(0, 0, 'Comfort', 19, 20), ntZone(1, 1, 'Night', 16, 17), ntZone(3, 8, 'Comfort+', 21, 18), ntZone(4, 5, 'Eco', 16, 16)],
    timetable: NT_TIMETABLE,
  }],
};
const ntChoisi = () => NT.plannings.find(s => s.id === NT.choisi) || NT.plannings[0];
function ntHomesdata() {
  const modules = [{ id: NT_PLUG, type: 'NAPlug', name: 'Netatmo Relay', modules_bridged: [NT_THERM].concat(...NT_PIECES.map(p => p.vannes ? p.modules : [])) }];
  NT_PIECES.forEach(p => p.modules.forEach((m, i) => modules.push(m === NT_THERM
    ? { id: NT_THERM, type: 'NATherm1', name: 'Netatmo Smart Thermostat', room_id: p.id, bridge: NT_PLUG }
    : { id: m, type: 'NRV', name: p.name + (p.vannes > 1 ? ' ' + (i + 1) : ''), room_id: p.id, bridge: NT_PLUG })));
  return { status: 'ok', body: { homes: [{
    id: NT_HOME, name: 'Mon domicile', timezone: 'Europe/Paris', therm_mode: NT.modeMaison,
    therm_setpoint_default_duration: 180, temperature_control_mode: 'heating',
    rooms: NT_PIECES.map(p => ({ id: p.id, name: p.name, type: p.type, module_ids: p.modules })).concat([{ id: 'mock-entree', name: 'Entrée', type: 'lobby', module_ids: [] }]),
    modules: modules,
    schedules: NT.plannings.map(s => Object.assign({}, s, { selected: s.id === NT.choisi })),
  }], user: { email: 'personne@exemple.fr', id: 'mock-user' } } };
}
function ntHomestatus() {
  const maintenant = Math.floor(Date.now() / 1000), sch = ntChoisi();
  let chaudiere = false;
  const rooms = NT_PIECES.map(p => {
    let mode = 'schedule', temp, fin = 0;
    const man = NT.manuel[p.id];
    if (NT.modeMaison === 'away') { mode = 'away'; temp = sch.away_temp; }
    else if (NT.modeMaison === 'hg') { mode = 'hg'; temp = sch.hg_temp; }
    else if (man && man.fin > maintenant) { mode = man.mode; temp = man.mode === 'max' ? 30 : man.temp; fin = man.fin; }
    else temp = progNetatmo(sch, p.id, 'Europe/Paris', new Date(), true).actif.temp;
    const demande = p.mesure < temp - 0.1;
    if (demande) chaudiere = true;
    const r = { id: p.id, reachable: true, therm_measured_temperature: p.mesure, therm_setpoint_temperature: temp,
      therm_setpoint_mode: mode, therm_setpoint_end_time: fin, anticipating: false,
      open_window: process.env.MOCK_FENETRE === '1' && p.id === 'mock-sdb' };
    if (p.vannes) r.heating_power_request = demande && !r.open_window ? 100 : 0;
    return r;
  });
  const modules = [{ id: NT_PLUG, type: 'NAPlug', firmware_revision: 200, rf_strength: 80, wifi_strength: 50 }];
  NT_PIECES.forEach(p => p.modules.forEach(m => modules.push(m === NT_THERM
    ? { id: NT_THERM, type: 'NATherm1', reachable: true, battery_state: 'full', boiler_status: chaudiere, anticipating: false, bridge: NT_PLUG }
    : { id: m, type: 'NRV', reachable: true, battery_state: process.env.MOCK_PILES === '1' && p.id === 'mock-nines' ? 'low' : 'full', rf_strength: 60, bridge: NT_PLUG })));
  return { status: 'ok', body: { home: { id: NT_HOME, rooms: rooms, modules: modules } } };
}
// lecture d'une requête : corps json (avec home_id… dans l'url) ou formulaire (tableaux en json)
function ntParams(url, opt) {
  const h = (opt && opt.headers) || {}, corps = String((opt && opt.body) || '');
  const q = {};
  new URLSearchParams(String(url).split('?')[1] || '').forEach((v, k) => { q[k] = v; });
  if (/json/.test(h['Content-Type'] || '')) {
    try { return { json: true, p: Object.assign(q, JSON.parse(corps)) }; } catch (e) { return { json: true, p: q, illisible: true }; }
  }
  const p = Object.assign(q, {});
  new URLSearchParams(corps).forEach((v, k) => { p[k] = /^(zones|timetable)$/.test(k) ? (() => { try { return JSON.parse(v); } catch (e) { return null; } })() : v; });
  return { json: false, p: p };
}
const ntRefus = msg => new Response(JSON.stringify({ error: { code: 21, message: 'Invalid argument : ' + msg } }), { status: 400 });
function ntVerifiePlanning(p) {
  const tt = p.timetable, zs = p.zones;
  if (!Array.isArray(tt) || !tt.length) return 'timetable';
  if (!Array.isArray(zs) || !zs.length) return 'zones';
  if (zs.length > 12) return 'trop de zones (' + zs.length + ')';
  if (tt.length > 150) return 'trop de créneaux (' + tt.length + ')';
  if (tt[0].m_offset !== 0) return 'premier créneau pas à lundi 0 h';
  for (let i = 1; i < tt.length; i++) if (!(tt[i].m_offset > tt[i - 1].m_offset) || tt[i].m_offset >= 10080) return 'créneaux non triés';
  const ids = zs.map(z => z.id);
  if (tt.some(c => ids.indexOf(c.zone_id) < 0)) return 'zone inconnue dans timetable';
  for (const z of zs) {
    if (!Number.isInteger(z.id) || !Number.isInteger(z.type)) return 'zone sans id ou type';
    for (const piece of NT_PIECES) {
      const r = (z.rooms || []).find(x => x.id === piece.id);
      if (!r || typeof r.therm_setpoint_temperature !== 'number' || r.therm_setpoint_temperature < 7 || r.therm_setpoint_temperature > 30) return 'pièce ' + piece.name + ' absente ou hors bornes dans la zone ' + z.id;
    }
  }
  if (typeof Number(p.hg_temp) !== 'number' || isNaN(Number(p.hg_temp)) || isNaN(Number(p.away_temp))) return 'hg_temp / away_temp';
  return '';
}
function netatmoFaux(chemin, url, opt) {
  if (NETATMO === 'panne') throw new TypeError('fetch failed (netatmo simulé en panne)');
  if (chemin === 'oauth2/token') {
    const p = new URLSearchParams(String((opt && opt.body) || ''));
    if (p.get('refresh_token') !== NT.valide) return json400({ error: 'invalid_grant' });
    NT.n++; NT.valide = 'mock-refresh-' + NT.n; NT.acces = 'mock-acces-' + NT.n;
    return json({ access_token: NT.acces, refresh_token: NT.valide, expires_in: 10800 });
  }
  const auth = String((opt && opt.headers && opt.headers.Authorization) || '');
  if (auth !== 'Bearer ' + NT.acces) return new Response(JSON.stringify({ error: { code: 3, message: 'Access token expired' } }), { status: 403 });
  const ok = body => json(Object.assign({ status: 'ok', time_server: Math.floor(Date.now() / 1000) }, body ? { body: body } : {}));
  const lu = ntParams(url, opt), p = lu.p;
  if (chemin === 'api/homesdata') return json(ntHomesdata());
  if (chemin === 'api/homestatus') return json(ntHomestatus());
  if (chemin === 'api/setroomthermpoint') {
    if (!NT_PIECES.some(x => x.id === p.room_id)) return ntRefus('room_id');
    if (p.mode === 'manual' || p.mode === 'max') NT.manuel[p.room_id] = { mode: p.mode, temp: parseFloat(p.temp), fin: parseInt(p.endtime, 10) || Math.floor(Date.now() / 1000) + 10800 };
    else if (p.mode === 'home') delete NT.manuel[p.room_id];
    return ok();
  }
  if (chemin === 'api/setthermmode') {
    NT.modeMaison = p.mode;
    if (NT.modeMaison !== 'schedule') NT.manuel = {}; // absent et hors-gel annulent les réglages manuels
    return ok();
  }
  if (chemin === 'api/switchhomeschedule') {
    if (!NT.plannings.some(s => s.id === p.schedule_id)) return ntRefus('schedule_id');
    NT.choisi = p.schedule_id;
    return ok();
  }
  if (chemin === 'api/createnewhomeschedule' || chemin === 'api/synchomeschedule') {
    if (process.env.MOCK_PLANNING === 'refus' || (process.env.MOCK_PLANNING === 'form' && lu.json)) return ntRefus('planning refusé par le faux netatmo');
    const err = lu.illisible ? 'json illisible' : ntVerifiePlanning(p);
    if (err) { console.log('[mock] ' + chemin + ' refusé : ' + err); return ntRefus(err); }
    const champs = { name: p.name, hg_temp: Number(p.hg_temp), away_temp: Number(p.away_temp), zones: p.zones, timetable: p.timetable };
    if (chemin === 'api/synchomeschedule') {
      const s = NT.plannings.find(x => x.id === p.schedule_id);
      if (!s) return ntRefus('schedule_id');
      Object.assign(s, champs, { name: p.name || s.name });
      console.log('[mock] planning « ' + s.name + ' » mis à jour (' + (lu.json ? 'json' : 'formulaire') + ') : ' + p.zones.length + ' zones, ' + p.timetable.length + ' créneaux');
      return ok();
    }
    const id = 'mock-planning-' + (++NT.nPlanning);
    NT.plannings.push(Object.assign({ id: id, type: 'therm' }, champs));
    console.log('[mock] planning « ' + p.name + ' » créé (' + (lu.json ? 'json' : 'formulaire') + ') : ' + p.zones.length + ' zones, ' + p.timetable.length + ' créneaux');
    return ok({ schedule_id: id });
  }
  return new Response(JSON.stringify({ error: { code: 404, message: 'inconnu' } }), { status: 404 });
}

/* ---------- faux fetch ---------- */
const json = o => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
const html = s => new Response(s, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
const vide = code => new Response(null, { status: code });
const json400 = o => new Response(JSON.stringify(o), { status: 400, headers: { 'content-type': 'application/json' } });
const ROUTES = [
  [/api\.netatmo\.com\/(oauth2\/token|api\/\w+)/, (m, opt, u) => netatmoFaux(m[1], u, opt)],
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
global.fetch = async function (url, opt) {
  const u = String(url);
  for (const [re, fn] of ROUTES) {
    const m = u.match(re);
    if (m) { if (VERBOSE) console.log('[mock] ' + u); return fn(m, opt, u); }
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
  netatmo: NETATMO === '0' ? undefined : { clientId: 'mock', clientSecret: 'mock', refreshToken: 'mock-refresh-0' },
});
const TMP = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP, { recursive: true });
// le faux netatmo repart de son premier jeton à chaque lancement : on efface la chaîne précédente
try { fs.unlinkSync(path.join(TMP, 'netatmo-jeton.json')); } catch (e) { /* pas de chaîne précédente */ }
// le programme maison repart aussi de zéro (jamais appliqué), sauf MOCK_GARDER=1
if (process.env.MOCK_GARDER !== '1') { try { fs.unlinkSync(path.join(TMP, 'programme-maison.json')); } catch (e) { /* rien à effacer */ } }
const cfgPath = path.join(TMP, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify(CFG, null, 2) + '\n');
process.env.ECRAN_CONFIG = cfgPath;
console.log('[mock] réseau simulé, config ' + path.relative(RACINE, cfgPath) + ' · http://localhost:' + PORT + BASE + '/');
require(path.join(RACINE, 'server.js'));
