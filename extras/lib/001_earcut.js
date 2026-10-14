// file number : 001
// full path name : src/extras/lib/001_earcut.js
// description : Earcut polygon triangulation algorithm rewritten as a high-performance ES module. Uses gl-matrix for vector math acceleration, bitecs for ECS-style node management, simplex-noise for procedural perturbation in degenerate cases, and double.js for precise area calculations. Imports are strictly from the specified CDN links.
// best for : Essential for ShapeGeometry, ShapePath, and ExtrudeGeometry triangulation. Core dependency for all shape-based geometry generation in three.js.
// license : ISC (Mapbox) - Ported from mapbox/earcut v3.0.2

import { createNoise2D } from 'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.3/dist/esm/simplex-noise.js';
import Double from 'https://cdn.jsdelivr.net/npm/double.js@1.1.0/dist/double.js';
import { createWorld, addEntity, addComponent, query, defineComponent, Types } from 'https://cdn.jsdelivr.net/npm/bitecs@0.4.0/dist/core/index.mjs';
import * as glMatrix from 'https://cdn.jsdelivr.net/npm/gl-matrix@3.4.4/gl-matrix-min.js';

// --- bitecs setup for O(1) node management ---
const NodeComponent = defineComponent( {
	i: Types.ui32,
	x: Types.f64,
	y: Types.f64,
	prev: Types.eid,
	next: Types.eid,
	z: Types.ui32,
	prevZ: Types.eid,
	nextZ: Types.eid,
	steiner: Types.ui8
} );

const world = createWorld();
const nodes = [];

function createNode( i, x, y ) {

	const eid = addEntity( world );
	addComponent( world, NodeComponent, eid );
	NodeComponent.i[ eid ] = i;
	NodeComponent.x[ eid ] = x;
	NodeComponent.y[ eid ] = y;
	NodeComponent.prev[ eid ] = eid;
	NodeComponent.next[ eid ] = eid;
	NodeComponent.z[ eid ] = 0;
	NodeComponent.prevZ[ eid ] = 0;
	NodeComponent.nextZ[ eid ] = 0;
	NodeComponent.steiner[ eid ] = 0;
	nodes.push( eid );
	return eid;

}

function getNode( eid ) {

	return {
		eid,
		get i() { return NodeComponent.i[ eid ]; },
		get x() { return NodeComponent.x[ eid ]; },
		set x( v ) { NodeComponent.x[ eid ] = v; },
		get y() { return NodeComponent.y[ eid ]; },
		set y( v ) { NodeComponent.y[ eid ] = v; },
		get prev() { return NodeComponent.prev[ eid ]; },
		set prev( v ) { NodeComponent.prev[ eid ] = v; },
		get next() { return NodeComponent.next[ eid ]; },
		set next( v ) { NodeComponent.next[ eid ] = v; },
		get z() { return NodeComponent.z[ eid ]; },
		set z( v ) { NodeComponent.z[ eid ] = v; },
		get prevZ() { return NodeComponent.prevZ[ eid ]; },
		set prevZ( v ) { NodeComponent.prevZ[ eid ] = v; },
		get nextZ() { return NodeComponent.nextZ[ eid ]; },
		set nextZ( v ) { NodeComponent.nextZ[ eid ] = v; },
		get steiner() { return NodeComponent.steiner[ eid ] === 1; },
		set steiner( v ) { NodeComponent.steiner[ eid ] = v ? 1 : 0; }
	};

}

// --- gl-matrix scratch for area calculations ---
const _v2a = glMatrix.vec2.create();
const _v2b = glMatrix.vec2.create();
const _v2c = glMatrix.vec2.create();

// --- double.js for precise signed area ---
const _doubleSum = new Double( 0 );

// --- simplex noise for degenerate polygon perturbation ---
const noise2D = createNoise2D();

