#!/usr/bin/env bash
set -euo pipefail

echo "========================================================"
echo "  Shufersal Telegram Bot - Oracle Cloud VM Setup (IL)   "
echo "========================================================"

# 1. Add 2GB Swap if VM has <= 2.5GB RAM (essential for Oracle E2.1.Micro 1GB RAM VMs running Chromium)
TOTAL_MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$TOTAL_MEM_MB" -le 2500 ] && [ ! -f /swapfile ]; then
  echo "[1/4] Detected ${TOTAL_MEM_MB}MB RAM. Creating 2GB swapfile so Chromium runs smoothly..."
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  if ! grep -q '/swapfile' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  fi
  echo "      Swap configured."
else
  echo "[1/4] Memory/Swap check OK (${TOTAL_MEM_MB}MB RAM)."
fi

# 2. Install Docker + Docker Compose if missing
if ! command -v docker >/dev/null 2>&1; then
  echo "[2/4] Installing Docker Engine & Compose plugin..."
  curl -fsSL https://get.docker.com | sudo sh
  sudo systemctl enable --now docker
  sudo usermod -aG docker "$USER" || true
else
  echo "[2/4] Docker is already installed."
fi

# 3. Interactive .env creation if missing
if [ ! -f .env ]; then
  echo "[3/4] Configuring .env credentials..."
  read -r -p "Enter TELEGRAM_BOT_TOKEN (from @BotFather): " TG_TOKEN
  read -r -p "Enter SHUFERSAL_USERNAME (email or ID): " SHUF_USER
  read -r -s -p "Enter SHUFERSAL_PASSWORD: " SHUF_PASS
  echo ""
  read -r -p "Enter HAZI_HINAM_USERNAME (optional, Enter for guest comparison): " HAZI_USER
  HAZI_PASS=""
  if [ -n "$HAZI_USER" ]; then
    read -r -s -p "Enter HAZI_HINAM_PASSWORD: " HAZI_PASS
    echo ""
  fi
  read -r -p "Enter SUPER_HAVIV_USERNAME (optional, Enter for guest comparison): " HAVIV_USER
  HAVIV_PASS=""
  if [ -n "$HAVIV_USER" ]; then
    read -r -s -p "Enter SUPER_HAVIV_PASSWORD: " HAVIV_PASS
    echo ""
  fi
  read -r -p "Enter VICTORY_USERNAME (optional, Enter for guest comparison): " VICTORY_USER
  VICTORY_PASS=""
  if [ -n "$VICTORY_USER" ]; then
    read -r -s -p "Enter VICTORY_PASSWORD: " VICTORY_PASS
    echo ""
  fi
  read -r -p "Enter GEMINI_API_KEY (from aistudio.google.com): " GEMINI_KEY
  read -r -p "Enter ALLOWED_CHAT_IDS (optional, press Enter to set later via /id): " CHAT_IDS
  read -r -p "Enter ADMIN_USER_IDS (optional, press Enter to allow Telegram Group Admins): " ADMIN_IDS

  cat > .env <<EOF
TELEGRAM_BOT_TOKEN=${TG_TOKEN}
ALLOWED_CHAT_IDS=${CHAT_IDS}
ADMIN_USER_IDS=${ADMIN_IDS}
ENABLED_STORES=shufersal,hazi_hinam,super_haviv,victory
SHUFERSAL_USERNAME=${SHUF_USER}
SHUFERSAL_PASSWORD=${SHUF_PASS}
HAZI_HINAM_USERNAME=${HAZI_USER}
HAZI_HINAM_PASSWORD=${HAZI_PASS}
SUPER_HAVIV_USERNAME=${HAVIV_USER}
SUPER_HAVIV_PASSWORD=${HAVIV_PASS}
VICTORY_USERNAME=${VICTORY_USER}
VICTORY_PASSWORD=${VICTORY_PASS}
GEMINI_API_KEY=${GEMINI_KEY}
GEMINI_MODEL=gemini-2.5-flash
HEADLESS=true
DATA_DIR=/app/data
AUTO_REMOVE_OUT_OF_STOCK=true
LOG_LEVEL=info
EOF
  chmod 600 .env
  echo "      Saved .env securely (chmod 600)."
else
  echo "[3/4] Found existing .env file."
fi

# 4. Build and start 24/7 container
echo "[4/4] Building and starting Shufersal Telegram Bot container..."
mkdir -p data
sudo chown -R 1000:1000 data
sudo docker compose up -d --build

echo ""
echo "✅ Done! Your bot is now running 24/7 on your Israeli VM."
echo "   • View live logs:   sudo docker compose logs -f"
echo "   • Restart bot:      sudo docker compose restart"
echo "   • Edit settings:    nano .env && sudo docker compose up -d"
