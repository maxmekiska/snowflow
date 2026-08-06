/**
 * The air the character drags with them in flight.
 *
 * Nothing here is new machinery. It is the ordinary spray pool — same
 * billboard, same lighting model, same sort, same pipeline — emitted in a shape
 * that reads as moving air rather than as falling snow, which means it needs no
 * material, no shader and therefore no warm-up. The whole system is an emitter.
 *
 * What makes powder read as *air* is entirely in the numbers handed to `emit`,
 * and there are three of them that matter:
 *
 *  - **Drag near 0.8, not the 5.2 a settling grain gets.** A grain with the
 *    powder default stops dead in about 120 ms and hangs there, which at twenty
 *    metres a second means the character sheds a line of stationary puffs and
 *    flies away from them. These have to keep travelling.
 *  - **Born with most of the body's own velocity**, not with none. The
 *    difference between the two is what the air appears to be doing: carried at
 *    `CARRY` the grain slides backward past the body at a walking pace and takes
 *    its whole life to clear the figure, which is a slipstream. Born at rest it
 *    is gone behind in two frames and reads as debris.
 *  - **Born a little way upstream.** They then pass the character rather than
 *    trailing them, and the effect belongs to the body instead of following it.
 *
 * The grains corkscrew: each is given a tangential velocity around the axis of
 * travel, so the sheath winds rather than streams straight. That is the one
 * detail that stops it looking like a smoke ribbon pinned to the character's
 * back — a straight stream has no way of saying the thing at the front of it is
 * what is disturbing the air.
 *
 * **This is flight only, deliberately.** The same rush at ground level is
 * already the surf plume's job, and it does it with two populations and a
 * thousand grains; a second, thinner system laid over the top of that would
 * only make the plume look dirty.
 *
 * Everything here works in three dimensions — the metering, the axis and the
 * ring it is built on. That was not true while flight was horizontal, and it
 * did not need to be: the character's vertical rate was capped at 9 m/s and the
 * ground distance it travelled was the whole story. The sky launch is 120 m/s
 * straight up, and on the old ground metering it emitted *nothing at all* — a
 * rocket climb with dead still air around it. Metering on the real path length
 * fixes that for free and the density stays frame-rate independent, because
 * distance is distance whichever way it points.
 *
 * Allocation: none per frame.
 */

import { S } from "../core/settings.js";

/**
 * Speeds between which the airflow builds, m/s.
 *
 * The floor is well above a hover. Air a stationary figure is not moving
 * through has nothing to say, and streaming it anyway is how a hover ends up
 * looking like it is leaking.
 */
const STREAM_LO = 6.0;
const STREAM_HI = 20.0;

/**
 * Grains per metre travelled, at full stream.
 *
 * Per distance rather than per second, so the density in the air is the same
 * whatever the frame rate — and so the effect thickens with speed for free,
 * which is the entire brief.
 *
 * These are low on purpose. The surf plume needs sheer count because it is
 * asking to be read as a solid mass of snow and only overlap gets it there;
 * this is asking to be read as a few wisps of disturbed air, and the moment
 * there are enough of them to overlap it stops being air and starts being fog
 * coming off the character.
 */
const SHEATH_PER_M = 7.0;
const HAND_PER_M = 3.0;

/** Fraction of the body's velocity a grain is born carrying. */
const CARRY = 0.55;

/** Radius of the sheath around the body, metres. */
const SHEATH_R = 0.62;

// ------------------------------------------------------- module-scope scratch
const _hand = new Float32Array(3);
/** Unit axis of travel and the two perpendiculars the sheath rings on. */
const _axis = new Float32Array(3);
const _perpA = new Float32Array(3);
const _perpB = new Float32Array(3);

export class Slipstream {
    /**
     * @param {import("../character/controller.js").CharacterController} controller
     * @param {import("../character/figure.js").Figure} figure
     * @param {import("./particles.js").SprayField} spray
     */
    constructor(controller, figure, spray) {
        this.controller = controller;
        this.figure = figure;
        this.spray = spray;

        this._owedSheath = 0;
        this._owedHand = 0;

        this._prevX = controller.position.x;
        this._prevY = controller.position.y;
        this._prevZ = controller.position.z;
    }

