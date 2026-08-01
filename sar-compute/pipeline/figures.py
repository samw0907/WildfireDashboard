"""Static figure generation - matplotlib/contextily, reinstated after
comparing this pipeline's output against LAwildfireSAR's own figure set
(dropped early in this project's build on the theory that the dashboard's
interactive MapLibre map would replace static figures entirely - true for
the vector layers, but not for the raw before/after backscatter imagery,
which a vector map can't show at all).

That same reasoning is why there is no whole-fire "overview" figure here
(dropped 2026-08-01, see SAR_PIPELINE_REDESIGN.md): a burn-perimeter-fill
map is pure vector content the live dashboard map already renders better
(pannable/zoomable/hoverable). Only content a vector map can't reproduce
gets a static figure: the raw radar imagery (backscatter_panel,
perimeter_change_map) and a curated damage "highlight" figure
(damage_zoom_map) - not a completeness claim, a demonstration one, since
individual building footprints are usually sub-pixel at whole-fire scale.

Deliberately excludes anything requiring ground truth (confusion matrix,
precision/recall, the SAR-signal-separability-by-DINS-category violin
plot from the original pipeline) - see SAR_METHODOLOGY.md §3/§7 for why
those can't exist honestly for an arbitrary new fire.
"""

import logging
import os

import contextily as cx
import geopandas as gpd
import numpy as np
import rasterio
from matplotlib.figure import Figure
from matplotlib.patches import Patch

logger = logging.getLogger(__name__)

# Matches FireMap.tsx's DAMAGE_CLASS_COLORS - kept in sync manually so the
# static figures and the live map read as the same classes.
DAMAGE_COLORS = {
    "destroyed": "#ff1a1a",
    "possibly_affected": "#ff9500",
    "no_damage": "#00d95f",
    "geometry_limited": "#7a7a7a",
    # A positive threshold read with no spatially-coherent patch backing
    # it up (see buildings.py's apply_spatial_corroboration()) - muted/
    # brownish rather than vivid, deliberately: flagged, not trusted.
    "unconfirmed": "#92400e",
}
# Deliberately excluded from DAMAGE_COLORS/plotting: "no_data" - once
# building damage is correctly clipped to the fire's own perimeter (see
# change.py/entrypoint.py), the overwhelming majority of the cached
# 2,400m-buffer building set falls outside it and is "no_data" by
# definition. Plotting thousands of uninformative gray dots added visual
# noise without telling the viewer anything - a building not being
# classified isn't itself a finding worth a map marker.
BURN_COLOR = "#7f1d1d"
BURN_LABEL = "Burn area detected"

# Damage classes eligible to anchor the zoomed "hotspot" figure - an
# unconfirmed or geometry-limited read isn't a confident enough finding to
# build the headline demonstration figure around.
HOTSPOT_CLASSES = ("destroyed", "possibly_affected")
# City-block scale, not fire scale - the point is to zoom tight enough
# that individual building footprints are actually visible, which a
# fire-sized or even neighborhood-sized window can't guarantee.
HOTSPOT_CELL_METERS = 500.0


def _add_basemap(ax, crs) -> None:
    # Basemap tiles are a nice-to-have, not load-bearing - a live Fargate
    # job losing network access to the tile provider shouldn't fail the
    # whole run over a background image.
    try:
        cx.add_basemap(ax, crs=crs, source=cx.providers.CartoDB.Positron, attribution_size=6)
    except Exception:
        logger.warning("Basemap tile fetch failed - continuing without one", exc_info=True)


def _legend(present_classes: set[str], include_burn: bool) -> list[Patch]:
    """Only lists classes actually plotted - a swatch for a color that
    isn't anywhere on the map reads as broken, not informative (the exact
    complaint that prompted this rewrite)."""
    patches = [
        Patch(facecolor=color, label=label.replace("_", " ").title())
        for label, color in DAMAGE_COLORS.items()
        if label in present_classes
    ]
    if include_burn:
        # alpha matches the actual fill's own opacity below, not full
        # saturation - a legend swatch that looks darker than what's
        # actually on the map reads as a mismatch.
        patches.insert(0, Patch(facecolor=BURN_COLOR, alpha=0.35, label=BURN_LABEL))
    return patches


def _plot_classified_buildings(ax, buildings_gdf: gpd.GeoDataFrame, markersize: float) -> set[str]:
    """Returns the set of damage classes that actually had ≥1 building
    plotted, so the caller can build an accurate legend."""
    present: set[str] = set()
    for damage_class, color in DAMAGE_COLORS.items():
        subset = buildings_gdf[buildings_gdf["damage_class"] == damage_class]
        if len(subset):
            # edgecolor/linewidth: real footprint polygons, not markers -
            # geopandas ignores `markersize` for polygon geometries, so a
            # thin dark outline is what actually makes a small building
            # footprint visible against a busy basemap, not the
            # markersize value itself.
            subset.plot(ax=ax, color=color, markersize=markersize, edgecolor="black", linewidth=0.3)
            present.add(damage_class)
    return present


