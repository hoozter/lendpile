# Lendpile – Full documentation

Reference for setup, deployment, database, admin, and project structure.

---

## Overview

Lendpile is a single-page loan and amortization tracker. Data lives in **localStorage** by default. When the user signs in (Supabase Auth), the same data syncs to Supabase so it can be restored on another device or browser. “Continue without an account” keeps everything in the browser only.

**Stack:** Plain HTML/CSS/JS (no bundler). `app.html` loads ECharts and Supabase from CDNs, then `config.js`, `styles.css`, and `app.js`. The only build step for deployment is `node scripts/write-config.js` to generate `config.js` from environment variables.

**Auth & sync:** Supabase handles sign-in, sign-up, sign-out, and session. One table `loan_data` stores `user_id` and a JSON `data` column; one row per user, upserted on save. Sharing uses `loan_shares` and RPCs defined in the schema.

---

## Requirements

- Modern browser (JavaScript enabled).
- For sync: a Supabase project and `config.js` (see below).
- For account deletion and admin: a backend (Cloudflare Worker or Supabase Edge Function for deletion only).

---

## Local setup

1. Clone the repo.
2. **Config:** Copy `config.example.js` to `config.js`. Add your Supabase project URL and anon key (Supabase Dashboard → Project Settings → API). Do not commit `config.js`.
3. **Serve:** Run a local server (e.g. `npx serve .`). Open `/` for landing or `/app.html` for the app. Use a real origin (e.g. `http://127.0.0.1:8080/app.html`) so Supabase auth redirects work.
4. **Database:** Run `docs/supabase-schema.sql` once in the Supabase SQL Editor.
5. **Supabase Auth:** In Authentication → URL Configuration, set Site URL to your app URL (e.g. `http://127.0.0.1:8080/app.html`).

---

## Database

- **Schema:** `docs/supabase-schema.sql` creates `loan_data`, `loan_shares`, RLS, and RPCs for sharing and edit-access requests. Run it once in the Supabase SQL Editor.
- **Check schema:** `docs/check-schema.sql` is optional; run it to compare the live database to the expected schema.

---

## Deploy (Cloudflare Pages)

1. **Pages:** Connect the repo to Cloudflare Pages (Workers & Pages → Create → Pages → Connect to Git).
2. **Build:** Framework preset **None**. Build command: `node scripts/write-config.js`. Build output directory: `/`.
3. **Environment variables:** Add `SUPABASE_URL` and `SUPABASE_ANON_KEY` (Supabase → Project Settings → API). The build script writes these into `config.js` at deploy time.
4. **Supabase:** In Authentication → URL Configuration, set Site URL and redirect URLs to your Pages URL (e.g. `https://yoursite.pages.dev/app.html`).

---

## Account deletion and admin (Cloudflare Worker)

Users can delete their own account from the app (Settings → Delete account). They enter their password and type **DELETE** to confirm. A backend is required because Supabase’s delete-user API uses the service role and must not run in the browser.

The repo includes a **Cloudflare Worker** (`worker/`) that provides:

- **POST /delete-my-account** – User sends session JWT; Worker verifies and deletes that user in Supabase.
- **GET /admin/users** – Admin lists users. Auth: API key (X-Admin-Key) or a logged-in user with `app_metadata.role === 'admin'`.
- **DELETE /admin/users/:id** – Admin deletes a user (same auth).

### Worker setup (dashboard)

1. **Create Worker:** Workers & Pages → Create → Create Worker. Name it (e.g. `lendpile-api`). Copy the Worker URL.
2. **Code:** Edit code → replace with contents of `worker/src/index.js` → Save and deploy.
3. **Secrets (Worker → Settings → Variables and Secrets):** Add as **Secret**:  
   `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_SECRET`.
4. **Pages env:** In your Pages project → Settings → Environment variables, add `DELETE_ACCOUNT_URL` = Worker URL + `/delete-my-account` (e.g. `https://lendpile-api.xxxx.workers.dev/delete-my-account`). Redeploy Pages.
5. **config.js (local or build):** Set `DELETE_ACCOUNT_URL` to that same URL. Optionally set `ADMIN_API_URL` to the Worker base URL for the admin dashboard.

### Deploy Worker from Git (one push → Pages + Worker)

