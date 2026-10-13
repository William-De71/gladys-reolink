// -----------------------------------------------------------------------------
// The four languages of Gladys: English, French, German and Spanish, in the
// manifest, the user documentation and the READMEs. The runtime messages are
// checked by test/messages.test.js.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const LANGUAGES = ['en', 'fr', 'de', 'es'];
const READMES = { en: 'README.md', fr: 'README.fr.md', de: 'README.de.md', es: 'README.es.md' };

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const manifest = JSON.parse(read('../gladys-assistant-integration.json'));

const headings = (value) => value.split('\n').filter((line) => /^#{1,3} /.test(line)).length;
const tables = (value) => value.split('\n').filter((line) => /^\|\s*-/.test(line)).length;

/**
 * Every multi-language object of the manifest, with its path.
 * @param {unknown} node - A manifest node.
 * @param {string} path - Its path.
 * @returns {Array<[string, object]>} The texts.
 */
function texts(node, path = '') {
  if (Array.isArray(node)) {
    return node.flatMap((child, i) => texts(child, `${path}[${i}]`));
  }
  if (node && typeof node === 'object') {
    if (typeof node.en === 'string') {
      return [[path, node]];
    }
    return Object.entries(node).flatMap(([key, child]) => texts(child, `${path}.${key}`));
  }
  return [];
}

test('every manifest text exists in English, French, German and Spanish', () => {
  const found = texts(manifest);
  assert.ok(found.length > 40);
  for (const [path, entry] of found) {
    assert.deepEqual(Object.keys(entry).sort(), [...LANGUAGES].sort(), path);
    for (const language of LANGUAGES) {
      assert.ok(entry[language]?.trim(), `${path}.${language} is missing`);
    }
  }
});

test('catalog description: 10 to 100 characters per language', () => {
  for (const language of LANGUAGES) {
    const { length } = manifest.description[language];
    assert.ok(length >= 10 && length <= 100, `description.${language}: ${length}`);
  }
});

test('the manifest stays under the 100 KB of the store', () => {
  assert.ok(Buffer.byteLength(read('../gladys-assistant-integration.json')) < 100 * 1024);
});

test('docs: the four languages, with the same structure', () => {
  const docs = Object.fromEntries(
    LANGUAGES.map((language) => {
      const path = new URL(`../docs/${language}.md`, import.meta.url);
      assert.ok(existsSync(path), `docs/${language}.md is missing`);
      return [language, readFileSync(path, 'utf8')];
    }),
  );
  for (const language of LANGUAGES) {
    assert.ok(docs[language].length > 300, `docs/${language}.md is too short`);
    assert.equal(headings(docs[language]), headings(docs.en), `docs/${language}.md headings`);
    assert.equal(tables(docs[language]), tables(docs.en), `docs/${language}.md tables`);
    // The store shows the cover above the docs already.
    assert.ok(!docs[language].includes('cover.jpg'), `docs/${language}.md: no cover`);
    // The store re-hosts the docs: a relative image would break there.
    assert.doesNotMatch(docs[language], /!\[[^\]]*\]\((?!https:\/\/)/, `docs/${language}.md`);
  }
});

test('README: one per language, each linking to the three others, with badges and cover', () => {
  const english = read(`../${READMES.en}`);
  for (const [language, file] of Object.entries(READMES)) {
    const path = new URL(`../${file}`, import.meta.url);
    assert.ok(existsSync(path), `${file} is missing`);
    const content = readFileSync(path, 'utf8');
    for (const other of Object.values(READMES).filter((name) => name !== file)) {
      assert.ok(content.includes(`](${other})`), `${file} does not link to ${other}`);
    }
    assert.ok(content.includes(`](docs/${language}.md)`), `${file}: user documentation`);
    assert.match(content, /\n!\[[^\]]+\]\(cover\.jpg\)\n/, `${file}: cover`);
    // The four badges, the cover right below them.
    const badges = content.indexOf('img.shields.io/badge/');
    assert.ok(badges > 0 && badges < content.indexOf('](cover.jpg)'), `${file}: badges first`);
    for (const badge of ['Apache--2.0', 'github/v/release', 'actions/workflow/status', 'Gladys-']) {
      assert.ok(content.includes(badge), `${file}: badge ${badge}`);
    }
    // The Gladys badge follows the manifest minimum.
    const minimum = manifest.gladys_version.replace(/^>=/, '');
    assert.ok(content.includes(`Gladys-%E2%89%A5%20${minimum}-`), `${file}: Gladys ${minimum}`);
    assert.equal(headings(content), headings(english), `${file}: same sections as README.md`);
    assert.equal(tables(content), tables(english), `${file}: same tables as README.md`);
    assert.ok(content.includes('](docs/assets/overview.svg)'), `${file}: architecture`);
  }
});

test('README: every image exists, and every table of contents entry points to a heading', () => {
  // GitHub anchors: lower case, punctuation dropped, spaces to hyphens.
  const slug = (heading) =>
    heading
      .toLowerCase()
      .replace(/[^\p{L}\p{N} -]/gu, '')
      .replace(/ /g, '-');
  for (const file of Object.values(READMES)) {
    const content = read(`../${file}`);
    for (const [, image] of content.matchAll(/!\[[^\]]*\]\(((?!https?:)[^)]+)\)/g)) {
      assert.ok(existsSync(new URL(`../${image}`, import.meta.url)), `${file}: ${image}`);
    }
    const anchors = new Set(
      content
        .split('\n')
        .filter((line) => line.startsWith('## '))
        .map((line) => slug(line.slice(3))),
    );
    const links = [...content.matchAll(/^- \[[^\]]+\]\(#([^)]+)\)$/gm)].map((match) => match[1]);
    assert.ok(links.length >= 10, `${file}: table of contents`);
    for (const link of links) {
      assert.ok(anchors.has(link), `${file}: #${link}`);
    }
  }
});