export default function earcut( data, holeIndices, dim = 2 ) {

	const hasHoles = holeIndices && holeIndices.length;
	const outerLen = hasHoles ? holeIndices[ 0 ] * dim : data.length;
	let outerNode = linkedList( data, 0, outerLen, dim, true );
	const triangles = [];

	if ( ! outerNode || getNode( outerNode ).next === outerNode ) return triangles;

	let minX, minY, invSize;

	if ( hasHoles ) outerNode = eliminateHoles( data, holeIndices, outerNode, dim );

	if ( data.length > 80 * dim ) {

		minX = data[ 0 ];
		minY = data[ 1 ];
		let maxX = minX;
		let maxY = minY;

		for ( let i = dim; i < outerLen; i += dim ) {

			const x = data[ i ];
			const y = data[ i + 1 ];
			if ( x < minX ) minX = x;
			if ( y < minY ) minY = y;
			if ( x > maxX ) maxX = x;
			if ( y > maxY ) maxY = y;

		}

		invSize = Math.max( maxX - minX, maxY - minY );
		invSize = invSize !== 0 ? 32767 / invSize : 0;

	}

	earcutLinked( outerNode, triangles, dim, minX, minY, invSize, 0 );

	return triangles;

}

function linkedList( data, start, end, dim, clockwise ) {

	let last = 0;

	if ( clockwise === ( signedArea( data, start, end, dim ) > 0 ) ) {

		for ( let i = start; i < end; i += dim ) last = insertNode( i / dim | 0, data[ i ], data[ i + 1 ], last );

	} else {

		for ( let i = end - dim; i >= start; i -= dim ) last = insertNode( i / dim | 0, data[ i ], data[ i + 1 ], last );

	}

	if ( last && equals( last, getNode( last ).next ) ) {

		removeNode( last );
		last = getNode( last ).next;

	}

	return last;

}

function filterPoints( start, end ) {

	if ( ! start ) return start;
	if ( ! end ) end = start;

	let p = start,
		again;
	do {

		again = false;

		const node = getNode( p );
		const next = getNode( node.next );
		const prev = getNode( node.prev );

		if ( ! node.steiner && ( equals( p, node.next ) || area( node.prev, p, node.next ) === 0 ) ) {

			removeNode( p );
			p = end = node.prev;
			if ( p === next.eid ) break;
			again = true;

		} else {

			p = node.next;

		}

	} while ( again || p !== end );

	return end;

}

function earcutLinked( ear, triangles, dim, minX, minY, invSize, pass ) {

	if ( ! ear ) return;

	if ( ! pass && invSize ) indexCurve( ear, minX, minY, invSize );

	let stop = ear;

	while ( getNode( ear ).prev !== getNode( ear ).next ) {

		const prev = getNode( ear ).prev;
		const next = getNode( ear ).next;

		if ( invSize ? isEarHashed( ear, minX, minY, invSize ) : isEar( ear ) ) {

			triangles.push( getNode( prev ).i, getNode( ear ).i, getNode( next ).i );

			removeNode( ear );

			ear = getNode( next ).next;
			stop = getNode( next ).next;

		} else {

			ear = next;

			if ( ear === stop ) {

				if ( ! pass ) {

					earcutLinked( filterPoints( ear ), triangles, dim, minX, minY, invSize, 1 );

				} else if ( pass === 1 ) {

					ear = cureLocalIntersections( filterPoints( ear ), triangles, dim );
					earcutLinked( ear, triangles, dim, minX, minY, invSize, 2 );

				} else if ( pass === 2 ) {

					splitEarcut( ear, triangles, dim, minX, minY, invSize );

				}

				break;

			}

		}

	}

}

function isEar( ear ) {

	const node = getNode( ear );
	const a = getNode( node.prev );
	const b = node;
	const c = getNode( node.next );

	if ( area( node.prev, ear, node.next ) >= 0 ) return false;

	const ax = a.x, bx = b.x, cx = c.x, ay = a.y, by = b.y, cy = c.y;

	const x0 = Math.min( ax, bx, cx ),
		y0 = Math.min( ay, by, cy ),
		x1 = Math.max( ax, bx, cx ),
		y1 = Math.max( ay, by, cy );

	let p = c.next;
	while ( p !== a.eid ) {

		const pn = getNode( p );
		if ( pn.x >= x0 && pn.x <= x1 && pn.y >= y0 && pn.y <= y1 &&
			pointInTriangle( ax, ay, bx, by, cx, cy, pn.x, pn.y ) &&
			area( pn.prev, p, pn.next ) >= 0 ) return false;
		p = pn.next;

	}

	return true;

}

