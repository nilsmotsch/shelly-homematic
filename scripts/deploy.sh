#!/usr/bin/env bash
# Fast local deploy: rebuild the esbuild bundle and push just dist/index.js to
# an already-installed CCU addon, then restart the service and tail the log.
#
# This is the quick iteration path — it does NOT reinstall the addon (node
# runtime, html, rc.d are untouched). For a clean/first install use --first.
#
# Credentials live in .env.local (gitignored):
#   CCU_HOST=192.168.178.10
#   CCU_SSH_USER=root
#   CCU_SSH_PASSWORD=...
#
# Usage:
#   scripts/deploy.sh            # build + deploy + restart + tail log
#   scripts/deploy.sh --first    # full first install (bundle + html + rc.d + InterfacesList)
#   scripts/deploy.sh --no-build # skip rebuild, push existing bundle
#   scripts/deploy.sh --logs     # just tail the remote log, no deploy

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "${ROOT_DIR}"

ENV_FILE="${ROOT_DIR}/.env.local"
if [ ! -f "${ENV_FILE}" ]; then
  echo "error: ${ENV_FILE} not found (need CCU_HOST / CCU_SSH_USER / CCU_SSH_PASSWORD)" >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; . "${ENV_FILE}"; set +a

: "${CCU_HOST:?set CCU_HOST in .env.local}"
: "${CCU_SSH_USER:=root}"
: "${CCU_SSH_PASSWORD:?set CCU_SSH_PASSWORD in .env.local}"

command -v sshpass >/dev/null 2>&1 || { echo "error: sshpass not installed (brew install sshpass)" >&2; exit 1; }

ADDON_NAME=shelly-homematic
ADDON_DIR="/usr/local/addons/${ADDON_NAME}"
RCD="/usr/local/etc/config/rc.d/${ADDON_NAME}"
LOGFILE="/usr/local/etc/config/addons/${ADDON_NAME}/${ADDON_NAME}.log"
BUNDLE="${ROOT_DIR}/build/deploy/index.js"

export SSHPASS="${CCU_SSH_PASSWORD}"
SSH="sshpass -e ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 ${CCU_SSH_USER}@${CCU_HOST}"
SCP="sshpass -e scp -o StrictHostKeyChecking=no -o ConnectTimeout=15"

tail_log() {
  echo "==> Tailing ${LOGFILE} (Ctrl-C to stop)"
  ${SSH} "tail -n 40 -f ${LOGFILE}"
}

if [ "${1:-}" = "--logs" ]; then
  tail_log
  exit 0
fi

if [ "${1:-}" != "--no-build" ]; then
  echo "==> Compiling TypeScript"
  npm run --silent build
  echo "==> Bundling app to single CJS file (target: node18)"
  mkdir -p "$(dirname "${BUNDLE}")"
  npx esbuild "${ROOT_DIR}/dist/index.js" --bundle --platform=node \
    --target=node18 --format=cjs \
    --log-level=warning --outfile="${BUNDLE}"
fi

[ -f "${BUNDLE}" ] || { echo "error: ${BUNDLE} missing — run without --no-build" >&2; exit 1; }
echo "==> Bundle: $(du -h "${BUNDLE}" | cut -f1)"

if [ "${1:-}" = "--first" ]; then
  echo "==> First install: uploading all addon files to ${CCU_HOST}"

  # Upload bundle
  ${SSH} "mkdir -p ${ADDON_DIR}/dist ${ADDON_DIR}/html /usr/local/etc/config/addons/${ADDON_NAME}"
  ${SCP} "${BUNDLE}" "${CCU_SSH_USER}@${CCU_HOST}:${ADDON_DIR}/dist/index.js"

  # Upload html
  ${SCP} -r "${ROOT_DIR}/html/." "${CCU_SSH_USER}@${CCU_HOST}:${ADDON_DIR}/html/"

  # Upload VERSION and config.example.json
  ${SCP} "${ROOT_DIR}/addon/VERSION" "${CCU_SSH_USER}@${CCU_HOST}:${ADDON_DIR}/VERSION" 2>/dev/null \
    || echo "0.1.0" | ${SSH} "cat > ${ADDON_DIR}/VERSION"
  ${SCP} "${ROOT_DIR}/config.example.json" "${CCU_SSH_USER}@${CCU_HOST}:${ADDON_DIR}/config.example.json"

  # Upload rc.d script
  ${SCP} "${ROOT_DIR}/addon/rc.d/${ADDON_NAME}" "${CCU_SSH_USER}@${CCU_HOST}:${RCD}"
  ${SSH} "chmod +x ${RCD}"

  # Symlink Node 18 from matter-homematic
  ${SSH} "ln -sfn /usr/local/addons/matter-homematic/node ${ADDON_DIR}/node"

  # Register the <ipc> entry into BOTH the live list and the boot template (the
  # live file is regenerated from the template at boot). The rc.d init case also
  # re-adds it on every boot — see addon/rc.d/shelly-homematic.
  ${SSH} "SED='s#</interfaces>#\t<ipc>\n\t\t<name>ShellyHM</name>\n\t\t<url>xmlrpc://127.0.0.1:2121</url>\n\t\t<info>ShellyHM</info>\n\t</ipc>\n</interfaces>#'; \
    for F in /usr/local/etc/config/InterfacesList.xml /etc/config_templates/InterfacesList.xml; do \
      [ -f \"\$F\" ] || continue; \
      if grep -q '<name>ShellyHM</name>' \"\$F\"; then echo \"already in \$F\"; continue; fi; \
      case \"\$F\" in /etc/*) mount -o remount,rw / 2>/dev/null;; esac; \
      sed -i \"\$F\" -e \"\$SED\"; \
      case \"\$F\" in /etc/*) mount -o remount,ro / 2>/dev/null;; esac; \
      echo \"registered ShellyHM in \$F\"; \
    done"

  echo "==> Starting service"
  ${SSH} "${RCD} start"

else
  echo "==> Uploading bundle to ${CCU_HOST}"
  ${SCP} "${BUNDLE}" "${CCU_SSH_USER}@${CCU_HOST}:/tmp/${ADDON_NAME}-index.js"

  echo "==> Swapping bundle + restarting service"
  ${SSH} "set -e; \
    cp ${ADDON_DIR}/dist/index.js ${ADDON_DIR}/dist/index.js.bak 2>/dev/null || true; \
    mv /tmp/${ADDON_NAME}-index.js ${ADDON_DIR}/dist/index.js; \
    ${RCD} restart"
fi

echo "==> Restart issued; verifying process"
sleep 5
${SSH} "ps w | grep '[s]helly-homematic/dist/index.js' || echo '(process not found yet)'"

echo "==> Recent log (run 'scripts/deploy.sh --logs' to follow live)"
${SSH} "tail -n 30 ${LOGFILE} 2>/dev/null || echo '(no log yet)'"
