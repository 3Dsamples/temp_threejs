// File number : 011
// File : src/math/011_bitECS_serialization.js
// Description : Full bitECS serialization (all original exports preserved) + SOA-aware serializers
//               for 1M+ entity worlds. Adds: pooled byte-writer/reader, chunked async
//               serialize/deserialize for mobile-safe 60 fps, Float64 world-position codec for
//               seamless mm-to-Mpc persistence, per-entity TRS (position + quat + scale) SOA
//               serializer, orbital-element SOA serializer, IK-chain serializer (nested bones),
//               animation keyframe serializer, color/HDR SOA serializer, bounding-volume (AABB)
//               serializer, diff-stream serializer with Float32Array shadow, and streaming
//               snapshot writer that works with or without GPU instancing. Every operation is
//               zero-copy-friendly, yields to the UI thread on Android 64-bit, and reuses pooled
//               buffers.
// Best for : 3d graphics with bitECS -- procedural generation persistence (save/load 1M+ placed
//            asteroids/trees/particles with their TRS, orbital elements, colors, and bounding
//            volumes in one snapshot), rendering state (per-instance color/HDR, spot-state,
//            camera-state), animation state (keyframe curves, spring state), natural IK motion
//            (whole chains saved per bone), orbital mechanics (6-element state for 1M+ bodies at
//            galactic scale), color (per-entity HDR values across exposures), seamless
//            small-to-galactic persistence (Float64 world positions + relative-to-origin
//            encoding), networking / rollback (diff-stream and observer-based live sync at
//            60 fps), save/load between sessions with pooled buffers and no main-thread stalls.
// License : MIT
//
// NOTE: Rewritten as a self-contained native ES module (no Vite / no Vue / no client build) so it
//       loads directly in the browser alongside Three.js r185. The previous CommonJS build is
//       removed. All features, functions and exports of the original are preserved.

// ============================================================================
// 0. IMPORTS -- all previously produced math modules + bitECS core
// ============================================================================
import * as vec2 from "./002_vec2.js";
import * as vec3 from "./003_vec3.js";
import * as vec4 from "./004_vec4.js";
import * as mat2 from "./005_mat2.js";
import * as mat3 from "./006_mat3.js";
import * as mat4 from "./007_mat4.js";
import * as quat from "./008_quat.js";
import * as quat2 from "./009_quat2.js";
// bitECS core -- used by the snapshot/observer serializers
import * as bitecs from "./010_bitECS_core.js";

// ============================================================================
// 0b. FOUNDATION HELPERS (inlined, replaces require("./001_common.js"))
// ============================================================================
const CHUNK_SIZE = 65536;
const CHUNK_YIELD_EVERY = 8;

function yieldToMain() {
	return new Promise(function (resolve) {
		if (typeof setTimeout === "function") { setTimeout(resolve, 0); }
		else { resolve(); }
	});
}

function createPool(factory, capacity, reset) {
	capacity = capacity || 256;
	var items = [];
	for (var i = 0; i < capacity; i++) { items.push(factory()); }
	return {
		acquire: function () {
			return items.length > 0 ? items.pop() : factory();
		},
		release: function (v) {
			if (reset) { reset(v); }
			if (items.length < capacity) { items.push(v); }
		}
	};
}

// ============================================================================
// 1. TYPE TAGS (preserved -- every original export)
// ============================================================================
var $u8 = Symbol.for("bitecs-u8");
var $i8 = Symbol.for("bitecs-i8");
var $u16 = Symbol.for("bitecs-u16");
var $i16 = Symbol.for("bitecs-i16");
var $u32 = Symbol.for("bitecs-u32");
var $i32 = Symbol.for("bitecs-i32");
var $f32 = Symbol.for("bitecs-f32");
var $f64 = Symbol.for("bitecs-f64");
var $ref = Symbol.for("bitecs-ref");
var $str = Symbol.for("bitecs-str");
var $arr = Symbol.for("bitecs-arr");

var typeTagForSerialization = function (symbol) {
	return function (a) {
		a = a || [];
		return Object.defineProperty(a, symbol, {
			value: true, enumerable: false, writable: false, configurable: false
		});
	};
};

var u8 = function (a) { return typeTagForSerialization($u8)(a); };
var i8 = function (a) { return typeTagForSerialization($i8)(a); };
var u16 = function (a) { return typeTagForSerialization($u16)(a); };
var i16 = function (a) { return typeTagForSerialization($i16)(a); };
var u32 = function (a) { return typeTagForSerialization($u32)(a); };
var i32 = function (a) { return typeTagForSerialization($i32)(a); };
var f32 = function (a) { return typeTagForSerialization($f32)(a); };
var f64 = function (a) { return typeTagForSerialization($f64)(a); };
var ref = function (a) { return typeTagForSerialization($ref)(a); };
var str = function (a) { return typeTagForSerialization($str)(a); };

var textEncoder = new TextEncoder();
var textDecoder = new TextDecoder();

// ============================================================================
// 2. TYPE SETTERS / GETTERS (preserved)
// ============================================================================
var typeSetters = {};
typeSetters[$u8] = function (view, offset, value) { view.setUint8(offset, value); return 1; };
typeSetters[$i8] = function (view, offset, value) { view.setInt8(offset, value); return 1; };
typeSetters[$u16] = function (view, offset, value) { view.setUint16(offset, value); return 2; };
typeSetters[$i16] = function (view, offset, value) { view.setInt16(offset, value); return 2; };
typeSetters[$u32] = function (view, offset, value) { view.setUint32(offset, value); return 4; };
typeSetters[$i32] = function (view, offset, value) { view.setInt32(offset, value); return 4; };
typeSetters[$f32] = function (view, offset, value) { view.setFloat32(offset, value); return 4; };
typeSetters[$f64] = function (view, offset, value) { view.setFloat64(offset, value); return 8; };
typeSetters[$ref] = function (view, offset, value) { view.setUint32(offset, value); return 4; };
typeSetters[$str] = function (view, offset, value) {
	var bytes = textEncoder.encode(value);
	var written = 0;
	written += typeSetters[$u32](view, offset + written, bytes.length);
	new Uint8Array(view.buffer, view.byteOffset + offset + written, bytes.length).set(bytes);
	written += bytes.length;
	return written;
};

var typeGetters = {};
typeGetters[$u8] = function (view, offset) { return { value: view.getUint8(offset), size: 1 }; };
typeGetters[$i8] = function (view, offset) { return { value: view.getInt8(offset), size: 1 }; };
typeGetters[$u16] = function (view, offset) { return { value: view.getUint16(offset), size: 2 }; };
typeGetters[$i16] = function (view, offset) { return { value: view.getInt16(offset), size: 2 }; };
typeGetters[$u32] = function (view, offset) { return { value: view.getUint32(offset), size: 4 }; };
typeGetters[$i32] = function (view, offset) { return { value: view.getInt32(offset), size: 4 }; };
typeGetters[$f32] = function (view, offset) { return { value: view.getFloat32(offset), size: 4 }; };
typeGetters[$f64] = function (view, offset) { return { value: view.getFloat64(offset), size: 8 }; };
typeGetters[$ref] = function (view, offset) { return { value: view.getUint32(offset), size: 4 }; };
typeGetters[$str] = function (view, offset) {
	var r = typeGetters[$u32](view, offset);
	var bytes = new Uint8Array(view.buffer, view.byteOffset + offset + r.size, r.value);
	return { value: textDecoder.decode(bytes), size: r.size + r.value };
};

// ============================================================================
// 3. TYPE RESOLUTION (preserved)
// ============================================================================
var functionToSymbolMap = new Map([
	[u8, $u8], [i8, $i8], [u16, $u16], [i16, $i16], [u32, $u32], [i32, $i32],
	[f32, $f32], [f64, $f64], [ref, $ref], [str, $str]
]);

function isArrayType(value) {
	return Array.isArray(value) && $arr in value;
}

function array(type) {
	type = type || f64;
	var arr = [];
	Object.defineProperty(arr, $arr, {
		value: type, enumerable: false, writable: false, configurable: false
	});
	return arr;
}

function getArrayElementType(arrayType) { return arrayType[$arr]; }

function resolveTypeToSymbol(type) {
	if (typeof type === "symbol") return type;
	if (typeof type === "function") {
		var symbol = functionToSymbolMap.get(type);
		if (symbol) return symbol;
		throw new Error("Unknown type function: " + type);
	}
	if (isArrayType(type)) return resolveTypeToSymbol(type[$arr]);
	return $f32;
}

function isTypedArrayOrBranded(arr) {
	return arr && (ArrayBuffer.isView(arr) || (Array.isArray(arr) && typeof arr === "object"));
}

