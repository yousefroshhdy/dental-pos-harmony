# Honest OS for Android (D-14 phase 2)

A thin Android shell around the Honest OS web app, so a field rep's working-day location
is recorded **in the background** too: with the screen off, or while another app is open.
The browser alone can only record while the page is open with the screen on (D-14, V-06).

**Status:** Implemented. The debug APK is built by GitHub Actions (`.github/workflows/android.yml`).
Nothing has been tried on a phone yet. **No real use before the D-03 legal review**: location
tracking of employees is personal data under Egypt's PDPL (Law 151/2020).

## How it works

- **Remote-URL WebView** (Capacitor). The Next.js app is server-rendered and uses server
  actions, so it cannot be bundled into the APK. The app opens the deployment set at build
  time (`CAP_SERVER_URL`, default `https://honest-os-staging.vercel.app`). The WebView may
  navigate only to that host; any other link opens in the phone's browser.
- **Background location**: `@capacitor-community/background-geolocation` (MIT). It runs a
  foreground service with a permanent notification ("Honest OS is recording your location for
  your working day"), which Android requires for background location.
- **The web app drives it.** There is no app-specific code in the APK beyond the shell. The
  tracking module (`src/modules/tracking`) detects the shell with
  `window.Capacitor?.isNativePlatform?.()`, and calls the plugin through
  `window.Capacitor.Plugins.BackgroundGeolocation` (`src/lib/native/`):
  - "Start my day" starts the watcher; "End my day", the server closing the shift, the
    shift's maximum length or signing out remove it. The login page also removes any
    watcher left behind. **Nothing is collected without an open shift.**
  - Points go through the same buffer, offline queue and server command as the browser
    collector, with `source: "native"`. The server gives that label **no extra trust**
    (migration `20261102000100`): same shift binding, spacing, cap and anomaly flags.
  - In a browser, the in-page collector is used instead; the two never run together.
- **Fallback page** (`www/offline.html`, Arabic and English): shown when the deployment cannot
  be loaded. Capacitor also shows it for any HTTP error on a full page load.

| | Version | Licence |
|---|---|---|
| `@capacitor/core`, `@capacitor/android`, `@capacitor/cli` | 8.5.3 | MIT |
| `@capacitor-community/background-geolocation` | 1.3.1 | MIT |

`mobile/` has its own `package.json` and `package-lock.json` (npm). It is not part of the
root pnpm install; `tsconfig.json` and `eslint.config.mjs` at the root ignore it.

## Build

### In GitHub Actions (normal path)

The workflow **Android** runs on every push to `ccr-cd8ec6c2-y28xig` that touches `mobile/**`
or the workflow, and on demand (Actions › Android › Run workflow). It builds
`app-debug.apk` and uploads it as the artifact **`honest-os-android-debug`** (kept 14 days).

To point the app at another deployment, set the repository variable `CAP_SERVER_URL`
(Settings › Secrets and variables › Actions › Variables), e.g. the production URL. It must be
`https://`.

### Locally (needs the Android SDK and Google's Maven repository)

```bash
cd mobile
npm ci
CAP_SERVER_URL=https://honest-os-staging.vercel.app npx cap sync android
cd android && ./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

JDK 21 is required (Capacitor 8). `npx cap sync android` alone needs only npm; it also
writes `www/config.js` (the fallback page's "Try again" target) through the
`capacitor:copy:before` hook. Run it after changing `capacitor.config.ts`, the plugin
version or `CAP_SERVER_URL`. `npx cap open android` opens the project in Android Studio.

### Release signing (later, not built yet)

Debug APKs are signed with the SDK's debug key: fine for a pilot by MDM or `adb`, **not** for
the Play Store or a long-lived fleet (a new debug key on another machine cannot update an
installed app). When ready:

1. Create an upload/release keystore once, offline, and keep it in the company's password
   manager (never in Git; `*.jks` and `*.keystore` are ignored):
   `keytool -genkeypair -v -keystore honest-os-release.jks -alias honest-os -keyalg RSA -keysize 4096 -validity 10000`
2. Add GitHub **secrets**: `ANDROID_KEYSTORE_BASE64` (`base64 -w0 honest-os-release.jks`),
   `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
3. Add a release job (manual trigger, protected environment) that decodes the keystore into
   `$RUNNER_TEMP`, runs `./gradlew assembleRelease` (or `bundleRelease` for Play) with a
   `signingConfigs.release` block that reads those values from environment variables, uploads
   the signed APK/AAB, and deletes the keystore file.
4. Bump `versionCode` / `versionName` in `android/app/build.gradle` for every release.

## Install on company phones

- **MDM (recommended for the fleet):** upload the APK as a private app in the MDM
  (e.g. Android Enterprise managed Google Play private app, or the MDM's own app catalogue).
  Through MDM IT can also: pre-grant location and notifications, exempt Honest OS from battery
  optimisation, and block uninstalling. A pilot can use the debug APK; the fleet needs the
  release-signed one (see above).
- **One phone by cable:** enable Developer options › USB debugging, then
  `adb install -r app-debug.apk`.
- **One phone without a computer:** copy the APK to the phone and open it; allow
  "Install unknown apps" for the file manager when asked, then turn that permission off again.

## Permissions (and what the rep must allow)

Declared in `android/app/src/main/AndroidManifest.xml`:

| Permission | Why |
|---|---|
| `INTERNET` | the web app |
| `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` | the location itself (precise is needed for visits and stops) |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION` | the location service with its permanent notification (type `location`, required from Android 14) |
| `POST_NOTIFICATIONS` | showing that notification (Android 13+); asked once when the app starts |

`ACCESS_BACKGROUND_LOCATION` is **not** requested: the service is started while the app is in
the foreground ("Start my day") and keeps running with its notification.

On the phone, the rep allows:

1. **Location: "Allow all the time" or "Allow only while using the app"**, with **"Use precise
   location" on**. ("Only this time" stops after the app is closed.)
2. **Notifications: allow.** The notification is what keeps tracking running.
3. **Battery: "Unrestricted"** (see below).

The shift card in the app shows the same guidance, in Arabic and English, with a button that
opens the app's Android settings.

## Battery settings

Android and especially some manufacturers stop background apps to save battery. Then the day
shows gaps (flagged for the manager, never an automatic penalty).

- **All phones:** Settings › Apps › Honest OS › Battery › **Unrestricted** (older versions:
  turn off "Optimise battery usage").
- **Samsung:** Settings › Battery › Background usage limits: remove Honest OS from "Sleeping
  apps" and "Deep sleeping apps"; optionally add it to "Never sleeping apps".
- **Xiaomi / Redmi / Poco (MIUI, HyperOS):** Settings › Apps › Honest OS: **Autostart on**,
  Battery saver › **No restrictions**; lock the app in the recent-apps screen.
- **Oppo / Realme / OnePlus (ColorOS), Vivo:** allow **Auto launch / Background activity**,
  battery "Don't optimise"; lock the app in recent apps.
- **MDM:** allow-list Honest OS from battery optimisation for all devices at once.
- Tell reps **not to swipe Honest OS away** from recent apps during the day: on Android that
  ends the app and its location service.

See also <https://dontkillmyapp.com> for model-specific steps.

## Known limits

- **Vercel Authentication.** If the staging deployment is protected by Vercel Authentication,
  the WebView shows Vercel's sign-in (or the fallback page) to reps without a Vercel account.
  Decide whether only preview deployments are protected.
- **Uploads while in the background** can be delayed: Android throttles WebView network
  requests after a few minutes in the background. Points stay queued on the phone (with their
  capture times) and are sent when the app is in front again or at "End my day"; the server
  accepts them up to 24 hours after the shift ended.
- **No location while the fallback page is shown** or after the app was killed; the rep
  opens the app again and recording resumes while the day is open.
- **Battery:** the plugin asks for a high-accuracy fix about once a second while the day is
  open (only one point per 5 minutes is kept). Expect noticeably higher battery use; measure
  it in the pilot.
- **Mock locations:** the plugin reports `simulated` fixes, but they are not sent or flagged
  yet; the server's impossible-travel flag still applies.