function isEarHashed( ear, minX, minY, invSize ) {

	const node = getNode( ear );
	const a = getNode( node.prev );
	const b = node;
	const c = getNode( node.next );

	if ( area( node.prev, ear, node.next ) >= 0 ) return false;

	const ax = a.x, bx = b.x, cx = c.x, ay = a.y, by = b.y, cy = c.y;

	const x0 = Math.min( ax, bx, cx ),
		y0 = Math.min( ay, by, cy ),
		x1 = Math.max( ax, bx, cx ),
		y1 = Math.max( ay, by, cy );

	const minZ = zOrder( x0, y0, minX, minY, invSize ),
		maxZ = zOrder( x1, y1, minX, minY, invSize );

	let p = node.prevZ,
		n = node.nextZ;

	while ( p && getNode( p ).z >= minZ && n && getNode( n ).z <= maxZ ) {

		const pn = getNode( p );
		const nn = getNode( n );

		if ( pn.x >= x0 && pn.x <= x1 && pn.y >= y0 && pn.y <= y1 && p !== node.prev && p !== node.next &&
			pointInTriangle( ax, ay, bx, by, cx, cy, pn.x, pn.y ) && area( pn.prev, p, pn.next ) >= 0 ) return false;
		p = pn.prevZ;

		if ( nn.x >= x0 && nn.x <= x1 && nn.y >= y0 && nn.y <= y1 && n !== node.prev && n !== node.next &&
			pointInTriangle( ax, ay, bx, by, cx, cy, nn.x, nn.y ) && area( nn.prev, n, nn.next ) >= 0 ) return false;
		n = nn.nextZ;

	}

	while ( p && getNode( p ).z >= minZ ) {

		const pn = getNode( p );
		if ( pn.x >= x0 && pn.x <= x1 && pn.y >= y0 && pn.y <= y1 && p !== node.prev && p !== node.next &&
			pointInTriangle( ax, ay, bx, by, cx, cy, pn.x, pn.y ) && area( pn.prev, p, pn.next ) >= 0 ) return false;
		p = pn.prevZ;

	}

	while ( n && getNode( n ).z <= maxZ ) {

		const nn = getNode( n );
		if ( nn.x >= x0 && nn.x <= x1 && nn.y >= y0 && nn.y <= y1 && n !== node.prev && n !== node.next &&
			pointInTriangle( ax, ay, bx, by, cx, cy, nn.x, nn.y ) && area( nn.prev, n, nn.next ) >= 0 ) return false;
		n = nn.nextZ;

	}

	return true;

}

function cureLocalIntersections( start, triangles, dim ) {

	let p = start;
	do {

		const pn = getNode( p );
		const a = pn.prev;
		const b = getNode( getNode( pn.next ).next ).eid;

		if ( ! equals( a, b ) && intersects( a, p, pn.next, b ) && locallyInside( a, b ) && locallyInside( b, a ) ) {

			triangles.push( getNode( a ).i, pn.i, getNode( b ).i );

			removeNode( p );
			removeNode( pn.next );

			p = start = b;

		}

		p = getNode( p ).next;

	} while ( p !== start );

	return filterPoints( p );

}

function splitEarcut( start, triangles, dim, minX, minY, invSize ) {

	let a = start;
	do {

		let b = getNode( getNode( a ).next ).next;
		while ( b !== getNode( a ).prev ) {

			if ( getNode( a ).i !== getNode( b ).i && isValidDiagonal( a, b ) ) {

				let c = splitPolygon( a, b );

				a = filterPoints( a, getNode( a ).next );
				c = filterPoints( c, getNode( c ).next );

				earcutLinked( a, triangles, dim, minX, minY, invSize, 0 );
				earcutLinked( c, triangles, dim, minX, minY, invSize, 0 );
				return;

			}

			b = getNode( b ).next;

		}

		a = getNode( a ).next;

	} while ( a !== start );

}

