// -----------------------------------------------------------------------------
// Release helpers, run by the Release and GitHub releases workflows.
//
//   node .github/scripts/release.mjs plan [--release-as X.Y.Z]
//     Reads the commits since the last version tag and decides: is there
//     something to release, and which version? Prints a JSON object and, in
//     GitHub Actions, writes `release`, `version`, `previous_tag` to
//     $GITHUB_OUTPUT.
//
//   node .github/scripts/release.mjs bump <version> <docker-image>
//     Points the manifest (`version` + `docker_image`), package.json and
//     package-lock.json at the release.
//
//   node .github/scripts/release.mjs changelog <version> <repo-url> [--date YYYY-MM-DD]
//     Writes the section of <version> at the top of CHANGELOG.md, generated
//     from the same commits as `plan`.
//
//   node .github/scripts/release.mjs notes <version> < CHANGELOG.md
//     Prints the changelog section of <version>: the notes of its GitHub
//     Release, identical to the section.
//
// Versions follow the Conventional Commits since the last tag: `feat` ->
// minor, `fix` / `perf` / `revert` -> patch, `!` or a `BREAKING CHANGE:`
// footer -> major (minor while the version is below 1.0.0). `docs`, `chore`,
// `ci`, `test`, `style`, `refactor` and `build` alone release nothing.
//
// Every file is edited in place instead of being re-printed (jq,
// JSON.stringify...), so the release commit keeps the Prettier layout.
// test/release.test.js covers the pure functions below.
// -----------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MANIFEST_FILE = 'gladys-assistant-integration.json';
const PACKAGE_FILE = 'package.json';
const LOCK_FILE = 'package-lock.json';
const CHANGELOG_FILE = 'CHANGELOG.md';
const TAG_PREFIX = 'v';

const CHANGELOG_HEADER = `# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/). This file is generated at
each release from the Conventional Commits: do not edit it by hand.
`;

// Changelog sections, in the order they are printed.
const SECTIONS = ['Added', 'Changed', 'Removed', 'Fixed', 'Security'];
const BREAKING_HEADING = 'Breaking changes';

// Types that release something, and the section they land in.
const RELEASED_TYPES = { feat: 'Added', fix: 'Fixed', perf: 'Changed', revert: 'Removed' };
// Types that never release anything on their own.
const SILENT_TYPES = ['docs', 'chore', 'ci', 'test', 'style', 'refactor', 'build'];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const HEADER_PATTERN = /^(\w+)(?:\(([^)]*)\))?(!)?: (.+)$/;
const REVERT_SUBJECT = /^Revert "(.+)"$/;
const REVERTS_HASH = /This reverts commit ([0-9a-f]{7,40})/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE: ([\s\S]+?)(?:\n\n|\n[\w-]+: |$)/m;
const REMOVAL = /^(remove|drop|delete)\b/i;

/**
 * Parse a semantic version.
 * @param {string} version - e.g. 1.2.0.
 * @returns {number[]|null} [major, minor, patch], null when not x.y.z.
 */
export function parseVersion(version) {
  const match = SEMVER.exec(String(version ?? ''));
  return match ? match.slice(1).map(Number) : null;
}

/**
 * Compare two versions.
 * @param {string} a - Version.
 * @param {string} b - Version.
 * @returns {number} < 0, 0 or > 0.
 */
export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) {
      return x[i] - y[i];
    }
  }
  return 0;
}

/**
 * The latest version tag among a list, with or without the `v` prefix (tags
 * made before the automatic releases keep their name).
 * @param {string[]} tags - Tag names.
 * @returns {{ tag: string, version: string }|null} The latest one, null when none.
 */
export function latestTag(tags) {
  return (
    tags
      .map((tag) => ({ tag, version: tag.replace(/^v/, '') }))
      .filter(({ version }) => parseVersion(version))
      .sort((a, b) => compareVersions(b.version, a.version))[0] ?? null
  );
}

