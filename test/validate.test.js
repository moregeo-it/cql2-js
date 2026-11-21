import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CONFORMANCE_PREFIX, CqlEqual, CqlValue, parseJson, parseText, requiredConformance, schemaToType, validate } from '../src/index.js';

const queryables = {
  id: { type: 'string' },
  datetime: { type: 'string', format: 'date-time' },
  acquired: { type: 'string', format: 'date' },
  'eo:cloud_cover': { type: 'number' },
  gsd: { type: ['integer', 'null'] },
  public: { type: 'boolean' },
  keywords: { type: 'array', items: { type: 'string' } },
  geometry: { $ref: 'https://geojson.org/schema/Geometry.json' },
  footprint: { format: 'geometry-polygon' }
};

/**
 * @param {string} text
 * @param {import('../src/validate.js').ValidateOptions} [options]
 * @returns {string[]}
 */
function codes(text, options = { queryables }) {
  return validate(parseText(text), options).map(problem => problem.code);
}

test('maps JSON Schemas of queryables to types', () => {
  assert.equal(schemaToType(queryables.datetime), 'timestamp');
  assert.equal(schemaToType(queryables.acquired), 'date');
  assert.equal(schemaToType(queryables.gsd), 'number');
  assert.equal(schemaToType(queryables.geometry), 'geometry');
  assert.equal(schemaToType(queryables.footprint), 'geometry');
  assert.equal(schemaToType(queryables.keywords), 'array');
  assert.equal(schemaToType('number'), 'number');
  assert.equal(schemaToType({}), null);
});

test('accepts valid filters', () => {
  for (const text of [
    "id = 'a' AND eo:cloud_cover < 10",
    "datetime >= TIMESTAMP('2020-01-01T00:00:00Z')",
    "datetime > DATE('2020-01-01')",
    "T_INTERSECTS(datetime, INTERVAL('2020-01-01', '..'))",
    'S_INTERSECTS(geometry, BBOX(0, 0, 1, 1))',
    "A_CONTAINS(keywords, ('a', 'b'))",
    "CASEI(id) LIKE casei('a%')",
    'eo:cloud_cover BETWEEN 0 AND gsd',
    'gsd IN (10, 20)',
    'public = TRUE',
    'public',
    'gsd * 2 + 1 > eo:cloud_cover',
    'footprint IS NULL'
  ]) {
    assert.deepEqual(validate(parseText(text), { queryables }), [], text);
  }
});

test('reports unknown properties with their position', () => {
  const [problem] = validate(parseText('id = 1 AND nope = 2', { }), { queryables }).filter(p => p.code === 'unknown-property');
  assert.match(problem.message, /"nope" is not a queryable/);
  assert.deepEqual(problem.span, { start: 11, end: 15 });
  assert.deepEqual(codes('nope = 2', { queryables, additionalProperties: true }), []);
  assert.deepEqual(codes('nope = 2', {}), []);
});

test('reports type mismatches', () => {
  assert.deepEqual(codes('id = 1'), ['type-mismatch']);
  assert.deepEqual(codes("eo:cloud_cover = '10'"), ['type-mismatch']);
  assert.deepEqual(codes("eo:cloud_cover LIKE 'a%'"), ['type-mismatch']);
  assert.deepEqual(codes("id BETWEEN 1 AND 2"), ['type-mismatch']);
  assert.deepEqual(codes("gsd IN (10, 'x')"), ['type-mismatch']);
  assert.deepEqual(codes('S_INTERSECTS(id, BBOX(0, 0, 1, 1))'), ['type-mismatch']);
  assert.deepEqual(codes("T_AFTER(geometry, DATE('2020-01-01'))"), ['type-mismatch']);
  assert.deepEqual(codes('A_CONTAINS(id, (1))'), ['type-mismatch']);
  assert.deepEqual(codes("id + 1 = 2"), ['type-mismatch']);
  assert.deepEqual(codes('CASEI(gsd) = 1'), ['type-mismatch', 'type-mismatch']);
  assert.deepEqual(codes('id = 1 AND gsd'), ['type-mismatch', 'type-mismatch']);
  assert.deepEqual(codes("geometry = 'a'"), ['type-mismatch']);
  const [problem] = validate(parseText("eo:cloud_cover = '10'"), { queryables });
  assert.match(problem.message, /right side of = is of type string, but is compared with type number/);
  assert.deepEqual(problem.span, { start: 17, end: 21 });
});

