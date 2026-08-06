/**
 * The cloud the character tears out of the deck in flight.
 *
 * This is the sky tier's answer to the surf wake, and it is deliberately built
 * the way the *slipstream* is rather than the way the wake is: it is an emitter
 * into the shared spray pool and nothing else — no mesh, no material, no shader,
 * nothing in the warm-up. The wake needs a mesh because a breaking wall of snow
 * is an opaque surface with a lip you can see the underside of. Torn vapour has
 * no surface at all, which makes it the one thing billboards are already the
 * right answer for.
 *
 * ## The spiral is laid, not simulated
 *
 * This is the whole trick, and getting it the other way round is what makes
 * every attempt at this read as smoke.
 *
 * Grains are not given an orbital velocity and left to circle. They are *placed*
 * on a helix whose phase advances with the distance the character has travelled,
 * so consecutive grains sit at consecutive points along a corkscrew that stands
 * still in the world while the character flies out of the end of it. The sim
 * then only has to hold them roughly where they were put, which is why the drag
 * here is high — the opposite of the slipstream's, where the grains genuinely
 * have to keep moving.
 *
 * Simulated orbits fail twice over. A grain circling at a speed that reads on
 * screen leaves its neighbours behind within a few frames and the rope
 * disintegrates into a swarm; and holding the orbit needs a low drag, which lets
 * the launch velocity carry every grain off along the flight path so the pair of
 * cores merge into one smear. Laid, the corkscrew is a fact about where the
 * grains are, and no amount of drift can take the shape apart faster than the
 * grains individually fade.
 *
 * Two counter-rotating cores, one off each hand, because that is what a body
 * moving through a fluid actually sheds and because two of them read as
 * *rotation* where one reads as a trail. They wind in opposite senses, which is
 * only visible when both are on screen and is exactly then that it matters.
 *
 * ## Sub-frame placement
 *
 * At a hundred metres a second and sixty frames a second the character moves
 * 1.7 m between emissions. Emitting a frame's grains all at the current position
 * lays the helix as a string of clumps at that spacing, with a visible beat at
 * whatever the frame rate happens to be. Each grain is therefore placed at a
 * fraction along the segment travelled since last frame, with its phase
 * interpolated to match — the same fix, for the same reason, as the fractional
 * column sampling in `surfWake._plume`.
 *
 * ## What turns it on
 *
 * `CloudDeck.densityAt`, probed with a reach greater than 1 so that flying
 * *past* a tower disturbs it as well as flying through one. The density is the
 * deck's own `1 - q²` profile, so what the effect responds to and what the
 * screen shows are the same number.
 *
 * Two populations off that one probe:
 *
 *  - **cores**, on the density itself. These are the vortices, and they are what
 *    is left hanging in the air behind.
 *  - **the tear**, on the *rate of change* of density, so it fires on entry
 *    rather than throughout. Punching into a tower throws a burst of vapour
 *    outward off the body and then stops; a hundred metres of solid cloud after
 *    that is the veil's job, not a particle's. Keyed to the derivative it is an
 *    event, which is the difference between an effect and a fog setting.
 *
 * Allocation: none per frame.
 */

import { S } from "../core/settings.js";
import { perpendicularFrame } from "./slipstream.js";

/**
 * Radius multiplier on the deck's puffs when probing.
 *
 * The density profile is zero at the silhouette, so a probe at reach 1 answers
 * "am I inside a cloud" and nothing else — and the brief is that flying *close*
 * to a cluster should stir it too. At 1.3 a 100 m puff registers about 30 m
 * outside its own edge, which at cruise is a bit under half a second of warning
 * before contact and reads as the air ahead already being disturbed.
 */
const PROBE_REACH = 1.3;

/**
 * Density between which the cores build.
 *
 * The floor is above what a swell crest gives at cruise clearance. The sky tier
 * holds 25 m over a surface whose own relief is ±40, so some part of the sheet
 * is within the probe's reach most of the time; starting the effect there would
 * have it running permanently, which is the one thing that would stop it being
 * an event.
 */
const DENS_LO = 0.10;
const DENS_HI = 0.55;

/**
 * Rate of density increase over which the tear burst builds, per second.
 *
 * Crossing the flank of a 120 m puff at cruise takes the density from nothing to
 * most of one over about 0.8 s, so the derivative peaks near 1.2/s. Below 0.35
 * is drifting into the edge of something rather than hitting it.
 */
const TEAR_LO = 0.35;
const TEAR_HI = 1.30;

