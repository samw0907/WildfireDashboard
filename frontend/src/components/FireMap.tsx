import { useEffect, useRef, useState } from 'react'
import { MapLibreMap, Popup } from 'maplibre-gl'
import type { GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { exposureAtBand, getFireAlerts, type Fire } from '../api'

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
  // Whether to fetch and offer a toggle for the NWS Red Flag Warning /
  // Fire Weather Watch layer - opt-in so Fire Detail's tiny zoomed-in map
  // doesn't fetch a nationwide layer it has no use for.
  enableAlerts?: boolean
}

const SOURCE_ID = 'fires'
const FILL_LAYER_ID = 'fires-fill'
const LINE_LAYER_ID = 'fires-line'
const ALERTS_SOURCE_ID = 'alerts'
const ALERTS_FILL_LAYER_ID = 'alerts-fill'
const ALERTS_LINE_LAYER_ID = 'alerts-line'
// Violet - deliberately distinct from the warm red/orange/yellow buffer
// gradient, so weather alerts read as a different kind of thing on the map.
const ALERTS_COLOR = '#9333ea'

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

function popupHtml(fire: Fire): string {
  const exp = exposureAtBand(fire.exposure, 2400)
  const acres = fire.acres ? `${Math.round(fire.acres).toLocaleString()} ac` : 'Acreage unknown'
  const buildings = exp?.building_count != null ? `${exp.building_count} buildings within 2.4km` : null
  return `
    <div class="map-popup">
      <strong>${fire.name}</strong>
      <div>${acres}${buildings ? ` &middot; ${buildings}` : ''}</div>
    </div>
  `
}

export function FireMap({ fires, selectedFireId, onSelectFire, fitToSelection, buffers, enableAlerts }: FireMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const firesRef = useRef<Fire[]>(fires)
  firesRef.current = fires

  const [alerts, setAlerts] = useState<GeoJSON.FeatureCollection | null>(null)
  const [alertsVisible, setAlertsVisible] = useState(true)

  useEffect(() => {
    if (!enableAlerts) return
    getFireAlerts()
      .then(setAlerts)
      .catch(() => setAlerts(null))
  }, [enableAlerts])

  useEffect(() => {
    if (!containerRef.current) return

    // OpenFreeMap "Liberty" style - free, no API key, no rate limit,
    // OSM-based so roads/streets are clearly visible (useful for the
    // evacuation-route angle). A satellite imagery toggle (MapTiler) is a
    // planned follow-up, not built yet - see DECISIONS.md.
    const map = new MapLibreMap({
      container: containerRef.current,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [-98.5, 39.8],
      zoom: 3,
    })
    mapRef.current = map

    map.on('load', () => {
      // Alerts added first (bottom of stack) - covers huge regional areas,
      // shouldn't visually dominate the fire-specific layers above it.
      map.addSource(ALERTS_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addLayer({
        id: ALERTS_FILL_LAYER_ID,
        type: 'fill',
        source: ALERTS_SOURCE_ID,
        paint: { 'fill-color': ALERTS_COLOR, 'fill-opacity': 0.08 },
      })
      map.addLayer({
        id: ALERTS_LINE_LAYER_ID,
        type: 'line',
        source: ALERTS_SOURCE_ID,
        paint: { 'line-color': ALERTS_COLOR, 'line-width': 1, 'line-dasharray': [3, 2] },
      })

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

      // promoteId lets feature-state key off our own string fire id
      // (MapLibre feature-state needs a numeric or string feature id, and
      // GeoJSON features here don't have a top-level `id` otherwise).
      map.addSource(SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        promoteId: 'fireId',
      })
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
        paint: {
          'line-color': '#dc2626',
          'line-width': ['case', ['boolean', ['feature-state', 'hover'], false], 3.5, 1.5],
        },
      })

      if (onSelectFire) {
        let hoveredId: string | undefined
        const popup = new Popup({ closeButton: false, closeOnClick: false })

        map.on('click', FILL_LAYER_ID, (e: MapLayerMouseEvent) => {
          const id = e.features?.[0]?.properties?.fireId
          if (id) onSelectFire(id)
        })

        map.on('mousemove', FILL_LAYER_ID, (e: MapLayerMouseEvent) => {
          map.getCanvas().style.cursor = 'pointer'
          const feature = e.features?.[0]
          const id = feature?.properties?.fireId as string | undefined
          if (!id) return

          if (hoveredId !== id) {
            if (hoveredId) map.setFeatureState({ source: SOURCE_ID, id: hoveredId }, { hover: false })
            hoveredId = id
            map.setFeatureState({ source: SOURCE_ID, id }, { hover: true })

            const fire = firesRef.current.find((f) => f.id === id)
            if (fire) popup.setHTML(popupHtml(fire))
          }
          popup.setLngLat(e.lngLat)
          if (!popup.isOpen()) popup.addTo(map)
        })

        map.on('mouseleave', FILL_LAYER_ID, () => {
          map.getCanvas().style.cursor = ''
          if (hoveredId) map.setFeatureState({ source: SOURCE_ID, id: hoveredId }, { hover: false })
          hoveredId = undefined
          popup.remove()
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

      const alertsSource = map.getSource(ALERTS_SOURCE_ID) as GeoJSONSource | undefined
      if (alertsSource && alerts) {
        alertsSource.setData(alerts)
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
  }, [fires, selectedFireId, fitToSelection, buffers, alerts])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !map.isStyleLoaded()) return
    const visibility = alertsVisible ? 'visible' : 'none'
    if (map.getLayer(ALERTS_FILL_LAYER_ID)) map.setLayoutProperty(ALERTS_FILL_LAYER_ID, 'visibility', visibility)
    if (map.getLayer(ALERTS_LINE_LAYER_ID)) map.setLayoutProperty(ALERTS_LINE_LAYER_ID, 'visibility', visibility)
  }, [alertsVisible])

  return (
    <div className="fire-map-container">
      <div ref={containerRef} className="fire-map" />
      {enableAlerts && alerts && alerts.features.length > 0 && (
        <label className="alerts-toggle">
          <input type="checkbox" checked={alertsVisible} onChange={(e) => setAlertsVisible(e.target.checked)} />
          Red Flag Warnings ({alerts.features.length})
        </label>
      )}
    </div>
  )
}
