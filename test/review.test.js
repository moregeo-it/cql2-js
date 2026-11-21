import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CqlArithmeticOperator,
  CqlBBox,
  CqlEqual,
  CqlError,
  CqlFunction,
  CqlProperty,
  CqlString,
  CqlValue,
  parseJson,
  parseText,
  requiredConformance,
  schemaToType,
  validate
} from '../src/index.js';

const BACKSLASH = String.fromCharCode(92);
const NEWLINE = String.fromCharCode(10);
const TAB = String.fromCharCode(9);

/**
 * @param {any} node
 * @returns {any}
 */
function plain(node) {
  return JSON.parse(JSON.stringify(node));
}

/**
 * @param {() => any} action
 * @param {RegExp} message
 */
function assertCqlError(action, message) {
  assert.throws(action, error => {
    assert.ok(error instanceof CqlError, String(error));
    assert.match(error.message, message);
    return true;
  });
}

test('a GeoJSON geometry with a bbox member stays a geometry', () => {
  const geometry = { type: 'Polygon', bbox: [0, 0, 1, 1], coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
  const node = parseJson({ op: 's_intersects', args: [{ property: 'g' }, geometry] });
  assert.deepEqual(plain(node.args[1]), geometry);
  assert.equal(node.args[1].toText(), 'POLYGON ((0 0, 1 0, 1 1, 0 0))');
  assert.deepEqual(plain(parseJson({ op: 's_intersects', args: [{ property: 'g' }, { bbox: [0, 0, 1, 1] }] }).args[1]), { bbox: [0, 0, 1, 1] });
});

test('numbers that cannot be represented exactly are refused', () => {
  assertCqlError(() => parseJson('{"op":"=","args":[{"property":"a"},9007199254740993]}'), /The integer 9007199254740993 is too large to be represented exactly/);
  assertCqlError(() => parseJson('{"op":"=","args":[{"property":"a"},9007199254740993123456789]}'), /The integer 9007199254740993123456789 is too large/);
  assertCqlError(() => parseJson({ op: '=', args: [{ property: 'a' }, 2 ** 60] }), /too large to be represented exactly.*\/args\/1/);
  assertCqlError(() => parseJson('{"op":"s_intersects","args":[{"property":"g"},{"type":"Point","coordinates":[9007199254740993,0]}]}'), /too large/);
  assertCqlError(() => parseJson({ op: 's_intersects', args: [{ property: 'g' }, { type: 'Point', coordinates: [2 ** 60, 0] }] }), /too large.*\/args\/1\/coordinates\/0/);
  assertCqlError(() => parseJson({ op: 's_intersects', args: [{ property: 'g' }, { bbox: [0, 0, 1, 2 ** 60] }] }), /too large.*\/args\/1\/bbox\/3/);
  assertCqlError(() => parseText('a = 9007199254740993.0'), /too large to be represented exactly/);
  assertCqlError(() => parseText('a = 9007199254740993e0'), /too large to be represented exactly/);
  assertCqlError(() => parseText('a = 999999999999999999999.0'), /too large to be represented exactly/);
  assertCqlError(() => parseText('a = 999999999999999999999e0'), /too large to be represented exactly/);
  assertCqlError(() => parseText('a = 9007199254740993e3'), /too large to be represented exactly/);
  assertCqlError(() => parseJson('{"op":"=","args":[{"property":"a"},999999999999999999999.0]}'), /too large to be represented exactly/);
  assertCqlError(() => parseJson({ op: 's_intersects', args: [{ property: 'g' }, { type: 'Point', bbox: [0, 0, 2 ** 60, 1], coordinates: [1, 2] }] }), /too large.*\/args\/1\/bbox\/2/);
  assertCqlError(() => parseJson({ op: 's_intersects', args: [{ property: 'g' }, { type: 'Point', bbox: [0, 0, 1, 'x'], coordinates: [1, 2] }] }), /4 or 6 numbers.*\/args\/1\/bbox/);
  assertCqlError(() => parseJson({ op: 's_intersects', args: [{ property: 'g' }, { type: 'GeometryCollection', geometries: [{ type: 'Point', bbox: [1], coordinates: [1, 2] }] }] }), /4 or 6 numbers.*\/geometries\/0\/bbox/);
  for (const text of ['1e20', '100000000000000000000', '9007199254740992', '9007199254740994', '1.5e25', '0.12345678901234567890', '123456789012345000000000']) {
    const value = parseText(`a = ${text}`).args[1].value;
    assert.equal(value, Number(text), text);
    assert.equal(parseText(`a = ${CqlValue.create(value).toText()}`).args[1].value, value, text);
  }
  assertCqlError(() => parseText('a = 9007199254740993'), /too large to be represented exactly \(line 1, column 5\)/);
  assertCqlError(() => parseText('a = 1e309'), /The number 1e309 is too large/);
  assertCqlError(() => parseText('S_INTERSECTS(g, POINT(1e999 0))'), /too large/);
  assertCqlError(() => parseText('S_INTERSECTS(g, BBOX(0, 0, 1, 99999999999999999999))'), /too large to be represented exactly/);
  assert.equal(parseText('a = 9007199254740991').args[1].value, Number.MAX_SAFE_INTEGER);
  assert.equal(parseText('a = 1e30').args[1].value, 1e30);
  assert.equal(parseJson({ op: '=', args: [{ property: 'a' }, 1e30] }).args[1].value, 1e30);
});

test('non-finite numbers cannot be written to JSON either', () => {
  assertCqlError(() => JSON.stringify(CqlValue.create(Infinity)), /Cannot write Infinity/);
  assertCqlError(() => JSON.stringify(new CqlEqual(new CqlProperty('a'), CqlValue.create(NaN))), /Cannot write NaN/);
  assertCqlError(() => JSON.stringify(new CqlBBox([0, 0, Infinity, 1])), /Cannot write Infinity/);
  assertCqlError(() => JSON.stringify(CqlValue.create(2 ** 60)), /too large to be represented exactly/);
  assertCqlError(() => JSON.stringify(CqlValue.create({ type: 'Point', coordinates: [Infinity, 0] })), /Cannot write Infinity/);
  assertCqlError(() => JSON.stringify(CqlValue.create({ type: 'LineString', coordinates: [[0, 0], [2 ** 60, 0]] })), /too large/);
  assertCqlError(() => JSON.stringify(CqlValue.create({ type: 'Point', bbox: [0, 0, NaN, 1], coordinates: [0, 0] })), /Cannot write NaN/);
  assertCqlError(() => JSON.stringify(CqlValue.create({ type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [0, Infinity] }] })), /Cannot write Infinity/);
  assert.deepEqual(plain(CqlValue.create({ type: 'Point', bbox: [0, 0, 1, 1], coordinates: [0.5, 0.5] })), { type: 'Point', bbox: [0, 0, 1, 1], coordinates: [0.5, 0.5] });
  assertCqlError(() => CqlValue.create(2 ** 60).toText(), /too large to be represented exactly/);
  assertCqlError(() => new CqlBBox([0, 0, 1, 2 ** 60]).toText(), /too large to be represented exactly/);
  for (const value of [Number.MAX_SAFE_INTEGER, 1e21, 1e30, 1.5e300, 0.1]) {
    const text = CqlValue.create(value).toText();
    assert.equal(parseText(`a = ${text}`).args[1].value, value, text);
    assert.equal(parseJson(JSON.stringify({ op: '=', args: [{ property: 'a' }, value] })).args[1].value, value, text);
  }
});

