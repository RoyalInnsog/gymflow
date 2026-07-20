# Gym Flow — Release Artifacts

| Folder | Contents | Status |
|--------|----------|--------|
| `android/` | APK builds (sideload / testing) | **GymFlow-v1.1.0.apk** (debug-signed, built 16 Jul 2026 — includes AI Diet scanner; points at Render) |
| `playstore/` | Signed AAB bundles for Play Store | pending — needs release keystore + `bundleRelease` |
| `windows/` | Windows .exe (Electron bundled-offline) | **GymFlow-Setup-1.1.0.exe** (NSIS installer, unsigned, built 16 Jul 2026) |
| `macos/` | macOS .dmg | build via CI — GitHub Actions `Desktop installers` workflow (macOS can't be built on Windows) |

## How each artifact is built

**Android APK** (`mobile/`):
```
cd mobile
API_BASE=https://gymflow-3svy.onrender.com node build-www.js
npx cap sync android
cd android && JAVA_HOME="C:/Program Files/Microsoft/jdk-21.0.11.10-hotspot" ./gradlew.bat assembleDebug
# -> mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

**Windows .exe** (`desktop/` — Electron, reuses `mobile/www`):
```
node mobile/build-www.js            # bundle frontend (Render API baked in)
cd desktop && npm ci && npm run dist:win
# -> desktop/dist/GymFlow-Setup-1.1.0.exe
```
Note: on this Windows machine electron-builder's `winCodeSign` helper fails to
extract (it contains macOS symlinks Windows won't create without Developer Mode).
Workaround already applied once: pre-extract it minus the `darwin` folder into
`%LOCALAPPDATA%/electron-builder/Cache/winCodeSign/winCodeSign-2.6.0`. CI runners
don't have this restriction.

**macOS .dmg** — cannot be built on Windows. Use the `Desktop installers`
GitHub Actions workflow (`.github/workflows/desktop.yml`): Actions tab → Run
workflow, then download the `GymFlow-macOS` artifact.

## App Store distribution (iOS + Mac)

- **iOS App Store:** the Capacitor iOS app via `codemagic.yaml` (builds the IPA on
  a cloud Mac → TestFlight → App Store). **This same app also runs on
  Apple-Silicon MacBooks from the App Store** — so one iOS submission covers
  iPhone, iPad, and modern Macs. This is the recommended "Mac + iOS" store path.
- The Electron `.dmg` above is for **direct/off-store** distribution (your own
  download link). It is a separate artifact from the App Store build.

All desktop/mobile builds are **unsigned**. Signing/notarization (Apple Developer
cert, Windows code-signing cert) is a later config step — the build scripts and CI
pick up the certs automatically once their secrets are set.
