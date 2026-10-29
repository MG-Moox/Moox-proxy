#!/usr/bin/env bash
# One-time setup of Moox on a fresh Ubuntu server (Oracle Cloud Always Free or any VPS).
# Run it ON the server:   curl -fsSL https://raw.githubusercontent.com/MG-Moox/Moox-proxy/main/deploy/oracle/setup.sh | bash
# It asks for your domain and your Turso details. Type the secrets here on the
# server, never into a chat. Running it again later is safe (it updates Moox).
set -euo pipefail

REPO="https://github.com/MG-Moox/Moox-proxy.git"
DIR="/opt/moox"

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -E bash "$0" "$@"
fi

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "1/6 Updating the server"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl ca-certificates iptables-persistent

say "2/6 Adding swap (the free servers have little memory)"
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "3/6 Installing Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

say "4/6 Opening web ports (80 and 443) in the server firewall"
for p in 80 443; do
  iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport "$p" -j ACCEPT
done
netfilter-persistent save >/dev/null 2>&1 || true

say "5/6 Getting Moox"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone "$REPO" "$DIR"
fi
cd "$DIR/deploy/oracle"

if [ ! -f .env ]; then
  say "Your details"
  echo "Domain: the address people will visit, e.g. mymoox.duckdns.org (it must already point at this server)."
  read -r -p "Domain: " DOMAIN </dev/tty
  read -r -p "TURSO_DATABASE_URL (starts with libsql://): " TURSO_URL </dev/tty
  read -r -s -p "TURSO_AUTH_TOKEN (hidden): " TURSO_TOKEN </dev/tty; echo
  read -r -s -p "ADMIN_PASSWORD (10+ characters, hidden): " ADMIN_PW </dev/tty; echo
  umask 077
  cat > .env <<ENVEOF
DOMAIN=$DOMAIN
TURSO_DATABASE_URL=$TURSO_URL
TURSO_AUTH_TOKEN=$TURSO_TOKEN
ADMIN_PASSWORD=$ADMIN_PW
ENVEOF
  chmod 600 .env
  echo "Saved to $DIR/deploy/oracle/.env (only root can read it)."
else
  echo "Using the existing .env"
fi

say "6/6 Starting Moox (the first build takes a few minutes)"
docker compose up -d --build
docker image prune -f >/dev/null 2>&1 || true

# A handy command for later:  sudo moox-update
cat > /usr/local/bin/moox-update <<'UPEOF'
#!/usr/bin/env bash
set -e
git -C /opt/moox pull --ff-only
cd /opt/moox/deploy/oracle
docker compose up -d --build
docker image prune -f >/dev/null 2>&1 || true
echo "Moox updated."
UPEOF
chmod +x /usr/local/bin/moox-update

DOMAIN_SHOWN=$(grep '^DOMAIN=' .env | cut -d= -f2-)
say "Done"
echo "Open https://$DOMAIN_SHOWN in a few minutes (the certificate is made on first visit)."
echo "To update Moox later:   sudo moox-update"
echo "To see logs:            cd $DIR/deploy/oracle && sudo docker compose logs -f"