test('names that are not identifiers cannot become function names or operators', () => {
  assertCqlError(() => parseJson({ op: '=', args: [{ op: 'f() = 0 OR TRUE OR f', args: [] }, 1] }), /neither an operator nor a valid function name.*\/args\/0/);
  assertCqlError(() => parseJson({ op: 'like(', args: [] }), /valid function name/);
  assertCqlError(() => new CqlFunction('f() OR g', []).toText(), /cannot be written as a function name/);
  assertCqlError(() => new CqlFunction('not', []).toText(), /cannot be written as a function name/);
  for (const name of ['date', 'timestamp', 'interval', 'point', 'bbox', 'Polygon']) {
    assertCqlError(() => parseJson({ op: '=', args: [{ op: name, args: ['2020-01-01'] }, 1] }), /neither an operator nor a valid function name/);
    assertCqlError(() => new CqlFunction(name, []).toText(), /cannot be written as a function name/);
  }
  assertCqlError(() => new CqlArithmeticOperator('+ 1 OR TRUE OR 1 +', CqlValue.create(1), CqlValue.create(2)).toText(), /not an arithmetic operator/);
  assert.equal(parseJson({ op: 'my:func.v2', args: [1] }).toText(), 'my:func.v2(1)');
});

test('string escapes of the standard are read and written', () => {
  const read = parseText(`a = 'x${BACKSLASH}ny${BACKSLASH}tz${BACKSLASH}${BACKSLASH}w${BACKSLASH}'q''r'`);
  assert.equal(read.args[1].value, `x${NEWLINE}y${TAB}z${BACKSLASH}w'q'r`);
  assert.equal(parseText(`a = '${BACKSLASH}a${BACKSLASH}b${BACKSLASH}v${BACKSLASH}f${BACKSLASH}r'`).args[1].value,
    [7, 8, 11, 12, 13].map(code => String.fromCharCode(code)).join(''));
  assert.equal(parseText(`a LIKE '100${BACKSLASH}%'`).args[1].value, `100${BACKSLASH}%`);

  assert.equal(new CqlString(`C:${BACKSLASH}`).toText(), `'C:${BACKSLASH}${BACKSLASH}'`);
  assert.equal(new CqlString(`a${NEWLINE}b`).toText(), `'a${BACKSLASH}nb'`);
  for (const value of [`C:${BACKSLASH}`, `${BACKSLASH}'`, `a${NEWLINE}b${TAB}c`, `100${BACKSLASH}%`, `${BACKSLASH}n`, "it's", `${BACKSLASH}${BACKSLASH}`]) {
    const filter = new CqlEqual(new CqlProperty('a'), new CqlString(value));
    assert.equal(parseText(filter.toText()).args[1].value, value, filter.toText());
  }
});

