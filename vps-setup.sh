#!/bin/bash
# ============================================================
# Football Watch Party — VPS Setup (coturn TURN server)
# Run on Ubuntu 22.04: bash vps-setup.sh
# ============================================================
set -e
echo "===== Installing coturn TURN server ====="
sudo apt-get update
sudo apt-get install -y coturn

sudo tee /etc/turnserver.conf > /dev/null <<'CONF'
listening-port=3478
listening-ip=0.0.0.0
external-ip=124.220.81.3
min-port=49152
max-port=65535
verbose
fingerprint
lt-cred-mech
realm=football-watch
user=turnuser:turnpass123
log-file=/var/log/turnserver.log
CONF

sudo sed -i 's/TURNSERVER_ENABLED=0/TURNSERVER_ENABLED=1/' /etc/default/coturn
sudo systemctl enable coturn
sudo systemctl restart coturn

echo "===== Firewall ====="
sudo ufw allow 22/tcp
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 49152:65535/udp
sudo ufw --force enable

echo ""
echo "===== DONE! ====="
echo "Verify: sudo systemctl status coturn"
echo "Test:   sudo ufw status"
