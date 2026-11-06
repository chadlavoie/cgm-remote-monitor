'use strict';

function configure(app, wares, ctx) {
  const api = require('express').Router();
  api.use(wares.sendJSONStatus);
  api.use(wares.jsonParser);
  api.use(function (req, res, next) {
    res.set('Cache-Control', 'no-store');
    // Unlike ordinary glucose reads, shadow telemetry always needs credentials,
    // including on sites whose default role grants anonymous read access.
    if (!app.enabled('api') ||
        (!req.header('api-secret') && !req.header('Authorization') && !req.query.token && !req.query.secret)) {
      return res.sendJSONStatus(res, 401, 'Unauthorized', 'Shadow collection requires authentication');
    }
    // Validate before the legacy authorization helper inspects body credentials.
    // This endpoint accepts credentials in headers/query only, never telemetry.
    try {
      if (req.method === 'POST') {
        require('../../server/cgm-observations').normalize(req.body, Date.now());
      } else if (req.body && Object.keys(req.body).length) {
        return res.sendJSONStatus(res, 400, 'Invalid observation request', 'GET does not accept a body');
      }
    } catch (err) {
      return res.sendJSONStatus(res, 400, 'Invalid observation request', err.message);
    }
    next();
  });

  function handle(operation) {
    return async function (req, res) {
      try {
        res.json(await operation(req));
      } catch (err) {
        const status = err.status === 400 || err.status === 409 ? err.status : 500;
        if (status === 500) console.error('Shadow collection storage error', err);
        res.sendJSONStatus(res, status, status === 500 ? 'Storage error' : 'Invalid observation request',
          status === 500 ? 'Retry the request with the same observation IDs' : err.message);
      }
    };
  }

  const authOptions = {requireCredentials: true};
  api.post('/cgm-observations/', ctx.authorization.isPermitted('api:cgm-observations:create', authOptions),
    handle(function (req) { return ctx.cgmObservations.create(req.body); }));
  api.get('/cgm-observations/', ctx.authorization.isPermitted('api:cgm-observations:read', authOptions),
    handle(function (req) { return ctx.cgmObservations.list(req.query); }));
  return api;
}

module.exports = configure;
