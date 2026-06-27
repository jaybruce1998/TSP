import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { MapContainer, Marker, Polyline, Popup, TileLayer } from 'react-leaflet'
import './App.css'
import type { OptimizationResponse, ResolvedAddressResponse, StoreInput } from './types'

const initialStores: StoreInput[] = [
  { id: crypto.randomUUID(), name: 'Trader Joe\'s', fixedAddress: '', resolvedLocation: null, isPinned: false },
  { id: crypto.randomUUID(), name: 'Target', fixedAddress: '', resolvedLocation: null, isPinned: false },
]

function App() {
  const [startAddress, setStartAddress] = useState('250 W 19th St, New York, NY 10011')
  const [endAddress, setEndAddress] = useState('250 W 19th St, New York, NY 10011')
  const [stores, setStores] = useState<StoreInput[]>(initialStores)
  const [result, setResult] = useState<OptimizationResponse | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [fixingStart, setFixingStart] = useState(false)
  const [fixingEnd, setFixingEnd] = useState(false)
  const [resolvedStart, setResolvedStart] = useState<ResolvedAddressResponse | null>(null)
  const [resolvedEnd, setResolvedEnd] = useState<ResolvedAddressResponse | null>(null)

  const mapCenter = useMemo<[number, number]>(() => {
    if (result?.geometry.length) {
      return result.geometry[0]
    }

    if (resolvedStart) {
      return [resolvedStart.lat, resolvedStart.lon]
    }

    if (resolvedEnd) {
      return [resolvedEnd.lat, resolvedEnd.lon]
    }

    return [40.741, -73.99]
  }, [result, resolvedEnd, resolvedStart])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true)
    setError('')

    try {
      const response = await fetch('/api/optimize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          startAddress,
          endAddress,
          stores,
        }),
      })
      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error ?? 'Failed to optimize route.')
      }

      setResult(data)
      setStartAddress(data.start.address)
      setEndAddress(data.end.address)
      setResolvedStart({
        input: data.start.address,
        resolvedAddress: data.start.address,
        lat: data.start.lat,
        lon: data.start.lon,
      })
      setResolvedEnd({
        input: data.end.address,
        resolvedAddress: data.end.address,
        lat: data.end.lat,
        lon: data.end.lon,
      })
    } catch (submissionError) {
      const message =
        submissionError instanceof Error
          ? submissionError.message
          : 'Failed to optimize route.'
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  async function resolveAddress(kind: 'start' | 'end') {
    const address = kind === 'start' ? startAddress : endAddress
    const setBusy = kind === 'start' ? setFixingStart : setFixingEnd
    const setAddress = kind === 'start' ? setStartAddress : setEndAddress
    setBusy(true)
    setError('')

    try {
      const response = await fetch('/api/resolve-address', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ address }),
      })
      const data: ResolvedAddressResponse & { error?: string } = await response.json()

      if (!response.ok) {
        throw new Error(data.error ?? 'Failed to resolve address.')
      }

      setAddress(data.resolvedAddress)
      if (kind === 'start') {
        setResolvedStart(data)
      } else {
        setResolvedEnd(data)
      }
    } catch (resolutionError) {
      const message =
        resolutionError instanceof Error ? resolutionError.message : 'Failed to resolve address.'
      setError(message)
    } finally {
      setBusy(false)
    }
  }

  function updateStoreName(storeId: string, name: string) {
    setStores((currentStores) =>
      currentStores.map((store) => (store.id === storeId ? { ...store, name } : store)),
    )
  }

  function updateStoreFixedAddress(storeId: string, fixedAddress: string) {
    setStores((currentStores) =>
      currentStores.map((store) =>
        store.id === storeId ? { ...store, fixedAddress, isPinned: false } : store,
      ),
    )
  }

  async function fixStoreAddress(storeId: string) {
    const store = stores.find((entry) => entry.id === storeId)

    if (!store) {
      return
    }

    const address = (store.fixedAddress || store.name).trim()

    if (!address) {
      setError('Enter a store name or address before fixing this stop.')
      return
    }

    setLoading(true)
    setError('')

    try {
      const response = await fetch('/api/resolve-address', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ address }),
      })
      const data: ResolvedAddressResponse & { error?: string } = await response.json()

      if (!response.ok) {
        throw new Error(data.error ?? 'Failed to resolve store address.')
      }

      setStores((currentStores) =>
        currentStores.map((entry) =>
          entry.id === storeId
            ? {
                ...entry,
                fixedAddress: data.resolvedAddress,
                resolvedLocation: data,
                isPinned: true,
              }
            : entry,
        ),
      )
    } catch (resolutionError) {
      const message =
        resolutionError instanceof Error
          ? resolutionError.message
          : 'Failed to resolve store address.'
      setError(message)
    } finally {
      setLoading(false)
    }
  }

  function clearPinnedStore(storeId: string) {
    setStores((currentStores) =>
      currentStores.map((store) =>
        store.id === storeId
          ? {
              ...store,
              isPinned: false,
              resolvedLocation: null,
            }
          : store,
      ),
    )
  }

  function addStore() {
    setStores((currentStores) => [
      ...currentStores,
      {
        id: crypto.randomUUID(),
        name: `Store ${currentStores.length + 1}`,
        fixedAddress: '',
        resolvedLocation: null,
        isPinned: false,
      },
    ])
  }

  function removeStore(storeId: string) {
    setStores((currentStores) => currentStores.filter((store) => store.id !== storeId))
  }

  function copyStartToEnd() {
    setEndAddress(startAddress)

    if (resolvedStart) {
      setResolvedEnd({
        ...resolvedStart,
        input: resolvedStart.resolvedAddress,
      })
    }
  }

  return (
    <div className="shell">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Exact multi-store route planning</p>
          <h1>Give the app store names and it will choose the best locations for the route.</h1>
          <p className="lede">
            Start and end are resolved into valid addresses, store candidates are discovered
            automatically near the trip area, and the final route is optimized for driving time.
          </p>
        </div>
        <div className="hero-note">
          <p>Run locally</p>
          <strong>npm run dev</strong>
        </div>
      </section>

      <main className="workspace">
        <form className="planner-card" onSubmit={handleSubmit}>
          <div className="section-heading">
            <h2>Trip setup</h2>
            <p>Enter start and end addresses plus store names only.</p>
          </div>

          <div className="address-card">
            <label className="field">
              <span>Start address</span>
              <textarea
                value={startAddress}
                onChange={(event) => setStartAddress(event.target.value)}
                rows={2}
                required
              />
            </label>
            <div className="mini-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => resolveAddress('start')}
                disabled={fixingStart || loading}
              >
                {fixingStart ? 'Fixing start...' : 'Fix start address'}
              </button>
            </div>
          </div>

          <div className="address-card">
            <label className="field">
              <span>End address</span>
              <textarea
                value={endAddress}
                onChange={(event) => setEndAddress(event.target.value)}
                rows={2}
                required
              />
            </label>
            <div className="mini-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => resolveAddress('end')}
                disabled={fixingEnd || loading}
              >
                {fixingEnd ? 'Fixing end...' : 'Fix end address'}
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={copyStartToEnd}
                disabled={loading}
              >
                Use start as end
              </button>
            </div>
          </div>

          <div className="stores-header">
            <div>
              <h2>Stores</h2>
              <p>The backend finds candidate locations for each store name.</p>
            </div>
            <button type="button" className="secondary-button" onClick={addStore}>
              Add store
            </button>
          </div>

          <div className="stores-list">
            {stores.map((store, storeIndex) => (
              <article className="store-card" key={store.id}>
                <div className="store-card-header">
                  <label className="field grow">
                    <span>{store.isPinned ? 'Stop label' : 'Store name'}</span>
                    <input
                      value={store.name}
                      onChange={(event) => updateStoreName(store.id, event.target.value)}
                      placeholder="Example: Costco, Walgreens, Whole Foods"
                      required
                    />
                  </label>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => removeStore(store.id)}
                    disabled={stores.length === 1}
                  >
                    Remove
                  </button>
                </div>
                <label className="field">
                  <span>Optional fixed address</span>
                  <input
                    value={store.fixedAddress ?? ''}
                    onChange={(event) => updateStoreFixedAddress(store.id, event.target.value)}
                    placeholder="Leave blank to search by store name"
                  />
                </label>
                <div className="mini-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => fixStoreAddress(store.id)}
                    disabled={loading}
                  >
                    {store.isPinned ? 'Refix stop address' : 'Fix stop address'}
                  </button>
                  {store.isPinned ? (
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => clearPinnedStore(store.id)}
                      disabled={loading}
                    >
                      Use store search instead
                    </button>
                  ) : null}
                </div>
                <p className="store-note">
                  {store.isPinned
                    ? `Stop ${storeIndex + 1} is pinned to a specific location and will use only that address.`
                    : `Store ${storeIndex + 1}: the app will search for likely nearby "${store.name || 'store'}" locations and test them automatically.`}
                </p>
                {store.isPinned && store.resolvedLocation ? (
                  <p className="store-note">
                    Using: {store.resolvedLocation.resolvedAddress}
                  </p>
                ) : null}
              </article>
            ))}
          </div>

          <div className="actions">
            <button type="submit" className="primary-button" disabled={loading}>
              {loading ? 'Optimizing exact route...' : 'Optimize trip'}
            </button>
            <p className="hint">
              Fresh lookups can take a bit because the app stays polite to public Nominatim limits.
            </p>
          </div>

          {error ? <div className="error-banner">{error}</div> : null}
        </form>

        <section className="results-column">
          <div className="results-summary">
            <div className="section-heading">
              <h2>Best route</h2>
              <p>Selected store locations are shown after the optimizer finishes.</p>
            </div>

            {result ? (
              <>
                <div className="summary-grid">
                  <MetricCard
                    label="Travel time"
                    value={formatDuration(result.summary.totalDurationSeconds)}
                  />
                  <MetricCard
                    label="Distance"
                    value={formatDistance(result.summary.totalDistanceMeters)}
                  />
                  <MetricCard
                    label="Plans checked"
                    value={formatNumber(result.summary.permutationsChecked)}
                  />
                  <MetricCard label="Solver" value="Exact" />
                </div>

                <div className="candidate-panel">
                  {result.stores.map((store) => (
                    <article className="candidate-card" key={store.id}>
                      <span>{store.name}</span>
                      <strong>{store.candidates.length} candidate locations tried</strong>
                      <p>{store.candidates.map((candidate) => candidate.address).join(' | ')}</p>
                    </article>
                  ))}
                </div>

                <div className="route-strip">
                  {result.orderedStops.map((stop, index) => (
                    <div className="route-stop" key={stop.pointId}>
                      <div className={`stop-badge stop-${stop.kind}`}>{index + 1}</div>
                      <div>
                        <strong>{stop.kind === 'store' ? stop.storeName : stop.label}</strong>
                        <p>{stop.address}</p>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="leg-list">
                  {result.legs.map((leg, index) => (
                    <article className="leg-card" key={`${leg.from.address}-${leg.to.address}`}>
                      <span>Leg {index + 1}</span>
                      <strong>
                        {leg.from.label} to {leg.to.label}
                      </strong>
                      <p>{formatDuration(leg.durationSeconds)}</p>
                      <p>{formatDistance(leg.distanceMeters)}</p>
                    </article>
                  ))}
                </div>
              </>
            ) : (
              <div className="empty-state">
                <p>Run the optimizer to see chosen store locations, stop order, and the map.</p>
              </div>
            )}
          </div>

          <div className="map-card">
            <MapContainer center={mapCenter} zoom={12} scrollWheelZoom className="map-frame">
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              {result?.orderedStops.map((stop) => (
                <Marker key={stop.pointId} position={[stop.lat, stop.lon]}>
                  <Popup>
                    <strong>{stop.kind === 'store' ? stop.storeName : stop.label}</strong>
                    <br />
                    {stop.address}
                  </Popup>
                </Marker>
              ))}
              {!result && resolvedStart ? (
                <Marker position={[resolvedStart.lat, resolvedStart.lon]}>
                  <Popup>
                    <strong>Start</strong>
                    <br />
                    {resolvedStart.resolvedAddress}
                  </Popup>
                </Marker>
              ) : null}
              {!result && resolvedEnd ? (
                <Marker position={[resolvedEnd.lat, resolvedEnd.lon]}>
                  <Popup>
                    <strong>End</strong>
                    <br />
                    {resolvedEnd.resolvedAddress}
                  </Popup>
                </Marker>
              ) : null}
              {!result
                ? stores
                    .filter((store) => store.isPinned && store.resolvedLocation)
                    .map((store) => (
                      <Marker
                        key={`pinned-${store.id}`}
                        position={[
                          store.resolvedLocation!.lat,
                          store.resolvedLocation!.lon,
                        ]}
                      >
                        <Popup>
                          <strong>{store.name}</strong>
                          <br />
                          {store.resolvedLocation!.resolvedAddress}
                        </Popup>
                      </Marker>
                    ))
                : null}
              {result?.geometry.length ? <Polyline positions={result.geometry} /> : null}
            </MapContainer>
          </div>
        </section>
      </main>
    </div>
  )
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  )
}

function formatDuration(seconds: number) {
  const roundedSeconds = Math.round(seconds)
  const hours = Math.floor(roundedSeconds / 3600)
  const minutes = Math.round((roundedSeconds % 3600) / 60)

  if (hours === 0) {
    return `${minutes} min`
  }

  return `${hours} hr ${minutes} min`
}

function formatDistance(meters: number) {
  const miles = meters / 1609.344
  return `${miles.toFixed(1)} mi`
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('en-US').format(value)
}

export default App
