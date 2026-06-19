# Gym Flow — Android wrapper (Capacitor)

This folder packages the Gym Flow web app as an Android app. Gym Flow is a
**server-rendered Node/Express app**, so the APK is a thin native **WebView** that loads
the live backend defined by `server.url` in [`capacitor.config.json`](capacitor.config.json).
There is no copy of the app logic in here — everything (auth cookie, Razorpay checkout,
all pages) runs against your hosted backend exactly like the website.

- **App name:** Gym Flow
- **Package / applicationId:** `com.gymflow.app`
- **Version:** `versionName 1.0.0`, `versionCode 1`  (in `android/app/build.gradle`)
- **Capacitor:** 8.x · **min/target SDK:** per `android/variables.gradle`

---

## One-time prerequisites (on the build machine)

The Android SDK is **not** bundled here. Install:

1. **JDK 21** (Capacitor 8 requirement).
2. **Android Studio** (ships the Android SDK + platform tools), or the standalone
   command-line SDK. Open Android Studio once and let it install SDK Platform 34/35 + build-tools.
3. Set `ANDROID_HOME` (or create `android/local.properties` with `sdk.dir=...`).

---

## Step 1 — Point the app at your backend  ⚠️ REQUIRED

Edit [`capacitor.config.json`](capacitor.config.json) and replace the placeholder:

```json
"server": { "url": "https://app.your-gym-domain.com", "androidScheme": "https", "cleartext": false }
```

The backend **must** be deployed and reachable over **HTTPS** (cookies + Razorpay need it).
Then copy the config into the native project:

```bash
npm install        # first time only, installs Capacitor CLI
npx cap sync android
```

## Step 2 — Generate a release keystore (one-time, keep it FOREVER)

From inside `android/`:

```bash
keytool -genkeypair -v -keystore gymflow-release.jks \
  -alias gymflow -keyalg RSA -keysize 2048 -validity 10000
```

Copy `keystore.properties.example` → `android/keystore.properties` and fill in the real
alias + passwords. **Back up the `.jks` file and passwords** — lose them and you can never
push an update to the same Play listing. Both files are gitignored; never commit them.

## Step 3 — Build

```bash
cd android
# Android App Bundle (what Google Play wants):
./gradlew bundleRelease       # -> app/build/outputs/bundle/release/app-release.aab
# or a directly-installable APK:
./gradlew assembleRelease     # -> app/build/outputs/apk/release/app-release.apk
```

(On Windows use `gradlew.bat`.) If `keystore.properties` is present the output is signed and
upload-ready; if absent you get `app-release-unsigned.apk` to sign manually.

## Step 4 — Update the icon/splash (optional)

The launcher icon + splash were generated from `assets/logo.png`. To change them, drop a new
≥1024×1024 `assets/logo.png` and run:

```bash
npx capacitor-assets generate --android --assetPath assets
```

---

## Bumping the version for each release

Edit `android/app/build.gradle` → `versionCode` (must increase every Play upload) and
`versionName` (the human label, e.g. `1.0.1`).

## Notes

- Re-run `npx cap sync android` after any change to `capacitor.config.json` or web assets.
- The bundled `www/index.html` is only a branded fallback shown if `server.url` is unset or
  unreachable — the real UI comes from your backend.
- To preview on a device/emulator during development: `npx cap run android`.
