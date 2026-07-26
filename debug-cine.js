/* diagnostic du parseur ciné · à lancer sur le vps :
     node debug-cine.js            → sonde aujourd'hui + demain + surlendemain (code P0086 par défaut)
     node debug-cine.js P0047      → autre cinéma
     node debug-cine.js P0086 /tmp/allo.html → analyse un fichier déjà téléchargé (jour 0 seulement)
   coller la sortie complète dans la conversation pour ajuster le parseur. */

const fs = require('fs');
const ARGS = process.argv.slice(2);
const CODE = (ARGS[0] && !ARGS[0].startsWith('/')) ? ARGS[0] : 'P0086';
const FICHIER = ARGS.find(a => a && a.startsWith('/'));

function decodeEntites(s){return String(s||"").replace(/&#(\d+);/g,function(m,n){return String.fromCharCode(parseInt(n,10));}).replace(/&#x([0-9a-f]+);/gi,function(m,n){return String.fromCharCode(parseInt(n,16));}).replace(/&quot;/g,String.fromCharCode(34)).replace(/&apos;/g,String.fromCharCode(39)).replace(/&nbsp;/g," ").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&");}

function url(off){const b='https://www.allocine.fr/seance/salle_gen_csalle='+CODE;return off===0?b+'.html':b+'/d-'+off+'/';}

async function recupererHtml(u){
  const r = await fetch(u, { headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    'Accept-Language': 'fr-FR,fr;q=0.9',
  }});
  return { status: r.status, html: await r.text() };
}

function datesShowtime(html){
  const d = {};
  const re = /data-showtime-time="(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/g;
  let m;
  while ((m = re.exec(html))) d[m[1]] = (d[m[1]] || 0) + 1;
  return d;
}

function dumpFilms(html){
  const cartes = html.split(/class="[^"]*movie-card/).slice(1);
  console.log('  cartes :', cartes.length);
  cartes.slice(0, 6).forEach((c) => {
    const t = c.match(/meta-title-link[^>]*>\s*([^<]+?)\s*</) || c.match(/meta-title-link[^>]*title="([^"]+)"/);
    if (!t || !t[1].trim()) return;
    const heures = (c.match(/data-showtime-time="\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/g) || [])
      .map(x => x.slice(-5));
    console.log('   ·', JSON.stringify(decodeEntites(t[1].trim())), '→', heures.length, 'séances', heures.slice(0, 8).join(' '));
  });
}

(async () => {
  console.log('cinéma :', CODE, '\n');

  if (FICHIER) {
    const html = fs.readFileSync(FICHIER, 'utf8');
    console.log('fichier :', FICHIER, '·', html.length, 'octets');
    console.log('dates de séances trouvées :', datesShowtime(html));
    dumpFilms(html);
    return;
  }

  // on sonde les 3 jours et on regarde quelles dates de séances chaque page contient.
  // objectif : confirmer que /d-1/ renvoie bien les séances de demain (et pas celles d'aujourd'hui).
  for (let off = 0; off < 3; off++) {
    const u = url(off);
    console.log('=== jour +' + off + ' ===');
    console.log('url :', u);
    try {
      const { status, html } = await recupererHtml(u);
      console.log('http :', status, '·', html.length, 'octets');
      console.log('dates de séances présentes :', datesShowtime(html));
      dumpFilms(html);
    } catch (e) { console.log('erreur :', e.message); }
    console.log('');
  }
})().catch(e => console.log('erreur :', e.message));
