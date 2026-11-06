'use strict';

const crypto = require('node:crypto');
const purifyForStorage = require('./storage-purifier');

const COLLECTION = 'cgm_observations';
const RETENTION_SECONDS = 30 * 24 * 60 * 60;
const MAX_BATCH = 100;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DIRECTIONS = ['NONE', 'DoubleUp', 'SingleUp', 'FortyFiveUp', 'Flat',
  'FortyFiveDown', 'SingleDown', 'DoubleDown', 'NOT COMPUTABLE', 'RATE OUT OF RANGE'];

function invalid(message, status) {
  const error = new Error(message);
  error.status = status || 400;
  throw error;
}

function identifier(value, name) {
  if (typeof value !== 'string' || !ID.test(value)) invalid('Invalid ' + name);
  return value;
}

function timestamp(value, name, now) {
  // Require epoch milliseconds, rather than silently accepting seconds or strings.
  if (!Number.isSafeInteger(value) || value < 946684800000 || value > now + 600000) {
    invalid(name + ' must be epoch milliseconds, no more than 10 minutes in the future');
  }
  return value;
}

function normalize(payload, now) {
  const items = Array.isArray(payload) ? payload : [payload];
  if (!items.length || items.length > MAX_BATCH) invalid('Expected 1 to 100 observations');
  const fields = ['schemaVersion', 'receiverId', 'observationId', 'sensorSessionId',
    'sensorModel', 'firmwareVersion', 'date', 'bleReceivedAt', 'sgv', 'sensorStatus',
    'trendRate', 'trendRateUnit', 'direction', 'rssi', 'sequence', 'receiverUptimeMs'];

  return items.map(function (item) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid('Expected observation objects');
    Object.keys(item).forEach(function (key) {
      if (!fields.includes(key)) invalid('Unknown observation field: ' + key);
    });
    if (item.schemaVersion !== 1) invalid('schemaVersion must be 1');
    const doc = {
      schemaVersion: 1,
      receiverId: identifier(item.receiverId, 'receiverId'),
      observationId: identifier(item.observationId, 'observationId'),
      date: timestamp(item.date, 'date', now),
      bleReceivedAt: timestamp(item.bleReceivedAt, 'bleReceivedAt', now),
      sensorStatus: item.sensorStatus,
      sgv: item.sgv == null ? null : item.sgv,
      trendRate: item.trendRate == null ? null : item.trendRate,
      trendRateUnit: 'mg/dL/min',
      source: 'esp32-ble',
      mode: 'shadow'
    };
    if (!['valid', 'warmup', 'error', 'unavailable', 'unknown'].includes(doc.sensorStatus)) {
      invalid('Invalid sensorStatus');
    }
    if (doc.sgv !== null && (!Number.isInteger(doc.sgv) || doc.sgv < 1 || doc.sgv > 1000)) {
      invalid('sgv must be null or an integer from 1 to 1000 mg/dL');
    }
    if (doc.sensorStatus === 'valid' && doc.sgv === null) invalid('Valid readings require sgv');
    if (doc.trendRate !== null && (typeof doc.trendRate !== 'number' || !Number.isFinite(doc.trendRate))) {
      invalid('trendRate must be a finite number or null');
    }
    if ((doc.trendRate !== null && item.trendRateUnit !== 'mg/dL/min') ||
        (item.trendRateUnit !== undefined && item.trendRateUnit !== 'mg/dL/min')) {
      invalid('trendRateUnit must be mg/dL/min');
    }
    ['sensorSessionId', 'sensorModel', 'firmwareVersion'].forEach(function (key) {
      if (item[key] !== undefined) doc[key] = identifier(item[key], key);
    });
    if (item.direction !== undefined) {
      if (!DIRECTIONS.includes(item.direction)) invalid('Invalid direction');
      doc.direction = item.direction;
    }
    if (item.rssi !== undefined) {
      if (!Number.isInteger(item.rssi) || item.rssi < -127 || item.rssi > 20) invalid('Invalid rssi');
      doc.rssi = item.rssi;
    }
    ['sequence', 'receiverUptimeMs'].forEach(function (key) {
      if (item[key] !== undefined) {
        if (!Number.isSafeInteger(item[key]) || item[key] < 0) invalid('Invalid ' + key);
        doc[key] = item[key];
      }
    });
    return doc;
  });
}

