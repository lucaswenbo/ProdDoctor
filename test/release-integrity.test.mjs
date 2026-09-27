import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_RELEASE_TARGETS,
  expectedReleaseSha,
  verifyPublishedReleaseIntegrity
} from '../scripts/check-release-integrity.mjs';

const sha = char => char.repeat(40);

test('exact release target SHA is authoritative', () => {
  assert.equal(
    expectedReleaseSha({tag_name: 'v2.1.1', target_commitish: sha('a')}),
    sha('a')
  );
});

test('legacy v1.4.0 is pinned to its audited historical commit', () => {
  assert.equal(
    expectedReleaseSha({tag_name: 'v1.4.0', target_commitish: 'main'}),
    LEGACY_RELEASE_TARGETS['v1.4.0']
  );
});

test('a stable published release without an exact target is rejected', () => {
  assert.throws(
    () => expectedReleaseSha({tag_name: 'v9.0.0', target_commitish: 'main'}),
    /does not record an exact commit SHA/
  );
});

test('moved fixed release tags are rejected', async () => {
  await assert.rejects(
    verifyPublishedReleaseIntegrity(
      [{tag_name: 'v2.1.1', target_commitish: sha('a'), draft: false}],
      async () => sha('b')
    ),
    /Published release tag moved/
  );
});

test('matching fixed tags pass and draft releases are ignored', async () => {
  const seen = [];
  const tags = await verifyPublishedReleaseIntegrity(
    [
      {tag_name: 'v2.1.1', target_commitish: sha('a'), draft: false},
      {tag_name: 'v2.2.0', target_commitish: sha('b'), draft: true},
      {tag_name: 'nightly', target_commitish: sha('c'), draft: false}
    ],
    async tag => {
      seen.push(tag);
      return sha('a');
    }
  );
  assert.deepEqual(tags, ['v2.1.1']);
  assert.deepEqual(seen, ['v2.1.1']);
});
