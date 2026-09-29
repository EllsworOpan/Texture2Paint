# Texture2Paint

Browser-based 3D model converter, texture-to-palette quantizer, and multi-color 3D printing prep tool. Drop in a model with authored textures, vertex colors, or material colors; simplify it into discrete filament colors with live 3D preview; clean up noise and boundaries; and export a painted **`.3mf`** for slicers that understand Prusa/Bambu-style triangle paint data.

**Live Demo:** `https://EllsworOpan.github.io/Texture2Paint/`

Everything runs **100% client-side** in your browser. No files are ever uploaded to a server.

---

## What is Texture2Paint?

Textured 3D models (from 3D scanners, photogrammetry, game assets, or digital sculpts) often feature continuous gradients and millions of blended colors. Prepping these models for multi-material FDM 3D printing (Bambu AMS, Prusa MMU/Core One, toolchangers) usually requires tedious manual triangle-painting or destructive mesh conversions that crack along UV seams.

**Texture2Paint** bridges this gap right in your browser:
1. **Flattens complex textures** into a custom palette of solid filament colors (e.g. 2 to 32 colors) with zero dithering.
2. **Cleans up noise** using configurable island despeckling and edge boundary smoothing.
3. **Exports directly to Slicer-Native `.3mf`**: Welds UV seams into a sealed, watertight manifold solid and embeds native MMU/AMS color segmentation attributes directly onto the mesh.

---

## Features

### 🎨 Color Quantization & Custom Palette Tools
- **Adjustable Palette Size:** Use the slider or enter any exact number of colors (e.g., 2, 4, 7, 9, 12).
- **Real-Time 3D Viewport Preview:** Quantization uses an in-memory 5-bit 3D Color LUT and supports base-color textures, material colors, vertex colors, and instance colors.
- **Guided Swatch Editor & Base-Color Dropper:** Click any color chip to use the full-spectrum picker, choose a perceptually ranked next color sampled from the model, or click the model with the base-color dropper. Model picks read the authored texture/material/vertex color and ignore viewport lighting, reflections, and exposure.
- **Persistent Memory:** Toggling quantization on/off or expanding/trimming the color count preserves your custom color choices without resetting your work.
- **Dedicated Resample Button:** Recompute the coverage-aware perceptual palette only when you explicitly request it.

### 🧹 Texture & Contour Cleanup
- **Despeckle (Min Island Filter):** Connected-component filter that removes stray dots and color speckles smaller than your chosen pixel threshold (e.g. 50–500 px), merging them into surrounding colors to eliminate wasteful filament purge switches.
- **Boundary Smoothing:** Majority mode filter that smooths stair-stepped, pixelated color borders into clean contours and rounds out circular features (like eyes).

### 🪄 Floating Decal Projection
- **Geometry-Aware Detection:** Finds disconnected, textured, zero-thickness surface components and ranks their likely receiving surfaces without relying on mesh or texture names.
- **Review Before Baking:** High-confidence sheets are selected automatically; ambiguous components remain available for manual source and receiver selection.
- **Curved-Surface Projection:** Surface-conforming mode follows each decal triangle's local plane and normal instead of forcing one direction through a curved sheet. Manual sheet-normal, receiver-normal, and closest-surface modes remain available. Affected continuous UV charts are remapped into dedicated high-resolution textures before compositing, preserving crisp decal detail without introducing per-triangle seams; genuinely overlapping UV layers remain isolated.
- **Clean WYSIWYG Output:** Successfully baked sheets are physically removed from the processed model. Exporters consume the same visible model snapshot, and the 3MF exporter explicitly excludes hidden geometry from both bounds and mesh output.

### 🖨️ Slicer-Ready Multi-Material 3MF Export

Choose the **Slicer** in the 3MF Print Detail section. **PrusaSlicer 2 / Bambu Studio** writes separate native paint encodings, including slots 17–32 (validated against Prusa 2.9.6 and Bambu 2.8.2.61). **OrcaSlicer 2.4.2** rejects paint using slots above 16; unused palette entries do not block export. **PrusaSlicer 3** is experimental and targets alpha12 with native JSON paint annotations. All targets contain meshes, paint and palette colors without printer, nozzle or print-profile settings; choose the printer and matching filament slots in your slicer.

