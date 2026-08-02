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
- Ménage du jour : ligne compacte sous la date (1 personne + ses tâches, week-end « ensemble »), tactile → écran de détail plein écran ; les arches sont tactiles aussi : olive → agenda (semaine navigable ‹ ›), sable → sport (multi-jours), terracotta → ciné (4 colonnes une par cinéma, sélecteur aujourd'hui/demain/surlendemain, séances horaires par jour)
- Navigation multi-vues côté client (`.vue`, fonction `montrer(id)`) : chaque écran de détail a un « ‹ accueil », et retour automatique à l'écran principal après 5 min sans interaction
- **Mode nuit calé sur le soleil** (classe `nuit` sur body, palettes assombries définies dans le CSS) : bornes lever/coucher fournies par Open-Meteo en minutes locales via `/contenu` (`soleil`), repli 21 h → 7 h tant que la première synchro n'est pas arrivée ; bascule en fondu (transitions CSS 1 s) ; les zones rafraîchies apparaissent en fondu léger (0,4 s, seulement si le contenu change)
- Typo : titres d'arches en Georgia italique, labels en petites capitales espacées, capitalisation française (pas de Title Case), pas de tirets cadratins dans les textes

## architecture

Un seul process Node (`server.js`), une seule dépendance (`node-ical`).

- Cache en mémoire, pas de base de données
- Données (météo, agenda, sport, studio) rafraîchies toutes les 2 min via `setInterval` ; Spotify toutes les 5 s — **ne pas descendre sous 5 s** : à 2 s l'API punit par des 429 avec Retry-After de 90 min et plus (tolérance : la capsule n'est vidée qu'après 10 échecs consécutifs, et le Retry-After est respecté)
- La page est assemblée à chaque GET depuis `template.html` par remplacement de slots : `{{METEO}}`, `{{AGENDA_AUJ}}`, `{{AGENDA_VENIR}}`, `{{SPORT_ITEMS}}`, `{{STUDIO_ITEMS}}`, `{{CINEMA_ITEMS}}`, `{{MENAGE_COMPACT}}`, `{{MENAGE_CLASS}}`, `{{MENAGE_PLANNING}}`, `{{MUSIC_CLASS}}`, `{{MUSIC_TITLE}}`, `{{MUSIC_ARTIST}}`
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

- **Météo** : Open-Meteo, gratuit sans clé (2 jours de prévision), codes météo mappés en libellés FR. Ligne détail : mini/maxi du jour. Ligne conseil (Georgia italique, sous la météo) : phrase amicale et tutoiement, format « info · geste », l'heure toujours présente (« averses vers 17 h · prends le parapluie »). Fonction pure `conseilMeteo(v)`, déterministe (pas d'aléatoire : la zone clignoterait au poll). Selon l'heure de Paris — matin → la journée (parapluie/chaleur ≥ 30°/petite laine ≤ 10°), après-midi → la soirée (parapluie, pull si ≤ 16° ou grosse chute et ≤ 18°), soir → fin de soirée puis demain (parapluie au départ, volets si ≥ 30°, couvre-toi si chute ≥ 6°). Seuil pluie proba ≥ 50 %
- **Santé des sources** : chaque `maj*` horodate sa réussite dans `sante` ; `sourcesFigees()` liste celles dépassant leur seuil (16 min pour météo/agenda/sport, 14 h pour ciné/studio), affichées discrètement en haut à gauche. Initialisées « fraîches » au démarrage
- **Agenda** : calendriers iCloud publiés (URL ICS `webcal://` → `https://`), récurrences gérées par node-ical (`rrule.between`), fenêtre de 7 jours coupée en deux sections : « aujourd'hui » (2 max, heure seule) et « à venir » (2 max, libellés relatifs "demain 18 h", "lun 27 · 19 h 30"). Multi-calendriers via `config.agendas` [{url, qui}] (repli sur `icsUrl` seul) : maison + persos fusionnés chronologiquement partout, chargés en `Promise.allSettled` (un calendrier mort ne bloque pas les autres, échec global seulement si tous échouent). **L'arche n'affiche que `maison`** ; les événements perso ne s'y montrent que s'ils sont épinglés à la main : dans la vue semaine, toucher un événement à pastille bascule son épinglage (endpoint `/agenda/epingle?k=`, clé = ms de début + `|` + titre, persistée dans `epingles.json` gitignoré, purge à 45 j). Un événement épinglé porte « · à l'accueil » et un bord renforcé dans la semaine, et apparaît dans l'arche avec son suffixe `· prénom`. Signatures : suffixe texte dans l'arche, pastille couleur ménage (olive Antoine / terracotta Inès, initiale du `qui`) dans la vue semaine ; `maison` reste nu. Colonnes de la vue semaine à défilement interne (12 événements max par jour), en-tête de jour collant (`position:sticky`, repli gracieux iOS 9)
- **Sport** : trois sources mélangées puis triées par date, 4 lignes max dans l'arche. Foot via football-data.org v4 si `footballDataKey` renseignée (équipes dans `equipesFoot` : 521 losc, 98 milan, 64 liverpool, 773 france, **ids à vérifier une fois** ; amicaux et sélections hors tournois absents de l'offre gratuite) — une requête par équipe sur une fenêtre -8 j → +70 j (limite api 10 req/min) qui rapporte à la fois les matchs à venir (3 max/équipe) et les **résultats** (`resultat:true`, score `fullTime`, titre "losc 2-1 lens") ; le plus récent ouvre l'arche avec un libellé passé ("hier", "sam 26"), et le détail a une section « derniers résultats ». Résultats foot uniquement (nba/ufc à venir si besoin). NBA (`nba` : phx suns, ny knicks) via l'API publique ESPN sans clé. MMA (`config.mma`, défaut ufc + pfl, même API ESPN) : **tous les événements** des ligues suivies s'affichent, titre = tête d'affiche du libellé calendrier ("ufc 324 · makhachev-gaethje") ; un combattant de `mmaFrancais` (repli `ufcFrancais`, comparaison sans accents) à la carte est signalé après la date/le badge s'il n'est pas déjà dans le titre. KSW/ARES/Hexagone : pas d'api fiable → entrées manuelles datées d'`events.json` (`{date, titre, comp}`) fusionnées au flux ; les entrées sans date restent le repli global. `debug-mma.js` sonde les ligues ESPN (libellés + cartes) pour calibrer
- **Studio** : abonnés du profil Instagram public de `instagram` (regex `edge_followed_by`/`follower_count`, repli sur le og:description arrondi), historique quotidien local `studio-historique.json` (gitignoré) pour le delta 7 j, rafraîchi toutes les 6 h avec le ciné. `statsUrl` (endpoint dédié) reste prioritaire si renseignée. Instagram peut bloquer les IP de datacenter : en échec, `[maj] studio en échec` et le pendentif garde/masque son contenu
- **Ménage** : roulement fixe défini dans `config.menage` (`depart` = lundi de la Semaine 1, `semaines` = liste de 6 semaines, chacune 5 jours individuels [qui, tâche] + `we` à deux). Le serveur déplie en cycle de 42 jours et calcule où on en est via `joursDepuis(depart)`. Calcul local, aucun réseau. Affichage : ligne compacte (aujourd'hui) + planning 3 semaines (dernière/actuelle/prochaine)
- **Ciné** : pages horaires AlloCiné des cinémas de `cinemas` (codes `salle_gen_csalle`), extraction regex des notes presse/spectateurs, avec les salles où le film passe (noms joints par « + », « N salles » au-delà de 2). Mix (arche) : 2 meilleures nouveautés + 2 meilleures reprises (détection par mention « reprise » ou année ≤ N-2 dans l'entête de carte, année affichée pour les classiques), complété si une catégorie manque. Écran de détail : la page `.html` d'un cinéma porte plusieurs jours de séances (en pratique aujourd'hui + demain), extraites des attributs `data-showtime-time` (ISO déjà en heure de Paris) et regroupées par date. Le serveur n'affiche que les jours réellement présents (fenêtre aujourd'hui → +6, 3 max), une colonne par cinéma triée par note ; le sélecteur de jour bascule côté client sans refetch. Une seule requête par cinéma (pas d'url `/d-N/` : elle renvoie 404). Colonnes à défilement interne (les longues listes ne débordent pas de l'écran). `debug-cine.js` sonde les urls et rapporte les dates de séances réellement servies. Rafraîchi toutes les 6 h. Scraping fragile par nature : en cas de changement de structure allociné, `[maj] ciné en échec` et l'arche garde son dernier contenu
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
