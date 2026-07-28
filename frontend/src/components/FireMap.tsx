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
}

const SOURCE_ID = 'fires'
const FILL_LAYER_ID = 'fires-fill'
const LINE_LAYER_ID = 'fires-line'

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

export function FireMap({ fires, selectedFireId, onSelectFire, fitToSelection }: FireMapProps) {
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
  }, [fires, selectedFireId, fitToSelection])

  return <div ref={containerRef} className="fire-map" />
}
