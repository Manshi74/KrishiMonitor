import { access, cp, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publishDir = path.join(projectRoot, 'dist');
const publicFiles = [
  'index.html',
  'style.css',
  'script.js',
  'chatbot.js',
  'earth-background.js',
  'terms.html',
  'privacy.html'
];

async function validateLocalReferences() {
  const html = await readFile(path.join(projectRoot, 'index.html'), 'utf8');
  const css = await readFile(path.join(projectRoot, 'style.css'), 'utf8');
  const references = [
    ...[...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)].map(match => match[1]),
    ...[...css.matchAll(/url\(["']?([^"')]+)["']?\)/gi)].map(match => match[1])
  ];
  const localReferences = new Set(references.filter(reference =>
    reference && !reference.startsWith('#') && !reference.startsWith('/') &&
    !/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(reference)
  ));
  for (const reference of localReferences) {
    const filePath = path.resolve(projectRoot, decodeURIComponent(reference.split(/[?#]/, 1)[0]));
    if (!filePath.startsWith(`${projectRoot}${path.sep}`)) {
      throw new Error(`Local site reference escapes the project folder: ${reference}`);
    }
    try {
      await access(filePath);
    } catch {
      throw new Error(`Missing local site asset referenced by the homepage or stylesheet: ${reference}`);
    }
  }
}

function getApiProxyTarget() {
  const configured = (process.env.KRISHI_API_PROXY_TARGET || '').trim();
  if (!configured) return '';

  let target;
  try {
    target = new URL(configured);
  } catch {
    throw new Error('KRISHI_API_PROXY_TARGET must be an HTTPS origin, such as https://api.example.com.');
  }
  if (target.protocol !== 'https:' || target.pathname !== '/' || target.search || target.hash || target.username || target.password) {
    throw new Error('KRISHI_API_PROXY_TARGET must be an HTTPS origin without a path, query, or credentials.');
  }
  return target.origin;
}

const apiTarget = getApiProxyTarget();

await validateLocalReferences();
await mkdir(publishDir, { recursive: true });
for (const file of publicFiles) {
  await cp(path.join(projectRoot, file), path.join(publishDir, file));
}
await cp(path.join(projectRoot, 'assets'), path.join(publishDir, 'assets'), { recursive: true });

const redirectsFile = path.join(publishDir, '_redirects');
try {
  await unlink(redirectsFile);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (apiTarget) {
  await writeFile(redirectsFile, `/api/* ${apiTarget}/api/:splat 200!\n`, 'utf8');
  console.log(`Netlify build ready; API proxy configured for ${apiTarget}.`);
} else {
  console.warn('Static build ready without an API proxy. Set KRISHI_API_PROXY_TARGET in Netlify to connect the Express backend; API features will be unavailable until then.');
}
