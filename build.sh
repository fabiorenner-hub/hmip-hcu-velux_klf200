#!/usr/bin/env bash
# Builds the ARM64 container image for the HCU and packages it as the
# .tar.gz that HCUweb accepts under "Plugins -> Install from file".

set -euo pipefail

IMAGE="hmip-velux-plugin"
TAG="1.0.1"
PLATFORM="linux/arm64"
OUT="${IMAGE}-${TAG}.tar"
OUT_GZ="${OUT}.gz"

echo ">> docker: $(docker --version)"

if ! docker buildx version >/dev/null 2>&1; then
    echo "ERROR: docker buildx is not available. Install the buildx plugin."
    exit 1
fi

HOST_ARCH="$(uname -m)"
if [ "${HOST_ARCH}" != "aarch64" ] && [ "${HOST_ARCH}" != "arm64" ]; then
    if ! docker buildx inspect --bootstrap 2>/dev/null | grep -qi arm64; then
        echo ">> Host is ${HOST_ARCH}; installing QEMU binfmt handlers for ARM64"
        docker run --privileged --rm tonistiigi/binfmt --install arm64 >/dev/null
    fi
fi

echo ">> Ensuring buildx builder 'hcubuild' exists"
if ! docker buildx inspect hcubuild >/dev/null 2>&1; then
    docker buildx create --name hcubuild --use >/dev/null
else
    docker buildx use hcubuild >/dev/null
fi

echo ">> Building ${IMAGE}:${TAG} for ${PLATFORM}"
docker buildx build \
    --platform "${PLATFORM}" \
    --tag "${IMAGE}:${TAG}" \
    --load \
    .

echo ">> Saving image to ${OUT}"
docker save "${IMAGE}:${TAG}" -o "${OUT}"

echo ">> Compressing to ${OUT_GZ}"
gzip -f "${OUT}"

echo ""
echo ">> Done: $(pwd)/${OUT_GZ}"
echo "   Upload this file in HCUweb -> Plugins -> Install from file."
