# Lendpile

A clear, reliable loan and amortization tracker. Plan loans you borrow or lend, see schedules and charts, and optionally sign in with an account to keep your data in sync. By [hoozter](https://hoozter.com). Designed in Sweden. Free to use.

## What it does

- Add and edit loans (amount, rate, currency, start date).
- Model interest changes and loan amount changes over time.
- Set up amortization plans (one-off or recurring) and see exactly what you’ll pay and when.
- Track both sides: borrowing (what you owe) and lending (what’s owed to you).
- Export and import your data; use with or without an account.
- Sign in to sync across browsers or devices; 2FA and recovery email supported.

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

## Security

- The only file that should hold your Supabase URL and anon key is `config.js`, and it’s in `.gitignore`. The repo only has `config.example.js` with placeholders. Keep it that way.
- No other secrets in the codebase. Safe to publish on GitHub as long as `config.js` is never committed.

## Auth and “continue without account”

Sign in to sync your data when you use the app on another browser or device. Choose “Continue without an account” and everything stays in your browser only—you can create an account later to back up or restore.

## Privacy and disclaimer

[privacy.html](privacy.html) covers how we handle your data (GDPR-style rights, security, recovery, emails we send) and the legal disclaimer for using the tool.

## Project structure

| Path | Purpose |
|------|--------|
| `index.html` | Landing page (what Lendpile is, link to app). |
| `app.html` | Main app (loans, amortization, sync, sharing, account, 2FA). |
| `privacy.html` | Privacy policy and disclaimer. |
| `faq.html` | Help & FAQ (how to use the tool). |
| `assets/` | Favicon, logo (`lendpile.svg`), and screenshot. |
| `scripts/write-config.js` | Build script: reads `SUPABASE_URL` and `SUPABASE_ANON_KEY` from env and writes `config.js` (for Cloudflare Pages or other CI). |
| `config.example.js` | Config template; copy to `config.js` and add your Supabase URL and anon key (for local dev). |
| `docs/supabase-schema.sql` | Supabase table and RLS; run once in SQL Editor. |
| `docs/check-schema.sql` | Optional: check live DB schema. |
| `PROJECT_OUTLINE.md` | Overview and roadmap. |

- **CSS/JS:** In each HTML file. For deployment, the only “build” step is `node scripts/write-config.js` to generate `config.js` from env vars.
- **Ignored:** `config.js` (secrets). Optional dev/review files (e.g. `docs/verify-*.js`, some `docs/*.md`) are in `.gitignore`; remove those lines if you want them in the repo.

## License

Lendpile is free to copy and use for non-commercial purposes under the [Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)](https://creativecommons.org/licenses/by-nc/4.0/) license. See [LICENSE](LICENSE) for details. You may not use it for commercial purposes without separate permission.
