#!/usr/bin/env bash
###############################################################################
#
#  DX-Compass - Bootstrap installer (run straight from GitHub)
#
#  Copy ONE of the following lines into your Ubuntu server terminal:
#
#    curl -fsSL https://raw.githubusercontent.com/BG7TVF/dx-compass/main/bootstrap.sh | sudo bash
#
#  System-wide install (sudo): programme goes to /opt/dx-compass and runs
#  as the invoking user via a systemd system service.
#
#  Per-user install (no sudo needed, no root privileges required):
#
#    curl -fsSL https://raw.githubusercontent.com/BG7TVF/dx-compass/main/bootstrap.sh | bash
#
#  ...or with a custom directory / branch:
#
#    DX_COMPASS_DIR=$HOME/dx-compass DX_COMPASS_BRANCH=main bash bootstrap.sh
#
#  Requirement for the no-sudo mode: Node.js >= 18, git and curl must
#  already be installed (the script cannot apt-get without root).
#
#  Ownership: a repository directory owned by another user is handled
#  automatically - when running as root the git commands are executed as
#  the directory owner, and the path is registered in git's
#  safe.directory list. This avoids the "detected dubious ownership"
#  error that used to force every pull to be run as the original owner.
#
###############################################################################

set -euo pipefail

# --------------------------------------------------------------------------- #
# Config (overridable via environment)
# --------------------------------------------------------------------------- #
REPO_URL="https://github.com/BG7TVF/dx-compass.git"
RAW_BASE="https://raw.githubusercontent.com/BG7TVF/dx-compass"
BRANCH="${DX_COMPASS_BRANCH:-main}"

# --------------------------------------------------------------------------- #
# Root vs per-user mode
# --------------------------------------------------------------------------- #
CUR_USER="$(id -un)"
if [[ ${EUID} -eq 0 ]]; then
    MODE="system"
    INSTALL_DIR="${DX_COMPASS_DIR:-/opt/dx-compass}"
else
    MODE="user"
    INSTALL_DIR="${DX_COMPASS_DIR:-${HOME}/dx-compass}"
fi

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
echo "  Mode: ${MODE}   Branch: ${BRANCH}"
echo "  Target: ${INSTALL_DIR}"
echo "=============================================================="
echo

# --------------------------------------------------------------------------- #
# Basic tools: make sure curl/git/ca-certificates are present.
# Only root can install packages; per-user mode checks and explains instead.
# --------------------------------------------------------------------------- #
NEED_INSTALL=()
command -v curl >/dev/null 2>&1 || NEED_INSTALL+=(curl ca-certificates)
command -v git  >/dev/null 2>&1 || NEED_INSTALL+=(git)
if [[ ${#NEED_INSTALL[@]} -gt 0 ]]; then
    if [[ ${EUID} -eq 0 ]]; then
        info "Installing required tools: ${NEED_INSTALL[*]} ..."
        apt-get update -qq
        env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${NEED_INSTALL[@]}" >/dev/null
    else
        warn "Missing tools: ${NEED_INSTALL[*]} (per-user mode cannot install them)."
    fi
fi
command -v curl >/dev/null 2>&1 || die "curl is required. Install it first:  sudo apt-get install -y curl ca-certificates"
command -v git  >/dev/null 2>&1 || die "git is required. Install it first:  sudo apt-get install -y git"

# --------------------------------------------------------------------------- #
# Git ownership handling
#   A repository created by root or by another user triggers git's
#   "detected dubious ownership" refusal. Solve it without forcing the
#   operator to switch accounts:
#     * root        -> run the git commands as the directory owner
#     * regular user-> register the path in this user's global safe.directory
# --------------------------------------------------------------------------- #
GIT_AS=(git)
build_git_runner() {
    local dir="$1" owner
    owner="$(stat -c '%U' "${dir}" 2>/dev/null || true)"
    if [[ -n "${owner}" && "${owner}" != "${CUR_USER}" ]]; then
        if [[ ${EUID} -eq 0 ]]; then
            info "Repository is owned by '${owner}' - running git as that user."
            GIT_AS=(sudo -u "${owner}" -H git)
        else
            err "Repository ${dir} is owned by '${owner}', current user is '${CUR_USER}'."
            err "Run the update as the owner:  sudo -u ${owner} bash ${BASH_SOURCE[0]}"
            err "Or take ownership:            sudo chown -R ${CUR_USER}:${CUR_USER} ${dir}"
            exit 1
        fi
    fi
    # Register the path as safe for whichever identity runs git.
    "${GIT_AS[@]}" config --global --add safe.directory "${dir}" 2>/dev/null || true
}

# --------------------------------------------------------------------------- #
# Download / update the project
# --------------------------------------------------------------------------- #
if [[ -d "${INSTALL_DIR}/.git" ]]; then
    info "Existing installation found at ${INSTALL_DIR} - updating..."
    build_git_runner "${INSTALL_DIR}"
    "${GIT_AS[@]}" -C "${INSTALL_DIR}" fetch --depth 1 origin "${BRANCH}"
    "${GIT_AS[@]}" -C "${INSTALL_DIR}" reset --hard "origin/${BRANCH}"
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