def _find_hotspot_bounds(buildings_gdf: gpd.GeoDataFrame, cell_meters: float = HOTSPOT_CELL_METERS):
    """Grid-bins destroyed/possibly-affected building centroids into
    `cell_meters` cells and returns the bounds of the single most
    concentrated cell - a simple, dependency-free way to find "the
    neighborhood that got hit hardest" without pulling in a clustering
    library. Returns None if no eligible buildings exist (nothing to
    anchor a hotspot on)."""
    hotspot_candidates = buildings_gdf[buildings_gdf["damage_class"].isin(HOTSPOT_CLASSES)]
    if not len(hotspot_candidates):
        return None

    centroids = hotspot_candidates.geometry.centroid
    minx, miny, _, _ = hotspot_candidates.total_bounds
    cell_x = np.floor((centroids.x.to_numpy() - minx) / cell_meters).astype(int)
    cell_y = np.floor((centroids.y.to_numpy() - miny) / cell_meters).astype(int)

    cells, counts = np.unique(np.stack([cell_x, cell_y], axis=1), axis=0, return_counts=True)
    best_cx, best_cy = cells[np.argmax(counts)]

    cell_minx = minx + best_cx * cell_meters
    cell_miny = miny + best_cy * cell_meters
    return (cell_minx, cell_miny, cell_minx + cell_meters, cell_miny + cell_meters)


def make_damage_zoom_map(
    perimeter_gdf: gpd.GeoDataFrame,
    burn_gdf: gpd.GeoDataFrame | None,
    buildings_gdf: gpd.GeoDataFrame,
    output_path: str,
) -> None:
    """Zoomed to the single densest cluster of confirmed (destroyed/
    possibly-affected) damage, not the whole burn extent - for a large
    fire, "zoom to burn extent" degenerates to "zoom to nearly the whole
    fire" whenever most of the perimeter burned, at which point individual
    building footprints are sub-pixel and invisible. This is deliberately
    a curated demonstration figure, not a completeness claim - the full
    dataset is always available as downloadable GeoJSON and on the live
    interactive map."""
    fig = Figure(figsize=(10, 10))
    ax = fig.add_subplot(111)
    perimeter_gdf.boundary.plot(ax=ax, color="black", linewidth=1.5, linestyle="--")

    hotspot_bounds = _find_hotspot_bounds(buildings_gdf)
    if hotspot_bounds:
        minx, miny, maxx, maxy = hotspot_bounds
        pad_x, pad_y = (maxx - minx) * 0.15, (maxy - miny) * 0.15
        caption = (
            "Zoomed to the highest concentration of confirmed (destroyed / possibly affected) damage - "
            "see the full results for the complete dataset."
        )
    else:
        # No confirmed damage to anchor a hotspot on - fall back to
        # whatever's available, same chain as before this rewrite.
        classified = buildings_gdf[buildings_gdf["damage_class"] != "no_data"]
        if burn_gdf is not None and len(burn_gdf):
            minx, miny, maxx, maxy = burn_gdf.total_bounds
        elif len(classified):
            minx, miny, maxx, maxy = classified.total_bounds
        else:
            minx, miny, maxx, maxy = perimeter_gdf.total_bounds
        pad_x, pad_y = max((maxx - minx) * 0.15, 50), max((maxy - miny) * 0.15, 50)
        caption = "No confirmed damage detected in this run - showing the full assessed area."

    ax.set_xlim(minx - pad_x, maxx + pad_x)
    ax.set_ylim(miny - pad_y, maxy + pad_y)

    if burn_gdf is not None and len(burn_gdf):
        burn_gdf.plot(ax=ax, color=BURN_COLOR, alpha=0.35)
    # Only buildings actually inside the final view count toward the
    # legend - a class that exists in the full dataset but happens not to
    # fall in this particular window shouldn't get a swatch either.
    in_view = buildings_gdf.cx[minx - pad_x : maxx + pad_x, miny - pad_y : maxy + pad_y]
    present_classes = _plot_classified_buildings(ax, in_view, markersize=12)

    _add_basemap(ax, perimeter_gdf.crs)
    ax.set_axis_off()
    ax.set_title("SAR Building Damage — Highest-Concentration Area")
    ax.legend(
        handles=_legend(present_classes, include_burn=burn_gdf is not None and len(burn_gdf) > 0),
        loc="lower right",
        fontsize=8,
        framealpha=0.9,
    )
    fig.text(0.5, 0.02, caption, ha="center", fontsize=8, style="italic", wrap=True)
    fig.savefig(output_path, dpi=150, bbox_inches="tight")


