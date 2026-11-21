import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CqlAnd,
  CqlArray,
  CqlBetween,
  CqlEqual,
  CqlError,
  CqlFunction,
  CqlGeometry,
  CqlIn,
  CqlNot,
  CqlNumber,
  CqlProperty,
  CqlString,
  CqlTimestamp,
  parseText
} from '../src/index.js';

/**
 * @param {string} text
 * @returns {any}
 */
function json(text) {
  return JSON.parse(JSON.stringify(parseText(text)));
}

/**
 * @param {string} text
 * @param {RegExp} message
 * @param {number} position
 */
function assertSyntaxError(text, message, position) {
  assert.throws(() => parseText(text), error => {
    assert.ok(error instanceof CqlError, String(error));
    assert.equal(error.code, 'syntax');
    assert.match(error.message, message);
    assert.equal(error.position, position, error.message);
    return true;
  });
}

test('parses a comparison into classes with positions', () => {
  const node = parseText("eo:cloud_cover <= 10");
  assert.ok(node instanceof CqlEqual === false);
  assert.equal(node.operator, '<=');
  assert.ok(node.args[0] instanceof CqlProperty);
  assert.ok(node.args[1] instanceof CqlNumber);
  assert.deepEqual(node.span, { start: 0, end: 20 });
  assert.deepEqual(node.args[1].span, { start: 18, end: 20 });
});

test('keywords are case-insensitive, names are not changed', () => {
  assert.deepEqual(json('Foo = 1 aNd bar = 2 OR nOt baz'), {
    op: 'or',
    args: [
      { op: 'and', args: [{ op: '=', args: [{ property: 'Foo' }, 1] }, { op: '=', args: [{ property: 'bar' }, 2] }] },
      { op: 'not', args: [{ property: 'baz' }] }
    ]
  });
});

test('AND binds tighter than OR and chains are flat', () => {
  const node = parseText('a = 1 AND b = 2 AND c = 3');
  assert.ok(node instanceof CqlAnd);
  assert.equal(node.args.length, 3);
  assert.equal(parseText('a = 1 OR b = 2 AND c = 3').toText(), 'a = 1 OR b = 2 AND c = 3');
  assert.equal(parseText('(a = 1 OR b = 2) AND c = 3').toText(), '(a = 1 OR b = 2) AND c = 3');
});

test('handles string escapes and writes every apostrophe doubled', () => {
  const node = parseText("name = 'it''s Tom''s'");
  assert.equal(node.args[1].value, "it's Tom's");
  assert.equal(node.toText(), "name = 'it''s Tom''s'");
  assert.equal(parseText("name = 'it\\'s'").args[1].value, "it's");
  assert.equal(new CqlString("a'b'c").toText(), "'a''b''c'");
});

test('quoted names and reserved words', () => {
  assert.deepEqual(json('"my prop" = 1'), { op: '=', args: [{ property: 'my prop' }, 1] });
  assert.equal(parseText('"my prop" = 1').toText(), '"my prop" = 1');
  assert.equal(parseText('"like" = 1').toText(), '"like" = 1');
  assert.equal(new CqlProperty('say "hi"').toText(), '"say ""hi"""');
  assert.equal(parseText('date = DATE(\'2020-01-01\')').args[0].name, 'date');
  assert.equal(parseText('point IS NULL').args[0].name, 'point');
  assertSyntaxError('like = 1', /Unexpected LIKE.*double quotes/, 0);
});

test('negated forms', () => {
  assert.deepEqual(json("a NOT LIKE 'x%'"), { op: 'not', args: [{ op: 'like', args: [{ property: 'a' }, 'x%'] }] });
  for (const text of ["a NOT LIKE 'x%'", 'a NOT BETWEEN 1 AND 2', 'a NOT IN (1, 2)', 'a IS NOT NULL', 'NOT (a = 1 AND b = 2)', 'NOT a = 1']) {
    assert.equal(parseText(text).toText(), text);
  }
  assert.ok(parseText('a IS NOT NULL') instanceof CqlNot);
  assert.equal(new CqlNot(new CqlNot(new CqlProperty('a'))).toText(), 'NOT (NOT a)');
});

