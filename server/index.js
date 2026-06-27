import cors from 'cors'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
const distDir = path.join(rootDir, 'dist')

const PORT = Number(process.env.PORT ?? 8787)
const NOMINATIM_BASE_URL =
  process.env.NOMINATIM_BASE_URL ?? 'https://nominatim.openstreetmap.org'
const OSRM_BASE_URL =
  process.env.OSRM_BASE_URL ?? 'https://router.project-osrm.org'
const OVERPASS_BASE_URL =
  process.env.OVERPASS_BASE_URL ?? 'https://overpass-api.de/api/interpreter'
const USER_AGENT =
  process.env.APP_USER_AGENT ??
  'tsp-route-optimizer/1.1 (local development; open-source routing demo)'
const MAX_STORES = 10
const MAX_CANDIDATES_PER_STORE = 3
const MAX_SEARCH_RADIUS_DEGREES = 0.35
const MAX_STORE_SEARCH_DISTANCE_MILES = 25

const app = express()
const geocodeCache = new Map()
const storeSearchCache = new Map()

app.use(cors())
app.use(express.json({ limit: '1mb' }))

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    routingProvider: 'osrm',
    geocoder: 'nominatim',
  })
})

app.post('/api/resolve-address', async (req, res) => {
  try {
    const address = cleanString(req.body?.address)

    if (!address) {
      throw new Error('Address is required.')
    }

    const result = await geocodeAddress(address)
    res.json({
      input: address,
      resolvedAddress: result.displayName,
      lat: result.lat,
      lon: result.lon,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    res.status(400).json({ error: message })
  }
})

app.post('/api/optimize', async (req, res) => {
  try {
    const payload = validateRequest(req.body)
    const geocodedPlan = await geocodePlan(payload)
    const matrix = await buildMatrix(geocodedPlan.points)
    const solution = solveExactRoute({
      matrix,
      points: geocodedPlan.points,
      stores: geocodedPlan.stores,
    })
    const route = await hydrateRoute(solution.bestPath)

    res.json({
      start: geocodedPlan.start,
      end: geocodedPlan.end,
      stores: geocodedPlan.stores,
      summary: {
        totalDurationSeconds: solution.totalDurationSeconds,
        totalDistanceMeters: route.totalDistanceMeters,
        permutationsChecked: solution.permutationsChecked,
        exactAlgorithm: 'dynamic-programming-over-store-subsets',
      },
      orderedStops: solution.bestPath,
      legs: route.legs,
      geometry: route.geometry,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    res.status(400).json({ error: message })
  }
})

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir))

  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

app.listen(PORT, () => {
  console.log(`Route optimizer server listening on http://localhost:${PORT}`)
})

function validateRequest(body) {
  if (!body || typeof body !== 'object') {
    throw new Error('Request body is required.')
  }

  const startAddress = cleanString(body.startAddress)
  const endAddress = cleanString(body.endAddress)

  if (!startAddress) {
    throw new Error('Start address is required.')
  }

  if (!endAddress) {
    throw new Error('End address is required.')
  }

  if (!Array.isArray(body.stores) || body.stores.length === 0) {
    throw new Error('At least one store is required.')
  }

  if (body.stores.length > MAX_STORES) {
    throw new Error(`Keep the store count at ${MAX_STORES} or fewer for exact optimization.`)
  }

  const stores = body.stores.map((store, storeIndex) => {
    const name = cleanString(store?.name)
    const fixedAddress = cleanString(store?.fixedAddress)

    if (!name && !fixedAddress) {
      throw new Error(`Store ${storeIndex + 1} needs a store name or fixed address.`)
    }

    return {
      id: `store-${storeIndex + 1}`,
      name: name || `Stop ${storeIndex + 1}`,
      fixedAddress,
    }
  })

  return { startAddress, endAddress, stores }
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

async function geocodePlan(payload) {
  const start = await geocodeAddress(payload.startAddress)
  const end = await geocodeAddress(payload.endAddress)
  const bounds = buildSearchBounds(start, end)
  const points = [
    {
      pointId: 'start',
      label: 'Start',
      address: start.displayName,
      lat: start.lat,
      lon: start.lon,
      kind: 'start',
    },
  ]
  const stores = []

  for (let storeIndex = 0; storeIndex < payload.stores.length; storeIndex += 1) {
    const store = payload.stores[storeIndex]
    const candidates = store.fixedAddress
      ? [await geocodeFixedStoreLocation(store, storeIndex)]
      : await findStoreCandidates({
          name: store.name,
          storeId: store.id,
          storeIndex,
          bounds,
          start,
          end,
        })

    if (candidates.length === 0) {
      throw new Error(
        `No likely locations found for "${store.name}" near the trip area. Try a more specific store name.`,
      )
    }

    points.push(...candidates)
    stores.push({
      ...store,
      candidates,
    })
  }

  points.push({
    pointId: 'end',
    label: 'End',
    address: end.displayName,
    lat: end.lat,
    lon: end.lon,
    kind: 'end',
  })

  return {
    start: points[0],
    end: points[points.length - 1],
    stores,
    points,
  }
}

async function geocodeFixedStoreLocation(store, storeIndex) {
  const resolved = await geocodeAddress(store.fixedAddress)

  return {
    pointId: `${store.id}-location-1`,
    label: `${store.name} 1`,
    storeId: store.id,
    storeName: store.name,
    storeIndex,
    locationIndex: 0,
    address: resolved.displayName,
    lat: resolved.lat,
    lon: resolved.lon,
    kind: 'store',
  }
}

async function geocodeAddress(address) {
  const cacheKey = `address:${address.toLowerCase()}`

  if (geocodeCache.has(cacheKey)) {
    return geocodeCache.get(cacheKey)
  }

  const results = await searchNominatim({
    q: address,
    limit: 1,
    addressdetails: '1',
  })

  if (results.length === 0) {
    throw new Error(`No geocoding match found for "${address}".`)
  }

  const best = normalizePlace(results[0])
  geocodeCache.set(cacheKey, best)
  return best
}

async function findStoreCandidates({ name, storeId, storeIndex, bounds, start, end }) {
  const cacheKey = JSON.stringify({ name: name.toLowerCase(), bounds })

  if (storeSearchCache.has(cacheKey)) {
    return storeSearchCache.get(cacheKey)
  }

  const overpassResults = await searchOverpassStoreLocations({ name, start, end })
  const startSearchBounds = buildStartSearchBounds(start)

  const searchPlans = [
    {
      q: name,
      limit: 18,
      addressdetails: '1',
      bounded: '1',
      viewbox: `${startSearchBounds.west},${startSearchBounds.north},${startSearchBounds.east},${startSearchBounds.south}`,
    },
    {
      q: `${name} near ${extractLocality(start.displayName)}`,
      limit: 18,
      addressdetails: '1',
      bounded: '1',
      viewbox: `${startSearchBounds.west},${startSearchBounds.north},${startSearchBounds.east},${startSearchBounds.south}`,
    },
  ]

  const aggregatedResults = []
  aggregatedResults.push(...overpassResults)

  for (const plan of searchPlans) {
    const results = await searchNominatim(plan)
    aggregatedResults.push(...results)
  }

  const rankedCandidates = rankStoreCandidates({
    results: aggregatedResults,
    name,
    storeId,
    storeIndex,
    start,
    end,
    enforceDistanceLimit: true,
  })

  const uniqueCandidates = rankedCandidates.slice(0, MAX_CANDIDATES_PER_STORE)

  storeSearchCache.set(cacheKey, uniqueCandidates)
  return uniqueCandidates
}

async function searchOverpassStoreLocations({ name, start, end }) {
  const radiusMeters = Math.round(MAX_STORE_SEARCH_DISTANCE_MILES * 1609.344)
  const escapedName = escapeOverpassString(name)
  const query = `
[out:json][timeout:25];
(
  nwr["name"="${escapedName}"]["shop"](around:${radiusMeters},${start.lat},${start.lon});
  nwr["name"="${escapedName}"]["amenity"](around:${radiusMeters},${start.lat},${start.lon});
  nwr["name"="${escapedName}"]["brand"](around:${radiusMeters},${start.lat},${start.lon});
  nwr["brand"="${escapedName}"](around:${radiusMeters},${start.lat},${start.lon});
  nwr["name"~"^${escapeOverpassRegex(name)}$",i](around:${radiusMeters},${start.lat},${start.lon});
);
out center tags;
`.trim()

  const response = await fetch(OVERPASS_BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      'User-Agent': USER_AGENT,
    },
    body: query,
  })

  if (!response.ok) {
    return []
  }

  const data = await response.json()
  await sleep(1100)

  if (!Array.isArray(data.elements)) {
    return []
  }

  return data.elements
    .map((element) => normalizeOverpassPlace(element))
    .filter(Boolean)
}

function rankStoreCandidates({
  results,
  name,
  storeId,
  storeIndex,
  start,
  end,
  enforceDistanceLimit,
}) {
  const normalizedQuery = simplifyText(name)
  const seenAddresses = new Set()
  const scored = []

  for (const result of results) {
    const normalized = normalizePlace(result)
    const displayName = normalized.displayName
    const simplifiedDisplayName = simplifyText(displayName)
    const categoryText = `${result.class ?? result.rawClass ?? ''} ${result.type ?? result.rawType ?? ''}`.toLowerCase()
    const nameMatch = simplifiedDisplayName.includes(normalizedQuery)
    const tokenMatch = allTokensPresent(normalizedQuery, simplifiedDisplayName)
    const exactNameMatch = simplifiedDisplayName.startsWith(normalizedQuery)
    const categoryMatch =
      /shop|amenity|supermarket|department_store|convenience|grocery|mall|retail|bakery|coffee/.test(
        categoryText,
      )

    if (!nameMatch && !tokenMatch) {
      continue
    }

    if (seenAddresses.has(displayName)) {
      continue
    }

    const distanceToStart = haversineMiles(start, normalized)
    const distanceToEnd = haversineMiles(end, normalized)
    const minimumTripDistance = distanceToStart

    if (enforceDistanceLimit && minimumTripDistance > MAX_STORE_SEARCH_DISTANCE_MILES) {
      continue
    }

    seenAddresses.add(displayName)

    const score =
      (exactNameMatch ? 0 : nameMatch ? 4 : 10) +
      distanceToStart * 8 +
      distanceToEnd * 0.25 +
      (categoryMatch ? 0 : 2)

    scored.push({
      score,
      candidate: {
        pointId: `${storeId}-location-${scored.length + 1}`,
        label: `${name} ${scored.length + 1}`,
        storeId,
        storeName: name,
        storeIndex,
        locationIndex: scored.length,
        address: displayName,
        lat: normalized.lat,
        lon: normalized.lon,
        kind: 'store',
      },
    })
  }

  scored.sort((left, right) => left.score - right.score)

  return scored.map(({ candidate }, index) => ({
    ...candidate,
    pointId: `${storeId}-location-${index + 1}`,
    label: `${name} ${index + 1}`,
    locationIndex: index,
  }))
}

async function searchNominatim(parameters) {
  const url = new URL('/search', NOMINATIM_BASE_URL)
  url.searchParams.set('format', 'jsonv2')
  url.searchParams.set('limit', String(parameters.limit ?? 1))
  url.searchParams.set('dedupe', '1')

  for (const [key, value] of Object.entries(parameters)) {
    if (key === 'limit' || value === undefined || value === null || value === '') {
      continue
    }

    url.searchParams.set(key, String(value))
  }

  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'en',
    },
  })

  if (!response.ok) {
    throw new Error('Failed to query the geocoding service.')
  }

  const results = await response.json()
  await sleep(1100)
  return Array.isArray(results) ? results : []
}

