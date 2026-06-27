export type StoreInput = {
  id: string
  name: string
  fixedAddress?: string
  resolvedLocation?: ResolvedAddressResponse | null
  isPinned?: boolean
}

export type OrderedStop = {
  pointId: string
  label: string
  address: string
  lat: number
  lon: number
  kind: 'start' | 'store' | 'end'
  storeId?: string
  storeName?: string
  storeIndex?: number
  locationIndex?: number
}

export type OptimizationResponse = {
  stores: Array<{
    id: string
    name: string
    candidates: OrderedStop[]
  }>
  summary: {
    totalDurationSeconds: number
    totalDistanceMeters: number
    permutationsChecked: number
    exactAlgorithm: string
  }
  orderedStops: OrderedStop[]
  geometry: [number, number][]
  legs: Array<{
    from: {
      label: string
      address: string
    }
    to: {
      label: string
      address: string
    }
    durationSeconds: number
    distanceMeters: number
    summary: string
  }>
}

export type ResolvedAddressResponse = {
  input: string
  resolvedAddress: string
  lat: number
  lon: number
}
