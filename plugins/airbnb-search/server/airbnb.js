// Airbnb search via the public search page's embedded SSR JSON.
// Ported from the fork's server/src/services/airbnbService.ts (commit 4bcbefc6).

function buildSearchUrl(params) {
  const { location, checkin, checkout, adults, priceMin, priceMax } = params;

  // Airbnb's URL slug format:
  // "Paris, France"  →  "Paris--France"
  // "Tokyo, Japan"   →  "Tokyo--Japan"
  // "New York, NY"   →  "New-York--NY"
  const slug = location
    .replace(/, /g, '--')
    .replace(/,/g, '')
    .replace(/ /g, '-')
    .replace(/---+/g, '--'); // collapse 3+ dashes, preserve double-dash separator

  const searchUrl = `https://www.airbnb.com/s/${slug}/homes`;
  const queryParams = new URLSearchParams({
    checkin,
    checkout,
    adults: String(adults ?? 1),
  });
  if (priceMin != null) queryParams.set('price_min', String(priceMin));
  if (priceMax != null) queryParams.set('price_max', String(priceMax));
  for (const rt of params.roomTypes || []) queryParams.append('room_types[]', rt);
  if (params.minBedrooms) queryParams.set('min_bedrooms', String(params.minBedrooms));
  if (params.minBeds) queryParams.set('min_beds', String(params.minBeds));
  if (params.minBathrooms) queryParams.set('min_bathrooms', String(params.minBathrooms));
  if (params.instantBook) queryParams.set('ib', 'true');
  if (params.offset) {
    // Airbnb paginates with a base64 cursor over an items offset.
    const cursor = Buffer.from(
      JSON.stringify({ section_offset: 0, items_offset: params.offset, version: 1 })
    ).toString('base64');
    queryParams.set('cursor', cursor);
  }

  return `${searchUrl}?${queryParams.toString()}`;
}

function extractSsrData(html) {
  // Match the <script id="data-deferred-state-0"> tag
  const match = html.match(
    /<script[^>]*id="data-deferred-state-0"[^>]*>(.*?)<\/script>/s
  );
  if (!match) {
    throw new Error('Airbnb SSR data not found in page');
  }

  const raw = JSON.parse(match[1]);
  const niobe = raw.niobeClientData;

  if (!Array.isArray(niobe) || niobe.length === 0) {
    throw new Error('Unexpected Airbnb data structure');
  }

  // Find the StaysSearch entry in niobeClientData
  const searchEntry = niobe.find(
    (entry) => Array.isArray(entry) && typeof entry[0] === 'string' && entry[0].startsWith('StaysSearch:')
  );

  if (!searchEntry) {
    throw new Error('Airbnb search results not found in page data');
  }

  return searchEntry[1].data.presentation.staysSearch.results;
}

function parseRatingAndReviews(result) {
  // Try avgRatingLocalized first: "5.0 (10)", "4.97 (147)"
  const localized = result.avgRatingLocalized;
  if (typeof localized === 'string') {
    const match = localized.match(/^([\d.]+)\s*\((\d+)\)$/);
    if (match) {
      return {
        rating: parseFloat(match[1]),
        reviewsCount: parseInt(match[2], 10),
      };
    }
  }

  // Fall back to avgRatingA11yLabel: "4.97 out of 5 average rating, 147 reviews"
  const a11yLabel = result.avgRatingA11yLabel;
  if (typeof a11yLabel === 'string') {
    const match = a11yLabel.match(/^([\d.]+)\s+out\s+of\s+5\s+average\s+rating,\s*(\d+)\s+reviews?/i);
    if (match) {
      return {
        rating: parseFloat(match[1]),
        reviewsCount: parseInt(match[2], 10),
      };
    }
  }

  return { rating: null, reviewsCount: null };
}

function decodeListingId(base64Id) {
  try {
    const decoded = Buffer.from(base64Id, 'base64').toString();
    const idMatch = decoded.match(/:(\d+)$/);
    return idMatch ? idMatch[1] : null;
  } catch {
    return null;
  }
}

