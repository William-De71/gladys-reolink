import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as prettier from 'prettier';

import {
  parseCommit,
  latestTag,
  bumpLevel,
  nextVersion,
  groupCommits,
  addRelease,
  releaseNotes,
  bumpManifest,
  bumpPackage,
  bumpLock,
  SILENT_TYPES,
} from '../.github/scripts/release.mjs';

const REPO = 'https://github.com/William-De71/gladys-reolink';
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

let counter = 0;
const commit = (subject, body = '') => {
  counter += 1;
  return parseCommit({
    hash: `${String(counter).padStart(7, 'a')}${'0'.repeat(33)}`,
    subject,
    body,
  });
};

const changelog = (text, commits, version, previousTag = 'v1.0.0') =>
  addRelease(text, {
    version,
    date: '2026-10-12',
    groups: groupCommits(commits, REPO),
    repoUrl: REPO,
    previousTag,
  });

const formatted = (text) => prettier.format(text, { parser: 'markdown', proseWrap: 'preserve' });

test('parses conventional commits, scopes, breaking marks and pull requests', () => {
  const parsed = commit('feat(widgets)!: show the album cover (#12)');
  assert.equal(parsed.type, 'feat');
  assert.equal(parsed.scope, 'widgets');
  assert.equal(parsed.description, 'show the album cover');
  assert.equal(parsed.pr, 12);
  assert.equal(parsed.breaking, true);
  const footer = commit(
    'fix: read the profiles',
    'Details.\n\nBREAKING CHANGE: the poll interval is now in minutes',
  );
  assert.equal(footer.breaking, true);
  assert.equal(footer.breakingNote, 'the poll interval is now in minutes');
  assert.equal(commit('Merge branch main').type, null);
});

test('picks the latest tag, with or without the v prefix', () => {
  assert.deepEqual(latestTag(['v1.0.0', 'v1.2.0', 'v1.10.0', 'beta']), {
    tag: 'v1.10.0',
    version: '1.10.0',
  });
  assert.deepEqual(latestTag(['1.0.0', '0.9.0']), { tag: '1.0.0', version: '1.0.0' });
  assert.equal(latestTag([]), null);
});

test('computes the version from each type of commit', () => {
  assert.equal(nextVersion('1.0.0', [commit('feat: add a widget')]), '1.1.0');
  assert.equal(nextVersion('1.0.0', [commit('fix: read the counter')]), '1.0.1');
  assert.equal(nextVersion('1.0.0', [commit('perf: fewer calls')]), '1.0.1');
  assert.equal(nextVersion('1.0.0', [commit('fix: x'), commit('feat: y')]), '1.1.0');
  for (const type of SILENT_TYPES) {
    assert.equal(nextVersion('1.0.0', [commit(`${type}: something long enough`)]), null, type);
  }
  assert.equal(nextVersion('1.0.0', [commit('Update README.md')]), null);
});

test('a breaking change is a major from 1.0.0, a minor below', () => {
  assert.equal(nextVersion('1.4.2', [commit('feat!: new device ids')]), '2.0.0');
  assert.equal(nextVersion('0.4.2', [commit('feat!: new device ids')]), '0.5.0');
  assert.equal(nextVersion('0.4.2', [commit('fix: x', 'BREAKING CHANGE: y')]), '0.5.0');
  assert.equal(nextVersion('1.0.0', [commit('refactor!: drop a setting')]), '2.0.0');
});

test('release-as forces a version above the current one', () => {
  assert.equal(nextVersion('0.9.3', [], { releaseAs: '1.0.0' }), '1.0.0');
  assert.equal(nextVersion('0.9.3', [commit('docs: x')], { releaseAs: '1.0.0' }), '1.0.0');
  assert.throws(() => nextVersion('1.0.0', [], { releaseAs: '1.0.0' }), /above/);
  assert.throws(() => nextVersion('1.0.0', [], { releaseAs: 'v2' }), /x\.y\.z/);
});

