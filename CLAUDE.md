# écran maison · contexte projet

Fichier de passation. À placer à la racine du projet (à côté de server.js) : Claude Code le lit automatiquement.

## le projet en une phrase

Écran mural de maison sur un iPad 3 (iOS 9, paysage 1024×768) fixé au mur, qui affiche une page HTML servie par un VPS Hostinger en HTTP simple, régénérée côté serveur avec météo, agenda partagé, sport, stats Instagram et contrôle Spotify.

## contraintes non négociables (iPad 3 / Safari iOS 9)

Tout ce qui est envoyé à l'iPad doit respecter :

- **JS : ES5 strict uniquement.** Pas de `fetch`, `Promise`, `let/const`, fonctions fléchées, template literals, `classList` à éviter par prudence (manipuler `className`). XHR uniquement.
- **CSS : pas de grid, pas de `gap`, pas de `var()`, pas d'`aspect-ratio`.** Flexbox obligatoirement doublé en `-webkit-` (`display:-webkit-flex`, `-webkit-align-items`, etc.).
- **Polices natives iOS uniquement** : Optima, Georgia, Avenir Next, Helvetica Neue. Aucun chargement de police externe.
- **HTTP simple, jamais HTTPS vers l'iPad** : iOS 9 ne reconnaît pas la racine ISRG de Let's Encrypt. C'est un choix assumé, ne pas "corriger" en ajoutant du TLS. Toute ressource externe (pochette d'album) est proxifiée par le serveur.
- **Icônes dessinées en CSS pur** (pseudo-éléments), pas d'emoji ni de glyphes unicode exotiques.
- Sécurité par chemin secret (`basePath` improbable dans config.json), pas d'auth. Ne pas logguer ce chemin publiquement.

Côté serveur en revanche : Node ≥ 18 moderne, `fetch` natif, async/await, tout est permis.

## la direction artistique (validée, ne pas dévier sans demander)

DA « arcades », retenue après 3 rondes d'exploration (sombre → clair calme → vert/orange → découpage → 5 variations). Esprit papiers découpés façon Matisse, calme et classe.

- Fond ivoire `#f6f1e8`, encre `#35342d`
- Trois arches en bas : olive `#75815f` (aujourd'hui + intertitre « à venir », deux sections), sable `#e5d5bd` (sport, arche centrale plus haute), terracotta `#b96f45` (ciné)
- Pendentif terracotta en haut au centre (petite arche renversée descendant du bord) : stats yum.ines, masqué (`off`) tant que `statsUrl` est vide
- Horloge Optima en haut à gauche, date Georgia italique dessous, météo en haut à droite
- Capsule musique d'encre en haut à droite (vinyle CSS remplacé par la pochette quand elle charge) : en pause elle reste visible tamisée (classe `paused`, bouton lecture) ; masquée via la classe `off` seulement quand plus rien n'est chargé (le serveur vide le titre sur 204/erreur). Fond teinté par la couleur dominante de la pochette (canvas côté client, assombrie ×0.3, aucune dépendance serveur). Boutons volume −/+ en plus de pause/suivant
- Prochaine échéance de l'agenda mise en évidence (classe `next` : petit point d'accent)
- **Mode nuit automatique 21 h → 7 h** (classe `nuit` sur body, palettes assombries définies dans le CSS), bascule en fondu (transitions CSS 1 s) ; les zones rafraîchies apparaissent en fondu léger (0,4 s, seulement si le contenu change)
- Typo : titres d'arches en Georgia italique, labels en petites capitales espacées, capitalisation française (pas de Title Case), pas de tirets cadratins dans les textes

## architecture

Un seul process Node (`server.js`), une seule dépendance (`node-ical`).

- Cache en mémoire, pas de base de données
- Données (météo, agenda, sport, studio) rafraîchies toutes les 2 min via `setInterval` ; Spotify toutes les 5 s — **ne pas descendre sous 5 s** : à 2 s l'API punit par des 429 avec Retry-After de 90 min et plus (tolérance : la capsule n'est vidée qu'après 10 échecs consécutifs, et le Retry-After est respecté)
- La page est assemblée à chaque GET depuis `template.html` par remplacement de slots : `{{METEO}}`, `{{AGENDA_AUJ}}`, `{{AGENDA_VENIR}}`, `{{SPORT_ITEMS}}`, `{{STUDIO_ITEMS}}`, `{{MUSIC_CLASS}}`, `{{MUSIC_TITLE}}`, `{{MUSIC_ARTIST}}`
- Côté iPad : poll XHR `musique/etat` toutes les 2 s + poll XHR `contenu` toutes les 60 s (remplacement innerHTML des zones `#z-*`, pas de rechargement) ; meta refresh complet toutes les 30 min par hygiène. URLs relatives, d'où la redirection 301 qui force la barre oblique finale sur `basePath`. Toutes les réponses en `Cache-Control: no-store` + horodatage anti-cache sur les polls (Safari iOS 9 met les XHR GET en cache sinon)
- Fuseau : tout est formaté en `Europe/Paris` via `Intl` côté serveur (le VPS peut être en UTC)

