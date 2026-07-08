const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildSearchUrl,
  parseListingDetails,
  extractSsrData,
  parseRatingAndReviews,
  decodeListingId,
  extractCurrency,
  normalizeListing,
  validateDates,
} = require('../server/airbnb');

test('buildSearchUrl slugs "City, Country" with a double dash', () => {
  const url = buildSearchUrl({ location: 'Paris, France', checkin: '2027-01-10', checkout: '2027-01-15', adults: 2 });
  assert.equal(url, 'https://www.airbnb.com/s/Paris--France/homes?checkin=2027-01-10&checkout=2027-01-15&adults=2');
});

test('parseListingDetails extracts top amenities and description snippet', () => {
  const html = `<html><head>
    <script type="application/ld+json">${JSON.stringify({
      "@type": "LodgingBusiness",
      name: 'Charming loft',
      description: 'A lovely stay &amp; more. It is located right in the heart of Paris, making it easy to walk to cafes and museums.',
      amenityFeature: [
        { "@type": "LocationFeatureSpecification", "name": "Wifi" },
        { "@type": "LocationFeatureSpecification", "name": "Pool" },
        { "@type": "LocationFeatureSpecification", "name": "Fire extinguisher" }
      ]
    })}</script></head></html>`;
  const d = parseListingDetails(html);
  assert.deepEqual(d.topAmenities, ['Wifi', 'Pool']);
  assert.equal(d.descriptionSnippet, 'A lovely stay & more. It is located right in the heart of Paris, making it easy to walk to cafes and museums.');
});

test('buildSearchUrl handles multi-word cities', () => {
  const url = buildSearchUrl({ location: 'New York, NY', checkin: '2027-01-10', checkout: '2027-01-15' });
  assert.ok(url.startsWith('https://www.airbnb.com/s/New-York--NY/homes?'));
  assert.ok(url.includes('adults=1'), 'defaults adults to 1');
});

test('buildSearchUrl includes price filters only when set', () => {
  const base = { location: 'Paris', checkin: '2027-01-10', checkout: '2027-01-15' };
  assert.ok(!buildSearchUrl(base).includes('price_min'));
  const url = buildSearchUrl({ ...base, priceMin: 50, priceMax: 300 });
  assert.ok(url.includes('price_min=50'));
  assert.ok(url.includes('price_max=300'));
});

test('buildSearchUrl includes airbnb filter params only when set', () => {
  const base = { location: 'Paris', checkin: '2027-01-10', checkout: '2027-01-15' };
  const plain = buildSearchUrl(base);
  assert.ok(!plain.includes('room_types'));
  assert.ok(!plain.includes('ib='));
  const url = buildSearchUrl({
    ...base,
    roomTypes: ['Entire home/apt'],
    minBedrooms: 2, minBeds: 3, minBathrooms: 1,
    instantBook: true,
  });
  assert.ok(url.includes('room_types%5B%5D=Entire+home%2Fapt'));
  assert.ok(url.includes('min_bedrooms=2'));
  assert.ok(url.includes('min_beds=3'));
  assert.ok(url.includes('min_bathrooms=1'));
  assert.ok(url.includes('ib=true'));
});

test('buildSearchUrl encodes the pagination offset as a base64 cursor', () => {
  const base = { location: 'Paris', checkin: '2027-01-10', checkout: '2027-01-15' };
  assert.ok(!buildSearchUrl(base).includes('cursor='));
  const url = new URL(buildSearchUrl({ ...base, offset: 18 }));
  const cursor = JSON.parse(Buffer.from(url.searchParams.get('cursor'), 'base64').toString());
  assert.deepEqual(cursor, { section_offset: 0, items_offset: 18, version: 1 });
});

test('parseListingDetails reads JSON-LD name/description/images/rating', () => {
  const html = `<html><head>
    <script type="application/ld+json">${JSON.stringify({
      name: 'Charming loft',
      description: 'A lovely stay &amp; more',
      image: ['https://a0.muscache.com/im/1.jpg', 'https://a0.muscache.com/im/2.jpg'],
      aggregateRating: { ratingValue: '4.9', reviewCount: '147' },
    })}</script></head></html>`;
  const d = parseListingDetails(html);
  assert.equal(d.name, 'Charming loft');
  assert.match(d.description, /lovely stay & more/);
  assert.deepEqual(d.images, ['https://a0.muscache.com/im/1.jpg', 'https://a0.muscache.com/im/2.jpg']);
  assert.equal(d.rating, 4.9);
  assert.equal(d.reviewsCount, 147);
});

test('parseListingDetails falls back to og: meta tags', () => {
  const html = `<html><head>
    <meta property="og:title" content="Loft &amp; Co" />
    <meta property="og:description" content="Nice &quot;place&quot;" />
    <meta property="og:image" content="https://a0.muscache.com/im/og.jpg" />
  </head></html>`;
  const d = parseListingDetails(html);
  assert.equal(d.name, 'Loft & Co');
  assert.equal(d.description, 'Nice "place"');
  assert.deepEqual(d.images, ['https://a0.muscache.com/im/og.jpg']);
  assert.equal(d.rating, null);
});

