# ESP32 BLE shadow collection

The experimental endpoint is `POST https://YOUR-SITE/api/v1/cgm-observations`.
It stores BLE observations in the separate `cgm_observations` MongoDB collection.
It never writes `entries`, changes the selected glucose source, updates live
caches, or emits glucose events. Keep the existing Dexcom Share collector running.
This phase collects evidence for evaluating the receiver; it does not yet perform
automatic Share/BLE matching, comparisons, or source preference.

## Server setup

1. Deploy a build containing this change and restart Nightscout. A configured
   `API_SECRET` is required, as with other write APIs. There is no new enable flag.
2. In Nightscout's `/admin` access management, create a subject for the receiver
   and assign **`cgm-shadow-upload`**. Its permission is
   `api:cgm-observations:create`; it does not grant glucose upload privileges.
   Do not grant this receiver `admin` or `api:entries:create`.
3. Put that subject's access token in the receiver's **`api-secret` header**.
   This header accepts Nightscout subject access tokens as well as the legacy
   API secret hash. The receiver does not need the administrator secret.
4. Use an administrator credential, or a subject with
   `api:cgm-observations:read`, to inspect observations. On a site with the
   default `readable` role, authenticated subjects also inherit read permissions.

Anonymous reads and uploads are rejected even on publicly readable sites.
Query-string tokens and Bearer JWTs work through normal Nightscout authorization,
but a header avoids putting credentials into URL logs. Credentials in the JSON
payload are not supported. Use HTTPS with certificate verification on the ESP32.

The first read or write creates indexes using the existing MongoDB connection.
The database user must be able to create indexes. If index setup fails, the
endpoint returns 500 and accepts no observations until setup succeeds.

**Retention: 30 days from the first server receipt**, including backfilled data.
MongoDB TTL cleanup is asynchronous. Duplicate retries do not extend retention.
After expiration, an old observation can be accepted again, so the receiver must
stop retrying acknowledged records. Export data before expiry if you need it for
longer range/stability studies. The collection name is reserved; configuring a
live Nightscout collection with that name is rejected at startup.

## Firmware payload contract (version 1)

Send `Content-Type: application/json`, with one object or an array of **1–100**
objects. Requests are limited to 1 MB. Unknown fields are rejected so protocol
mistakes and misspelled fields do not silently lose information.

```json
{
  "schemaVersion": 1,
  "receiverId": "esp32-desk",
  "observationId": "boot-a1-000123",
  "sensorSessionId": "sensor-session-1",
  "sensorModel": "G7",
  "firmwareVersion": "0.1.0",
  "date": 1700000000000,
  "bleReceivedAt": 1700000000800,
  "sgv": 112,
  "sensorStatus": "valid",
  "trendRate": -0.5,
  "trendRateUnit": "mg/dL/min",
  "direction": "Flat",
  "rssi": -72,
  "sequence": 123,
  "receiverUptimeMs": 3600000
}
```

The example dates are historical and accepted as backfill. Real firmware must
send the actual measurement and reception times.

| Field | Requirement and meaning |
| --- | --- |
| `schemaVersion` | Required; integer `1`. |
| `receiverId` | Required; stable identifier for the physical receiver. |
| `observationId` | Required; unique observation ID within that receiver. Persist it unchanged with queued data and across retries. A random boot ID plus a persistent-in-that-boot counter is one option. |
| `date` | Required; sensor measurement time as an integer Unix epoch **in milliseconds**. Never substitute upload time for old readings. |
| `bleReceivedAt` | Required; time the receiver obtained the observation, also epoch milliseconds. |
| `sgv` | Integer glucose in **mg/dL**, 1–1000, or `null`/omitted when unavailable. Required for `sensorStatus: "valid"`. This storage range is a wire validation bound, not a statement of sensor accuracy. |
| `sensorStatus` | Required; `valid`, `warmup`, `error`, `unavailable`, or `unknown`. Decode status separately from glucose; never upload a protocol error sentinel as valid glucose. |
| `trendRate` | Finite JSON number, such as `-0.5`, or `null`/omitted when unavailable. Zero means a known zero rate. Send the decoded **sensor** rate, not a rate inferred from an arrow or successive glucose values. |
| `trendRateUnit` | Must be `mg/dL/min` when a numeric rate is supplied. Storage always uses this unit, independently of site display units. |
| `sensorSessionId` | Optional session identifier, stable for the sensor session and changed on replacement. An opaque local alias is sufficient; no transmitter secret is needed. |
| `sensorModel`, `firmwareVersion` | Optional identifiers for decoding and debugging. |
| `direction` | Optional existing Nightscout arrow name: `NONE`, `DoubleUp`, `SingleUp`, `FortyFiveUp`, `Flat`, `FortyFiveDown`, `SingleDown`, `DoubleDown`, `NOT COMPUTABLE`, or `RATE OUT OF RANGE`. No arrow is synthesized in shadow mode. |
| `rssi` | Optional integer dBm, -127 to 20; signal strength at reception. |
| `sequence` | Optional nonnegative sensor reading counter, scoped to the sensor session. |
| `receiverUptimeMs` | Optional nonnegative integer uptime at reception. |

