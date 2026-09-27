import process from 'node:process';
import {pathToFileURL} from 'node:url';

const STABLE_TAG = /^v\d+\.\d+\.\d+$/;
const EXACT_SHA = /^[0-9a-f]{40}$/i;

// v1.4.0 predates exact-SHA release targets. Pin its historical release commit
// so the first release is covered by the same immutability check as newer ones.
export const LEGACY_RELEASE_TARGETS = Object.freeze({
  'v1.4.0': '34f3d81001d6fd18a3971263bfac268afeeb4e0f'
});

export function expectedReleaseSha(release) {
  if (!release || !STABLE_TAG.test(String(release.tag_name ?? ''))) return null;
  const target = String(release.target_commitish ?? '');
  if (EXACT_SHA.test(target)) return target.toLowerCase();
  const legacy = LEGACY_RELEASE_TARGETS[release.tag_name];
  if (legacy) return legacy;
  throw new Error(
    `Published release ${release.tag_name} does not record an exact commit SHA; add an audited legacy baseline before continuing.`
  );
}

export async function verifyPublishedReleaseIntegrity(releases, resolveTagCommit) {
  const stable = releases.filter(release =>
    !release.draft && STABLE_TAG.test(String(release.tag_name ?? ''))
  );
  const seen = new Set();

  for (const release of stable) {
    const tag = release.tag_name;
    if (seen.has(tag)) throw new Error(`Duplicate published release tag: ${tag}`);
    seen.add(tag);

    const expected = expectedReleaseSha(release);
    const actual = String(await resolveTagCommit(tag)).toLowerCase();
    if (!EXACT_SHA.test(actual)) {
      throw new Error(`Could not resolve ${tag} to an exact commit SHA.`);
    }
    if (actual !== expected) {
      throw new Error(
        `Published release tag moved: ${tag} now points to ${actual}, expected ${expected}.`
      );
    }
  }

  return stable.map(release => release.tag_name);
}

function githubClient() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const apiRoot = process.env.GITHUB_API_URL || 'https://api.github.com';
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must be owner/repo.');
  }
  if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required.');

  async function api(route) {
    const response = await fetch(`${apiRoot}/repos/${repository}${route}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
    if (!response.ok) {
      throw new Error(`GitHub API GET ${route.split('?')[0]} failed with HTTP ${response.status}`);
    }
    return response.json();
  }

  return {api};
}

async function loadPublishedReleases(api) {
  const releases = [];
  for (let page = 1; ; page += 1) {
    const batch = await api(`/releases?per_page=100&page=${page}`);
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  return releases;
}

async function resolveTagCommit(api, tag) {
  let object = (await api(`/git/ref/tags/${encodeURIComponent(tag)}`)).object;
  for (let depth = 0; depth < 5; depth += 1) {
    if (object?.type === 'commit' && EXACT_SHA.test(String(object.sha ?? ''))) {
      return object.sha;
    }
    if (object?.type !== 'tag' || !EXACT_SHA.test(String(object.sha ?? ''))) {
      throw new Error(`Tag ${tag} does not resolve to a commit.`);
    }
    object = (await api(`/git/tags/${object.sha}`)).object;
  }
  throw new Error(`Tag ${tag} has an unexpectedly deep annotated-tag chain.`);
}

async function main() {
  const {api} = githubClient();
  const releases = await loadPublishedReleases(api);
  const tags = await verifyPublishedReleaseIntegrity(
    releases,
    tag => resolveTagCommit(api, tag)
  );
  console.log(`release integrity ok: ${tags.length} fixed release tag(s) verified`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
