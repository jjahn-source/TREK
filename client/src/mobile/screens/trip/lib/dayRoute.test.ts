import { describe, expect, it } from 'vitest'
import { dayCoMapsUrl, dayExportStops, dayGoogleMapsUrl } from './dayRoute'
import type { Accommodation, Assignment, Day } from '../../../../types'

// FE-MOBILE-DAYROUTE-001 to FE-MOBILE-DAYROUTE-005

const days = [
  { id: 10, day_number: 1 },
  { id: 20, day_number: 2 },
  { id: 30, day_number: 3 },
] as unknown as Day[]

const hotel = {
  place_lat: 48.85, place_lng: 2.35, place_name: 'Hotel Lutetia',
  start_day_id: 10, end_day_id: 30,
} as unknown as Accommodation

const stop = (id: number, name: string, lat: number, lng: number): Assignment =>
  ({ id, day_id: 20, order_index: id, place: { id, name, lat, lng } }) as unknown as Assignment

const louvre = stop(1, 'Louvre', 48.86, 2.34)
const orsay = stop(2, 'Orsay', 48.87, 2.33)

describe('dayExportStops', () => {
  it('FE-MOBILE-DAYROUTE-001: carries the stops in planned order, hotel-bookended and named', () => {
    expect(dayExportStops(days[1], days, [louvre, orsay], [hotel], true)).toEqual([
      { lat: 48.85, lng: 2.35, name: 'Hotel Lutetia' },
      { lat: 48.86, lng: 2.34, name: 'Louvre' },
      { lat: 48.87, lng: 2.33, name: 'Orsay' },
      { lat: 48.85, lng: 2.35, name: 'Hotel Lutetia' },
    ])
  })

  it('FE-MOBILE-DAYROUTE-002: drops the bookends when accommodation optimization is off', () => {
    const stops = dayExportStops(days[1], days, [louvre, orsay], [hotel], false)
    expect(stops.map(s => s.name)).toEqual(['Louvre', 'Orsay'])
  })

  it('FE-MOBILE-DAYROUTE-003: a stop without coordinates cannot be exported', () => {
    const nowhere = { id: 3, day_id: 20, order_index: 3, place: { id: 3, name: 'TBD' } } as unknown as Assignment
    const stops = dayExportStops(days[1], days, [louvre, nowhere], [], false)
    expect(stops.map(s => s.name)).toEqual(['Louvre'])
  })
})

describe('day map links', () => {
  it('FE-MOBILE-DAYROUTE-004: both exports read the same stop list', () => {
    // One source for the bookend rules, so the two links can never disagree
    // about which hotel legs are real.
    const google = dayGoogleMapsUrl(days[1], days, [louvre, orsay], [hotel], true)!
    const coMaps = dayCoMapsUrl(days[1], days, [louvre, orsay], [hotel], true, 'walking')!
    for (const ll of ['48.85,2.35', '48.86,2.34', '48.87,2.33']) {
      expect(google).toContain(ll)
      expect(coMaps).toContain(ll)
    }
  })

  it('FE-MOBILE-DAYROUTE-005: the CoMaps link travels in the mode it was given', () => {
    // Four bookended stops is more than a CoMaps route link can hold, so it
    // becomes pins — which is also why no mode appears here.
    expect(dayCoMapsUrl(days[1], days, [louvre, orsay], [hotel], true, 'walking'))
      .toMatch(/^https:\/\/comaps\.at\/map\?v=1&/)
    // Two stops fit a route, and then the mode does apply.
    expect(dayCoMapsUrl(days[1], days, [louvre, orsay], [], false, 'walking'))
      .toContain('type=pedestrian')
  })
})