test('geometries in JSON need complete lines and closed rings', () => {
  const filter = (/** @type {any} */ geometry) => ({ op: 's_intersects', args: [{ property: 'g' }, geometry] });
  assertCqlError(() => parseJson(filter({ type: 'LineString', coordinates: [[1, 2]] })), /A line needs at least 2 positions/);
  assertCqlError(() => parseJson(filter({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [0, 0]]] })), /ring needs at least 4 positions/);
  assertCqlError(() => parseJson(filter({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] })), /must end at the position where it starts/);
  assertCqlError(() => parseJson(filter({ type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 1]]]] })), /must end at the position/);
  assertCqlError(() => parseJson(filter({ type: 'MultiPoint', coordinates: [[1, 2], []] })), /A position needs 2 or 3 numbers/);
  assertCqlError(() => parseJson(filter({ type: 'MultiLineString', coordinates: [[]] })), /A line needs at least 2 positions/);
  assertCqlError(() => parseJson(filter({ type: 'Polygon', coordinates: [[]] })), /ring needs at least 4 positions/);
  assertCqlError(() => parseJson(filter({ type: 'Polygon' })), /Expected an array of coordinates/);
  for (const type of ['Point', 'LineString', 'Polygon', 'MultiPoint', 'MultiLineString', 'MultiPolygon']) {
    const empty = parseJson(filter({ type, coordinates: [] }));
    assert.deepEqual(plain(parseText(empty.toText())), plain(empty), type);
  }
});

test('polygon rings in text must be closed', () => {
  assertCqlError(() => parseText('S_INTERSECTS(g, POLYGON((0 0, 1 0, 1 1, 0 1)))'), /must end at the position where it starts \(line 1, column 25\)/);
  assertCqlError(() => parseText('S_INTERSECTS(g, MULTIPOLYGON(((0 0, 1 0, 1 1, 0 0)), ((0 0, 1 0, 1 1, 0 1))))'), /must end at the position/);
  assertCqlError(() => parseText('S_INTERSECTS(g, POLYGON((0 0 1, 1 0 1, 1 1 1, 0 0 2)))'), /must end at the position/);
  assert.ok(parseText('S_INTERSECTS(g, POLYGON((0 0, 1 0, 1 1, 0 0), (0 0, 0.5 0, 0.5 0.5, 0 0)))'));
});

test('grouped expressions inside arrays survive a round trip', () => {
  const filter = { op: 'a_contains', args: [{ property: 't' }, [{ op: '*', args: [{ op: '+', args: [1, 2] }, 3] }, [4], [[5]], []]] };
  const text = parseJson(filter).toText();
  assert.equal(text, 'A_CONTAINS(t, ((1 + 2) * 3, (4), ((5)), ()))');
  assert.deepEqual(plain(parseText(text)), filter);
  assert.deepEqual(plain(parseText('a IN ((1 + 2) * 3, 4)')), { op: 'in', args: [{ property: 'a' }, [{ op: '*', args: [{ op: '+', args: [1, 2] }, 3] }, 4]] });
});

test('arrays with one element survive a round trip as function arguments', () => {
  for (const args of [[[1]], [[[1]]], [[1], 2], [[]], [[1, 2]], [{ op: '+', args: [1, 2] }]]) {
    const filter = { op: '=', args: [{ op: 'f', args }, 1] };
    const text = parseJson(filter).toText();
    assert.deepEqual(plain(parseText(text)), filter, text);
  }
  assert.deepEqual(plain(parseText('f((1 + 2) * 3) = 1')).args[0].args, [{ op: '*', args: [{ op: '+', args: [1, 2] }, 3] }]);
  assert.deepEqual(plain(parseText('S_INTERSECTS((g), POINT(1 2))')).args[0], { property: 'g' });
  assert.deepEqual(plain(parseText('(a) = (1)')), { op: '=', args: [{ property: 'a' }, 1] });
});