    /** @param {number} dt */
    update(dt) {
        const ch = this.controller;
        const sp = this.spray;

        // Distance actually travelled, which is what the emission is metered
        // against. Taken from the position delta rather than from `speed * dt`
        // so that a clamped frame cannot quietly emit for time the character did
        // not move through — and so the vertical leg of a launch is counted at
        // its real length rather than at its horizontal shadow, which is zero.
        const dx = ch.position.x - this._prevX;
        const dy = ch.position.y - this._prevY;
        const dz = ch.position.z - this._prevZ;
        const moved = Math.sqrt(dx * dx + dy * dy + dz * dz);
        this._prevX = ch.position.x;
        this._prevY = ch.position.y;
        this._prevZ = ch.position.z;

        const density = S.flyStream;
        if (!sp || density <= 0) return;

        // The rate through the air, not across the ground. `climbRate` carries
        // the ground-following term as well as the altitude hold, but that only
        // matters below the deadband the ramp starts at.
        const vx = ch.velocity.x;
        const vy = ch.climbRate;
        const vz = ch.velocity.z;
        const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
        // Switched off through the sky strike, and for two reasons that happen
        // to point the same way.
        //
        // The look: at 620 m/s this asks for three thousand grains over the
        // shot. That is not "a few wisps of disturbed air", it is a solid wall
        // of fog around the character, and the strike already has its own
        // airflow in `vfx/skyBolt.js` — the column, the wrap and the sparks.
        // Two systems describing the same metre of air is how one of them ends
        // up looking like a mistake.
        //
        // The mechanism: the per-frame caps below were sized against a 26 m/s
        // cruise, where they never bite. At 620 they bite at 30 fps and not at
        // 240, which makes the emitted count depend on the frame rate — the one
        // property the per-metre metering exists to guarantee. Measured, the
        // strike alone moved the round-trip grain count from 3.4k at 30 fps to
        // 10.5k at 240. Not emitting here at all is what puts that back.
        const stream =
            ch.airborne * clamp01((speed - STREAM_LO) / (STREAM_HI - STREAM_LO))
            * (1 - ch.bolt);
        if (stream < 0.02 || moved < 1e-5 || speed < 1e-4) {
            // Owed distance is dropped rather than banked. Coming back up to
            // speed after a hover should start the stream where the character
            // is, not spend a debt from wherever they last were.
            this._owedSheath = 0;
            this._owedHand = 0;
            return;
        }

        // Axis of travel. Velocity and not facing: flight has a third of the
        // board's grip, so a hard turn slides the body sideways through the air
        // for most of a second, and a sheath built on the facing would sit
        // across the flow for exactly as long as the turn lasts.
        _axis[0] = vx / speed;
        _axis[1] = vy / speed;
        _axis[2] = vz / speed;
        perpendicularFrame(_axis, _perpA, _perpB);

        // The pelvis sits about a hip's height above `position`; the body spans
        // roughly a metre either side of that once it is prone.
        const cy = ch.position.y + 0.9;

        this._sheath(moved, stream, density, vx, vy, vz, cy);
        this._hands(moved, stream, density, vx, vy, vz);
    }

    /**
     * The sheath: a corkscrew of air wrapping the body and sliding aft.
     *
     * Born on a ring around the axis of travel and offset along it, so the
     * grains occupy the length of the figure rather than a disc at its centre.
     */
    _sheath(moved, stream, density, vx, vy, vz, cy) {
        const ch = this.controller;
        const sp = this.spray;

        this._owedSheath += moved * SHEATH_PER_M * stream * density;
        let count = this._owedSheath | 0;
        if (count <= 0) return;
        this._owedSheath -= count;
        // The cap *drops* its overflow rather than leaving it owed, and that
        // only started mattering when the sky strike arrived. At the deck
        // tier's 26 m/s the cap is never reached, so the two behaved
        // identically; at the strike's 620 m/s a frame asks for a hundred and
        // gets twenty-four, and the debt keeps the emitter running flat out for
        // several seconds after the character has landed and stopped — a
        // slipstream pouring off a figure kneeling in the snow.
        if (count > 24) { count = 24; this._owedSheath = 0; }

        for (let i = 0; i < count; i++) {
            const a = Math.random() * Math.PI * 2;
            const ca = Math.cos(a);
            const sa = Math.sin(a);
            const r = SHEATH_R * (0.72 + Math.random() * 0.55);

            // Upstream of the body, so the grain passes it. The spread is what
            // gives the sheath its length: the leading grains are already ahead
            // of the head as the trailing ones clear the feet.
            const along = 0.6 + Math.random() * 2.4;

            // On the ring: the two perpendiculars parametrise a circle around
            // the axis of travel, and the axis offsets it along the body.
            const ox = _perpA[0] * ca + _perpB[0] * sa;
            const oy = _perpA[1] * ca + _perpB[1] * sa;
            const oz = _perpA[2] * ca + _perpB[2] * sa;

            const x = ch.position.x + _axis[0] * along + ox * r;
            const y = cy + _axis[1] * along + oy * r;
            const z = ch.position.z + _axis[2] * along + oz * r;

            // Tangential to the ring — the derivative of the point above, which
            // is what makes the path wind instead of run straight back.
            const swirl = (2.2 + Math.random() * 3.4) * stream;
            const tx = -_perpA[0] * sa + _perpB[0] * ca;
            const ty = -_perpA[1] * sa + _perpB[1] * ca;
            const tz = -_perpA[2] * sa + _perpB[2] * ca;

            // A little outward as well, so the sheath opens behind the body
            // rather than staying a tube the character is threaded through.
            const out = 0.7 + Math.random() * 1.5;

            sp.emit(
                x, y, z,
                vx * CARRY + tx * swirl + ox * out,
                vy * CARRY + ty * swirl + oy * out,
                vz * CARRY + tz * swirl + oz * out,
                0.05 + Math.random() * 0.08,
                0.30 + Math.random() * 0.22,
                0,
                // See the header. Anywhere near the powder default and these
                // stop in the character's own length.
                0.8
            );
        }
    }

