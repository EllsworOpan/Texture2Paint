# Texture2Paint

Browser-based 3D model converter, texture-to-palette quantizer, and multi-color 3D printing prep tool. Drop in any textured 3D model, simplify its texture into discrete filament colors with live 3D preview, clean up noise and boundaries, and export directly as a multi-color **`.3mf`** for **PrusaSlicer**, **Bambu Studio**, and **OrcaSlicer**—or convert between common 3D formats.

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
- **Real-Time 3D Viewport Preview:** Quantization is accelerated by an in-memory 5-bit 3D Color LUT for smooth, interactive 60 FPS slider adjustments.
- **Interactive Swatch Editor & Eyedropper:** Click any color chip to open a color picker. Toggle quantization off to inspect the original texture and use your browser's eyedropper tool to sample colors directly from the 3D model.
- **Persistent Memory:** Toggling quantization on/off or expanding/trimming the color count preserves your custom color choices without resetting your work.
- **Dedicated Resample Button:** Re-run K-Means clustering only when you explicitly want a fresh, randomized palette from the model.

### 🧹 Texture & Contour Cleanup
- **Despeckle (Min Island Filter):** Connected-component filter that removes stray dots and color speckles smaller than your chosen pixel threshold (e.g. 50–500 px), merging them into surrounding colors to eliminate wasteful filament purge switches.
- **Boundary Smoothing:** Majority mode filter that smooths stair-stepped, pixelated color borders into clean contours and rounds out circular features (like eyes).
- **UV Orientation Control:** Lossless vertical UV inversion (`V = 1.0 - V`) toggle with live viewport updates.

### 🪄 Floating Decal Projection
- **Geometry-Aware Detection:** Finds disconnected, textured, zero-thickness surface components and ranks their likely receiving surfaces without relying on mesh or texture names.
- **Review Before Baking:** High-confidence sheets are selected automatically; ambiguous components remain available for manual source and receiver selection.
- **Curved-Surface Projection:** Surface-conforming mode follows each decal triangle's local plane and normal instead of forcing one direction through a curved sheet. Manual sheet-normal, receiver-normal, and closest-surface modes remain available. Affected continuous UV charts are remapped into dedicated high-resolution textures before compositing, preserving crisp decal detail without introducing per-triangle seams; genuinely overlapping UV layers remain isolated.
- **Clean WYSIWYG Output:** Successfully baked sheets are physically removed from the processed model. GLB, glTF, OBJ, STL, PLY, USDZ, and 3MF exporters all consume the same visible model snapshot, so backup geometry and hidden decal nodes are not serialized.

### 🖨️ Slicer-Ready Multi-Material 3MF Export
- **Native AMS & MMU Segmentation:** Writes `<m:colorgroup>`, `slic3rpe:mmu_segmentation`, and `paint_color` attributes directly onto the mesh.
- **Feature-Aware Boundary Tracing:** Converts quantized texel boundaries into shared mesh contours instead of uniformly resampling the surface. Boundary Accuracy defaults to `0` for an exact processed texel outline; larger values opt into contour simplification with per-face paint-preservation checks.
- **Watertight Manifold Topology (Zero Cracks):** Traces colors with original UVs first, propagates contour intersections across shared edges, then welds coincident vertices along UV seams into shared indices. Eliminates the non-manifold open-edge errors common with multi-body converters.
- **Z-Up Print Bed Alignment:** Automatically transforms models from Y-Up (web) to Z-Up (slicers) and grounds the lowest point flat to the build plate at $Z = 0$.
- **Configurable Scale:** Normalizes the model to your desired build size (default 150 mm) so it loads into your slicer at **100% scale** with no scaling warnings.

### 🌐 Universal 3D Viewer & Multi-Format Converter
- **Wide Import Support:** Accepts `.glb`, `.gltf`, `.obj`, `.stl`, `.ply`, `.dae`, `.3mf`, and `.fbx`.
- **Multi-Format Export:** Export your model as `.3mf` (Multi-Material), `.glb` (with embedded quantized or original textures), `.gltf`, `.obj`, `.stl`, `.ply`, or `.usdz`.
- **Interactive Viewport:** Orbit controls, exposure, environment intensity, ambient/directional lighting controls, wireframe mode, and dark/grey/white/black background presets.

---

## Supported Formats

| Format | Import | Export | Notes |
| :--- | :---: | :---: | :--- |
| **3MF** | ✅ | ✅ | Multi-material assembly with native Prusa/Bambu paint data |
| **GLB** | ✅ | ✅ | Binary glTF; embeds quantized canvas texture when enabled |
| **glTF** | ✅ | ✅ | JSON glTF with external buffer/image support |
| **OBJ** | ✅ | ✅ | Wavefront OBJ with material and vertex coordinate export |
| **STL** | ✅ | ✅ | Binary STL for standard single-color slicing |
| **PLY** | ✅ | ✅ | Polygon file format |
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
   * Or, turn quantization **OFF**, click a swatch, select the eyedropper tool, and sample colors directly from the original model in the 3D viewport. Turn quantization back **ON** to apply.
4. **Clean Up:**
   * Adjust **Despeckle** (e.g., `40–120 px`) to remove stray color dots and speckles.
   * Adjust **Boundary Smoothing** (e.g., `Level 2`) to round circular features like eyes and sharpen shell margins.
5. **Set Size:** Enter your desired **Target Print Size** (e.g., `150` mm).
6. **Export:** Set the top bar export dropdown to **`3MF (PrusaSlicer Multi-Color)`** and click **Export**.
7. **Slice:** Drop the `.3mf` into **PrusaSlicer**, **Bambu Studio**, or **OrcaSlicer**. The model will load onto the bed standing upright, at 100% scale, with zero non-manifold cracks and all colors assigned to separate filament slots.

---

## Attribution & Credits

Texture2Paint is a fork of the 3D browser viewer foundation developed by [Amal David](https://github.com/Amal-David) (`meshy2glb`). This project expands that foundation into a dedicated 3D printing preparation tool, introducing K-Means color quantization, interactive custom palette editing, connected-component despeckling, majority-mode contour smoothing, UV transform baking, and native multi-material 3MF compilation.

### Third-Party Libraries
- [three.js](https://threejs.org/) — 3D scene graph, WebGL rendering, and format exporters (MIT)
- [fflate](https://github.com/101arrowz/fflate) — High-performance client-side ZIP/3MF packaging (MIT)
- [meshoptimizer](https://github.com/zeux/meshoptimizer) — Geometry decompression support (MIT)

---

## License

[MIT](./LICENSE)
