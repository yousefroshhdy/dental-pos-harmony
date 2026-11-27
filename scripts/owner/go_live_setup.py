#!/usr/bin/env python3
"""
Honest OS - owner go-live setup for STAGING (run on your own computer).

What it does, one step at a time (you choose the step from a menu):
  1. Secrets   - put a NEW Supabase secret key and two NEW random secrets
                 (CRON_SECRET, OUTBOX_SIGNING_SECRET) into Vercel as "Sensitive",
                 then redeploy. You create the new Supabase secret key yourself
                 in the Supabase dashboard first (two clicks); the script asks for it.
  2. Google    - enable Maps JavaScript / Places (New) / Geocoding, create a
                 restricted browser key and a restricted server key, put them in
                 Vercel, add a monthly budget alert, redeploy. Needs the Google
                 Cloud CLI ("gcloud") installed and signed in.
  3. Supabase  - exposed schemas "api, service", leaked-password protection,
                 and (optional) your SMTP server for e-mails.
  4. Check     - read-only: shows what is set now (names only, never values).

Safety:
  - Read-only unless you start it with --apply. Even then, every change asks
    you to type "yes" first.
  - Tokens and keys are typed with a hidden prompt and are never printed,
    logged or written to disk.
  - Uses only the Python standard library (Python 3.9+).

Run (Windows, in PowerShell, from the folder that holds this file):
    py go_live_setup.py            # look only (read-only)
    py go_live_setup.py --apply    # make changes, asking before each one

Tokens it will ask for (create them yourself; never paste them in a chat):
  - Vercel token:    https://vercel.com/account/tokens  (scope: the team that owns honest-os-staging)
  - Supabase token:  https://supabase.com/dashboard/account/tokens
"""

from __future__ import annotations

import getpass
import json
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# --- Fixed project identifiers (not secrets) --------------------------------
SUPABASE_REF = "hhdctubhbdqriyqwjgfk"
VERCEL_PROJECT = "prj_DvbqD41K1FpuVTNTzi6z2VYy2DuG"
VERCEL_PROJECT_NAME = "honest-os-staging"
VERCEL_TEAM = "team_KmeSUQtMAZNNh9yjszbSGkJn"
APP_URL = "https://honest-os-staging.vercel.app"
EXPOSED_SCHEMAS = "api,service"
SENDER_EMAIL_DEFAULT = "no-reply@honesteg.co"
SENDER_NAME_DEFAULT = "Honest OS"

GOOGLE_SERVICES_BROWSER = ["maps-backend.googleapis.com"]  # Maps JavaScript API
GOOGLE_SERVICES_SERVER = ["places.googleapis.com", "geocoding-backend.googleapis.com"]  # Places (New), Geocoding
GOOGLE_SERVICES_EXTRA = ["apikeys.googleapis.com", "billingbudgets.googleapis.com"]
BROWSER_KEY_NAME = "honest-os-staging-browser"
SERVER_KEY_NAME = "honest-os-staging-server"

APPLY = "--apply" in sys.argv


# --- Small helpers -----------------------------------------------------------
def say(msg: str = "") -> None:
    print(msg, flush=True)


def confirm(question: str) -> bool:
    if not APPLY:
        say(f"  [read-only] would ask: {question}  -> skipped (start with --apply to change things)")
        return False
    answer = input(f"  {question} Type yes to continue: ").strip().lower()
    return answer == "yes"


def ask_secret(label: str, must_start: str | None = None) -> str:
    while True:
        value = getpass.getpass(f"  {label} (hidden, paste and press Enter): ").strip()
        if not value:
            say("  Nothing entered.")
            continue
        if must_start and not value.startswith(must_start):
            say(f"  That does not look right (it should start with '{must_start}'). Try again.")
            continue
        return value


