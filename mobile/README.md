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

## Install the pilot app, step by step (IT and reps)

**Status of these steps: Planned.** They follow the app's manifest and the plugin's source; nobody
has run them on a phone yet. The owner's test day (`docs/TESTING.md` §6) is the first run.

Before you start: **no real use before the D-03 legal review** (see the top of this file). Use the
one pilot phone and a test account.

### 1. Get a fresh pilot APK (IT, on a computer)

1. Open the repository on GitHub › **Actions** › **Android** (left column).
2. Open the latest run with a green tick on branch `ccr-cd8ec6c2-y28xig`.
3. Under **Artifacts**, download **`honest-os-android-pilot`**. It is a ZIP; unzip it to get
   **`app-release.apk`**. Never use `honest-os-android-debug` on a rep's phone.
4. **Artifacts expire after 14 days.** If the run is older, or the artifact is gone: Actions ›
   **Android** › **Run workflow** (top right) › branch `ccr-cd8ec6c2-y28xig` › **Run workflow**.
   Wait about 10 minutes for the green tick, then download as above.
5. Optional check: the run's log, step "Check the pilot APK", prints the APK's signing
   certificate (SHA-256). Install only an APK downloaded from this repository's run.

### 2. Remove the old app (on the phone)

Each CI run signs the pilot with a new key, so a new APK cannot update an installed one
("App not installed" / "package conflicts"). Remove the old one first:

1. If the rep's working day is open: open Honest OS, wait until the shift card shows
   **"All points sent"**, then tap **End my day**. Uninstalling deletes points still waiting on
   the phone.
2. Settings › **Apps** › **Honest OS** › **Uninstall** › OK.

### 3. Install the new APK (on the phone)

**Without a computer (usual):**

1. Copy `app-release.apk` to the phone (USB file transfer, or a company channel). Do not
   forward it through public chats.
2. Open the **Files** app (Samsung: **My Files**), tap `app-release.apk`.
3. Android says the phone is not allowed to install unknown apps from this source: tap
   **Settings**, turn on **Allow from this source**, go back, tap **Install**.
4. If Google Play Protect warns about an unknown app: **More details** › **Install anyway**
   (the pilot is not on the Play Store).
5. After installing: Settings › Apps › (the Files app) › **Install unknown apps** › turn
   **Allow from this source** off again.

**With a cable (IT):**

1. On the phone: Settings › About phone › tap **Build number** 7 times (Developer options
   appear), then Settings › System › Developer options › **USB debugging** on.
2. On the computer: `adb install app-release.apk`.
3. **Then turn USB debugging off, and Developer options off** (Settings › System › Developer
   options › top switch off). Left on, anyone with the phone and a laptop can install or
   inspect apps.

### 4. Allow notifications (first start)

Open **Honest OS**. On Android 13 and newer it asks **"Allow Honest OS to send you
notifications?"** › **Allow**. The permanent notification "Honest OS is recording your location
for your working day" is what keeps tracking running in the background. (If it was refused:
Settings › Apps › Honest OS › Notifications › on.)

### 5. Sign in

Enter the rep's **work email**, then either the password or **"Email me a sign-in code"** and the
numeric code from the email. Use the code, not the link in the same email: the link opens the
phone's browser, not the app.

### 6. Allow location (at the first "Start my day")

On **Today**, tap **Start my day** (after reading and accepting the tracking notice the first
time). Android asks for location:

1. Choose **"While using the app"** (Settings wording: **"Allow only while using the app"**).
2. Keep **"Precise"** / **"Use precise location"** on.
3. Do **not** choose **"Only this time"** or **"Ask every time"**: tracking would stop when the app
   is closed.

**About "Allow all the time".** The owner's brief asked for it, but **the phone will not offer
it**, and it is not needed. Checked in the app's manifest and the plugin's source
(`@capacitor-community/background-geolocation` 1.3.1):

- The app does **not** declare `ACCESS_BACKGROUND_LOCATION` (2026-10-30 audit; see
  `android/app/src/main/AndroidManifest.xml`), and the plugin asks only for
  `ACCESS_COARSE_LOCATION` + `ACCESS_FINE_LOCATION`. Android shows "Allow all the time" only to
  apps that declare background location, so the choices are "Allow only while using the app",
  "Ask every time" and "Don't allow".
- Background recording works through a **foreground service of type `location`** with a
  permanent notification (`FOREGROUND_SERVICE_LOCATION`). Android lets a foreground service that
  was started while the app was on screen ("Start my day") keep using a "while using the app"
  permission when the screen is off or another app is open.
