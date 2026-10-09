#!/usr/bin/env bash
###############################################################################
#
#  DX-Compass - One-click installer for Ubuntu 22.04 / 24.04 (Debian-family)
#
#  This installer is designed to COEXIST with an already running
#  Node-Red-Contesting-Dashboard (or any other Node-RED) instance:
#
#    * Separate userDir   -> own flows, nodes, context (never touches ~/.node-red)
#    * Separate port      -> 5758 (never touches 1880)
#    * Separate service   -> "dx-compass" (never touches "nodered")
#    * Local node_modules -> dependencies installed inside this folder only
#
#  Usage:
#     1) Copy the whole DX-Compass folder to the server, e.g. /opt/dx-compass
#     2) cd /opt/dx-compass
#     3) sudo bash install.sh
#
#  Re-running this script is safe (idempotent).
#
###############################################################################

set -euo pipefail

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #
APP_NAME="dx-compass"
APP_PORT="5758"
SERVICE_NAME="dx-compass"
REQUIRED_NODE_MAJOR=18
NPM_MIRROR="https://registry.npmmirror.com"

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETTINGS_FILE="${APP_DIR}/settings.js"
FLOW_FILE="${APP_DIR}/flow.json"
PACKAGE_FILE="${APP_DIR}/package.json"
RED_JS="${APP_DIR}/node_modules/node-red/red.js"

# --------------------------------------------------------------------------- #
# Output helpers (ASCII only to avoid locale/codepage issues)
# --------------------------------------------------------------------------- #
_c_reset='\033[0m'; _c_blue='\033[1;34m'; _c_green='\033[1;32m'
_c_yellow='\033[1;33m'; _c_red='\033[1;31m'
info()  { echo -e "${_c_blue}[INFO]${_c_reset}  $*"; }
ok()    { echo -e "${_c_green}[ OK ]${_c_reset}  $*"; }
warn()  { echo -e "${_c_yellow}[WARN]${_c_reset}  $*"; }
err()   { echo -e "${_c_red}[FAIL]${_c_reset}  $*" >&2; }
die()   { err "$*"; exit 1; }

# --------------------------------------------------------------------------- #
# Privilege / user handling
# --------------------------------------------------------------------------- #
if [[ ${EUID} -eq 0 ]]; then
    SUDO=""
    if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
        RUN_USER="${SUDO_USER}"
    else
        RUN_USER="dxcompass"   # dedicated system user (created below)
    fi
else
    SUDO="sudo"
    RUN_USER="$(id -un)"
fi
RUN_GROUP="$(id -gn "${RUN_USER}" 2>/dev/null || echo "${RUN_USER}")"
run_as_user() {
    if [[ ${EUID} -eq 0 ]]; then
        local user_home
        user_home="$(getent passwd "${RUN_USER}" | cut -d: -f6)"
        sudo -u "${RUN_USER}" HOME="${user_home}" "$@"
    else
        "$@"
    fi
}

info "DX-Compass installer"
info "App directory : ${APP_DIR}"
info "Service user  : ${RUN_USER}"
info "Listen port   : ${APP_PORT}"
echo

# --------------------------------------------------------------------------- #
# 1. Sanity checks
# --------------------------------------------------------------------------- #
[[ -f "${PACKAGE_FILE}" ]]  || die "package.json not found in ${APP_DIR}"
[[ -f "${SETTINGS_FILE}" ]] || die "settings.js not found in ${APP_DIR}"
[[ -f "${FLOW_FILE}" ]]     || die "flow.json not found in ${APP_DIR}"

if [[ ! -f /etc/os-release ]]; then
    warn "Cannot detect OS (/etc/os-release missing) - continuing anyway."
else
    # shellcheck disable=SC1091
    . /etc/os-release
    case "${ID:-}" in
        ubuntu|debian|linuxmint|pop)
            ok "Detected ${PRETTY_NAME:-$ID}" ;;
        *)
            warn "This script is intended for Ubuntu/Debian (detected: ${ID:-unknown}). Continuing, but apt steps may fail." ;;
    esac
fi

# Port 5758 must be free (unless it is already our own service)
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${APP_PORT}$"; then
    if systemctl list-units --type=service --all 2>/dev/null | grep -q "^${SERVICE_NAME}.service"; then
        warn "Port ${APP_PORT} is in use by the existing ${SERVICE_NAME} service - it will be restarted."
    else
        die "Port ${APP_PORT} is already in use by another program. Free it or edit uiPort in settings.js."
    fi
fi

# Explicitly report that any pre-existing Node-RED will NOT be touched
for existing in nodered node-red; do
    if systemctl list-units --type=service --all 2>/dev/null | grep -qE "^${existing}\.service"; then
        state="$(systemctl is-active "${existing}.service" 2>/dev/null || true)"
        warn "Existing service '${existing}.service' (${state}) detected - it will be left completely untouched."
    fi
done
if [[ -d "${HOME}/.node-red" ]]; then
    warn "Existing ~/.node-red directory detected - DX-Compass does not use it and will not modify it."
fi

# --------------------------------------------------------------------------- #
# 2. System packages (build tools needed by the sqlite native module)
# --------------------------------------------------------------------------- #
info "Installing system packages (ca-certificates, curl, build tools)..."
${SUDO} apt-get update -qq
${SUDO} env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    ca-certificates curl gnupg iproute2 \
    build-essential python3 make g++ >/dev/null
ok "System packages ready"

