# écran maison · serveur

Un seul process Node sur le VPS : il récupère météo, agenda, sport et stats toutes les 5 minutes, interroge Spotify toutes les 30 secondes, et sert la page « arcades » à l'iPad en HTTP simple.

## 1 · prérequis sur le VPS

```bash
node -v        # il faut node 18 ou plus
mkdir -p ~/ecran-maison && cd ~/ecran-maison
# copier les fichiers du projet ici (scp ou git), puis :
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

## 4 · sport (optionnel)

Clé gratuite sur football-data.org, à coller dans `footballDataKey`. La Coupe du monde et la Ligue 1 sont dans l'offre gratuite. `loscTeamId` vaut 521, à vérifier une fois avec un appel sur `/v4/teams/521` (ça doit répondre Lille OSC).

Sans clé, le serveur affiche le contenu de `events.json`, à éditer à la main.

## 5 · stats yum.ines

Renseigner `statsUrl` avec l'endpoint Netlify du media kit. Si le JSON renvoyé n'a pas des champs `followers` / `delta7`, adapter les deux lignes de lecture dans `majStudio()` (server.js, section studio, c'est commenté).

## 6 · chemin secret et lancement

Personnaliser `basePath` dans `config.json` (garder un truc improbable). Puis :

```bash
node server.js
# → écran maison prêt : http://<ip-du-vps>:8017/maison-x7k2p/
```

Test depuis un navigateur : la page doit s'afficher avec la vraie météo.

## 7 · lancement automatique (systemd)

```bash
sudo tee /etc/systemd/system/ecran-maison.service << 'EOF'
[Unit]
Description=ecran maison
After=network-online.target

[Service]
WorkingDirectory=/root/ecran-maison
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
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
