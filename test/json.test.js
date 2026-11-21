import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CqlAnd,
  CqlArrayContainedBy,
  CqlBetween,
  CqlEqual,
  CqlError,
  CqlFunction,
  CqlIn,
  CqlInterval,
  CqlProperty,
  CqlTimestamp,
  CqlValue,
  parseJson
} from '../src/index.js';

/**
 * @param {any} json
 * @param {RegExp} message
 * @param {Array<string | number> | undefined} path
 */
function assertJsonError(json, message, path) {
  assert.throws(() => parseJson(json), error => {
    assert.ok(error instanceof CqlError, String(error));
    assert.equal(error.code, 'syntax');
    assert.match(error.message, message);
    assert.deepEqual(error.path, path, error.message);
    return true;
  });
}

test('parses objects and strings into classes with paths', () => {
  const filter = { op: 'and', args: [{ op: '=', args: [{ property: 'a' }, 1] }, { op: 'in', args: [{ property: 'b' }, ['x']] }] };
  for (const input of [filter, JSON.stringify(filter)]) {
    const node = parseJson(input);
    assert.ok(node instanceof CqlAnd);
    assert.ok(node.args[0] instanceof CqlEqual);
    assert.ok(node.args[1] instanceof CqlIn);
    assert.deepEqual(node.args[1].args[0].path, ['args', 1, 'args', 0]);
    assert.equal(node.toText(), "a = 1 AND b IN ('x')");
  }
});

test('operator names are matched without regard to case and written canonically', () => {
  const node = parseJson({ op: 'A_CONTAINEDBY', args: [{ property: 'a' }, [1]] });
  assert.ok(node instanceof CqlArrayContainedBy);
  assert.equal(node.toJSON().op, 'a_containedBy');
});

test('unknown operators are functions', () => {
  const node = parseJson({ op: '=', args: [{ op: 'Buffer', args: [{ property: 'geometry' }, 10] }, 1] });
  assert.ok(node.args[0] instanceof CqlFunction);
  assert.equal(node.toText(), 'Buffer(geometry, 10) = 1');
});

test('temporal values and intervals', () => {
  const node = parseJson({
    op: 't_during',
    args: [{ timestamp: '2020-01-01T00:00:00Z' }, { interval: ['2019-01-01', { property: 'ends' }] }]
  });
  assert.ok(node.args[0] instanceof CqlTimestamp);
  assert.ok(node.args[1] instanceof CqlInterval);
  assert.equal(node.toText(), "T_DURING(TIMESTAMP('2020-01-01T00:00:00Z'), INTERVAL('2019-01-01', ends))");
  assert.deepEqual(parseJson({ op: 't_after', args: [{ property: 'a' }, { interval: ['..', '2020-01-01'] }] }).args[1].args[0], null);
});

test('errors name the path', () => {
  assertJsonError('{', /not valid JSON/, undefined);
  assertJsonError(null, /Unexpected null/, []);
  assertJsonError({ op: '=', args: [{ property: 'a' }, null] }, /Unexpected null.*\/args\/1/, ['args', 1]);
  assertJsonError({ op: '=', args: [{ property: 'a' }] }, /needs 2 arguments, got 1/, []);
  assertJsonError({ op: 'and', args: [true] }, /at least 2 arguments/, []);
  assertJsonError({ op: '=', args: 'a' }, /Expected an array of arguments/, ['args']);
  assertJsonError({ op: 'in', args: [{ property: 'a' }, 1] }, /must be a list/, []);
  assertJsonError({ op: 'not', args: [{ op: '=', args: [{ property: '' }, 1] }] }, /non-empty string/, ['args', 0, 'args', 0, 'property']);
  assertJsonError({ op: '=', args: [{ property: 'a' }, { date: '2020-13-01' }] }, /Invalid date/, ['args', 1, 'date']);
  assertJsonError({ op: '=', args: [{ property: 'a' }, { timestamp: 5 }] }, /Invalid timestamp/, ['args', 1, 'timestamp']);
  assertJsonError({ op: 't_after', args: [{ property: 'a' }, { interval: ['2020-01-01'] }] }, /a start and an end/, ['args', 1, 'interval']);
  assertJsonError({ op: 't_after', args: [{ property: 'a' }, { interval: ['2020-01-01', 5] }] }, /interval end must be/, ['args', 1, 'interval', 1]);
  assertJsonError({ op: 's_intersects', args: [{ property: 'g' }, { bbox: [1, 2, 3] }] }, /4 or 6 numbers/, ['args', 1, 'bbox']);
  assertJsonError({ op: 's_intersects', args: [{ property: 'g' }, { type: 'Circle' }] }, /Unknown geometry type/, ['args', 1, 'type']);
  assertJsonError({ op: 's_intersects', args: [{ property: 'g' }, { type: 'Point', coordinates: [1] }] }, /2 or 3 numbers/, ['args', 1, 'coordinates']);
  assertJsonError({ op: 's_intersects', args: [{ property: 'g' }, { type: 'LineString', coordinates: [[1, 2], ['a', 2]] }] },
    /2 or 3 numbers/, ['args', 1, 'coordinates', 1]);
  assertJsonError({ foo: 1 }, /Expected an object with one of the members/, []);
});

test('deep nesting is refused', () => {
  /** @type {any} */
  let filter = { op: '=', args: [{ property: 'a' }, 1] };
  for (let i = 0; i < 500; i++) {
    filter = { op: 'not', args: [filter] };
  }
  assert.throws(() => parseJson(filter), /nested too deeply/);
});

test('filters can be built from classes and plain values', () => {
  const filter = new CqlAnd([
    new CqlEqual(new CqlProperty('platform'), CqlValue.create("Tom's")),
    new CqlBetween(new CqlProperty('eo:cloud_cover'), CqlValue.create(0), CqlValue.create(10)),
    new CqlIn(new CqlProperty('gsd'), [10, 20])
  ]);
  assert.equal(filter.toText(), "platform = 'Tom''s' AND eo:cloud_cover BETWEEN 0 AND 10 AND gsd IN (10, 20)");
  assert.deepEqual(JSON.parse(JSON.stringify(filter)), {
    op: 'and',
    args: [
      { op: '=', args: [{ property: 'platform' }, "Tom's"] },
      { op: 'between', args: [{ property: 'eo:cloud_cover' }, 0, 10] },
      { op: 'in', args: [{ property: 'gsd' }, [10, 20]] }
    ]
  });
});

test('objects of other libraries can be used as arguments', () => {
  const queryable = { toJSON: () => ({ property: 'foreign' }), toText: () => 'foreign' };
  const filter = new CqlEqual(queryable, CqlValue.create(1));
  assert.equal(filter.toText(), 'foreign = 1');
  assert.deepEqual(filter.toJSON(), { op: '=', args: [{ property: 'foreign' }, 1] });
});

test('non-finite numbers cannot be written', () => {
  assert.throws(() => CqlValue.create(Infinity).toText(), /Cannot write/);
});
