import type { Document } from "./document";
import type { LimitOptions } from "./limits";
/** Reference swatches, not measurements of a particular brand's filaments. */
export declare const VIRTUAL_EXTRUDER_PALETTE: readonly (Readonly<{
    name: "Cyan";
    color: "#00FFFF";
}> | Readonly<{
    name: "Magenta";
    color: "#FF00FF";
}> | Readonly<{
    name: "Yellow";
    color: "#FFFF00";
}> | Readonly<{
    name: "White";
    color: "#FFFFFF";
}> | Readonly<{
    name: "Black";
    color: "#000000";
}> | Readonly<{
    name: "Red";
    color: "#FF0000";
}> | Readonly<{
    name: "Green";
    color: "#00FF00";
}> | Readonly<{
    name: "Blue";
    color: "#0000FF";
}>)[];
export interface BlendComponent {
    /** One-based physical tool number. */
    extruder: number;
    ratio: number;
}
export interface RegionRecipe {
    /** Source document region; equal RGB values still have distinct region IDs. */
    region: number;
    /** One to three components; positive weights are normalized automatically. */
    components: BlendComponent[];
}
export interface VirtualExtruderOptions {
    /** Number of physical slots on the destination printer, from 2 through 8. */
    physicalExtruderCount: number;
    /** Optional measured/reference hex colors, one per physical slot in tool order. */
    physicalColors?: string[];
    /** Optional recipe overrides; omitted regions receive automatic starting recipes. */
    recipes?: RegionRecipe[];
}
export interface VirtualRegion {
    region: number;
    /** Exported native material ID, above all physical tools. */
    virtualExtruder: number;
    /** Desired/source color, used as the independently editable display swatch. */
    color: string;
    predictedColor: string;
    components: BlendComponent[];
    /** CIEDE2000 distance between desired and predicted color. */
    colorDifference: number;
}
export interface VirtualExtruderPlan {
    physicalExtruders: {
        id: number;
        name: string;
        color: string;
    }[];
    regions: VirtualRegion[];
    warnings: string[];
}
/** Preview/preflight only: never changes the document or allocates new geometry. */
export declare function planVirtualExtruders(document: Document, options: VirtualExtruderOptions, limits?: LimitOptions): VirtualExtruderPlan;
/** Internal: map source regions to native slots without cloning meshes. */
export declare function virtualizeDocument(document: Document, plan: VirtualExtruderPlan): Document;
/** Internal: material recipes are project data; no printer or filament profiles. */
export declare function attachVirtualExtruders(files: Record<string, Uint8Array>, plan: VirtualExtruderPlan): void;
