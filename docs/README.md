# Lendpile – Full Documentation

Lendpile is a single-page loan and amortization tracker. Offline data stays in `localStorage`; signed-in data syncs through a Cloudflare Worker into Neon Postgres.

## Current Backend

- **Auth:** Neon Auth.
- **Data:** Neon Postgres tables in `neon/schema.sql`.
- **API:** Cloudflare Worker in `worker/src/index.js`.
- **Browser config:** `LENDPILE_API_URL` and `NEON_AUTH_URL` (`/auth`). The upstream Neon URL is a Pages runtime binding, not a browser endpoint. Never expose `NEON_DATABASE_URL`.

## Neon Auth Settings

Configure Neon Auth before public signup:

- Add every deployed app domain to trusted origins, otherwise signup can fail with `INVALID_ORIGIN`.
- Require email verification.
- Use OTP verification:
  - `requireEmailVerification: true`
  - `emailVerificationMethod: "otp"`
  - `sendVerificationEmailOnSignUp: true`
  - `sendVerificationEmailOnSignIn: false`

The frontend has a signup verification code input, a resend button, and handles “account created but no session yet”.

## Local Setup

1. Run `npm install`.
2. Copy `config.example.js` to `config.js`.
3. Set:
   - `window.LENDPILE_API_URL`
   - Keep `window.NEON_AUTH_URL = "/auth"`
4. Run `neon/schema.sql` against your Neon database.
5. Deploy or run the Worker with Neon secrets.
6. Build with `NEON_AUTH_URL` set to the trusted Neon Auth upstream, then use Pages local development with that runtime binding and open `/app.html`. A static file server cannot run `/auth/*`. Use an HTTPS development origin registered in Neon for real cookie testing; do not relax Secure cookies or origin validation for localhost.

## Worker Setup

From `worker/`:

```sh
npm ci
npx wrangler deploy
```

Required Worker secrets:

- `NEON_DATABASE_URL`
- `NEON_AUTH_URL`
- `NEON_AUTH_JWKS_URL`

Optional Worker secrets:

- `ADMIN_SECRET` — API-key admin access.
- `ADMIN_TOTP_SECRET` — base32 TOTP secret for API-key admin access.

The Worker verifies JWTs using Neon JWKS. It does not trust decoded JWT payloads without signature verification.

## Cloudflare Pages

- Build command: `npm ci && npm run build:pages`
- Output directory: `dist`
- Pages build **and runtime** environment variable: `NEON_AUTH_URL` (existing trusted HTTPS Neon endpoint, e.g. `https://<endpoint>.neonauth.<region>.neon.tech/neondb/auth`). Keep it available to Functions, not only the build process.
- The production API endpoint is source-owned as `https://api.lendpile.com`; stale Pages variables cannot redirect it.

The build moves any existing `dist` into a unique `../build-archive/pages-*/dist` generation before creating the replacement. Prior artifacts are retained; never prune them automatically.

The Pages build copies only public browser files into `dist`, so repo-only files such as `.gitignore`, `neonconnect.txt`, `worker/`, and `neon/` are not published as static assets.

### Frontend update notifications

An open `app.html` tab checks its own document after 15 seconds and then every 60 seconds with `cache: "no-store"`. When the deployed `app-version` differs, Lendpile shows a user-confirmed Update dialog; it never reloads the page silently.

`npm run build:pages` automatically stamps `dist/app.html` with Cloudflare Pages' `CF_PAGES_COMMIT_SHA` and applies that value to local CSS/JavaScript URLs as a cache-busting query parameter. This means every Git-backed Pages deployment has a distinct version and the refreshed page receives matching assets. Local builds fall back to the `app-version` value in source `app.html`.

**Release contract:** production must publish the generated `dist` assets **and** compile the root `functions/` directory using the documented Pages build command. Pages Git integration discovers `functions/` at the project root, outside `dist`; uploading only static files is insufficient. Do not publish the source directory directly or remove the version check, version meta tag, or build stamping. If the hosting/build path changes, preserve this behavior and verify it with `node --test test/build-pages.test.js`.

## First-party auth proxy

`functions/auth/[[path]].js` serves `/auth/*` on the same origin as both `app.html` and `admin.html`. Generated config and the config template use `/auth`; `write-config` uses the same renderer as the Pages build. The admin config asset is version-stamped alongside app assets.

Only these method/path pairs are forwarded, with no query strings:

- `GET /auth/get-session`
- `POST /auth/sign-in/email`
- `POST /auth/sign-up/email`
- `POST /auth/sign-out`
- `POST /auth/email-otp/send-verification-otp`
- `POST /auth/email-otp/verify-email`

POST requires JSON and an exact same-origin `Origin`. Foreign origins and cross-site/same-site fetch metadata are rejected, including on GET. The original Origin is forwarded unchanged; missing GET Origin is not manufactured. Neon must still trust `https://lendpile.com` (and any deliberately enabled preview origin). Do not work around `INVALID_ORIGIN` by rewriting Origin, disabling CSRF, or relaxing email verification. The API Worker's JWT signature verification is unchanged.

