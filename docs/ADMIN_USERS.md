# Admin users and security

## Where to set a user as admin

In **Supabase Dashboard**:

1. Go to your project → **Authentication** → **Users**.
2. Click the user you want to make an admin.
3. Open **Edit** (or the three-dots menu).
4. Find **App metadata** (sometimes under "Raw user meta"). Set it to:
   ```json
   {"role": "admin"}
   ```
   If there is already JSON, add `"role": "admin"` to it.
5. Save.

You can repeat this for multiple users. To remove admin, edit the user again and remove `"role": "admin"` from App metadata.

## How the admin gets to the admin page

- **From the app:** If the logged-in user has the admin role, the **profile menu** (top right, account icon) shows an **Admin** item. Click it to open the admin page.
- **Direct URL:** Anyone can open `https://yoursite.com/admin.html`. They still must log in with an admin account (email + password, and 2FA if enabled) or enter the **Admin API key** (your Worker's `ADMIN_SECRET`) to do anything.

## What admins can do

On the admin page, an admin can:

- **List users** – See all users (email, user id, created date).
- **Delete a user** – Permanently remove a user from Supabase Auth (with confirmation).

**Not implemented yet:** Reset a user's TOTP/2FA, export a user's data, or impersonate/disable/edit users. These would require new Worker routes and Supabase Admin API usage; they can be added later.

## Two ways to authenticate on the admin page

1. **Log in with your Lendpile account** – If that account has the admin role, use email and password (and 2FA if you have it). No API key needed.
2. **Use the API key** – Enter the **ADMIN_SECRET** (the value you set in the Worker's Variables and Secrets) in the "Or use API key" field. Useful for scripts or as a fallback.

## Security

- **Admin-by-role (recommended):** Use a Lendpile account with the admin role. If that account has **2FA** enabled in the app (Account → Two-factor authentication), you get password + 2FA to access the admin page. The Worker only checks your session and that your user has `app_metadata.role === 'admin'`.
- **API key:** The ADMIN_SECRET is a single shared secret. Anyone with it can call the admin API. Keep it secret.
- **Optional: TOTP for API key** – To require a second factor when using the API key (key + 6-digit code from an authenticator app), set **ADMIN_TOTP_SECRET** in the Worker’s Variables and Secrets to a **base32** TOTP secret. Generate one (e.g. run `openssl rand -base32 20` in a terminal, or use any TOTP app’s “enter key manually” and copy the secret). Add that secret to your authenticator app (Google Authenticator, Authy, etc.) and add the same value as the Worker secret `ADMIN_TOTP_SECRET`. On the admin page, when using “Or use API key”, enter the API key and the current 6-digit code. Without this secret set, only the API key is required; with it set, brute-forcing the key is not enough.

**Ways to generate a base32 TOTP secret** (the Worker accepts base32 only; base64 will not work):

- **Node** (from project root): `node scripts/generate-totp-secret.js`
- **Python 3:** `python3 -c "import base64, os; print(base64.b32encode(os.urandom(20)).decode().rstrip('='))"`
- **OpenSSL** (if your build supports it): `openssl rand -base32 20`
- Or use any TOTP app "enter key manually" and copy the secret it shows (must be base32: letters A–Z and digits 2–7 only).
