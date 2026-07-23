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

  const cartes = html.split(/class="[^"]*movie-card/).slice(1);
  console.log('cartes découpées :', cartes.length);

  cartes.slice(0, 3).forEach((c, i) => {
    const t = c.match(/meta-title-link[^>]*>\s*([^<]+?)\s*</) || c.match(/meta-title-link[^>]*title="([^"]+)"/);
    console.log('\n=== carte', i, '· titre :', t ? JSON.stringify(t[1].trim()) : 'INTROUVABLE');
    console.log('  rating-items dans la carte :', c.split(/rating-item/).length - 1);
    const m = c.indexOf('meta-title-link');
    if (m !== -1) console.log('  contexte titre :', JSON.stringify(c.slice(m, m + 180)));
    // id allociné du film (les anciens catalogues ont des ids bas)
    const cf = c.match(/cfilm=(\d+)/);
    console.log('  cfilm :', cf ? cf[1] : '?');
    // toutes les années présentes dans la carte, et mention reprise n'importe où
    const annees = (c.slice(0, 2500).match(/\b(19[2-9]\d|20[0-3]\d)\b/g) || []);
    console.log('  années dans la carte :', annees.join(', ') || 'aucune',
      '· "reprise" présent :', /reprise/i.test(c.slice(0, 2500)));
    // le texte utile sous le titre (date, genre, réalisateur…), balises retirées
    const mb = c.indexOf('meta-body');
    if (mb !== -1) {
      const brut = c.slice(mb, mb + 700).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      console.log('  meta-body :', JSON.stringify(brut.slice(0, 260)));
    }
  });

  // où vivent les notes si elles ne sont pas dans les cartes ?
  const premiereNote = html.indexOf('stareval-note');
  if (premiereNote !== -1 && !cartes.some(c => c.indexOf('stareval-note') !== -1)) {
    console.log('\nnotes hors cartes · contexte de la première :',
      JSON.stringify(html.slice(Math.max(0, premiereNote - 200), premiereNote + 100)));
  }
})().catch(e => console.log('erreur :', e.message));