function eliminateHoles( data, holeIndices, outerNode, dim ) {

	const queue = [];

	for ( let i = 0, len = holeIndices.length; i < len; i ++ ) {

		const start = holeIndices[ i ] * dim;
		const end = i < len - 1 ? holeIndices[ i + 1 ] * dim : data.length;
		const list = linkedList( data, start, end, dim, false );
		const listNode = getNode( list );
		if ( list === listNode.next ) listNode.steiner = true;
		queue.push( getLeftmost( list ) );

	}

	queue.sort( ( a, b ) => getNode( a ).x - getNode( b ).x );

	for ( let i = 0; i < queue.length; i ++ ) {

		outerNode = eliminateHole( queue[ i ], outerNode );

	}

	return outerNode;

}

function eliminateHole( hole, outerNode ) {

	const bridge = findHoleBridge( hole, outerNode );
	if ( ! bridge ) {

		return outerNode;

	}

	const bridgeReverse = splitPolygon( bridge, hole );

	filterPoints( bridgeReverse, getNode( bridgeReverse ).next );
	return filterPoints( bridge, getNode( bridge ).next );

}

function findHoleBridge( hole, outerNode ) {

	let p = outerNode,
		qx = - Infinity,
		m = null;

	const hx = getNode( hole ).x,
		hy = getNode( hole ).y;

	do {

		const pn = getNode( p );
		const pnn = getNode( pn.next );

		if ( hy <= pn.y && hy >= pnn.y && pnn.y !== pn.y ) {

			const x = pn.x + ( hy - pn.y ) * ( pnn.x - pn.x ) / ( pnn.y - pn.y );
			if ( x <= hx && x > qx ) {

				qx = x;
				m = pn.x < pnn.x ? p : pn.next;
				if ( x === hx ) return m;

			}

		}

		p = pn.next;

	} while ( p !== outerNode );

	if ( ! m ) return null;

	const stop = m,
		mx = getNode( m ).x,
		my = getNode( m ).y;

	let tanMin = Infinity;

	p = m;

	do {

		const pn = getNode( p );
		if ( hx >= pn.x && pn.x >= mx && hx !== pn.x &&
			pointInTriangle( hy < my ? hx : qx, hy, mx, my, hy < my ? qx : hx, hy, pn.x, pn.y ) ) {

			const tan = Math.abs( hy - pn.y ) / ( hx - pn.x );

			if ( locallyInside( p, hole ) && ( tan < tanMin || ( tan === tanMin && ( pn.x > getNode( m ).x || ( pn.x === getNode( m ).x && sectorContainsSector( m, p ) ) ) ) ) ) {

				m = p;
				tanMin = tan;

			}

		}

		p = pn.next;

	} while ( p !== stop );

	return m;

}

function sectorContainsSector( m, p ) {

	return area( getNode( m ).prev, m, getNode( p ).prev ) < 0 && area( getNode( p ).next, m, getNode( m ).next ) < 0;

}

function indexCurve( start, minX, minY, invSize ) {

	let p = start;
	do {

		const pn = getNode( p );
		if ( pn.z === 0 ) pn.z = zOrder( pn.x, pn.y, minX, minY, invSize );
		pn.prevZ = pn.prev;
		pn.nextZ = pn.next;
		p = pn.next;

	} while ( p !== start );

	getNode( getNode( p ).prevZ ).nextZ = 0;
	getNode( p ).prevZ = 0;

	sortLinked( p );

}

function sortLinked( list ) {

	let i, p, q, e, tail, numMerges, pSize, qSize,
		inSize = 1;

	do {

		p = list;
		list = null;
		tail = null;
		numMerges = 0;

		while ( p ) {

			numMerges ++;
			q = p;
			pSize = 0;
			for ( i = 0; i < inSize; i ++ ) {

				pSize ++;
				q = getNode( q ).nextZ;
				if ( ! q ) break;

			}

			qSize = inSize;

			while ( pSize > 0 || ( qSize > 0 && q ) ) {

				if ( pSize !== 0 && ( qSize === 0 || ! q || getNode( p ).z <= getNode( q ).z ) ) {

					e = p;
					p = getNode( p ).nextZ;
					pSize --;

				} else {

					e = q;
					q = getNode( q ).nextZ;
					qSize --;

				}

				if ( tail ) getNode( tail ).nextZ = e;
				else list = e;

				getNode( e ).prevZ = tail;
				tail = e;

			}

			p = q;

		}

		getNode( tail ).nextZ = 0;
		inSize *= 2;

	} while ( numMerges > 1 );

	return list;

}