test('the depth limit applies to the resulting tree, however it is written', () => {
  const sum = (/** @type {number} */ terms) => Array(terms).fill('1').join(' + ');
  assertCqlError(() => parseText(`a = ${sum(200000)}`), /nested deeper than 100 levels/);
  assertCqlError(() => parseText(`a = ${Array(200000).fill('1').join(' * ')}`), /nested deeper than 100 levels/);
  assertCqlError(() => parseText(`a = (${sum(99)}) + 1`), /nested deeper than 100 levels/);
  assertCqlError(() => parseText(`a = ((${sum(50)}) + ${sum(50)}) + 1`), /nested deeper than 100 levels/);

  const allowed = parseText(`a = (${sum(50)}) + ${sum(49)}`);
  assert.equal(allowed.toText(), `a = ${sum(99)}`);
  assert.deepEqual(plain(parseText(allowed.toText())), plain(allowed));
  assert.deepEqual(plain(parseJson(plain(allowed))), plain(allowed));
  assert.equal(validate(allowed).length, 0);
  assertCqlError(() => parseText(`a = ${sum(100)}`), /nested deeper than 100 levels/);
  assert.ok(parseText(`a = ${sum(150)}`, { maxDepth: 200 }));

  const interval = { op: 't_after', args: [{ property: 'a' }, { interval: ['2020-01-01', '..'] }] };
  assertCqlError(() => parseJson(interval, { maxDepth: 2 }), /nested too deeply.*\/args\/1\/interval\/0/);
  assertCqlError(() => parseText(parseJson(interval).toText(), { maxDepth: 2 }), /nested deeper than 2 levels/);
  assert.deepEqual(plain(parseText(parseJson(interval, { maxDepth: 3 }).toText(), { maxDepth: 3 })), interval);

  const long = parseText(Array(5000).fill('a = 1').join(' OR '));
  assert.equal(long.args.length, 5000);
  assert.equal(validate(long).length, 0);
});

test('a plus sign in front of a group does not turn it into an array', () => {
  assert.deepEqual(plain(parseText('f(+(1)) = 1')).args[0].args, [1]);
  assert.deepEqual(plain(parseText('f((+(1))) = 1')).args[0].args, [[1]]);
  assert.deepEqual(plain(parseText('f(-(1)) = 1')).args[0].args, [-1]);
  assert.deepEqual(plain(parseText('A_CONTAINS(t, (+(1), (2)))')).args[1], [1, [2]]);
});

test('nested IN lists are validated in linear time', () => {
  /** @type {any} */
  let filter = { op: 'in', args: [{ property: 'a' }, [1]] };
  for (let level = 0; level < 45; level++) {
    filter = { op: 'in', args: [{ property: 'a' }, [filter, 2]] };
  }
  const node = parseJson(filter);
  const started = Date.now();
  validate(node, { queryables: { a: 'number' } });
  requiredConformance(node);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(validate(parseText("a IN (1, 'x')"), { queryables: { a: 'number' } }).map(problem => problem.code), ['type-mismatch']);
});

test('queryables with several types are not checked for their type', () => {
  assert.equal(schemaToType({ type: ['string', 'number'] }), null);
  assert.equal(schemaToType({ type: ['string', 'number', 'null'] }), null);
  assert.equal(schemaToType({ type: ['integer', 'number'] }), 'number');
  assert.equal(schemaToType({ type: ['string', 'null'], format: 'date-time' }), 'timestamp');
  const queryables = { p: { type: ['string', 'number'] } };
  assert.deepEqual(validate(parseText('p = 1'), { queryables }), []);
  assert.deepEqual(validate(parseText("p = 'x'"), { queryables }), []);
});

test('property names that are keywords are quoted', () => {
  for (const name of ['date', 'timestamp', 'point', 'bbox', 'interval', 'casei', 'not', 'DATE', 't_after', 'my-prop', 'my prop', '1abc']) {
    const filter = new CqlEqual(new CqlProperty(name), CqlValue.create(1));
    assert.equal(filter.toText(), `"${name}" = 1`);
    assert.equal(parseText(filter.toText()).args[0].name, name);
  }
  assert.equal(new CqlEqual(new CqlProperty('eo:cloud_cover'), CqlValue.create(1)).toText(), 'eo:cloud_cover = 1');
  assert.equal(parseText('date = 1').args[0].name, 'date');
});

test('an IN list without values is refused in text and accepted in JSON', () => {
  assertCqlError(() => parseText('a IN ()'), /The list of IN needs at least one value \(line 1, column 6\)/);
  assertCqlError(() => parseText('a NOT IN ()'), /at least one value/);
  const filter = parseJson({ op: 'in', args: [{ property: 'a' }, []] });
  assert.deepEqual(plain(filter), { op: 'in', args: [{ property: 'a' }, []] });
  assertCqlError(() => filter.toText(), /cannot be written as text/);
});
