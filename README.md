# cql2-js

Parse, validate and write [OGC CQL2](https://docs.ogc.org/is/21-065r2/21-065r2.html) filters in JavaScript.

- Reads and writes both encodings, CQL2 text and CQL2 JSON, through one set of classes.
- Covers the whole standard: comparisons, `LIKE`, `BETWEEN`, `IN`, case- and accent-insensitive comparison, spatial, temporal and array operators, functions and arithmetic.
- Checks filters against the conformance classes a server supports, against queryables with their types, and against the functions a server offers.
- Errors say where the problem is: a position in the text, or a path in the JSON.
- No dependencies. Runs in Node.js and in the browser.

It does not evaluate filters and does not generate SQL.

## Install

```bash
npm install @moregeo-it/cql2
```

## Parse and write

```js
import { parse, parseText, parseJson } from '@moregeo-it/cql2';

const filter = parseText("eo:cloud_cover < 10 AND platform IN ('sentinel-2a', 'sentinel-2b')");

filter.toJSON();
// { op: 'and', args: [
//   { op: '<', args: [{ property: 'eo:cloud_cover' }, 10] },
//   { op: 'in', args: [{ property: 'platform' }, ['sentinel-2a', 'sentinel-2b']] } ] }

parseJson({ op: '=', args: [{ property: 'id' }, "Tom's"] }).toText();
// "id = 'Tom''s'"

parse(input); // detects the encoding
```

A filter is a tree of nodes. Operators have an `operator` and `args`, values have a `value`, properties have a `name`. Every node has `toText()` and `toJSON()`. Nodes parsed from text carry their position in `span`, nodes parsed from JSON carry their `path`.

## Build filters

```js
import { CqlAnd, CqlBetween, CqlEqual, CqlProperty, CqlValue } from '@moregeo-it/cql2';

const filter = new CqlAnd([
  new CqlEqual(new CqlProperty('platform'), CqlValue.create('landsat-9')),
  new CqlBetween(new CqlProperty('eo:cloud_cover'), CqlValue.create(0), CqlValue.create(10))
]);

filter.toText(); // "platform = 'landsat-9' AND eo:cloud_cover BETWEEN 0 AND 10"
```

`CqlValue.create()` turns strings, numbers, booleans, `Date` objects, arrays and GeoJSON geometries into nodes. Any object with `toText()` and `toJSON()` can be used as an argument, so an application can keep its own classes for properties.

## Validate

```js
import { parseText, validate } from '@moregeo-it/cql2';

const problems = validate(parseText("eo:cloud_cover = 'low' AND S_WITHIN(geometry, BBOX(0, 0, 1, 1))"), {
  queryables: {
    'eo:cloud_cover': { type: 'number' },
    geometry: { format: 'geometry-any' }
  },
  conformance: ['basic-cql2', 'basic-spatial-functions']
});
// [ { code: 'type-mismatch', message: 'The right side of = is of type string, but is compared with type number',
//     span: { start: 17, end: 22 }, ... },
//   { code: 'needs-conformance', conformance: 'http://www.opengis.net/spec/cql2/1.0/conf/spatial-functions', ... } ]
```

`validate()` collects all problems and returns an empty list for a valid filter. All options are optional.

| Option | Meaning |
|---|---|
| `queryables` | Property names with their JSON Schema, as in the `properties` of a Queryables document, or with a type name |
| `additionalProperties` | Set to `true` to allow properties that are not listed in `queryables` |
| `conformance` | The CQL2 conformance classes the server supports, as URIs or short names |
| `functions` | The functions the server offers, each with optional `args` and `returns` types |

| Problem code | Meaning |
|---|---|
| `type-mismatch` | An operand has the wrong type |
| `unknown-property` | A property is not a queryable |
| `unknown-function` | A function is not offered by the server |
| `needs-conformance` | The filter uses a conformance class the server does not support |
| `invalid-pattern` | The pattern of `LIKE` is not a string |
| `not-boolean` | The filter as a whole is not a boolean expression |

`requiredConformance(filter)` lists the conformance classes a filter needs.

## Errors

Both parsers throw a `CqlError`.

```js
try {
  parseText('a = 1 AND (b = 2');
} catch (error) {
  error.message;  // 'Expected ")" but found the end of the filter (line 1, column 17)'
  error.position; // 16
}
```

For JSON input the error has a `path`, for example `['args', 1, 'date']`.

Filters whose tree is deeper than 100 levels are refused. The limit can be changed with the `maxDepth` option of the parsers.

## Decisions where the standard leaves room

- Input is not rewritten. Timestamps, numbers and names are written back as they were read. Only keywords and operator names get their standard spelling.
- Timestamps must be in UTC and end in `Z`, as the standard requires.
- `a NOT LIKE b`, `a NOT BETWEEN b AND c`, `a NOT IN (b)` and `a IS NOT NULL` are read as `not` around the operator, and written back in the short form.
- Chains of `AND` or `OR` in text become one operator with several arguments.
- A minus sign in front of a number is part of the number. In front of anything else it is read as a multiplication with `-1`.
- Parentheses around a whole array element or a whole function argument are an array with one element. Parentheses around a part of it, and everywhere else, are a group.
- Geometries with measures (`M`) are refused. Positions with three numbers are written with `Z`.
- Property names that are keywords of the standard, such as `date`, are written in double quotes. They are read with and without quotes where the meaning is clear.
- An `IN` list without values is refused in text, as in the grammar. In JSON it is accepted, as in the schema.
- Polygon rings must be closed, and lines need at least two positions, in both encodings.
- Integers beyond the range that JavaScript represents exactly, and numbers that are not finite, are refused instead of being rounded, when reading and when writing. From `1e21` on, numbers in exponent notation are accepted as approximate values.
- In strings, the backslash escapes of the standard are read and written. A backslash in front of any other character is kept.
- The depth limit applies to the resulting tree, so a chain of about 100 arithmetic operators is refused like deeper nesting. `AND` and `OR` chains are flat and have no limit.
- Functions cannot be named like a keyword of the standard, such as `date` or `point`, because their call could not be told apart in text.

## Tests

The tests run all example filters of the standard and the expressions of its abstract test suite, and check the written JSON against the JSON schema of the standard. See [NOTICE](NOTICE) for the licence of this material.

```bash
npm test
npm run lint
npm run typecheck
```

## Releases

A release is published to npm by the workflow `publish.yml` when a GitHub release is created. The tag must be `v` followed by the version in `package.json`. The workflow uses npm trusted publishing, so no token is stored in the repository.

## Licence

Apache-2.0