function getTypeForArray(arr) {
	if (isArrayType(arr)) return resolveTypeToSymbol(arr[$arr]);
	var symbols = [$u8, $i8, $u16, $i16, $u32, $i32, $f32, $f64, $str, $ref];
	for (var i = 0; i < symbols.length; i++) {
		if (symbols[i] in arr) return symbols[i];
	}
	if (arr instanceof Int8Array) return $i8;
	if (arr instanceof Uint8Array) return $u8;
	if (arr instanceof Int16Array) return $i16;
	if (arr instanceof Uint16Array) return $u16;
	if (arr instanceof Int32Array) return $i32;
	if (arr instanceof Uint32Array) return $u32;
	if (arr instanceof Float32Array) return $f32;
	return $f64;
}

// ============================================================================
// 4. NESTED ARRAY SERIALIZATION (preserved)
// ============================================================================
function serializeArrayValue(elementType, value, view, offset) {
	var bytesWritten = 0;
	var isArrayDefined = Array.isArray(value) ? 1 : 0;
	bytesWritten += typeSetters[$u8](view, offset, isArrayDefined);
	if (!isArrayDefined) return bytesWritten;
	bytesWritten += typeSetters[$u32](view, offset + bytesWritten, value.length);
	for (var i = 0; i < value.length; i++) {
		var element = value[i];
		if (isArrayType(elementType)) {
			bytesWritten += serializeArrayValue(getArrayElementType(elementType), element, view, offset + bytesWritten);
		} else {
			var symbol = resolveTypeToSymbol(elementType);
			bytesWritten += typeSetters[symbol](view, offset + bytesWritten, element);
		}
	}
	return bytesWritten;
}

function deserializeArrayValue(elementType, view, offset, entityIdMapping) {
	var bytesRead = 0;
	var isArrayResult = typeGetters[$u8](view, offset + bytesRead);
	bytesRead += isArrayResult.size;
	if (!isArrayResult.value) return { size: bytesRead };
	var lenResult = typeGetters[$u32](view, offset + bytesRead);
	bytesRead += lenResult.size;
	var arr = new Array(lenResult.value);
	for (var i = 0; i < arr.length; i++) {
		if (isArrayType(elementType)) {
			var sub = deserializeArrayValue(getArrayElementType(elementType), view, offset + bytesRead, entityIdMapping);
			bytesRead += sub.size;
			if (Array.isArray(sub.value)) arr[i] = sub.value;
		} else {
			var symbol = resolveTypeToSymbol(elementType);
			var r = typeGetters[symbol](view, offset + bytesRead);
			bytesRead += r.size;
			if (symbol === $ref) {
				arr[i] = entityIdMapping ? (entityIdMapping.get(r.value) != null ? entityIdMapping.get(r.value) : r.value) : r.value;
			} else {
				arr[i] = r.value;
			}
		}
	}
	return { value: arr, size: bytesRead };
}

// ============================================================================
// 5. DIFF SUPPORT (preserved)
// ============================================================================
var isFloatType = function (array2) {
	var arrayType = getTypeForArray(array2);
	return arrayType === $f32 || arrayType === $f64;
};

var getEpsilonForType = function (array2, epsilon) {
	return isFloatType(array2) ? epsilon : 0;
};

var getShadow = function (shadowMap, array2) {
	var shadow = shadowMap.get(array2);
	if (!shadow) {
		if (ArrayBuffer.isView(array2)) shadow = new array2.constructor(array2.length);
		else shadow = new Array(array2.length).fill(0);
		shadowMap.set(array2, shadow);
	}
	return shadow;
};

var hasChanged = function (shadowMap, array2, index, epsilon) {
	if (epsilon === undefined) epsilon = 1e-4;
	var shadow = getShadow(shadowMap, array2);
	var currentValue = array2[index];
	var actualEpsilon = getEpsilonForType(array2, epsilon);
	var changed = actualEpsilon > 0
		? Math.abs(shadow[index] - currentValue) > actualEpsilon
		: shadow[index] !== currentValue;
	shadow[index] = currentValue;
	return changed;
};

// ============================================================================
// 6. COMPONENT SERIALIZERS (preserved)
// ============================================================================
var createComponentSerializer = function (component, diff, shadowMap, epsilon) {
	if (diff === undefined) diff = false;
	if (epsilon === undefined) epsilon = 1e-4;

	if (isTypedArrayOrBranded(component)) {
		var type = getTypeForArray(component);
		var setter = typeSetters[type];
		return function (view, offset, index, componentId) {
			if (diff && shadowMap) {
				if (!hasChanged(shadowMap, component, index, epsilon)) return 0;
				var bytesWritten = 0;
				bytesWritten += typeSetters[$u32](view, offset + bytesWritten, index);
				bytesWritten += typeSetters[$u32](view, offset + bytesWritten, componentId);
				bytesWritten += setter(view, offset + bytesWritten, component[index]);
				return bytesWritten;
			}
			var bw = 0;
			bw += typeSetters[$u32](view, offset + bw, index);
			bw += setter(view, offset + bw, component[index]);
			return bw;
		};
	}

	var props = Object.keys(component);
	var types = props.map(function (prop) {
		var arr = component[prop];
		if (!isTypedArrayOrBranded(arr)) throw new Error("Invalid array type for property " + prop);
		return getTypeForArray(arr);
	});
	var setters = types.map(function (t) {
		return typeSetters[t] || function () { throw new Error("Unsupported or unannotated type"); };
	});

	return function (view, offset, index, componentId) {
		if (diff && shadowMap) {
			var changeMask = 0;
			for (var i = 0; i < props.length; i++) {
				if (hasChanged(shadowMap, component[props[i]], index, epsilon)) changeMask |= 1 << i;
			}
			if (changeMask === 0) return 0;
			var bw = 0;
			bw += typeSetters[$u32](view, offset + bw, index);
			bw += typeSetters[$u32](view, offset + bw, componentId);
			var maskSetter = props.length <= 8 ? typeSetters[$u8] : props.length <= 16 ? typeSetters[$u16] : typeSetters[$u32];
			bw += maskSetter(view, offset + bw, changeMask);
			for (var j = 0; j < props.length; j++) {
				if (changeMask & (1 << j)) {
					var p = component[props[j]];
					if (isArrayType(p)) bw += serializeArrayValue(getArrayElementType(p), p[index], view, offset + bw);
					else bw += setters[j](view, offset + bw, p[index]);
				}
			}
			return bw;
		}
		var b = 0;
		b += typeSetters[$u32](view, offset + b, index);
		for (var k = 0; k < props.length; k++) {
			var p2 = component[props[k]];
			if (isArrayType(p2)) b += serializeArrayValue(getArrayElementType(p2), p2[index], view, offset + b);
			else b += setters[k](view, offset + b, p2[index]);
		}
		return b;
	};
};

var createComponentDeserializer = function (component, diff) {
	if (diff === undefined) diff = false;

	if (isTypedArrayOrBranded(component)) {
		var type = getTypeForArray(component);
		var getter = typeGetters[type];
		return function (view, offset, entityIdMapping) {
			var bytesRead = 0;
			var r = typeGetters[$u32](view, offset);
			bytesRead += r.size;
			var originalIndex = r.value;
			var index = entityIdMapping ? (entityIdMapping.get(originalIndex) != null ? entityIdMapping.get(originalIndex) : originalIndex) : originalIndex;
			if (diff) {
				var cid = typeGetters[$u32](view, offset + bytesRead);
				bytesRead += cid.size;
			}
			var val = getter(view, offset + bytesRead);
			if (type === $ref) {
				component[index] = entityIdMapping ? (entityIdMapping.get(val.value) != null ? entityIdMapping.get(val.value) : val.value) : val.value;
			} else {
				component[index] = val.value;
			}
			return bytesRead + val.size;
		};
	}

	var props = Object.keys(component);
	var types = props.map(function (prop) {
		var arr = component[prop];
		if (!isTypedArrayOrBranded(arr)) throw new Error("Invalid array type for property " + prop);
		return getTypeForArray(arr);
	});
	var getters = types.map(function (t) {
		return typeGetters[t] || function () { throw new Error("Unsupported or unannotated type"); };
	});

	return function (view, offset, entityIdMapping) {
		var bytesRead = 0;
		var r = typeGetters[$u32](view, offset + bytesRead);
		bytesRead += r.size;
		var originalIndex = r.value;
		var index = entityIdMapping ? (entityIdMapping.get(originalIndex) != null ? entityIdMapping.get(originalIndex) : originalIndex) : originalIndex;
		if (diff) {
			var cid = typeGetters[$u32](view, offset + bytesRead);
			bytesRead += cid.size;
			var maskGetter = props.length <= 8 ? typeGetters[$u8] : props.length <= 16 ? typeGetters[$u16] : typeGetters[$u32];
			var m = maskGetter(view, offset + bytesRead);
			bytesRead += m.size;
			var changeMask = m.value;
			for (var i = 0; i < props.length; i++) {
				if (changeMask & (1 << i)) {
					var p = component[props[i]];
					if (isArrayType(p)) {
						var sub = deserializeArrayValue(getArrayElementType(p), view, offset + bytesRead, entityIdMapping);
						if (Array.isArray(sub.value)) p[index] = sub.value;
						bytesRead += sub.size;
					} else {
						var g = getters[i](view, offset + bytesRead);
						if (types[i] === $ref) component[props[i]][index] = entityIdMapping ? (entityIdMapping.get(g.value) != null ? entityIdMapping.get(g.value) : g.value) : g.value;
						else component[props[i]][index] = g.value;
						bytesRead += g.size;
					}
				}
			}
		} else {
			for (var j = 0; j < props.length; j++) {
				var p2 = component[props[j]];
				if (isArrayType(p2)) {
					var sub2 = deserializeArrayValue(getArrayElementType(p2), view, offset + bytesRead, entityIdMapping);
					if (Array.isArray(sub2.value)) p2[index] = sub2.value;
					bytesRead += sub2.size;
				} else {
					var g2 = getters[j](view, offset + bytesRead);
					if (types[j] === $ref) component[props[j]][index] = entityIdMapping ? (entityIdMapping.get(g2.value) != null ? entityIdMapping.get(g2.value) : g2.value) : g2.value;
					else component[props[j]][index] = g2.value;
					bytesRead += g2.size;
				}
			}
		}
		return bytesRead;
	};
};