/**
 * Speeds between which the whole effect builds, m/s.
 *
 * Well above the deck tier's cruise, and it never runs there anyway — the deck
 * is absent below 80 m of camera height, so `densityAt` returns zero for the
 * entire ground game and this system costs one comparison.
 */
const SPEED_LO = 16.0;
const SPEED_HI = 85.0;

/** Grains per metre travelled, per core, at full strength. */
const CORE_PER_M = 1.15;
/** Grains per metre travelled for the entry burst, at full strength. */
const TEAR_PER_M = 1.6;

/**
 * Radius of a core's helix, metres, and how fast it winds — radians per metre
 * travelled.
 *
 * A full turn every eleven metres. Read against the emission rate: at 1.15
 * grains a metre that is thirteen grains to the turn, which with the sizes below
 * is just dense enough to close into a rope. Winding it faster spends the same
 * grains on more turns and the rope comes apart into a dotted line; winding it
 * slower makes a shallow enough helix that at any distance it reads as straight.
 */
const CORE_R = 0.75;
const TWIST = 0.57;

/**
 * How much of the body's velocity a grain is born carrying.
 *
 * Almost none, and this is the opposite of the slipstream's 0.55. That system is
 * drawing air being dragged along *with* the character; this one is drawing
 * cloud that was already there and is now being left behind. A core born
 * carrying the body's velocity follows the character out of the tower it came
 * from, which is the single most obvious way to get this wrong.
 */
const CARRY = 0.06;

/**
 * Linear drag on a core grain, 1/s.
 *
 * High, because the shape is geometry and the sim's job is to leave it alone —
 * see the header. It is also what puts a floor under the sink: the spray steps
 * every grain toward a terminal fall, so the least a grain can descend is about
 * 1.9 m/s however hard it is damped, which over these lives is five or six
 * metres. That is not a compromise — a real vortex pair induces downwash between
 * its cores and sinks at very close to that rate.
 */
const CORE_DRAG = 5.0;

// ------------------------------------------------------- module-scope scratch
const _hand = new Float32Array(3);
const _axis = new Float32Array(3);
const _perpA = new Float32Array(3);
const _perpB = new Float32Array(3);
/** Hand offsets from the body, one per side, resolved once a frame. */
const _handOff = new Float32Array(6);

export class CloudVortex {
    /**
     * @param {import("../character/controller.js").CharacterController} controller
     * @param {import("../character/figure.js").Figure} figure
     * @param {import("./particles.js").SprayField} spray
     * @param {import("./cloudDeck.js").CloudDeck} clouds
     */
    constructor(controller, figure, spray, clouds) {
        this.controller = controller;
        this.figure = figure;
        this.spray = spray;
        this.clouds = clouds;

        this._owedCore = 0;
        this._owedTear = 0;
        /** Helix phase, radians, advanced by distance travelled. */
        this._phase = 0;

        /** Last frame's density at the body, for the entry derivative. */
        this._prevDens = 0;

        this._prevX = controller.position.x;
        this._prevY = controller.position.y;
        this._prevZ = controller.position.z;

        /** Live probe reading, for the console and the overlay. */
        this.density = 0;
    }

    /** @param {number} dt */
    update(dt) {
        const ch = this.controller;
        const sp = this.spray;

        const x = ch.position.x;
        const y = ch.position.y;
        const z = ch.position.z;
        const dx = x - this._prevX;
        const dy = y - this._prevY;
        const dz = z - this._prevZ;
        const moved = Math.sqrt(dx * dx + dy * dy + dz * dz);
        this._prevX = x;
        this._prevY = y;
        this._prevZ = z;

        const amount = S.cloudVortex;
        // Cheap gate first. On the ground this is the whole of the system, and
        // even in the air it saves the probe's pass over the pool whenever the
        // character is walking or surfing.
        if (!sp || !this.clouds || amount <= 0 || ch.airborne < 0.5) {
            this.density = 0;
            this._prevDens = 0;
            this._owedCore = 0;
            this._owedTear = 0;
            return;
        }

        // The rate through the air rather than across the ground, as the
        // slipstream reads it: a vertical launch through the deck has no
        // horizontal speed at all and is the manoeuvre most worth drawing.
        const vx = ch.velocity.x;
        const vy = ch.climbRate;
        const vz = ch.velocity.z;
        const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);

        // Probed at the body, a little above `position` — the pelvis height the
        // slipstream uses, so both systems agree about where the character is.
        const cy = y + 0.9;
        const dens = this.clouds.densityAt(x, cy, z, PROBE_REACH);
        this.density = dens;

