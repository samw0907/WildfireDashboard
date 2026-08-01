import { useEffect, useRef, useState } from 'react'
import { MapLibreMap, Popup } from 'maplibre-gl'
import type { GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { exposureAtBand, getFireAlerts, type Fire } from '../api'
import { LayersIcon } from './icons'

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
  // Fire Weather Watch layer.
  enableAlerts?: boolean
  // Initial toggle state when enableAlerts is set - defaults to visible
  // (the nationwide Dashboard/Map views want it on by default), but Fire
  // Detail's single-fire view wants it available as an opt-in toggle,
  // default off, since it's not the primary thing being looked at there.
  alertsDefaultVisible?: boolean
  // Real Sentinel-1 scene footprints (before/after) - up to 3 each in
  // Composite mode, 1 each in Single-pair mode - for visual context while
  // picking acquisition scenes. Outline only, not filled, since a full IW
  // swath is ~250km wide and would otherwise dominate the view.
  sceneFootprints?: { before?: GeoJSON.Geometry[]; after?: GeoJSON.Geometry[] }
  // True once acquisition scenes have been confirmed (job submitted or
  // beyond) rather than still being picked. Scene footprints are most
  // useful during picking itself - once confirmed, this drives a one-time
  // auto-hide of the footprints layer and a re-fit back to just the fire
  // perimeter, without removing the user's ability to toggle footprints
  // back on manually afterward.
  scenesConfirmed?: boolean
  // SAR compute results once a job completes - both already reprojected
  // to EPSG:4326 by the pipeline. burnPerimeter is null both before
  // completion and when no burn area was detected at all (a real outcome).
  sarResults?: {
    burnPerimeter?: GeoJSON.FeatureCollection | null
    buildingDamage?: GeoJSON.FeatureCollection | null
  }
  // Real OSM building footprints within the fire's 2,400m exposure buffer
  // (the same cache the building-count stat cards already use) - shown as
  // a single consistent color rather than per-band, since position
  // relative to the already-drawn buffer rings already tells you which
  // band a building falls in.
  buildings?: GeoJSON.FeatureCollection | null
}

const SOURCE_ID = 'fires'
const FILL_LAYER_ID = 'fires-fill'
const LINE_LAYER_ID = 'fires-line'
const SATELLITE_SOURCE_ID = 'satellite'
const SATELLITE_LAYER_ID = 'satellite-layer'
const ALERTS_SOURCE_ID = 'alerts'
const ALERTS_FILL_LAYER_ID = 'alerts-fill'
const ALERTS_LINE_LAYER_ID = 'alerts-line'
// Violet - deliberately distinct from the warm red/orange/yellow buffer
// gradient, so weather alerts read as a different kind of thing on the map.
const ALERTS_COLOR = '#9333ea'
const SCENE_BEFORE_SOURCE_ID = 'scene-before'
const SCENE_AFTER_SOURCE_ID = 'scene-after'
// Blue/cyan - a third, distinct hue family from the warm buffer gradient
// and the violet alerts layer, so scene footprints read as their own
// kind of thing (satellite coverage, not fire risk).
const SCENE_BEFORE_COLOR = '#2563eb'
const SCENE_AFTER_COLOR = '#0891b2'
// Brighter/lighter red - the base NIFC-reported perimeter, one of two
// reds on the map now that both it and the SAR burn area are toggleable
// (previously orange, but two different "how much of this fire actually
// burned per SAR" reds side by side reads more clearly than orange vs.
// maroon once both can be on screen at once).
const FIRE_PERIMETER_FILL_COLOR = '#f87171'
const BURN_PERIMETER_SOURCE_ID = 'sar-burn-perimeter'
// Deep, dark red - deliberately much darker than the lighter NIFC
// perimeter fill above, so the two are easy to tell apart when both are
// visible: this one is what SAR actually detected as changed, the other
// is the officially reported perimeter.
const BURN_PERIMETER_COLOR = '#450a0a'
const BUILDING_DAMAGE_SOURCE_ID = 'sar-building-damage'
// Matches buildings.py's classify_damage()/flag_geometry_limited() classes.
// Deliberately more saturated/vivid than this map's other color families -
// these polygons are tiny (real building footprint size against a
// fire-extent canvas), so anything less than maximum contrast is
// invisible in practice, not just "a bit dull."
const DAMAGE_CLASS_COLORS: Record<string, string> = {
  destroyed: '#ff1a1a',
  possibly_affected: '#ff9500',
  no_damage: '#00d95f',
  no_data: '#b0b0b0',
  geometry_limited: '#7a7a7a',
  // A positive threshold read with no spatially-coherent patch backing
  // it up - muted/brownish rather than vivid red/orange, deliberately:
  // it *was* flagged, just not trusted the way a corroborated read is.
  unconfirmed: '#92400e',
}
const BUILDINGS_SOURCE_ID = 'buildings'
// Slate blue-gray - distinct from every other hue family already in use
// here (warm fire/buffer gradient, violet alerts, blue/cyan scenes, dark
// maroon burn area, red/orange/green/gray SAR damage classes), so plain
// "buildings near this fire" reads as its own, neutral kind of thing.
const BUILDINGS_COLOR = '#475569'

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

