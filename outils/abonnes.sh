#!/bin/bash
# écran maison · met à jour le nombre d'abonnés affiché dans le pendentif (yum.ines)
#   bash outils/abonnes.sh 14250
# instagram bloque l'ip du vps : c'est config.abonnesManuel qui fait foi.
# le service est redémarré aussitôt, sinon il réécrirait config.json avec l'ancienne valeur.
set -u
cd "$(dirname "$0")/.." || exit 1
N="${1:-}"
if ! [[ "$N" =~ ^[0-9]+$ ]] || [ "$N" -eq 0 ]; then
  echo "usage : bash outils/abonnes.sh 14250   (chiffres seulement, sans espace ni point)"
  exit 1
fi
node -e '
const fs = require("fs"), f = "config.json";
const c = JSON.parse(fs.readFileSync(f, "utf8"));
const avant = c.abonnesManuel;
c.abonnesManuel = Number(process.argv[1]);
fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
console.log("abonnés : " + (avant || "rien") + " → " + c.abonnesManuel);
' "$N" || exit 1
if [ "$(id -u)" -eq 0 ]; then systemctl restart ecran-maison; else sudo systemctl restart ecran-maison; fi && echo "service redémarré : le pendentif se met à jour dans la minute"