// ============================================================================
// 7. SoA SERIALIZER (preserved)
// ============================================================================
var createSoASerializer = function (components, options) {
	options = options || {};
	var diff = options.diff !== undefined ? options.diff : false;
	var buffer = options.buffer || new ArrayBuffer(1024 * 1024 * 100);
	var epsilon = options.epsilon !== undefined ? options.epsilon : 1e-4;
	var view = new DataView(buffer);
	var shadowMap = diff ? new Map() : undefined;
	var componentSerializers = components.map(function (c) { return createComponentSerializer(c, diff, shadowMap, epsilon); });
	return function (indices) {
		var offset = 0;
		for (var i = 0; i < indices.length; i++) {
			var idx = indices[i];
			for (var j = 0; j < componentSerializers.length; j++) {
				offset += componentSerializers[j](view, offset, idx, j);
			}
		}
		return buffer.slice(0, offset);
	};
};

var createSoADeserializer = function (components, options) {
	options = options || {};
	var diff = options.diff !== undefined ? options.diff : false;
	var componentDeserializers = components.map(function (c) { return createComponentDeserializer(c, diff); });
	return function (packet, entityIdMapping) {
		var view = new DataView(packet);
		var offset = 0;
		while (offset < packet.byteLength) {
			if (diff) {
				var e = typeGetters[$u32](view, offset);
				var c = typeGetters[$u32](view, offset + e.size);
				offset += componentDeserializers[c.value](view, offset, entityIdMapping);
			} else {
				for (var i = 0; i < componentDeserializers.length; i++) {
					offset += componentDeserializers[i](view, offset, entityIdMapping);
				}
			}
		}
	};
};

// ============================================================================
// 8. AoS SERIALIZER (preserved)
// ============================================================================
var isFloatType2 = function (array2) {
	var t = getTypeForArray(array2);
	return t === $f32 || t === $f64;
};

var getEpsilonForType2 = function (array2, epsilon) {
	return isFloatType2(array2) ? epsilon : 0;
};

var getShadowComponent = function (shadowMap, component) {
	var shadow = shadowMap.get(component);
	if (!shadow) { shadow = []; shadowMap.set(component, shadow); }
	return shadow;
};

var hasComponentChanged = function (shadowMap, component, entityId, epsilon) {
	var shadow = getShadowComponent(shadowMap, component);
	var currentValue = component[entityId];
	var shadowValue = shadow[entityId];
	if (currentValue === void 0) return false;
	if (shadowValue === void 0) return true;
	if (typeof currentValue === "object" && currentValue !== null) {
		for (var prop in currentValue) {
			if (component[prop]) {
				var pe = getEpsilonForType2(component[prop], epsilon);
				var changed = pe > 0
					? Math.abs(shadowValue[prop] - currentValue[prop]) > pe
					: shadowValue[prop] !== currentValue[prop];
				if (changed) return true;
			}
		}
		return false;
	}
	var ve = getEpsilonForType2(component, epsilon);
	return ve > 0 ? Math.abs(shadowValue - currentValue) > ve : shadowValue !== currentValue;
};

var updateShadow = function (shadowMap, component, entityId) {
	var shadow = getShadowComponent(shadowMap, component);
	var currentValue = component[entityId];
	if (typeof currentValue === "object" && currentValue !== null) shadow[entityId] = Object.assign({}, currentValue);
	else shadow[entityId] = currentValue;
};

var createAoSComponentSerializer = function (component, diff, shadowMap, epsilon) {
	if (epsilon === undefined) epsilon = 1e-4;
	var isObjectComponent = typeof component === "object" && Object.keys(component).some(function (k) {
		return isNaN(parseInt(k)) && typeof component[k] === "object";
	});

	if (isObjectComponent) {
		var props = Object.keys(component).filter(function (k) { return isNaN(parseInt(k)); });
		var types = props.map(function (p) { return getTypeForArray(component[p]); });
		var setters = types.map(function (t) { return typeSetters[t]; });
		return function (view, offset, entityId) {
			var value = component[entityId];
			if (value === void 0) return 0;
			if (diff && shadowMap) {
				if (!hasComponentChanged(shadowMap, component, entityId, epsilon)) return 0;
				updateShadow(shadowMap, component, entityId);
			}
			var bw = 0;
			for (var i = 0; i < props.length; i++) {
				var p = component[props[i]];
				var pv = value[props[i]];
				if (isArrayType(p)) bw += serializeArrayValue(getArrayElementType(p), pv, view, offset + bw);
				else bw += setters[i](view, offset + bw, pv);
			}
			return bw;
		};
	}

	var type = getTypeForArray(component);
	var setter = typeSetters[type];
	return function (view, offset, entityId) {
		var value = component[entityId];
		if (value === void 0) return 0;
		if (diff && shadowMap) {
			if (!hasComponentChanged(shadowMap, component, entityId, epsilon)) return 0;
			updateShadow(shadowMap, component, entityId);
		}
		return setter(view, offset, value);
	};
};

var createAoSComponentDeserializer = function (component) {
	var isObjectComponent = typeof component === "object" && Object.keys(component).some(function (k) {
		return isNaN(parseInt(k)) && typeof component[k] === "object";
	});

	if (isObjectComponent) {
		var props = Object.keys(component).filter(function (k) { return isNaN(parseInt(k)); });
		var types = props.map(function (p) { return getTypeForArray(component[p]); });
		var getters = types.map(function (t) { return typeGetters[t]; });
		return function (view, offset, entityId, entityIdMapping) {
			var bytesRead = 0;
			var value = {};
			for (var i = 0; i < props.length; i++) {
				var p = component[props[i]];
				if (isArrayType(p)) {
					var sub = deserializeArrayValue(getArrayElementType(p), view, offset + bytesRead, entityIdMapping);
					if (Array.isArray(sub.value)) value[props[i]] = sub.value;
					bytesRead += sub.size;
				} else {
					var g = getters[i](view, offset + bytesRead);
					if (types[i] === $ref) value[props[i]] = entityIdMapping ? (entityIdMapping.get(g.value) != null ? entityIdMapping.get(g.value) : g.value) : g.value;
					else value[props[i]] = g.value;
					bytesRead += g.size;
				}
			}
			component[entityId] = value;
			return bytesRead;
		};
	}

	var type = getTypeForArray(component);
	var getter = typeGetters[type];
	return function (view, offset, entityId, entityIdMapping) {
		var r = getter(view, offset);
		if (type === $ref) component[entityId] = entityIdMapping ? (entityIdMapping.get(r.value) != null ? entityIdMapping.get(r.value) : r.value) : r.value;
		else component[entityId] = r.value;
		return r.size;
	};
};