        // Entry rate. Differenced against the clamped step the controller
        // integrates with, not against the raw frame time, so a stall cannot
        // read as a violent entry.
        const h = Math.min(dt, 1 / 30);
        const enter = h > 0 ? (dens - this._prevDens) / h : 0;
        this._prevDens = dens;

        const fast = clamp01((speed - SPEED_LO) / (SPEED_HI - SPEED_LO));
        const core = fast * clamp01((dens - DENS_LO) / (DENS_HI - DENS_LO));
        const tear = fast * clamp01((enter - TEAR_LO) / (TEAR_HI - TEAR_LO));

        if (moved < 1e-5 || speed < 1e-4 || (core < 0.02 && tear < 0.02)) {
            // Owed distance is dropped rather than banked, exactly as the
            // slipstream drops its own: coasting out of a tower and back into
            // one should start the next pass where the character is, not spend a
            // debt from the last cloud.
            this._owedCore = 0;
            this._owedTear = 0;
            return;
        }

        _axis[0] = vx / speed;
        _axis[1] = vy / speed;
        _axis[2] = vz / speed;
        perpendicularFrame(_axis, _perpA, _perpB);

        this._resolveHands(x, y, z);

        const phase0 = this._phase;
        this._phase += moved * TWIST;
        // Held inside a turn rather than left to grow. Only the phase modulo a
        // turn is ever read, and at cruise this advances by about sixty radians
        // a second — left alone it would be into the millions inside an hour,
        // where a float32 no longer resolves the tenth of a radian the helix is
        // built from.
        this._phase %= 6.28318530718;

        // The segment this frame's grains are laid along: where the body was
        // last frame, through to where it is now.
        const sx = x - dx;
        const sy = y - dy;
        const sz = z - dz;