test('parseListingDetails tolerates broken JSON-LD blocks', () => {
  const html = `<script type="application/ld+json">{not json</script>
    <meta property="og:description" content="fallback works" />`;
  assert.equal(parseListingDetails(html).description, 'fallback works');
});

test('buildSearchUrl collapses 3+ dashes but keeps the separator', () => {
  const url = buildSearchUrl({ location: 'Foo - Bar, Baz', checkin: '2027-01-10', checkout: '2027-01-15' });
  assert.ok(url.includes('/s/Foo--Bar--Baz/homes'));
});

test('extractSsrData finds the StaysSearch entry', () => {
  const data = {
    niobeClientData: [
      ['Other:1', {}],
      ['StaysSearch:abc', { data: { presentation: { staysSearch: { results: { searchResults: [], pagination: { totalCount: 0 } } } } } }],
    ],
  };
  const html = `<html><script id="data-deferred-state-0" type="application/json">${JSON.stringify(data)}</script></html>`;
  const results = extractSsrData(html);
  assert.deepEqual(results.pagination, { totalCount: 0 });
});

test('extractSsrData throws when the SSR script is missing', () => {
  assert.throws(() => extractSsrData('<html></html>'), /SSR data not found/);
});

test('parseRatingAndReviews parses the localized format', () => {
  assert.deepEqual(parseRatingAndReviews({ avgRatingLocalized: '4.97 (147)' }), { rating: 4.97, reviewsCount: 147 });
});

test('parseRatingAndReviews falls back to the a11y label', () => {
  assert.deepEqual(
    parseRatingAndReviews({ avgRatingA11yLabel: '4.97 out of 5 average rating, 147 reviews' }),
    { rating: 4.97, reviewsCount: 147 }
  );
});

test('parseRatingAndReviews returns nulls when absent', () => {
  assert.deepEqual(parseRatingAndReviews({}), { rating: null, reviewsCount: null });
});

test('decodeListingId decodes a base64 typed id', () => {
  const encoded = Buffer.from('StayListing:12345678').toString('base64');
  assert.equal(decodeListingId(encoded), '12345678');
});

test('decodeListingId returns null for garbage', () => {
  assert.equal(decodeListingId('not-base64-typed'), null);
});

test('extractCurrency maps $, €, £', () => {
  assert.equal(extractCurrency('$1,234'), 'USD');
  assert.equal(extractCurrency('€89'), 'EUR');
  assert.equal(extractCurrency('£450'), 'GBP');
  assert.equal(extractCurrency('¥9000'), null);
  assert.equal(extractCurrency(''), null);
});

test('normalizeListing distinguishes beds from bedrooms', () => {
  const listing = normalizeListing({
    title: 'Nice flat',
    structuredContent: { primaryLine: [{ body: '2 bedrooms' }, { body: '3 beds' }] },
    demandStayListing: { location: { coordinate: { latitude: 48.85, longitude: 2.35 } } },
  });
  assert.equal(listing.bedrooms, 2);
  assert.equal(listing.beds, 3);
});

test('normalizeListing builds the listing URL from the decoded id', () => {
  const encoded = Buffer.from('StayListing:987', 'utf8').toString('base64');
  const listing = normalizeListing({
    demandStayListing: { id: encoded, location: { coordinate: { latitude: 1, longitude: 2 } } },
  });
  assert.equal(listing.listingUrl, 'https://www.airbnb.com/rooms/987');
});

test('normalizeListing detects the superhost badge', () => {
  const listing = normalizeListing({
    badges: [{ loggingContext: { badgeType: 'SUPERHOST' } }],
    demandStayListing: {},
  });
  assert.equal(listing.isSuperhost, true);
});

test('validateDates rejects bad input', () => {
  assert.throws(() => validateDates('nope', '2027-01-15'), /Invalid date format/);
  assert.throws(() => validateDates('2027-01-15', '2027-01-10'), /after check-in/);
  assert.throws(() => validateDates('2020-01-01', '2020-01-05'), /in the past/);
  assert.doesNotThrow(() => validateDates('2027-01-10', '2027-01-15'));
});

const fixturePath = path.join(__dirname, 'fixtures', 'airbnb-paris-search.html');
test('parses the real Paris fixture end to end', { skip: !fs.existsSync(fixturePath) && 'fixture not present' }, () => {
  const html = fs.readFileSync(fixturePath, 'utf8');
  const results = extractSsrData(html);
  const listings = (results.searchResults || []).map(normalizeListing).filter((l) => l.lat !== 0 && l.lng !== 0);
  assert.ok(listings.length > 0, 'fixture yields listings');
  const first = listings[0];
  assert.ok(first.title.length > 0);
  assert.ok(first.priceTotal.length > 0);
});