- What stops it: swiping Honest OS away from recent apps, the phone's battery saver killing the
  app (step 7), or notifications being off. Then the day shows gaps, and the manager's health
  panel shows "Needs attention" after 15 minutes.

If location was refused: Settings › Apps › Honest OS › **Permissions** › **Location** › **Allow
only while using the app**, "Use precise location" on. The shift card's **Open app settings**
button opens that page.

### 7. Turn battery optimisation off for Honest OS

Android, and some brands much more than others, stop background apps to save battery.

| Phone | Where |
|---|---|
| **All (Android 12+)** | Settings › Apps › Honest OS › **Battery** › **Unrestricted** (older: Battery optimisation › All apps › Honest OS › **Don't optimise**) |
| **Samsung** (One UI) | the above, and Settings › Battery › **Background usage limits**: remove Honest OS from **Sleeping apps** and **Deep sleeping apps**, add it to **Never sleeping apps**; turn **Put unused apps to sleep** off |
| **Xiaomi / Redmi / Poco** (MIUI, HyperOS) | Settings › Apps › Manage apps › Honest OS: **Autostart** on; **Battery saver** › **No restrictions**; in recent apps, long-press Honest OS › **lock** |
| **Oppo / Realme / OnePlus** (ColorOS, realme UI) | Settings › Apps › App management › Honest OS › **Battery usage**: **Allow background activity** on, **Allow auto launch** on (older: **Don't optimise**); lock it in recent apps |
| **Huawei / Honor** (EMUI, MagicOS) | Settings › Battery › **App launch** › Honest OS: switch **Manage automatically** off, then keep **Auto-launch**, **Secondary launch** and **Run in background** on; lock it in recent apps |
| **MDM** | allow-list Honest OS from battery optimisation for every device at once |

Menu names change between versions; <https://dontkillmyapp.com> has model-specific steps. Also
check that the phone-wide **Battery saver / Power saving mode** is off during the working day.

### 8. Check it works (rep and manager together)

1. Rep: **Start my day**. The notification appears; the shift card says "On shift".
2. Lock the phone for 15 minutes, then open the app: the shift card shows a recent "Last point".
3. Manager: **Tracking** › **Tracking health now**: the rep's row shows "Day open", a last point a
   few minutes old, "Android app", location "Allowed", and no "Needs attention" badge.

### 9. After installing (IT)

- **USB debugging and Developer options off** (step 3), **Install unknown apps** off again.
- The phone keeps the notification permission, location "while using the app", and battery
  "Unrestricted".

### MDM (later, for the fleet)

Upload the APK as a private app in the MDM (e.g. Android Enterprise managed Google Play). The
MDM can pre-grant location and notifications, exempt Honest OS from battery optimisation, and
block uninstalling. The fleet needs the production-signed APK (see Signing), not the pilot one.

## Permissions (what the app declares)

Declared in `android/app/src/main/AndroidManifest.xml`:

| Permission | Why |
|---|---|
| `INTERNET` | the web app |
| `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` | the location itself (precise is needed for visits and stops) |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_LOCATION` | the location service with its permanent notification (type `location`, required from Android 14) |
| `POST_NOTIFICATIONS` | showing that notification (Android 13+); asked once when the app starts |

`ACCESS_BACKGROUND_LOCATION` is **not** requested: the service is started while the app is in
the foreground ("Start my day") and keeps running with its notification. Adding it later would
need a Play Store background-location declaration, and on Android 11 and newer "Allow all the
time" would still be granted only in Settings, never in the first dialog. It is not needed for
the pilot.

## What the app reports to the manager

While the day is open, the app sends a small status report at "Start my day" and every 5
minutes (`api.report_device_status`, at most once a minute per shift): which collector runs
(Android app or browser), the location permission as the phone knows it (allowed, refused,
location off, not asked, unknown), the app version, battery saver (not available yet: no web
API reports it, so "Not reported"), and how many points are still waiting on the phone. No
location, no phone model, no identifiers. Managers see it on **Tracking › Tracking health now**.

**App version:** the pilot shell has no `@capacitor/app` plugin and its guarded bridge allows only
the background-location plugin, so the app version shows as the **web build** (the deployment's
commit). To show the APK's own version, add `@capacitor/app` and allow `App.getInfo` in
`BridgePolicy` (a deliberate bridge change, with a test), or set `appendUserAgent` in
`capacitor.config.ts`.

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
