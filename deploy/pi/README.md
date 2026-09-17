# kiosque raspberry pi · second écran

Un Raspberry Pi 5 branché sur un écran HDMI affiche la même page que l'iPad, en plein écran, sans curseur ni mise en veille. Chaque écran navigue indépendamment (même serveur, mêmes données).

Deux scripts, à lancer **sur le Pi** :

- `kiosque.sh` : installe le mode kiosque (relançable sans risque)
- `etat.sh` : résume l'état du Pi et du kiosque (à coller dans la conversation pour diagnostiquer)

## 0 · branchements

1. Écran sur le port **HDMI0** du Pi (le micro-HDMI le plus proche de la prise USB-C d'alimentation).
2. Alimenter l'écran, puis le Pi (alim 27 W officielle). Premier démarrage : environ 1 min, la LED verte clignote puis le bureau apparaît.

## 1 · se connecter en ssh (Termius)

Nouvel hôte : adresse `ecran-pi.local`, utilisateur `antoine`, mot de passe choisi dans Raspberry Pi Imager.

Si `ecran-pi.local` ne répond pas : l'adresse IP du Pi se lit dans l'interface Freebox (« périphériques réseau », hôte `ecran-pi`) ; utiliser cette IP à la place.

## 2 · installer le kiosque

```bash
curl -fsSL -o ~/kiosque.sh https://raw.githubusercontent.com/LordWLK/home-sceen/main/deploy/pi/kiosque.sh
curl -fsSL -o ~/etat.sh    https://raw.githubusercontent.com/LordWLK/home-sceen/main/deploy/pi/etat.sh
bash ~/kiosque.sh http://IP-DU-VPS:8017/CHEMIN-SECRET/
sudo reboot
```

Remplacer `IP-DU-VPS` et `CHEMIN-SECRET` par les vraies valeurs (jamais dans ce dépôt public). Le script ajoute lui-même `?kiosque` à l'adresse : c'est ce paramètre qui masque le curseur côté page.

Après le redémarrage, la page s'affiche toute seule. Elle se relance si Chromium tombe, et attend le serveur au démarrage (2 min max) avant de se lancer.

## 3 · vérifier / diagnostiquer

```bash
bash ~/etat.sh
```

Affiche : modèle, système, bureau en cours (attendu : `labwc`), Chromium, kiosque en marche ou non, écran HDMI détecté et sa résolution, contenu de l'autostart, veille, adresse de la page et réponse du serveur.

## dépannage

- **Écran noir au démarrage** : mauvais port HDMI (HDMI0 obligatoire pour l'affichage au boot), ou écran non alimenté.
- **Le bureau apparaît mais pas la page** : `bash ~/etat.sh` → ligne `serveur` doit dire `réponse http 200`. Sinon, l'adresse est fausse ou le Pi n'a pas de réseau.
- **Le curseur reste visible** : l'adresse du lanceur (`~/ecran-kiosque.sh`) doit finir par `?kiosque`. Relancer `kiosque.sh` avec la bonne adresse.
- **L'écran s'éteint après 10 min** : `bash ~/etat.sh` → ligne `veille` doit dire `désactivée`. Sinon relancer `kiosque.sh`.
- **Bandeau « restaurer les pages » ou barre d'adresse** : Chromium n'est pas lancé par le lanceur. Vérifier `~/.config/labwc/autostart` (une ligne `/home/antoine/ecran-kiosque.sh &`).
- **Relancer la page sans redémarrer** : `pkill -f -- --kiosk` (le lanceur la relance en 3 s).

## changer d'adresse plus tard

Relancer simplement `bash ~/kiosque.sh http://…/` avec la nouvelle adresse, puis `sudo reboot`.

## ce que le script règle, pour mémoire

| réglage | comment |
|---|---|
| démarrage sur le bureau, connexion auto | `raspi-config nonint do_boot_behaviour B4` |
| veille écran | `raspi-config nonint do_blanking 1` + suppression de la ligne `swayidle` des autostart labwc |
| wi-fi sans économie d'énergie | `nmcli connection modify <wifi> wifi.powersave 2` |
| lancement | `~/ecran-kiosque.sh &` dans `~/.config/labwc/autostart` (ou `[autostart]` de `wayfire.ini` sur un ancien Bookworm) |
| Chromium | `--kiosk --incognito --noerrdialogs --disable-infobars --no-first-run --disable-session-crashed-bubble …` |
