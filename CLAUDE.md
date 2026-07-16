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
- Trois arches en bas : olive `#75815f` (aujourd'hui), sable `#e5d5bd` (à suivre, arche centrale plus haute), terracotta `#b96f45` (studio)
- Horloge Optima en haut à gauche, date Georgia italique dessous, météo en haut à droite
- Capsule musique d'encre en haut à droite (vinyle CSS remplacé par la pochette quand elle charge), masquée via la classe `off` quand rien ne joue
- **Mode nuit automatique 21 h → 7 h** (classe `nuit` sur body, palettes assombries définies dans le CSS)
- Typo : titres d'arches en Georgia italique, labels en petites capitales espacées, capitalisation française (pas de Title Case), pas de tirets cadratins dans les textes

## architecture

Un seul process Node (`server.js`), une seule dépendance (`node-ical`).

- Cache en mémoire, pas de base de données
- Données (météo, agenda, sport, studio) rafraîchies toutes les 5 min via `setInterval` ; Spotify toutes les 30 s
- La page est assemblée à chaque GET depuis `template.html` par remplacement de slots : `{{METEO}}`, `{{AGENDA_ITEMS}}`, `{{SPORT_ITEMS}}`, `{{STUDIO_ITEMS}}`, `{{MUSIC_CLASS}}`, `{{MUSIC_TITLE}}`, `{{MUSIC_ARTIST}}`
- Côté iPad : meta refresh complet toutes les 10 min + poll XHR `musique/etat` toutes les 30 s (URLs relatives, d'où la redirection 301 qui force la barre oblique finale sur `basePath`)
- Fuseau : tout est formaté en `Europe/Paris` via `Intl` côté serveur (le VPS peut être en UTC)

### endpoints (tous sous `basePath`)

- `GET /` page assemblée
- `GET /musique/etat` JSON `{playing, title, artist}`
- `GET /musique/pause` toggle play/pause
- `GET /musique/suivant` piste suivante
- `GET /musique/pochette` image proxifiée (no-store)

### sources de données

- **Météo** : Open-Meteo, gratuit sans clé, codes météo mappés en libellés FR
- **Agenda** : calendrier iCloud publié (URL ICS `webcal://` → `https://`), récurrences gérées par node-ical (`rrule.between`), 4 prochains événements sur 7 jours, libellés relatifs ("ce soir", "demain 18 h")
- **Sport** : football-data.org v4 si `footballDataKey` renseignée (compétitions WC et FL1 dans l'offre gratuite, LOSC = team id 521 **à vérifier une fois**), sinon repli sur `events.json` édité à la main
- **Studio** : endpoint Netlify du media kit yum.ines (`statsUrl`), lecture tolérante des champs dans `majStudio()` **à adapter au JSON réel**
- **Spotify** : Web API, compte Premium requis. Refresh token obtenu une fois via `auth-spotify.js` lancé sur le PC (redirect URI imposée `http://127.0.0.1:8888/callback`, Spotify exige HTTPS ou loopback). Pas d'API Jam publique : on contrôle la lecture du compte hôte, ce qui revient au même à la maison.

## état d'avancement

Fait et testé en local : serveur complet, template final, replis d'erreur par source, redirection, endpoints, auth Spotify script, README pas à pas.

Reste à faire (avec l'utilisateur) :

1. `cp config.example.json config.json` et tout remplir
2. URL ICS du calendrier iCloud partagé (à rendre public depuis l'app Calendrier)
3. App Spotify + `node auth-spotify.js ID SECRET` sur le PC → refreshToken
4. Optionnel : clé football-data.org, vérifier `loscTeamId`
5. `statsUrl` + adapter les 2 lignes de `majStudio()` au format réel
6. Déploiement VPS : `npm install`, service systemd (unité fournie dans le README), ouvrir le port dans le pare-feu Hostinger
7. iPad : ouvrir l'URL, "Sur l'écran d'accueil", verrouillage auto jamais, luminosité auto off, accès guidé

## backlog d'idées (non engagé)

- Boutons volume dans la capsule musique (endpoints `/musique/volume/+` et `/-`)
- Pochette avec coin "en pause" quand `playing=false` au lieu de masquer
- Rotation de contenus dans l'arche centrale selon l'heure (matin : agenda, soir : sport)
- Classement MPP "La Fricadelle Compétition" pendant les compétitions

## comment tester sans iPad

`node server.js` puis ouvrir `http://localhost:8017/<basePath>/` dans un navigateur : la page s'affiche à l'échelle. Les sources en échec loggent `[maj] … en échec` et gardent leur dernier contenu, le serveur ne crashe jamais pour une source morte.