        if (core > 0.02) {
            this._cores(moved, core, amount, sx, sy, sz, dx, dy, dz, phase0, vx, vy, vz);
        }
        if (tear > 0.02) {
            this._tear(moved, tear, amount, sx, sy + 0.9, sz, dx, dy, dz, vx, vy, vz);
        }
    }

    /**
     * Both hands as offsets from the body, resolved once for the frame.
     *
     * Offsets rather than absolute positions, because the grains are laid along
     * the segment the *body* travelled and the hand has to be carried back down
     * that segment with it. Interpolating between this frame's and last frame's
     * absolute hand positions would be the honest version and is not worth it:
     * in cruise the flight pose is static to within a centimetre a frame, and a
     * centimetre against a 0.75 m helix is nothing.
     */
    _resolveHands(x, y, z) {
        const fig = this.figure;
        for (let s = 0; s < 2; s++) {
            const o = s * 3;
            if (fig) {
                fig.handPosition(s, _hand, 0);
                _handOff[o] = _hand[0] - x;
                _handOff[o + 1] = _hand[1] - y;
                _handOff[o + 2] = _hand[2] - z;
            } else {
                // No figure: fall back to a wingspan either side of the axis, so
                // the pair still counter-rotate about something.
                const side = s === 0 ? -1 : 1;
                _handOff[o] = _perpA[0] * 0.75 * side;
                _handOff[o + 1] = _perpA[1] * 0.75 * side;
                _handOff[o + 2] = _perpA[2] * 0.75 * side;
            }
        }
    }

    /**
     * The two counter-rotating cores.
     *
     * Each grain is placed at a fraction along the segment the body covered this
     * frame, at a phase interpolated to match, so what is laid down is a
     * continuous corkscrew rather than one turn's worth of grains per frame.
     */
    _cores(moved, strength, amount, sx, sy, sz, dx, dy, dz, phase0, vx, vy, vz) {
        const sp = this.spray;

        // The count is per side, so the inner loop runs twice and the pool sees
        // twice this many grains.
        this._owedCore += moved * CORE_PER_M * strength * amount;
        let count = this._owedCore | 0;
        if (count <= 0) return;
        this._owedCore -= count;
        // Sized above what the *slowest* frame rate can ask for, not below it.
        // The controller clamps its step to 1/30, so the longest segment the
        // sky strike can lay down is 620/30 = 21 m, which wants 24 grains a
        // side here. This was 20, chosen when the fastest thing through the
        // deck was a 120 m/s climb and four metres a frame: it bit at 30 fps and
        // not at 60, which made the emitted count depend on the frame rate. That
        // is the one property per-metre metering exists to guarantee, so the cap
        // is a guard against a resumed tab rather than a budget.
        //
        // The overflow is dropped rather than left owed, for the same reason.
        // A banked debt goes on tearing vapour out of a tower the character left
        // several hundred metres ago.
        if (count > 26) { count = 26; this._owedCore = 0; }

        for (let i = 0; i < count; i++) {
            // Jittered inside its own slot rather than laid on a regular grid:
            // an exactly even spacing beats against the helix pitch and shows
            // as a stripe running along the rope.
            const f = (i + Math.random()) / count;
            const bx = sx + dx * f;
            const by = sy + dy * f;
            const bz = sz + dz * f;
            const ang = phase0 + moved * f * TWIST;

            for (let s = 0; s < 2; s++) {
                const ho = s * 3;
                // Counter-rotating. One sign flip, and it is the only thing
                // distinguishing the two cores.
                const sgn = s === 0 ? 1 : -1;
                const ca = Math.cos(ang * sgn);
                const sa = Math.sin(ang * sgn);
                const r = CORE_R * (0.75 + Math.random() * 0.5);

                const ox = _perpA[0] * ca + _perpB[0] * sa;
                const oy = _perpA[1] * ca + _perpB[1] * sa;
                const oz = _perpA[2] * ca + _perpB[2] * sa;

                // A little tangential motion — not enough to carry the grain
                // anywhere, just enough that the rope shears as it fades and
                // does not read as a solid object left in the air.
                const spin = 0.5 + Math.random() * 0.7;
                const tx = -_perpA[0] * sa + _perpB[0] * ca;
                const ty = -_perpA[1] * sa + _perpB[1] * ca;
                const tz = -_perpA[2] * sa + _perpB[2] * ca;

                sp.emit(
                    bx + _handOff[ho] + ox * r,
                    by + _handOff[ho + 1] + oy * r,
                    bz + _handOff[ho + 2] + oz * r,
                    vx * CARRY + tx * spin * sgn,
                    vy * CARRY + ty * spin * sgn,
                    vz * CARRY + tz * spin * sgn,
                    // Cloud-scale, not snow-scale. The spray grows a powder
                    // grain by 2.3x over its life, so these end near a metre and
                    // a half across — which at the eight metres the camera sits
                    // behind the character is a soft mass rather than a dot.
                    0.30 + Math.random() * 0.34,
                    1.1 + Math.random() * 1.0,
                    0,
                    CORE_DRAG
                );
            }
        }
    }

    /**
     * The entry burst: vapour thrown off the body on the way in.
     *
     * Radially outward from the axis of travel and slightly upstream, so it
     * blooms around the character and is passed rather than dragged. Shorter
     * lived and faster than the cores — this is the impact, and it is over
     * before the cores it was thrown alongside have finished winding.
     */
    _tear(moved, strength, amount, sx, sy, sz, dx, dy, dz, vx, vy, vz) {
        const sp = this.spray;

        this._owedTear += moved * TEAR_PER_M * strength * amount;
        let count = this._owedTear | 0;
        if (count <= 0) return;
        this._owedTear -= count;
        // 36 rather than 24, and dropped rather than banked — see the note on
        // the cores' cap above. This one meters harder (1.6/m against 1.15), so
        // a 21 m worst-case frame asks for 33 of it.
        if (count > 36) { count = 36; this._owedTear = 0; }

        for (let i = 0; i < count; i++) {
            const f = (i + Math.random()) / count;
            const a = Math.random() * Math.PI * 2;
            const ca = Math.cos(a);
            const sa = Math.sin(a);

            const ox = _perpA[0] * ca + _perpB[0] * sa;
            const oy = _perpA[1] * ca + _perpB[1] * sa;
            const oz = _perpA[2] * ca + _perpB[2] * sa;

            // Born on a ring a little wider than the body and a little ahead of
            // it, and thrown outward from there.
            const r = 0.8 + Math.random() * 1.1;
            const along = 0.5 + Math.random() * 2.2;
            const out = 3.0 + Math.random() * 5.5;

            sp.emit(
                sx + dx * f + _axis[0] * along + ox * r,
                sy + dy * f + _axis[1] * along + oy * r,
                sz + dz * f + _axis[2] * along + oz * r,
                vx * CARRY + ox * out,
                vy * CARRY + oy * out,
                vz * CARRY + oz * out,
                0.34 + Math.random() * 0.46,
                0.55 + Math.random() * 0.55,
                0,
                // Lower than the cores': this one is *meant* to travel, and it
                // has half a second to get clear of the body before it is gone.
                2.2
            );
        }
    }
}

function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}