function normalizePlace(place) {
  return {
    lat: Number(place.lat),
    lon: Number(place.lon),
    displayName: place.display_name ?? place.displayName ?? '',
    rawClass: place.class ?? place.rawClass ?? '',
    rawType: place.type ?? place.rawType ?? '',
  }
}

function normalizeOverpassPlace(element) {
  const lat = Number(element.lat ?? element.center?.lat)
  const lon = Number(element.lon ?? element.center?.lon)
  const tags = element.tags ?? {}

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null
  }

  const displayNameParts = [
    tags.name,
    tags['addr:housenumber'],
    tags['addr:street'],
    tags['addr:city'],
    tags['addr:state'],
    tags['addr:postcode'],
    tags['addr:country'],
  ].filter(Boolean)

  return {
    lat,
    lon,
    displayName: displayNameParts.join(', '),
    rawClass: tags.shop || tags.amenity || '',
    rawType: tags.brand || tags.name || '',
  }
}

function simplifyText(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function allTokensPresent(query, text) {
  const tokens = query.split(' ').filter(Boolean)
  return tokens.length > 0 && tokens.every((token) => text.includes(token))
}

function extractLocality(displayName) {
  return displayName.split(',').slice(-5, -2).join(',').trim() || displayName
}

function haversineMiles(fromPoint, toPoint) {
  const earthRadiusMiles = 3958.8
  const latDelta = toRadians(toPoint.lat - fromPoint.lat)
  const lonDelta = toRadians(toPoint.lon - fromPoint.lon)
  const fromLat = toRadians(fromPoint.lat)
  const toLat = toRadians(toPoint.lat)
  const a =
    Math.sin(latDelta / 2) ** 2 +
    Math.cos(fromLat) * Math.cos(toLat) * Math.sin(lonDelta / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return earthRadiusMiles * c
}

function toRadians(value) {
  return (value * Math.PI) / 180
}

function escapeOverpassString(value) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function escapeOverpassRegex(value) {
  return value
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+')
}

function buildSearchBounds(start, end) {
  const latPadding = Math.min(Math.max(Math.abs(start.lat - end.lat) * 0.6, 0.08), MAX_SEARCH_RADIUS_DEGREES)
  const lonPadding = Math.min(Math.max(Math.abs(start.lon - end.lon) * 0.6, 0.08), MAX_SEARCH_RADIUS_DEGREES)
  const north = Math.max(start.lat, end.lat) + latPadding
  const south = Math.min(start.lat, end.lat) - latPadding
  const east = Math.max(start.lon, end.lon) + lonPadding
  const west = Math.min(start.lon, end.lon) - lonPadding

  return { north, south, east, west }
}

function buildStartSearchBounds(start) {
  const latPadding = 0.22
  const lonPadding = 0.22

  return {
    north: start.lat + latPadding,
    south: start.lat - latPadding,
    east: start.lon + lonPadding,
    west: start.lon - lonPadding,
  }
}

async function buildMatrix(points) {
  const coordinates = points.map((point) => `${point.lon},${point.lat}`).join(';')
  const url = new URL(`/table/v1/driving/${coordinates}`, OSRM_BASE_URL)
  url.searchParams.set('annotations', 'duration,distance')

  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
  })

  if (!response.ok) {
    throw new Error('Failed to fetch travel-time matrix from the routing service.')
  }

  const data = await response.json()

  if (!Array.isArray(data.durations) || !Array.isArray(data.distances)) {
    throw new Error('Routing service did not return a usable duration matrix.')
  }

  return {
    durations: data.durations,
    distances: data.distances,
  }
}

