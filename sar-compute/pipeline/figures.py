"""Static figure generation - matplotlib/contextily, reinstated after
comparing this pipeline's output against LAwildfireSAR's own figure set
(dropped early in this project's build on the theory that the dashboard's
interactive MapLibre map would replace static figures entirely - true for
the vector layers, but not for the raw before/after backscatter imagery,
which a vector map can't show at all).

Deliberately excludes anything requiring ground truth (confusion matrix,
precision/recall, the SAR-signal-separability-by-DINS-category violin
plot from the original pipeline) - see SAR_METHODOLOGY.md §3/§7 for why
those can't exist honestly for an arbitrary new fire. Only the three
figure types below need nothing but this job's own inputs/outputs.
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

DAMAGE_COLORS = {
    "destroyed": "#dc2626",
    "possibly_affected": "#f97316",
    "no_damage": "#16a34a",
    "geometry_limited": "#6b7280",
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


def _add_basemap(ax, crs) -> None:
    # Basemap tiles are a nice-to-have, not load-bearing - a live Fargate
    # job losing network access to the tile provider shouldn't fail the
    # whole run over a background image.
    try:
        cx.add_basemap(ax, crs=crs, source=cx.providers.CartoDB.Positron, attribution_size=6)
    except Exception:
        logger.warning("Basemap tile fetch failed - continuing without one", exc_info=True)


def _legend(include_burn: bool) -> list[Patch]:
    patches = [Patch(facecolor=color, label=label.replace("_", " ").title()) for label, color in DAMAGE_COLORS.items()]
    if include_burn:
        # alpha matches the actual fill's own opacity below, not full
        # saturation - a legend swatch that looks darker than what's
        # actually on the map reads as a mismatch, exactly what was
        # flagged as "vague colouring that doesn't match the key."
        patches.insert(0, Patch(facecolor=BURN_COLOR, alpha=0.35, label=BURN_LABEL))
    return patches


def _plot_classified_buildings(ax, buildings_gdf: gpd.GeoDataFrame, markersize: float) -> None:
    for damage_class, color in DAMAGE_COLORS.items():
        subset = buildings_gdf[buildings_gdf["damage_class"] == damage_class]
        if len(subset):
            subset.plot(ax=ax, color=color, markersize=markersize)


def make_overview_map(
    perimeter_gdf: gpd.GeoDataFrame,
    burn_gdf: gpd.GeoDataFrame | None,
    buildings_gdf: gpd.GeoDataFrame,
    output_path: str,
) -> None:
    """Full fire-perimeter context, matching the regional-overview figure
    in the original pipeline's own output set."""
    fig = Figure(figsize=(10, 8))
    ax = fig.add_subplot(111)
    perimeter_gdf.boundary.plot(ax=ax, color="black", linewidth=1.5, linestyle="--")
    if burn_gdf is not None and len(burn_gdf):
        burn_gdf.plot(ax=ax, color=BURN_COLOR, alpha=0.35)
    _plot_classified_buildings(ax, buildings_gdf, markersize=4)
    _add_basemap(ax, perimeter_gdf.crs)
    ax.set_axis_off()
    ax.set_title("SAR Damage Assessment — Overview")
    ax.legend(handles=_legend(include_burn=burn_gdf is not None and len(burn_gdf) > 0), loc="lower right", fontsize=8, framealpha=0.9)
    fig.savefig(output_path, dpi=150, bbox_inches="tight")


def make_damage_zoom_map(
    perimeter_gdf: gpd.GeoDataFrame,
    burn_gdf: gpd.GeoDataFrame | None,
    buildings_gdf: gpd.GeoDataFrame,
    output_path: str,
) -> None:
    """Zoomed to the *detected burn area's* own extent, not the full
    cached building set (which spans the whole 2,400m exposure buffer -
    often much wider than the fire itself, which produced a "zoom" that
    wasn't actually zoomed to anything in particular). Falls back to
    classified (non-"no_data") buildings, then the full perimeter, if no
    burn area was detected at all - always zooming to *something*
    meaningful rather than defaulting to the full building set."""
    fig = Figure(figsize=(10, 10))
    ax = fig.add_subplot(111)
    perimeter_gdf.boundary.plot(ax=ax, color="black", linewidth=1.5, linestyle="--")
    if burn_gdf is not None and len(burn_gdf):
        burn_gdf.plot(ax=ax, color=BURN_COLOR, alpha=0.35)
    _plot_classified_buildings(ax, buildings_gdf, markersize=8)

    classified = buildings_gdf[buildings_gdf["damage_class"] != "no_data"]
    if burn_gdf is not None and len(burn_gdf):
        minx, miny, maxx, maxy = burn_gdf.total_bounds
    elif len(classified):
        minx, miny, maxx, maxy = classified.total_bounds
    else:
        minx, miny, maxx, maxy = perimeter_gdf.total_bounds
    pad_x, pad_y = max((maxx - minx) * 0.15, 50), max((maxy - miny) * 0.15, 50)
    ax.set_xlim(minx - pad_x, maxx + pad_x)
    ax.set_ylim(miny - pad_y, maxy + pad_y)

    _add_basemap(ax, perimeter_gdf.crs)
    ax.set_axis_off()
    ax.set_title("SAR Building Damage — Zoomed")
    ax.legend(handles=_legend(include_burn=burn_gdf is not None and len(burn_gdf) > 0), loc="lower right", fontsize=8, framealpha=0.9)
    fig.savefig(output_path, dpi=150, bbox_inches="tight")