The destination comes only from the Pages binding, validated as an HTTPS Neon Auth host with a database `/auth` base path. Browser headers cannot choose the destination. The proxy does not forward Authorization, host overrides, unrelated cookies, or CORS response headers. Only `__Secure-neon-auth.session_token`, `__Secure-neon-auth.dont_remember`, and `__Secure-neon-auth.session_data` (including numbered data chunks) pass in either direction. OAuth and SDK-local cache cookies are outside the current password/OTP contract.

Response cookies retain their names, opaque values, Max-Age and Expires, including deletion. Each remains a separate Set-Cookie header and becomes Secure, HttpOnly, host-only, SameSite=Lax, Path=/auth. No cookies or sessions are minted locally. The `set-auth-jwt` response header remains available to same-origin callers. Requests and responses use no-store, upstream redirects fail closed, request JSON is limited to 64 KiB, and upstream bodies are limited to 256 KiB. A 10-second deadline covers request reading, fetching and response reading; timed-out or oversized streams are cancelled. Oversized requests return 413, while upstream overflow and other upstream failures expose only a generic proxy error. The proxy logs no request bodies, cookies, sessions or secrets.

OTP success without a retrievable session now reports that the email was verified but the user must sign in; it does not report successful authentication. Signup enters the OTP flow only when Neon explicitly returns an unverified user, rather than treating every session failure as verification pending.

### Coordinator release and rollback

This implementation is local only. The coordinator owns review, commit/push and deployment. Repository documentation specifies Pages with `dist` output; there is no root Wrangler deployment config or checked-in CI workflow. Confirm the actual Pages project uses the intended Git integration, repository root, build command and runtime binding before releasing. Normal release is the reviewed Git commit through that integration; match the deployed revision to the commit. Do not deploy the data Worker for this proxy change.

Pages must include the root Functions source; use the Pages Git build or a coordinator-approved Pages CLI deployment from the project root. A static dashboard upload of `dist` alone does not install this function. See [Pages Functions setup](https://developers.cloudflare.com/pages/functions/get-started/) and [routing](https://developers.cloudflare.com/pages/functions/routing/).

For rollback, restore the previous **complete Pages deployment** (assets and Functions together), and reconcile the rollback in Git before the next release. The archived local `dist` is an asset backup, not a standalone Functions deployment backup. Returning to the previous direct-Neon browser config also returns the Safari third-party-cookie limitation. First-party cookies and old upstream-domain cookies are separate; existing users may need to sign in again. This change cannot delete cookies belonging to the Neon domain.

### Local and live acceptance

- `npm test`: proxy security, cookie renewal/deletion lifecycle, OTP/session regressions, browser config and existing application tests.
- `npm run build:pages`: archives the prior assets and builds the same-origin browser bundle (requires the build binding).
- `node scripts/verify-auth-proxy-runtime.js`: after building and installing existing `worker/` devDependencies, compiles Pages Functions into temporary staging inside `dist`, checks generated `/auth/*` routing, and exercises workerd login/session/sign-out, multiple Set-Cookie, origin rejection and static fallback against an in-process upstream fixture. No upstream network or credentials are used; only its own staging is removed.
- Coordinator live acceptance: confirm `/auth/get-session` is a no-store JSON response, not static fallback; validate runtime binding and Neon trusted origins; verify actual upstream cookie names match the allowlist; test Safari signup/resend/invalid OTP/valid OTP/login, reload persistence, expiry/renewal and sign-out followed by reload; repeat admin login/logout. Check Secure/HttpOnly/host-only/SameSite/Path and separate deletion headers in browser tools without copying session values into logs. Confirm Worker API JWT authorization still works and rejects invalid JWTs. Local fixtures do not prove Safari or live Neon behavior.

## Preserving Existing Lendpile Users

The legacy user-ID migration is completed. Preserved account data and share references are already stored under their Neon Auth user IDs. The Worker no longer performs login-time claiming or database rewrites.

## Admin

Open `admin.html`. Admin access works with:

- A signed-in Neon Auth user who is in `admin_users`.
- `ADMIN_SECRET`, optionally protected with `ADMIN_TOTP_SECRET`.

Admin membership is fail-closed: account creation, account age, and email address never grant admin access. Add or remove signed-in administrators explicitly in `admin_users` using their Neon Auth user ID.

## Verification Checklist

- `GET /health` returns `provider: "neon"` and `auth: "neon-auth"`.
- `config.js` exposes `LENDPILE_API_URL` and `NEON_AUTH_URL`, not database secrets.
- Signup creates an unverified user and shows the OTP entry UI.
- Resend calls Neon’s OTP resend endpoint.
- Verify calls Neon’s OTP verify endpoint.
- Signin works after verification and does not trigger duplicate OTPs.
- App data and shares read/write through the Worker into Neon Postgres.