test('BETWEEN and IN', () => {
  const between = parseText('a BETWEEN 1 AND 2 AND b = 3');
  assert.ok(between instanceof CqlAnd);
  assert.ok(between.args[0] instanceof CqlBetween);
  assert.deepEqual(json('a BETWEEN 1 AND 2'), { op: 'between', args: [{ property: 'a' }, 1, 2] });
  const list = parseText('a IN (1)');
  assert.ok(list instanceof CqlIn);
  assert.ok(list.args[1] instanceof CqlArray);
  assert.deepEqual(json("a IN ('x', 'y')"), { op: 'in', args: [{ property: 'a' }, ['x', 'y']] });
});

test('arithmetic precedence and parentheses', () => {
  assert.deepEqual(json('a + b * 2 = 7'), {
    op: '=',
    args: [{ op: '+', args: [{ property: 'a' }, { op: '*', args: [{ property: 'b' }, 2] }] }, 7]
  });
  for (const text of ['(a + b) * 2 = 7', 'a - (b - c) = 0', 'a - b - c = 0', 'a / (b * c) > 1', '2 ^ 3 ^ 2 = 512', '(2 ^ 3) ^ 2 = 64', 'a div 2 = 1', 'a % 2 = 1']) {
    assert.equal(parseText(text).toText(), text);
  }
  assert.equal(parseText('a = -5').args[1].value, -5);
  assert.deepEqual(json('-a = 5'), { op: '=', args: [{ op: '*', args: [-1, { property: 'a' }] }, 5] });
  assert.equal(parseText('a = 1.5e3').args[1].value, 1500);
  assert.equal(parseText('a = .5').args[1].value, 0.5);
});

test('functions and arrays', () => {
  const node = parseText("my_func(a, 'x', 1 + 2) = 3");
  assert.ok(node.args[0] instanceof CqlFunction);
  assert.equal(node.args[0].name, 'my_func');
  assert.equal(node.toText(), "my_func(a, 'x', 1 + 2) = 3");
  assert.deepEqual(json('A_CONTAINS(tags, (1))'), { op: 'a_contains', args: [{ property: 'tags' }, [1]] });
  assert.deepEqual(json('A_EQUALS(tags, ())'), { op: 'a_equals', args: [{ property: 'tags' }, []] });
  assert.deepEqual(json('A_CONTAINEDBY(tags, ((1, 2), (3)))'), {
    op: 'a_containedBy',
    args: [{ property: 'tags' }, [[1, 2], [3]]]
  });
  assert.equal(parseText('a_containedby(tags, (1, 2))').toText(), 'A_CONTAINEDBY(tags, (1, 2))');
});

test('temporal values', () => {
  const node = parseText("T_INTERSECTS(datetime, INTERVAL('2020-01-01', '..'))");
  assert.deepEqual(json("T_INTERSECTS(datetime, INTERVAL('2020-01-01', '..'))"), {
    op: 't_intersects',
    args: [{ property: 'datetime' }, { interval: ['2020-01-01', '..'] }]
  });
  assert.equal(node.toText(), "T_INTERSECTS(datetime, INTERVAL('2020-01-01', '..'))");
  assert.deepEqual(json("T_FINISHEDBY(INTERVAL(starts, ends), TIMESTAMP('2020-01-01T00:00:00.5Z'))").op, 't_finishedBy');
  assert.equal(new CqlTimestamp(new Date(0)).toText(), "TIMESTAMP('1970-01-01T00:00:00.000Z')");
  assertSyntaxError("a = DATE('2020-02-30')", /does not exist/, 9);
  assertSyntaxError("a = TIMESTAMP('2020-01-01T00:00:00+01:00')", /must be in UTC/, 14);
  assertSyntaxError("a = DATE(2020)", /Expected a string/, 9);
  assertSyntaxError("T_AFTER(a, INTERVAL('yesterday', '..'))", /Invalid interval end/, 20);
});

