// conditionalLinesFeatures.js
// Orchestrator for the conditional-lines toolchain (features 133-148).

import { EventDispatcher } from '../core/083_EventDispatcher.js';

// 133-148 imports
import { CombinedEdgesGeometry } from './133_CombinedEdgesGeometry.js';
import { TriangleIntersectionEdgesGeometry } from './134_TriangleIntersectionEdgesGeometry.js';
import { AttenuatedLineMaterial } from './135_AttenuatedLineMaterial.js';
import { CurvatureLineMaterial } from './136_CurvatureLineMaterial.js';
import { GPUConditionalEdges } from './137_GPUConditionalEdges.js';
import { CulledEdgesBatch } from './138_CulledEdgesBatch.js';
import { EdgesBufferUpdater } from './139_EdgesBufferUpdater.js';
import { VertexColorLineMaterial } from './140_VertexColorLineMaterial.js';
import { EdgeTypeTaggedGeometry } from './141_EdgeTypeTaggedGeometry.js';
import { ConditionalToonMaterial } from './142_ConditionalToonMaterial.js';
import { TIntersectionSplitter } from './143_TIntersectionSplitter.js';
import { ManifoldEdgeDetector } from './144_ManifoldEdgeDetector.js';
import { DoubleSidedOutsideEdges } from './145_DoubleSidedOutsideEdges.js';
import { ConditionalEdgesDebug } from './146_ConditionalEdgesDebug.js';
import { ConditionalEdgesBaker } from './147_ConditionalEdgesBaker.js';
import { MergedConditionalEdges } from './148_MergedConditionalEdges.js';

// Feature registry
const FEATURES = { ... };

// ... class ...

export { ConditionalLinesFeatures, FEATURES, CATEGORIES, PRESETS };
export default ConditionalLinesFeatures;