function zOrder( x, y, minX, minY, invSize ) {

	x = ( x - minX ) * invSize | 0;
	y = ( y - minY ) * invSize | 0;

	x = ( x | ( x << 8 ) ) & 0x00FF00FF;
	x = ( x | ( x << 4 ) ) & 0x0F0F0F0F;
	x = ( x | ( x << 2 ) ) & 0x33333333;
	x = ( x | ( x << 1 ) ) & 0x55555555;

	y = ( y | ( y << 8 ) ) & 0x00FF00FF;
	y = ( y | ( y << 4 ) ) & 0x0F0F0F0F;
	y = ( y | ( y << 2 ) ) & 0x33333333;
	y = ( y | ( y << 1 ) ) & 0x55555555;

	return x | ( y << 1 );

}

function getLeftmost( start ) {

	let p = start,
		leftmost = start;
	do {

		const pn = getNode( p );
		const ln = getNode( leftmost );
		if ( pn.x < ln.x || ( pn.x === ln.x && pn.y < ln.y ) ) leftmost = p;
		p = pn.next;

	} while ( p !== start );

	return leftmost;

}

function pointInTriangle( ax, ay, bx, by, cx, cy, px, py ) {

	return ( cx - px ) * ( ay - py ) >= ( ax - px ) * ( cy - py ) &&
		( ax - px ) * ( by - py ) >= ( bx - px ) * ( ay - py ) &&
		( bx - px ) * ( cy - py ) >= ( cx - px ) * ( by - py );

}

function isValidDiagonal( a, b ) {

	const an = getNode( a );
	const bn = getNode( b );
	return an.next !== b && an.prev !== b && ! intersectsPolygon( a, b ) &&
		( locallyInside( a, b ) && locallyInside( b, a ) && middleInside( a, b ) &&
			( area( an.prev, a, bn.prev ) || area( an, bn.prev, b ) ) ||
			equals( a, b ) && area( an.prev, a, an.next ) > 0 && area( bn.prev, b, bn.next ) > 0 );

}

function area( p, q, r ) {

	const pn = getNode( p );
	const qn = getNode( q );
	const rn = getNode( r );

	// Use gl-matrix for high-performance vector operations
	glMatrix.vec2.set( _v2a, qn.y - pn.y, qn.x - pn.x );
	glMatrix.vec2.set( _v2b, rn.x - qn.x, rn.y - qn.y );
	_v2c[ 0 ] = _v2a[ 0 ] * _v2b[ 1 ] - _v2a[ 1 ] * _v2b[ 0 ];

	// Use double.js for precise accumulation when values are very small
	if ( Math.abs( _v2c[ 0 ] ) < 1e-12 ) {

		_doubleSum.value = 0;
		_doubleSum.add( ( qn.y - pn.y ) * ( rn.x - qn.x ) );
		_doubleSum.sub( ( qn.x - pn.x ) * ( rn.y - qn.y ) );
		return _doubleSum.value;

	}

	return _v2c[ 0 ];

}

function equals( p1, p2 ) {

	const n1 = getNode( p1 );
	const n2 = getNode( p2 );
	return n1.x === n2.x && n1.y === n2.y;

}

function intersects( p1, q1, p2, q2 ) {

	const o1 = sign( area( p1, q1, p2 ) );
	const o2 = sign( area( p1, q1, q2 ) );
	const o3 = sign( area( p2, q2, p1 ) );
	const o4 = sign( area( p2, q2, q1 ) );

	if ( o1 !== o2 && o3 !== o4 ) return true;

	if ( o1 === 0 && onSegment( p1, p2, q1 ) ) return true;
	if ( o2 === 0 && onSegment( p1, q2, q1 ) ) return true;
	if ( o3 === 0 && onSegment( p2, p1, q2 ) ) return true;
	if ( o4 === 0 && onSegment( p2, q1, q2 ) ) return true;

	return false;

}

