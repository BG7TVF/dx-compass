#!/usr/bin/env bash
###############################################################################
#
#  DX-Compass - Bootstrap installer (run straight from GitHub)
#
#  Copy ONE of the following lines into your Ubuntu server terminal:
#
#    curl -fsSL https://raw.githubusercontent.com/BG7TVF/dx-compass/main/bootstrap.sh | sudo bash
#
#    wget -qO- https://raw.githubusercontent.com/BG7TVF/dx-compass/main/bootstrap.sh | sudo bash
#
#  What it does:
#    1. Downloads (git clone) or updates the project to /opt/dx-compass
#    2. Hands over to install.sh which installs deps and starts the service
#
#  Optional variables:
#    sudo DX_COMPASS_DIR=/srv/dx-compass bash bootstrap.sh      # custom path
#    sudo DX_COMPASS_BRANCH=dev bash bootstrap.sh              # custom branch
#
#  Note: must run as root (prefix the curl/wget command with sudo) because
#        apt packages and the systemd service are installed.
#
###############################################################################

set -euo pipefail

# --------------------------------------------------------------------------- #
# Config (overridable via environment)
# --------------------------------------------------------------------------- #
REPO_URL="https://github.com/BG7TVF/dx-compass.git"
RAW_BASE="https://raw.githubusercontent.com/BG7TVF/dx-compass"
BRANCH="${DX_COMPASS_BRANCH:-main}"
INSTALL_DIR="${DX_COMPASS_DIR:-/opt/dx-compass}"

# --------------------------------------------------------------------------- #
# Output helpers (ASCII only)
# --------------------------------------------------------------------------- #
_c_reset='\033[0m'; _c_blue='\033[1;34m'; _c_green='\033[1;32m'
_c_yellow='\033[1;33m'; _c_red='\033[1;31m'
info()  { echo -e "${_c_blue}[INFO]${_c_reset}  $*"; }
ok()    { echo -e "${_c_green}[ OK ]${_c_reset}  $*"; }
warn()  { echo -e "${_c_yellow}[WARN]${_c_reset}  $*"; }
err()   { echo -e "${_c_red}[FAIL]${_c_reset}  $*" >&2; }
die()   { err "$*"; exit 1; }

echo
echo "=============================================================="
echo "  DX-Compass bootstrap installer"
echo "  Branch: ${BRANCH}   Target: ${INSTALL_DIR}"
echo "=============================================================="
echo

# --------------------------------------------------------------------------- #
# Root check (apt + systemd need it)
# --------------------------------------------------------------------------- #
if [[ ${EUID} -ne 0 ]]; then
    err "This installer must run as root."
    err "Please re-run with sudo, for example:"
    err "  curl -fsSL ${RAW_BASE}/${BRANCH}/bootstrap.sh | sudo bash"
    exit 1
fi

# --------------------------------------------------------------------------- #
# Basic tools: make sure curl/git/ca-certificates are present
# --------------------------------------------------------------------------- #
NEED_INSTALL=()
command -v curl >/dev/null 2>&1 || NEED_INSTALL+=(curl ca-certificates)
command -v git  >/dev/null 2>&1 || NEED_INSTALL+=(git)
if [[ ${#NEED_INSTALL[@]} -gt 0 ]]; then
    info "Installing required tools: ${NEED_INSTALL[*]} ..."
    apt-get update -qq
    env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${NEED_INSTALL[@]}" >/dev/null
fi
command -v curl >/dev/null 2>&1 || die "curl is required but could not be installed."

# --------------------------------------------------------------------------- #
# Download / update the project
# --------------------------------------------------------------------------- #
if [[ -d "${INSTALL_DIR}/.git" ]]; then
    info "Existing installation found at ${INSTALL_DIR} - updating..."
    git -C "${INSTALL_DIR}" fetch --depth 1 origin "${BRANCH}"
    git -C "${INSTALL_DIR}" reset --hard "origin/${BRANCH}"
    ok "Project updated to branch ${BRANCH}"

elif [[ -f "${INSTALL_DIR}/install.sh" ]]; then
    warn "${INSTALL_DIR} exists but is not a git repository - using the files already there."

else
    # Fresh install: prefer git, fall back to tarball download
    mkdir -p "$(dirname "${INSTALL_DIR}")"

    if command -v git >/dev/null 2>&1; then
        info "Cloning ${REPO_URL} (branch ${BRANCH})..."
        if ! git clone --depth 1 --branch "${BRANCH}" "${REPO_URL}" "${INSTALL_DIR}"; then
            die "git clone failed. If the server accesses GitHub via a proxy, run:
  curl -fsSL ${RAW_BASE}/${BRANCH}/bootstrap.sh -o /tmp/dxc-bootstrap.sh
  sudo https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 bash /tmp/dxc-bootstrap.sh"
        fi
    else
        info "git not found - downloading release tarball..."
        TARBALL_URL="https://codeload.github.com/BG7TVF/dx-compass/tar.gz/refs/heads/${BRANCH}"
        TMP_TGZ="$(mktemp /tmp/dx-compass.XXXXXX.tar.gz)"
        TMP_EXTRACT="$(mktemp -d /tmp/dx-compass.XXXXXX)"
        # shellcheck disable=SC2064
        trap "rm -f '${TMP_TGZ}'; rm -rf '${TMP_EXTRACT}'" EXIT

        if curl -fsSL --retry 3 -o "${TMP_TGZ}" "${TARBALL_URL}"; then
            tar -xzf "${TMP_TGZ}" -C "${TMP_EXTRACT}"
            # archive extracts to a single folder named dx-compass-<branch>
            SRC_DIR=""
            for d in "${TMP_EXTRACT}"/*/; do
                if [[ -f "${d}install.sh" ]]; then SRC_DIR="${d%/}"; break; fi
            done
            [[ -n "${SRC_DIR}" ]] || die "Downloaded archive is invalid."
            mkdir -p "${INSTALL_DIR}"
            cp -a "${SRC_DIR}/." "${INSTALL_DIR}/"
        else
            die "Download failed. Check network/proxy access to github.com."
        fi
    fi
    ok "Project downloaded to ${INSTALL_DIR}"
fi

# --------------------------------------------------------------------------- #
# Hand over to the real installer
# --------------------------------------------------------------------------- #
[[ -f "${INSTALL_DIR}/install.sh" ]] || die "install.sh not found in ${INSTALL_DIR}."
info "Starting installer..."
echo
exec bash "${INSTALL_DIR}/install.sh"
