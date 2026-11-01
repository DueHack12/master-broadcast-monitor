#!/bin/bash
# Double-click to start Broadcast Monitor on a Mac.
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed. Download the LTS installer from https://nodejs.org,"
  echo "  run it, then double-click this file again."
  echo
  read -n 1 -s -r -p "  Press any key to close."
  exit 1
fi

if [ "$(node -p "process.versions.node.split('.')[0]")" -lt 18 ]; then
  echo "  Node.js is too old - Broadcast Monitor needs Node 18 or newer."
  read -n 1 -s -r -p "  Press any key to close."
  exit 1
fi

# A git checkout can update itself. Ask, and start anyway after 15 seconds.
if [ -d .git ] && command -v git >/dev/null 2>&1 && git fetch --quiet 2>/dev/null; then
  BEHIND=$(git rev-list --count HEAD..@{u} 2>/dev/null || echo 0)
  if [ "$BEHIND" != "0" ]; then
    echo
    read -t 15 -n 1 -p "  An update is available ($BEHIND new commits). Update now? [y/N] " yn
    echo
    if [ "$yn" = "y" ] || [ "$yn" = "Y" ]; then git pull --ff-only || echo "  Update failed - starting the current version."; fi
  fi
fi

node server.js "$@"