function solveExactRoute({ matrix, points, stores }) {
  const pointById = new Map(points.map((point, index) => [point.pointId, { point, index }]))
  const startIndex = 0
  const endIndex = points.length - 1
  const storeCount = stores.length
  const fullMask = (1 << storeCount) - 1
  const dp = new Map()
  const choiceMap = new Map()

  for (const store of stores) {
    for (const candidate of store.candidates) {
      const candidateIndex = pointById.get(candidate.pointId).index
      const mask = 1 << candidate.storeIndex
      const duration = matrix.durations[startIndex][candidateIndex]
      ensureFinite(duration, points[startIndex], candidate)
      const key = makeKey(mask, candidate.pointId)
      dp.set(key, duration)
      choiceMap.set(key, null)
    }
  }

  for (let visitedMask = 1; visitedMask <= fullMask; visitedMask += 1) {
    for (const store of stores) {
      for (const candidate of store.candidates) {
        const currentKey = makeKey(visitedMask, candidate.pointId)

        if (!dp.has(currentKey)) {
          continue
        }

        const currentCost = dp.get(currentKey)
        const currentIndex = pointById.get(candidate.pointId).index

        for (const nextStore of stores) {
          if ((visitedMask & (1 << nextStore.candidates[0].storeIndex)) !== 0) {
            continue
          }

          for (const nextCandidate of nextStore.candidates) {
            const nextIndex = pointById.get(nextCandidate.pointId).index
            const legDuration = matrix.durations[currentIndex][nextIndex]
            ensureFinite(legDuration, candidate, nextCandidate)
            const nextMask = visitedMask | (1 << nextCandidate.storeIndex)
            const nextKey = makeKey(nextMask, nextCandidate.pointId)
            const nextCost = currentCost + legDuration

            if (!dp.has(nextKey) || nextCost < dp.get(nextKey)) {
              dp.set(nextKey, nextCost)
              choiceMap.set(nextKey, {
                previousMask: visitedMask,
                previousPointId: candidate.pointId,
              })
            }
          }
        }
      }
    }
  }

  let bestDuration = Number.POSITIVE_INFINITY
  let bestEndPointId = ''

  for (const store of stores) {
    for (const candidate of store.candidates) {
      const candidateIndex = pointById.get(candidate.pointId).index
      const key = makeKey(fullMask, candidate.pointId)

      if (!dp.has(key)) {
        continue
      }

      const endLegDuration = matrix.durations[candidateIndex][endIndex]
      ensureFinite(endLegDuration, candidate, points[endIndex])
      const totalDuration = dp.get(key) + endLegDuration

      if (totalDuration < bestDuration) {
        bestDuration = totalDuration
        bestEndPointId = candidate.pointId
      }
    }
  }

  if (!Number.isFinite(bestDuration) || !bestEndPointId) {
    throw new Error('Unable to find a complete route through all requested stores.')
  }

  const orderedStops = []
  let currentMask = fullMask
  let currentPointId = bestEndPointId

  while (currentPointId) {
    const { point } = pointById.get(currentPointId)
    orderedStops.push(point)
    const previous = choiceMap.get(makeKey(currentMask, currentPointId))

    if (!previous) {
      break
    }

    currentMask = previous.previousMask
    currentPointId = previous.previousPointId
  }

  orderedStops.reverse()
  orderedStops.unshift(points[startIndex])
  orderedStops.push(points[endIndex])

  return {
    totalDurationSeconds: bestDuration,
    bestPath: orderedStops,
    permutationsChecked:
      factorial(stores.length) *
      stores.reduce((total, store) => total * store.candidates.length, 1),
  }
}

