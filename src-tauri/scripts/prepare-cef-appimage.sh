#!/usr/bin/env bash
set -euo pipefail

if [[ "${TAURI_ENV_FAMILY:-}" != "unix" || "${TAURI_ENV_PLATFORM:-}" != "linux" ]]; then
  exit 0
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
target_dir="$repo_root/src-tauri/target/release"
cef_src="$(find "$target_dir/build" -path '*/out/cef_linux_x86_64/libcef.so' -print -quit)"

if [[ -z "$cef_src" ]]; then
  echo "CEF runtime not found under $target_dir/build" >&2
  exit 1
fi

cef_dir="$(dirname "$cef_src")"
bundle_dir="$repo_root/src-tauri/cef-bundle"
binary="$target_dir/vjled-app"

rm -rf "$bundle_dir"
mkdir -p "$bundle_dir/locales"

cp "$cef_dir"/libcef.so "$bundle_dir/"
cp "$cef_dir"/libEGL.so "$bundle_dir/"
cp "$cef_dir"/libGLESv2.so "$bundle_dir/"
cp "$cef_dir"/libvk_swiftshader.so "$bundle_dir/"
cp "$cef_dir"/libvulkan.so.1 "$bundle_dir/"
cp "$cef_dir"/vk_swiftshader_icd.json "$bundle_dir/"
cp "$cef_dir"/icudtl.dat "$bundle_dir/"
cp "$cef_dir"/v8_context_snapshot.bin "$bundle_dir/"
cp "$cef_dir"/chrome_100_percent.pak "$bundle_dir/"
cp "$cef_dir"/chrome_200_percent.pak "$bundle_dir/"
cp "$cef_dir"/resources.pak "$bundle_dir/"
cp "$cef_dir"/locales/en-US.pak "$bundle_dir/locales/"
cp "$cef_dir"/locales/ja.pak "$bundle_dir/locales/"

if [[ -x "$binary" ]]; then
  patchelf --set-rpath '$ORIGIN/../lib' "$binary"
fi
