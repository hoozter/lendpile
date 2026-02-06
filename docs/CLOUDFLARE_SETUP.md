# Cloudflare setup – correct order, no jargon

Your **website** is already on Cloudflare Pages. To make “Delete my account” work, you add a **Worker** (a small API) and then tell the website its address. Do the steps below in order. You’ll know what to type at each step.

---

## What you need before starting

- Your **Supabase** project open: **Project Settings** → **API**. You need:
  - **Project URL** (e.g. `https://abcdefgh.supabase.co`)
  - **anon public** key (long string)
  - **service_role** key (long string; treat as secret, never put it in the website)
- A **random secret** for the admin page (e.g. generate a long password and save it somewhere safe).

---

## Step 1: Create the Worker (this gives you the URL)

1. In Cloudflare, open **Workers & Pages** in the left sidebar.
2. Click **Create** → **Create Worker** (not “Pages”).
3. **Name:** type `lendpile-api` (or any name you like). Click **Deploy**.
4. After it deploys, you’ll see a page for that Worker. On it there is a **URL**. It will look like:
   - `https://lendpile-api.xxxx.workers.dev`
   - The `xxxx` part is chosen by Cloudflare; you don’t have to create a subdomain.
5. **Copy that full URL** (from `https` to `.dev`, no path). Paste it into a note. You’ll use it in Step 4.

---

## Step 2: Put the Worker code in

1. On the same Worker page, click **Edit code** (or **Quick edit**).
2. In the code editor, **select all** the default code and delete it.
3. Open the file **`worker/src/index.js`** in your Lendpile project. Select **all** of it and copy.
4. Paste into the Cloudflare editor. Click **Save and deploy**.

---

## Step 3: Add the Worker’s secrets

1. On the Worker’s page, open **Settings** → **Variables and Secrets**.
2. Under **Encrypted** (or **Secrets**), click **Add** (or **Add variable** / **Add secret**).
3. Add these **four** variables one by one. For each, choose **Secret** (or “Encrypted”) so the value is hidden.

   **First variable**
   - **Variable name:** type exactly: `SUPABASE_URL`
   - **Value:** paste your Supabase Project URL (from Supabase → Project Settings → API).
   - Save.

   **Second variable**
   - **Variable name:** type exactly: `SUPABASE_ANON_KEY`
   - **Value:** paste your Supabase anon public key.
   - Save.

   **Third variable**
   - **Variable name:** type exactly: `SUPABASE_SERVICE_ROLE_KEY`
   - **Value:** paste your Supabase service_role key.
   - Save.

   **Fourth variable**
   - **Variable name:** type exactly: `ADMIN_SECRET`
   - **Value:** the long random secret you saved (for the admin page later).
   - Save.

4. Go back to the Worker and click **Deploy** again so it uses the new secrets.

---

## Step 4: Give the website the Worker URL (Pages)

You use the URL you copied in Step 1.

1. In Cloudflare, open **Workers & Pages** → click your **lendpile** (Pages) project.
2. Go to **Settings** → **Environment variables**.
3. Click **Add** (or **Edit** if you already have something).
4. **Production** (and Preview if you use it):
   - **Variable name:** type exactly: `DELETE_ACCOUNT_URL`
   - **Value:** paste the Worker URL from Step 1, then type `/delete-my-account` at the end with no space.
   - Example: if your Worker URL was `https://lendpile-api.xxxx.workers.dev`, then the value is:  
     `https://lendpile-api.xxxx.workers.dev/delete-my-account`
5. Save.
6. **Redeploy the Pages site:** open **Deployments**, click the **…** on the latest deployment, choose **Retry deployment** (or push a small commit to trigger a new build).

---

## Done

- **Delete my account:** In the app, users can use Settings → Delete account (password + typing DELETE). The app will call the Worker URL you set in Step 4.
- **Admin page:** Open `https://<your-lendpile-site>/admin.html` (your real Pages URL). When it asks for “Admin API key”, paste the same value you used for **ADMIN_SECRET** in Step 3.

---

## Quick reference – what goes where

| Where | Name | Value |
|--------|------|--------|
| **Worker** (Variables and Secrets) | `SUPABASE_URL` | Supabase Project URL |
| **Worker** | `SUPABASE_ANON_KEY` | Supabase anon key |
| **Worker** | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key |
| **Worker** | `ADMIN_SECRET` | Your chosen long random secret |
| **Pages** (Environment variables) | `DELETE_ACCOUNT_URL` | Worker URL + `/delete-my-account` (e.g. `https://lendpile-api.xxxx.workers.dev/delete-my-account`) |

The Worker URL is the one Cloudflare shows on the Worker’s page after you create it (Step 1).