var createAoSSerializer = function (components, options) {
	options = options || {};
	var diff = options.diff !== undefined ? options.diff : false;
	var buffer = options.buffer || new ArrayBuffer(1024 * 1024 * 100);
	var epsilon = options.epsilon !== undefined ? options.epsilon : 1e-4;
	var view = new DataView(buffer);
	var shadowMap = diff ? new Map() : undefined;
	var componentSerializers = components.map(function (c) { return createAoSComponentSerializer(c, diff, shadowMap, epsilon); });
	return function (entityIds) {
		var offset = 0;
		for (var i = 0; i < entityIds.length; i++) {
			var entityId = entityIds[i];
			if (diff) {
				var entityHasChanges = false;
				for (var j = 0; j < components.length; j++) {
					if (shadowMap && hasComponentChanged(shadowMap, components[j], entityId, epsilon)) { entityHasChanges = true; break; }
				}
				if (!entityHasChanges) continue;
				offset += typeSetters[$u32](view, offset, entityId);
				var maskOffset = offset;
				var maskSetter = components.length <= 8 ? typeSetters[$u8] : components.length <= 16 ? typeSetters[$u16] : typeSetters[$u32];
				offset += (components.length <= 8 ? 1 : components.length <= 16 ? 2 : 4);
				var componentMask = 0;
				for (var k = 0; k < componentSerializers.length; k++) {
					var bw = componentSerializers[k](view, offset, entityId);
					if (bw > 0) { componentMask |= 1 << k; offset += bw; }
				}
				maskSetter(view, maskOffset, componentMask);
			} else {
				offset += typeSetters[$u32](view, offset, entityId);
				for (var m = 0; m < componentSerializers.length; m++) {
					offset += componentSerializers[m](view, offset, entityId);
				}
			}
		}
		return buffer.slice(0, offset);
	};
};

var createAoSDeserializer = function (components, options) {
	options = options || {};
	var diff = options.diff !== undefined ? options.diff : false;
	var componentDeserializers = components.map(function (c) { return createAoSComponentDeserializer(c); });
	return function (packet, entityIdMapping) {
		var view = new DataView(packet);
		var offset = 0;
		while (offset < packet.byteLength) {
			var e = typeGetters[$u32](view, offset);
			offset += e.size;
			var entityId = entityIdMapping ? (entityIdMapping.get(e.value) != null ? entityIdMapping.get(e.value) : e.value) : e.value;
			if (diff) {
				var maskGetter = components.length <= 8 ? typeGetters[$u8] : components.length <= 16 ? typeGetters[$u16] : typeGetters[$u32];
				var m = maskGetter(view, offset);
				offset += m.size;
				for (var i = 0; i < components.length; i++) {
					if (m.value & (1 << i)) offset += componentDeserializers[i](view, offset, entityId, entityIdMapping);
				}
			} else {
				for (var j = 0; j < componentDeserializers.length; j++) {
					offset += componentDeserializers[j](view, offset, entityId, entityIdMapping);
				}
			}
		}
	};
};

// ============================================================================
// 9. RELATION DATA (preserved)
// ============================================================================
function serializeRelationData(data, eid, dataView, offset) {
	if (!data) return offset;
	if (Array.isArray(data)) {
		var value = data[eid];
		if (value !== void 0) {
			if ($ref in data) { dataView.setUint32(offset, value); return offset + 4; }
			dataView.setFloat64(offset, value);
			return offset + 8;
		}
		return offset;
	}
	if (typeof data === "object") {
		var keys = Object.keys(data).sort();
		for (var i = 0; i < keys.length; i++) {
			var arr = data[keys[i]];
			var v = arr[eid];
			if (v === void 0) continue;
			if (arr instanceof Int8Array || $i8 in arr) { dataView.setInt8(offset, v); offset += 1; }
			else if (arr instanceof Uint8Array || $u8 in arr) { dataView.setUint8(offset, v); offset += 1; }
			else if (arr instanceof Int16Array || $i16 in arr) { dataView.setInt16(offset, v); offset += 2; }
			else if (arr instanceof Uint16Array || $u16 in arr) { dataView.setUint16(offset, v); offset += 2; }
			else if (arr instanceof Int32Array || $i32 in arr) { dataView.setInt32(offset, v); offset += 4; }
			else if (arr instanceof Uint32Array || $u32 in arr || $ref in arr) { dataView.setUint32(offset, v); offset += 4; }
			else if (arr instanceof Float32Array || $f32 in arr) { dataView.setFloat32(offset, v); offset += 4; }
			else { dataView.setFloat64(offset, v); offset += 8; }
		}
	}
	return offset;
}

function deserializeRelationData(data, eid, dataView, offset, entityIdMapping) {
	if (!data) return offset;
	if (Array.isArray(data)) {
		if ($ref in data) {
			var v = dataView.getUint32(offset);
			data[eid] = entityIdMapping ? (entityIdMapping.get(v) != null ? entityIdMapping.get(v) : v) : v;
			return offset + 4;
		}
		data[eid] = dataView.getFloat64(offset);
		return offset + 8;
	}
	if (typeof data === "object") {
		var keys = Object.keys(data).sort();
		for (var i = 0; i < keys.length; i++) {
			var arr = data[keys[i]];
			if (arr instanceof Int8Array || $i8 in arr) { arr[eid] = dataView.getInt8(offset); offset += 1; }
			else if (arr instanceof Uint8Array || $u8 in arr) { arr[eid] = dataView.getUint8(offset); offset += 1; }
			else if (arr instanceof Int16Array || $i16 in arr) { arr[eid] = dataView.getInt16(offset); offset += 2; }
			else if (arr instanceof Uint16Array || $u16 in arr) { arr[eid] = dataView.getUint16(offset); offset += 2; }
			else if (arr instanceof Int32Array || $i32 in arr) { arr[eid] = dataView.getInt32(offset); offset += 4; }
			else if (arr instanceof Uint32Array || $u32 in arr || $ref in arr) {
				var vv = dataView.getUint32(offset);
				arr[eid] = $ref in arr ? (entityIdMapping ? (entityIdMapping.get(vv) != null ? entityIdMapping.get(vv) : vv) : vv) : vv;
				offset += 4;
			}
			else if (arr instanceof Float32Array || $f32 in arr) { arr[eid] = dataView.getFloat32(offset); offset += 4; }
			else { arr[eid] = dataView.getFloat64(offset); offset += 8; }
		}
	}
	return offset;
}

// ============================================================================
// 10. SNAPSHOT SERIALIZER (preserved)
// ============================================================================
var createSnapshotSerializer = function (world, components, buffer) {
	buffer = buffer || new ArrayBuffer(1024 * 1024 * 100);
	var dataView = new DataView(buffer);
	var offset = 0;

	var serializeEntityComponentRelationships = function (entities) {
		var entityCount = entities.length;
		dataView.setUint32(offset, entityCount);
		offset += 4;
		for (var i = 0; i < entityCount; i++) {
			var entityId = entities[i];
			var componentCount = 0;
			dataView.setUint32(offset, entityId);
			offset += 4;
			var componentCountOffset = offset;
			offset += 1;
			for (var j = 0; j < components.length; j++) {
				var component = components[j];
				if (bitecs.isRelation(component)) {
					var targets = bitecs.getRelationTargets(world, entityId, component);
					for (var t = 0; t < targets.length; t++) {
						dataView.setUint8(offset, j); offset += 1;
						dataView.setUint32(offset, targets[t]); offset += 4;
						var relationData = component(targets[t]);
						offset = serializeRelationData(relationData, entityId, dataView, offset);
						componentCount++;
					}
				} else if (bitecs.hasComponent(world, entityId, component)) {
					dataView.setUint8(offset, j); offset += 1;
					componentCount++;
				}
			}
			dataView.setUint8(componentCountOffset, componentCount);
		}
	};

	var serializeComponentData = function (entities) {
		var soaSerializer = createSoASerializer(components, { buffer: buffer.slice(offset) });
		var componentData = soaSerializer(entities);
		new Uint8Array(buffer).set(new Uint8Array(componentData), offset);
		offset += componentData.byteLength;
	};

	return function (selectedEntities) {
		offset = 0;
		var entities = selectedEntities || bitecs.getAllEntities(world);
		serializeEntityComponentRelationships(entities);
		serializeComponentData(entities);
		return buffer.slice(0, offset);
	};
};

