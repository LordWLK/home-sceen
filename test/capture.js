#!/usr/bin/env node
/* captures playwright de la page servie par le harnais (test/mock.js) :
   accueil ipad 1024×768, puis variantes pour l'écran 1280×800 du kiosque pi.

   usage : node test/mock.js &  puis
           NODE_PATH=$(npm root -g) node test/capture.js [url] [dossier de sortie]
   (playwright est installé en global dans l'environnement de dev ; chromium
    dans /opt/pw-browsers) */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const URL0 = process.argv[2] || 'http://localhost:8017/maison-mock/';
const OUT = process.argv[3] || path.join(__dirname, 'tmp', 'captures');
fs.mkdirSync(OUT, { recursive: true });

function get(u) {
  return new Promise((res, rej) => {
    http.get(u, r => { let b = ''; r.on('data', c => { b += c; }); r.on('end', () => res(b)); }).on('error', rej);
  });
}
// on attend que les sources mock soient toutes passées une fois
async function attendreServeur() {
  for (let i = 0; i < 60; i++) {
    try {
      const j = JSON.parse(await get(URL0 + 'contenu?t=' + Date.now()));
      if (j.sport && j.cinema && j.meteo.indexOf('indisponible') === -1 && j.agendaAuj.indexOf('chargement') === -1) return;
    } catch (e) { /* pas encore là */ }
    await new Promise(r => setTimeout(r, 500));
  }
  console.log('serveur pas prêt après 30 s, on capture quand même');
}

async function capture(browser, nom, vp, url, prep) {
  const page = await browser.newPage({ viewport: vp, deviceScaleFactor: 1 });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(1500); // premier poll musique (pochette + teinte)
  if (prep) await prep(page);
  await page.waitForTimeout(700);  // fondus css
  await page.screenshot({ path: path.join(OUT, nom + '.png') });
  await page.close();
  console.log('→', path.join(OUT, nom + '.png'));
}

// variante « scène élargie » : le stage passe de 1024×768 à 1280×800 sans mise à l'échelle
function elargir(largeurArche) {
  return page => page.evaluate(w => {
    var st = document.getElementById('stage'), f = document.getElementById('fit');
    st.style.width = '1280px'; st.style.height = '800px';
    st.style.webkitTransform = 'none'; st.style.transform = 'none';
    var vs = document.querySelectorAll('.vue');
    for (var i = 0; i < vs.length; i++) { vs[i].style.width = '1280px'; vs[i].style.height = '800px'; }
    f.style.left = '0px'; f.style.top = '0px'; f.style.width = '1280px'; f.style.height = '800px';
    if (w) {
      var as = document.querySelectorAll('.arch');
      for (var k = 0; k < as.length; k++) { as[k].style.width = w + 'px'; as[k].style.borderRadius = (w / 2) + 'px ' + (w / 2) + 'px 0 0'; }
    }
  }, largeurArche || 0);
}

(async () => {
  await attendreServeur();
  const browser = await chromium.launch();
  await capture(browser, 'ipad-accueil', { width: 1024, height: 768 }, URL0);
  const pi = { width: 1280, height: 800 }, urlPi = URL0 + '?kiosque';
  await capture(browser, 'pi-A-actuel', pi, urlPi);
  await capture(browser, 'pi-B-bandes-ivoire', pi, urlPi, p => p.addStyleTag({ content: 'body{background:#f6f1e8}' }));
  await capture(browser, 'pi-C-scene-elargie', pi, urlPi, elargir(0));
  await capture(browser, 'pi-D-arches-larges', pi, urlPi, elargir(360));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
