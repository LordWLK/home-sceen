# écran maison · serveur

Un seul process Node sur le VPS : il récupère météo, agenda, sport et stats toutes les 5 minutes, interroge Spotify toutes les 30 secondes, et sert la page « arcades » à l'iPad en HTTP simple.

## 1 · prérequis sur le VPS

```bash
node -v        # il faut node 18 ou plus
git clone https://github.com/LordWLK/home-sceen.git ~/ecran-maison
cd ~/ecran-maison
npm install
cp config.example.json config.json
```

## 2 · calendrier iCloud

Sur Mac ou iPhone, app Calendrier : sélectionner le calendrier partagé avec Inès, ouvrir ses infos, cocher **Calendrier public**, copier l'URL (`webcal://p…icloud.com/published/…`).

Dans `config.json`, coller cette URL dans `icsUrl` en remplaçant `webcal://` par `https://`.

Note : un calendrier public est lisible par quiconque a l'URL. Elle est illisible sans la connaître, même logique que le chemin secret de la page.

## 3 · spotify (une fois, depuis ton PC)

1. Sur developer.spotify.com/dashboard : créer une app, type Web API.
2. Dans ses réglages, ajouter la redirect URI exactement : `http://127.0.0.1:8888/callback`
3. Sur ton PC :

```bash
node auth-spotify.js TON_CLIENT_ID TON_CLIENT_SECRET
```

4. Ouvrir l'URL affichée, accepter, récupérer le `refresh_token` dans le terminal.
5. Reporter `clientId`, `clientSecret` et `refreshToken` dans `config.json` sur le VPS.

Compte Premium requis pour le contrôle de lecture.

## 4 · sport

Trois sources, mélangées puis triées par date (les 4 prochaines échéances s'affichent dans l'arche centrale) :

- **foot** (losc, milan, liverpool, équipe de france) : clé gratuite sur football-data.org à coller dans `footballDataKey`. Les équipes suivies sont dans `equipesFoot` (id football-data + nom affiché). Vérifier les ids une fois :

```bash
curl -H "X-Auth-Token: TA_CLE" https://api.football-data.org/v4/teams/521   # Lille OSC
curl -H "X-Auth-Token: TA_CLE" https://api.football-data.org/v4/teams/98    # AC Milan
curl -H "X-Auth-Token: TA_CLE" https://api.football-data.org/v4/teams/64    # Liverpool FC
curl -H "X-Auth-Token: TA_CLE" https://api.football-data.org/v4/teams/773   # France
```

  Limite de l'offre gratuite : pas de matchs amicaux, et l'équipe de France n'apparaît que pendant les grands tournois (euro, coupe du monde).

- **nba** (suns, knicks) : api publique espn, sans clé. `nba` liste les équipes suivies (abréviation espn + nom affiché). Hors saison, la source se tait toute seule.

- **ufc** : api publique espn, sans clé. Les événements numérotés (UFC 324…) s'affichent toujours ; les fight nights seulement si un combattant de `ufcFrancais` est à la carte. Noms en minuscules et sans accents, la liste est libre (par défaut : gane, saint denis, imavov, fiorot, ziam, gomis, charriere, lapilus).

Si aucune source ne répond, le serveur affiche le contenu de `events.json`, à éditer à la main.

## 4 bis · ciné (arche terracotta)

L'arche « ciné » affiche les 3 films à l'affiche les mieux notés (moyenne presse + spectateurs AlloCiné) dans les cinémas configurés. Pour chaque cinéma à suivre :

1. Sur allocine.fr, chercher le cinéma et ouvrir sa page horaires : l'URL ressemble à `https://www.allocine.fr/seance/salle_gen_csalle=P0104.html`
2. Reporter le code (`P0104` dans l'exemple) dans `cinemas` du config.json :

```json
"cinemas": [
  { "allocine": "P0104", "nom": "ugc lille" },
  { "allocine": "XXXX", "nom": "ugc villeneuve d'ascq" }
]
```

L'affiche est rafraîchie toutes les 6 h (scraping poli d'allociné ; si la structure de leurs pages change, la source logge `[maj] ciné en échec` et garde son dernier contenu). Liste vide = arche sobre, rien ne casse.

## 5 · stats yum.ines

Renseigner `statsUrl` avec l'endpoint Netlify du media kit : les stats s'affichent dans le pendentif terracotta en haut de l'écran (masqué tant que `statsUrl` est vide). Si le JSON renvoyé n'a pas des champs `followers` / `delta7`, adapter les deux lignes de lecture dans `majStudio()` (server.js, section studio, c'est commenté).

## 6 · chemin secret et lancement

Personnaliser `basePath` dans `config.json` (garder un truc improbable). Puis :

```bash
node server.js
# → écran maison prêt : http://<ip-du-vps>:8017/maison-x7k2p/
```

Test depuis un navigateur : la page doit s'afficher avec la vraie météo.

## 7 · lancement automatique (systemd)

L'unité est fournie dans `deploy/ecran-maison.service` :

```bash
sudo cp deploy/ecran-maison.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ecran-maison
```

Adapter `WorkingDirectory` et le chemin de node (`which node`) si besoin. Vérifier que le port 8017 est ouvert dans le pare-feu Hostinger.

## 8 · réglages iPad

1. Safari → ouvrir `http://<ip-du-vps>:8017/maison-x7k2p/`
2. Partager → **Sur l'écran d'accueil**, puis lancer depuis l'icône (plein écran).
3. Réglages : verrouillage automatique sur **jamais**, luminosité auto désactivée, notifications coupées.
4. Optionnel : Accès guidé (Réglages → Général → Accessibilité) pour verrouiller l'iPad sur cette app.

## endpoints

- `GET {basePath}/` : la page
- `GET {basePath}/musique/etat` : état lecture (JSON)
- `GET {basePath}/musique/pause` : lecture / pause
- `GET {basePath}/musique/suivant` : piste suivante
- `GET {basePath}/musique/pochette` : pochette proxifiée (l'iPad la lit en HTTP chez nous)
