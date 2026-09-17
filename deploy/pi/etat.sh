#!/bin/bash
# écran maison · état du kiosque pi, à coller dans la conversation pour diagnostiquer
#   bash etat.sh
# (la sortie contient l'adresse de la page : à ne pas partager publiquement)

p() { printf '%-13s %s\n' "$1" "$2"; }

MODELE="$(tr -d '\0' < /proc/device-tree/model 2>/dev/null || echo '?')"
p "machine"     "$MODELE · $(hostname)"
p "système"     "$(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-?}") · noyau $(uname -r)"
p "démarré"     "depuis $(uptime -p 2>/dev/null | sed 's/^up //')"
p "température" "$(vcgencmd measure_temp 2>/dev/null | cut -d= -f2 || echo '?')"
SSID="$(nmcli -t -f active,ssid dev wifi 2>/dev/null | awk -F: '$1=="yes"{print $2; exit}')"
p "réseau"      "$(hostname -I 2>/dev/null | awk '{print $1}') · wi-fi ${SSID:--}"

if pgrep -x labwc >/dev/null 2>&1; then BUREAU=labwc
elif pgrep -x wayfire >/dev/null 2>&1; then BUREAU=wayfire
elif pgrep -x Xorg >/dev/null 2>&1; then BUREAU=x11
else BUREAU="aucun (pas de session graphique en cours)"; fi
p "bureau"      "$BUREAU"
p "autologin"   "$(grep -s '^autologin-user=' /etc/lightdm/lightdm.conf | cut -d= -f2)"

BIN=""
for c in chromium chromium-browser; do
  if command -v "$c" >/dev/null 2>&1; then BIN="$c"; break; fi
done
if [ -n "$BIN" ]; then p "chromium" "$("$BIN" --version 2>/dev/null | head -1)"; else p "chromium" "absent"; fi
if pgrep -f -- '--kiosk' >/dev/null 2>&1; then p "kiosque" "en marche"; else p "kiosque" "pas lancé"; fi

for c in /sys/class/drm/card*-HDMI*; do
  [ -e "$c" ] || continue
  p "écran" "$(basename "$c" | sed 's/^card[0-9]*-//') · $(cat "$c/status") · $(head -1 "$c/modes" 2>/dev/null || echo 'pas de mode')"
done

AST="$HOME/.config/labwc/autostart"
if [ -f "$AST" ]; then
  p "autostart" "$AST"
  sed 's/^/              /' "$AST"
else
  p "autostart" "absent ($AST)"
fi
if grep -qs swayidle "$AST" /etc/xdg/labwc/autostart 2>/dev/null; then p "veille" "ACTIVE (swayidle présent)"; else p "veille" "désactivée"; fi

L="$HOME/ecran-kiosque.sh"
if [ -f "$L" ]; then
  U="$(grep -m1 '^URL=' "$L" | cut -d"'" -f2)"
  p "page" "$U"
  p "serveur" "réponse http $(curl -s -m 5 -o /dev/null -w '%{http_code}' "$U" 2>/dev/null || echo 'injoignable')"
else
  p "lanceur" "absent (kiosque pas encore installé)"
fi
