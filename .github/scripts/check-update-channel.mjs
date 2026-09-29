import assert from 'node:assert/strict';
import { compareVersions, parseTag, selectHighestRelease, validateReleaseManifest } from './update-release-channel.mjs';

assert.deepEqual(parseTag('v1.2.3'), [1, 2, 3]);
assert.equal(parseTag('v1.2'), null);
assert.equal(compareVersions('1.10.0', '1.9.9'), 1);

const releases = [
  { tag_name: 'v1.0.4', draft: false, prerelease: true },
  { tag_name: 'v1.0.5', draft: true, prerelease: false },
  { tag_name: 'v1.0.3', draft: false, prerelease: false },
  { tag_name: 'v1.0.6', draft: false, prerelease: true },
  { tag_name: 'latest', draft: false, prerelease: false },
];
assert.equal(selectHighestRelease(releases).tag_name, 'v1.0.6');
assert.equal(selectHighestRelease(releases, { stableOnly: true }).tag_name, 'v1.0.3');
assert.equal(selectHighestRelease(releases.filter(release => release.draft)), null);

const manifest = {
  schema: 1,
  version: '1.0.6',
  package: 'BobsBotNetwork-1.0.6.zip',
  url: 'https://github.com/PedroB0bs/BobsBot-Releases/releases/download/v1.0.6/BobsBotNetwork-1.0.6.zip',
  size: 10000,
  sha256: 'a'.repeat(64),
};
const completeRelease = {
  tag_name: 'v1.0.6',
  assets: [
    { name: 'manifest.json', size: 250 },
    { name: 'manifest.sig', size: 88 },
    { name: manifest.package, size: manifest.size, digest: `sha256:${manifest.sha256}` },
    { name: 'BobsBotNetworkSetup.exe', size: 1000 },
  ],
};
assert.equal(validateReleaseManifest(completeRelease, manifest), manifest);
assert.throws(() => validateReleaseManifest({ ...completeRelease, assets: completeRelease.assets.slice(0, 3) }, manifest), /missing BobsBotNetworkSetup.exe/);
assert.throws(() => validateReleaseManifest({ ...completeRelease, assets: completeRelease.assets.map(asset => asset.name === manifest.package ? { ...asset, size: 1 } : asset) }, manifest), /incomplete or mismatched/);
assert.throws(() => validateReleaseManifest({ tag_name: 'v1.0.7' }, manifest));
console.log('Update channel selection and manifest checks passed.');
