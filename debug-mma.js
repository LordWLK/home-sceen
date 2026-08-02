/* diagnostic des flux mma espn · à lancer sur le vps :
     node debug-mma.js            → sonde ufc + pfl (ou les ligues de config.mma)
     node debug-mma.js bellator   → sonde une ligue précise
   coller la sortie complète dans la conversation pour calibrer le parseur. */

const fs = require('fs');
let CFG = {};
try { CFG = JSON.parse(fs.readFileSync(__dirname + '/config.json', 'utf8')); } catch (e) {}

const arg = process.argv[2];
const ligues = arg ? [{ espn: arg, nom: arg }]
  : (Array.isArray(CFG.mma) && CFG.mma.length ? CFG.mma : [{ espn: 'ufc', nom: 'ufc' }, { espn: 'pfl', nom: 'pfl' }]);

async function jsonEspn(u) {
  const r = await fetch(u);
  return { status: r.status, j: r.ok ? await r.json() : null };
}

(async () => {
  for (const lg of ligues) {
    console.log('=== ligue', lg.espn, '===');
    const u = 'https://site.api.espn.com/apis/site/v2/sports/mma/' + lg.espn + '/scoreboard';
    try {
      const { status, j } = await jsonEspn(u);
      console.log('http :', status);
      if (!j) continue;
      const cal = (((j.leagues || [])[0] || {}).calendar) || [];
      console.log('événements au calendrier :', cal.length);
      // les 8 prochains : libellé brut + date (c'est le libellé qui donne la tête d'affiche)
      const fen = cal.filter(c => {
        const d = new Date(c.startDate || c);
        return !isNaN(d) && d > new Date(Date.now() - 12 * 3600000) && d < new Date(Date.now() + 60 * 86400000);
      }).slice(0, 8);
      for (const c of fen) {
        console.log('  ·', JSON.stringify(String(c.label || '')), '·', String(c.startDate || c).slice(0, 10));
        // carte du jour : heure réelle + les 3 premiers combats
        try {
          const ymd = new Date(c.startDate || c).toISOString().slice(0, 10).replace(/-/g, '');
          const { j: jour } = await jsonEspn(u + '?dates=' + ymd);
          ((jour && jour.events) || []).forEach(ev => {
            const combats = (ev.competitions || []).slice(0, 3).map(co =>
              (co.competitors || []).map(a => (a.athlete && a.athlete.displayName) || '?').join(' vs '));
            console.log('    heure :', ev.date, '· combats :', combats.join(' | ') || '(vide)');
          });
        } catch (e) { console.log('    carte du jour : erreur', e.message); }
      }
    } catch (e) { console.log('erreur :', e.message); }
    console.log('');
  }
})().catch(e => console.log('erreur :', e.message));
