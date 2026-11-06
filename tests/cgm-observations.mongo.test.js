'use strict';

const assert = require('node:assert/strict');
const MongoClient = require('mongodb').MongoClient;
const storage = require('../lib/server/cgm-observations');

describe('CGM shadow collection with MongoDB', function () {
  let client;
  let db;
  before(async function () {
    const uri = process.env.SHADOW_TEST_MONGODB_URI;
    if (!uri) return this.skip();
    const parsed = new URL(uri);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname), 'Use a local MongoDB test server');
    assert.match(parsed.pathname, /^\/[A-Za-z0-9_-]+_shadow_test$/, 'Use a dedicated *_shadow_test database');
    client = new MongoClient(uri, {serverSelectionTimeoutMS: 2000});
    await client.connect();
    db = client.db();
    await db.collection(storage.COLLECTION).deleteMany({});
  });
  after(async function () {
    if (db) await db.collection(storage.COLLECTION).deleteMany({});
    if (client) await client.close();
  });

  it('persists floats, enforces retention and deduplicates concurrent observations atomically', async function () {
    const ctx = {
      store: {collection: function (name) { assert.equal(name, storage.COLLECTION); return db.collection(name); }},
      purifier: require('../lib/server/purifier')({}, {})
    };
    const api = storage({}, ctx);
    const reading = {schemaVersion: 1, receiverId: 'esp32-test', observationId: 'test-1',
      date: Date.now() - 1000, bleReceivedAt: Date.now(), sgv: 112, sensorStatus: 'valid',
      trendRate: -0.5, trendRateUnit: 'mg/dL/min'};
    const results = await Promise.all([api.create(reading), api.create(reading)]);
    assert.deepEqual(results.map(function (r) { return r.observations[0].duplicate; }).sort(), [false, true]);
    const rows = await api.list({receiverId: 'esp32-test'});
    assert.equal(rows.length, 1);
    assert.equal(rows[0].trendRate, -0.5);
    assert.equal(rows[0].payloadHash, undefined);
    assert.ok(rows[0].receivedAt instanceof Date);
    await assert.rejects(api.create({...reading, trendRate: -0.75}), {status: 409});
    const indexes = await db.collection(storage.COLLECTION).listIndexes().toArray();
    assert.ok(indexes.some(function (index) {
      return index.key.receivedAt === 1 && index.expireAfterSeconds === storage.RETENTION_SECONDS;
    }));
  });
});
