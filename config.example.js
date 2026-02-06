/**
 * Supabase configuration template.
 * Copy this file to config.js and replace the placeholders with your project values.
 * config.js is gitignored so your keys are not pushed to GitHub.
 *
 * Get your URL and anon key from: Supabase Dashboard → Project Settings → API
 */
window.SUPABASE_URL = "https://your-project-ref.supabase.co";
window.SUPABASE_ANON_KEY = "your-anon-public-key";

/**
 * Account deletion and admin API (Cloudflare Worker).
 * DELETE_ACCOUNT_URL = full URL for "Delete my account" (e.g. https://lendpile-api.workers.dev/delete-my-account).
 * ADMIN_API_URL = Worker base URL for the admin dashboard (admin.html); optional if same as DELETE_ACCOUNT_URL base.
 */
// window.DELETE_ACCOUNT_URL = "https://your-worker.workers.dev/delete-my-account";
// window.ADMIN_API_URL = "https://your-worker.workers.dev";
