const test = require('node:test');
const assert = require('node:assert/strict');

const plugin = require('../server/index');

const route = (method, path) => plugin.routes.find((r) => r.method === method && r.path === path);

/** Minimal ctx stub matching the host's route-handler surface. */
function stubCtx(overrides = {}) {
  const metaStore = new Map();
  return {
    trips: { getById: async () => null },
    places: { create: async (tripId, input) => ({ id: 7, trip_id: tripId, ...input }) },
    meta: {
      get: async (kind, id, key) => metaStore.get(`${kind}:${id}:${key}`) ?? null,
      set: async (kind, id, key, value) => { metaStore.set(`${kind}:${id}:${key}`, value); },
    },
    log: { info() {}, warn() {}, error() {} },
    _metaStore: metaStore,
    ...overrides,
  };
}

test('GET /defaults returns trip-derived values', async () => {
  const ctx = stubCtx({
    trips: { getById: async () => ({ id: 1, destination: 'Paris, France', start_date: '2027-09-10', end_date: '2027-09-15' }) },
  });
  const res = await route('GET', '/defaults').handler({ query: { tripId: '1' } }, ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { location: 'Paris, France', checkin: '2027-09-10', checkout: '2027-09-15' });
});

test('GET /defaults degrades to {} when the trip read fails', async () => {
  const ctx = stubCtx({ trips: { getById: async () => { throw new Error('RESOURCE_FORBIDDEN'); } } });
  const res = await route('GET', '/defaults').handler({ query: { tripId: '9' } }, ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {});
});

test('POST /search validates its input before fetching', async () => {
  const handler = route('POST', '/search').handler;
  let res = await handler({ body: {} }, stubCtx());
  assert.equal(res.status, 400);
  res = await handler({ body: { location: 'Paris', checkin: 'bad', checkout: '2027-01-15' } }, stubCtx());
  assert.equal(res.status, 400);
});

test('GET /photo refuses non-muscache hosts', async () => {
  const handler = route('GET', '/photo').handler;
  for (const url of ['https://evil.com/x.jpg', 'http://a0.muscache.com/x.jpg', 'https://muscache.com.evil.com/x.jpg', 'not-a-url', '']) {
    const res = await handler({ query: { url } }, stubCtx());
    assert.equal(res.status, 400, `should refuse ${url}`);
  }
});

test('GET /photo proxies a muscache image as a data URI and caches it', async (t) => {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls++;
    assert.match(String(url), /^https:\/\/a0\.muscache\.com\//);
    assert.match(String(url), /im_w=320/);
    return {
      ok: true,
      headers: { get: (h) => (h === 'content-type' ? 'image/jpeg' : null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const handler = route('GET', '/photo').handler;
  const req = { query: { url: 'https://a0.muscache.com/im/pictures/abc.jpg' } };
  const res = await handler(req, stubCtx());
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).dataUri, 'data:image/jpeg;base64,' + bytes.toString('base64'));
  await handler(req, stubCtx());
  assert.equal(calls, 1, 'second request served from cache');
});

test('GET /geocode returns trimmed unique suggestions', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /^https:\/\/nominatim\.openstreetmap\.org\/search\?/);
    return {
      ok: true,
      json: async () => [
        { display_name: 'Paris, Île-de-France, Metropolitan France, France' },
        { display_name: 'Paris, Île-de-France, Metropolitan France, France' },
        { display_name: 'Paris, Lamar County, Texas, United States' },
      ],
    };
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const res = await route('GET', '/geocode').handler({ query: { q: 'paris' } }, stubCtx());
  assert.deepEqual(JSON.parse(res.body).suggestions, [
    'Paris, Île-de-France, Metropolitan France',
    'Paris, Lamar County, Texas',
  ]);
});

test('GET /geocode degrades to empty on short input or upstream failure', async (t) => {
  const handler = route('GET', '/geocode').handler;
  let res = await handler({ query: { q: 'p' } }, stubCtx());
  assert.deepEqual(JSON.parse(res.body), { suggestions: [] });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  t.after(() => { globalThis.fetch = realFetch; });
  res = await handler({ query: { q: 'paris' } }, stubCtx());
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { suggestions: [] });
});