def make_backscatter_panel(
    pre_vv_path: str,
    post_vv_path: str,
    change_combined_path: str,
    threshold_db: float,
    threshold_label: str,
    output_path: str,
) -> None:
    """Pre-event / post-event / change-magnitude 3-panel, all sharing the
    same full-scene extent - the one figure type the interactive map
    genuinely cannot replicate, since it shows the raw radar imagery
    itself, not a vector overlay derived from it. Deliberately uses the
    *unclipped* change raster (not the perimeter-clipped one) so all three
    panels stay aligned to the same imaged area - the clipped, fire-
    specific view is its own separate figure (make_perimeter_change_map),
    not one panel of a mismatched-extent trio."""
    with rasterio.open(pre_vv_path) as src:
        pre = src.read(1)
    with rasterio.open(post_vv_path) as src:
        post = src.read(1)
    with rasterio.open(change_combined_path) as src:
        change = src.read(1)

    fig = Figure(figsize=(18, 6))
    axes = fig.subplots(1, 3)

    for ax, data, title in ((axes[0], pre, "Pre-event γ⁰ VV (dB)"), (axes[1], post, "Post-event γ⁰ VV (dB)")):
        im = ax.imshow(np.clip(data, -25, 5), cmap="gray")
        ax.set_title(title)
        ax.set_axis_off()
        fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)

    im = axes[2].imshow(change, cmap="Reds", vmin=0, vmax=max(threshold_db * 2, np.nanpercentile(change, 99)))
    axes[2].set_title(f"Change magnitude (dB) — {threshold_label}")
    axes[2].set_axis_off()
    fig.colorbar(im, ax=axes[2], fraction=0.046, pad=0.04)

    fig.suptitle("SAR Change Detection — Full-Scene Backscatter Comparison")
    fig.savefig(output_path, dpi=150, bbox_inches="tight")


def make_perimeter_change_map(
    change_combined_clipped_path: str,
    threshold_db: float,
    threshold_label: str,
    output_path: str,
) -> None:
    """The fire-specific counterpart to make_backscatter_panel's full-scene
    view: change magnitude clipped to the fire's own perimeter, at its own
    tight extent - previously (incorrectly) embedded as the third panel of
    the full-scene trio above, which mismatched all three panels' extents."""
    with rasterio.open(change_combined_clipped_path) as src:
        change = src.read(1)

    fig = Figure(figsize=(8, 8))
    ax = fig.add_subplot(111)
    im = ax.imshow(np.clip(change, 0, None), cmap="Reds", vmin=0, vmax=max(threshold_db * 2, np.nanpercentile(change, 99)))
    ax.set_title(f"Change Magnitude — Clipped to Fire Perimeter ({threshold_label})")
    ax.set_axis_off()
    fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
    fig.savefig(output_path, dpi=150, bbox_inches="tight")


def run_figures(
    perimeter_geojson: dict,
    target_crs: int,
    buildings_gdf: gpd.GeoDataFrame,
    burn_perimeter_path: str | None,
    pre_vv_path: str,
    post_vv_path: str,
    change_combined_path: str,
    change_combined_clipped_path: str,
    threshold_db: float,
    threshold_label: str,
    output_dir: str,
) -> dict[str, str]:
    """Generates all figures, returning {label: local_path} for whichever
    succeeded - a single figure failing (e.g. a basemap outage) shouldn't
    take down the ones that didn't depend on it."""
    from shapely.geometry import shape

    os.makedirs(output_dir, exist_ok=True)
    perimeter_gdf = gpd.GeoDataFrame(geometry=[shape(perimeter_geojson)], crs="EPSG:4326").to_crs(target_crs)
    burn_gdf = None
    if burn_perimeter_path and os.path.exists(burn_perimeter_path):
        burn_gdf = gpd.read_file(burn_perimeter_path).to_crs(target_crs)

    outputs: dict[str, str] = {}

    try:
        path = os.path.join(output_dir, "damage_zoom_map.png")
        make_damage_zoom_map(perimeter_gdf, burn_gdf, buildings_gdf, path)
        outputs["damage_zoom_map"] = path
    except Exception:
        logger.exception("Damage zoom map generation failed - continuing without it")

    try:
        path = os.path.join(output_dir, "backscatter_panel.png")
        make_backscatter_panel(pre_vv_path, post_vv_path, change_combined_path, threshold_db, threshold_label, path)
        outputs["backscatter_panel"] = path
    except Exception:
        logger.exception("Backscatter panel generation failed - continuing without it")

    try:
        path = os.path.join(output_dir, "perimeter_change_map.png")
        make_perimeter_change_map(change_combined_clipped_path, threshold_db, threshold_label, path)
        outputs["perimeter_change_map"] = path
    except Exception:
        logger.exception("Perimeter change map generation failed - continuing without it")

    return outputs
