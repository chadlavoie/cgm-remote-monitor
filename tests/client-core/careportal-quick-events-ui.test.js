'use strict';

var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var vm = require('vm');
var createRequire = require('module').createRequire;
var createSecureDOM = require('../fixtures/secure-jsdom').createSecureDOM;
var jquery = require('jquery');
var moment = require('moment');

describe('Care Portal quick event buttons', function () {
  var env, $, client, portal, requests, pending, closes, confirmations, alerts, stored;

  beforeEach(function () {
    env = createSecureDOM(fs.readFileSync(path.resolve(__dirname, '../../views/index.html'), 'utf8'));
    $ = jquery(env.window);
    requests = [];
    closes = 0;
    confirmations = 0;
    alerts = [];
    stored = {};
    env.window.confirm = function () { confirmations++; return false; };
    $.ajax = function (request) {
      requests.push(request);
      pending = $.Deferred();
      return pending.promise();
    };
    client = {
      settings: { units: 'mg/dl' }
      , translate: function (text) { return text; }
      , ctx: { moment: function () { return moment.utc('2026-10-19T12:00:00Z'); } }
      , plugins: { getAllEventTypes: function () { return [{ val: 'Correction Bolus', name: 'Correction Bolus', insulin: true }]; } }
      , headers: function () { return { 'api-secret': 'test-token' }; }
      , browserUtils: { closeDrawer: function () { closes++; } }
    };
    // Load the real adapter with isolated storage and browser globals.
    var adapterPath = path.resolve(__dirname, '../../lib/client/careportal.js');
    var adapterRequire = createRequire(adapterPath);
    var context = {
      module: { exports: {} }
      , require: function (name) {
        if (name === 'js-storage') return { localStorage: {
          get: function (key) { return stored[key]; }
          , set: function (key, value) { stored[key] = value; }
        } };
        return adapterRequire(name);
      }
      , window: env.window
      , alert: function (message) { alerts.push(message); }
      , console: console
    };
    vm.runInNewContext(fs.readFileSync(adapterPath, 'utf8'), context, { filename: adapterPath });
    portal = context.module.exports(client, $);
  });

  afterEach(function () { env.cleanup(); });

  it('renders six buttons and sends one authenticated request without confirmation or form data', function () {
    assert.equal($('#quickEventButtons button').length, 6);
    $('#insulinGiven').val('999');
    $('#notes').val('Unsubmitted form');
    $('#enteredBy').val('Caregiver');
    $('[data-quick-event="breakfast"]').trigger('click');
    assert.equal(requests.length, 1);
    assert.equal(confirmations, 0);
    assert.equal(requests[0].contentType, 'application/json');
    assert.equal(requests[0].headers['api-secret'], 'test-token');
    var records = JSON.parse(requests[0].data);
    assert.equal(records[0].insulin, 20);
    assert.equal(records[0].created_at, '2026-10-19T11:40:00.000Z');
    assert.equal(records[1].created_at, '2026-10-19T12:00:00.000Z');
    assert.equal(records[1].fat, 20);
    assert.equal(records[1].notes, 'Breakfast');
    assert.equal(records[1].enteredBy, 'Caregiver');
    assert.equal(closes, 0);
    pending.resolve([]);
    assert.equal(closes, 1);
    assert.equal(stored.enteredBy, 'Caregiver');
  });

  it('blocks repeat clicks and manual submissions while saving, then allows another event', function () {
    var button = $('[data-quick-event="correction-5"]');
    button.trigger('click');
    assert.equal($('#treatmentSubmit').prop('disabled'), true);
    portal.saveQuickEvent.call(button[0]);
    portal.save();
    assert.equal(requests.length, 1);
    pending.resolve([]);
    assert.equal(button.prop('disabled'), false);
    button.trigger('click');
    assert.equal(requests.length, 2);
  });

  it('keeps the drawer open and restores buttons on failure', function () {
    $('[data-quick-event="lunch"]').trigger('click');
    pending.reject({ status: 403 });
    assert.equal(closes, 0);
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /403/);
    assert.equal($('#quickEventButtons button:disabled').length, 0);
    assert.equal($('#treatmentSubmit').prop('disabled'), false);
  });

  it('uses the authenticated author for quick events', function () {
    client.authorized = { sub: 'Authenticated author' };
    $('#enteredBy').val('Other author');
    $('[data-quick-event="dinner-walk"]').trigger('click');
    JSON.parse(requests[0].data).forEach(function (record) {
      assert.equal(record.enteredBy, 'Authenticated author');
    });
  });

  it('keeps the normal form confirmation', function () {
    portal.prepareEvents();
    $('#eventType').val('Correction Bolus');
    $('#insulinGiven').val('5');
    $('#treatmentSubmit').trigger('click');
    assert.equal(confirmations, 1);
    assert.equal(requests.length, 0);
  });
});
