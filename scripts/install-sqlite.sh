#!/usr/bin/env bash
set -euo pipefail

# This script installs the SQLite client and necessary build tooling for better-sqlite3.
# It supports Debian/Ubuntu, Fedora/RHEL/CentOS, and Arch Linux.

if [[ $(id -u) -ne 0 ]]; then
  echo "Please run this script as root or with sudo."
  exit 1
fi

install_debian() {
  apt-get update
  apt-get install -y sqlite3 libsqlite3-dev build-essential python3
}

install_fedora() {
  dnf install -y sqlite sqlite-devel gcc-c++ make python3
}

install_arch() {
  pacman -Syu --noconfirm sqlite sqlite-libs base-devel python
}

if command -v apt-get >/dev/null 2>&1; then
  install_debian
elif command -v dnf >/dev/null 2>&1; then
  install_fedora
elif command -v pacman >/dev/null 2>&1; then
  install_arch
else
  echo "Unsupported package manager. Please install sqlite3, libsqlite3-dev, build-essential, and python3 manually."
  exit 1
fi

echo "System SQLite and build dependencies installed."

echo "Installing better-sqlite3 npm package..."
cd "$(dirname "$0")/.."
npm install better-sqlite3

echo "Done. SQLite setup complete."