test('POST /search rejects max price below min price', async () => {
  const res = await route('POST', '/search').handler(
    { body: { location: 'Paris', checkin: '2027-01-10', checkout: '2027-01-15', priceMin: 200, priceMax: 100 } },
    stubCtx()
  );
  assert.equal(res.status, 400);
});

test('GET /listing rejects non-numeric ids', async () => {
  const handler = route('GET', '/listing').handler;
  for (const id of ['abc', '12a', '../etc', '']) {
    const res = await handler({ query: { id } }, stubCtx());
    assert.equal(res.status, 400, `should refuse "${id}"`);
  }
});

test('GET /listing fetches and caches details', async (t) => {
  let calls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls++;
    assert.equal(String(url), 'https://www.airbnb.com/rooms/424242');
    return {
      ok: true,
      text: async () => '<meta property="og:description" content="Great flat" />' + 'x'.repeat(6000),
    };
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const handler = route('GET', '/listing').handler;
  const res = await handler({ query: { id: '424242' } }, stubCtx());
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.body).description, 'Great flat');
  await handler({ query: { id: '424242' } }, stubCtx());
  assert.equal(calls, 1, 'second request served from cache');
});

test('POST /search applies the superhost-only filter server-side', async (t) => {
  const ssr = {
    niobeClientData: [[
      'StaysSearch:x',
      { data: { presentation: { staysSearch: { results: {
        searchResults: [
          { title: 'A', badges: [{ loggingContext: { badgeType: 'SUPERHOST' } }], demandStayListing: { location: { coordinate: { latitude: 1, longitude: 2 } } } },
          { title: 'B', demandStayListing: { location: { coordinate: { latitude: 3, longitude: 4 } } } },
        ],
        pagination: { totalCount: 2 },
      } } } } },
    ]],
  };
  const html = `<script id="data-deferred-state-0" type="application/json">${JSON.stringify(ssr)}</script>` + 'x'.repeat(6000);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => html });
  t.after(() => { globalThis.fetch = realFetch; });

  const res = await route('POST', '/search').handler(
    { body: { location: 'Paris', checkin: '2027-01-10', checkout: '2027-01-15', superhostOnly: true } },
    stubCtx()
  );
  const { listings, totalCount } = JSON.parse(res.body);
  assert.equal(totalCount, 2);
  assert.deepEqual(listings.map((l) => l.title), ['A']);
});

function ssrPage(titles, idBase = 1000) {
  const ssr = {
    niobeClientData: [[
      'StaysSearch:x',
      { data: { presentation: { staysSearch: { results: {
        searchResults: titles.map((title, i) => ({
          title,
          demandStayListing: {
            id: Buffer.from('StayListing:' + (idBase + i)).toString('base64'),
            location: { coordinate: { latitude: 1 + i, longitude: 2 + i } },
          },
        })),
        pagination: { totalCount: 100 },
      } } } } },
    ]],
  };
  return `<script id="data-deferred-state-0" type="application/json">${JSON.stringify(ssr)}</script>` + 'x'.repeat(6000);
}

test('POST /search returns nextOffset for a full page, and /last restores per trip', async (t) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, text: async () => ssrPage(Array.from({ length: 18 }, (_, i) => 'Stay ' + i)) });
  t.after(() => { globalThis.fetch = realFetch; });

  const ctx = stubCtx();
  const body = { location: 'Paris', checkin: '2027-01-10', checkout: '2027-01-15', tripId: 55 };
  const res = await route('POST', '/search').handler({ body }, ctx);
  const data = JSON.parse(res.body);
  assert.equal(data.listings.length, 18);
  assert.equal(data.nextOffset, 18);
  assert.deepEqual(data.addedIds, []);

  const last = JSON.parse((await route('GET', '/last').handler({ query: { tripId: '55' } }, ctx)).body);
  assert.equal(last.listings.length, 18);
  assert.equal(last.params.location, 'Paris');
  assert.equal(last.nextOffset, 18);

  const none = JSON.parse((await route('GET', '/last').handler({ query: { tripId: '99' } }, ctx)).body);
  assert.deepEqual(none, {});
});

