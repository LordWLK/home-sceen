/* ============================================================
   autorisation spotify · à lancer UNE FOIS sur ton pc (pas le vps)
   usage :  node auth-spotify.js CLIENT_ID CLIENT_SECRET
   prérequis : dans le dashboard spotify developer, ajouter
   exactement cette redirect uri à ton app :
   http://127.0.0.1:8888/callback
   ============================================================ */

const http = require('http');

const clientId = process.argv[2];
const clientSecret = process.argv[3];
if (!clientId || !clientSecret) {
  console.log('usage : node auth-spotify.js CLIENT_ID CLIENT_SECRET');
  process.exit(1);
}

const REDIRECT = 'http://127.0.0.1:8888/callback';
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing';

const urlAuth = 'https://accounts.spotify.com/authorize' +
  '?response_type=code' +
  '&client_id=' + encodeURIComponent(clientId) +
  '&scope=' + encodeURIComponent(SCOPES) +
  '&redirect_uri=' + encodeURIComponent(REDIRECT);

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1:8888');
  if (u.pathname !== '/callback') { res.end(); return; }
  const code = u.searchParams.get('code');
  if (!code) { res.end('pas de code reçu, réessaie.'); return; }

  const basic = Buffer.from(clientId + ':' + clientSecret).toString('base64');
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + basic,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=authorization_code&code=' + encodeURIComponent(code) +
      '&redirect_uri=' + encodeURIComponent(REDIRECT),
  });
  const j = await r.json();

  if (j.refresh_token) {
    res.end('c\'est bon, retourne dans le terminal.');
    console.log('\n=== refresh token (à coller dans config.json) ===\n');
    console.log(j.refresh_token);
    console.log('\n=================================================\n');
  } else {
    res.end('erreur, regarde le terminal.');
    console.log('réponse spotify :', j);
  }
  process.exit(0);
}).listen(8888, () => {
  console.log('\nouvre cette url dans ton navigateur et accepte :\n');
  console.log(urlAuth + '\n');
});