1. Workers & Pages → your Worker → Settings → Build.
2. Connect the **same repo and branch** as Pages.
3. **Root directory:** `worker`. **Build command:** empty (or `npm install` if needed). **Deploy command:** `npx wrangler deploy`.
4. Save. Each push to the branch deploys both Pages and the Worker. Secrets stay in the Worker’s dashboard.

### Quick reference – where to set values

| Where | Name | Value |
|--------|------|--------|
| Worker (Secrets) | `SUPABASE_URL` | Supabase Project URL |
| Worker | `SUPABASE_ANON_KEY` | Supabase anon key |
| Worker | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key |
| Worker | `ADMIN_SECRET` | Your chosen admin secret |
| Worker (optional) | `ADMIN_TOTP_SECRET` | Base32 TOTP secret for 2FA on API-key admin access |
| Pages (Env vars) | `DELETE_ACCOUNT_URL` | Worker URL + `/delete-my-account` |

**Alternative:** Supabase Edge Function for deletion only: `supabase functions deploy delete-my-account`. The app uses `SUPABASE_URL/functions/v1/delete-my-account` if `DELETE_ACCOUNT_URL` is not set. Admin list/delete requires the Worker (or another backend with the service role).

---

## Admin dashboard

- **URL:** `https://yoursite.pages.dev/admin.html` (or your app origin + `/admin.html`).
- **Ways to authenticate:**  
  - Log in with a Lendpile account that has the admin role (email + password, and 2FA if enabled).  
  - Or use the “Admin API key” (your Worker `ADMIN_SECRET`), stored in session storage for the current tab.
- **Actions:** List users, delete a user (with confirmation).

**Making a user an admin:** Supabase → Authentication → Users → open user → Edit → App metadata: add `{"role": "admin"}` (or merge with existing JSON). Save. That user can open the admin page and log in with email/password (and 2FA if set). Multiple users can have the admin role.

**Security:** Admin-by-role is recommended; if that account has 2FA in the app, admin access also requires 2FA. The API key is a single shared secret; keep it private. Optional: set `ADMIN_TOTP_SECRET` in the Worker so API-key access also requires a 6-digit code from an authenticator app. To generate a base32 TOTP secret: `node scripts/generate-totp-secret.js` (from project root) or `openssl rand -base32 20`.

---

## Project structure

| Path | Purpose |
|------|--------|
| `index.html` | Landing page. |
| `app.html` | Main app shell; loads `styles.css` and `app.js`. |
| `app.js` | Auth, sync, sharing, UI, calculations, charts. |
| `styles.css` | Layout, modals, forms, theme. |
| `privacy.html` | Privacy policy and disclaimer. |
| `faq.html` | Help & FAQ. |
| `assets/` | Favicon, logo, screenshot. |
| `config.example.js` | Config template; copy to `config.js`. |
| `scripts/write-config.js` | Build script: writes `config.js` from env (e.g. Cloudflare Pages). |
| `scripts/generate-totp-secret.js` | Generates base32 TOTP secret for optional admin 2FA. |
| `docs/supabase-schema.sql` | Database schema; run once in Supabase. |
| `docs/check-schema.sql` | Optional schema check. |
| `worker/` | Cloudflare Worker (account deletion + admin API). |
| `admin.html` | Admin dashboard. |
| `supabase/functions/delete-my-account/` | Optional Edge Function for deletion only. |

---

## Security and config

- Supabase URL and anon key belong only in `config.js` (gitignored). The repo has only `config.example.js` with placeholders. Do not commit `config.js` or the service role key.
- The service role key is used only in the Worker (or Edge Function); never in the front end or in `config.js`.

---

## Auth and “continue without account”

Sign in to sync data across browsers or devices. “Continue without an account” keeps data in the browser only; you can create an account later to back up or restore.

---

## Calculations reference

For how loan and amortization calculations work (timeline, interest, payments, capitalization), see **[CALCULATIONS.md](CALCULATIONS.md)**. Use it to verify the app against Excel or a bank statement.

---

## Future ideas

Possible enhancements (optional; not required for current use):

- **Planning:** Extra payments (one-off or recurring), target date / required payment, compare scenarios.
- **Loan model:** Interest-only period, fees, balloon payment.
- **Export/reporting:** Export amortization table to CSV, yearly interest summary, print-friendly view.
- **Overview:** Portfolio summary (total debt, total payment), archive/hide paid-off loans.
- **UX:** Loan templates, clear “next important date” on cards, validation hints.

See the codebase and issues for priorities; the app is usable as-is for core loan and amortization tracking.