def make_backscatter_panel(
    pre_vv_path: str,
    post_vv_path: str,
    change_combined_clipped_path: str,
    threshold_db: float,
    output_path: str,
) -> None:
    """Pre-event / post-event / change-magnitude 3-panel - the one figure
    type the interactive map genuinely cannot replicate, since it shows
    the raw radar imagery itself, not a vector overlay derived from it."""
    with rasterio.open(pre_vv_path) as src:
        pre = src.read(1)
    with rasterio.open(post_vv_path) as src:
        post = src.read(1)
    with rasterio.open(change_combined_clipped_path) as src:
        change = src.read(1)

    fig = Figure(figsize=(18, 6))
    axes = fig.subplots(1, 3)

    for ax, data, title in ((axes[0], pre, "Pre-event γ⁰ VV (dB)"), (axes[1], post, "Post-event γ⁰ VV (dB)")):
        im = ax.imshow(np.clip(data, -25, 5), cmap="gray")
        ax.set_title(title)
        ax.set_axis_off()
        fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)

    im = axes[2].imshow(change, cmap="Reds", vmin=0, vmax=max(threshold_db * 2, np.nanpercentile(change, 99)))
    axes[2].set_title(f"Change magnitude (dB) — threshold {threshold_db}")
    axes[2].set_axis_off()
    fig.colorbar(im, ax=axes[2], fraction=0.046, pad=0.04)

    fig.suptitle("SAR Change Detection — Backscatter Comparison")
    fig.savefig(output_path, dpi=150, bbox_inches="tight")


def run_figures(
    perimeter_geojson: dict,
    target_crs: int,
    buildings_gdf: gpd.GeoDataFrame,
    burn_perimeter_path: str | None,
    pre_vv_path: str,
    post_vv_path: str,
    change_combined_clipped_path: str,
    threshold_db: float,
    output_dir: str,
) -> dict[str, str]:
    """Generates all three figures, returning {label: local_path} for
    whichever succeeded - a single figure failing (e.g. a basemap outage)
    shouldn't take down the ones that didn't depend on it."""
    from shapely.geometry import shape

    os.makedirs(output_dir, exist_ok=True)
    perimeter_gdf = gpd.GeoDataFrame(geometry=[shape(perimeter_geojson)], crs="EPSG:4326").to_crs(target_crs)
    burn_gdf = None
    if burn_perimeter_path and os.path.exists(burn_perimeter_path):
        burn_gdf = gpd.read_file(burn_perimeter_path).to_crs(target_crs)

    outputs: dict[str, str] = {}

    try:
        path = os.path.join(output_dir, "overview_map.png")
        make_overview_map(perimeter_gdf, burn_gdf, buildings_gdf, path)
        outputs["overview_map"] = path
    except Exception:
        logger.exception("Overview map generation failed - continuing without it")

    try:
        path = os.path.join(output_dir, "damage_zoom_map.png")
        make_damage_zoom_map(perimeter_gdf, burn_gdf, buildings_gdf, path)
        outputs["damage_zoom_map"] = path
    except Exception:
        logger.exception("Damage zoom map generation failed - continuing without it")

    try:
        path = os.path.join(output_dir, "backscatter_panel.png")
        make_backscatter_panel(pre_vv_path, post_vv_path, change_combined_clipped_path, threshold_db, path)
        outputs["backscatter_panel"] = path
    except Exception:
        logger.exception("Backscatter panel generation failed - continuing without it")

    return outputs
