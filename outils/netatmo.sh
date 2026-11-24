#!/bin/bash
# écran maison · branche le thermostat netatmo
#   bash outils/netatmo.sh
# demande les trois valeurs de l'app créée sur dev.netatmo.com (saisie masquée :
# rien ne s'affiche, c'est normal), les range dans config.json, redémarre le
# service puis lance le diagnostic. à relancer tel quel si on régénère un jeton.
set -u
cd "$(dirname "$0")/.." || exit 1
echo "colle chaque valeur puis appuie sur entrée (rien ne s'affiche, c'est voulu)"
read -rsp "client id : " CI; echo
read -rsp "client secret : " CS; echo
read -rsp "refresh token : " RT; echo
CI="$CI" CS="$CS" RT="$RT" node -e '
const fs = require("fs"), f = "config.json", e = process.env;
const n = { clientId: e.CI.trim(), clientSecret: e.CS.trim(), refreshToken: e.RT.trim() };
if (!n.clientId || !n.clientSecret || !n.refreshToken) { console.log("une valeur est vide : rien n’a changé"); process.exit(1); }
const c = JSON.parse(fs.readFileSync(f, "utf8"));
c.netatmo = Object.assign({}, c.netatmo, n);
fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
console.log("accès netatmo enregistrés dans config.json");
' || exit 1
if [ "$(id -u)" -eq 0 ]; then systemctl restart ecran-maison; else sudo systemctl restart ecran-maison; fi && echo "service redémarré"
echo
node debug-netatmo.js
