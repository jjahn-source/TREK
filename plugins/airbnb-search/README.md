# Airbnb Search

A TREK **trip-page** plugin: adds an "Airbnb Search" tab inside every trip planner
where you can search Airbnb stays by location, dates and guest count, then add a
listing to the open trip as a place — with its price, rating, bed count and
listing link pinned to the place-detail panel.

![screenshot](docs/screenshot.png)

## What it does

- **Search** airbnb.com for stays (no API key — parses the public search page's
  embedded SSR data). Dates and location pre-fill from the trip; results show
  photos, rating, beds and total + per-night price.
- **Location autocomplete** via OpenStreetMap's Nominatim, with keyboard navigation.
- **Filters**: type of place, price range, bedrooms/beds/baths minimums,
  Instant Book, Superhost only.
- **Pagination**: "Load more" walks Airbnb's cursor-based result pages.
- **Sorting**: relevance, price ↑/↓, rating.
- **Click a result** to expand its full description, photo gallery and rating,
  parsed from the listing's own page (JSON-LD + og fallbacks, cached).
- **Add to trip** creates a place on the trip (name, coordinates, listing URL,
  price + currency) via TREK's membership- and permission-checked plugin API.
  Already-added listings show as "Added ✓" across searches.
- **Search state survives tab switches** — the sandboxed frame is remounted
  every time you leave the tab, so the plugin server remembers your last
  search per trip and restores it.
- **Native detail rows**: a `placeDetailProvider` hook shows the Airbnb link,
  total price for your dates, rating, bedrooms/beds and Superhost status on the
  place — rendered by TREK itself.

## Permissions

| Permission | Why |
|---|---|
| `http:outbound:www.airbnb.com` | fetch search results and listing details |
| `http:outbound:*.muscache.com` | proxy listing photos (the sandboxed frame can't load external images) |
| `http:outbound:nominatim.openstreetmap.org` | location autocomplete |
| `db:read:trips` | pre-fill the search form from the trip's destination/dates |
| `db:write:places` | "Add to trip" (host enforces your `place_edit` permission) |
| `db:meta` | pin listing details on the created place |
| `hook:place-detail-provider` | render those details natively in the place panel |

## Development

```bash
npm install                 # gets trek-plugin-sdk (devDependency)
npm test                    # parser + route/hook tests
npx trek-plugin-sdk dev     # http://localhost:4317 — try /preview
npx trek-plugin-sdk validate
npx trek-plugin-sdk pack    # build plugin.zip for install
```

`dev-fixtures.json` seeds a sample trip so `/defaults` pre-fills in dev.

## Caveats

- Airbnb has no public API; this parses the search page and can break if the
  page structure changes or a bot challenge is served. Errors are shown as
  friendly toasts, never crashes.
- Plugins can't create accommodation *bookings* (no plugin API for that yet) —
  after adding a listing as a place, set it as an accommodation in the planner
  as usual.