var createSnapshotDeserializer = function (world, components, idMap) {
	var entityIdMapping = idMap || new Map();
	var soaDeserializer = createSoADeserializer(components);
	return function (packet, idMapOverride) {
		var currentMapping = idMapOverride || entityIdMapping;
		var dataView = new DataView(packet);
		var offset = 0;
		var entityCount = dataView.getUint32(offset); offset += 4;
		for (var i = 0; i < entityCount; i++) {
			var packetEntityId = dataView.getUint32(offset); offset += 4;
			var worldEntityId = currentMapping.get(packetEntityId);
			if (worldEntityId === void 0) {
				worldEntityId = bitecs.addEntity(world);
				currentMapping.set(packetEntityId, worldEntityId);
			}
			var componentCount = dataView.getUint8(offset); offset += 1;
			for (var j = 0; j < componentCount; j++) {
				var componentIndex = dataView.getUint8(offset); offset += 1;
				var component = components[componentIndex];
				if (bitecs.isRelation(component)) {
					var targetId = dataView.getUint32(offset); offset += 4;
					var worldTargetId = currentMapping.get(targetId);
					if (worldTargetId === void 0) {
						worldTargetId = bitecs.addEntity(world);
						currentMapping.set(targetId, worldTargetId);
					}
					var rc = component(worldTargetId);
					bitecs.addComponent(world, worldEntityId, rc);
					offset = deserializeRelationData(rc, worldEntityId, dataView, offset, currentMapping);
				} else {
					bitecs.addComponent(world, worldEntityId, component);
				}
			}
		}
		soaDeserializer(packet.slice(offset), currentMapping);
		return currentMapping;
	};
};

// ============================================================================
// 11. OBSERVER SERIALIZER (preserved)
// ============================================================================
var createObserverSerializer = function (world, networkedTag, components, options) {
	options = options || {};
	var backingBuffer = options.buffer || new ArrayBuffer(1024 * 1024 * 100);
	var dataView = new DataView(backingBuffer);
	var offset = 0;
	var queue = [];
	var relationTargets = new Map();

	bitecs.observe(world, bitecs.onAdd(networkedTag), function (eid) { queue.push([eid, 0, -1]); });
	bitecs.observe(world, bitecs.onRemove(networkedTag), function (eid) { queue.push([eid, 1, -1]); relationTargets.delete(eid); });

	components.forEach(function (component, i) {
		if (bitecs.isRelation(component)) {
			bitecs.observe(world, bitecs.onAdd(networkedTag, component(bitecs.Wildcard)), function (eid) {
				var targets = bitecs.getRelationTargets(world, eid, component);
				for (var t = 0; t < targets.length; t++) {
					if (!relationTargets.has(eid)) relationTargets.set(eid, new Map());
					relationTargets.get(eid).set(i, targets[t]);
					queue.push([eid, 4, i, targets[t], component(targets[t])]);
				}
			});
			bitecs.observe(world, bitecs.onRemove(networkedTag, component(bitecs.Wildcard)), function (eid) {
				var m = relationTargets.get(eid);
				if (!m) return;
				var target = m.get(i);
				if (target !== void 0) {
					queue.push([eid, 5, i, target]);
					m.delete(i);
					if (m.size === 0) relationTargets.delete(eid);
				}
			});
		} else {
			bitecs.observe(world, bitecs.onAdd(networkedTag, component), function (eid) { queue.push([eid, 2, i]); });
			bitecs.observe(world, bitecs.onRemove(networkedTag, component), function (eid) { queue.push([eid, 3, i]); });
		}
	});

	return function () {
		offset = 0;
		for (var i = 0; i < queue.length; i++) {
			var item = queue[i];
			var entityId = item[0], type = item[1], componentId = item[2], targetId = item[3], relationData = item[4];
			dataView.setUint32(offset, entityId); offset += 4;
			dataView.setUint8(offset, type); offset += 1;
			if (type === 2 || type === 3 || type === 4 || type === 5) {
				dataView.setUint8(offset, componentId); offset += 1;
				if (type === 4 || type === 5) {
					dataView.setUint32(offset, targetId); offset += 4;
					if (type === 4 && relationData) offset = serializeRelationData(relationData, entityId, dataView, offset);
				}
			}
		}
		queue.length = 0;
		return backingBuffer.slice(0, offset);
	};
};

var createObserverDeserializer = function (world, networkedTag, components, options) {
	options = options || {};
	var entityIdMapping = options.idMap || new Map();
	return function (packet, idMap) {
		var currentMapping = idMap || entityIdMapping;
		var dataView = new DataView(packet);
		var offset = 0;
		while (offset < packet.byteLength) {
			var packetEntityId = dataView.getUint32(offset); offset += 4;
			var op = dataView.getUint8(offset); offset += 1;
			var componentId = -1, targetId = -1;
			if (op === 2 || op === 3 || op === 4 || op === 5) {
				componentId = dataView.getUint8(offset); offset += 1;
				if (op === 4 || op === 5) {
					targetId = dataView.getUint32(offset); offset += 4;
				}
			}
			var component = components[componentId];
			var worldEntityId = currentMapping.get(packetEntityId);
			if (op === 0) {
				if (worldEntityId === void 0) {
					worldEntityId = bitecs.addEntity(world);
					currentMapping.set(packetEntityId, worldEntityId);
					bitecs.addComponent(world, worldEntityId, networkedTag);
				}
			} else if (worldEntityId !== void 0 && bitecs.entityExists(world, worldEntityId)) {
				if (op === 1) {
					bitecs.removeEntity(world, worldEntityId);
					currentMapping.delete(packetEntityId);
				} else if (op === 2) {
					bitecs.addComponent(world, worldEntityId, component);
				} else if (op === 3) {
					bitecs.removeComponent(world, worldEntityId, component);
				} else if (op === 4) {
					var worldTargetId = currentMapping.get(targetId);
					if (worldTargetId !== void 0) {
						var rc = component(worldTargetId);
						bitecs.addComponent(world, worldEntityId, rc);
						offset = deserializeRelationData(rc, worldEntityId, dataView, offset, currentMapping);
					}
				} else if (op === 5) {
					var wt = currentMapping.get(targetId);
					if (wt !== void 0) bitecs.removeComponent(world, worldEntityId, component(wt));
				}
			}
		}
		return currentMapping;
	};
};

// ============================================================================
// 12. POOLED BYTE WRITER / READER -- zero-GC buffer reuse for 1M+ entities
// ============================================================================
var _byteWriterPool = createPool(
	function () { return { buffer: new ArrayBuffer(1 << 20), view: null, offset: 0 }; },
	8,
	function (w) { w.offset = 0; }
);

function createByteWriter(initialBytes) {
	initialBytes = initialBytes || (1 << 20);
	var w = _byteWriterPool.acquire();
	if (w.buffer.byteLength < initialBytes) {
		w.buffer = new ArrayBuffer(initialBytes);
	}
	w.view = new DataView(w.buffer);
	w.offset = 0;

	var writerObj = {
		view: w.view,
		buffer: w.buffer,
		get offset() { return w.offset; },
		ensure: function (extraBytes) {
			if (w.offset + extraBytes <= w.buffer.byteLength) return;
			var newSize = Math.max(w.buffer.byteLength * 2, w.offset + extraBytes);
			var nb = new ArrayBuffer(newSize);
			new Uint8Array(nb).set(new Uint8Array(w.buffer));
			w.buffer = nb;
			w.view = new DataView(nb);
			writerObj.view = w.view;
			writerObj.buffer = w.buffer;
		},
		writeU8: function (v) { writerObj.ensure(1); w.view.setUint8(w.offset, v); w.offset += 1; },
		writeI8: function (v) { writerObj.ensure(1); w.view.setInt8(w.offset, v); w.offset += 1; },
		writeU16: function (v) { writerObj.ensure(2); w.view.setUint16(w.offset, v); w.offset += 2; },
		writeI16: function (v) { writerObj.ensure(2); w.view.setInt16(w.offset, v); w.offset += 2; },
		writeU32: function (v) { writerObj.ensure(4); w.view.setUint32(w.offset, v); w.offset += 4; },
		writeI32: function (v) { writerObj.ensure(4); w.view.setInt32(w.offset, v); w.offset += 4; },
		writeF32: function (v) { writerObj.ensure(4); w.view.setFloat32(w.offset, v); w.offset += 4; },
		writeF64: function (v) { writerObj.ensure(8); w.view.setFloat64(w.offset, v); w.offset += 8; },
		writeBytes: function (bytes) {
			writerObj.ensure(bytes.byteLength);
			new Uint8Array(w.buffer, w.offset, bytes.byteLength).set(bytes);
			w.offset += bytes.byteLength;
		},
		slice: function () { return w.buffer.slice(0, w.offset); },
		reset: function () { w.offset = 0; },
		release: function () { w.view = null; _byteWriterPool.release(w); }
	};
	return writerObj;
}

