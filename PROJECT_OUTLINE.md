# Lendpile – Project outline

## What the tool is

**Lendpile** is a single-page loan and amortization tracker. Users can:

- Add and edit **loans** (name, start date, initial amount, interest rate, currency).
- Add **interest changes** and **loan amount changes** over time.
- Add **amortization plans** (scheduled or one-time) with optional recurrence (e.g. every N months, specific day or last weekday).
- View an **amortization table** and **chart** per loan.
- Use **Swedish** or **English** (language stored in `localStorage`).
- Toggle **light/dark** theme.
- **Export/import** loan data as JSON (Settings).

Data lives in **localStorage** by default. When the user is **logged in** (Supabase Auth), the same data is synced to a Supabase table so it can be restored on another device or browser.

---

## How it works today

### Frontend

- **`index.html`** = landing page; **`app.html`** = main app (HTML + CSS + JS in one file).
- No build step; serve the folder (e.g. `http://localhost:8080/` for landing, `/app.html` for the app).
- Structure: Supabase client → AuthService & SyncService → LanguageService → StorageService → Form/UI/Confirm handlers → DOMContentLoaded and event listeners.

### Auth and sync

- **Supabase** is used for:
  1. **Auth**: sign in, sign up, sign out, session (Supabase Auth).
  2. **Sync**: one table `loan_data` with `user_id` and a JSON `data` column; one row per user, upserted on save.
- On load:
  - If **not** in “offline mode” (`localStorage.offlineMode`), the app checks for a Supabase user.
  - If **no user** → login modal is shown; rest of app init (e.g. full UI) is skipped until the user logs in or chooses “Continue without an account”.
  - If **user exists** → loan data is loaded from Supabase into `localStorage`, then the app runs as usual.
- When the user **saves** loans (add/edit/delete), `StorageService.save("loanData", …)` runs and, if not offline, `SyncService.syncData()` is called to upsert to `loan_data`.
- “Continue without an account” sets `localStorage.offlineMode = "true"` and hides the login modal; all data stays in localStorage only.

So: **the login does real work** – it gates access to Supabase-backed sync. Without a Supabase project (or with wrong URL/key), login will fail; with a valid project and `loan_data` table, login enables cloud backup/restore.

### What’s not in the repo

- **Supabase schema**: no SQL or migration files. The code assumes a table like:
  - `loan_data (user_id uuid PRIMARY KEY, data jsonb, ...)` and RLS so users only see their own row.
- **Admin**: no UI to list users, disable accounts, or manage roles. Supabase Dashboard is the only way to do that today.

---

## Current state summary

| Area              | State |
|-------------------|--------|
| Loan/amortization | Implemented (add, edit, delete, table, chart). |
| Language (sv/en)  | Implemented; login modal now uses same i18n. |
| Theme (light/dark)| Implemented. |
| Export/import     | Implemented. |
| Auth (Supabase)   | Implemented (login/signup/logout + “offline”). |
| Sync to Supabase  | Implemented (upsert `loan_data` on save). |
| Login modal UX    | Redesigned (clear auth screen, i18n, “continue without account” as link). |
| DB schema in repo | Missing (table + RLS not versioned). |
| User account (Settings) | Implemented: display name, recovery/secondary email (set, delete), 2FA (TOTP enroll/disable). Profile shows display name when set; MFA challenge at login when enabled. |
| Admin / superuser      | Not implemented (Dashboard only). |

---

## Clear improvements

1. **Supabase schema in repo**  
   Add SQL (e.g. `supabase/migrations/...sql` or a single `schema.sql`) that creates `loan_data` and RLS so the app works after a fresh Supabase setup.

2. **Config for Supabase**  
   Move `SUPABASE_URL` and `SUPABASE_ANON_KEY` to a small config (e.g. env or `config.js`) so keys are not hardcoded in the main HTML (and different keys can be used for dev/prod).

3. **Sign-out and “current user”**  
   There is no visible “Log out” or “Signed in as …”. Adding a user menu in the header (e.g. next to settings) with sign-out and optionally “Sync status” would make auth state clear.

4. **Sync feedback**  
   Sync is silent; on failure it only logs to console. Showing a short “Synced” / “Sync failed” (e.g. in header or toast) would help.

