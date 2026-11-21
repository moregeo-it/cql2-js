import Ajv2020 from 'ajv/dist/2020.js';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseJson, parseText } from '../src/index.js';

const fixtures = join(import.meta.dirname, 'fixtures', 'ogc');
const schema = JSON.parse(readFileSync(join(fixtures, 'cql2.schema.json'), 'utf8'));
const validate = new Ajv2020.default({ strict: false }).compile(schema);

/**
 * @param {any} node
 * @param {string} name
 */
function assertValid(node, name) {
  const json = JSON.parse(JSON.stringify(node));
  assert.ok(validate(json), `${name}: ${JSON.stringify(validate.errors?.[0])}`);
}

test('JSON written for the text examples is valid against the schema of the standard', () => {
  for (const name of readdirSync(join(fixtures, 'text'))) {
    assertValid(parseText(readFileSync(join(fixtures, 'text', name), 'utf8')), name);
  }
});

test('JSON written for the expressions of the abstract test suite is valid against the schema', () => {
  const lines = readFileSync(join(fixtures, 'ats-expressions.txt'), 'utf8').split('\n');
  for (const line of lines.filter(entry => entry.trim() && !entry.startsWith('#'))) {
    const expression = line.slice(line.indexOf('|') + 1);
    assertValid(parseText(expression), expression);
  }
});

test('everything the schema accepts among the JSON examples is accepted by the parser', () => {
  for (const name of readdirSync(join(fixtures, 'json')).filter(file => file.endsWith('.json'))) {
    const json = JSON.parse(readFileSync(join(fixtures, 'json', name), 'utf8'));
    assertValid(json, name);
    assertValid(parseJson(json), name);
  }
});

test('built filters are valid against the schema', () => {
  for (const text of [
    "a NOT LIKE 'x%' AND b NOT IN (1, 2) AND c IS NOT NULL AND d NOT BETWEEN 1 AND 2",
    "T_INTERSECTS(INTERVAL(starts, '..'), INTERVAL('2020-01-01', '2021-01-01T00:00:00Z'))",
    'S_INTERSECTS(geometry, GEOMETRYCOLLECTION(POINT(1 2), POLYGON((0 0, 1 0, 1 1, 0 0))))',
    "A_OVERLAPS(tags, ('a', 1, TRUE, DATE('2020-01-01'), (1, 2)))",
    'my_function(a, 1) AND -a + 2 * (b - 1) > c ^ 2',
    "ACCENTI(CASEI(name)) = accenti(casei('x'))"
  ]) {
    assertValid(parseText(text), text);
  }
});
