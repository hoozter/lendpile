import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist');

export const publicFiles = [
  'index.html',
  'app.html',
  'admin.html',
  '404.html',
  '_redirects',
  'faq.html',
  'privacy.html',
  'styles.css',
  'app.js',
  'calculations.js',
  'robots.txt',
  'sitemap.xml',
];

const versionedAppAssets = ['config.js', 'calculations.js', 'styles.css', 'app.js'];

export function deploymentVersion(env = process.env, sourceHtml = '') {
  const commitSha = String(env.CF_PAGES_COMMIT_SHA || '').trim().toLowerCase();
  if (commitSha) {
    if (!/^[a-f0-9]{7,64}$/.test(commitSha)) {
      throw new Error('CF_PAGES_COMMIT_SHA is not a valid commit SHA');
    }
    return commitSha;
  }

  const match = sourceHtml.match(/<meta\s+name="app-version"\s+content="([^"]+)"\s*\/?\s*>/i);
  const fallback = match ? match[1].trim() : '';
  if (!fallback || !/^[a-z0-9._-]+$/i.test(fallback)) {
    throw new Error('app.html must contain a valid app-version fallback');
  }
  return fallback;
}

export function stampDeploymentVersion(html, version) {
  let stamped = html.replace(
    /(<meta\s+name="app-version"\s+content=")[^"]*("\s*\/?\s*>)/i,
    `$1${version}$2`
  );

  for (const asset of versionedAppAssets) {
    const escapedAsset = asset.replace('.', '\\.');
    const attribute = asset.endsWith('.css') ? 'href' : 'src';
    const pattern = new RegExp(`(${attribute}="${escapedAsset})(?:\\?v=[^"]*)?(")`, 'g');
    stamped = stamped.replace(pattern, `$1?v=${version}$2`);
  }

  return stamped;
}

function requiredEndpoint(value, name) {
  if (!value) {
    throw new Error('LENDPILE_API_URL and NEON_AUTH_URL are required');
  }
  const url = new URL(value);
  if (url.protocol !== 'https:') {
    throw new Error(`${name} must use https`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not contain credentials`);
  }
  return url.href.replace(/\/$/, '');
}

export function renderDeploymentConfig(env = process.env) {
  const apiUrl = requiredEndpoint(env.LENDPILE_API_URL, 'LENDPILE_API_URL');
  const authUrl = requiredEndpoint(env.NEON_AUTH_URL, 'NEON_AUTH_URL');

  return `// Generated at build time. Do not edit in dist.\nwindow.LENDPILE_API_URL = ${JSON.stringify(apiUrl)};\nwindow.NEON_AUTH_URL = ${JSON.stringify(authUrl)};\nwindow.ADMIN_API_URL = ${JSON.stringify(apiUrl)};\n`;
}

export function buildPages(env = process.env) {
  const config = renderDeploymentConfig(env);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const sourceAppHtml = readFileSync(join(root, 'app.html'), 'utf8');
  const version = deploymentVersion(env, sourceAppHtml);

  for (const file of publicFiles) {
    const source = join(root, file);
    if (!existsSync(source)) continue;
    if (file === 'app.html') {
      writeFileSync(join(outDir, file), stampDeploymentVersion(sourceAppHtml, version));
    } else {
      copyFileSync(source, join(outDir, file));
    }
  }

  const assetsDir = join(root, 'assets');
  if (existsSync(assetsDir)) {
    cpSync(assetsDir, join(outDir, 'assets'), { recursive: true });
  }

  writeFileSync(join(outDir, 'config.js'), config);

  console.log(`Built public Pages bundle in ${outDir} (version ${version})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  buildPages();
}
