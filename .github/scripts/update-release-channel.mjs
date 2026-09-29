import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const repo = process.env.GITHUB_REPOSITORY || 'PedroB0bs/BobsBot-Releases';
const apiRoot = process.env.GITHUB_API_URL || 'https://api.github.com';
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

export function parseTag(tag) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag || '');
  return match ? match.slice(1).map(Number) : null;
}

export function compareVersions(a, b) {
  const left = typeof a === 'string' ? parseTag(`v${a}`) : a;
  const right = typeof b === 'string' ? parseTag(`v${b}`) : b;
  if (!left || !right) throw new Error('invalid numeric release version');
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

export function selectHighestRelease(releases, { stableOnly = false } = {}) {
  return releases
    .filter(release => !release.draft && (!stableOnly || !release.prerelease) && parseTag(release.tag_name))
    .sort((a, b) => compareVersions(parseTag(b.tag_name), parseTag(a.tag_name)))[0] || null;
}

export function validateReleaseManifest(release, manifest) {
  const version = parseTag(release.tag_name)?.join('.');
  if (!version || !manifest || manifest.schema !== 1 || manifest.version !== version ||
      manifest.package !== `BobsBotNetwork-${version}.zip` ||
      manifest.url !== `https://github.com/PedroB0bs/BobsBot-Releases/releases/download/v${version}/${manifest.package}` ||
      !/^[a-f0-9]{64}$/.test(manifest.sha256) || !Number.isSafeInteger(manifest.size) ||
      manifest.size < 10000 || manifest.size > 800 * 1024 * 1024) {
    throw new Error(`release ${release.tag_name} has an invalid signed manifest`);
  }
  const assets = new Map((release.assets || []).map(asset => [asset.name, asset]));
  for (const name of ['manifest.json', 'manifest.sig', manifest.package, 'BobsBotNetworkSetup.exe']) {
    if (!assets.has(name)) throw new Error(`release ${release.tag_name} is missing ${name}`);
  }
  const packageAsset = assets.get(manifest.package);
  if (packageAsset.size !== manifest.size ||
      (packageAsset.digest && packageAsset.digest !== `sha256:${manifest.sha256}`)) {
    throw new Error(`release ${release.tag_name} has an incomplete or mismatched package`);
  }
  return manifest;
}

async function api(pathname) {
  const response = await fetch(new URL(pathname, apiRoot), {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub API request failed (${response.status})`);
  return response.json();
}

async function assetBytes(asset) {
  if (!asset?.browser_download_url) throw new Error('release asset is missing a download URL');
  const response = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(30_000), cache: 'no-store' });
  if (!response.ok) throw new Error(`release asset download failed (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

async function verifyPackageAsset(asset, manifest) {
  const response = await fetch(asset.browser_download_url, {
    signal: AbortSignal.timeout(10 * 60_000), cache: 'no-store',
  });
  if (!response.ok || !response.body) throw new Error(`release package download failed (${response.status})`);
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > manifest.size) throw new Error('release package is larger than its signed manifest');
    hash.update(chunk);
  }
  if (size !== manifest.size || hash.digest('hex') !== manifest.sha256) {
    throw new Error('release package does not match its signed size and SHA-256');
  }
}

async function listReleases() {
  const all = [];
  for (let page = 1; ; page++) {
    const current = await api(`/repos/${repo}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(current)) throw new Error('GitHub returned an invalid release list');
    all.push(...current);
    if (current.length < 100) return all;
  }
}

async function main() {
  if (!token) throw new Error('GitHub workflow token is unavailable');
  const releases = await listReleases();
  const latest = selectHighestRelease(releases);
  if (!latest) throw new Error('there are no public releases with numeric version tags');
  const assets = new Map(latest.assets.map(asset => [asset.name, asset]));
  const [manifestBytes, signatureBytes] = await Promise.all([
    assetBytes(assets.get('manifest.json')),
    assetBytes(assets.get('manifest.sig')),
  ]);
  if (manifestBytes.length > 8192) throw new Error('release manifest is too large');
  const manifest = validateReleaseManifest(latest, JSON.parse(manifestBytes.toString('utf8')));
  const signatureText = signatureBytes.toString('utf8').trim();
  const signature = Buffer.from(signatureText, 'base64');
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signatureText) || signature.length !== 64) throw new Error('release signature has an invalid format');
  const publicKeyText = fs.readFileSync(path.resolve('updates/update-public-key.txt'), 'utf8').trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(publicKeyText)) throw new Error('update verification key has an invalid format');
  const publicKey = createPublicKey({ key: Buffer.from(publicKeyText, 'base64'), type: 'spki', format: 'der' });
  if (!verify(null, manifestBytes, publicKey, signature)) throw new Error('release manifest signature verification failed');
  await verifyPackageAsset(assets.get(manifest.package), manifest);

  const channelDirectory = path.resolve('updates');
  fs.mkdirSync(channelDirectory, { recursive: true });
  fs.writeFileSync(path.join(channelDirectory, 'manifest.json'), manifestBytes);
  fs.writeFileSync(path.join(channelDirectory, 'manifest.sig'), signatureBytes);
  execFileSync('git', ['config', 'user.name', 'github-actions[bot]']);
  execFileSync('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  execFileSync('git', ['add', 'updates/manifest.json', 'updates/manifest.sig']);
  const diff = spawnSync('git', ['diff', '--cached', '--quiet'], { stdio: 'ignore' });
  if (diff.error) throw diff.error;
  if (diff.status === 1) {
    execFileSync('git', ['commit', '-m', `Publish BobsBot update channel ${manifest.version}`], { stdio: 'inherit' });
    execFileSync('git', ['push', 'origin', 'main'], { stdio: 'inherit' });
  } else if (diff.status !== 0) {
    throw new Error('could not check whether the update channel changed');
  }

  const latestStable = selectHighestRelease(releases, { stableOnly: true });
  if (latestStable) {
    const manifestPath = path.join(channelDirectory, 'manifest.json');
    const signaturePath = path.join(channelDirectory, 'manifest.sig');
    execFileSync('gh', ['release', 'upload', latestStable.tag_name, manifestPath, signaturePath,
      '--clobber', '--repo', repo], { stdio: 'inherit', env: process.env });
  }
  console.log(`BobsBot update channel now points to ${manifest.version}${latest.prerelease ? ' (prerelease)' : ''}.`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(`Release channel: ${error.message}`); process.exitCode = 1; });
}