function createByteReader(packet) {
	var view = new DataView(packet);
	var offset = 0;
	return {
		view: view,
		packet: packet,
		get offset() { return offset; },
		get remaining() { return packet.byteLength - offset; },
		readU8: function () { var v = view.getUint8(offset); offset += 1; return v; },
		readI8: function () { var v = view.getInt8(offset); offset += 1; return v; },
		readU16: function () { var v = view.getUint16(offset); offset += 2; return v; },
		readI16: function () { var v = view.getInt16(offset); offset += 2; return v; },
		readU32: function () { var v = view.getUint32(offset); offset += 4; return v; },
		readI32: function () { var v = view.getInt32(offset); offset += 4; return v; },
		readF32: function () { var v = view.getFloat32(offset); offset += 4; return v; },
		readF64: function () { var v = view.getFloat64(offset); offset += 8; return v; },
		readBytes: function (n) { var v = new Uint8Array(packet, offset, n); offset += n; return v; }
	};
}

// ============================================================================
// 13. TRS SOA SERIALIZER -- save/load 1M+ entity transforms in one pass
// ============================================================================
var TRS_STRIDE = 44;
var TRS_STRIDE_F64 = 56;

function createTRSSOASerializer(options) {
	options = options || {};
	var worldCoords = options.worldCoords === true;
	var stride = worldCoords ? TRS_STRIDE_F64 : TRS_STRIDE;
	return function (writer, eids, trs) {
		var n = eids.length;
		var px = trs.position.x, py = trs.position.y, pz = trs.position.z;
		var qx = trs.rotation.x, qy = trs.rotation.y, qz = trs.rotation.z, qw = trs.rotation.w;
		var sx = trs.scale.x, sy = trs.scale.y, sz = trs.scale.z;
		writer.ensure(n * stride);
		for (var i = 0; i < n; i++) {
			writer.writeU32(eids[i]);
			if (worldCoords) {
				writer.writeF64(px[i]); writer.writeF64(py[i]); writer.writeF64(pz[i]);
			} else {
				writer.writeF32(px[i]); writer.writeF32(py[i]); writer.writeF32(pz[i]);
			}
			writer.writeF32(qx[i]); writer.writeF32(qy[i]); writer.writeF32(qz[i]); writer.writeF32(qw[i]);
			writer.writeF32(sx[i]); writer.writeF32(sy[i]); writer.writeF32(sz[i]);
		}
		return writer;
	};
}

function createTRSSOADeserializer(options) {
	options = options || {};
	var worldCoords = options.worldCoords === true;
	var stride = worldCoords ? TRS_STRIDE_F64 : TRS_STRIDE;
	return function (reader, trs, entityIdMapping, outEids) {
		var px = trs.position.x, py = trs.position.y, pz = trs.position.z;
		var qx = trs.rotation.x, qy = trs.rotation.y, qz = trs.rotation.z, qw = trs.rotation.w;
		var sx = trs.scale.x, sy = trs.scale.y, sz = trs.scale.z;
		var i = 0;
		var max = Math.floor(reader.remaining / stride);
		for (var k = 0; k < max; k++) {
			var eid = reader.readU32();
			var idx = entityIdMapping ? (entityIdMapping.get(eid) != null ? entityIdMapping.get(eid) : eid) : eid;
			if (outEids) outEids[i] = idx;
			if (worldCoords) {
				px[i] = reader.readF64(); py[i] = reader.readF64(); pz[i] = reader.readF64();
			} else {
				px[i] = reader.readF32(); py[i] = reader.readF32(); pz[i] = reader.readF32();
			}
			qx[i] = reader.readF32(); qy[i] = reader.readF32(); qz[i] = reader.readF32(); qw[i] = reader.readF32();
			sx[i] = reader.readF32(); sy[i] = reader.readF32(); sz[i] = reader.readF32();
			i++;
		}
		return i;
	};
}

// Returns an async function directly (no outer async wrapper).
function createTRSSOASerializerChunked(options) {
	var worldCoords = (options && options.worldCoords) === true;
	var stride = worldCoords ? TRS_STRIDE_F64 : TRS_STRIDE;
	return async function (writer, eids, trs, chunkSize, yieldEvery) {
		chunkSize = chunkSize || CHUNK_SIZE;
		yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
		var n = eids.length;
		var px = trs.position.x, py = trs.position.y, pz = trs.position.z;
		var qx = trs.rotation.x, qy = trs.rotation.y, qz = trs.rotation.z, qw = trs.rotation.w;
		var sx = trs.scale.x, sy = trs.scale.y, sz = trs.scale.z;
		var c = 0;
		for (var start = 0; start < n; start += chunkSize) {
			var end = Math.min(start + chunkSize, n);
			writer.ensure((end - start) * stride);
			for (var i = start; i < end; i++) {
				writer.writeU32(eids[i]);
				if (worldCoords) { writer.writeF64(px[i]); writer.writeF64(py[i]); writer.writeF64(pz[i]); }
				else { writer.writeF32(px[i]); writer.writeF32(py[i]); writer.writeF32(pz[i]); }
				writer.writeF32(qx[i]); writer.writeF32(qy[i]); writer.writeF32(qz[i]); writer.writeF32(qw[i]);
				writer.writeF32(sx[i]); writer.writeF32(sy[i]); writer.writeF32(sz[i]);
			}
			if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
		}
		return writer;
	};
}

// ============================================================================
// 14. ORBITAL ELEMENT SOA SERIALIZER -- 6 Keplerian elements + clock
// ============================================================================
var ORBITAL_STRIDE = 4 + 6 * 8; // eid + (a,e,M,inc,Om,om) as Float64 = 52 bytes/body

function createOrbitalSOASerializer() {
	return function (writer, eids, elements) {
		var n = eids.length;
		writer.ensure(n * ORBITAL_STRIDE);
		var a = elements.a, e = elements.e, M = elements.M;
		var inc = elements.inc, Om = elements.Om, om = elements.om;
		for (var i = 0; i < n; i++) {
			writer.writeU32(eids[i]);
			writer.writeF64(a[i]); writer.writeF64(e[i]); writer.writeF64(M[i]);
			writer.writeF64(inc[i]); writer.writeF64(Om[i]); writer.writeF64(om[i]);
		}
		return writer;
	};
}

function createOrbitalSOADeserializer() {
	return function (reader, elements, entityIdMapping, outEids) {
		var a = elements.a, e = elements.e, M = elements.M;
		var inc = elements.inc, Om = elements.Om, om = elements.om;
		var i = 0;
		var max = Math.floor(reader.remaining / ORBITAL_STRIDE);
		for (var k = 0; k < max; k++) {
			var eid = reader.readU32();
			var idx = entityIdMapping ? (entityIdMapping.get(eid) != null ? entityIdMapping.get(eid) : eid) : eid;
			if (outEids) outEids[i] = idx;
			a[i] = reader.readF64(); e[i] = reader.readF64(); M[i] = reader.readF64();
			inc[i] = reader.readF64(); Om[i] = reader.readF64(); om[i] = reader.readF64();
			i++;
		}
		return i;
	};
}

// Returns an async function directly (no outer async wrapper).
function createOrbitalSOASerializerChunked() {
	return async function (writer, eids, elements, chunkSize, yieldEvery) {
		chunkSize = chunkSize || CHUNK_SIZE;
		yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
		var n = eids.length, c = 0;
		for (var start = 0; start < n; start += chunkSize) {
			var end = Math.min(start + chunkSize, n);
			writer.ensure((end - start) * ORBITAL_STRIDE);
			for (var i = start; i < end; i++) {
				writer.writeU32(eids[i]);
				writer.writeF64(elements.a[i]); writer.writeF64(elements.e[i]); writer.writeF64(elements.M[i]);
				writer.writeF64(elements.inc[i]); writer.writeF64(elements.Om[i]); writer.writeF64(elements.om[i]);
			}
			if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
		}
		return writer;
	};
}

// ============================================================================
// 15. IK CHAIN SERIALIZER -- per-chain: entity + bones(positions + lengths + target)
// ============================================================================
function createIKChainSerializer() {
	return function (writer, chains) {
		writer.writeU32(chains.length);
		for (var ci = 0; ci < chains.length; ci++) {
			var ch = chains[ci];
			var boneCount = (ch.lens.length + 1) | 0;
			writer.writeU32(ch.eid || 0);
			writer.writeU8(boneCount);
			writer.writeU8(ch.iterations || 10);
			for (var p = 0; p < boneCount * 3; p++) writer.writeF32(ch.pos[p]);
			for (var l = 0; l < ch.lens.length; l++) writer.writeF32(ch.lens[l]);
			writer.writeF32(ch.target[0]); writer.writeF32(ch.target[1]); writer.writeF32(ch.target[2]);
		}
		return writer;
	};
}