export function FireMap({
  fires,
  selectedFireId,
  onSelectFire,
  fitToSelection,
  buffers,
  enableAlerts,
  alertsDefaultVisible = true,
  sceneFootprints,
  scenesConfirmed,
  sarResults,
  buildings,
}: FireMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const firesRef = useRef<Fire[]>(fires)
  firesRef.current = fires

  const [alerts, setAlerts] = useState<GeoJSON.FeatureCollection | null>(null)
  const [alertsVisible, setAlertsVisible] = useState(alertsDefaultVisible)
  const [buildingsVisible, setBuildingsVisible] = useState(true)
  const [sceneFootprintsVisible, setSceneFootprintsVisible] = useState(true)
  const [firePerimeterVisible, setFirePerimeterVisible] = useState(true)
  const [burnPerimeterVisible, setBurnPerimeterVisible] = useState(true)
  // Tracks whether we've already reacted to a false->true scenesConfirmed
  // transition, so a later manual re-toggle by the user isn't immediately
  // fought by this effect running again on some unrelated re-render.
  const wasScenesConfirmedRef = useRef(false)
  // Consolidated "Layers" dropdown - up to 3 independent toggles (alerts,
  // buildings, scene footprints) used to each render as their own stacked
  // checkbox in the top-right corner, which ate a lot of map space once a
  // Fire Detail page had all three at once. One button + a panel instead.
  const [layersPanelOpen, setLayersPanelOpen] = useState(false)
  const layersPanelRef = useRef<HTMLDivElement>(null)
  // Street vs satellite basemap - see the satellite-layer setup in the
  // map-init effect for why this is a visibility toggle between one raster
  // layer and the base style's own layers, not a full map.setStyle() swap.
  const [basemap, setBasemap] = useState<'street' | 'satellite'>('street')
  const baseStyleLayerIdsRef = useRef<string[]>([])

  useEffect(() => {
    if (!layersPanelOpen) return
    function handleOutsideClick(e: MouseEvent) {
      if (layersPanelRef.current && !layersPanelRef.current.contains(e.target as Node)) setLayersPanelOpen(false)
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [layersPanelOpen])

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
      // Tightened from 3 - the previous default showed all of Canada/
      // Mexico/the Caribbean for what's a US-only fire dataset, more than
      // needed to still show the whole country.
      zoom: 3.5,
      // Requires Ctrl/Cmd+scroll to zoom (shows an on-map hint on a plain
      // scroll instead) - without this, scrolling the page with the mouse
      // over a large embedded map hijacks the scroll as a zoom gesture
      // instead, making it hard to scroll past the map at all.
      cooperativeGestures: true,
    })
    mapRef.current = map

    map.on('load', () => {
      // Satellite basemap toggle: rather than swapping the whole style
      // (which would wipe every source/layer we add below and force
      // re-adding them all after every switch), keep the vector "Liberty"
      // style always loaded and add one raster layer underneath it - the
      // toggle just flips visibility between "this raster layer" and
      // "every layer already in the base style", captured here before we
      // add anything of our own so this list is exactly the base style's
      // own layers, nothing more.
      baseStyleLayerIdsRef.current = (map.getStyle().layers ?? []).map((l) => l.id)
      map.addSource(SATELLITE_SOURCE_ID, {
        type: 'raster',
        tiles: [
          'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        ],
        tileSize: 256,
        attribution: 'Esri, Maxar, Earthstar Geographics',
      })
      map.addLayer(
        {
          id: SATELLITE_LAYER_ID,
          type: 'raster',
          source: SATELLITE_SOURCE_ID,
          layout: { visibility: 'none' },
        },
        baseStyleLayerIdsRef.current[0],
      )

      // Alerts added first (bottom of stack) - covers huge regional areas,
      // shouldn't visually dominate the fire-specific layers above it.
      map.addSource(ALERTS_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      // Initial visibility set explicitly here (not left to the toggle
      // effect below) - that effect bails out via its own isStyleLoaded()
      // guard on first mount, since the map hasn't finished loading yet
      // at that point, so it never actually applies the correct starting
      // state. Only matters when the desired default is 'none' (Fire
      // Detail) - harmless no-op when it's 'visible' (the MapLibre
      // default anyway), which is why this stayed invisible until now.
      const initialAlertsVisibility = alertsDefaultVisible ? 'visible' : 'none'
      map.addLayer({
        id: ALERTS_FILL_LAYER_ID,
        type: 'fill',
        source: ALERTS_SOURCE_ID,
        layout: { visibility: initialAlertsVisibility },
        paint: { 'fill-color': ALERTS_COLOR, 'fill-opacity': 0.11 },
      })
      map.addLayer({
        id: ALERTS_LINE_LAYER_ID,
        type: 'line',
        source: ALERTS_SOURCE_ID,
        layout: { visibility: initialAlertsVisibility },
        paint: { 'line-color': ALERTS_COLOR, 'line-width': 1.25, 'line-dasharray': [3, 2] },
      })

      // Outline only, no fill - a full Sentinel-1 IW swath is ~250km wide
      // and would blot out the whole map otherwise.
      map.addSource(SCENE_BEFORE_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addLayer({
        id: `${SCENE_BEFORE_SOURCE_ID}-line`,
        type: 'line',
        source: SCENE_BEFORE_SOURCE_ID,
        paint: { 'line-color': SCENE_BEFORE_COLOR, 'line-width': 2, 'line-dasharray': [4, 2] },
      })
      map.addSource(SCENE_AFTER_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addLayer({
        id: `${SCENE_AFTER_SOURCE_ID}-line`,
        type: 'line',
        source: SCENE_AFTER_SOURCE_ID,
        paint: { 'line-color': SCENE_AFTER_COLOR, 'line-width': 2, 'line-dasharray': [4, 2] },
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

      // Real building footprints, on top of the buffer rings so individual
      // buildings stay legible - position relative to the rings already
      // underneath tells you which band a given building falls in, which is
      // why this uses one flat color instead of a per-band scheme. Default
      // visibility set explicitly here for the same isStyleLoaded() race
      // reason as the alerts layer above. Added *before* the SAR compute
      // results below (not after) - this generic layer used to be added
      // later/on top, which meant its semi-opaque gray fill visually muted
      // the classified-damage colors underneath for every building that
      // appears in both datasets (i.e. every classified building). Adding
      // it first means classified damage colors now render on top, full
      // strength, as intended.
      map.addSource(BUILDINGS_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addLayer({
        id: `${BUILDINGS_SOURCE_ID}-fill`,
        type: 'fill',
        source: BUILDINGS_SOURCE_ID,
        layout: { visibility: 'visible' },
        paint: { 'fill-color': BUILDINGS_COLOR, 'fill-opacity': 0.55 },
      })
      map.addLayer({
        id: `${BUILDINGS_SOURCE_ID}-line`,
        type: 'line',
        source: BUILDINGS_SOURCE_ID,
        layout: { visibility: 'visible' },
        paint: { 'line-color': BUILDINGS_COLOR, 'line-width': 1 },
      })

      // SAR compute results - added above the buffer bands/generic
      // buildings but below the fire perimeter itself, so a detected burn
      // area/damaged buildings read as more prominent than the generic
      // exposure rings and building layer underneath.
      map.addSource(BURN_PERIMETER_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addLayer({
        id: `${BURN_PERIMETER_SOURCE_ID}-fill`,
        type: 'fill',
        source: BURN_PERIMETER_SOURCE_ID,
        layout: { visibility: 'visible' },
        paint: { 'fill-color': BURN_PERIMETER_COLOR, 'fill-opacity': 0.4 },
      })
      map.addLayer({
        id: `${BURN_PERIMETER_SOURCE_ID}-line`,
        type: 'line',
        source: BURN_PERIMETER_SOURCE_ID,
        layout: { visibility: 'visible' },
        paint: { 'line-color': BURN_PERIMETER_COLOR, 'line-width': 1.5 },
      })
      // Classified buildings - bold, fully-opaque, saturated colors and a
      // dark outline deliberately, not the softer tones used elsewhere on
      // this map: these polygons are tiny relative to the fire itself (see
      // SAR_RESULTS_ASSESSMENT.md §3.1), so anything less than maximum
      // contrast disappears entirely against a busy basemap.
      map.addSource(BUILDING_DAMAGE_SOURCE_ID, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
      map.addLayer({
        id: `${BUILDING_DAMAGE_SOURCE_ID}-fill`,
        type: 'fill',
        source: BUILDING_DAMAGE_SOURCE_ID,
        paint: {
          'fill-color': [
            'match',
            ['get', 'damage_class'],
            'destroyed', DAMAGE_CLASS_COLORS.destroyed,
            'possibly_affected', DAMAGE_CLASS_COLORS.possibly_affected,
            'no_damage', DAMAGE_CLASS_COLORS.no_damage,
            'geometry_limited', DAMAGE_CLASS_COLORS.geometry_limited,
            'unconfirmed', DAMAGE_CLASS_COLORS.unconfirmed,
            DAMAGE_CLASS_COLORS.no_data,
          ],
          'fill-opacity': 1,
        },
      })
      map.addLayer({
        id: `${BUILDING_DAMAGE_SOURCE_ID}-line`,
        type: 'line',
        source: BUILDING_DAMAGE_SOURCE_ID,
        paint: {
          'line-color': '#000000',
          'line-width': 1,
        },
      })

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
        layout: { visibility: 'visible' },
        paint: { 'fill-color': FIRE_PERIMETER_FILL_COLOR, 'fill-opacity': 0.35 },
      })
      map.addLayer({
        id: LINE_LAYER_ID,
        type: 'line',
        source: SOURCE_ID,
        layout: { visibility: 'visible' },
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

      const toFeatureCollection = (geometries?: GeoJSON.Geometry[]): GeoJSON.FeatureCollection => ({
        type: 'FeatureCollection',
        features: (geometries ?? []).map((geometry) => ({ type: 'Feature', geometry, properties: {} })),
      })
      const beforeSource = map.getSource(SCENE_BEFORE_SOURCE_ID) as GeoJSONSource | undefined
      beforeSource?.setData(toFeatureCollection(sceneFootprints?.before))
      const afterSource = map.getSource(SCENE_AFTER_SOURCE_ID) as GeoJSONSource | undefined
      afterSource?.setData(toFeatureCollection(sceneFootprints?.after))

      const burnSource = map.getSource(BURN_PERIMETER_SOURCE_ID) as GeoJSONSource | undefined
      burnSource?.setData(sarResults?.burnPerimeter ?? { type: 'FeatureCollection', features: [] })
      const damageSource = map.getSource(BUILDING_DAMAGE_SOURCE_ID) as GeoJSONSource | undefined
      damageSource?.setData(sarResults?.buildingDamage ?? { type: 'FeatureCollection', features: [] })
      const buildingsSource = map.getSource(BUILDINGS_SOURCE_ID) as GeoJSONSource | undefined
      buildingsSource?.setData(buildings ?? { type: 'FeatureCollection', features: [] })

      if (fitToSelection && selectedFireId) {
        const selected = fires.find((f) => f.id === selectedFireId)
        let coords = selected ? flattenCoords(selected.perimeter) : []
        // A selected scene's real footprint (~250km swath) is easy to miss
        // entirely at the fire's own zoom level - widen the fit to include
        // it so the boundary is actually visible, not just present in data.
        // Only while the footprints layer is actually visible though - once
        // scenes are confirmed and the layer auto-hides, the fit should
        // snap back to just the fire perimeter rather than staying zoomed
        // out to a swath that's no longer even shown.
        if (sceneFootprintsVisible) {
          for (const geom of sceneFootprints?.before ?? []) coords = coords.concat(flattenCoords(geom))
          for (const geom of sceneFootprints?.after ?? []) coords = coords.concat(flattenCoords(geom))
        }
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
  }, [fires, selectedFireId, fitToSelection, buffers, alerts, sceneFootprints, sceneFootprintsVisible, sarResults, buildings])

  // Note: guarded only by `map` existing, not by map.isStyleLoaded() - that
  // check is stricter than it needs to be here and was the actual bug
  // behind an intermittent "toggle does nothing" report. isStyleLoaded()
  // reflects the *whole* style/tile-loading state and can transiently
  // report false whenever unrelated sources update (e.g. a big buildings/
  // damage setData() elsewhere), silently dropping a same-tick toggle
  // click with no retry. The per-layer map.getLayer() checks already below
  // are the actually-correct guard: once our own map.on('load') callback
  // has added a layer, getLayer() stays truthy for the rest of the map's
  // lifetime regardless of ongoing tile activity, so they're sufficient
  // on their own.
  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const visibility = alertsVisible ? 'visible' : 'none'
    if (map.getLayer(ALERTS_FILL_LAYER_ID)) map.setLayoutProperty(ALERTS_FILL_LAYER_ID, 'visibility', visibility)
    if (map.getLayer(ALERTS_LINE_LAYER_ID)) map.setLayoutProperty(ALERTS_LINE_LAYER_ID, 'visibility', visibility)
  }, [alertsVisible])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const visibility = buildingsVisible ? 'visible' : 'none'
    const fillId = `${BUILDINGS_SOURCE_ID}-fill`
    const lineId = `${BUILDINGS_SOURCE_ID}-line`
    if (map.getLayer(fillId)) map.setLayoutProperty(fillId, 'visibility', visibility)
    if (map.getLayer(lineId)) map.setLayoutProperty(lineId, 'visibility', visibility)
  }, [buildingsVisible])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const visibility = sceneFootprintsVisible ? 'visible' : 'none'
    const beforeId = `${SCENE_BEFORE_SOURCE_ID}-line`
    const afterId = `${SCENE_AFTER_SOURCE_ID}-line`
    if (map.getLayer(beforeId)) map.setLayoutProperty(beforeId, 'visibility', visibility)
    if (map.getLayer(afterId)) map.setLayoutProperty(afterId, 'visibility', visibility)
  }, [sceneFootprintsVisible])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const satelliteVisibility = basemap === 'satellite' ? 'visible' : 'none'
    const streetVisibility = basemap === 'street' ? 'visible' : 'none'
    if (map.getLayer(SATELLITE_LAYER_ID)) map.setLayoutProperty(SATELLITE_LAYER_ID, 'visibility', satelliteVisibility)
    for (const id of baseStyleLayerIdsRef.current) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', streetVisibility)
    }
  }, [basemap])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const visibility = firePerimeterVisible ? 'visible' : 'none'
    if (map.getLayer(FILL_LAYER_ID)) map.setLayoutProperty(FILL_LAYER_ID, 'visibility', visibility)
    if (map.getLayer(LINE_LAYER_ID)) map.setLayoutProperty(LINE_LAYER_ID, 'visibility', visibility)
  }, [firePerimeterVisible])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const visibility = burnPerimeterVisible ? 'visible' : 'none'
    const fillId = `${BURN_PERIMETER_SOURCE_ID}-fill`
    const lineId = `${BURN_PERIMETER_SOURCE_ID}-line`
    if (map.getLayer(fillId)) map.setLayoutProperty(fillId, 'visibility', visibility)
    if (map.getLayer(lineId)) map.setLayoutProperty(lineId, 'visibility', visibility)
  }, [burnPerimeterVisible])

  // One-time auto-collapse: the moment scenesConfirmed flips from false to
  // true (scenes just confirmed, or an already-confirmed fire just
  // loaded), hide the footprints layer by default. Guarded by the ref so
  // this doesn't re-fire and fight a manual re-toggle on later re-renders
  // while scenesConfirmed stays true.
  useEffect(() => {
    if (scenesConfirmed && !wasScenesConfirmedRef.current) {
      setSceneFootprintsVisible(false)
    }
    wasScenesConfirmedRef.current = !!scenesConfirmed
  }, [scenesConfirmed])

  const hasAlertsToggle = !!(enableAlerts && alerts && alerts.features.length > 0)
  const hasBuildingsToggle = !!(buildings && buildings.features.length > 0)
  const hasSceneFootprintsToggle = (sceneFootprints?.before?.length ?? 0) > 0 || (sceneFootprints?.after?.length ?? 0) > 0
  const hasBurnPerimeterToggle = !!(sarResults?.burnPerimeter && sarResults.burnPerimeter.features.length > 0)
  return (
    <div className="fire-map-container">
      <div ref={containerRef} className="fire-map" />
      {/* Always rendered - the basemap (street/satellite) toggle applies
          to every map instance regardless of whether any of the
          data-driven layer toggles below happen to apply. */}
      <div ref={layersPanelRef} className="map-layers-control">
          <button
            className="map-layers-btn"
            onClick={() => setLayersPanelOpen((o) => !o)}
            title="Toggle map layers"
          >
            <LayersIcon />
            Layers
          </button>
          {layersPanelOpen && (
            <div className="map-layers-panel">
              <div className="map-basemap-toggle">
                <button
                  className={basemap === 'street' ? 'map-basemap-btn map-basemap-btn--active' : 'map-basemap-btn'}
                  onClick={() => setBasemap('street')}
                >
                  Street
                </button>
                <button
                  className={basemap === 'satellite' ? 'map-basemap-btn map-basemap-btn--active' : 'map-basemap-btn'}
                  onClick={() => setBasemap('satellite')}
                >
                  Satellite
                </button>
              </div>
              <label
                className="map-layers-option"
                title="The officially reported NIFC fire perimeter - not SAR-derived."
              >
                <input
                  type="checkbox"
                  checked={firePerimeterVisible}
                  onChange={(e) => setFirePerimeterVisible(e.target.checked)}
                />
                Fire perimeter (reported)
              </label>
              {hasBurnPerimeterToggle && (
                <label
                  className="map-layers-option"
                  title="SAR-detected change area from this fire's completed acquisition - a separate, independent measurement from the reported perimeter above, not always the same shape or extent."
                >
                  <input
                    type="checkbox"
                    checked={burnPerimeterVisible}
                    onChange={(e) => setBurnPerimeterVisible(e.target.checked)}
                  />
                  Burn area (SAR-detected)
                </label>
              )}
              {hasAlertsToggle && (
                <label
                  className="map-layers-option"
                  title="Issued by local NWS offices when wind, humidity, and dryness combine to create critical fire weather - not tied to fire counts or size, so coverage can be a tight regional cluster on one day and nationwide the next."
                >
                  <input
                    type="checkbox"
                    checked={alertsVisible}
                    onChange={(e) => setAlertsVisible(e.target.checked)}
                  />
                  Red Flag Warnings ({alerts!.features.length})
                </label>
              )}
              {hasBuildingsToggle && (
                <label
                  className="map-layers-option"
                  title="Real OSM building footprints within this fire's exposure buffer."
                >
                  <input
                    type="checkbox"
                    checked={buildingsVisible}
                    onChange={(e) => setBuildingsVisible(e.target.checked)}
                  />
                  Buildings ({buildings!.features.length})
                </label>
              )}
              {hasSceneFootprintsToggle && (
                <label
                  className="map-layers-option"
                  title="Real Sentinel-1 scene footprints used for this acquisition. Hidden by default once scenes are confirmed, since they matter most during scene selection - toggle back on any time to see coverage again."
                >
                  <input
                    type="checkbox"
                    checked={sceneFootprintsVisible}
                    onChange={(e) => setSceneFootprintsVisible(e.target.checked)}
                  />
                  Scene footprints
                </label>
              )}
            </div>
          )}
        </div>
    </div>
  )
}
