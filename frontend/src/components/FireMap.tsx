import { useEffect, useRef } from 'react'
import { MapLibreMap } from 'maplibre-gl'
import type { GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { Fire } from '../api'

interface FireMapProps {
  fires: Fire[]
  selectedFireId?: string
  onSelectFire?: (id: string) => void
  fitToSelection?: boolean
  // Buffer ring polygons keyed by band ("500" | "1000" | "2400"). Only
  // meaningful (and only passed) for a single-fire view - rendering these
  // for every fire on an all-fires map would be imperceptible at that zoom
  // level and just adds rendering cost.
  buffers?: Record<string, GeoJSON.Geometry>
}

const SOURCE_ID = 'fires'
const FILL_LAYER_ID = 'fires-fill'
const LINE_LAYER_ID = 'fires-line'

// Outward heat gradient: the closest buffer is most urgent (red, matching
// the perimeter's own red outline), fading to yellow at the widest band -
// these are the exact hex values behind --accent-red/orange/yellow, kept
// in sync manually since MapLibre paint properties can't read CSS
// variables directly, so the matching stat cards read as the same colors.
const BUFFER_COLORS: Record<string, string> = {
  '500': '#dc2626',
  '1000': '#f97316',
  '2400': '#eab308',
}
// Largest band added first (bottom of stack) so smaller bands draw on top,
// which is what makes stacked filled disks read as concentric rings.
const BUFFER_BAND_ORDER = ['2400', '1000', '500']

function flattenCoords(geometry: GeoJSON.Geometry): number[][] {
  switch (geometry.type) {
    case 'Polygon':
      return geometry.coordinates.flat()
    case 'MultiPolygon':
      return geometry.coordinates.flat(2)
    default:
      return []
  }
}

export function FireMap({ fires, selectedFireId, onSelectFire, fitToSelection, buffers }: FireMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    // Placeholder demo style - swap for a real basemap before shipping
    const map = new MapLibreMap({
      container: containerRef.current,
      style: 'https://demotiles.maplibre.org/style.json',
      center: [-98.5, 39.8],
      zoom: 3,
    })
    mapRef.current = map

    map.on('load', () => {
      for (const band of BUFFER_BAND_ORDER) {
        const bandSourceId = `buffer-${band}`
        map.addSource(bandSourceId, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
        map.addLayer({
          id: `${bandSourceId}-fill`,
          type: 'fill',
          source: bandSourceId,
          paint: { 'fill-color': BUFFER_COLORS[band], 'fill-opacity': 0.1 },
        })
        map.addLayer({
          id: `${bandSourceId}-line`,
          type: 'line',
          source: bandSourceId,
          paint: { 'line-color': BUFFER_COLORS[band], 'line-width': 1.5, 'line-dasharray': [2, 2] },
        })
      }

      map.addSource(SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addLayer({
        id: FILL_LAYER_ID,
        type: 'fill',
        source: SOURCE_ID,
        paint: { 'fill-color': '#f97316', 'fill-opacity': 0.35 },
      })
      map.addLayer({
        id: LINE_LAYER_ID,
        type: 'line',
        source: SOURCE_ID,
        paint: { 'line-color': '#dc2626', 'line-width': 1.5 },
      })

      if (onSelectFire) {
        map.on('click', FILL_LAYER_ID, (e: MapLayerMouseEvent) => {
          const id = e.features?.[0]?.properties?.fireId
          if (id) onSelectFire(id)
        })
        map.on('mouseenter', FILL_LAYER_ID, () => {
          map.getCanvas().style.cursor = 'pointer'
        })
        map.on('mouseleave', FILL_LAYER_ID, () => {
          map.getCanvas().style.cursor = ''
        })
      }
    })

    return () => map.remove()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return

    const updateData = () => {
      const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined
      if (!source) return

      const featureCollection: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: fires.map((f) => ({
          type: 'Feature',
          geometry: f.perimeter,
          properties: { fireId: f.id, name: f.name },
        })),
      }
      source.setData(featureCollection)

      for (const band of BUFFER_BAND_ORDER) {
        const bandSource = map.getSource(`buffer-${band}`) as GeoJSONSource | undefined
        if (!bandSource) continue
        const geometry = buffers?.[band]
        bandSource.setData(
          geometry
            ? { type: 'FeatureCollection', features: [{ type: 'Feature', geometry, properties: {} }] }
            : { type: 'FeatureCollection', features: [] },
        )
      }

      if (fitToSelection && selectedFireId) {
        const selected = fires.find((f) => f.id === selectedFireId)
        const coords = selected ? flattenCoords(selected.perimeter) : []
        if (coords.length) {
          const lons = coords.map((c) => c[0])
          const lats = coords.map((c) => c[1])
          map.fitBounds(
            [
              [Math.min(...lons), Math.min(...lats)],
              [Math.max(...lons), Math.max(...lats)],
            ],
            { padding: 40, maxZoom: 14 },
          )
        }
      }
    }

    if (map.isStyleLoaded()) {
      updateData()
    } else {
      map.once('load', updateData)
    }
  }, [fires, selectedFireId, fitToSelection, buffers])

  return <div ref={containerRef} className="fire-map" />
}