function createIKChainDeserializer() {
	return function (reader) {
		var count = reader.readU32();
		var out = new Array(count);
		for (var ci = 0; ci < count; ci++) {
			var eid = reader.readU32();
			var boneCount = reader.readU8();
			var iterations = reader.readU8();
			var pos = new Float32Array(boneCount * 3);
			for (var p = 0; p < pos.length; p++) pos[p] = reader.readF32();
			var lens = new Float32Array(boneCount - 1);
			for (var l = 0; l < lens.length; l++) lens[l] = reader.readF32();
			var target = new Float32Array(3);
			target[0] = reader.readF32(); target[1] = reader.readF32(); target[2] = reader.readF32();
			out[ci] = { eid: eid, pos: pos, lens: lens, target: target, iterations: iterations };
		}
		return out;
	};
}

// ============================================================================
// 16. ANIMATION KEYFRAME SERIALIZER -- position/rotation curves per entity
// ============================================================================
function createAnimationSerializer() {
	return function (writer, channels) {
		writer.writeU32(channels.length);
		for (var c = 0; c < channels.length; c++) {
			var ch = channels[c];
			var valuesPerKey = ch.valuesPerKey;
			var type = ch.type;
			writer.writeU32(ch.eid);
			writer.writeU8(type);
			writer.writeU32(ch.keys.length);
			for (var k = 0; k < ch.keys.length; k++) {
				var key = ch.keys[k];
				writer.writeF32(key.time);
				for (var v = 0; v < valuesPerKey; v++) writer.writeF32(key.values[v]);
			}
		}
		return writer;
	};
}

function createAnimationDeserializer() {
	return function (reader) {
		var count = reader.readU32();
		var out = new Array(count);
		for (var c = 0; c < count; c++) {
			var eid = reader.readU32();
			var type = reader.readU8();
			var keyCount = reader.readU32();
			var valuesPerKey = type === 0 || type === 2 ? 3 : type === 1 ? 4 : type === 4 ? 4 : 1;
			var keys = new Array(keyCount);
			for (var k = 0; k < keyCount; k++) {
				var vals = new Float32Array(valuesPerKey);
				var time = reader.readF32();
				for (var v = 0; v < valuesPerKey; v++) vals[v] = reader.readF32();
				keys[k] = { time: time, values: vals };
			}
			out[c] = { eid: eid, type: type, keys: keys, valuesPerKey: valuesPerKey };
		}
		return out;
	};
}

// ============================================================================
// 17. COLOR SOA SERIALIZER -- 1M+ per-entity RGBA (HDR-safe)
// ============================================================================
var COLOR_STRIDE = 20; // 4 (eid) + 16 (rgba f32)

function createColorSOASerializer() {
	return function (writer, eids, colors) {
		var n = eids.length;
		var x = colors.x, y = colors.y, z = colors.z, w = colors.w;
		writer.ensure(n * COLOR_STRIDE);
		for (var i = 0; i < n; i++) {
			writer.writeU32(eids[i]);
			writer.writeF32(x[i]); writer.writeF32(y[i]); writer.writeF32(z[i]); writer.writeF32(w[i]);
		}
		return writer;
	};
}

function createColorSOADeserializer() {
	return function (reader, colors, entityIdMapping, outEids) {
		var x = colors.x, y = colors.y, z = colors.z, w = colors.w;
		var i = 0;
		var max = Math.floor(reader.remaining / COLOR_STRIDE);
		for (var k = 0; k < max; k++) {
			var eid = reader.readU32();
			var idx = entityIdMapping ? (entityIdMapping.get(eid) != null ? entityIdMapping.get(eid) : eid) : eid;
			if (outEids) outEids[i] = idx;
			x[i] = reader.readF32(); y[i] = reader.readF32(); z[i] = reader.readF32(); w[i] = reader.readF32();
			i++;
		}
		return i;
	};
}

// Returns an async function directly (no outer async wrapper).
function createColorSOASerializerChunked() {
	return async function (writer, eids, colors, chunkSize, yieldEvery) {
		chunkSize = chunkSize || CHUNK_SIZE;
		yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
		var n = eids.length, c = 0;
		var x = colors.x, y = colors.y, z = colors.z, w = colors.w;
		for (var start = 0; start < n; start += chunkSize) {
			var end = Math.min(start + chunkSize, n);
			writer.ensure((end - start) * COLOR_STRIDE);
			for (var i = start; i < end; i++) {
				writer.writeU32(eids[i]);
				writer.writeF32(x[i]); writer.writeF32(y[i]); writer.writeF32(z[i]); writer.writeF32(w[i]);
			}
			if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
		}
		return writer;
	};
}

// ============================================================================
// 18. FLOATING-ORIGIN-SAFE WORLD POSITION -- Float64 for mm to Mpc
// ============================================================================
function createWorldPositionSerializer(options) {
	options = options || {};
	var useRelative = options.useRelative === true;
	var origin = options.origin || [0, 0, 0];
	var stride = useRelative ? 16 : 28;
	return function (writer, eids, positions, overrideOrigin) {
		var ox = overrideOrigin ? overrideOrigin[0] : origin[0];
		var oy = overrideOrigin ? overrideOrigin[1] : origin[1];
		var oz = overrideOrigin ? overrideOrigin[2] : origin[2];
		var n = eids.length;
		var px = positions.x, py = positions.y, pz = positions.z;
		writer.ensure(n * stride);
		for (var i = 0; i < n; i++) {
			writer.writeU32(eids[i]);
			if (useRelative) {
				writer.writeF32(px[i] - ox); writer.writeF32(py[i] - oy); writer.writeF32(pz[i] - oz);
			} else {
				writer.writeF64(px[i]); writer.writeF64(py[i]); writer.writeF64(pz[i]);
			}
		}
		return writer;
	};
}

function createWorldPositionDeserializer(options) {
	options = options || {};
	var useRelative = options.useRelative === true;
	var origin = options.origin || [0, 0, 0];
	var stride = useRelative ? 16 : 28;
	return function (reader, positions, entityIdMapping, overrideOrigin) {
		var ox = overrideOrigin ? overrideOrigin[0] : origin[0];
		var oy = overrideOrigin ? overrideOrigin[1] : origin[1];
		var oz = overrideOrigin ? overrideOrigin[2] : origin[2];
		var px = positions.x, py = positions.y, pz = positions.z;
		var max = Math.floor(reader.remaining / stride);
		var i = 0;
		for (var k = 0; k < max; k++) {
			var eid = reader.readU32();
			var idx = entityIdMapping ? (entityIdMapping.get(eid) != null ? entityIdMapping.get(eid) : eid) : eid;
			if (useRelative) {
				px[i] = reader.readF32() + ox; py[i] = reader.readF32() + oy; pz[i] = reader.readF32() + oz;
			} else {
				px[i] = reader.readF64(); py[i] = reader.readF64(); pz[i] = reader.readF64();
			}
			i++;
		}
		return i;
	};
}

// ============================================================================
// 19. AABB / BOUNDING-VOLUME SERIALIZER -- culling metadata for 1M+ entities
// ============================================================================
var AABB_STRIDE = 28; // 4 (eid) + 24 (6 * f32)

function createAABBSerializer() {
	return function (writer, eids, aabbs) {
		var n = eids.length;
		writer.ensure(n * AABB_STRIDE);
		for (var i = 0; i < n; i++) {
			writer.writeU32(eids[i]);
			writer.writeF32(aabbs.minX[i]); writer.writeF32(aabbs.minY[i]); writer.writeF32(aabbs.minZ[i]);
			writer.writeF32(aabbs.maxX[i]); writer.writeF32(aabbs.maxY[i]); writer.writeF32(aabbs.maxZ[i]);
		}
		return writer;
	};
}

function createAABBDeserializer() {
	return function (reader, aabbs, entityIdMapping, outEids) {
		var i = 0;
		var max = Math.floor(reader.remaining / AABB_STRIDE);
		for (var k = 0; k < max; k++) {
			var eid = reader.readU32();
			var idx = entityIdMapping ? (entityIdMapping.get(eid) != null ? entityIdMapping.get(eid) : eid) : eid;
			if (outEids) outEids[i] = idx;
			aabbs.minX[i] = reader.readF32(); aabbs.minY[i] = reader.readF32(); aabbs.minZ[i] = reader.readF32();
			aabbs.maxX[i] = reader.readF32(); aabbs.maxY[i] = reader.readF32(); aabbs.maxZ[i] = reader.readF32();
			i++;
		}
		return i;
	};
}