function queryOptions(query, now) {
  const filter = {};
  Object.keys(query).forEach(function (key) {
    if (!['receiverId', 'sensorSessionId', 'since', 'until', 'count', 'token', 'secret'].includes(key)) {
      invalid('Unknown query parameter: ' + key);
    }
  });
  ['receiverId', 'sensorSessionId'].forEach(function (key) {
    if (query[key] !== undefined) filter[key] = identifier(query[key], key);
  });
  ['since', 'until'].forEach(function (key) {
    if (query[key] !== undefined) {
      if (typeof query[key] !== 'string' || !/^\d{13}$/.test(query[key])) invalid('Invalid ' + key);
      const value = timestamp(Number(query[key]), key, now);
      if (!filter.date) filter.date = {};
      filter.date[key === 'since' ? '$gte' : '$lt'] = value;
    }
  });
  if (filter.date && filter.date.$gte !== undefined && filter.date.$lt !== undefined &&
      filter.date.$gte >= filter.date.$lt) invalid('since must precede until');
  const count = query.count === undefined ? '100' : query.count;
  if (typeof count !== 'string' || !/^\d{1,4}$/.test(count) || Number(count) < 1 || Number(count) > 1000) {
    invalid('count must be from 1 to 1000');
  }
  return {filter: filter, count: Number(count)};
}

function storage(env, ctx) {
  const liveCollections = ['entries_collection', 'treatments_collection', 'devicestatus_collection',
    'profile_collection', 'settings_collection', 'food_collection', 'activity_collection'];
  if (liveCollections.some(function (key) { return env[key] === COLLECTION; }) ||
      [env.authentication_collections_prefix + 'roles', env.authentication_collections_prefix + 'subjects'].includes(COLLECTION)) {
    throw new Error('cgm_observations is reserved for isolated shadow telemetry');
  }
  let indexPromise;
  function collection() { return ctx.store.collection(COLLECTION); }

  async function ready() {
    // Do not accept observations until retention is enforced. Retry failed setup
    // on the next request, without adding a new startup dependency for collectors.
    if (!indexPromise) {
      indexPromise = (async function () {
        await collection().createIndex({receivedAt: 1}, {expireAfterSeconds: RETENTION_SECONDS});
        await collection().createIndex({date: -1, _id: -1});
        await collection().createIndex({receiverId: 1, date: -1, _id: -1});
      })().catch(function (err) { indexPromise = null; throw err; });
    }
    await indexPromise;
  }

  async function create(payload) {
    const now = Date.now();
    const docs = normalize(payload, now);
    purifyForStorage(ctx, docs);
    await ready();
    const results = [];
    for (const doc of docs) {
      // Mongo's built-in unique _id index makes retries safe across processes.
      const id = crypto.createHash('sha256').update(JSON.stringify([doc.receiverId, doc.observationId])).digest('hex');
      const digest = crypto.createHash('sha256').update(JSON.stringify(doc)).digest('hex');
      const stored = Object.assign({_id: id}, doc, {payloadHash: digest, receivedAt: new Date(now)});
      let duplicate = false;
      try {
        await collection().insertOne(stored);
      } catch (err) {
        if (err.code !== 11000) throw err;
        const previous = await collection().findOne({_id: id});
        if (!previous || previous.payloadHash !== digest) {
          invalid('observationId already exists with different contents', 409);
        }
        duplicate = true;
      }
      results.push({receiverId: doc.receiverId, observationId: doc.observationId, duplicate: duplicate});
    }
    // Deliberately no entries writes, data-update events, or live cache changes.
    return {mode: 'shadow', observations: results};
  }

  async function list(query) {
    const options = queryOptions(query, Date.now());
    await ready();
    return collection().find(options.filter, {projection: {payloadHash: 0}})
      .sort({date: -1, _id: -1}).limit(options.count).toArray();
  }

  return {create: create, list: list};
}

module.exports = storage;
module.exports.normalize = normalize;
module.exports.queryOptions = queryOptions;
module.exports.COLLECTION = COLLECTION;
module.exports.RETENTION_SECONDS = RETENTION_SECONDS;
