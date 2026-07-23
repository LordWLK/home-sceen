/* diagnostic du parseur ciné · à lancer sur le vps :
     node debug-cine.js /tmp/allo.html   → analyse un fichier téléchargé par curl
     node debug-cine.js                  → va chercher la page allociné comme le serveur
   coller la sortie complète dans la conversation pour ajuster le parseur. */

const fs = require('fs');
const CODE = process.argv[3] || 'P0086';

async function recupererHtml() {
  if (process.argv[2]) return fs.readFileSync(process.argv[2], 'utf8');
  const r = await fetch('https://www.allocine.fr/seance/salle_gen_csalle=' + CODE + '.html', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Accept-Language': 'fr-FR,fr;q=0.9',
    },
  });
  console.log('http :', r.status);
  return r.text();
}

(async () => {
  const html = await recupererHtml();
  console.log('taille :', html.length, 'octets');
  console.log('occurrences · movie-card :', (html.match(/movie-card/g) || []).length,
    '· stareval-note :', (html.match(/stareval-note/g) || []).length,
    '· meta-title-link :', (html.match(/meta-title-link/g) || []).length,
    '· rating-item :', (html.match(/rating-item/g) || []).length);

  // exactement le découpage et le parseur de server.js
  const cartes = html.split(/class="[^"]*movie-card/).slice(1);
  console.log('cartes découpées :', cartes.length, '\n');

  cartes.forEach((c, i) => {
    const titres = (c.match(/meta-title-link[^>]*>\s*([^<]+?)\s*</g) || []).length;
    const t = c.match(/meta-title-link[^>]*>\s*([^<]+?)\s*</) || c.match(/meta-title-link[^>]*title="([^"]+)"/);
    if (!t || !t[1].trim()) return;
    const cf = c.match(/cfilm=(\d+)/);
    // notes lues exactement comme server.js
    let presse = 0, spect = 0;
    const matches = c.match(/stareval-note[^>]*>\s*([\d,.]+)/g) || [];
    for (const raw of matches) {
      const idx = c.indexOf(raw);
      const val = parseFloat(raw.replace(/.*>\s*/, '').replace(',', '.'));
      if (isNaN(val)) continue;
      const avant = c.slice(Math.max(0, idx - 600), idx).toLowerCase();
      const p = avant.lastIndexOf('presse'), s = avant.lastIndexOf('spectateur');
      if (p === -1 && s === -1) continue;
      if (p > s) presse = Math.max(presse, val); else spect = Math.max(spect, val);
    }
    const flag = titres > 1 ? '  <<< ' + titres + ' TITRES DANS CE SEGMENT' : '';
    console.log('carte', i, '·', JSON.stringify(t[1].trim()),
      '· cfilm', cf ? cf[1] : '?',
      '· presse', presse || '-', '· spect', spect || '-',
      '· notes brutes:[' + matches.map(m => m.replace(/.*>\s*/, '')).join(',') + ']' + flag);
  });
})().catch(e => console.log('erreur :', e.message));