### endpoints (tous sous `basePath`)

- `GET /` page assemblée
- `GET /contenu` JSON de toutes les zones (météo, agenda auj/venir, sport, studio, ciné) + `figees` (sources en échec au-delà de leur seuil)
- `GET /musique/etat` JSON `{playing, title, artist}`
- `GET /musique/pause` toggle play/pause
- `GET /musique/suivant` piste suivante
- `GET /musique/volume/plus` et `/musique/volume/moins` ±10 % (lit le volume de l'appareil actif puis le règle)
- `GET /musique/pochette` image proxifiée (no-store)

### sources de données

- **Météo** : Open-Meteo, gratuit sans clé, codes météo mappés en libellés FR. Ligne détail : mini/maxi du jour + prochaine heure pluvieuse (proba ≥ 50 %, heure de Paris)
- **Santé des sources** : chaque `maj*` horodate sa réussite dans `sante` ; `sourcesFigees()` liste celles dépassant leur seuil (16 min pour météo/agenda/sport, 14 h pour ciné/studio), affichées discrètement en haut à gauche. Initialisées « fraîches » au démarrage
- **Agenda** : calendrier iCloud publié (URL ICS `webcal://` → `https://`), récurrences gérées par node-ical (`rrule.between`), fenêtre de 7 jours coupée en deux sections : « aujourd'hui » (2 max, heure seule) et « à venir » (2 max, libellés relatifs "demain 18 h", "lun 27 · 19 h 30")
- **Sport** : trois sources mélangées puis triées par date, 4 échéances max. Foot via football-data.org v4 si `footballDataKey` renseignée (équipes dans `equipesFoot` : 521 losc, 98 milan, 64 liverpool, 773 france, **ids à vérifier une fois** ; amicaux et sélections hors tournois absents de l'offre gratuite). NBA (`nba` : phx suns, ny knicks) et UFC via l'API publique ESPN sans clé (événements numérotés toujours affichés, fight nights seulement si un nom de `ufcFrancais` est à la carte, comparaison sans accents). Repli global sur `events.json` édité à la main
- **Studio** : abonnés du profil Instagram public de `instagram` (regex `edge_followed_by`/`follower_count`, repli sur le og:description arrondi), historique quotidien local `studio-historique.json` (gitignoré) pour le delta 7 j, rafraîchi toutes les 6 h avec le ciné. `statsUrl` (endpoint dédié) reste prioritaire si renseignée. Instagram peut bloquer les IP de datacenter : en échec, `[maj] studio en échec` et le pendentif garde/masque son contenu
- **Ciné** : pages horaires AlloCiné des cinémas de `cinemas` (codes `salle_gen_csalle`), extraction regex des notes presse/spectateurs, avec les salles où le film passe (noms joints par « + », « N salles » au-delà de 2). Mix : 2 meilleures nouveautés + 2 meilleures reprises (détection par mention « reprise » ou année ≤ N-2 dans l'entête de carte, année affichée pour les classiques), complété si une catégorie manque. Rafraîchi toutes les 6 h. Scraping fragile par nature : en cas de changement de structure allociné, `[maj] ciné en échec` et l'arche garde son dernier contenu
- **Spotify** : Web API, compte Premium requis. Refresh token obtenu une fois via `auth-spotify.js` lancé sur le PC (redirect URI imposée `http://127.0.0.1:8888/callback`, Spotify exige HTTPS ou loopback). Pas d'API Jam publique : on contrôle la lecture du compte hôte, ce qui revient au même à la maison.

## état d'avancement

Fait et testé en local : serveur complet, template final, replis d'erreur par source, redirection, endpoints, auth Spotify script, README pas à pas.

Reste à faire (avec l'utilisateur) :

1. `cp config.example.json config.json` et tout remplir
2. URL ICS du calendrier iCloud partagé (à rendre public depuis l'app Calendrier)
3. App Spotify + `node auth-spotify.js ID SECRET` sur le PC → refreshToken
4. Clé football-data.org, vérifier les ids de `equipesFoot` (521/98/64/773) et les abréviations ESPN de `nba`
5. `statsUrl` + adapter les 2 lignes de `majStudio()` au format réel
6. Déploiement VPS : `npm install`, service systemd (unité fournie dans le README), ouvrir le port dans le pare-feu Hostinger
7. iPad : ouvrir l'URL, "Sur l'écran d'accueil", verrouillage auto jamais, luminosité auto off, accès guidé

## backlog d'idées (non engagé)

- Rotation de contenus dans l'arche centrale selon l'heure (matin : agenda, soir : sport)
- Classement MPP "La Fricadelle Compétition" pendant les compétitions
- yum.ines via l'API Graph de Meta (chiffre exact fiable, remplace le scraping bloqué)

## comment tester sans iPad

`node server.js` puis ouvrir `http://localhost:8017/<basePath>/` dans un navigateur : la page s'affiche à l'échelle. Les sources en échec loggent `[maj] … en échec` et gardent leur dernier contenu, le serveur ne crashe jamais pour une source morte.
