// Use the same browser config as the Pages build. NEON_AUTH_URL stays server-side.
import { writeFileSync } from 'node:fs';
import { renderDeploymentConfig } from './build-pages.js';

writeFileSync(new URL('../config.js', import.meta.url), renderDeploymentConfig());
console.log('Wrote same-origin browser config');
