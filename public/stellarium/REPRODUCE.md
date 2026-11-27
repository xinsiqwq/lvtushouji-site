# Local Stellarium renderer

`public/stellarium/index.html` embeds the reviewed browser engine in its own
same-origin document. It loads only local assets. React supplies the time,
location and controls through the documented message bridge. The old Vue UI,
proxy server, remote object search, geolocation and analytics are not involved.

The original engine copyright/AGPL, sky-culture statement and font OFL are
preserved. Public source/notice entry: `/stellarium/source.html`; the downloadable
bundle is `/stellarium/source.zip`; asset hashes are `/stellarium/manifest.json`.

The C/JavaScript source is the **available upstream source snapshot**. Its exact
relationship to the cached WASM binary is **not established**. The original
upstream revision remains `null`. This archive does not claim an exact matching
revision, a newly compiled WASM, or a byte-for-byte C-to-WASM reconstruction.
The cached factory and WASM were linked using the original bundle's hashed WASM
reference. Their reviewed hashes are recorded in the manifest.

## Reproduction

Node.js 22.22 or later can regenerate the browser wrapper, Chinese culture name
records, actual star child masks, manifest and source archive without accessing
the old project or the network:

```sh
node scripts/prepare-stellarium.mjs
```

To repeat the original bounded extraction, install TypeScript and point at a
source checkout containing the reviewed `.tools` engine files:

```sh
node scripts/prepare-stellarium.mjs --source-root="PATH_TO_REVIEWED_LOCAL_REFERENCE"
```

The script locates the single inner Emscripten factory in Webpack module `c074`
using a TypeScript AST. It preserves that fragment and copies only the engine,
sample stars/western/landscape and licence resources. It never starts that site
or reads its storage, environment, accounts or uploads.

Recreate the static Chinese font subsets from the original official font:

```sh
uv run --with fonttools==4.66.1 python docs/third-party/stellarium/subset-font.py
node scripts/prepare-stellarium.mjs
```

The font script pins weights 400/600, retains copyright/OFL metadata, renames the
modified family to Travel Sky Sans, and checks all Chinese glyphs used by the
runtime/catalogue. Subsets currently cover 218 Chinese characters plus Latin,
Greek and symbols; arbitrary user-provided Chinese text is not part of the
canvas font contract. The outside React interface uses normal browser fonts.

The available C source includes its Makefile, SConstruct, data, tools and
dependencies. Its README documents the Emscripten/SCons build. The exact original
compiler/toolchain for the cached binary is unknown, so this build was not run
and binary correspondence remains unverified.

## Local catalogue

All twelve order-zero star tiles are present, plus 32 real order-one sample
tiles. The original base tiles claim children beyond those present in the
snapshot. Preparation derives each base tile's `children_mask` from the actual
local child inventory and preserves the untouched source tiles in the archive.
Only that metadata and chunk checksum change; celestial records/coordinates are
not generated or altered. This is a basic test catalogue, not complete Gaia or
complete faint-star coverage. Sky-culture lines and all 88 constellation objects
are local. Illustrations are hidden by default. The engine can display an
illustration for a selected constellation despite its ordinary visibility
switch, so the full local illustration set is retained to avoid missing assets.

The UI exposes 25 named stars. Its stable `HIP nnnn` identifiers are translated
to the real names in this cached catalogue. Native direct lookup uses names such
as `Sirius`, not `NAME Sirius`; Megrez uses `* del UMa`, Mizar uses `* zet UMa`.
All 25 aliases and 88 constellations were exercised against real engine objects.
Planet syntax is `NAME Moon`, `NAME Saturn`, etc.; constellation syntax is
`CON western Ori`. The bridge also accepts `CON Orion`. Native culture IDs have
some mixed-case variants such as `Cvn`; the runtime maps the UI's IAU casing.

The optional DSO sample is not registered; this interface does not provide M31
or M42 search entries. A previous unused `data/dso` folder remains on disk after
automatic approval rejected its deletion. It is excluded from the asset
manifest/source bundle and never requested by the runtime.

## Bridge and lifecycle

The child reads `session` from its URL and validates message origin, parent
window, source name and session. Commands are `configure`, `target`, `view`,
`reset`, `pause`, and `resume`. Empty target ID clears selection and tracking.
Observers use radians and Modified Julian Date internally. All bridge angles
are degrees, dates ISO strings. Latitude/longitude/time are taken from actual
engine state. Time speed is always zero; configuration preserves the camera.

`ready` message acknowledges module startup; initial `state.ready=false` becomes
true only after rendered frames, all twelve successful base tile responses,
completed star progress and completed font loading. That readiness is retained
through pause/resume. `starsLoaded` reflects successful responses plus actual
render/progress state, not a fabricated star count. States are sampled every
200ms while active. Missing targets report `{code,message}` with `fatal:false`.
WASM/font/WebGL initialization failures report fatal errors.

The bootstrap owns the local WASM request with an awaited fetch/arrayBuffer and
validation inside try/catch, then supplies `wasmBinary` to the factory. This
bypasses a streaming fetch branch in the cached factory that drops its Promise
and otherwise leaves module readiness pending when the request fails. Network
failure is actually caught before the engine starts; global error suppression
is not used. `pagehide` aborts a pending controlled resource request.

The native recursive RAF loop has no global destroy/pause API. The child wraps
RAF so host pause and document hiding stop scheduled callbacks. Removing the
iframe destroys the isolated document; `pagehide` cancels pending callbacks,
clears polling, and deletes the GL context where available. Per-object
`destroy()` releases that object reference, not the whole engine.

Labels are controlled through `stars.hints_visible`, `planets.hints_visible`
and `constellations.labels_visible`. The state combines their real values.
Constellation lines use the engine's built-in blue-green color; no public line
color property exists in this snapshot. The azimuth grid uses a muted blue-gray
RGBA value. Canvas supports drag, wheel, arrows, +/- and Escape close messaging.

## Verification

The isolated smoke script serves only the public files and a synthetic host at
127.0.0.1:3001, runs a fresh headless Chrome, and always stops both in `finally`:

```sh
node docs/third-party/stellarium/verify-runtime.mjs
```

It exercises real WASM, tile readiness, actual target coordinates, all 25 stars
and 88 constellations, labels, missing-target recovery, frozen time, reset,
session validation, RAF pause/resume, keyboard controls, and iframe teardown.
It writes `runtime-verification.json` and a real `runtime-preview.png`.
Any host-machine Kaspersky injected requests are counted separately; the
runtime itself requests no remote astronomy/location/account service.
This static smoke does not claim verification of the current user page at 3000.