All 3MF targets follow the same clean contract: start from the processed meshes and numbered color regions, then export only that model data. Source metadata and printer/material/print settings are never copied. Region IDs remain distinct even when their display swatches match. Standard RGB swatches are only a convenience; assign actual materials, colors and tools in the receiving slicer. Prusa 3 exports have no configuration containers, and Orca exports do not add purge tables.

Prusa and Bambu share paint codes only through slot 16. Higher slots are serialized separately. Native open/save tests check persistence; they do not by themselves prove that a slicer interpreted paint correctly. The compatibility tests also slice models painted with slots 16, 17 and 32 in PrusaSlicer 2.9.6 and check the tool used on actual extrusion moves.

- **Native AMS & MMU Segmentation:** Writes `<m:colorgroup>`, `slic3rpe:mmu_segmentation`, and `paint_color` attributes directly onto the mesh.
- **Feature-Aware Boundary Tracing:** Converts quantized texel boundaries into shared mesh contours instead of uniformly resampling the surface. Boundary Accuracy defaults to `0` for an exact processed texel outline; larger values opt into contour simplification with per-face paint-preservation checks.
- **Adaptive Paint Recommendation:** Forecasts painted 3MF growth from a stratified sample of the processed UV boundaries and reports headroom against a one-million-triangle recommendation. Over-budget projections automatically select existing-triangle painting. Users can explicitly override that choice; override exports have no application-imposed resource limit, never silently fall back, and report a failure if the requested refinement cannot be completed.
- **Selectable 3MF Paint Geometry:** Trace Color Boundaries subdivides geometry along printable color contours for crisp boundaries. Existing-triangle mode adds no contour geometry and assigns one printable color to every current triangle. The viewport previews the selected 3MF representation; 3MF-only controls are hidden for other export formats.
- **Attribute-Aware Simplification:** An optional Level of Detail control removes redundant geometry before contour generation. It is constrained by scale-independent geometric error—not a requested triangle count—and preserves UV channels, material groups, open borders, components, normals, and RGBA vertex colors. Skinned and morph-target geometry is left unchanged.
- **Seam-Safe Topology:** Traces colors with the texture's selected UV channel, propagates contour intersections across shared edges, then welds coincident vertices along UV seams. It preserves manifold input topology but is intentionally not a general mesh-repair tool.
- **Complete Authored Color Inputs:** Combines base-color texture alpha, alpha-map green, opacity, alpha test, vertex RGBA, material color, and instance color when assigning printable regions.
- **Static Scene Bake:** Exports visible instances and the current morph/skinned pose, respects draw ranges, and corrects mirrored winding. Unsupported batched geometry and shader-defined surface color are rejected with an actionable error.
- **Z-Up Print Bed Alignment:** Automatically transforms models from Y-Up (web) to Z-Up (slicers) and grounds the lowest point flat to the build plate at $Z = 0$.
- **Configurable Scale:** Normalizes the model to your desired build size (default 150 mm) so it loads into your slicer at **100% scale** with no scaling warnings.

### 🌐 3D Viewer & Multi-Format Converter
- **Color-Aware Import Support:** Accepts `.meshy`, `.glb`, `.gltf`, `.obj`, `.ply`, `.dae`, and `.fbx`, directly or in `.zip`. A ZIP with alternate model formats loads one preferred model rather than overlaying duplicates. Models without authored color information are rejected.
- **Multi-Format Export:** Export as `.3mf` (painted multi-material), `.glb` (Automatic, PNG, or JPEG embedded texture encoding), `.gltf`, `.obj`, `.stl`, `.ply`, or `.usdz`. JPEG is blocked when it would discard transparency.
- **Interactive Viewport:** Orbit controls, exposure, environment intensity, ambient/directional lighting controls, wireframe mode, and dark/grey/white/black background presets.

---

## Supported Formats