function extractCurrency(priceStr) {
  if (!priceStr) return null;
  const symbol = priceStr.charAt(0);
  const currencyMap = {
    $: 'USD',
    '€': 'EUR',
    '£': 'GBP',
  };
  return currencyMap[symbol] ?? null;
}

function normalizeListing(result) {
  const demandStay = result.demandStayListing || {};
  const coord = (demandStay.location && demandStay.location.coordinate) || {};
  const price = (result.structuredDisplayPrice && result.structuredDisplayPrice.primaryLine) || {};
  const pictures = result.contextualPictures || [];
  const content = result.structuredContent || {};

  // Extract bedroom/bed count from primaryLine body strings
  let bedrooms = null;
  let beds = null;
  const primaryLines = content.primaryLine || [];
  for (const item of primaryLines) {
    const body = item.body || '';
    const bedroomMatch = body.match(/^(\d+)\s+bedroom/);
    if (bedroomMatch) {
      bedrooms = parseInt(bedroomMatch[1], 10);
    } else {
      const bedMatch = body.match(/^(\d+)\s+bed(?!room)/);
      if (bedMatch) beds = parseInt(bedMatch[1], 10);
    }
  }

  // Check superhost badge
  const badges = result.badges || [];
  const isSuperhost = badges.some(
    (b) => b.loggingContext && b.loggingContext.badgeType === 'SUPERHOST'
  );

  // Parse rating and review count
  const { rating, reviewsCount } = parseRatingAndReviews(result);

  // Build listing URL from decoded demandStay id
  const listingId = demandStay.id ? decodeListingId(demandStay.id) : null;
  const listingUrl = listingId ? `https://www.airbnb.com/rooms/${listingId}` : '';

  // Extract currency from price string
  const priceStr = price.discountedPrice || price.price || '';
  const currency = extractCurrency(priceStr);

  return {
    id: result.propertyId || demandStay.id || '',
    title: result.title || '',
    subtitle: result.subtitle || '',
    priceTotal: price.discountedPrice || price.price || '',
    priceQualifier: price.qualifier || '',
    bedrooms,
    beds,
    lat: coord.latitude || 0,
    lng: coord.longitude || 0,
    photoUrl: (pictures[0] && pictures[0].picture) || '',
    isSuperhost,
    rating,
    reviewsCount,
    listingUrl,
    currency,
  };
}

const AIRBNB_TIMEOUT_MS = 15000;

function validateDates(checkin, checkout) {
  const checkinDate = new Date(checkin + 'T00:00:00Z');
  const checkoutDate = new Date(checkout + 'T00:00:00Z');
  if (isNaN(checkinDate.getTime()) || isNaN(checkoutDate.getTime())) {
    throw new Error('Invalid date format. Use YYYY-MM-DD.');
  }
  if (checkoutDate <= checkinDate) {
    throw new Error('Check-out date must be after check-in date.');
  }
  if (checkinDate < new Date()) {
    throw new Error('Check-in date cannot be in the past.');
  }
}

async function searchAirbnb(params) {
  validateDates(params.checkin, params.checkout);

  const url = buildSearchUrl(params);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(AIRBNB_TIMEOUT_MS),
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    if (response.status === 403 || response.status === 429) {
      throw new Error(
        'Airbnb is not available right now — try a more specific search or use the Airbnb website directly.'
      );
    }
    throw new Error(`Airbnb returned status ${response.status}`);
  }

  const html = await response.text();

  // Detect challenge pages
  if (
    html.includes('_fvb') ||
    html.includes('cf-browser-identity') ||
    html.includes('Just a moment') ||
    html.length < 5000
  ) {
    throw new Error(
      'Airbnb blocked the request — try a more specific search or use the Airbnb website directly.'
    );
  }

  let results;
  try {
    results = extractSsrData(html);
  } catch (err) {
    throw new Error(
      `Could not parse Airbnb results — the page structure may have changed. ${err.message}`
    );
  }

  const searchResults = (results && results.searchResults) || [];
  const totalCount =
    (results && results.pagination && results.pagination.totalCount) ?? searchResults.length;

  const listings = searchResults.map(normalizeListing).filter((l) => l.lat !== 0 && l.lng !== 0);

  return { listings, totalCount, source: 'airbnb' };
}

