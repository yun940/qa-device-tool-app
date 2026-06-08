#!/bin/bash
# QA Device Tool — iOS Ad Hoc IPA 빌드 스크립트
# 사용법: ./ios/build-ipa.sh
# 결과물: ios/build/App.ipa
#
# 사전 조건:
#  1. developer.apple.com에 설치 대상 기기들의 UDID가 모두 등록돼 있어야 함
#  2. Xcode에 본인 개발자 계정이 로그인돼 있어야 함

set -e

# 경로에 한글이 들어가 있어 UTF-8 강제
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8

# 이 스크립트가 있는 폴더 = ios/
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

WORKSPACE="App/App.xcworkspace"
SCHEME="App"
CONFIG="Release"
ARCHIVE_PATH="build/App.xcarchive"
EXPORT_DIR="build"
EXPORT_OPTIONS="ExportOptions.plist"

echo "▶︎ 1/3  웹 자산 동기화 (cap sync ios)"
cd ..
npx cap sync ios
cd "$SCRIPT_DIR"

echo "▶︎ 2/3  아카이브 생성 (1~3분 소요)"
rm -rf "$ARCHIVE_PATH"
xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration "$CONFIG" \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE_PATH" \
  -allowProvisioningUpdates \
  archive

echo "▶︎ 3/3  Ad Hoc IPA 내보내기"
rm -f "$EXPORT_DIR"/*.ipa
xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$EXPORT_OPTIONS" \
  -allowProvisioningUpdates

echo ""
echo "✅ 완료! IPA 위치:"
ls -lh "$EXPORT_DIR"/*.ipa
echo ""
echo "다음 단계:"
echo "  1. 위 IPA 파일을 HTTPS 서버에 업로드"
echo "  2. ios/dist/manifest.plist 의 URL을 실제 URL로 수정 후 함께 업로드"
echo "  3. ios/dist/install.html 의 manifest URL 수정 후 업로드"
