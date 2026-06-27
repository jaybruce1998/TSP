# Exact Store Route Optimizer

This app now expects:

- a start address
- an end address
- a list of store names

The user does not enter store locations manually. The backend searches OpenStreetMap/Nominatim for likely nearby locations for each store name, then the exact optimizer chooses both the store order and the specific location for each store.

## Run the app

```bash
npm install
npm run dev
```

That starts:

- the Vite frontend
- the Express API on `http://localhost:8787`

For a production-style run:

```bash
npm run build
npm start
```

## Features

- `Fix start address` and `Fix end address` resolve an entered address to a specific valid Nominatim match.
- `Use start as end` copies the start address into the end address field.
- `Optimize trip` automatically finds candidate store locations near the trip area and solves the exact route over those candidates.

## Stack

- `Nominatim` for address resolution and store-place discovery
- `OSRM` for road-network travel-time and route geometry
- exact dynamic programming for choosing store order and store location

## Notes

- Public Nominatim is rate-limited, so fresh searches may take a few seconds.
- Store matching quality depends on OpenStreetMap naming and coverage.
- The exact solver is intentionally capped to keep searches realistic for local use.
