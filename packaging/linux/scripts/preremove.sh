#!/bin/sh
# ==============================================================================
# preremove for the storagebase-studio .deb/.rpm packages (nfpm scripts:).
#
# Stops and disables the service only on full removal, never on upgrade:
# deb prerm receives "remove" | "upgrade" | ...; rpm %preun receives 0
# (uninstall) or >= 1 (upgrade). Without this, "apt remove" / "rpm -e"
# would delete /usr/lib/storagebase-studio and the unit while the old server
# keeps running from deleted files until reboot.
# ==============================================================================
set -e

case "${1:-}" in
  remove | 0)
    if [ -d /run/systemd/system ]; then
      systemctl stop storagebase-studio.service >/dev/null 2>&1 || true
      systemctl disable storagebase-studio.service >/dev/null 2>&1 || true
    fi
    ;;
esac

exit 0