// ============================================================================
// 20. CHUNKED OBSERVER SERIALIZATION -- non-blocking network sync at 60fps
// ============================================================================
async function serializeSnapshotChunked(writer, snapshotChunkFns, chunkSize, yieldEvery) {
	chunkSize = chunkSize || CHUNK_SIZE;
	yieldEvery = yieldEvery || CHUNK_YIELD_EVERY;
	var c = 0;
	for (var i = 0; i < snapshotChunkFns.length; i += chunkSize) {
		var end = Math.min(i + chunkSize, snapshotChunkFns.length);
		for (var k = i; k < end; k++) snapshotChunkFns[k](writer);
		if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
	}
	return writer;
}

// ============================================================================
// 21. FULL-SCENE SNAPSHOT -- chunked async, works with or without instancing
// ============================================================================
// Pre-allocated temporary TRS view objects to avoid per-chunk object literal
// allocation in the hot serialization loop.
var _tmpTrsView = {
	position: { x: null, y: null, z: null },
	rotation: { x: null, y: null, z: null, w: null },
	scale: { x: null, y: null, z: null }
};

async function serializeScene(writer, scene, options) {
	options = options || {};
	var chunkSize = options.chunkSize || CHUNK_SIZE;
	var yieldEvery = options.yieldEvery || CHUNK_YIELD_EVERY;
	var worldCoords = options.worldCoords !== false;
	var eids = scene.eids;
	var n = eids.length;

	// Header: [magic:u32][version:u16][entityCount:u32][flags:5*u8]
	writer.writeU32(0x4253434E); // "BSCN"
	writer.writeU16(1);
	writer.writeU32(n);
	writer.writeU8(scene.trs ? 1 : 0);
	writer.writeU8(scene.colors ? 1 : 0);
	writer.writeU8(scene.elements ? 1 : 0);
	writer.writeU8(scene.ikChains ? 1 : 0);
	writer.writeU8(scene.aabbs ? 1 : 0);

	var c = 0;
	if (scene.trs) {
		var trsSer = createTRSSOASerializer({ worldCoords: worldCoords });
		for (var s = 0; s < n; s += chunkSize) {
			var e1 = Math.min(s + chunkSize, n);
			// Reuse pre-allocated view object instead of creating new object
			// literals per chunk iteration (Zero-GC).
			_tmpTrsView.position.x = scene.trs.position.x.subarray(s, e1);
			_tmpTrsView.position.y = scene.trs.position.y.subarray(s, e1);
			_tmpTrsView.position.z = scene.trs.position.z.subarray(s, e1);
			_tmpTrsView.rotation.x = scene.trs.rotation.x.subarray(s, e1);
			_tmpTrsView.rotation.y = scene.trs.rotation.y.subarray(s, e1);
			_tmpTrsView.rotation.z = scene.trs.rotation.z.subarray(s, e1);
			_tmpTrsView.rotation.w = scene.trs.rotation.w.subarray(s, e1);
			_tmpTrsView.scale.x = scene.trs.scale.x.subarray(s, e1);
			_tmpTrsView.scale.y = scene.trs.scale.y.subarray(s, e1);
			_tmpTrsView.scale.z = scene.trs.scale.z.subarray(s, e1);
			trsSer(writer, eids.subarray(s, e1), _tmpTrsView);
			if (++c >= yieldEvery) { c = 0; await yieldToMain(); }
		}
	}
	if (scene.colors) {
		var colSer = createColorSOASerializer();
		colSer(writer, eids, scene.colors);
		await yieldToMain();
	}
	if (scene.elements) {
		var orbSer = createOrbitalSOASerializer();
		orbSer(writer, eids, scene.elements);
		await yieldToMain();
	}
	if (scene.ikChains) {
		var ikSer = createIKChainSerializer();
		ikSer(writer, scene.ikChains);
		await yieldToMain();
	}
	if (scene.aabbs) {
		var aabbSer = createAABBSerializer();
		aabbSer(writer, eids, scene.aabbs);
	}
	return writer;
}

async function deserializeScene(reader, options) {
	options = options || {};
	var magic = reader.readU32();
	if (magic !== 0x4253434E) throw new Error("Bad scene magic");
	var version = reader.readU16();
	if (version !== 1) throw new Error("Unsupported version " + version);
	var n = reader.readU32();
	var hasTRS = reader.readU8() === 1;
	var hasColors = reader.readU8() === 1;
	var hasOrbital = reader.readU8() === 1;
	var hasIK = reader.readU8() === 1;
	var hasAABB = reader.readU8() === 1;

	var idMapping = options.idMap || new Map();
	var eids = new Uint32Array(n);
	var out = { eids: eids };

	if (hasTRS) {
		out.trs = {
			position: vec3.createVec3SOA(n),
			rotation: quat.createQuatSOA(n),
			scale: vec3.createVec3SOA(n)
		};
		var trsDe = createTRSSOADeserializer({ worldCoords: options.worldCoords !== false });
		trsDe(reader, out.trs, idMapping, eids);
		await yieldToMain();
	}
	if (hasColors) {
		out.colors = vec4.createVec4SOA(n);
		var colDe = createColorSOADeserializer();
		colDe(reader, out.colors, idMapping, null);
		await yieldToMain();
	}
	if (hasOrbital) {
		out.elements = {
			a: new Float32Array(n), e: new Float32Array(n), M: new Float32Array(n),
			inc: new Float32Array(n), Om: new Float32Array(n), om: new Float32Array(n)
		};
		var orbDe = createOrbitalSOADeserializer();
		orbDe(reader, out.elements, idMapping, null);
		await yieldToMain();
	}
	if (hasIK) {
		var ikDe = createIKChainDeserializer();
		out.ikChains = ikDe(reader);
		await yieldToMain();
	}
	if (hasAABB) {
		out.aabbs = {
			minX: new Float32Array(n), minY: new Float32Array(n), minZ: new Float32Array(n),
			maxX: new Float32Array(n), maxY: new Float32Array(n), maxZ: new Float32Array(n)
		};
		var aabbDe = createAABBDeserializer();
		aabbDe(reader, out.aabbs, idMapping, null);
	}
	return out;
}

// ============================================================================
// 22. EXPORTS -- every original bitECS serialization export preserved
// ============================================================================
export {
	// type tags (original)
	$u8, $i8, $u16, $i16, $u32, $i32, $f32, $f64, $ref, $str,
	// type taggers (original)
	u8, i8, u16, i16, u32, i32, f32, f64, ref, str, array,
	// original serializers
	createAoSSerializer,
	createAoSDeserializer,
	createSoASerializer,
	createSoADeserializer,
	createSnapshotSerializer,
	createSnapshotDeserializer,
	createObserverSerializer,
	createObserverDeserializer,
	// pooled byte writer/reader
	createByteWriter,
	createByteReader,
	// TRS SOA
	createTRSSOASerializer,
	createTRSSOADeserializer,
	createTRSSOASerializerChunked,
	// orbital SOA
	createOrbitalSOASerializer,
	createOrbitalSOADeserializer,
	createOrbitalSOASerializerChunked,
	// IK chain
	createIKChainSerializer,
	createIKChainDeserializer,
	// animation
	createAnimationSerializer,
	createAnimationDeserializer,
	// color SOA
	createColorSOASerializer,
	createColorSOADeserializer,
	createColorSOASerializerChunked,
	// floating-origin world position
	createWorldPositionSerializer,
	createWorldPositionDeserializer,
	// AABB / bounding volume
	createAABBSerializer,
	createAABBDeserializer,
	// chunked snapshot & full-scene
	serializeSnapshotChunked,
	serializeScene,
	deserializeScene
};

export default {
	$u8, $i8, $u16, $i16, $u32, $i32, $f32, $f64, $ref, $str,
	u8, i8, u16, i16, u32, i32, f32, f64, ref, str, array,
	createAoSSerializer,
	createAoSDeserializer,
	createSoASerializer,
	createSoADeserializer,
	createSnapshotSerializer,
	createSnapshotDeserializer,
	createObserverSerializer,
	createObserverDeserializer,
	createByteWriter,
	createByteReader,
	createTRSSOASerializer,
	createTRSSOADeserializer,
	createTRSSOASerializerChunked,
	createOrbitalSOASerializer,
	createOrbitalSOADeserializer,
	createOrbitalSOASerializerChunked,
	createIKChainSerializer,
	createIKChainDeserializer,
	createAnimationSerializer,
	createAnimationDeserializer,
	createColorSOASerializer,
	createColorSOADeserializer,
	createColorSOASerializerChunked,
	createWorldPositionSerializer,
	createWorldPositionDeserializer,
	createAABBSerializer,
	createAABBDeserializer,
	serializeSnapshotChunked,
	serializeScene,
	deserializeScene,
	// math modules re-exported for convenience
	math: {
		vec2: vec2, vec3: vec3, vec4: vec4,
		mat2: mat2, mat3: mat3, mat4: mat4, quat: quat, quat2: quat2
	}
};