function ensureFinite(value, fromPoint, toPoint) {
  if (Number.isFinite(value)) {
    return
  }

  throw new Error(
    `No drivable route found between "${fromPoint.address}" and "${toPoint.address}".`,
  )
}

function makeKey(mask, pointId) {
  return `${mask}:${pointId}`
}

async function hydrateRoute(points) {
  const legs = []
  const geometry = []
  let totalDistanceMeters = 0

  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index]
    const to = points[index + 1]
    const coordinates = `${from.lon},${from.lat};${to.lon},${to.lat}`
    const url = new URL(`/route/v1/driving/${coordinates}`, OSRM_BASE_URL)
    url.searchParams.set('overview', 'full')
    url.searchParams.set('steps', 'true')
    url.searchParams.set('geometries', 'geojson')

    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
    })

    if (!response.ok) {
      throw new Error('Failed to fetch leg geometry from the routing service.')
    }

    const data = await response.json()
    const route = data.routes?.[0]

    if (!route) {
      throw new Error('Routing service could not return the selected route.')
    }

    const coordinatesList = route.geometry?.coordinates ?? []
    const latLngGeometry = coordinatesList.map(([lon, lat]) => [lat, lon])
    totalDistanceMeters += route.distance ?? 0

    if (index === 0) {
      geometry.push(...latLngGeometry)
    } else {
      geometry.push(...latLngGeometry.slice(1))
    }

    legs.push({
      from: {
        label: from.label,
        address: from.address,
      },
      to: {
        label: to.kind === 'store' ? to.storeName : to.label,
        address: to.address,
      },
      durationSeconds: route.duration,
      distanceMeters: route.distance,
      summary: route.legs?.[0]?.summary ?? '',
    })
  }

  return {
    legs,
    geometry,
    totalDistanceMeters,
  }
}

function factorial(value) {
  let total = 1

  for (let index = 2; index <= value; index += 1) {
    total *= index
  }

  return total
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}