const HTML_ENTITIES = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>', '&#x27;': "'", '&nbsp;': ' ' };

function decodeHtmlEntities(s) {
  return String(s).replace(/&(?:amp|quot|#39|lt|gt|#x27|nbsp);/g, (m) => HTML_ENTITIES[m] || m);
}

const TOP_AMENITIES = new Set([
  'Wifi', 'Air conditioning', 'Kitchen', 'Pool', 'Hot tub', 'Free parking', 'Washer', 'Dryer', 'Heating', 'Gym'
]);

/**
 * Pull listing details out of a rooms/<id> page: JSON-LD first (name,
 * description, images, aggregate rating), og: meta tags as fallback.
 */
function parseListingDetails(html) {
  const out = { name: '', description: '', images: [], rating: null, reviewsCount: null, topAmenities: [] };

  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs)) {
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    for (const node of Array.isArray(data) ? data : [data]) {
      if (!node || typeof node !== 'object') continue;
      if (!out.name && typeof node.name === 'string') out.name = node.name;
      if (!out.description && typeof node.description === 'string') out.description = node.description;
      const imgs = node.image ? (Array.isArray(node.image) ? node.image : [node.image]) : [];
      out.images.push(...imgs.filter((u) => typeof u === 'string' && u.startsWith('https://')));
      const ar = node.aggregateRating;
      if (ar && out.rating == null) {
        const rating = parseFloat(ar.ratingValue);
        const reviews = parseInt(ar.reviewCount, 10);
        if (Number.isFinite(rating)) out.rating = rating;
        if (Number.isFinite(reviews)) out.reviewsCount = reviews;
      }
      if (node.amenityFeature) {
        const features = Array.isArray(node.amenityFeature) ? node.amenityFeature : [node.amenityFeature];
        for (const feat of features) {
          if (feat && typeof feat.name === 'string' && TOP_AMENITIES.has(feat.name)) {
            out.topAmenities.push(feat.name);
          }
        }
      }
    }
  }

  if (!out.description) {
    const m = html.match(/<meta\s+property="og:description"\s+content="([^"]*)"/);
    if (m) out.description = decodeHtmlEntities(m[1]);
  }
  if (!out.images.length) {
    const m = html.match(/<meta\s+property="og:image"\s+content="([^"]*)"/);
    if (m && m[1].startsWith('https://')) out.images.push(decodeHtmlEntities(m[1]));
  }
  if (!out.name) {
    const m = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/);
    if (m) out.name = decodeHtmlEntities(m[1]);
  }

  out.description = decodeHtmlEntities(out.description).trim().slice(0, 4000);
  out.images = [...new Set(out.images)].slice(0, 8);
  out.topAmenities = [...new Set(out.topAmenities)];

  let snip = out.description.replace(/\s+/g, ' ').trim();
  if (snip.length > 110) {
    snip = snip.substring(0, 107).trim() + '...';
  }
  out.descriptionSnippet = snip;

  return out;
}

async function fetchListingDetails(listingId) {
  const response = await fetch(`https://www.airbnb.com/rooms/${listingId}`, {
    signal: AbortSignal.timeout(AIRBNB_TIMEOUT_MS),
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Airbnb returned status ${response.status}`);
  }
  const html = await response.text();
  if (html.includes('Just a moment') || html.length < 5000) {
    throw new Error('Airbnb blocked the request — open the listing on airbnb.com instead.');
  }
  return parseListingDetails(html);
}

module.exports = {
  buildSearchUrl,
  parseListingDetails,
  fetchListingDetails,
  extractSsrData,
  parseRatingAndReviews,
  decodeListingId,
  extractCurrency,
  normalizeListing,
  validateDates,
  searchAirbnb,
};