test('POST /search with an offset merges into the trip\'s last-search cache', async (t) => {
  const realFetch = globalThis.fetch;
  let page = 0;
  globalThis.fetch = async () => {
    // 18 unique listings per page (ids offset by page number)
    const titles = Array.from({ length: 18 }, (_, i) => 'P' + page + '-' + i);
    const html = ssrPage(titles, 1000 + page * 1000);
    page++;
    return { ok: true, text: async () => html };
  };
  t.after(() => { globalThis.fetch = realFetch; });

  const ctx = stubCtx();
  const body = { location: 'Rome', checkin: '2027-01-10', checkout: '2027-01-15', tripId: 77 };
  await route('POST', '/search').handler({ body }, ctx);
  await route('POST', '/search').handler({ body: { ...body, offset: 18 } }, ctx);
  const last = JSON.parse((await route('GET', '/last').handler({ query: { tripId: '77' } }, ctx)).body);
  assert.equal(last.listings.length, 36, 'accumulated across pages');
});

test('POST /add records the listing in the trip\'s added index', async () => {
  const ctx = stubCtx();
  const listing = { title: 'Loft', listingUrl: 'https://www.airbnb.com/rooms/987', lat: 1, lng: 2 };
  await route('POST', '/add').handler({ body: { tripId: 5, listing } }, ctx);
  assert.deepEqual(ctx._metaStore.get('trip:5:added'), { 987: 7 });
});

test('POST /add creates a place and pins meta', async () => {
  const ctx = stubCtx();
  const listing = {
    title: 'Charming loft',
    subtitle: 'Le Marais',
    lat: 48.85,
    lng: 2.35,
    listingUrl: 'https://www.airbnb.com/rooms/987',
    priceTotal: '$1,234',
    priceQualifier: 'total',
    currency: 'USD',
    rating: 4.9,
    reviewsCount: 147,
    beds: 2,
    bedrooms: 1,
    isSuperhost: true,
  };
  const res = await route('POST', '/add').handler(
    { body: { tripId: 1, listing, checkin: '2027-09-10', checkout: '2027-09-15', adults: 2 } },
    ctx
  );
  assert.equal(res.status, 200);
  const { place } = JSON.parse(res.body);
  assert.equal(place.name, 'Charming loft');
  assert.equal(place.price, 1234);
  assert.equal(place.currency, 'USD');
  assert.equal(place.website, 'https://www.airbnb.com/rooms/987');
  const meta = ctx._metaStore.get('place:7:airbnb');
  assert.equal(meta.checkin, '2027-09-10');
  assert.equal(meta.rating, 4.9);
});

test('POST /add surfaces a write failure as an error', async () => {
  const ctx = stubCtx({ places: { create: async () => { throw new Error('PERMISSION_DENIED'); } } });
  const res = await route('POST', '/add').handler(
    { body: { tripId: 1, listing: { title: 'X' } } },
    ctx
  );
  assert.equal(res.status, 502);
  assert.match(JSON.parse(res.body).error, /PERMISSION_DENIED/);
});

test('placeDetailProvider returns rows only when meta exists', async () => {
  const ctx = stubCtx();
  const getDetails = plugin.hooks.placeDetailProvider.getDetails;

  assert.deepEqual(await getDetails(7, ctx), []);

  ctx._metaStore.set('place:7:airbnb', {
    listingUrl: 'https://www.airbnb.com/rooms/987',
    priceTotal: '$1,234',
    priceQualifier: 'total',
    rating: 4.9,
    reviewsCount: 147,
    beds: 2,
    bedrooms: 1,
    isSuperhost: true,
    checkin: '2027-09-10',
    checkout: '2027-09-15',
    adults: 2,
  });
  const rows = await getDetails(7, ctx);
  assert.deepEqual(rows.map((r) => r.label), ['Airbnb', 'Price', 'Rating', 'Sleeps', 'Host']);
  assert.equal(rows[0].url, 'https://www.airbnb.com/rooms/987');
  assert.match(rows[1].value, /\$1,234 total \(2027-09-10 → 2027-09-15, 2 guests\)/);
  assert.equal(rows[2].value, '4.9 ★ (147)');
  assert.equal(rows[3].value, '1 bedroom, 2 beds');
});
