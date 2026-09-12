# Lendpile – Full Documentation

Lendpile is a single-page loan and amortization tracker. Offline data stays in `localStorage`; signed-in data syncs through a Cloudflare Worker into Neon Postgres.

## Current Backend

- **Auth:** Neon Auth.
- **Data:** Neon Postgres tables in `neon/schema.sql`.
- **API:** Cloudflare Worker in `worker/src/index.js`.
- **Browser config:** `LENDPILE_API_URL` and `NEON_AUTH_URL` only. Never expose `NEON_DATABASE_URL`.

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
   - `window.NEON_AUTH_URL`
4. Run `neon/schema.sql` against your Neon database.
5. Deploy or run the Worker with Neon secrets.
6. Serve the repo locally, for example `npx serve .`, and open `/app.html`.

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
- Pages environment variable: `NEON_AUTH_URL`
- The production API endpoint is source-owned as `https://api.lendpile.com`; stale Pages variables cannot redirect it.

The Pages build copies only public browser files into `dist`, so repo-only files such as `.gitignore`, `neonconnect.txt`, `worker/`, and `neon/` are not published as static assets.

### Frontend update notifications

An open `app.html` tab checks its own document after 15 seconds and then every 60 seconds with `cache: "no-store"`. When the deployed `app-version` differs, Lendpile shows a user-confirmed Update dialog; it never reloads the page silently.

`npm run build:pages` automatically stamps `dist/app.html` with Cloudflare Pages' `CF_PAGES_COMMIT_SHA` and applies that value to local CSS/JavaScript URLs as a cache-busting query parameter. This means every Git-backed Pages deployment has a distinct version and the refreshed page receives matching assets. Local builds fall back to the `app-version` value in source `app.html`.

**Release contract:** production must publish the generated `dist` directory using the documented build command. Do not publish the source directory directly or remove the version check, version meta tag, or build stamping. If the hosting/build path changes, preserve this behavior and verify it with `node --test test/build-pages.test.js`.

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
