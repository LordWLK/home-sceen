/* diagnostic du parseur ciné · à lancer sur le vps :
     node debug-cine.js /tmp/allo.html   → analyse un fichier téléchargé par curl
     node debug-cine.js                  → va chercher la page allociné comme le serveur
   coller la sortie complète dans la conversation pour ajuster le parseur. */

const fs = require('fs');
function decodeEntites(s){return String(s||"").replace(/&#(\d+);/g,function(m,n){return String.fromCharCode(parseInt(n,10));}).replace(/&#x([0-9a-f]+);/gi,function(m,n){return String.fromCharCode(parseInt(n,16));}).replace(/&quot;/g,String.fromCharCode(34)).replace(/&apos;/g,String.fromCharCode(39)).replace(/&nbsp;/g," ").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&");}
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
    // année du meta-body, notes bloc par bloc — exactement comme server.js
    const mb = c.indexOf('meta-body');
    const an = mb !== -1 ? (c.slice(mb, mb + 120).match(/\b(19\d\d|20[0-3]\d)\b/) || [])[1] : null;
    let presse = 0, spect = 0;
    for (const bloc of c.split(/class="[^"]*rating-item/).slice(1)) {
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
    const cat = (cf && parseInt(cf[1], 10) < 20000) || (an && parseInt(an, 10) <= new Date().getFullYear() - 2);
    const flag = titres > 1 ? '  <<< ' + titres + ' TITRES' : '';
    console.log('carte', i, '·', JSON.stringify(decodeEntites(t[1].trim())),
      '· cfilm', cf ? cf[1] : '?', '· année', an || '?',
      '· presse', presse || '-', '· spect', spect || '-',
      '·', cat ? 'REPRISE' : 'nouveauté', flag);
  });
})().catch(e => console.log('erreur :', e.message));
