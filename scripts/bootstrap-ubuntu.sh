#!/usr/bin/env bash
set -euo pipefail
sudo apt update
sudo apt install -y git curl build-essential docker.io docker-compose-plugin nodejs npm
sudo systemctl enable --now docker
echo
echo "If Docker says permission denied, run:"
echo "  sudo usermod -aG docker \$USER"
echo "then log out/in (or: newgrp docker)"