test('reports problems of JSON filters with their path', () => {
  const [problem] = validate(parseJson({ op: 'and', args: [true, { op: '=', args: [{ property: 'id' }, 5] }] }), { queryables });
  assert.equal(problem.code, 'type-mismatch');
  assert.deepEqual(problem.path, ['args', 1, 'args', 1]);
  assert.equal(problem.span, null);
});

test('a filter must be boolean and a LIKE pattern must be a string', () => {
  assert.deepEqual(codes('gsd + 1'), ['not-boolean']);
  assert.deepEqual(codes("'text'"), ['not-boolean']);
  assert.deepEqual(codes('id LIKE id'), ['invalid-pattern']);
});

test('checks functions that the server offers', () => {
  const functions = { Area: { returns: /** @type {const} */ ('number'), args: [/** @type {const} */ ('geometry')] } };
  assert.deepEqual(codes('area(geometry) > 10', { queryables, functions }), []);
  assert.deepEqual(codes('volume(geometry) > 10', { queryables, functions }), ['unknown-function']);
  assert.deepEqual(codes('area(id) > 10', { queryables, functions }), ['type-mismatch']);
  assert.deepEqual(codes('area(geometry, 1) > 10', { queryables, functions }), ['type-mismatch']);
  assert.deepEqual(codes("area(geometry) = 'big'", { queryables, functions }), ['type-mismatch']);
  assert.deepEqual(codes('anything(id) = 1', { queryables }), []);
});

test('reports missing conformance classes', () => {
  const basic = { conformance: [] };
  assert.deepEqual(codes("a = 1 AND NOT b = 'x' OR c IS NULL", basic), []);
  const cases = {
    "a LIKE 'x%'": 'advanced-comparison-operators',
    'a BETWEEN 1 AND 2': 'advanced-comparison-operators',
    'a IN (1, 2)': 'advanced-comparison-operators',
    "CASEI(a) = casei('x')": 'case-insensitive-comparison',
    "ACCENTI(a) = accenti('x')": 'accent-insensitive-comparison',
    'S_INTERSECTS(g, POINT(1 2))': 'basic-spatial-functions',
    'S_INTERSECTS(g, LINESTRING(1 2, 3 4))': 'basic-spatial-functions-plus',
    'S_WITHIN(g, BBOX(0, 0, 1, 1))': 'spatial-functions',
    "T_AFTER(a, DATE('2020-01-01'))": 'temporal-functions',
    'A_CONTAINS(a, (1))': 'array-functions',
    'a = b': 'property-property',
    '1 = a': 'property-property',
    'f(a) = 1': 'functions',
    'a + 1 = 2': 'arithmetic'
  };
  for (const [text, expected] of Object.entries(cases)) {
    const problems = validate(parseText(text), basic);
    assert.ok(problems.length > 0, text);
    for (const problem of problems) {
      assert.equal(problem.code, 'needs-conformance', text);
      assert.equal(problem.conformance, CONFORMANCE_PREFIX + expected, text);
    }
    assert.deepEqual(codes(text, { conformance: [expected] }), [], text);
    assert.deepEqual(codes(text, { conformance: [CONFORMANCE_PREFIX + expected] }), [], text);
    assert.ok(requiredConformance(parseText(text)).includes(CONFORMANCE_PREFIX + expected), text);
  }
});

test('conformance classes imply the classes they build on', () => {
  assert.deepEqual(codes('S_INTERSECTS(g, POINT(1 2))', { conformance: ['spatial-functions'] }), []);
  assert.deepEqual(codes('S_INTERSECTS(g, LINESTRING(1 2, 3 4))', { conformance: ['basic-spatial-functions'] }), ['needs-conformance']);
  assert.deepEqual(requiredConformance(parseText('a = 1')), [`${CONFORMANCE_PREFIX}basic-cql2`]);
});

test('validates filters that contain objects of other libraries', () => {
  const queryable = { toJSON: () => ({ property: 'gsd' }), toText: () => 'gsd' };
  assert.deepEqual(validate(new CqlEqual(queryable, CqlValue.create(10)), { queryables, conformance: [] }), []);
  assert.deepEqual(validate(new CqlEqual(queryable, CqlValue.create('x')), { queryables }).map(p => p.code), ['type-mismatch']);
});
