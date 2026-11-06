'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const observationStorage = require('../lib/server/cgm-observations');

function sample(overrides) {
  return Object.assign({schemaVersion: 1, receiverId: 'esp32-desk', observationId: 'boot1-123',
    sensorSessionId: 'session-1', date: Date.now() - 60000, bleReceivedAt: Date.now() - 59000,
    sgv: 112, sensorStatus: 'valid', trendRate: -0.5, trendRateUnit: 'mg/dL/min'}, overrides);
}

// Exercise the real storage adapter and authorization middleware without touching
// a configured Nightscout database.
function fixture(defaultRoles) {
  const documents = new Map();
  const indexes = [];
  let failIndex = false;
  const collection = {
    createIndex: async function (keys, options) {
      if (failIndex) throw new Error('Index unavailable');
      indexes.push({keys: keys, options: options});
    },
    insertOne: async function (doc) {
      if (documents.has(doc._id)) {
        const err = new Error('Duplicate key');
        err.code = 11000;
        throw err;
      }
      documents.set(doc._id, doc);
    },
    findOne: async function (filter) { return documents.get(filter._id); },
    find: function (filter) {
      let result = Array.from(documents.values()).filter(function (doc) {
        return (!filter.receiverId || filter.receiverId === doc.receiverId) &&
          (!filter.sensorSessionId || filter.sensorSessionId === doc.sensorSessionId) &&
          (!filter.date || ((filter.date.$gte === undefined || doc.date >= filter.date.$gte) &&
            (filter.date.$lt === undefined || doc.date < filter.date.$lt)));
      });
      const cursor = {
        sort: function () { result.sort(function (a, b) { return b.date - a.date || b._id.localeCompare(a._id); }); return cursor; },
        limit: function (count) { result = result.slice(0, count); return cursor; },
        toArray: async function () { return result.map(function (doc) { const copy = {...doc}; delete copy.payloadHash; return copy; }); }
      };
      return cursor;
    }
  };
  const env = {
    settings: {authDefaultRoles: defaultRoles || 'denied', authFailDelay: 0},
    authentication_collections_prefix: 'auth_',
    enclave: {
      isApiKey: function (key) { return key === 'test-admin'; },
      verifyJWT: function () { return null; }
    }
  };
  const ctx = {
    settings: {units: 'mg/dl'},
    language: {translate: function (text) { return text; }},
    bus: {emit: function (name) {
      if (name === 'data-update' || name === 'data-received') throw new Error('Shadow collection must not emit data events');
    }},
    store: {collection: function (name) {
      if (name === 'auth_roles' || name === 'auth_subjects') return {};
      assert.equal(name, 'cgm_observations', 'Never access a live data collection');
      return collection;
    }}
  };
  ctx.purifier = require('../lib/server/purifier')(env, ctx);
  ctx.authorization = require('../lib/authorization')(env, ctx);
  ctx.authorization.storage.roles = ctx.authorization.storage.defaultRoles;
  const uploadToken = 'receiver-0123456789abcdef';
  ctx.authorization.storage.subjects = [{name: 'receiver', roles: ['cgm-shadow-upload'],
    accessTokenDigest: uploadToken, digest: '0123456789abcdef'}];
  ctx.cgmObservations = observationStorage(env, ctx);
  const app = express();
  app.enable('api');
  const wares = require('../lib/middleware')(env);
  // Mount through the real v1 router, including its extension middleware.
  const apiEnv = Object.assign({}, env, {name: 'test', version: 'test',
    enclave: Object.assign({}, env.enclave, {isApiKeySet: function () { return true; }})});
  // The other v1 routes only need these context objects during construction.
  ctx.wares = wares;
  ctx.cache = {};
  ctx.ddata = {sgvs: []};
  ctx.entries = {};
  ctx.devicestatus = {};
  app.use('/api/v1', require('../lib/api')(apiEnv, ctx));
  return {app: app, ctx: ctx, collection: collection, documents: documents, indexes: indexes, uploadToken: uploadToken,
    failIndex: function (value) { failIndex = value; }};
}

