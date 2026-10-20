'use strict';

var assert = require('node:assert/strict');
var quickEvents = require('../../lib/client-core/careportal/quick-events');

describe('Care Portal quick events', function () {
  var now = new Date('2026-10-19T00:10:00.000Z');

  [5, 10, 20].forEach(function (dose) {
    it('logs a ' + dose + 'u correction at the click time', function () {
      var records = quickEvents.buildTreatments('correction-' + dose, now, 'Caregiver', 'mg/dl');
      assert.equal(records.length, 1);
      assert.equal(records[0].eventType, 'Correction Bolus');
      assert.equal(records[0].insulin, dose);
      assert.equal(records[0].created_at, now.toISOString());
      assert.equal(records[0].enteredBy, 'Caregiver');
      assert.equal(records[0].units, 'mg/dl');
      assert.equal(records[0].carbs, undefined);
    });
  });

  [
    { id: 'breakfast', name: 'Breakfast', carbs: 40, fat: 20, insulin: 20 }
    , { id: 'lunch', name: 'Lunch', carbs: 30, insulin: 10 }
    , { id: 'dinner-walk', name: 'Dinner + walk', carbs: 60, insulin: 15 }
  ].forEach(function (preset) {
    it('logs ' + preset.name + ' now and its bolus 20 minutes earlier, across midnight', function () {
      var records = quickEvents.buildTreatments(preset.id, now, 'Caregiver', 'mmol');
      assert.equal(records.length, 2);
      var bolus = records[0];
      var meal = records[1];
      assert.equal(bolus.eventType, 'Meal Bolus');
      assert.equal(bolus.insulin, preset.insulin);
      assert.equal(bolus.created_at, '2026-10-18T23:50:00.000Z');
      assert.equal(bolus.carbs, undefined);
      assert.equal(bolus.fat, undefined);
      assert.equal(meal.eventType, 'Meal Bolus');
      assert.equal(meal.carbs, preset.carbs);
      assert.equal(meal.fat, preset.fat);
      assert.equal(meal.insulin, undefined);
      assert.equal(meal.created_at, now.toISOString());
      assert.equal(meal.notes, preset.name);
      records.forEach(function (record) {
        assert.equal(record.enteredBy, 'Caregiver');
        assert.equal(record.units, 'mmol');
        assert.equal(record.preBolus, undefined);
        assert.equal(record.duration, undefined);
      });
    });
  });

  it('does not reuse changed treatment data for subsequent clicks', function () {
    var first = quickEvents.buildTreatments('breakfast', now, 'First', 'mg/dl');
    first[0].insulin = 100;
    first[1].fat = 100;
    var second = quickEvents.buildTreatments('breakfast', now, 'Second', 'mg/dl');
    assert.equal(second[0].insulin, 20);
    assert.equal(second[1].fat, 20);
    assert.equal(second[0].enteredBy, 'Second');
    assert.equal(now.toISOString(), '2026-10-19T00:10:00.000Z');
  });

  it('ignores unknown preset names', function () {
    assert.equal(quickEvents.buildTreatments('unknown', now), null);
  });
});