test('a revert inside the range cancels its commit', () => {
  const feat = commit('feat: add a widget');
  const revert = parseCommit({
    hash: 'f'.repeat(40),
    subject: 'Revert "feat: add a widget"',
    body: `This reverts commit ${feat.hash}.`,
  });
  assert.equal(bumpLevel([feat, revert]), null);
  assert.equal(groupCommits([feat, revert], REPO).size, 0);
  // Reverting an already released feature removes it.
  const lone = parseCommit({
    hash: 'e'.repeat(40),
    subject: 'Revert "feat(widgets): add a widget"',
    body: 'This reverts commit 1234567.',
  });
  assert.equal(nextVersion('1.1.0', [lone]), '1.1.1');
  assert.deepEqual([...groupCommits([lone], REPO).keys()], ['Removed']);
});

test('groups the lines by section, breaking changes first, silent types out', () => {
  const groups = groupCommits(
    [
      commit('fix(widgets): keep the cover (#3)'),
      commit('feat: German and Spanish'),
      commit('perf: one call less'),
      commit('feat: remove the old setting'),
      commit('fix(security): validate the image keys'),
      commit('feat(device)!: rename the features', 'BREAKING CHANGE: recreate the devices'),
      commit('docs: typo'),
      commit('chore: deps'),
      commit('ci: cache'),
      commit('test: more'),
      commit('style: format'),
      commit('build: docker'),
    ],
    REPO,
  );
  assert.deepEqual(
    [...groups.keys()],
    ['Breaking changes', 'Added', 'Changed', 'Removed', 'Fixed', 'Security'],
  );
  assert.match(groups.get('Breaking changes')[0], /^- \*\*device:\*\* recreate the devices \(/);
  assert.match(
    groups.get('Fixed')[0],
    /^- \*\*widgets:\*\* keep the cover \(\[#3\]\(https:\/\/github\.com\/William-De71\/gladys-reolink\/pull\/3\), \[\w{7}\]\(https:\/\/github\.com\/William-De71\/gladys-reolink\/commit\/\w{40}\)\)$/,
  );
  assert.match(groups.get('Security')[0], /^- validate the image keys/);
  assert.equal(groups.get('Removed').length, 1);
});

test('adds the section on top of the existing history, with its comparison link', async () => {
  // The real file, whatever the releases already in it (header, links).
  const history = read('../CHANGELOG.md');
  const sections = history
    .slice(history.indexOf('\n## ') + 1)
    .replace(/\n\[[^\]]+\]: [\s\S]*$/, '');
  const result = changelog(history, [commit('feat: German and Spanish (#4)')], '9.0.0', 'v8.9.9');
  assert.ok(result.startsWith('# Changelog\n'));
  assert.equal(result.match(/^# Changelog$/gm).length, 1);
  assert.ok(result.includes(sections.trim()), 'the existing history is kept as is');
  assert.ok(result.indexOf('## [9.0.0] - 2026-10-12') < result.indexOf(sections.trim()));
  assert.match(
    result,
    /\n\[9\.0\.0\]: https:\/\/github\.com\/William-De71\/gladys-reolink\/compare\/v8\.9\.9\.\.\.v9\.0\.0\n/,
  );
  // Idempotent: a second run changes nothing.
  assert.equal(changelog(result, [commit('feat: other')], '9.0.0', 'v8.9.9'), result);
  // The next release keeps both links, newest first.
  const next = changelog(result, [commit('fix: x')], '9.0.1', 'v9.0.0');
  assert.match(next, /\[9\.0\.1\]: .*v9\.0\.0\.\.\.v9\.0\.1\n\[9\.0\.0\]: /);
  assert.equal(next.match(/^# Changelog$/gm).length, 1);
});

test('creates a changelog without inventing history', () => {
  const result = changelog('', [commit('fix: x')], '0.1.1', null);
  assert.ok(result.startsWith('# Changelog\n'));
  assert.equal(result.match(/^## /gm).length, 1);
  assert.match(result, /\[0\.1\.1\]: .*\/releases\/tag\/v0\.1\.1\n$/);
});

test('merges a hand-written Unreleased section once, then drops it', () => {
  const text = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '### Added',
    '',
    '- A note written by hand',
    '',
    '### Deprecated',
    '',
    '- The old setting',
    '',
    '## [1.0.0] - 2026-10-10',
    '',
    '### Added',
    '',
    '- First release',
    '',
    `[Unreleased]: ${REPO}/compare/v1.0.0...HEAD`,
    `[1.0.0]: ${REPO}/releases/tag/v1.0.0`,
    '',
  ].join('\n');
  const result = changelog(text, [commit('feat: generated line')], '1.1.0');
  assert.doesNotMatch(result, /Unreleased/);
  const notes = releaseNotes(result, '1.1.0');
  assert.match(notes, /### Added\n\n- A note written by hand\n- generated line/);
  assert.match(notes, /### Deprecated\n\n- The old setting/);
  assert.match(result, /## \[1\.0\.0\] - 2026-10-10\n\n### Added\n\n- First release/);
  assert.match(result, /\[1\.1\.0\]: .*\n\[1\.0\.0\]: .*releases\/tag\/v1\.0\.0\n$/);
});

test('the generated changelog is Prettier-clean', async () => {
  const result = changelog(
    '',
    [
      commit('feat(widgets): German and Spanish (#4)'),
      commit('fix: keep the cover'),
      commit('feat!: x', 'BREAKING CHANGE: recreate the devices'),
    ],
    '2.0.0',
    'v1.1.0',
  );
  assert.equal(await formatted(result), result);
  const second = changelog(result, [commit('perf: one call less')], '2.0.1', 'v2.0.0');
  assert.equal(await formatted(second), second);
});

test('the release notes are the section itself', () => {
  const result = changelog(read('../CHANGELOG.md'), [commit('feat: x')], '9.0.0', 'v8.9.9');
  const notes = releaseNotes(result, '9.0.0');
  assert.match(notes, /^### Added\n\n- x \(/);
  assert.doesNotMatch(notes, /^## /m, 'no other section');
  assert.ok(!notes.includes(']: '), 'no link definition');
  // Older headings, written before the automatic releases, are read too.
  assert.match(releaseNotes(result, '1.0.0'), /^### Features/);
  assert.equal(releaseNotes(result, '9.9.9'), '');
});

test('bumps the manifest, package.json and the lockfile in place', () => {
  const image = 'ghcr.io/william-de71/gladys-reolink:9.0.0';
  const manifest = read('../gladys-assistant-integration.json');
  const bumped = bumpManifest(manifest, '9.0.0', image);
  const before = manifest.split('\n');
  const after = bumped.split('\n');
  assert.equal(after.length, before.length, 'same layout');
  assert.equal(after.filter((line, i) => line !== before[i]).length, 2, 'only two lines change');
  assert.equal(JSON.parse(bumped).docker_image, image);

  const pkg = bumpPackage(read('../package.json'), '9.0.0');
  assert.equal(JSON.parse(pkg).version, '9.0.0');
  assert.equal(pkg.split('\n').length, read('../package.json').split('\n').length);

  const lock = bumpLock(read('../package-lock.json'), '9.0.0');
  const parsed = JSON.parse(lock);
  assert.equal(parsed.version, '9.0.0');
  assert.equal(parsed.packages[''].version, '9.0.0');
  // A dependency's version is never touched.
  const deps = (text) =>
    Object.entries(JSON.parse(text).packages)
      .filter(([key]) => key !== '')
      .map(([key, value]) => `${key}@${value.version}`);
  assert.deepEqual(deps(lock), deps(read('../package-lock.json')));
});

test('manifest, package.json and image tag agree', () => {
  const manifest = JSON.parse(read('../gladys-assistant-integration.json'));
  const pkg = JSON.parse(read('../package.json'));
  const lock = JSON.parse(read('../package-lock.json'));
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.ok(manifest.docker_image.endsWith(`:${pkg.version}`));
});