    /**
     * Wisps off the hands.
     *
     * The hands are the leading edges of the pose — swept back at the hips at
     * speed — and putting the tightest, finest part of the effect exactly there
     * is what ties the airflow to the figure instead of to its bounding box.
     * They are half the size of the sheath's and turn twice as hard.
     */
    _hands(moved, stream, density, vx, vy, vz) {
        const sp = this.spray;
        const fig = this.figure;
        if (!fig) return;

        this._owedHand += moved * HAND_PER_M * stream * density;
        let count = this._owedHand | 0;
        if (count <= 0) return;
        this._owedHand -= count;
        // Dropped, not banked — see the note on the sheath's cap above.
        if (count > 16) { count = 16; this._owedHand = 0; }

        for (let i = 0; i < count; i++) {
            const which = i & 1;
            fig.handPosition(which, _hand, 0);

            const a = Math.random() * Math.PI * 2;
            const ca = Math.cos(a);
            const sa = Math.sin(a);
            const r = 0.05 + Math.random() * 0.16;

            // Just downstream of the hand: a vortex sheds off a trailing edge,
            // it does not sit on it.
            const along = -0.15 - Math.random() * 0.5;

            const ox = _perpA[0] * ca + _perpB[0] * sa;
            const oy = _perpA[1] * ca + _perpB[1] * sa;
            const oz = _perpA[2] * ca + _perpB[2] * sa;

            const swirl = (3.0 + Math.random() * 4.5) * stream;
            const tx = -_perpA[0] * sa + _perpB[0] * ca;
            const ty = -_perpA[1] * sa + _perpB[1] * ca;
            const tz = -_perpA[2] * sa + _perpB[2] * ca;

            sp.emit(
                _hand[0] + _axis[0] * along + ox * r,
                _hand[1] + _axis[1] * along + oy * r,
                _hand[2] + _axis[2] * along + oz * r,
                vx * CARRY + tx * swirl,
                vy * CARRY + ty * swirl,
                vz * CARRY + tz * swirl,
                0.035 + Math.random() * 0.055,
                0.26 + Math.random() * 0.24,
                0,
                0.8
            );
        }
    }
}

/**
 * Two unit vectors perpendicular to `a` and to each other, written to `outA`
 * and `outB`.
 *
 * The obvious construction — cross with world up — is exactly the one that
 * fails here, and it fails on the one manoeuvre this file was extended for: a
 * vertical launch has an axis *parallel* to up, the cross product is zero, and
 * normalising it produces NaN positions that poison every grain they touch.
 * Crossing with whichever cardinal axis `a` is least aligned to can never
 * degenerate, because a unit vector cannot be within 45 degrees of all three.
 *
 * Exported because `cloudVortex.js` rings the same axis for the same reason and
 * hits the same vertical launch. It lives here rather than in a shared vector
 * module so the paragraph above stays with the code it is about — a second copy
 * of this whose failure mode is silent NaN is not worth the tidier import.
 *
 * @param {Float32Array} a unit axis
 * @param {Float32Array} outA @param {Float32Array} outB
 */
export function perpendicularFrame(a, outA, outB) {
    const ax = Math.abs(a[0]);
    const ay = Math.abs(a[1]);
    const az = Math.abs(a[2]);
    // The least-aligned cardinal, as a basis vector picked without branching on
    // floats twice.
    let rx = 0, ry = 0, rz = 0;
    if (ax <= ay && ax <= az) rx = 1;
    else if (ay <= az) ry = 1;
    else rz = 1;

    // outA = normalize(a x r)
    let px = a[1] * rz - a[2] * ry;
    let py = a[2] * rx - a[0] * rz;
    let pz = a[0] * ry - a[1] * rx;
    const len = Math.sqrt(px * px + py * py + pz * pz) || 1;
    px /= len; py /= len; pz /= len;
    outA[0] = px; outA[1] = py; outA[2] = pz;

    // outB = a x outA. Already unit: both are unit and orthogonal.
    outB[0] = a[1] * pz - a[2] * py;
    outB[1] = a[2] * px - a[0] * pz;
    outB[2] = a[0] * py - a[1] * px;
}

function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}
