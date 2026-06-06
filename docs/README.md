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

- `LENDPILE_ADMIN_EMAILS` — comma-separated admin recovery/bootstrap allowlist.
- `ADMIN_SECRET` — API-key admin access.
- `ADMIN_TOTP_SECRET` — base32 TOTP secret for API-key admin access.

The Worker verifies JWTs using Neon JWKS. It does not trust decoded JWT payloads without signature verification.

## Cloudflare Pages

- Build command: `npm ci && npm run build:pages`
- Output directory: `dist`
- Pages environment variables:
  - `LENDPILE_API_URL`
  - `NEON_AUTH_URL`
  - Optional `ADMIN_API_URL`

The Pages build copies only public browser files into `dist`, so repo-only files such as `.gitignore`, `neonconnect.txt`, `worker/`, and `neon/` are not published as static assets.

## Preserving Existing Lendpile Users

Lendpile has existing users that must be preserved. Existing app data has already been imported into Neon under legacy user IDs and will be claimed by email on first login.

When `david@mailo.se` and `pamela@familj-sjodin.se` sign up/sign in with those same emails, the Worker rewrites their legacy app data and share references to their Neon Auth user IDs.

### Existing Neon Project

The existing Lendpile Neon database was reset to the current `neon/schema.sql` app schema and loaded with preserved account data.

Current migrated state:

- `legacy_user_map`: 2 users
- `loan_data`: 2 user rows
- `loan_shares`: 1 redeemed shared-loan row
- `profiles`: 2 rows

When each preserved user signs up/signs in with the same email, the Worker claims their old UUID-keyed data and rewrites ownership/share references to the new Neon Auth user ID.

## Admin

Open `admin.html`. Admin access works with:

- A signed-in Neon Auth user who is in `admin_users`.
- A signed-in Neon Auth user whose email is in `LENDPILE_ADMIN_EMAILS`.
- The first Neon Auth user when no active admin exists yet.
- `ADMIN_SECRET`, optionally protected with `ADMIN_TOTP_SECRET`.

## Verification Checklist

- `GET /health` returns `provider: "neon"` and `auth: "neon-auth"`.
- `config.js` exposes `LENDPILE_API_URL` and `NEON_AUTH_URL`, not database secrets.
- Signup creates an unverified user and shows the OTP entry UI.
- Resend calls Neon’s OTP resend endpoint.
- Verify calls Neon’s OTP verify endpoint.
- Signin works after verification and does not trigger duplicate OTPs.
- App data and shares read/write through the Worker into Neon Postgres.
