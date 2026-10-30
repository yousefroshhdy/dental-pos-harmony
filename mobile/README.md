# Honest OS for Android (D-14 phase 2)

A thin Android shell around the Honest OS web app, so a field rep's working-day location
is recorded **in the background** too: with the screen off, or while another app is open.
The browser alone can only record while the page is open with the screen on (D-14, V-06).

**Status:** Implemented. GitHub Actions (`.github/workflows/android.yml`) builds the **pilot APK**
(release type, not debuggable, the one to install) and a debug APK (development only).
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
    shift's maximum length or signing out remove it. Any page that is not collecting, and
    the login page, also remove a watcher left behind by an earlier page (after a reload or
    the fallback page, the plugin keeps the watcher but the page's callback is gone).
    **Nothing is collected without an open shift.**
  - Points go through the same buffer, offline queue and server command as the browser
    collector, with `source: "native"`. The server gives that label **no extra trust**
    (migration `20261102000100`): same shift binding, spacing, cap and anomaly flags.
  - In a browser, the in-page collector is used instead; the two never run together.
- **Fallback page** (`www/offline.html`, Arabic and English): shown when the deployment cannot
  be loaded. Capacitor also shows it for any HTTP error on a full page load.
- **Guarded bridge** (`android/app/src/main/java/eg/honest/os/`, see [Security](#security)): only
  the top frame of the deployment can call a native plugin, and only the background-location
  plugin's `addWatcher`, `removeWatcher` and `openSettings`.

| | Version | Licence |
|---|---|---|
| `@capacitor/core`, `@capacitor/android`, `@capacitor/cli` | 8.5.3 | MIT |
| `@capacitor-community/background-geolocation` | 1.3.1 | MIT |

`mobile/` has its own `package.json` and `package-lock.json` (npm). It is not part of the
root pnpm install; `tsconfig.json` and `eslint.config.mjs` at the root ignore it.

## Build

### In GitHub Actions (normal path)

The workflow **Android** runs on every push to `ccr-cd8ec6c2-y28xig` that touches `mobile/**`
or the workflow, and on demand (Actions › Android › Run workflow). It runs the native unit tests
(`BridgePolicyTest`) and uploads two artifacts (kept 14 days):

| Artifact | File | Use |
|---|---|---|
| **`honest-os-android-pilot`** | `app-release.apk` | **The pilot.** Release type: not debuggable, no WebView inspection, no Capacitor logging. Signed with the Android SDK's debug key (see [Signing](#signing-pilot-now-production-later)). The workflow checks that it is not debuggable and prints its signing certificate. |
| `honest-os-android-debug` | `app-debug.apk` | Development only. Debuggable: anyone with the phone and a cable can read the app's storage (`adb run-as`). **Never install it on a rep's phone.** |

Every action in the workflow is pinned to a full commit SHA, with its tag in a comment, and
`npm ci --ignore-scripts` runs no dependency install scripts (none of the locked packages has
one).

To point the app at another deployment, set the repository variable `CAP_SERVER_URL`
(Settings › Secrets and variables › Actions › Variables), e.g. the production URL. It must be
`https://`.

### Locally (needs the Android SDK and Google's Maven repository)

```bash
cd mobile
npm ci
CAP_SERVER_URL=https://honest-os-staging.vercel.app npx cap sync android
cd android && ./gradlew testDebugUnitTest assembleDebug assembleRelease
# → android/app/build/outputs/apk/release/app-release.apk (pilot)
# → android/app/build/outputs/apk/debug/app-debug.apk (development only)
```

JDK 21 is required (Capacitor 8). `npx cap sync android` alone needs only npm; it also
writes `www/config.js` (the fallback page's "Try again" target) through the
`capacitor:copy:before` hook. Run it after changing `capacitor.config.ts`, the plugin
version or `CAP_SERVER_URL`. `npx cap open android` opens the project in Android Studio.

### Signing (pilot now, production later)

**The pilot APK is for the pilot only.** It is a release-type build signed with the Android
SDK's debug keystore (`signingConfig signingConfigs.debug` in `android/app/build.gradle`), so IT
can install it without a production keystore. That key is not protected (its password is the SDK's
well-known default) and each CI run creates a new one, so a newer pilot APK cannot update an
installed one: the rep ends the day (so every point is sent), IT uninstalls the old APK and
installs the new one. It is **not** for the Play Store or the fleet.

**Production needs a real keystore from GitHub secrets** (not built yet). When ready:

1. Create an upload/release keystore once, offline, and keep it in the company's password
   manager (never in Git; `*.jks` and `*.keystore` are ignored):
   `keytool -genkeypair -v -keystore honest-os-release.jks -alias honest-os -keyalg RSA -keysize 4096 -validity 10000`
2. Add GitHub **secrets**: `ANDROID_KEYSTORE_BASE64` (`base64 -w0 honest-os-release.jks`),
   `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.
3. Add a release job (manual trigger, protected environment) that decodes the keystore into
   `$RUNNER_TEMP`, runs `./gradlew assembleRelease` (or `bundleRelease` for Play) with a
   `signingConfigs.release` block that reads those values from environment variables (replacing
   the pilot's `signingConfigs.debug`), uploads the signed APK/AAB, and deletes the keystore file.
4. Bump `versionCode` / `versionName` in `android/app/build.gradle` for every release.

## Install on company phones

- **MDM (recommended for the fleet):** upload the APK as a private app in the MDM
  (e.g. Android Enterprise managed Google Play private app, or the MDM's own app catalogue).
  Through MDM IT can also: pre-grant location and notifications, exempt Honest OS from battery
  optimisation, and block uninstalling. The pilot uses the **pilot APK**
  (`honest-os-android-pilot`, `app-release.apk`), **never the debug APK**; the fleet needs the
  production-signed one (see above).
- **One phone by cable:** enable Developer options › USB debugging, then
  `adb install -r app-release.apk`. **Then turn USB debugging (and Developer options) off
  again**: left on, anyone with the phone and a laptop can install or inspect apps.
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

## Security

- **Guarded bridge (audit 4 F1).** The background-location plugin needs
  `android.useLegacyBridge: true` (with the WebMessage bridge, location callbacks stop after about
  5 minutes in the background; plugin README). Capacitor's legacy bridge registers itself with
  `addJavascriptInterface`, which every frame of every origin can reach, and its built-in
  CapacitorCookies / CapacitorHttp plugins add two more such interfaces. The app replaces that:
  - `HonestWebView` (used through the app's override of Capacitor's
    `capacitor_bridge_layout_main.xml`) intercepts those registrations. The bridge is registered
    with `addWebMessageListener` instead, which the WebView offers only to frames of the
    `server.url` origin; every other JavaScript interface is refused.
  - `BridgePolicy` checks every message: top frame only, exactly the `server.url` origin, a
    Capacitor plugin call (no Cordova), plugin `BackgroundGeolocation`, method `addWatcher`,
    `removeWatcher` or `openSettings`. CapacitorCookies, CapacitorHttp, WebView and SystemBars
    cannot be called at all. Refusals are logged (`HonestBridge`), without the message.
  - Replies still use the legacy path (`evaluateJavascript` on the page), which is what keeps
    background location callbacks flowing.
  - `MainActivity` refuses to start if the WebView is not `HonestWebView` (for example after a
    Capacitor update renamed its layout). Adding a native plugin means adding it to
    `BridgePolicy` on purpose.
- **No logs, no inspection (F3).** `loggingBehavior: "none"` (no plugin results, such as each
  location fix, in logcat) and `android.webContentsDebuggingEnabled: false` (no
  `chrome://inspect`) in every build; the pilot APK is not debuggable (no `adb run-as`).
- **Nothing leaves the phone (F3).** `allowBackup="false"` with `fullBackupContent` excluding
  everything (Android 11 and older), and `dataExtractionRules` excluding every domain from cloud
  backup and device-to-device transfer (Android 12+).
- **Residual risks:**
  - Code running in the deployment's own top frame (a script injected into the page) can still
    start or stop the location watcher or open the app settings, as the app itself does. The
    page's CSP is what limits that; the server never trusts a point's `source` more than a
    browser's.
  - On an Android System WebView too old for `addWebMessageListener` and document-start scripts
    (not updated for years), no bridge is exposed at all, so there is no background location
    (the shift card shows no points). On such a WebView Capacitor also fetches pages itself,
    which drops their security headers (CSP) and follows redirects to other hosts. Keep Android
    System WebView updated (Play Store, or enforce it through the MDM).
  - The pilot APK is signed with an unprotected debug key, so its signature proves little: install
    it only from this repository's workflow artifacts (the run's log prints its certificate's
    SHA-256 digest).

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
