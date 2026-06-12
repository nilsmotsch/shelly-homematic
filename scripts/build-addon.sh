#!/usr/bin/env bash
# Build the shelly-homematic CCU/RaspberryMatic addon tarball.
#
# Output: dist-addon/shelly-homematic-${VERSION}.tar.gz

set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
cd "${ROOT_DIR}"

NODE_VERSION=18.20.8
NODE_TARBALL="node-v${NODE_VERSION}-linux-armv6l.tar.xz"
NODE_URL="https://unofficial-builds.nodejs.org/download/release/v${NODE_VERSION}/${NODE_TARBALL}"
NODE_SHA256=8f9acd04d60219af8f8a3024b297f9e5c0be218bd9f196f211ce9aa7f75392c7
NODE_CACHE_DIR="${ROOT_DIR}/build-cache"

VERSION=$(cat addon/VERSION | tr -d '[:space:]')
if [ -z "${VERSION}" ]; then
  echo "addon/VERSION is empty" >&2
  exit 1
fi

STAGING="${ROOT_DIR}/build/staging"
PAYLOAD="${STAGING}/shelly-homematic"
OUT_DIR="${ROOT_DIR}/dist-addon"
TARBALL="${OUT_DIR}/shelly-homematic-${VERSION}.tar.gz"

echo "==> Cleaning previous build"
rm -rf "${ROOT_DIR}/build"
mkdir -p "${PAYLOAD}" "${STAGING}/rc.d" "${STAGING}/www" "${OUT_DIR}"

echo "==> Compiling TypeScript"
npm run --silent build

echo "==> Bundling app to single CJS file (target: node18)"
mkdir -p "${PAYLOAD}/dist"
npx esbuild "${ROOT_DIR}/dist/index.js" --bundle --platform=node \
    --target=node18 --format=cjs \
    --log-level=warning --outfile="${PAYLOAD}/dist/index.js" \
    --metafile="${ROOT_DIR}/build/esbuild-meta.json"

echo "==> Staging payload"
cp -R "${ROOT_DIR}/html" "${PAYLOAD}/html"
cp "${ROOT_DIR}/package.json" "${PAYLOAD}/package.json"
cp "${ROOT_DIR}/config.example.json" "${PAYLOAD}/config.example.json"
cp "${ROOT_DIR}/README.md" "${PAYLOAD}/README.md" 2>/dev/null || true
cp "${ROOT_DIR}/addon/VERSION" "${PAYLOAD}/VERSION"

echo "==> Bundling Node ${NODE_VERSION} runtime (linux-armv6l)"
mkdir -p "${NODE_CACHE_DIR}"
if [ ! -f "${NODE_CACHE_DIR}/${NODE_TARBALL}" ]; then
  curl -fsSL -o "${NODE_CACHE_DIR}/${NODE_TARBALL}.tmp" "${NODE_URL}"
  mv "${NODE_CACHE_DIR}/${NODE_TARBALL}.tmp" "${NODE_CACHE_DIR}/${NODE_TARBALL}"
fi
echo "${NODE_SHA256}  ${NODE_CACHE_DIR}/${NODE_TARBALL}" | shasum -a 256 -c - >/dev/null
mkdir -p "${PAYLOAD}/node/bin"
tar -xJf "${NODE_CACHE_DIR}/${NODE_TARBALL}" -C "${PAYLOAD}/node/bin" \
    --strip-components=2 "node-v${NODE_VERSION}-linux-armv6l/bin/node"
chmod 755 "${PAYLOAD}/node/bin/node"
touch "${PAYLOAD}/node/.nobackup"

echo "==> Collecting third-party licenses"
node "${ROOT_DIR}/scripts/generate-third-party-licenses.mjs" \
    "${ROOT_DIR}/build/esbuild-meta.json" "${PAYLOAD}/THIRD-PARTY-LICENSES.txt"
{
  echo
  echo "========================================================================"
  echo "Node.js v${NODE_VERSION} (bundled runtime binary, node/bin/node)"
  echo "https://nodejs.org/"
  echo "========================================================================"
  echo
  tar -xJOf "${NODE_CACHE_DIR}/${NODE_TARBALL}" "node-v${NODE_VERSION}-linux-armv6l/LICENSE"
} >> "${PAYLOAD}/THIRD-PARTY-LICENSES.txt"

echo "==> Staging addon installer"
cp "${ROOT_DIR}/addon/update_script" "${STAGING}/update_script"
cp "${ROOT_DIR}/addon/rc.d/shelly-homematic" "${STAGING}/rc.d/shelly-homematic"
cp "${ROOT_DIR}/addon/www/index.html" "${STAGING}/www/index.html"
cp "${ROOT_DIR}/addon/www/update-check.cgi" "${STAGING}/www/update-check.cgi"
chmod +x "${STAGING}/update_script" \
         "${STAGING}/rc.d/shelly-homematic" \
         "${STAGING}/www/update-check.cgi"

echo "==> Creating tarball"
( cd "${STAGING}" && tar czf "${TARBALL}" \
    --owner=0 --group=0 \
    update_script rc.d www shelly-homematic )

echo "==> Cleaning staging"
rm -rf "${ROOT_DIR}/build"

SIZE=$(du -h "${TARBALL}" | awk '{print $1}')
echo
echo "Built ${TARBALL} (${SIZE})"