describe('CGM shadow collection', function () {
  let f;
  beforeEach(function () { f = fixture(); });

  function post(payload, token) {
    return request(f.app).post('/api/v1/cgm-observations').set('api-secret', token || f.uploadToken)
      .send(payload).timeout({response: 1500});
  }

  it('stores float trends and distinct measurement, BLE and server timestamps outside live data', async function () {
    const reading = sample();
    const response = await post(reading).expect(200);
    assert.equal(response.body.mode, 'shadow');
    assert.equal(response.body.observations[0].duplicate, false);
    const doc = Array.from(f.documents.values())[0];
    assert.equal(doc.trendRate, -0.5);
    assert.equal(doc.date, reading.date);
    assert.equal(doc.bleReceivedAt, reading.bleReceivedAt);
    assert.ok(doc.receivedAt instanceof Date);
    assert.equal(doc.source, 'esp32-ble');
    assert.equal(doc.mode, 'shadow');
    assert.deepEqual(f.indexes[0], {keys: {receivedAt: 1}, options: {expireAfterSeconds: 2592000}});
  });

  it('accepts JSON extension URLs, arrays and authenticated bounded reads', async function () {
    const readings = [sample({observationId: 'older', date: Date.now() - 3600000}), sample()];
    await request(f.app).post('/api/v1/cgm-observations.json').set('api-secret', f.uploadToken).send(readings).expect(200);
    const response = await request(f.app).get('/api/v1/cgm-observations.json')
      .set('api-secret', 'test-admin').query({receiverId: 'esp32-desk', count: '1', since: String(readings[1].date)})
      .expect(200);
    assert.equal(response.body.length, 1);
    assert.equal(response.body[0].observationId, readings[1].observationId);
    assert.equal(response.body[0].payloadHash, undefined);
    assert.equal(response.headers['cache-control'], 'no-store');
  });

  it('deduplicates retries and concurrent posts without changing the first receipt time', async function () {
    const reading = sample();
    const responses = await Promise.all([post(reading), post(reading)]);
    assert.deepEqual(responses.map(function (r) { return r.status; }), [200, 200]);
    assert.deepEqual(responses.map(function (r) { return r.body.observations[0].duplicate; }).sort(), [false, true]);
    const original = Array.from(f.documents.values())[0].receivedAt;
    await post(reading).expect(200);
    assert.equal(Array.from(f.documents.values())[0].receivedAt, original);
    assert.equal(f.documents.size, 1);
  });

  it('does not depend on JSON property order for retry identity', async function () {
    const reading = sample();
    await post(reading).expect(200);
    const reordered = Object.fromEntries(Object.entries(reading).reverse());
    const response = await post(reordered).expect(200);
    assert.equal(response.body.observations[0].duplicate, true);
  });

  it('safely retries a batch after a partial storage failure', async function () {
    const insert = f.collection.insertOne;
    let fail = true;
    f.collection.insertOne = async function (doc) {
      if (fail && doc.observationId === 'second') throw new Error('Temporary storage failure');
      return insert(doc);
    };
    const batch = [sample({observationId: 'first'}), sample({observationId: 'second'})];
    await post(batch).expect(500);
    assert.equal(f.documents.size, 1);
    fail = false;
    const response = await post(batch).expect(200);
    assert.deepEqual(response.body.observations.map(function (r) { return r.duplicate; }), [true, false]);
    assert.equal(f.documents.size, 2);
  });

  it('rejects reused IDs with changed contents, while keeping receiver IDs independent', async function () {
    const reading = sample();
    await post(reading).expect(200);
    await post({...reading, sgv: 113}).expect(409);
    await post({...reading, receiverId: 'esp32-bedroom'}).expect(200);
    assert.equal(f.documents.size, 2);
  });

  it('preserves null and zero trends and accepts warmup observations without glucose', async function () {
    await post(sample({observationId: 'warmup', sensorStatus: 'warmup', sgv: null, trendRate: null})).expect(200);
    await post(sample({observationId: 'zero', trendRate: 0})).expect(200);
    const docs = Array.from(f.documents.values());
    assert.equal(docs[0].trendRate, null);
    assert.equal(docs[1].trendRate, 0);
  });

  it('validates the entire batch before writing', async function () {
    await post([sample(), sample({observationId: 'bad', trendRate: '0.5'})]).expect(400);
    assert.equal(f.documents.size, 0);
  });

  it('rejects bad shapes, operator injection, forged server fields and ambiguous units/timestamps', async function () {
    const invalid = [null, [], [null], new Array(101).fill(sample()),
      sample({receiverId: {$ne: null}}), sample({_id: 'forged'}), sample({source: 'dexcomshare'}),
      sample({receivedAt: Date.now()}), sample({date: Math.floor(Date.now() / 1000)}),
      sample({date: Date.now() + 3600000}), sample({sgv: null}), sample({sgv: 12.5}),
      sample({sensorStatus: 'ok'}), sample({trendRateUnit: 'mmol/L/min'}),
      sample({trendRateUnit: undefined}), sample({firmwareVersion: '<script>bad</script>'})];
    for (const payload of invalid) {
      try { await post(payload).expect(400); }
      catch (err) { throw new Error('Payload ' + JSON.stringify(payload) + ': ' + err.message); }
    }
    assert.equal(f.documents.size, 0);
    assert.throws(function () { observationStorage.normalize(sample({trendRate: Infinity}), Date.now()); });
  });

  it('rejects anonymous access even when the default role is readable', async function () {
    f = fixture('readable');
    for (const method of ['post', 'get']) {
      await request(f.app)[method]('/api/v1/cgm-observations').send(method === 'post' ? sample() : undefined).expect(401);
    }
  });

  it('rejects headers and query tokens that resolve to anonymous access', async function () {
    f = fixture('readable cgm-shadow-upload');
    await request(f.app).get('/api/v1/cgm-observations').set('Authorization', 'Basic invalid').expect(401);
    await request(f.app).get('/api/v1/cgm-observations?token=invalid').expect(401);
    await request(f.app).get('/api/v1/cgm-observations').set('api-secret', 'null').expect(401);
    await request(f.app).post('/api/v1/cgm-observations').set('Authorization', 'Basic invalid').send(sample()).expect(401);
    assert.equal(f.documents.size, 0);
  });

  it('allows the shadow role to upload but not read or write glucose entries', async function () {
    await post(sample()).expect(200);
    await request(f.app).get('/api/v1/cgm-observations').set('api-secret', f.uploadToken).expect(401);
    await request(f.app).post('/api/v1/entries').set('api-secret', f.uploadToken).send([{type: 'sgv', sgv: 112, date: Date.now()}]).expect(401);
    await post(sample(), 'incorrect-token').expect(401);
  });

  it('disables shadow routes when the API is disabled', async function () {
    // The outer v1 router derives its API setting from the enclave.
    const app = express();
    app.use(require('../lib/api/cgm-observations')(app, require('../lib/middleware')({}), f.ctx));
    await request(app).post('/cgm-observations').set('api-secret', f.uploadToken).send(sample()).expect(401);
  });

  it('rejects query operators and unbounded or malformed read parameters', async function () {
    for (const query of ['receiverId[$ne]=x', 'count=1001', 'count=-1', 'count=1.5', 'since=123',
      'find[sgv][$gt]=1', 'until=1700000000000&since=1800000000000']) {
      await request(f.app).get('/api/v1/cgm-observations?' + query).set('api-secret', 'test-admin').expect(400);
    }
  });

  it('fails closed on retention index errors and permits retry after recovery', async function () {
    const reading = sample();
    f.failIndex(true);
    await post(reading).expect(500);
    assert.equal(f.documents.size, 0);
    f.failIndex(false);
    await post(reading).expect(200);
  });

  it('allows backlog without treating upload time as measurement time', async function () {
    const old = Date.now() - 10 * 86400000;
    await post(sample({date: old, bleReceivedAt: old + 1000})).expect(200);
    const doc = Array.from(f.documents.values())[0];
    assert.equal(doc.date, old);
    assert.ok(doc.receivedAt.getTime() > old + 86400000);
  });

  it('rejects collection name collisions and refuses storage without the purifier', async function () {
    assert.throws(function () { observationStorage({entries_collection: 'cgm_observations'}, f.ctx); }, /reserved/);
    delete f.ctx.purifier;
    await assert.rejects(f.ctx.cgmObservations.create(sample()), /purifier/);
    assert.equal(f.documents.size, 0);
    assert.equal(f.indexes.length, 0);
  });
});
