import { CqlError } from './errors.js';

/**
 * @typedef {object} Geometry
 * @property {string} type
 * @property {any[]} [coordinates]
 * @property {Geometry[]} [geometries]
 */

export const GEOMETRY_TYPES = {
  point: 'Point',
  linestring: 'LineString',
  polygon: 'Polygon',
  multipoint: 'MultiPoint',
  multilinestring: 'MultiLineString',
  multipolygon: 'MultiPolygon',
  geometrycollection: 'GeometryCollection'
};

/**
 * @param {number} value
 * @returns {string}
 */
export function numberToText(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new CqlError('invalid-number', `Cannot write ${value} as a number`);
  }
  return String(value);
}

/**
 * @param {number[]} position
 * @returns {string}
 */
function point(position) {
  return position.map(numberToText).join(' ');
}

/**
 * @param {number[][]} positions
 * @returns {string}
 */
function points(positions) {
  return `(${positions.map(point).join(', ')})`;
}

/**
 * @param {number[][][]} lines
 * @returns {string}
 */
function rings(lines) {
  return `(${lines.map(points).join(', ')})`;
}

/**
 * @param {any} coordinates
 * @returns {boolean}
 */
function hasZ(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length === 0) {
    return false;
  }
  return Array.isArray(coordinates[0]) ? hasZ(coordinates[0]) : coordinates.length > 2;
}

/**
 * @param {Geometry} geometry
 * @returns {string}
 */
export function geometryToWkt(geometry) {
  const tag = String(geometry.type).toUpperCase();
  if (geometry.type === 'GeometryCollection') {
    const members = geometry.geometries ?? [];
    if (members.length === 0) {
      return `${tag} EMPTY`;
    }
    const z = members.some(member => hasZ(member.coordinates)) ? ' Z' : '';
    return `${tag}${z} (${members.map(geometryToWkt).join(', ')})`;
  }
  const coordinates = geometry.coordinates ?? [];
  if (coordinates.length === 0) {
    return `${tag} EMPTY`;
  }
  const prefix = hasZ(coordinates) ? `${tag} Z ` : `${tag} `;
  switch (geometry.type) {
    case 'Point':
      return `${prefix}(${point(coordinates)})`;
    case 'LineString':
      return prefix + points(coordinates);
    case 'MultiPoint':
      return `${prefix}(${coordinates.map((/** @type {number[]} */ position) => `(${point(position)})`).join(', ')})`;
    case 'Polygon':
    case 'MultiLineString':
      return prefix + rings(coordinates);
    case 'MultiPolygon':
      return `${prefix}(${coordinates.map(rings).join(', ')})`;
    default:
      throw new CqlError('invalid-geometry', `Unknown geometry type ${geometry.type}`);
  }
}
