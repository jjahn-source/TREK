// Airbnb Search — a TREK trip-page plugin.
//
// Routes (called from the plugin's own iframe via trek.invoke):
//   GET  /defaults?tripId=N  → { location?, checkin?, checkout? } from the trip
//   POST /search             → { listings, totalCount } from airbnb.com
//   POST /add                → creates a place on the trip + pins Airbnb details in meta
//
// The placeDetailProvider hook surfaces the pinned details as native rows in the
// place-detail panel, so an added listing keeps its price/rating/dates visible.

const { definePlugin } = require('trek-plugin-sdk');
const { searchAirbnb, fetchListingDetails } = require('./airbnb');

const json = { 'content-type': 'application/json' };
const reply = (status, body) => ({ status, headers: json, body: JSON.stringify(body) });

/** "$1,234" / "€89" → 1234 / 89, else null. */
function parsePriceNumber(priceStr) {
  if (!priceStr) return null;
  const digits = String(priceStr).replace(/[^\d.]/g, '');
  const n = parseFloat(digits);
  return Number.isFinite(n) ? n : null;
}

function formatDateRange(checkin, checkout) {
  if (!checkin || !checkout) return '';
  return `${checkin} → ${checkout}`;
}

/** Only Airbnb's image CDN may be proxied — anything else is refused. */
function parsePhotoUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || ''));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (!/(^|\.)muscache\.com$/i.test(url.hostname)) return null;
  url.searchParams.set('im_w', '320'); // Airbnb's imaging service: request a small rendition
  return url;
}

// Tiny in-memory photo cache so scrolling back through results doesn't re-fetch.
const photoCache = new Map();
const PHOTO_CACHE_MAX = 120;
const PHOTO_MAX_BYTES = 512 * 1024;

// Listing-detail cache — a listing's description doesn't change mid-session.
const listingCache = new Map();
const LISTING_CACHE_MAX = 60;

const ROOM_TYPES = new Set(['Entire home/apt', 'Private room', 'Shared room', 'Hotel room']);

function clampInt(v, min, max) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= min ? Math.min(n, max) : null;
}

// Last search per trip — the sandboxed frame loses all state when the user
// switches planner tabs, so the server remembers and /last restores it.
const lastSearch = new Map();
const LAST_SEARCH_MAX = 40;
const PAGE_SIZE = 18;
const MAX_OFFSET = PAGE_SIZE * 15;

function numericListingId(listing) {
  const m = String((listing && listing.listingUrl) || '').match(/\/rooms\/(\d+)/);
  return m ? m[1] : null;
}

/** The trip's map of already-added listings ({ listingId: placeId }), or {}. */
async function addedMapOf(ctx, tripId) {
  try {
    return (await ctx.meta.get('trip', Number(tripId), 'added')) || {};
  } catch {
    return {};
  }
}