5. **Admin / account administration**  
   Implement a simple admin area (e.g. `/admin` or role-gated section) to list users, disable accounts, or manage roles – either via Supabase Admin API (server/edge) or Supabase Dashboard until then.

---

## Plan to take it to the next step

### Phase 1 – Reliable auth and sync (recommended first)

1. **Define and document Supabase schema**  
   - Create `loan_data` with `user_id` (references `auth.users`) and `data` (jsonb).  
   - Add RLS: `SELECT/INSERT/UPDATE/DELETE` only for `auth.uid() = user_id`.  
   - Put this in a file in the repo (e.g. `docs/supabase-schema.sql` or a real migration) and add a short “Database setup” section to the README.

2. **Optional: config**  
   - Move Supabase URL and anon key to a single place (e.g. `config.js` or build-time env) so production can use a different project than dev.

3. **Sign-out and user indicator**  
   - In the header, when the user is logged in: show “Signed in as &lt;email&gt;” or an icon, and a “Log out” action that calls `AuthService.signOut()` and optionally clears `offlineMode` / reloads.

4. **Basic sync feedback**  
   - After `SyncService.syncData()`, show a brief “Synced” or “Sync failed: &lt;message&gt;” (e.g. small toast or header message).

### Phase 2 – Admin and account management

5. **Admin area**  
   - Option A: Separate admin page (e.g. `admin.html`) or route, protected by a “superuser” or admin role stored in Supabase (e.g. `profiles.role` or similar).  
   - Option B: Use Supabase Dashboard + Auth for now; document “how to disable/delete users” in README.  
   - If building Option A: use Supabase Admin API (requires a backend or Edge Function with the service role key) to list users, update metadata, or disable accounts.

6. **Account lifecycle**  
   - Document or implement: sign up → email confirmation (Supabase default) → sign in; optional “Forgot password” link using Supabase’s reset flow.

7. **User administration (done)**  
   - **Display name**: Settings → Account; stored in `user_metadata.display_name`; shown in profile header and used when sharing (e.g. “David is sharing a loan”).  
   - **Recovery / secondary email**: Optional; set or delete in Settings → Account; stored in `user_metadata.recovery_email`.  
   - **2FA (TOTP)**: Enable/disable in Settings → Account; MFA challenge shown at login when required (AAL check on load and after sign-in).

### Phase 3 – Structure and maintainability (optional)

7. **Split HTML/CSS/JS**  
   - Move CSS to `styles.css`, JS to `app.js` (or several modules), and keep `app.html` as the shell. This improves readability and reuse without changing behaviour.

8. **README and version**  
   - README: what Lendpile is, how to run it, how to set up Supabase (schema + env), and how auth/sync and “continue without account” work.  
   - If you adopt versioning, keep a single version (e.g. in README or `package.json` if you add one) and update it when you release.

---

## Future roadmap

### Share loan (implemented)

- **Goal**: Let users share a loan with someone else. When the recipient opens the link, they see who is sharing (e.g. “David is sharing a loan” / “David has sent a loan request”) using the owner’s **display name** (set in Settings → Account).
- **Behaviour**: Share link is **time-limited** and **one-time use**; owner chooses permissions (view only / can edit) and recipient view (borrowing vs lending). One source of truth (canonical loan + share records); no “copy on accept.”
- **Flow**: Loan detail menu → Share loan → set permission, recipient view, expiry → Create link → copy URL. Recipient opens URL → signs in → sees shared loan with banner. With "can edit", recipient can save changes back to the owner's loan.
- **Schema**: `docs/supabase-schema.sql` includes `loan_shares` table and RPCs `get_share_by_token`, `redeem_share`, `update_shared_loan`.

---

## Summary

- **What it is**: Single-page loan/amortization tracker with optional Supabase auth and sync.
- **What login does**: Enables syncing loan data to Supabase; “continue without account” uses only localStorage.
- **Gaps**: Schema not in repo, no sign-out/user indicator, no sync feedback, no admin UI.
- **Next steps**: Add schema + doc, optional config, sign-out + user indicator, sync feedback; then plan admin (Dashboard vs custom admin page).
