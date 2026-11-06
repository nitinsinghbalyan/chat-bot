#!/usr/bin/env bash
# One-time setup of the Seller assistants server on Ubuntu 24.04 (Oracle Cloud Always Free; ARM or x86).
# Safe to run again (e.g. after changing SITE_HOST to your own domain). Step by step: docs/DEPLOY_ORACLE.md
#
#   Public repo:   curl -fsSL https://raw.githubusercontent.com/nitinsinghbalyan/chat-bot/main/deploy/oracle/setup.sh -o setup.sh
#                  sudo bash setup.sh
#   Private repo:  sudo REPO_URL=git@github.com:nitinsinghbalyan/chat-bot.git bash setup.sh
#                  (it shows a deploy key to add on GitHub, then waits)
#
# What it does: installs Node 22, git and Caddy; creates the user "bot", /var/data and
# /opt/seller-assistants; opens ports 80 and 443; asks for the secrets once (kept in
# /etc/seller-assistants.env); builds main; starts the bot, HTTPS, the 2-minute auto-deploy and the
# nightly backup.
set -euo pipefail
REPO_URL=${REPO_URL:-https://github.com/nitinsinghbalyan/chat-bot.git}
BRANCH=${BRANCH:-main}
BASE=/opt/seller-assistants
DATA=/var/data
ENV_FILE=/etc/seller-assistants.env
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ask() { local v; read -r -p "$1" v </dev/tty; printf '%s' "$v"; }
ask_secret() { local v; read -r -s -p "$1" v </dev/tty; echo >/dev/tty; printf '%s' "$v"; }
[[ $(id -u) -eq 0 ]] || { echo "Run it with sudo: sudo bash setup.sh"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

say "Packages: Node 22, git, build tools, Caddy"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git build-essential python3 debian-keyring debian-archive-keyring apt-transport-https >/dev/null
if ! command -v node >/dev/null || [[ $(node -v) != v22.* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt >/etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
echo "node $(node -v), $(caddy version | cut -d' ' -f1) caddy"

say "Firewall: allow web traffic (ports 80 and 443)"
# Oracle's Ubuntu image rejects everything but SSH in iptables; the VCN security list must allow them too.
for port in 80 443; do
  iptables -C INPUT -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null ||
    iptables -I INPUT -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT
done
if command -v netfilter-persistent >/dev/null; then netfilter-persistent save >/dev/null 2>&1 || true; fi

say "User bot, data folder $DATA, app folder $BASE"
id bot >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/bot --shell /usr/sbin/nologin bot
install -d -o bot -g bot -m 750 "$DATA" "$BASE" "$BASE/releases"
install -d -m 755 /var/lib/seller-assistants

as_bot() { runuser -u bot -- env HOME=/home/bot "$@"; }
if [[ ! -d $BASE/repo/.git ]]; then
  if [[ $REPO_URL == git@* ]]; then
    say "Deploy key (private repo)"
    install -d -o bot -g bot -m 700 /home/bot/.ssh
    [[ -f /home/bot/.ssh/id_ed25519 ]] || as_bot ssh-keygen -q -t ed25519 -N "" -C "seller-assistants-server" -f /home/bot/.ssh/id_ed25519
    ssh-keyscan -t ed25519 github.com 2>/dev/null >>/home/bot/.ssh/known_hosts && chown bot:bot /home/bot/.ssh/known_hosts
    echo "On GitHub: the repo → Settings → Deploy keys → Add deploy key. Title: Oracle server. Key:"
    echo
    cat /home/bot/.ssh/id_ed25519.pub
    echo
    ask "Leave 'Allow write access' unticked, press Add key, then press Enter here… " >/dev/null
  fi
  say "Getting the code"
  as_bot git clone --quiet --branch "$BRANCH" "$REPO_URL" "$BASE/repo"
fi
KIT=$BASE/repo/deploy/oracle

say "Settings: $ENV_FILE"
[[ -f $ENV_FILE ]] || install -m 600 -o root -g root "$KIT/env.example" "$ENV_FILE"
get() { (grep -E "^$1=" "$ENV_FILE" || true) | tail -1 | cut -d= -f2-; }
put() {
  local tmp; tmp=$(mktemp)
  grep -vE "^$1=" "$ENV_FILE" >"$tmp" || true
  printf '%s=%s\n' "$1" "$2" >>"$tmp"
  install -m 600 -o root -g root "$tmp" "$ENV_FILE" && rm -f "$tmp"
}
if [[ -z $(get SITE_HOST) ]]; then
  ip=$(curl -fsS --max-time 10 https://api.ipify.org || curl -fsS --max-time 10 https://ifconfig.me)
  put SITE_HOST "${ip//./-}.sslip.io"
fi
[[ -n $(get ANTHROPIC_API_KEY) ]] || put ANTHROPIC_API_KEY "$(ask_secret 'Anthropic API key (sk-ant-…, from Render → Environment): ')"
while [[ $(get ADMIN_PASSWORD | wc -c) -lt 9 ]]; do put ADMIN_PASSWORD "$(ask_secret 'Admin password for /admin (8+ characters, can be the one on Render): ')"; done
if [[ -z $(get LANGFUSE_PUBLIC_KEY) ]]; then
  pk=$(ask 'Langfuse public key (pk-lf-…; press Enter to skip tracing): ')
  if [[ -n $pk ]]; then
    put LANGFUSE_PUBLIC_KEY "$pk"
    put LANGFUSE_SECRET_KEY "$(ask_secret 'Langfuse secret key (sk-lf-…): ')"
    put LANGFUSE_BASE_URL "$(ask 'Langfuse base URL (Enter for Langfuse Cloud): ')"
  fi
fi
SITE_HOST=$(get SITE_HOST)
echo "Address: https://$SITE_HOST"

say "Caddy (HTTPS for $SITE_HOST)"
sed "s/^SITE_HOST {/$SITE_HOST {/" "$KIT/Caddyfile" >/etc/caddy/Caddyfile
systemctl enable --quiet caddy
systemctl reload caddy 2>/dev/null || systemctl restart caddy

say "Services: bot, auto-deploy, nightly backup"
install -m 755 "$KIT/deploy.sh" /usr/local/sbin/seller-assistants-deploy
install -m 755 "$KIT/backup.sh" /usr/local/sbin/seller-assistants-backup
install -m 644 "$KIT"/seller-assistants*.service "$KIT"/seller-assistants*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --quiet seller-assistants

say "Building main (a few minutes the first time)"
/usr/local/sbin/seller-assistants-deploy --force
systemctl enable --now --quiet seller-assistants-deploy.timer seller-assistants-backup.timer

say "Done"
echo "Bot and admin: https://$SITE_HOST/admin (the HTTPS certificate can take a minute)"
echo "Status:        systemctl status seller-assistants   ·   logs: journalctl -u seller-assistants -f"
echo "Deploys:       merge to main; the server picks it up within 2 minutes (journalctl -u seller-assistants-deploy)"
echo "Next:          on Render's /admin press Download backup, then on the new /admin use Restore from a backup."
