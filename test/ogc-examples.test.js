import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CONFORMANCE_PREFIX, parse, parseJson, parseText, requiredConformance, validate } from '../src/index.js';

const fixtures = join(import.meta.dirname, 'fixtures', 'ogc');
const textFiles = readdirSync(join(fixtures, 'text')).filter(name => name.endsWith('.txt'));
const jsonFiles = readdirSync(join(fixtures, 'json')).filter(name => name.endsWith('.json'));

const TEXT_AND_JSON_DIFFER = new Map([
  ['example54', 'the text has fractional seconds that the JSON lacks'],
  ['example55', 'the text has fractional seconds that the JSON lacks'],
  ['example82', 'the text has fractional seconds that the JSON lacks']
]);

/** @type {Record<string, string[]>} */
const IMPLIED_CLASSES = {
  'accent-insensitive-comparison': ['advanced-comparison-operators', 'case-insensitive-comparison'],
  'case-insensitive-comparison': ['advanced-comparison-operators'],
  'spatial-functions': ['basic-spatial-functions', 'basic-spatial-functions-plus']
};

/**
 * @param {any} node
 * @returns {any}
 */
function plain(node) {
  return JSON.parse(JSON.stringify(node));
}

/**
 * @param {string} folder
 * @param {string} name
 * @returns {string}
 */
function read(folder, name) {
  return readFileSync(join(fixtures, folder, name), 'utf8');
}

test('the fixtures are complete', () => {
  assert.equal(textFiles.length, 120);
  assert.equal(jsonFiles.length, 109);
});

test('every text example parses and survives a round trip through text', () => {
  for (const name of textFiles) {
    const node = parseText(read('text', name));
    const written = node.toText();
    assert.deepEqual(plain(parseText(written)), plain(node), `${name}: ${written}`);
  }
});

test('every JSON example parses and is written back unchanged', () => {
  for (const name of jsonFiles) {
    const json = JSON.parse(read('json', name));
    assert.deepEqual(plain(parseJson(json)), plain(json), name);
  }
});

test('every JSON example survives a round trip through text', () => {
  for (const name of jsonFiles) {
    const json = JSON.parse(read('json', name));
    const written = parseJson(json).toText();
    assert.deepEqual(plain(parseText(written)), plain(json), `${name}: ${written}`);
  }
});

test('text and JSON examples of the same name describe the same filter', () => {
  let compared = 0;
  for (const name of textFiles) {
    const id = name.replace('.txt', '');
    if (TEXT_AND_JSON_DIFFER.has(id) || !existsSync(join(fixtures, 'json', `${id}.json`))) {
      continue;
    }
    const json = JSON.parse(read('json', `${id}.json`));
    assert.deepEqual(plain(parseText(read('text', name))), plain(json), name);
    compared++;
  }
  assert.ok(compared > 90, `only ${compared} pairs compared`);
});

test('the encoding is detected', () => {
  assert.deepEqual(plain(parse(read('text', 'example01.txt'))), plain(parse(read('json', 'example01.json'))));
  assert.deepEqual(plain(parse(JSON.parse(read('json', 'example01.json')))), plain(parse(read('text', 'example01.txt'))));
});

test('no example has a type problem', () => {
  for (const name of textFiles) {
    const problems = validate(parseText(read('text', name)));
    assert.deepEqual(problems.map(problem => `${problem.code}: ${problem.message}`), [], name);
  }
});

test('expressions of the abstract test suite need only their own conformance class', () => {
  const lines = read('.', 'ats-expressions.txt').split('\n').filter(line => line.trim() && !line.startsWith('#'));
  assert.equal(lines.length, 175);
  for (const line of lines) {
    const separator = line.indexOf('|');
    const conformance = line.slice(0, separator);
    const expression = line.slice(separator + 1);
    const node = parseText(expression);
    assert.deepEqual(validate(node, { conformance: [conformance, ...(IMPLIED_CLASSES[conformance] ?? [])] }), [], expression);

    const allowed = new Set(['basic-cql2', conformance, ...(IMPLIED_CLASSES[conformance] ?? [])]);
    const required = requiredConformance(node).map(uri => uri.slice(CONFORMANCE_PREFIX.length));
    assert.deepEqual(required.filter(name => !allowed.has(name)), [], expression);
    if (!['spatial-functions', 'property-property'].includes(conformance)) {
      assert.ok(required.includes(conformance), `${expression} should need ${conformance}`);
    }
  }
});