/**
 * Parse one commit into a Conventional Commit.
 * @param {{ hash: string, subject: string, body?: string }} commit - The commit.
 * @returns {object} `{ hash, type, scope, description, pr, breaking,
 * breakingNote, revertOf }`; `type` is null for a commit that does not
 * follow the convention.
 */
export function parseCommit({ hash, subject, body = '' }) {
  const base = { hash, type: null, scope: '', description: subject.trim(), pr: null };
  let rest = subject.trim();
  const pr = /\s*\(#(\d+)\)$/.exec(rest);
  if (pr) {
    base.pr = Number(pr[1]);
    rest = rest.slice(0, pr.index);
  }
  const revert = REVERT_SUBJECT.exec(rest);
  if (revert) {
    const original = parseCommit({ hash: '', subject: revert[1] });
    return {
      ...base,
      type: 'revert',
      scope: original.scope,
      description: `revert "${original.description}"`,
      revertedType: original.type,
      revertOf: REVERTS_HASH.exec(body)?.[1] ?? null,
      breaking: false,
      breakingNote: '',
    };
  }
  const header = HEADER_PATTERN.exec(rest);
  if (!header) {
    return { ...base, breaking: false, breakingNote: '', revertOf: null };
  }
  const footer = BREAKING_FOOTER.exec(body);
  return {
    ...base,
    type: header[1].toLowerCase(),
    scope: header[2] ?? '',
    description: header[4].trim(),
    breaking: Boolean(header[3] || footer),
    breakingNote: footer ? footer[1].trim().replace(/\s*\n\s*/g, ' ') : '',
    revertOf: null,
  };
}

/**
 * Drop the commits reverted inside the same range, with their revert: the
 * pair cancels out and neither reaches the changelog.
 * @param {object[]} commits - Parsed commits.
 * @returns {object[]} The commits that still count.
 */
export function cancelReverts(commits) {
  const cancelled = new Set();
  for (const commit of commits) {
    if (commit.type !== 'revert' || !commit.revertOf) {
      continue;
    }
    const original = commits.find(
      (other) => other !== commit && other.hash.startsWith(commit.revertOf),
    );
    if (original) {
      cancelled.add(original);
      cancelled.add(commit);
    }
  }
  return commits.filter((commit) => !cancelled.has(commit));
}

/**
 * The bump the commits call for.
 * @param {object[]} commits - Parsed commits.
 * @returns {'major'|'minor'|'patch'|null} null when nothing is released.
 */
export function bumpLevel(commits) {
  let level = null;
  for (const commit of cancelReverts(commits)) {
    // `!` or a BREAKING CHANGE footer breaks users whatever the type.
    if (commit.breaking && commit.type) {
      return 'major';
    }
    if (commit.type === 'feat') {
      level = 'minor';
    } else if (commit.type in RELEASED_TYPES && level === null) {
      level = 'patch';
    }
  }
  return level;
}

/**
 * The next version.
 * @param {string} current - The latest released version.
 * @param {object[]} commits - Parsed commits since that version.
 * @param {object} [options] - Options.
 * @param {string} [options.releaseAs] - Forced version (e.g. 1.0.0).
 * @returns {string|null} The version, null when nothing is to be released.
 * @throws {Error} When the forced version is not above the current one.
 */
export function nextVersion(current, commits, { releaseAs = '' } = {}) {
  if (releaseAs) {
    if (!parseVersion(releaseAs)) {
      throw new Error(`release-as: "${releaseAs}" is not a x.y.z version`);
    }
    if (compareVersions(releaseAs, current) <= 0) {
      throw new Error(`release-as: ${releaseAs} must be above the current version ${current}`);
    }
    return releaseAs;
  }
  let level = bumpLevel(commits);
  if (level === null) {
    return null;
  }
  const [major, minor, patch] = parseVersion(current);
  // Below 1.0.0, a breaking change is a minor: 1.0.0 is a deliberate choice
  // (`release-as`), never a side effect of a commit message.
  if (level === 'major' && major === 0) {
    level = 'minor';
  }
  if (level === 'major') {
    return `${major + 1}.0.0`;
  }
  if (level === 'minor') {
    return `${major}.${minor + 1}.0`;
  }
  return `${major}.${minor}.${patch + 1}`;
}

/**
 * The section a released commit lands in.
 * @param {object} commit - Parsed commit.
 * @returns {string|null} The section, null for a commit left out.
 */
function sectionOf(commit) {
  if (!(commit.type in RELEASED_TYPES)) {
    return null;
  }
  if (commit.scope === 'security') {
    return 'Security';
  }
  if (commit.type === 'revert') {
    return commit.revertedType === 'feat' ? 'Removed' : 'Fixed';
  }
  if (REMOVAL.test(commit.description)) {
    return 'Removed';
  }
  return RELEASED_TYPES[commit.type];
}

/**
 * One changelog line: `- **scope:** description ([#12](...), [abc1234](...))`.
 * @param {object} commit - Parsed commit.
 * @param {string} repoUrl - Repository URL.
 * @param {string} [text] - Text instead of the description.
 * @returns {string} The line.
 */
function changelogLine(commit, repoUrl, text = commit.description) {
  const scope = commit.scope && commit.scope !== 'security' ? `**${commit.scope}:** ` : '';
  const refs = [];
  if (commit.pr) {
    refs.push(`[#${commit.pr}](${repoUrl}/pull/${commit.pr})`);
  }
  if (commit.hash) {
    refs.push(`[${commit.hash.slice(0, 7)}](${repoUrl}/commit/${commit.hash})`);
  }
  return `- ${scope}${text}${refs.length > 0 ? ` (${refs.join(', ')})` : ''}`;
}

/**
 * Group the released commits by section.
 * @param {object[]} commits - Parsed commits.
 * @param {string} repoUrl - Repository URL.
 * @returns {Map<string, string[]>} Section -> lines, the breaking block first.
 */
export function groupCommits(commits, repoUrl) {
  const groups = new Map();
  const add = (section, line) => {
    if (!groups.has(section)) {
      groups.set(section, []);
    }
    groups.get(section).push(line);
  };
  const kept = cancelReverts(commits);
  for (const commit of kept.filter((c) => c.breaking)) {
    add(BREAKING_HEADING, changelogLine(commit, repoUrl, commit.breakingNote || undefined));
  }
  for (const commit of kept) {
    const section = sectionOf(commit);
    if (section) {
      add(section, changelogLine(commit, repoUrl));
    }
  }
  const ordered = new Map();
  for (const section of [BREAKING_HEADING, ...SECTIONS]) {
    if (groups.has(section)) {
      ordered.set(section, groups.get(section));
    }
  }
  return ordered;
}

/**
 * Read the `### Heading` lists of a changelog body (the `[Unreleased]`
 * section written by hand before the automatic releases).
 * @param {string} body - The section body.
 * @returns {{ intro: string, groups: Map<string, string[]> }} Free text and lists.
 */
function readBody(body) {
  const groups = new Map();
  const intro = [];
  let current = null;
  for (const line of body.split('\n')) {
    const heading = /^### (.+)$/.exec(line.trim());
    if (heading) {
      current = heading[1].trim();
      if (!groups.has(current)) {
        groups.set(current, []);
      }
    } else if (line.trim() && current) {
      const item = groups.get(current);
      if (/^[-*] /.test(line)) {
        item.push(`- ${line.replace(/^[-*] /, '')}`);
      } else if (item.length > 0) {
        item[item.length - 1] += ` ${line.trim()}`;
      }
    } else if (line.trim()) {
      intro.push(line.trim());
    }
  }
  return { intro: intro.join('\n'), groups };
}

/**
 * Render the section of a version.
 * @param {object} options - Options.
 * @param {string} options.version - The version.
 * @param {string} options.date - YYYY-MM-DD.
 * @param {Map<string, string[]>} options.groups - From groupCommits.
 * @param {string} [options.unreleased] - Body of a hand-written `[Unreleased]`
 * section, merged once into this one.
 * @returns {string} The section, ending with a newline.
 */
export function renderSection({ version, date, groups, unreleased = '' }) {
  const merged = new Map(groups);
  const { intro, groups: extra } = readBody(unreleased);
  for (const [section, lines] of extra) {
    merged.set(section, [...lines, ...(merged.get(section) ?? [])]);
  }
  const order = [BREAKING_HEADING, ...SECTIONS];
  const sections = [...merged.keys()].sort((a, b) => {
    const [x, y] = [order.indexOf(a), order.indexOf(b)];
    return (x === -1 ? order.length : x) - (y === -1 ? order.length : y);
  });
  let text = `## [${version}] - ${date}\n`;
  if (intro) {
    text += `\n${intro}\n`;
  }
  for (const section of sections) {
    text += `\n### ${section}\n\n${merged.get(section).join('\n')}\n`;
  }
  if (sections.length === 0 && !intro) {
    text += '\nNo user-facing change.\n';
  }
  return text;
}

/**
 * Add the section of a released version to a changelog. Keeps everything
 * already there, adds the Keep a Changelog header when missing, merges a
 * hand-written `## [Unreleased]` section once (then drops it) and appends the
 * comparison link. Idempotent: a version already listed is left as is.
 * @param {string} text - Current CHANGELOG.md content ('' when absent).
 * @param {object} options - Options.
 * @param {string} options.version - The version.
 * @param {string} options.date - YYYY-MM-DD.
 * @param {Map<string, string[]>} options.groups - From groupCommits.
 * @param {string} options.repoUrl - Repository URL.
 * @param {string|null} options.previousTag - Tag of the previous version.
 * @returns {string} The new content.
 */
export function addRelease(text, { version, date, groups, repoUrl, previousTag }) {
  const escaped = version.replaceAll('.', '\\.');
  if (new RegExp(`^## \\[?${escaped}\\]?(?: |$)`, 'm').test(text)) {
    return text;
  }
  let rest = text.trim();
  if (rest.startsWith('# ')) {
    // Drop the header, rewritten below (an older one is replaced as a whole).
    const firstSection = rest.search(/^## /m);
    rest = firstSection === -1 ? '' : rest.slice(firstSection);
  }

  let unreleased = '';
  const heading = /^## \[Unreleased\][^\n]*$/im.exec(rest);
  if (heading) {
    const bodyStart = heading.index + heading[0].length;
    const after = rest.slice(bodyStart);
    const next = after.search(/^## |^\[[^\]]+\]: /m);
    const bodyEnd = next === -1 ? rest.length : bodyStart + next;
    unreleased = rest.slice(bodyStart, bodyEnd).trim();
    rest = `${rest.slice(0, heading.index)}${rest.slice(bodyEnd)}`.trim();
    rest = rest.replace(/^\[Unreleased\]: .*\n?/im, '').trim();
  }

  const section = renderSection({ version, date, groups, unreleased });
  const tag = `${TAG_PREFIX}${version}`;
  const link = previousTag
    ? `[${version}]: ${repoUrl}/compare/${previousTag}...${tag}`
    : `[${version}]: ${repoUrl}/releases/tag/${tag}`;

  // The link definitions close the file: keep them together, newest first.
  const linksStart = rest.search(/^\[[^\]]+\]: /m);
  const history = (linksStart === -1 ? rest : rest.slice(0, linksStart)).trim();
  const links = linksStart === -1 ? '' : rest.slice(linksStart).trim();
  const parts = [CHANGELOG_HEADER.trim(), section.trim()];
  if (history) {
    parts.push(history);
  }
  parts.push(links ? `${link}\n${links}` : link);
  return `${parts.join('\n\n')}\n`;
}

/**
 * Body of the changelog section of a version: the notes of its GitHub Release.
 * @param {string} text - CHANGELOG.md content.
 * @param {string} version - Version, e.g. 1.2.0.
 * @returns {string} The section body, empty when the version has none.
 */
export function releaseNotes(text, version) {
  const escaped = version.replaceAll('.', '\\.');
  // `## [1.2.0] - date`, `## 1.2.0 (date)` and, before the automatic
  // releases, `## [1.2.0](compare-link) (date)`.
  const match = new RegExp(`^## \\[?${escaped}\\]?(?:\\([^)]*\\))?(?: .*)?$`, 'm').exec(text);
  if (!match) {
    return '';
  }
  const bodyStart = match.index + match[0].length;
  const rest = text.slice(bodyStart);
  const end = rest.search(/^## |^\[[^\]]+\]: /m);
  return (end === -1 ? rest : rest.slice(0, end)).trim();
}

/**
 * Name of a Docker image reference, without its tag or digest.
 * @param {string} ref - Image reference, e.g. ghcr.io/me/repo:1.2.0.
 * @returns {string} The image name, e.g. ghcr.io/me/repo.
 */
function imageName(ref) {
  const name = ref.split('@')[0];
  const tag = name.indexOf(':', name.lastIndexOf('/') + 1);
  return tag === -1 ? name : name.slice(0, tag);
}

/**
 * Set the top-level `version` and `docker_image` of a manifest, leaving every
 * other byte of the file untouched (a sub-container running the integration's
 * own image follows it, as in the official template).
 * @param {string} text - Manifest content (Prettier-formatted JSON).
 * @param {string} version - Released version.
 * @param {string} dockerImage - Image of that version.
 * @returns {string} The new manifest content.
 */
export function bumpManifest(text, version, dockerImage) {
  const manifest = JSON.parse(text);
  const updates = { version, docker_image: dockerImage };
  const indent = /^[ \t]+(?=")/m.exec(text)?.[0];
  let result = text;
  for (const [key, value] of Object.entries(updates)) {
    const pattern = new RegExp(`^(${indent}"${key}":\\s*)"[^"]*"`, 'm');
    if (indent === undefined || !pattern.test(result)) {
      throw new Error(`${MANIFEST_FILE}: no top-level "${key}" string to update`);
    }
    result = result.replace(pattern, (_match, prefix) => prefix + JSON.stringify(value));
  }
  const ownImages = new Set([imageName(manifest.docker_image), imageName(dockerImage)]);
  result = result.replace(/("docker_image":\s*)"([^"]*)"/g, (match, prefix, image) =>
    ownImages.has(imageName(image)) ? prefix + JSON.stringify(dockerImage) : match,
  );
  const expected = { ...manifest, ...updates };
  if (Array.isArray(manifest.containers)) {
    expected.containers = manifest.containers.map((container) =>
      ownImages.has(imageName(String(container?.docker_image ?? '')))
        ? { ...container, docker_image: dockerImage }
        : container,
    );
  }
  assert.deepEqual(JSON.parse(result), expected);
  return result;
}

/**
 * Set the version of package.json, in place.
 * @param {string} text - package.json content.
 * @param {string} version - Released version.
 * @returns {string} The new content.
 */
export function bumpPackage(text, version) {
  const result = text.replace(
    /^(\s{2}"version":\s*)"[^"]*"/m,
    (_m, prefix) => `${prefix}"${version}"`,
  );
  assert.deepEqual(JSON.parse(result), { ...JSON.parse(text), version });
  return result;
}

/**
 * Set the version of the root package in package-lock.json (its top-level
 * `version` and `packages[""].version`), in place.
 * @param {string} text - package-lock.json content.
 * @param {string} version - Released version.
 * @returns {string} The new content.
 */
export function bumpLock(text, version) {
  let result = text.replace(
    /^(\s{2}"version":\s*)"[^"]*"/m,
    (_m, prefix) => `${prefix}"${version}"`,
  );
  result = result.replace(
    /^(\s{4}"": \{\n(?:\s{6}.*\n)*?\s{6}"version":\s*)"[^"]*"/m,
    (_m, prefix) => `${prefix}"${version}"`,
  );
  const before = JSON.parse(text);
  const after = JSON.parse(result);
  assert.equal(after.version, version);
  if (before.packages?.['']) {
    assert.equal(after.packages[''].version, version);
  }
  return result;
}