def http(method: str, url: str, token: str, body: dict | None = None) -> tuple[int, object]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode() or "null"
            return resp.status, json.loads(raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            parsed: object = json.loads(raw)
        except ValueError:
            parsed = raw[:300]
        return e.code, parsed


def short_error(payload: object) -> str:
    """An error message without echoing anything that could hold a value we sent."""
    if isinstance(payload, dict):
        err = payload.get("error") if isinstance(payload.get("error"), dict) else payload
        msg = err.get("message") or err.get("msg") or err.get("code") or ""
        return str(msg)[:200]
    return str(payload)[:200]


# --- Vercel ------------------------------------------------------------------
class Vercel:
    base = "https://api.vercel.com"

    def __init__(self, token: str) -> None:
        self.token = token

    def _q(self, extra: dict | None = None) -> str:
        q = {"teamId": VERCEL_TEAM}
        q.update(extra or {})
        return urllib.parse.urlencode(q)

    def check(self) -> bool:
        code, body = http("GET", f"{self.base}/v9/projects/{VERCEL_PROJECT}?{self._q()}", self.token)
        if code != 200:
            say(f"  Vercel: cannot read the project ({code}: {short_error(body)}). Check the token's team scope.")
            return False
        say(f"  Vercel: project '{body.get('name')}' found.")
        return True

    def envs(self) -> list[dict]:
        code, body = http("GET", f"{self.base}/v10/projects/{VERCEL_PROJECT}/env?{self._q()}", self.token)
        if code != 200:
            raise RuntimeError(f"Vercel env list failed ({code}: {short_error(body)})")
        return body.get("envs", []) if isinstance(body, dict) else []

    def show_envs(self) -> None:
        for e in sorted(self.envs(), key=lambda x: x.get("key", "")):
            say(f"    {e.get('key'):<34} type={e.get('type'):<10} targets={','.join(e.get('target') or [])}")

    def replace_env(self, key: str, value: str, sensitive: bool) -> None:
        """Delete every existing variable with this name, then add it again.
        The running site keeps its old values until the next deployment, so the
        short gap between delete and add does not affect users."""
        for e in self.envs():
            if e.get("key") == key:
                code, body = http("DELETE", f"{self.base}/v9/projects/{VERCEL_PROJECT}/env/{e['id']}?{self._q()}", self.token)
                if code not in (200, 204):
                    raise RuntimeError(f"could not remove old {key} ({code}: {short_error(body)})")
        body = {"key": key, "value": value, "type": "sensitive" if sensitive else "encrypted",
                "target": ["production", "preview"]}
        code, resp = http("POST", f"{self.base}/v10/projects/{VERCEL_PROJECT}/env?{self._q()}", self.token, body)
        if code not in (200, 201):
            raise RuntimeError(f"could not add {key} ({code}: {short_error(resp)}). Add it by hand in Vercel now.")
        say(f"    {key}: set ({'Sensitive' if sensitive else 'Encrypted'}, Production + Preview)")

    def redeploy_and_wait(self) -> bool:
        code, body = http("GET", f"{self.base}/v7/deployments?{self._q({'projectId': VERCEL_PROJECT, 'target': 'production', 'limit': '1'})}", self.token)
        deps = body.get("deployments", []) if isinstance(body, dict) else []
        if code != 200 or not deps:
            say(f"  Could not find the current production deployment ({code}). Redeploy by hand: Vercel > Deployments > ... > Redeploy.")
            return False
        current = deps[0]["uid"]
        code, body = http("POST", f"{self.base}/v13/deployments?{self._q({'forceNew': '1'})}", self.token,
                          {"name": VERCEL_PROJECT_NAME, "deploymentId": current, "target": "production"})
        if code not in (200, 201):
            say(f"  Redeploy failed ({code}: {short_error(body)}). Redeploy by hand in Vercel.")
            return False
        new_id = body.get("id") or body.get("uid")
        say(f"  Redeploying ({new_id}). This takes about 1-3 minutes...")
        for _ in range(60):
            time.sleep(10)
            code, d = http("GET", f"{self.base}/v13/deployments/{new_id}?{self._q()}", self.token)
            state = (d or {}).get("readyState") if isinstance(d, dict) else None
            if state == "READY":
                say("  Deployment is READY.")
                return True
            if state in ("ERROR", "CANCELED"):
                say(f"  Deployment ended with {state}. Open Vercel > Deployments to see the log.")
                return False
        say("  Still building after 10 minutes; check Vercel > Deployments.")
        return False


def site_answers() -> bool:
    try:
        with urllib.request.urlopen(f"{APP_URL}/ar/login", timeout=30) as resp:
            ok = resp.status == 200
    except Exception as e:  # noqa: BLE001 - report any network problem plainly
        say(f"  The site did not answer: {e}")
        return False
    say(f"  {APP_URL}/ar/login answers: {'OK' if ok else 'not OK'}")
    return ok


# --- Supabase Management API -------------------------------------------------
class Supabase:
    base = "https://api.supabase.com/v1"

    def __init__(self, token: str) -> None:
        self.token = token

    def check(self) -> bool:
        code, body = http("GET", f"{self.base}/projects/{SUPABASE_REF}", self.token)
        if code != 200:
            say(f"  Supabase: cannot read the project ({code}: {short_error(body)}).")
            return False
        say(f"  Supabase: project '{body.get('name')}' found ({body.get('status')}).")
        return True

    def show(self) -> None:
        code, pg = http("GET", f"{self.base}/projects/{SUPABASE_REF}/postgrest", self.token)
        if code == 200 and isinstance(pg, dict):
            say(f"    Exposed schemas now: {pg.get('db_schema')}   (wanted: {EXPOSED_SCHEMAS})")
        code, auth = http("GET", f"{self.base}/projects/{SUPABASE_REF}/config/auth", self.token)
        if code == 200 and isinstance(auth, dict):
            say(f"    Leaked-password protection: {'ON' if auth.get('password_hibp_enabled') else 'off'}")
            say(f"    Custom SMTP: {'set (' + str(auth.get('smtp_host')) + ')' if auth.get('smtp_host') else 'not set'}")

    def set_schemas(self) -> None:
        code, body = http("PATCH", f"{self.base}/projects/{SUPABASE_REF}/postgrest", self.token, {"db_schema": EXPOSED_SCHEMAS})
        say(f"    Exposed schemas: {'done' if code == 200 else f'FAILED ({code}: {short_error(body)})'}")

    def set_leaked_password_protection(self) -> None:
        code, body = http("PATCH", f"{self.base}/projects/{SUPABASE_REF}/config/auth", self.token, {"password_hibp_enabled": True})
        if code == 200:
            say("    Leaked-password protection: ON")
        else:
            say(f"    Leaked-password protection: FAILED ({code}: {short_error(body)}). It may need a paid Supabase plan.")

    def set_smtp(self) -> None:
        host = input("    SMTP host (e.g. smtp.gmail.com): ").strip()
        port = input("    SMTP port [587]: ").strip() or "587"
        user = input("    SMTP username: ").strip()
        password = ask_secret("SMTP password")
        sender = input(f"    Sender e-mail [{SENDER_EMAIL_DEFAULT}]: ").strip() or SENDER_EMAIL_DEFAULT
        name = input(f"    Sender name [{SENDER_NAME_DEFAULT}]: ").strip() or SENDER_NAME_DEFAULT
        if not (host and user):
            say("    Host and username are required; SMTP not changed.")
            return
        body = {"smtp_host": host, "smtp_port": port, "smtp_user": user, "smtp_pass": password,
                "smtp_admin_email": sender, "smtp_sender_name": name}
        code, resp = http("PATCH", f"{self.base}/projects/{SUPABASE_REF}/config/auth", self.token, body)
        say(f"    SMTP: {'saved' if code == 200 else f'FAILED ({code}: {short_error(resp)})'}")


# --- Google Cloud (via the gcloud CLI) -------------------------------------
def gcloud(*args: str, capture: bool = True) -> tuple[int, str]:
    exe = shutil.which("gcloud")
    if not exe:
        return 127, "gcloud not found"
    # --quiet: never wait on a hidden yes/no prompt (output is captured).
    proc = subprocess.run([exe, *args, "--quiet"], capture_output=capture, text=True, stdin=subprocess.DEVNULL)
    out = (proc.stdout or "") if capture else ""
    if proc.returncode != 0 and capture:
        out = (proc.stderr or proc.stdout or "")[-400:]
    return proc.returncode, out.strip()


def google_key(project: str, display: str, services: list[str], referrer: str | None) -> str | None:
    """Create (or reuse) a restricted API key and return its value, never printing it."""
    code, name = gcloud("services", "api-keys", "list", f"--project={project}",
                        f'--filter=displayName="{display}"', "--format=value(name)")
    name = name.splitlines()[0] if code == 0 and name else ""
    if not name:
        args = ["services", "api-keys", "create", f"--project={project}", f"--display-name={display}"]
        for s in services:
            args.append(f"--api-target=service={s}")
        if referrer:
            args.append(f"--allowed-referrers={referrer}")
        code, out = gcloud(*args)
        if code != 0:
            say(f"    Creating key '{display}' failed: {out}")
            return None
        code, name = gcloud("services", "api-keys", "list", f"--project={project}",
                            f'--filter=displayName="{display}"', "--format=value(name)")
        name = name.splitlines()[0] if code == 0 and name else ""
        say(f"    Key '{display}' created.")
    else:
        say(f"    Key '{display}' already exists; reusing it.")
    if not name:
        say(f"    Could not find key '{display}' after creating it.")
        return None
    code, value = gcloud("services", "api-keys", "get-key-string", name, f"--project={project}", "--format=value(keyString)")
    if code != 0 or not value:
        say(f"    Could not read the value of key '{display}'.")
        return None
    return value


# --- Steps -------------------------------------------------------------------
def step_secrets(v: Vercel) -> None:
    say("\nSTEP 1 - New secrets in Vercel (Sensitive) + redeploy")
    say("  First, in your browser: Supabase > honest-os-staging > Project Settings > API Keys >")
    say("  Secret keys > 'Create new secret key'. Copy it. Do NOT delete the old key yet.")
    if not confirm("Replace SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET and OUTBOX_SIGNING_SECRET, then redeploy?"):
        return
    new_key = ask_secret("New Supabase secret key", must_start="sb_secret_")
    try:
        v.replace_env("SUPABASE_SERVICE_ROLE_KEY", new_key, sensitive=True)
        v.replace_env("CRON_SECRET", secrets.token_hex(32), sensitive=True)
        v.replace_env("OUTBOX_SIGNING_SECRET", secrets.token_hex(32), sensitive=True)
    except RuntimeError as e:
        say(f"  STOPPED: {e}")
        return
    finally:
        new_key = ""  # drop the reference
    if v.redeploy_and_wait() and site_answers():
        say("  Now sign in at the site to check it works. If it does, go back to Supabase >")
        say("  API Keys and DELETE the OLD secret key (the one you did not just create).")


def step_google(v: Vercel) -> None:
    say("\nSTEP 2 - Google Maps keys + budget alert")
    if not shutil.which("gcloud"):
        say("  The Google Cloud CLI is not installed. Install it from https://cloud.google.com/sdk/docs/install,")
        say("  run 'gcloud auth login', then run this step again.")
        return
    code, acct = gcloud("config", "get-value", "account")
    say(f"  gcloud signed in as: {acct or '(nobody - run: gcloud auth login)'}")
    project = input("  Google Cloud project ID to use (create it first in console.cloud.google.com): ").strip()
    if not project:
        return
    if not confirm(f"Enable the Maps APIs in '{project}', create 2 restricted keys, put them in Vercel and add a budget?"):
        return
    code, out = gcloud("services", "enable", "cloudbilling.googleapis.com", f"--project={project}")
    if code != 0:
        say(f"  Could not enable the billing API: {out}")
        return
    code, billing = gcloud("billing", "projects", "describe", project, "--format=value(billingAccountName)")
    say(f"  Billing account linked: {billing or 'NONE'}")
    if not billing:
        say("  Link a billing account first: console.cloud.google.com > Billing > link this project. Then run step 2 again.")
        return
    code, out = gcloud("services", "enable", *GOOGLE_SERVICES_BROWSER, *GOOGLE_SERVICES_SERVER, *GOOGLE_SERVICES_EXTRA,
                       f"--project={project}")
    if code != 0:
        say(f"  Enabling the APIs failed: {out}")
        return
    say("  APIs enabled: Maps JavaScript, Places (New), Geocoding (+ API keys, budgets).")
    browser = google_key(project, BROWSER_KEY_NAME, GOOGLE_SERVICES_BROWSER, f"{APP_URL}/*")
    server = google_key(project, SERVER_KEY_NAME, GOOGLE_SERVICES_SERVER, None)
    if not (browser and server):
        say("  STOPPED: a key is missing; nothing was changed in Vercel.")
        return
    try:
        v.replace_env("NEXT_PUBLIC_GOOGLE_MAPS_API_KEY", browser, sensitive=False)  # shown in browsers by design
        v.replace_env("GOOGLE_MAPS_SERVER_KEY", server, sensitive=True)
    except RuntimeError as e:
        say(f"  STOPPED: {e}")
        return
    finally:
        browser = server = ""
    amount = input("  Monthly budget alert amount, in your billing currency [50]: ").strip() or "50"
    currency = input("  Billing currency code [USD]: ").strip().upper() or "USD"
    billing_id = billing.split("/")[-1]
    code, out = gcloud("billing", "budgets", "create", f"--billing-account={billing_id}",
                       "--display-name=Honest OS maps", f"--budget-amount={amount}{currency}",
                       "--threshold-rule=percent=0.5", "--threshold-rule=percent=0.9", "--threshold-rule=percent=1.0",
                       f"--filter-projects=projects/{project}")
    say("  Budget alert: created (e-mails go to the billing account admins)." if code == 0
        else f"  Budget alert FAILED: {out}  (add it by hand: Billing > Budgets & alerts)")
    if v.redeploy_and_wait():
        site_answers()
        say("  Check: open /ar/map on the site - a Google map should show.")


def step_supabase(s: Supabase) -> None:
    say("\nSTEP 3 - Supabase settings")
    s.show()
    if confirm(f"Set exposed schemas to '{EXPOSED_SCHEMAS}'?"):
        s.set_schemas()
    if confirm("Turn on leaked-password protection?"):
        s.set_leaked_password_protection()
    if APPLY and input("  Set up your SMTP server for e-mails now? (yes/no): ").strip().lower() == "yes":
        s.set_smtp()


def step_check(v: Vercel | None, s: Supabase | None) -> None:
    say("\nSTEP 4 - What is set now (names only, never values)")
    if v:
        say("  Vercel environment variables:")
        v.show_envs()
    if s:
        say("  Supabase:")
        s.show()
    site_answers()


def main() -> None:
    say("Honest OS - owner go-live setup (staging)")
    say("Mode: " + ("APPLY (asks before every change)" if APPLY else "READ-ONLY (start with --apply to change things)"))
    say("Tokens are typed hidden and never shown or saved.\n")
    v = Vercel(ask_secret("Vercel token"))
    if not v.check():
        return
    s_token = getpass.getpass("  Supabase access token (hidden; Enter to skip Supabase steps): ").strip()
    s = Supabase(s_token) if s_token else None
    if s and not s.check():
        s = None
    while True:
        say("\nChoose a step:\n  1  New secrets in Vercel + redeploy\n  2  Google Maps keys + budget\n"
            "  3  Supabase settings (schemas, leaked passwords, SMTP)\n  4  Show what is set now\n  0  Quit")
        choice = input("Step: ").strip()
        if choice == "1":
            step_secrets(v)
        elif choice == "2":
            step_google(v)
        elif choice == "3":
            if s:
                step_supabase(s)
            else:
                say("  Supabase token not given; restart the script to use this step.")
        elif choice == "4":
            step_check(v, s)
        elif choice == "0":
            say("Done. Next: MFA on /ar/account/security, then /ar/admin/setup (see docs/runbooks/owner-go-live.md).")
            return


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        say("\nStopped.")