# --------------------------------------------------------------------------- #
# 3. Node.js (>= 18) - use existing one if present, apt next, NodeSource last
# --------------------------------------------------------------------------- #
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

if command -v node >/dev/null 2>&1 && [[ "$(node_major)" -ge ${REQUIRED_NODE_MAJOR} ]]; then
    ok "Node.js $(node -v) already installed - using it"
else
    info "Node.js >= ${REQUIRED_NODE_MAJOR} not found. Trying Ubuntu repository..."
    ${SUDO} env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs npm >/dev/null || true
fi

if ! command -v node >/dev/null 2>&1 || [[ "$(node_major)" -lt ${REQUIRED_NODE_MAJOR} ]]; then
    warn "apt Node.js is too old/missing. Installing Node.js 20 LTS from NodeSource..."
    curl -fsSL "https://deb.nodesource.com/setup_20.x" | ${SUDO} bash - >/dev/null
    ${SUDO} env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
fi

command -v node >/dev/null 2>&1 || die "Node.js installation failed."
[[ "$(node_major)" -ge ${REQUIRED_NODE_MAJOR} ]] || die "Node.js >= ${REQUIRED_NODE_MAJOR} is required, found $(node -v 2>/dev/null || echo 'none')."
ok "Node.js $(node -v), npm $(npm -v)"
NODE_BIN="$(command -v node)"

# --------------------------------------------------------------------------- #
# 4. Dedicated service user (only when running as root without SUDO_USER)
# --------------------------------------------------------------------------- #
if [[ "${RUN_USER}" == "dxcompass" ]] && ! id "dxcompass" >/dev/null 2>&1; then
    info "Creating dedicated system user 'dxcompass'..."
    ${SUDO} useradd --system --create-home \
        --home-dir /var/lib/dx-compass --shell /usr/sbin/nologin dxcompass
fi

# --------------------------------------------------------------------------- #
# 5. npm dependencies (local node_modules inside the app folder)
# --------------------------------------------------------------------------- #
info "Making ${RUN_USER} the owner of the application folder..."
${SUDO} chown -R "${RUN_USER}:${RUN_GROUP}" "${APP_DIR}"

info "Installing npm dependencies locally (this can take a few minutes)..."
NPM_ARGS=(install --omit=dev --no-audit --no-fund)
if ! run_as_user npm "${NPM_ARGS[@]}" ; then
    warn "Default npm registry failed, retrying with mirror ${NPM_MIRROR} ..."
    run_as_user npm "${NPM_ARGS[@]}" --registry="${NPM_MIRROR}"
fi
[[ -f "${RED_JS}" ]] || die "node-red binary not found after npm install (${RED_JS})."
ok "npm dependencies installed"

# --------------------------------------------------------------------------- #
# 6. systemd service (fully isolated from any other Node-RED instance)
# --------------------------------------------------------------------------- #
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
info "Writing systemd unit ${UNIT_FILE} ..."
${SUDO} tee "${UNIT_FILE}" >/dev/null <<EOF
[Unit]
Description=DX-Compass - Multi-callsign DX Spot Monitor (Node-RED, port ${APP_PORT})
Documentation=https://github.com/
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_GROUP}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
Environment=NODE_OPTIONS=--max-old-space-size=256
ExecStart=${NODE_BIN} ${RED_JS} -u ${APP_DIR} -s ${SETTINGS_FILE}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${SERVICE_NAME}

[Install]
WantedBy=multi-user.target
EOF
ok "systemd unit installed"

# --------------------------------------------------------------------------- #
# 7. Enable and start
# --------------------------------------------------------------------------- #
info "Enabling and starting ${SERVICE_NAME} ..."
${SUDO} systemctl daemon-reload
${SUDO} systemctl enable "${SERVICE_NAME}.service" >/dev/null 2>&1
${SUDO} systemctl restart "${SERVICE_NAME}.service"

# Wait for the port to come up (max ~20 s)
info "Waiting for DX-Compass to start ..."
for i in $(seq 1 20); do
    if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${APP_PORT}$"; then
        break
    fi
    sleep 1
done

PRIMARY_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
PRIMARY_IP="${PRIMARY_IP:-<server-ip>}"

echo
if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
    ok "DX-Compass is RUNNING"
else
    err "DX-Compass service is not active. Show logs with:  journalctl -u ${SERVICE_NAME} -f"
    exit 1
fi

if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${APP_PORT}$"; then
    ok "Listening on port ${APP_PORT}"
else
    warn "Port ${APP_PORT} not detected yet - give it a few more seconds."
fi

echo
echo "------------------------------------------------------------------------"
echo -e "${_c_green}  DX-Compass installed successfully${_c_reset}"
echo "------------------------------------------------------------------------"
echo "  Dashboard      : http://${PRIMARY_IP}:${APP_PORT}/"
echo "  Node-RED editor: http://${PRIMARY_IP}:${APP_PORT}/red"
echo ""
echo "  Manage the service:"
echo "    sudo systemctl status  ${SERVICE_NAME}"
echo "    sudo systemctl restart ${SERVICE_NAME}"
echo "    sudo systemctl stop    ${SERVICE_NAME}"
echo "    journalctl -u ${SERVICE_NAME} -f"
echo ""
echo "  Coexistence: an existing Node-RED (e.g. port 1880 / nodered service)"
echo "  and ~/.node-red were not modified. Both instances run independently."
echo "------------------------------------------------------------------------"