// --- Git -----------------------------------------------------------------------

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

/**
 * The base of the next release and the commits since.
 * @returns {{ current: string, previousTag: string|null, commits: object[] }} The base.
 */
function readHistory() {
  const tags = git('tag', '--merged', 'HEAD').split('\n').filter(Boolean);
  const latest = latestTag(tags);
  // Without a tag, the version in package.json is taken as released already
  // (its image exists): the first automatic release starts from it, it never
  // publishes it again.
  const current = latest?.version ?? JSON.parse(readFileSync(PACKAGE_FILE, 'utf8')).version;
  const range = latest ? [`${latest.tag}..HEAD`] : ['HEAD'];
  const log = git('log', '--no-merges', '--format=%H%x1f%s%x1f%b%x1e', ...range);
  const commits = log
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [hash, subject, body] = entry.split('\x1f');
      return parseCommit({ hash, subject, body });
    })
    // The release commits only repeat the version heading.
    .filter((commit) => !(commit.type === 'chore' && commit.scope === 'release'))
    .reverse();
  return { current, previousTag: latest?.tag ?? null, commits };
}

/**
 * Read a `--name value` option.
 * @param {string[]} args - Arguments.
 * @param {string} name - Option name.
 * @returns {string} Its value, '' when absent.
 */
function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? '' : (args[index + 1] ?? '');
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'plan') {
    const { current, previousTag, commits } = readHistory();
    const releaseAs = option(args, '--release-as');
    const version = nextVersion(current, commits, { releaseAs });
    const plan = {
      release: version !== null,
      version: version ?? current,
      previous_tag: previousTag,
    };
    console.log(JSON.stringify(plan));
    if (process.env.GITHUB_OUTPUT) {
      writeFileSync(
        process.env.GITHUB_OUTPUT,
        Object.entries(plan)
          .map(([key, value]) => `${key}=${value ?? ''}\n`)
          .join(''),
        { flag: 'a' },
      );
    }
  } else if (command === 'bump') {
    const [version, dockerImage] = args;
    assert.ok(parseVersion(version), 'Usage: release.mjs bump <x.y.z> <docker-image>');
    writeFileSync(
      MANIFEST_FILE,
      bumpManifest(readFileSync(MANIFEST_FILE, 'utf8'), version, dockerImage),
    );
    writeFileSync(PACKAGE_FILE, bumpPackage(readFileSync(PACKAGE_FILE, 'utf8'), version));
    if (existsSync(LOCK_FILE)) {
      writeFileSync(LOCK_FILE, bumpLock(readFileSync(LOCK_FILE, 'utf8'), version));
    }
  } else if (command === 'changelog') {
    const [version, repoUrl] = args;
    assert.ok(parseVersion(version) && repoUrl, 'Usage: release.mjs changelog <x.y.z> <repo-url>');
    const date = option(args, '--date') || new Date().toISOString().slice(0, 10);
    const { previousTag, commits } = readHistory();
    const text = existsSync(CHANGELOG_FILE) ? readFileSync(CHANGELOG_FILE, 'utf8') : '';
    const groups = groupCommits(commits, repoUrl);
    writeFileSync(
      CHANGELOG_FILE,
      addRelease(text, { version, date, groups, repoUrl, previousTag }),
    );
  } else if (command === 'notes') {
    const [version] = args;
    assert.ok(parseVersion(version), 'Usage: release.mjs notes <x.y.z> < CHANGELOG.md');
    process.stdout.write(`${releaseNotes(readFileSync(0, 'utf8'), version)}\n`);
  } else {
    console.error('Usage: release.mjs plan|bump|changelog|notes ...');
    process.exit(1);
  }
}

export { SILENT_TYPES, CHANGELOG_HEADER };