module.exports = definePlugin({
  routes: [
    {
      method: 'GET',
      path: '/defaults',
      auth: true,
      async handler(req, ctx) {
        const tripId = Number(req.query && req.query.tripId);
        if (!tripId) return reply(200, {});
        try {
          // Second arg feeds the dev harness; the real host binds the request user and ignores it.
          const trip = await ctx.trips.getById(tripId, req.user && req.user.id);
          if (!trip) return reply(200, {});
          return reply(200, {
            location: trip.destination || trip.location || '',
            checkin: trip.start_date || trip.startDate || '',
            checkout: trip.end_date || trip.endDate || '',
          });
        } catch {
          return reply(200, {});
        }
      },
    },

    {
      // GET /geocode?q=par — location suggestions from Nominatim (OpenStreetMap).
      method: 'GET',
      path: '/geocode',
      auth: true,
      async handler(req) {
        const q = String((req.query && req.query.q) || '').trim();
        if (q.length < 2 || q.length > 200) return reply(200, { suggestions: [] });
        try {
          const url = new URL('https://nominatim.openstreetmap.org/search');
          url.searchParams.set('q', q);
          url.searchParams.set('format', 'jsonv2');
          url.searchParams.set('limit', '5');
          url.searchParams.set('featureType', 'settlement');
          const res = await fetch(url, {
            signal: AbortSignal.timeout(8000),
            headers: {
              // Nominatim's usage policy requires an identifying UA.
              'User-Agent': 'trek-plugin-airbnb-search/1.0 (TREK trip planner plugin)',
              Accept: 'application/json',
            },
          });
          if (!res.ok) return reply(200, { suggestions: [] });
          const rows = await res.json();
          const suggestions = (Array.isArray(rows) ? rows : [])
            .map((r) => r.display_name)
            .filter((s) => typeof s === 'string' && s.length > 0)
            // Nominatim names can be very long ("Paris, Île-de-France, Metropolitan France, France")
            // — keep the first three segments, which is what Airbnb's slug wants anyway.
            .map((s) => s.split(', ').slice(0, 3).join(', '));
          return reply(200, { suggestions: [...new Set(suggestions)] });
        } catch {
          return reply(200, { suggestions: [] }); // autocomplete is best-effort
        }
      },
    },

    {
      // GET /photo?url=… — proxy a listing photo as a data URI (the sandboxed
      // frame's CSP blocks external images; data: is allowed).
      method: 'GET',
      path: '/photo',
      auth: true,
      async handler(req) {
        const url = parsePhotoUrl(req.query && req.query.url);
        if (!url) return reply(400, { error: 'unsupported photo URL' });
        const key = url.toString();
        if (photoCache.has(key)) return reply(200, { dataUri: photoCache.get(key) });
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
          if (!res.ok) return reply(502, { error: `photo fetch failed (${res.status})` });
          const type = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
          if (!type.startsWith('image/')) return reply(502, { error: 'not an image' });
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > PHOTO_MAX_BYTES) return reply(502, { error: 'image too large' });
          const dataUri = `data:${type};base64,${buf.toString('base64')}`;
          if (photoCache.size >= PHOTO_CACHE_MAX) {
            photoCache.delete(photoCache.keys().next().value);
          }
          photoCache.set(key, dataUri);
          return reply(200, { dataUri });
        } catch (err) {
          return reply(502, { error: (err && err.message) || 'photo fetch failed' });
        }
      },
    },

    {
      // GET /last?tripId=N — restore the trip's previous search (params +
      // accumulated results) after the frame was remounted by a tab switch.
      method: 'GET',
      path: '/last',
      auth: true,
      async handler(req, ctx) {
        const tripId = Number((req.query && req.query.tripId) || 0);
        const saved = tripId ? lastSearch.get(tripId) : null;
        if (!saved) return reply(200, {});
        const addedIds = Object.keys(await addedMapOf(ctx, tripId));
        return reply(200, { ...saved, addedIds });
      },
    },

    {
      // GET /listing?id=12345 — description, photos and rating from the
      // listing's own page, for the expandable detail view.
      method: 'GET',
      path: '/listing',
      auth: true,
      async handler(req) {
        const id = String((req.query && req.query.id) || '');
        if (!/^\d{1,20}$/.test(id)) return reply(400, { error: 'invalid listing id' });
        if (listingCache.has(id)) return reply(200, listingCache.get(id));
        try {
          const details = await fetchListingDetails(id);
          if (listingCache.size >= LISTING_CACHE_MAX) {
            listingCache.delete(listingCache.keys().next().value);
          }
          listingCache.set(id, details);
          return reply(200, details);
        } catch (err) {
          return reply(502, { error: (err && err.message) || 'Could not load listing details.' });
        }
      },
    },

    {
      method: 'POST',
      path: '/search',
      auth: true,
      async handler(req, ctx) {
        const {
          location, checkin, checkout, adults, priceMin, priceMax,
          roomType, minBedrooms, minBeds, minBathrooms, instantBook, superhostOnly,
          offset, tripId,
        } = req.body || {};
        if (!location || typeof location !== 'string' || location.length > 200) {
          return reply(400, { error: 'location is required' });
        }
        const dateRe = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRe.test(checkin || '') || !dateRe.test(checkout || '')) {
          return reply(400, { error: 'checkin and checkout must be YYYY-MM-DD' });
        }
        const guests = Math.min(Math.max(parseInt(adults, 10) || 1, 1), 16);
        const min = Number.isFinite(parseInt(priceMin, 10)) && parseInt(priceMin, 10) > 0 ? parseInt(priceMin, 10) : null;
        const max = Number.isFinite(parseInt(priceMax, 10)) && parseInt(priceMax, 10) > 0 ? parseInt(priceMax, 10) : null;
        if (min != null && max != null && max < min) {
          return reply(400, { error: 'Max price must be at least the min price.' });
        }
        const pageOffset = Math.min(clampInt(offset, 0, MAX_OFFSET) ?? 0, MAX_OFFSET);
        try {
          const result = await searchAirbnb({
            location, checkin, checkout, adults: guests,
            priceMin: min ?? undefined, priceMax: max ?? undefined,
            roomTypes: ROOM_TYPES.has(roomType) ? [roomType] : [],
            minBedrooms: clampInt(minBedrooms, 1, 16) ?? undefined,
            minBeds: clampInt(minBeds, 1, 16) ?? undefined,
            minBathrooms: clampInt(minBathrooms, 1, 16) ?? undefined,
            instantBook: instantBook === true,
            offset: pageOffset || undefined,
          });
          const listings = superhostOnly === true
            ? result.listings.filter((l) => l.isSuperhost)
            : result.listings;
          // A full page suggests more exist; a short one is the end.
          const nextOffset =
            result.listings.length >= PAGE_SIZE && pageOffset + PAGE_SIZE < MAX_OFFSET
              ? pageOffset + PAGE_SIZE
              : null;
          const addedIds = tripId ? Object.keys(await addedMapOf(ctx, tripId)) : [];

          // Remember the accumulated results per trip so tab switches restore them.
          if (tripId) {
            const params = {
              location, checkin, checkout, adults: guests,
              priceMin: min, priceMax: max,
              roomType: ROOM_TYPES.has(roomType) ? roomType : '',
              minBedrooms: clampInt(minBedrooms, 1, 16), minBeds: clampInt(minBeds, 1, 16),
              minBathrooms: clampInt(minBathrooms, 1, 16),
              instantBook: instantBook === true, superhostOnly: superhostOnly === true,
            };
            const prev = pageOffset > 0 ? lastSearch.get(Number(tripId)) : null;
            const seen = new Set((prev ? prev.listings : []).map((l) => l.id));
            const merged = prev
              ? prev.listings.concat(listings.filter((l) => !seen.has(l.id)))
              : listings;
            if (lastSearch.size >= LAST_SEARCH_MAX && !lastSearch.has(Number(tripId))) {
              lastSearch.delete(lastSearch.keys().next().value);
            }
            const totalCount = Math.max(result.totalCount, prev ? prev.totalCount : 0, merged.length);
            lastSearch.set(Number(tripId), { params, listings: merged, totalCount, nextOffset });
          }

          return reply(200, { listings, totalCount: result.totalCount, nextOffset, addedIds });
        } catch (err) {
          const message = (err && err.message) || 'Airbnb search failed.';
          // Validation messages read fine as-is; upstream/parse failures are a 502.
          const status = /date/i.test(message) ? 400 : 502;
          return reply(status, { error: message });
        }
      },
    },

    {
      method: 'POST',
      path: '/add',
      auth: true,
      async handler(req, ctx) {
        const { tripId, listing, checkin, checkout, adults } = req.body || {};
        if (!tripId || !listing || !listing.title) {
          return reply(400, { error: 'tripId and listing are required' });
        }
        try {
          const place = await ctx.places.create(Number(tripId), {
            name: String(listing.title).slice(0, 200),
            lat: listing.lat,
            lng: listing.lng,
            website: listing.listingUrl || undefined,
            price: parsePriceNumber(listing.priceTotal) ?? undefined,
            currency: listing.currency || undefined,
            notes: listing.subtitle || undefined,
          });
          const listingId = numericListingId(listing);
          if (listingId) {
            const added = await addedMapOf(ctx, tripId);
            added[listingId] = place.id;
            await ctx.meta.set('trip', Number(tripId), 'added', added);
          }
          await ctx.meta.set('place', place.id, 'airbnb', {
            listingUrl: listing.listingUrl || '',
            priceTotal: listing.priceTotal || '',
            priceQualifier: listing.priceQualifier || '',
            rating: listing.rating ?? null,
            reviewsCount: listing.reviewsCount ?? null,
            beds: listing.beds ?? null,
            bedrooms: listing.bedrooms ?? null,
            isSuperhost: !!listing.isSuperhost,
            checkin: checkin || '',
            checkout: checkout || '',
            adults: adults || null,
          });
          return reply(200, { place });
        } catch (err) {
          const message = (err && err.message) || 'Could not add the listing to the trip.';
          return reply(502, { error: message });
        }
      },
    },
  ],

  hooks: {
    placeDetailProvider: {
      async getDetails(placeId, ctx) {
        const info = await ctx.meta.get('place', placeId, 'airbnb');
        if (!info) return [];
        const rows = [];
        if (info.listingUrl) rows.push({ label: 'Airbnb', url: info.listingUrl });
        if (info.priceTotal) {
          const range = formatDateRange(info.checkin, info.checkout);
          const guests = info.adults ? `${info.adults} guest${info.adults > 1 ? 's' : ''}` : '';
          const detail = [range, guests].filter(Boolean).join(', ');
          rows.push({
            label: 'Price',
            value: `${info.priceTotal} ${info.priceQualifier || ''}${detail ? ` (${detail})` : ''}`.trim(),
          });
        }
        if (info.rating != null) {
          rows.push({
            label: 'Rating',
            value: `${info.rating} ★${info.reviewsCount != null ? ` (${info.reviewsCount})` : ''}`,
          });
        }
        const sleeps = [
          info.bedrooms != null ? `${info.bedrooms} bedroom${info.bedrooms === 1 ? '' : 's'}` : null,
          info.beds != null ? `${info.beds} bed${info.beds === 1 ? '' : 's'}` : null,
        ].filter(Boolean);
        if (sleeps.length) rows.push({ label: 'Sleeps', value: sleeps.join(', ') });
        if (info.isSuperhost) rows.push({ label: 'Host', value: 'Superhost' });
        return rows;
      },
    },
  },
});
