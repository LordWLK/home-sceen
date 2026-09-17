#!/bin/bash
# écran maison · mode kiosque sur raspberry pi (raspberry pi os trixie, bureau labwc)
#
# à lancer sur le pi, en tant qu'utilisateur du bureau (pas avec sudo) :
#   bash kiosque.sh http://IP:8017/chemin-secret/
#
# ce que ça fait (relançable sans risque, chaque étape est idempotente) :
#   1. vérifie chromium (l'installe s'il manque)
#   2. démarrage sur le bureau avec connexion automatique
#   3. plus de mise en veille de l'écran (labwc : ligne swayidle retirée)
#   4. wi-fi : économie d'énergie coupée (évite les décrochages)
#   5. écrit ~/ecran-kiosque.sh (chromium plein écran, relancé s'il tombe)
#   6. l'ajoute au démarrage de la session (~/.config/labwc/autostart)
# puis : sudo reboot

set -u

URL="${1:-}"
if [ -z "$URL" ]; then
  echo "usage : bash kiosque.sh http://IP:8017/chemin-secret/"
  exit 1
fi
if [ "$(id -u)" -eq 0 ]; then
  echo "à lancer sans sudo, en tant que l'utilisateur du bureau (le script appelle sudo lui-même)"
  exit 1
fi
# normalise : on retire un éventuel ?..., on force la barre oblique finale,
# puis ?kiosque : la page masque alors le curseur (écran non tactile)
URL="${URL%%\?*}"
URL="${URL%/}/?kiosque"

ok()    { printf '  [ok] %s\n' "$1"; }
info()  { printf '  ...  %s\n' "$1"; }
etape() { printf '\n== %s ==\n' "$1"; }

etape "1 · chromium"
BIN=""
for c in chromium chromium-browser; do
  if command -v "$c" >/dev/null 2>&1; then BIN="$c"; break; fi
done
if [ -z "$BIN" ]; then
  info "absent, installation (quelques minutes)"
  sudo apt-get update -qq && sudo apt-get install -y -qq chromium || { echo "échec de l'installation de chromium"; exit 1; }
  BIN=chromium
fi
ok "$BIN · $("$BIN" --version 2>/dev/null | head -1)"

etape "2 · démarrage sur le bureau, connexion automatique"
if sudo raspi-config nonint do_boot_behaviour B4 >/dev/null 2>&1; then
  ok "bureau + connexion automatique ($USER)"
else
  info "raspi-config indisponible, réglage sauté"
fi

etape "3 · pas de mise en veille de l'écran"
sudo raspi-config nonint do_blanking 1 >/dev/null 2>&1 || true
for f in "$HOME/.config/labwc/autostart" /etc/xdg/labwc/autostart; do
  if [ -f "$f" ] && grep -q swayidle "$f"; then
    sudo sed -i '/swayidle/d' "$f"
    info "ligne swayidle retirée de $f"
  fi
done
ok "veille désactivée"

etape "4 · wi-fi sans économie d'énergie"
if command -v nmcli >/dev/null 2>&1; then
  CONN="$(nmcli -t -f NAME,TYPE connection show --active 2>/dev/null | awk -F: '$2=="802-11-wireless"{print $1; exit}')"
  if [ -n "$CONN" ]; then
    if sudo nmcli connection modify "$CONN" wifi.powersave 2 >/dev/null 2>&1; then
      ok "économie d'énergie coupée sur « $CONN »"
    else
      info "réglage wi-fi impossible (pas grave)"
    fi
  else
    info "pas de wi-fi actif (câble ?), rien à faire"
  fi
else
  info "nmcli absent, réglage sauté"
fi

etape "5 · lanceur"
LANCEUR="$HOME/ecran-kiosque.sh"
cat > "$LANCEUR" <<FIN
#!/bin/bash
# écran maison · lancé à l'ouverture de la session (labwc autostart)
# attend que le serveur réponde (2 min max), lance chromium plein écran,
# et le relance s'il tombe. réinstallation : deploy/pi/kiosque.sh
URL='$URL'
BIN='$BIN'
for i in \$(seq 1 60); do
  curl -fsS -m 3 -o /dev/null "\$URL" && break
  sleep 2
done
while true; do
  "\$BIN" --kiosk --incognito --noerrdialogs --disable-infobars --no-first-run \\
    --disable-session-crashed-bubble --disable-features=Translate,TranslateUI \\
    --overscroll-history-navigation=0 --disable-pinch --password-store=basic \\
    --check-for-update-interval=31536000 --start-maximized \\
    --ozone-platform-hint=auto "\$URL"
  sleep 3
done
FIN
chmod +x "$LANCEUR"
ok "$LANCEUR"

etape "6 · démarrage automatique avec la session"
if pgrep -x wayfire >/dev/null 2>&1 && ! command -v labwc >/dev/null 2>&1; then
  # ancien bureau wayfire (bookworm) : section [autostart] de wayfire.ini
  WF="$HOME/.config/wayfire.ini"
  [ -f "$WF" ] || cp /etc/wayfire/template.ini "$WF" 2>/dev/null || touch "$WF"
  sed -i '/^ecran *=/d' "$WF"
  grep -q '^\[autostart\]' "$WF" || printf '\n[autostart]\n' >> "$WF"
  sed -i "s#^\[autostart\]#[autostart]\necran = $LANCEUR#" "$WF"
  ok "$WF (wayfire)"
else
  AST="$HOME/.config/labwc/autostart"
  mkdir -p "$(dirname "$AST")"
  touch "$AST"
  sed -i '\#ecran-kiosque.sh#d' "$AST"
  echo "$LANCEUR &" >> "$AST"
  ok "$AST"
  if ! pgrep -x labwc >/dev/null 2>&1; then
    info "attention : le bureau labwc ne tourne pas en ce moment ; après reboot, vérifier que le pi démarre bien sur le bureau"
  fi
fi

etape "terminé"
info "page affichée : $URL"
info "pour appliquer : sudo reboot"
info "état du kiosque à tout moment : bash etat.sh"