| Format | Import | Export | Notes |
| :--- | :---: | :---: | :--- |
| **3MF** | ❌ | ✅ | Painted output with native Prusa/Bambu triangle paint data |
| **GLB** | ✅ | ✅ | Binary glTF; embeds quantized canvas texture when enabled |
| **glTF** | ✅ | ✅ | JSON glTF with external buffer/image support |
| **OBJ** | ✅ | ✅ | Wavefront OBJ with material and vertex coordinate export |
| **STL** | ❌ | ✅ | Colorless mesh export only |
| **PLY** | ✅ | ✅ | Vertex-colored PLY is supported on import |
| **USDZ** | ❌ | ✅ | Apple AR / iOS QuickLook format |
| **FBX** | ✅ | ❌ | Autodesk FBX import |
| **DAE** | ✅ | ❌ | Collada format import |

---

## Quick Start (Local Setup)

Because Texture2Paint runs entirely on client-side web technologies (Three.js, WebGL, Web APIs, and fflate), it can be hosted using any static web server:

### Option 1: Python HTTP Server
```bash
git clone https://github.com/<your-username>/Texture2Paint.git
cd Texture2Paint
./start.sh
# Or manually:
python3 -m http.server 8765
```
Open `http://localhost:8765` in your browser.

### Option 2: Docker
```bash
docker compose up --build
```
Open `http://localhost:8080` in your browser.

---

## Typical Slicer Workflow

1. **Import:** Drag and drop your 3D model (`.glb`, `.obj`, `.fbx`, etc.) into the viewport.
2. **Quantize:** Open the **Processing** sidebar, switch **Enable Color Quantization** to **ON**, and set your desired number of filament colors (e.g. `4`).
3. **Customize Palette (Optional):**
   * Click any color swatch to pick exact filament colors or enter hex values.
   * Or, click a swatch and choose **Pick from model**, then click the model. The sampled color comes from the authored surface rather than the lit screen pixel. The same editor also offers model-based suggested colors and a full-spectrum picker under **Choose any color**.
4. **Clean Up:**
   * Adjust **Despeckle** (e.g., `40–120 px`) to remove stray color dots and speckles.
   * Adjust **Boundary Smoothing** (e.g., `Level 2`) to round circular features like eyes and sharpen shell margins.
5. **Check Paint Geometry:** Review the projection beside the color controls. If it exceeds the recommendation, **Trace Color Boundaries** switches off automatically. Leave existing-triangle painting selected, reduce the estimate with simplification/despeckle/Boundary Accuracy, or turn tracing back on and accept the unrestricted-export warning.
6. **Set Size:** Enter your desired **Target Print Size** (e.g., `150` mm).
7. **Export:** Set the top bar export dropdown to **`3MF (Painted Model)`**, select the target **Slicer** in Print Detail, and click **Export**.
8. **Slice:** Drop the `.3mf` into a compatible slicer such as **PrusaSlicer**, **Bambu Studio**, or **OrcaSlicer**. The model loads Z-up at the requested size, with its palette regions assigned to filament slots. Mesh defects already present in the source remain outside this app's scope.

---

## Attribution & Credits

Texture2Paint is a fork of the 3D browser viewer foundation developed by [Amal David](https://github.com/Amal-David) (`meshy2glb`). This project expands that foundation into a dedicated 3D printing preparation tool, introducing coverage-aware perceptual color quantization, interactive custom palette editing, connected-component despeckling, majority-mode contour smoothing, UV transform baking, and native multi-material 3MF compilation.

### Third-Party Libraries
- [three.js](https://threejs.org/) — 3D scene graph, WebGL rendering, and format exporters (MIT)
- [fflate](https://github.com/101arrowz/fflate) — High-performance client-side ZIP/3MF packaging (MIT)
- [meshoptimizer](https://github.com/zeux/meshoptimizer) — Geometry decompression and attribute-aware simplification (MIT)

---

## License

[MIT](./LICENSE)

## Included 3MF support

The browser code for 3MF handling is included in [src/vendor/three-mf](src/vendor/three-mf). It is part of the normal development and publishing workflow described above.
