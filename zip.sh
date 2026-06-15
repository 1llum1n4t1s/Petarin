#!/bin/bash
# ぺたりん を Chrome Web Store 提出用 ZIP にパッケージング
set -euo pipefail
cd "$(dirname "$0")"

echo "ぺたりん をパッケージングします..."

if [ -f scripts/generate-icons.js ]; then
  echo "アイコンを生成しています..."
  pnpm install --silent
  pnpm run generate-icons
fi

if ! command -v zip &> /dev/null; then
  echo "zip コマンドが見つかりません（Linux: sudo apt install zip / macOS: brew install zip）"
  exit 1
fi

rm -f ./petarin-chrome.zip
zip -r ./petarin-chrome.zip \
  manifest.json \
  _locales/ \
  icons/ \
  src/ \
  -x "*.DS_Store" "*.swp" "*~"

echo "ZIP を作成しました: petarin-chrome.zip"
ls -lh ./petarin-chrome.zip
