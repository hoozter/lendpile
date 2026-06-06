/**
 * Lendpile Neon configuration template.
 * Copy this file to config.js and replace the placeholders with your project values.
 * config.js is gitignored. Never expose NEON_DATABASE_URL in browser config.
 */
window.LENDPILE_API_URL = "https://your-worker.workers.dev";
window.NEON_AUTH_URL = "https://your-neon-auth-host/neondb/auth";

/**
 * Account deletion and admin API use the same Worker.
 * ADMIN_API_URL is optional when it matches LENDPILE_API_URL.
 */
// window.ADMIN_API_URL = "https://your-worker.workers.dev";