Identifiers are 1–128 characters: start with an ASCII letter/digit, followed by
letters, digits, `_`, `.`, `:`, or `-`. Counters must be safe JSON integers.
Dates before 2000 or more than 10 minutes ahead of server time are rejected.
Synchronize the receiver's wall clock before constructing epoch timestamps. If
the sensor exposes only a relative clock, anchor it to UTC and preserve that
mapping while queuing data. Old/backfilled measurements are accepted.

Confirm scaling, status codes, and unavailable trend sentinels against the exact
sensor model before uploading a decoded rate. Use `null` if decoding is uncertain.
Do not round a decoded `-0.5` to an arrow or integer.

## Upload, acknowledgements, and retries

Save the JSON example above to `observation.json`, then:

```sh
curl --fail-with-body \
  'https://YOUR-SITE/api/v1/cgm-observations' \
  -H "api-secret: $SHADOW_UPLOAD_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @observation.json
```

A successful upload returns **200** after persistence:

```json
{
  "mode": "shadow",
  "observations": [
    {"receiverId": "esp32-desk", "observationId": "boot-a1-000123", "duplicate": false}
  ]
}
```

- Retry an identical observation with the same `(receiverId, observationId)`;
  it returns 200 with `duplicate: true`. Original contents and server receipt
  time remain unchanged. Object property order does not affect deduplication.
- Reusing that pair with different contents returns **409**. Each observation
  represents an immutable reception: do not refresh RSSI, uptime, timestamps, or
  firmware metadata while retrying. A separate reception may use a new ID.
- **400** means fix the payload; **401** means fix credentials/permissions;
  **413** means reduce the request size. For 409, investigate ID reuse.
- On network errors or **500**, retry with exponential backoff and jitter using
  the original IDs and payloads. Delete queued items only after acknowledgement.
- The complete batch is validated before writing, but storage is **not a batch
  transaction**. A conflict/database failure can leave an earlier portion stored.
  Retrying the original batch safely acknowledges that portion as duplicates.

Do not POST these observations to `/entries`: that would bypass shadow mode.
The `.json` URL suffix and a trailing slash are also supported.

## Inspect and export

```sh
curl --fail-with-body --get \
  'https://YOUR-SITE/api/v1/cgm-observations' \
  -H "api-secret: $SHADOW_READ_TOKEN" \
  --data-urlencode 'receiverId=esp32-desk' \
  --data-urlencode 'since=1700000000000' \
  --data-urlencode 'until=1700086400000' \
  --data-urlencode 'count=1000'
```

GET returns an array, newest **measurement time** first. Supported parameters:
`receiverId`, `sensorSessionId`, `since` (inclusive measurement epoch ms), `until`
(exclusive measurement epoch ms), and `count` (default 100, maximum 1000).
Use smaller time windows if a response reaches the limit; there is no cursor
pagination in this version. Query operators and arbitrary `find` filters are
not supported. Export separate receivers separately when necessary.

Each record includes the normalized payload plus a server-generated `_id`,
`source: "esp32-ble"`, `mode: "shadow"`, and **`receivedAt`**, an ISO UTC timestamp
assigned at first server receipt. The internal deduplication hash is not returned.
No sensor measurement timestamp is rewritten to make a backlog look live.

Compare these observations with ordinary `/api/v1/entries` Share history by
measurement time. `bleReceivedAt - date` estimates sensor-to-receiver delay;
`receivedAt - bleReceivedAt` estimates queuing/upload delay, subject to clock
accuracy. RSSI, observation gaps, uptime resets, and firmware version support
range/stability testing. Shadow records are not used for alerts or dosing inputs.

## Verification

```sh
./node_modules/.bin/mocha --timeout 5000 --exit tests/cgm-observations.test.js
```

These tests exercise the mounted v1 routes and real authorization middleware,
with an in-memory collection substitute. To additionally verify real MongoDB
indexes, concurrent insert deduplication, and persistence, run against a dedicated
local test database:

```sh
SHADOW_TEST_MONGODB_URI=mongodb://127.0.0.1:27017/nightscout_shadow_test \
  ./node_modules/.bin/mocha --timeout 10000 --exit tests/cgm-observations.mongo.test.js
```

The Mongo test is skipped unless that explicit URI is provided. It requires a
local database whose name ends in `_shadow_test` and clears only its
`cgm_observations` collection before/after the test.