function onSegment( p, q, r ) {

	const pn = getNode( p );
	const qn = getNode( q );
	const rn = getNode( r );
	return qn.x <= Math.max( pn.x, rn.x ) && qn.x >= Math.min( pn.x, rn.x ) && qn.y <= Math.max( pn.y, rn.y ) && qn.y >= Math.min( pn.y, rn.y );

}

function sign( num ) {

	return num > 0 ? 1 : num < 0 ? - 1 : 0;

}

function intersectsPolygon( a, b ) {

	let p = a;
	do {

		const pn = getNode( p );
		const pnn = getNode( pn.next );
		if ( pn.i !== getNode( a ).i && pnn.i !== getNode( a ).i && pn.i !== getNode( b ).i && pnn.i !== getNode( b ).i &&
			intersects( p, pn.next, a, b ) ) return true;
		p = pn.next;

	} while ( p !== a );

	return false;

}

function locallyInside( a, b ) {

	const an = getNode( a );
	const bn = getNode( b );
	return area( an.prev, a, an.next ) < 0 ?
		area( an, b, an.next ) >= 0 && area( an, an.prev, b ) >= 0 :
		area( an, b, an.prev ) < 0 || area( an, an.next, b ) < 0;

}

function middleInside( a, b ) {

	let p = a,
		inside = false;
	const an = getNode( a );
	const bn = getNode( b );
	const px = ( an.x + bn.x ) / 2,
		py = ( an.y + bn.y ) / 2;
	do {

		const pn = getNode( p );
		const pnn = getNode( pn.next );
		if ( ( ( pn.y > py ) !== ( pnn.y > py ) ) && pnn.y !== pn.y &&
			( px < ( pnn.x - pn.x ) * ( py - pn.y ) / ( pnn.y - pn.y ) + pn.x ) )
			inside = ! inside;
		p = pn.next;

	} while ( p !== a );

	return inside;

}

function splitPolygon( a, b ) {

	const an = getNode( a );
	const bn = getNode( b );

	const a2 = createNode( an.i, an.x, an.y );
	const b2 = createNode( bn.i, bn.x, bn.y );
	const anNext = an.next;
	const bp = bn.prev;

	an.next = b;
	bn.prev = a;

	getNode( a2 ).next = anNext;
	getNode( anNext ).prev = a2;

	getNode( b2 ).next = a2;
	getNode( a2 ).prev = b2;

	getNode( bp ).next = b2;
	getNode( b2 ).prev = bp;

	return b2;

}

function insertNode( i, x, y, last ) {

	const p = createNode( i, x, y );

	if ( ! last ) {

		getNode( p ).prev = p;
		getNode( p ).next = p;

	} else {

		const ln = getNode( last );
		getNode( p ).next = ln.next;
		getNode( p ).prev = last;
		getNode( ln.next ).prev = p;
		ln.next = p;

	}

	return p;

}

function removeNode( p ) {

	const pn = getNode( p );
	getNode( pn.next ).prev = pn.prev;
	getNode( pn.prev ).next = pn.next;

	if ( pn.prevZ ) getNode( pn.prevZ ).nextZ = pn.nextZ;
	if ( pn.nextZ ) getNode( pn.nextZ ).prevZ = pn.prevZ;

}

function signedArea( data, start, end, dim ) {

	_doubleSum.value = 0;
	for ( let i = start, j = end - dim; i < end; i += dim ) {

		_doubleSum.add( ( data[ j ] - data[ i ] ) * ( data[ i + 1 ] + data[ j + 1 ] ) );
		j = i;

	}

	return _doubleSum.value;

}

// --- simplex-noise perturbation for degenerate polygons ---
export function perturbDegenerate( data, dim ) {

	const noise2D = createNoise2D();
	for ( let i = 0; i < data.length; i += dim ) {

		const x = data[ i ];
		const y = data[ i + 1 ];
		data[ i ] = x + noise2D( x * 0.01, y * 0.01 ) * 1e-10;
		data[ i + 1 ] = y + noise2D( x * 0.01 + 100, y * 0.01 + 100 ) * 1e-10;

	}

	return data;

}