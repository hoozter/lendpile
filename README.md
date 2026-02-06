# Lendpile

**Version 0.2.0**

A clear, reliable loan and amortization tracker. Plan loans you borrow or lend, see schedules and charts, and optionally sign in with an account to keep your data in sync. By [hoozter](https://hoozter.com). Designed in Sweden. Free to use.

## What it does

- Add and edit loans (amount, rate, currency, start date).
- Model interest changes and loan amount changes over time.
- Set up amortization plans (one-off or recurring) and see exactly what you’ll pay and when.
- Track both sides: borrowing (what you owe) and lending (what’s owed to you).
- Export and import your data; use with or without an account.
- Sign in to sync across browsers or devices; 2FA and recovery email supported. After you confirm your email via the link we send, you’ll see a short welcome message in the app.
- Share a loan via link (view-only or can edit). The recipient sees who shared it and which loan before signing in. Shared loans stay in your list (one source of truth); the recipient can revoke the share from their side. With view-only access, they can still open the loan and all modals in read-only form and request edit access; you see requests in a banner and in the Share dialog and can approve or decline (both of you see the outcome on next load). The loan list shows type badges (Borrowing / Lending) and is grouped by type.

Lendpile is built with care. The calculations are there to help you plan and understand—not to replace your lender or adviser. For important decisions, confirm the numbers with your bank or a qualified professional. See [privacy.html](privacy.html) for the full disclaimer and privacy details.

## Requirements

- A modern browser (JavaScript enabled).
- For sync: a Supabase project and `config.js` (see below).

## Run locally

1. **Clone or download** this repo.
2. **Config (for sync):** Copy `config.example.js` to `config.js`. Add your Supabase project URL and anon key (Supabase Dashboard → Project Settings → API).  
   **Important:** `config.js` is gitignored. Don’t commit it.
3. **Serve the app:** Run a local server and open the site (e.g. `/` for landing, `/app.html` for the app). For example: `npx serve .` or your IDE’s live server. Use a real origin (e.g. `http://127.0.0.1:8080/app.html`) so Supabase auth redirects work.
4. **Supabase:** Run `docs/supabase-schema.sql` once in the Supabase SQL Editor. In Authentication → URL Configuration, set Site URL to your app URL (e.g. `http://127.0.0.1:8080/app.html`).

## Deploy (e.g. Cloudflare Pages)

1. **Connect the repo** to Cloudflare Pages (Workers & Pages → Create → Pages → Connect to Git → choose this repo).
2. **Build settings:** Framework preset **None**, Build command **`node scripts/write-config.js`**, Build output directory **`/`**.
3. **Environment variables** (Advanced): add **`SUPABASE_URL`** and **`SUPABASE_ANON_KEY`** with your Supabase project URL and anon key (Dashboard → Project Settings → API). The build script writes these into `config.js` at deploy time so keys stay out of the repo.
4. **Supabase:** In Authentication → URL Configuration, set Site URL and redirect URLs to your Pages URL (e.g. `https://lendpile.pages.dev/app.html`).

## Account deletion and admin (Cloudflare Worker)

Users can delete their own account from the app (Settings → Delete account). They must enter their password and type **DELETE** to confirm. A backend is required because Supabase’s delete-user API uses the service role and must not run in the browser.

The repo includes a **Cloudflare Worker** (`worker/`) that:

1. **POST /delete-my-account** – User sends their session JWT; the Worker verifies it and deletes that user in Supabase. Only that user’s account is deleted.
2. **GET /admin/users** – Admin lists users (protected by a secret key).
3. **DELETE /admin/users/:id** – Admin deletes a user by id.

**Deploy the Worker**

- **Without a terminal:** See **[docs/CLOUDFLARE_SETUP.md](docs/CLOUDFLARE_SETUP.md)** for step-by-step setup using only the Cloudflare dashboard and GitHub (create Worker, paste code, set secrets, then add the Worker URL to Pages).
- **With a terminal:** From the project root: `cd worker && npx wrangler deploy`. Set secrets (your Supabase and a chosen admin secret):
   - `npx wrangler secret put SUPABASE_URL`
   - `npx wrangler secret put SUPABASE_ANON_KEY`
   - `npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY`
   - `npx wrangler secret put ADMIN_SECRET`
3. In `config.js` set `DELETE_ACCOUNT_URL` to the Worker URL plus `/delete-my-account` (e.g. `https://lendpile-api.<your-subdomain>.workers.dev/delete-my-account`). Optionally set `ADMIN_API_URL` to the Worker base URL for the admin dashboard.

**Admin dashboard**

Open `admin.html` (e.g. `https://yoursite.pages.dev/admin.html`). Enter your `ADMIN_SECRET` as the “Admin API key”, then click “Load users” to list users and delete them if needed. The key is stored in session storage for the current tab only.

**Alternative: Supabase Edge Function**

You can still use the Supabase Edge Function for deletion only: deploy with `supabase functions deploy delete-my-account`. The app will use `SUPABASE_URL/functions/v1/delete-my-account` if `DELETE_ACCOUNT_URL` is not set. The admin dashboard and list/delete-other-users require the Worker (or another backend with the service role).

## Security

- The only file that should hold your Supabase URL and anon key is `config.js`, and it’s in `.gitignore`. The repo only has `config.example.js` with placeholders. Keep it that way.
- No other secrets in the codebase. Safe to publish on GitHub as long as `config.js` is never committed. The Edge Function runs on Supabase and uses the project's service role key there; never put the service role key in the front end or in `config.js`.

## Auth and “continue without account”

Sign in to sync your data when you use the app on another browser or device. Choose “Continue without an account” and everything stays in your browser only—you can create an account later to back up or restore.

## Privacy and disclaimer

[privacy.html](privacy.html) covers how we handle your data (GDPR-style rights, security, recovery, emails we send) and the legal disclaimer for using the tool.

## Project structure

| Path | Purpose |
|------|--------|
| `index.html` | Landing page (what Lendpile is, link to app). |
| `app.html` | Main app shell (markup only; loads `styles.css` and `app.js`). |
| `app.js` | App logic: auth, sync, sharing, UI handlers, calculations, charts. |
| `styles.css` | App styles (layout, modals, forms, dark/light theme). |
| `privacy.html` | Privacy policy and disclaimer. |
| `faq.html` | Help & FAQ (how to use the tool). |
| `assets/` | Favicon, logo (`lendpile.svg`), and screenshot. |
| `scripts/write-config.js` | Build script: reads `SUPABASE_URL` and `SUPABASE_ANON_KEY` from env and writes `config.js` (for Cloudflare Pages or other CI). |
| `config.example.js` | Config template; copy to `config.js` and add your Supabase URL and anon key (for local dev). |
| `docs/supabase-schema.sql` | Supabase tables, RLS, and functions (sharing, edit-access requests, etc.); run once in SQL Editor. |
| `docs/check-schema.sql` | Optional: check live DB schema. |
| `worker/` | Cloudflare Worker: account deletion + admin API (list/delete users). Deploy with `cd worker && npx wrangler deploy`. |
| `admin.html` | Admin dashboard: list users and delete them (requires Worker and ADMIN_SECRET). |
| `supabase/functions/delete-my-account/` | Optional Edge Function for account deletion only; alternative to the Worker. |
| `PROJECT_OUTLINE.md` | Overview and roadmap. |

- **No bundler:** The app uses plain HTML, CSS, and JS. `app.html` loads ECharts and Supabase from CDNs, then `config.js`, then `styles.css`, and finally `app.js` at the end of the body. The only build step for deployment is `node scripts/write-config.js` to generate `config.js` from env vars.
- **Ignored:** `config.js` (secrets). Optional dev/review files (e.g. `docs/verify-*.js`, some `docs/*.md`) are in `.gitignore`; remove those lines if you want them in the repo.

## License

Lendpile is free to copy and use for non-commercial purposes under the [Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)](https://creativecommons.org/licenses/by-nc/4.0/) license. See [LICENSE](LICENSE) for details. You may not use it for commercial purposes without separate permission.
