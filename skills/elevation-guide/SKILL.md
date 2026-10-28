---
name: elevation-guide
description: Assess route terrain, refine candidate high points, and evaluate visual or radio sightlines with elevation_* tools. Use when a task starts from named places or route geometry, chains terrain calls, or needs a conclusion supported by coverage, sampling, and height references.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use elevation-mcp-server for sampled terrain analysis. Obtain place coordinates and route geometry elsewhere; the server does not geocode names or find trails. A terrain sightline supports a view or radio assessment, but does not establish building clearance, vegetation clearance, or radio-link performance.

## Gates

- Before reporting a named trail's gain or grade, obtain its actual vertices in travel order. Two endpoints produce a great-circle segment, not the trail between them. Convert GeoJSON's longitude-first positions to the tools' named coordinate fields rather than passing tuples through.
- Before comparing route totals, inspect coverage, dataset provenance, and sample spacing for both routes. Missing samples are bridged in profile statistics; report that gap rather than presenting the totals as a complete measurement. Differences in source or sampling can affect a comparison.
- Before naming an area's summit, distinguish the highest sampled node from the highest terrain in the box. A smaller grid around a candidate improves its local sampling; it cannot prove that no higher feature lies between nodes elsewhere in the original area.
- Before evaluating a sightline, establish the observer and target positions and their eye or antenna heights above the applicable surface. Do not substitute an absolute elevation for a height above ground.
- If a sightline crosses water and needs an explicit water level, establish a vertical reference compatible with the sampled terrain before setting it. Zero and a provider choice do not establish compatibility. If the reference cannot be established, state that the water-adjusted clearance remains unresolved.
- Before concluding a path is clear, inspect the returned verdict and coverage. A known obstruction can establish blockage despite gaps; missing data cannot establish clearance. For radio, report geometric and Fresnel verdicts separately, and keep the conclusion limited to sampled terrain at the chosen refraction model.

## Workflows

### Assess a route

Resolve the route's identity and obtain its polyline, then call elevation_get_profile on that geometry. Report the sampling and coverage alongside gain and grades. Use the returned extreme-grade distances to locate steep sections; matching a rounded grade against the sample list can select the wrong occurrence.

If the decision depends on a short section that the returned spacing does not resolve, profile that section's actual vertices separately. Label the section result separately from the whole-route totals: a different sampling interval can change cumulative ascent and descent. Increasing the count beyond the answering raster's detail does not recover finer terrain.

### Refine a candidate high point and assess its view

Start from a defined area, call elevation_get_grid, and use the returned highest node's coordinates to center a smaller search box when local refinement is needed. Retain the original search extent and the refined extent in the conclusion so a local candidate does not become an asserted regional maximum.

Use the candidate coordinates and an independently resolved lookout or target for elevation_check_line_of_sight after establishing endpoint heights. If the user needs to inspect the intervening terrain, call elevation_get_profile on those same endpoints. Its raw terrain elevations are not the sightline's curvature-adjusted clearances.

### Assess a radio path or water crossing

Establish antenna heights and frequency for a radio assessment, and use the radio earth model with the Fresnel check. Inspect the Fresnel limiting point independently of the geometric limiting point: they can occur at different positions. A geometrically clear path can still have insufficient Fresnel clearance.

For a water crossing, resolve the water-level reference gate before applying a level. The level floors every sample, including endpoints; check the returned endpoint surfaces and sightline heights when interpreting the result. Preserve the result's height-reference context and source attribution in the assessment.