test('geometries', () => {
  const node = parseText('S_INTERSECTS(geometry, POLYGON((0 0, 1 0, 1 1, 0 0)))').args[1];
  assert.ok(node instanceof CqlGeometry);
  assert.deepEqual(node.value, { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] });
  assert.equal(node.toText(), 'POLYGON ((0 0, 1 0, 1 1, 0 0))');
  assert.deepEqual(json('S_INTERSECTS(g, POINT Z (1 2 3))').args[1], { type: 'Point', coordinates: [1, 2, 3] });
  assert.equal(parseText('S_INTERSECTS(g, POINT(1 2 3))').toText(), 'S_INTERSECTS(g, POINT Z (1 2 3))');
  assert.deepEqual(json('S_INTERSECTS(g, MULTIPOINT(1 2, (3 4)))').args[1], { type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] });
  assert.deepEqual(json('S_INTERSECTS(g, BBOX(-10, -5.5, 10, 5))').args[1], { bbox: [-10, -5.5, 10, 5] });
  assert.deepEqual(json('S_WITHIN(g, GEOMETRYCOLLECTION(POINT(1 2), LINESTRING(0 0, 1 1)))').args[1], {
    type: 'GeometryCollection',
    geometries: [{ type: 'Point', coordinates: [1, 2] }, { type: 'LineString', coordinates: [[0, 0], [1, 1]] }]
  });
  assert.deepEqual(json('S_INTERSECTS(g, POLYGON EMPTY)').args[1], { type: 'Polygon', coordinates: [] });
  assertSyntaxError('S_INTERSECTS(g, POINT(1))', /A position needs 2 or 3 numbers/, 22);
  assertSyntaxError('S_INTERSECTS(g, BBOX(1, 2, 3))', /4 or 6 numbers/, 16);
  assertSyntaxError('S_INTERSECTS(g, LINESTRING(1 2))', /at least 2 positions/, 26);
  assertSyntaxError('S_INTERSECTS(g, POINT M (1 2 3))', /measures/, 22);
});

test('errors name the position', () => {
  assertSyntaxError('', /empty/, 0);
  assertSyntaxError('a = ', /Expected a value.*the end of the filter/, 4);
  assertSyntaxError('a = 1 b', /Unexpected "b"/, 6);
  assertSyntaxError('a = 1 = 2', /Unexpected "="/, 6);
  assertSyntaxError("a = 'open", /The string is not closed/, 4);
  assertSyntaxError('a = 1 AND (b = 2', /Expected "\)"/, 16);
  assertSyntaxError('a IN 1', /Expected a list/, 5);
  assertSyntaxError('a BETWEEN 1 OR 2', /Expected AND/, 12);
  assertSyntaxError('a = 1 ? 2', /Unexpected character/, 6);
  assertSyntaxError('S_INTERSECTS(a)', /needs 2 arguments, got 1/, 0);
  assertSyntaxError('CASEI(a, b) = 1', /needs 1 argument/, 0);
  assert.throws(() => parseText('a = 1\nAND b ='), error => {
    assert.ok(error instanceof CqlError);
    assert.equal(error.line, 2);
    assert.equal(error.column, 8);
    return true;
  });
});

test('deep nesting fails fast instead of overflowing the stack', () => {
  const started = Date.now();
  assertSyntaxError(`${'('.repeat(5000)}a = 1${')'.repeat(5000)}`, /nested deeper than 100 levels/, 100);
  assertSyntaxError(`${'NOT '.repeat(5000)}a`, /nested deeper/, 396);
  assertSyntaxError(`a = ${'-'.repeat(5000)}1`, /nested deeper/, 103);
  assert.ok(Date.now() - started < 1000);
  const nested = `${'('.repeat(40)}a = 1${')'.repeat(40)}`;
  assert.equal(parseText(nested).toText(), 'a = 1');
  assert.equal(parseText(`${'('.repeat(150)}a = 1${')'.repeat(150)}`, { maxDepth: 200 }).toText(), 'a = 1');
});
