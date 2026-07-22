# mode opératoire · finir l'écran maison

Runbook pour aller au bout du projet. Les valeurs secrètes (clé football-data, URL ICS, identifiants Spotify) ne sont pas dans ce fichier : elles vont uniquement dans `config.json`, qui n'est jamais versionné.

## état du projet

Déjà fait :

- code complet et testé (serveur, template iPad, sport foot + nba + ufc, replis d'erreur)
- calendrier iCloud « Maison » créé, partagé et publié (URL ICS en main)
- clé football-data obtenue, ids d'équipes vérifiés (521 losc, 98 milan, 64 liverpool, 773 france)
- unité systemd prête dans `deploy/ecran-maison.service`

Reste : Spotify (étape 1), déploiement VPS (étape 2), iPad (étape 3), stats studio (étape 4, optionnelle).

## étape 1 · spotify (~15 min, sur le PC)

Objectif : obtenir le `refresh_token`. Prérequis déjà en place : projet cloné dans `~/ecran-maison`, Node ≥ 18, app « Home screen » créée sur [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) avec la redirect URI exacte `http://127.0.0.1:8888/callback`.

1. PowerShell :
   ```powershell
   cd $HOME\ecran-maison
   node auth-spotify.js CLIENT_ID CLIENT_SECRET
   ```
   (Client ID et secret : Dashboard → l'app → Settings → Basic Information, utiliser les icônes de copie.)
2. Ouvrir l'URL affichée, se connecter avec le compte Spotify **qui joue la musique à la maison** (Premium), cliquer Accepter.
3. Le refresh token s'affiche dans PowerShell entre deux lignes `===`. Noter les trois valeurs : clientId, clientSecret, refreshToken.

Si la page dit « client_id: Invalid » :

- vérifier que l'e-mail du compte Spotify est validé ([spotify.com/account](https://www.spotify.com/account), bandeau de vérification) puis réessayer ;
- sinon supprimer l'app (Settings → Delete app) et la recréer : description remplie, redirect URI collée puis bouton **Add**, Web API cochée, Save. Relancer l'étape 1 avec le nouveau Client ID et le nouveau secret.

## étape 2 · déploiement vps (~15 min)

1. Se connecter : `ssh root@IP_DU_VPS` (IP et mot de passe dans le hPanel Hostinger).
2. Vérifier Node : `node -v` (il faut ≥ 18). Si absent ou trop vieux :
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
   apt-get install -y nodejs
   ```
3. Cloner et installer :
   ```bash
   git clone -b claude/config-setup-guidance-ff5lnv https://github.com/LordWLK/home-sceen.git ~/ecran-maison
   cd ~/ecran-maison
   npm install
   cp config.example.json config.json
   nano config.json
   ```
4. Remplir `config.json` : basePath improbable inventé (garder le `/` initial, pas de slash final), URL ICS en `https://`, clé football-data, bloc spotify de l'étape 1. `statsUrl` peut rester vide pour l'instant.
5. Test manuel : `node server.js` doit afficher « écran maison prêt ». Depuis un téléphone en 4G : `http://IP_DU_VPS:8017/le-chemin/` doit montrer la page avec la vraie météo. Puis Ctrl+C.
6. Service permanent :
   ```bash
   sudo cp deploy/ecran-maison.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now ecran-maison
   systemctl status ecran-maison          # attendu : active (running)
   journalctl -u ecran-maison -n 20       # aucun [maj] en échec répété
   ```
   Si le projet n'est pas dans `/root/ecran-maison`, adapter `WorkingDirectory` dans l'unité ; le chemin de node se vérifie avec `which node`.
7. Pare-feu : hPanel → VPS → Pare-feu → règle **TCP, port 8017, source any**. Si `ufw` est actif sur la machine : `ufw allow 8017/tcp`.

## étape 3 · ipad (~5 min)

1. Safari → `http://IP_DU_VPS:8017/le-chemin/` (en http, c'est voulu : iOS 9 ne connaît pas les certificats Let's Encrypt).
2. Partager → **Sur l'écran d'accueil** → lancer depuis l'icône (plein écran).
3. Réglages : verrouillage automatique **jamais**, luminosité auto désactivée, notifications coupées.
4. Recommandé au mur : Accès guidé (Réglages → Général → Accessibilité), puis triple clic sur le bouton principal dans la page pour verrouiller l'iPad dessus.

La page se recharge toute seule toutes les 10 minutes ; la musique se met à jour toutes les 30 secondes.

## étape 4 · stats yum.ines (optionnelle, à tout moment)

1. Récupérer l'URL de la fonction Netlify du media kit (dashboard Netlify → Functions).
2. `curl -s CETTE_URL` : si le JSON contient `followers` et `delta7` (ou `abonnes`, `weeklyGrowth`, `instagram.followers`…), coller simplement l'URL dans `statsUrl` du config.json et `systemctl restart ecran-maison`.
3. Si le format est différent, adapter les deux lignes de lecture dans `majStudio()` (server.js, section studio, c'est commenté).

## mises à jour futures

```bash
ssh root@IP_DU_VPS
cd ~/ecran-maison && git pull && npm install && systemctl restart ecran-maison
```

## dépannage express

- Logs en direct : `journalctl -u ecran-maison -f`
- Une source morte logge `[maj] … en échec : …` et garde son dernier contenu ; le serveur ne crashe jamais pour ça.
- Page inaccessible de l'extérieur mais OK en local sur le VPS : pare-feu (port 8017) ou faute de frappe dans le chemin secret.
- Capsule musique absente : normal quand rien ne joue (classe `off`) ; vérifier le bloc spotify du config sinon.
- L'agenda met parfois quelques minutes à refléter un nouvel événement (propagation iCloud du calendrier public).
