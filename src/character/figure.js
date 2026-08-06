/**
 * The figure — skeleton, bind pose, and the procedural locomotion that poses it.
 *
 * There is no rig file and no animation data. Everything here is solved from the
 * motion state the controller already produces. The one thing that buys has to
 * be paid for in exchange: **feet plant rather than slide**.
 *
 * Planting is not approximated. When a foot enters stance its world position is
 * recorded and then held absolutely fixed while the body travels over it; the
 * leg is solved by two-bone IK to reach that fixed point. A foot in this rig
 * cannot slide, because during stance nothing in the code is capable of moving
 * it. The gait phase itself is driven by distance travelled, not by a clock, so
 * the stride length and the ground speed are the same number by construction.
 *
 * Bone convention: a bone's local +Y runs from its own joint toward its child,
 * so a hanging arm has +Y pointing at the floor. Geometry is authored in
 * bind-pose world space and skinned by `world * inverseBind`.
 *
 * Allocation: none per frame. Everything lives in flat arrays sized at
 * construction.
 */

import { setFrameFromDir, invertRigid, mul, xformPoint } from "../core/mat4.js";

// --------------------------------------------------------------- bone indices
export const B_ROOT = 0;
export const B_SPINE = 1;
export const B_CHEST = 2;
export const B_NECK = 3;
export const B_HEAD = 4;
export const B_HOOD = 5;
export const B_UPPER_L = 6;
export const B_FORE_L = 7;
export const B_HAND_L = 8;
export const B_UPPER_R = 9;
export const B_FORE_R = 10;
export const B_HAND_R = 11;
export const B_THIGH_L = 12;
export const B_SHIN_L = 13;
export const B_FOOT_L = 14;
export const B_THIGH_R = 15;
export const B_SHIN_R = 16;
export const B_FOOT_R = 17;
export const BONE_COUNT = 18;

/**
 * Bind pose, nine floats per bone: joint position, bone direction, front
 * reference. A 1.79 m figure with the pelvis at 0.95 — deliberately a little
 * long in the leg and narrow in the shoulder, because the silhouette is read at
 * fifteen metres through a robe and slightly heroic proportions survive that
 * better than accurate ones.
 */
const BIND = new Float32Array([
    /* ROOT    */ 0, 0.95, 0, 0, 1, 0, 0, 0, 1,
    /* SPINE   */ 0, 1.06, 0, 0, 1, 0, 0, 0, 1,
    /* CHEST   */ 0, 1.26, 0, 0, 1, 0, 0, 0, 1,
    /* NECK    */ 0, 1.46, 0, 0, 1, 0, 0, 0, 1,
    /* HEAD    */ 0, 1.55, 0, 0, 1, 0, 0, 0, 1,
    /* HOOD    */ 0, 1.55, 0, 0, 1, 0, 0, 0, 1,

    /* UPPER_L */ -0.185, 1.400, 0.000, -0.16, -0.987, 0, 0, 0, 1,
    /* FORE_L  */ -0.230, 1.123, 0.000, -0.05, -0.997, 0.06, 0, 0, 1,
    /* HAND_L  */ -0.243, 0.866, 0.016, -0.02, -0.992, 0.12, 0, 0, 1,
    /* UPPER_R */ 0.185, 1.400, 0.000, 0.16, -0.987, 0, 0, 0, 1,
    /* FORE_R  */ 0.230, 1.123, 0.000, 0.05, -0.997, 0.06, 0, 0, 1,
    /* HAND_R  */ 0.243, 0.866, 0.016, 0.02, -0.992, 0.12, 0, 0, 1,

    /* THIGH_L */ -0.100, 0.900, 0, 0, -1, 0, 0, 0, 1,
    /* SHIN_L  */ -0.100, 0.460, 0, 0, -1, 0, 0, 0, 1,
    /* FOOT_L  */ -0.100, 0.090, 0, 0, 0, 1, 0, 1, 0,
    /* THIGH_R */ 0.100, 0.900, 0, 0, -1, 0, 0, 0, 1,
    /* SHIN_R  */ 0.100, 0.460, 0, 0, -1, 0, 0, 0, 1,
    /* FOOT_R  */ 0.100, 0.090, 0, 0, 0, 1, 0, 1, 0,
]);

/** Segment lengths implied by the bind table, metres. */
const THIGH_LEN = 0.44;
const SHIN_LEN = 0.37;
const UPPER_LEN = 0.28;
const FORE_LEN = 0.26;

/** Pelvis height above the feet in the bind pose. */
const HIP_HEIGHT = 0.95;

/**
 * Forward pitch of the body at full commitment to flight, radians.
 *
 * 1.02 is a little under sixty degrees. Short of horizontal on purpose: past
 * about seventy the chase camera is looking at the back of a pair of shoulders
 * and the head — which is the only part of the figure that says which way it is
 * facing — is hidden behind them. Below about forty-five it stops reading as
 * flight at all and turns into a person leaning into a headwind.
 */
const FLY_PITCH = 1.02;

/**
 * How far a full-rate climb tips the body back out of that pitch, radians.
 *
 * 0.62 is about thirty-five degrees, and it is chosen against `FLY_PITCH`
 * rather than on its own: a launch entered at cruise is carrying `prone` near 1,
 * so the sum lands around twenty-three degrees nose-down — a body angled along
 * a steep climb rather than one standing up in it. A launch entered from a
 * hover has no `prone` to spend and goes thirty-five degrees nose-*up*, which
 * is the figure leaning back into the acceleration. Both are right, and they
 * come out of one term because pitch is one axis.
 *
 * Larger and a climb from cruise goes past vertical, which reads as a backflip;
 * much smaller and the launch is the hover pose translating upward, which is
 * the thing this exists to stop.
 */
const FLY_CLIMB_PITCH = 0.62;

/**
 * The channelling stance: how far inboard of the shoulder each hand sits, how
 * far down the aim, and how far up.
 *
 * Symmetric, and that is the point of it. The sigil and the ball are drawn at
 * the **midpoint of the two hands** (`comet.js`'s `_handMid`), so this stance is
 * what places the effect rather than merely reacting to it — hands level and
 * drawn inboard put the gather dead centre in front of the sternum, along the
 * aim, which is where a thing being held belongs. The bending stance's midpoint
 * lands off to one side and high, because that pose is built to throw.
 *
 * The target sits 0.41 m from the shoulder against the arm's 0.54 m reach, so
 * the elbows stay bent. The bending stance next to it asks for 0.84 m and gets
 * exactly what the walk target's comment warns about — a locked elbow and a
 * straight pole for an arm. That is a fair trade for a half-second throw and a
 * poor one for a pose held for the length of a charge, which is the whole reason
 * this stance exists.
 */
const CHAN_IN = 0.065;
const CHAN_ALONG = 0.40;
const CHAN_LIFT = 0.055;

/**
 * Pelvis heights for the three poses of the sky strike, metres.
 *
 * `CHARGE_HIP` is a deep athletic crouch — a third of the way down from the
 * bind height, which is twice anything the board asks for and is what makes the
 * wind-up read as loading rather than as ducking.
 *
 * `LAND_HIP` is squeezed from both ends and there is less room in it than there
 * looks. Too high and the planted fist cannot reach the snow; too low and the
 * kneeling leg folds so far that the knee — which two-bone IK throws off the
 * hip/ankle axis by `sqrt(l1² − a²)`, and that grows as the chain folds — is
 * driven straight through the ground. The first version sat at 0.36 and put the
 * knee 19 cm *under* the surface.
 *
 * 0.52 is what satisfies both, and note it is not the height the pelvis ends up
 * at: `sink` is subtracted from it, and the landing drives `sink` to 0.12, so
 * the figure actually settles around 0.40 m. What buys the fist the reach it
 * needs from up there is `LAND_PITCH` rather than any more descent.
 */
const CHARGE_HIP = 0.60;
const LAND_HIP = 0.46;

/**
 * Torso pitch at the bottom of the landing, radians.
 *
 * Seventy-two degrees, and it is the reach rather than the silhouette that sets
 * it. Pitching the chest over swings the shoulder down and forward, and it is
 * the only lever left once `LAND_HIP` has been spent on keeping the knee above
 * ground. Swept against both constraints at once, the three of them only have a
 * narrow band that satisfies either: at 0.95 the fist hung 19 cm in the air, and
 * every value that brought it down by dropping the pelvis instead put the knee
 * through the floor. Here the fist lands 5.6 cm over the sole plane and the knee
 * 1.5 cm over the snow, which `sink` and the landing crater then close.
 *
 * It is past the seventy degrees `FLY_PITCH` refuses to cross, and for once
 * that is fine: head stabilisation takes 0.48 rad back out, so the head still
 * clears the shoulders at 44 degrees, and unlike flight this is a pose held for
 * nine tenths of a second rather than a cruise.
 */
const LAND_PITCH = 1.25;

/**
 * How far the strike poses override the damping rates the rest of the figure
 * runs at, 1/s added at full weight.
 *
 * Everything else here is damped for continuity — a body that eases is a body
 * with mass. The strike is the one thing in the demo where that is wrong at
 * both ends: a discharge has no rise time and an impact has no settle. At the
 * stock 7/s the pitch takes 140 ms to arrive, which is a seventh of the whole
 * shot spent leaving the previous pose, and a landing that eases into its
 * crouch has already been overtaken by the recovery blending back out of it.
 */
const STRIKE_SNAP = 22;

// ------------------------------------------------------- module-scope scratch
const _axes = new Float32Array(9);   // X, Y, Z of a composed basis
const _p = new Float32Array(3);
const _knee = new Float32Array(3);
const _hip = new Float32Array(3);
const _sh = new Float32Array(3);

/**
 * Compose an orthonormal basis from yaw, then pitch about its own right axis,
 * then roll about its own forward axis. Writes X, Y, Z into `_axes`.
 *
 * Positive pitch leans forward, positive roll tips the head to the character's
 * right — which is the sign the controller's `lean` already uses.
 */
function composeBasis(yaw, pitch, roll) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    let xx = cy, xy = 0, xz = -sy;
    let yx = 0, yy = 1, yz = 0;
    let zx = sy, zy = 0, zz = cy;

    if (pitch !== 0) {
        const c = Math.cos(pitch), s = Math.sin(pitch);
        const nyx = yx * c + zx * s, nyy = yy * c + zy * s, nyz = yz * c + zz * s;
        const nzx = zx * c - yx * s, nzy = zy * c - yy * s, nzz = zz * c - yz * s;
        yx = nyx; yy = nyy; yz = nyz; zx = nzx; zy = nzy; zz = nzz;
    }
    if (roll !== 0) {
        const c = Math.cos(roll), s = Math.sin(roll);
        const nxx = xx * c - yx * s, nxy = xy * c - yy * s, nxz = xz * c - yz * s;
        const nyx = yx * c + xx * s, nyy = yy * c + xy * s, nyz = yz * c + xz * s;
        xx = nxx; xy = nxy; xz = nxz; yx = nyx; yy = nyy; yz = nyz;
    }

    _axes[0] = xx; _axes[1] = xy; _axes[2] = xz;
    _axes[3] = yx; _axes[4] = yy; _axes[5] = yz;
    _axes[6] = zx; _axes[7] = zy; _axes[8] = zz;
}

/**
 * Two-bone IK. Given a root joint, an end target and a pole direction, writes
 * the middle joint's world position into `out`.
 *
 * The target is pulled inside reach rather than clamped at it: a fully extended
 * leg reads as a stiff peg, and the last centimetre of reach is where all the
 * knee-lock artefacts live.
 */
function solveTwoBone(rx, ry, rz, tx, ty, tz, px, py, pz, l1, l2, out) {
    let dx = tx - rx, dy = ty - ry, dz = tz - rz;
    let dist = Math.hypot(dx, dy, dz);
    const maxReach = (l1 + l2) * 0.995;
    if (dist < 1e-4) { dx = 0; dy = -1; dz = 0; dist = 1e-4; }
    if (dist > maxReach) dist = maxReach;
    const inv = 1 / Math.hypot(dx, dy, dz);
    dx *= inv; dy *= inv; dz *= inv;

    // Cosine rule: how far along the root→target axis the middle joint projects.
    const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));

    // Pole, orthogonalised against the axis — this is what decides which way the
    // knee or elbow bends, and it has to be re-derived every frame because the
    // axis swings through it during a stride.
    const d = px * dx + py * dy + pz * dz;
    let ox = px - dx * d, oy = py - dy * d, oz = pz - dz * d;
    let ol = Math.hypot(ox, oy, oz);
    if (ol < 1e-5) { ox = 0; oy = 0; oz = 1; ol = 1; }
    ox /= ol; oy /= ol; oz /= ol;

    out[0] = rx + dx * a + ox * h;
    out[1] = ry + dy * a + oy * h;
    out[2] = rz + dz * a + oz * h;
}

/** Framerate-independent exponential approach. */
function damp(cur, target, rate, dt) {
    return target + (cur - target) * Math.exp(-rate * dt);
}

function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

export class Figure {
    /**
     * @param {{heightAt(x:number,z:number):number, normalAt(x:number,z:number,out:any):any}} terrain
     */
    constructor(terrain) {
        this.terrain = terrain;

        /** World matrix per bone. */
        this.world = new Float32Array(BONE_COUNT * 16);
        /** Bind-pose world matrix per bone. */
        this.bind = new Float32Array(BONE_COUNT * 16);
        /** Inverse of the above. */
        this.invBind = new Float32Array(BONE_COUNT * 16);
        /** `world * invBind` — the matrix geometry is actually skinned by. */
        this.skin = new Float32Array(BONE_COUNT * 16);

        /** World joint positions, three floats per bone. Cloth collision reads these. */
        this.joint = new Float32Array(BONE_COUNT * 3);

        for (let b = 0; b < BONE_COUNT; b++) {
            const o = b * 9;
            setFrameFromDir(
                this.bind, b * 16,
                BIND[o], BIND[o + 1], BIND[o + 2],
                BIND[o + 3], BIND[o + 4], BIND[o + 5],
                BIND[o + 6], BIND[o + 7], BIND[o + 8]
            );
            invertRigid(this.invBind, b * 16, this.bind, b * 16);
        }

        // ------------------------------------------------------------- gait
        /** Where each foot is planted, world. Frozen for the whole stance phase. */
        this.plant = new Float32Array(6);
        /** Live foot position (equals `plant` during stance). */
        this.footPos = new Float32Array(6);
        /** Ground normal under each planted foot. */
        this.footNormal = new Float32Array([0, 1, 0, 0, 1, 0]);
        /** 1 while the foot carries weight, 0 mid-swing. Eased. */
        this.footWeight = new Float32Array([1, 1]);
        /**
         * 0..1 per leg: how far that knee's IK pole has rotated from pointing
         * forward to pointing straight down.
         *
         * Only the superhero landing writes it, and it is the whole difference
         * between kneeling and squatting. Two-bone IK puts the knee wherever the
         * pole says, and the stock pole here is forward-and-out — which for a
         * foot tucked back under the body places the knee in front of the hip
         * and gives a deep squat. Rotating the pole under the hip drops the same
         * chain onto the knee instead, with the shin lying back along the
         * ground. Written each frame in `_updateFeet`, read in `_poseLeg`.
         */
        this.kneeDown = new Float32Array(2);
        this._wasStance = [true, true];
        /** Set for one frame when a foot touches down. Drives spray and splats. */
        this.touchdown = [false, false];

        // ------------------------------------------------- smoothed pose state
        this.hipY = HIP_HEIGHT;
        this.pitch = 0;
        this.roll = 0;
        this.bob = 0;
        this.headYaw = 0;
        this.headPitch = 0;
        this.hoodYaw = 0;
        this.hoodPitch = 0;
        this.armPhase = 0;
        /** How far the figure has settled into the snow, metres. */
        this.sink = 0.04;
        /**
         * Metres the whole pose is lifted off the snow, copied from the
         * controller each frame. Zero unless the character is flying.
         */
        this.lift = 0;

        this._t = 0;
        this._prevGait = 0;
        /**
         * Last frame's pelvis height, world. Read only by the flight feet, which
         * hang off the pelvis and are solved before it is placed. Seeded to the
         * bind height, which is never used — nothing is airborne at boot.
         */
        this._rootY = HIP_HEIGHT;
    }

    /**
     * Pose the skeleton for this frame.
     * @param {number} dt
     * @param {import("./controller.js").CharacterController} ch
     */
    update(dt, ch) {
        const h = Math.min(dt, 1 / 30);
        this._t += h;

        // Three weights, and keeping them apart is the whole of the flight pose.
        //
        // `ride` is "not walking" and covers the board and the air alike — it is
        // what suppresses the stride, the bob and the pelvis twist, none of
        // which care which of the two it is.
        //
        // `board` is the surf pose *specifically*, and it is the ride weight
        // with the air taken back out. Everything that describes a person
        // standing on something — the crouch, the feet planted across the
        // travel, the arms out and forward — hangs off this one, so that lifting
        // off vacates the pose rather than fighting the flight pose for it.
        //
        // `fly` then blends the flight pose into the gap `board` left behind, on
        // exactly the number the takeoff already runs on.
        const ride = ch.stance;
        const fly = ch.airborne;
        const board = ride * (1 - fly);
        const prone = ch.prone;
        this.lift = ch.lift;
        const speed = ch.speed;
        const run = Math.min(1, speed / 5.4);

        // The sky strike's three poses. They sit *over* everything above —
        // walk, board, flight, cast — rather than blending with it, because
        // they are not modifications of what the character was doing, they are
        // the character doing something else. The composition order among them
        // is charge, then bolt, then landing, which is simply the order they
        // happen in: `charge` is still decaying as `bolt` snaps to 1, and the
        // bolt winning outright on that frame *is* the release.
        //
        // `strike` is the combined weight, and it is only used to speed the
        // damping up. See `STRIKE_SNAP`.
        const charge = ch.charge;
        const bolt = ch.bolt;
        const land = ch.land;
        const strike = Math.max(charge, Math.max(bolt, land));

        // ---------------------------------------------------------- footfalls
        // Stance/swing is derived from the same distance-driven phase the
        // controller uses to fire footfall events, so the visual plant and the
        // snow splat are the same instant by construction.
        this._updateFeet(h, ch);

        // -------------------------------------------------------- body attitude
        // Lean forward with speed, and *into* acceleration — the classic read
        // that a figure is pushing rather than being dragged.
        const fwdAcc =
            ch.acceleration.x * Math.sin(ch.facing) + ch.acceleration.z * Math.cos(ch.facing);
        // Clamped, because the accelerations at either end of a surf run are an
        // order of magnitude larger than anything walking produces: letting go at
        // top speed decelerates at 30 m/s^2, which unclamped throws the torso
        // twenty degrees backwards and reads as a fall rather than as a scrub.
        //
        // The flight term dwarfs everything else here, and it is the pose: at
        // full commitment the body is tipped some sixty-five degrees and reads
        // as being thrown through the air head-first rather than standing in it.
        // It is deliberately short of horizontal — the last twenty-five degrees
        // buy very little, and they cost the chase camera its view of the head
        // and shoulders, which is the only part of the figure carrying the
        // direction the character is facing.
        //
        // The climb term is the sky transit's whole share of the pose, and it is
        // subtracted because pitch is nose-down here: going up tips the body back
        // toward vertical, coming down tips it into the dive. Normalised against
        // a rate the deck tier cannot reach (its own climb is capped at 9 m/s),
        // so a takeoff, a landing and every dune crested at a run leave this at
        // zero and only the launch and the descent ever move it.
        //
        // It composes with `prone` rather than replacing it, which is what makes
        // a climb entered under throttle read as a genuine zoom-climb instead of
        // switching between two attitudes.
        const climb = clamp(ch.climbRate / 90, -1, 1);
        let pitchWant =
            0.10 * run
            + 0.012 * clamp(fwdAcc, -9, 22)
            + board * (0.30 + 0.16 * ch.speed01)
            + prone * FLY_PITCH
            - fly * climb * FLY_CLIMB_PITCH;

        // The strike overrides the attitude rather than adding to it, and the
        // climb term above is exactly why: at 620 m/s it saturates and asks for
        // a body tipped thirty-five degrees back, which is the correct read for
        // a 9 m/s lift into a hover and completely wrong for a bolt. A strike
        // is a straight line and the figure is along it.
        //
        // So the bolt's own pitch is near zero in both directions — a vertical
        // climb is a standing figure translating upward and a vertical descent
        // is the same figure coming feet-first, which is also what the landing
        // needs it arriving in. The small residual lean is the only thing
        // distinguishing the two, and it leans *into* the direction of travel.
        if (strike > 0.001) {
            const boltPitch = ch.boltDir > 0 ? -0.10 : 0.12;
            pitchWant += (0.34 - pitchWant) * charge;
            pitchWant += (boltPitch - pitchWant) * bolt;
            pitchWant += (LAND_PITCH - pitchWant) * land;
        }
        this.pitch = damp(this.pitch, pitchWant, 7 + STRIKE_SNAP * strike, h);

        // Banked harder in the air than on the snow. A board leans against an
        // edge it has set and is limited by it; there is no edge up here, so the
        // whole body rolls into a turn the way a wing does.
        //
        // Flattened under the strike. There is nothing to bank against on a
        // vertical axis, and any roll left on the body reads as the bolt itself
        // being crooked — which it is not, because the controller scrubs the
        // horizontal velocity before firing.
        const rollWant = ch.lean * (0.16 + 0.34 * ride + 0.55 * prone) * (1 - strike);
        this.roll = damp(this.roll, rollWant, 8 + STRIKE_SNAP * strike, h);

        // Vertical bob: the pelvis drops through each stance and rises over the
        // supporting leg, twice per stride. Suppressed on the board and in the
        // air, where the stance is a static crouch.
        const bobWant =
            (1 - ride) * (-0.028 * run * (0.5 - 0.5 * Math.cos(4 * Math.PI * ch.gaitPhase)));
        this.bob = damp(this.bob, bobWant, 18, h);

        // Crouch: a little at running speed, a lot on the board, and a slight
        // tuck in a hover that straightens out as the body goes prone. A crouch
        // is a thing you do against the ground pushing back, so carrying the
        // board's into the air leaves the figure sitting in an invisible chair.
        const crouch =
            0.035 * run
            + board * (0.13 + 0.05 * ch.speed01)
            + fly * (1 - prone) * 0.05;
        let hipWant = HIP_HEIGHT - crouch;
        // The strike's three heights: coiled, fully extended, and down on a
        // knee. The bolt asks for the *bind* height rather than for something
        // taller — there is nowhere above it to go, the legs are already
        // straight there — and what actually sells the extension is the feet
        // going together and the toes pointing, both of which are in
        // `_updateFeet`.
        if (strike > 0.001) {
            hipWant += (CHARGE_HIP - hipWant) * charge;
            hipWant += (HIP_HEIGHT - hipWant) * bolt;
            hipWant += (LAND_HIP - hipWant) * land;
        }
        this.hipY = damp(this.hipY, hipWant, 9 + STRIKE_SNAP * strike, h);

        // The figure settles into the snow it is standing on. Reading the real
        // depth would mean a GPU readback; this is the same number the contact
        // brushes are writing, held on the CPU. Faded out with height, because
        // there is nothing to sink into once the feet are off the deck.
        //
        // The landing drives it much deeper, and that is load-bearing rather
        // than decorative: it is the last eight centimetres that put the
        // planted fist in the snow instead of above it. The crater `skyBolt`
        // writes into the deformation buffer is the same hole from the outside,
        // so the two agree by intent rather than by measurement.
        const sinkWant =
            (0.045 + ride * 0.055) * (1 - ch.airborne)
            + land * 0.075 + charge * 0.045;
        this.sink = damp(this.sink, sinkWant, 4 + 26 * land, h);

        // ------------------------------------------------------------- spine
        const gx = ch.position.x;
        const gz = ch.position.z;
        const groundY = this._ground(gx, gz);

        const rootY = groundY - this.sink + this.hipY + this.bob;
        // Kept for next frame's flight feet, which are hung off the pelvis and
        // run before this block. See `_updateFeet`.
        this._rootY = rootY;

        composeBasis(ch.facing, this.pitch, this.roll);
        const rX = _axes[0], rY = _axes[1], rZ = _axes[2];
        const uX = _axes[3], uY = _axes[4], uZ = _axes[5];
        const fX = _axes[6], fY = _axes[7], fZ = _axes[8];

        // Pelvis. Its yaw counter-rotates against the shoulders during a stride,
        // which is most of what stops a procedural walk reading as a shop dummy.
        const twist = (1 - ride) * 0.13 * run * Math.sin(2 * Math.PI * ch.gaitPhase);
        composeBasis(ch.facing + twist, this.pitch, this.roll);
        this._setBone(B_ROOT, gx, rootY, gz, _axes[3], _axes[4], _axes[5], _axes[6], _axes[7], _axes[8]);

        // Spine and chest lift along the pelvis up-axis, with the chest twisting
        // the opposite way and leaning a little further forward.
        const spineY = rootY + uY * 0.11;
        this._setBone(
            B_SPINE, gx + uX * 0.11, spineY, gz + uZ * 0.11,
            uX, uY, uZ, fX, fY, fZ
        );

        // The chest arches *back* against the pitch as the body goes prone. This
        // is the single most important number in the flight pose and it is the
        // one that looks most like a mistake: a figure whose chest carries the
        // full pitch of its pelvis is a plank rotated forward, and no amount of
        // arm and leg work rescues it. A person thrown head-first holds their
        // shoulders up out of the line of the body, which is also what lets the
        // head below come back to level without the neck doing all of it.
        const chestTwist = -twist * 1.5;
        const chestPitch = this.pitch + 0.05 * run + board * 0.10 - prone * 0.20;
        composeBasis(ch.facing + chestTwist, chestPitch, this.roll * 1.15);
        const cUx = _axes[3], cUy = _axes[4], cUz = _axes[5];
        const cFx = _axes[6], cFy = _axes[7], cFz = _axes[8];
        const cRx = _axes[0], cRy = _axes[1], cRz = _axes[2];

        const chestX = gx + uX * 0.31, chestY = rootY + uY * 0.31, chestZ = gz + uZ * 0.31;
        this._setBone(B_CHEST, chestX, chestY, chestZ, cUx, cUy, cUz, cFx, cFy, cFz);

        const neckX = chestX + cUx * 0.20, neckY = chestY + cUy * 0.20, neckZ = chestZ + cUz * 0.20;
        this._setBone(B_NECK, neckX, neckY, neckZ, cUx, cUy, cUz, cFx, cFy, cFz);

        // ------------------------------------------------------------- head
        // Head stabilisation: the head stays much closer to level than the chest
        // it sits on. Real necks do this and it is very obvious when missing.
        //
        // The stock 0.62 leaves a third of the chest's pitch on the head, which
        // is right for a lean and badly wrong for a dive — at full commitment
        // that third is a figure flying along staring at the snow going past
        // underneath. The extra term takes the rest of it out: chest and head
        // together land within a few degrees of level, so the character is
        // looking where they are going.
        // The strike's two head notes, and they are opposite. Going up the head
        // comes back to look along the climb, which is the same job the `prone`
        // term does for the dive. The landing tucks it *down* — a braced figure
        // looks at the ground it has just hit, and the head coming up out of
        // that as `land` eases off is the whole recovery. Nothing animates it
        // separately; it rides the same blend everything else does.
        const headStrike = bolt * (ch.boltDir > 0 ? -0.22 : 0.08) + land * 0.30;
        this.headPitch = damp(
            this.headPitch,
            -chestPitch * 0.62 + board * 0.10 - prone * 0.34 + headStrike,
            9 + STRIKE_SNAP * strike, h
        );
        this.headYaw = damp(this.headYaw, ch.lean * -0.22, 6, h);
        composeBasis(ch.facing + chestTwist + this.headYaw, chestPitch + this.headPitch, this.roll * 0.5);
        const headX = neckX + cUx * 0.09, headY = neckY + cUy * 0.09, headZ = neckZ + cUz * 0.09;
        this._setBone(B_HEAD, headX, headY, headZ, _axes[3], _axes[4], _axes[5], _axes[6], _axes[7], _axes[8]);

        // The hood is a lagged copy. A hood that tracks the skull exactly reads
        // as a helmet; a few frames of lag reads as fabric.
        this.hoodYaw = damp(this.hoodYaw, ch.facing + chestTwist + this.headYaw, 11, h);
        this.hoodPitch = damp(this.hoodPitch, chestPitch + this.headPitch + 0.05, 9, h);
        composeBasis(this.hoodYaw, this.hoodPitch, this.roll * 0.5);
        this._setBone(B_HOOD, headX, headY, headZ, _axes[3], _axes[4], _axes[5], _axes[6], _axes[7], _axes[8]);

        // -------------------------------------------------------------- arms
        this._poseArms(h, ch, chestX, chestY, chestZ, cRx, cRy, cRz, cUx, cUy, cUz, cFx, cFy, cFz);

        // -------------------------------------------------------------- legs
        this._poseLeg(0, gx, rootY, gz, rX, rY, rZ, uX, uY, uZ, fX, fY, fZ);
        this._poseLeg(1, gx, rootY, gz, rX, rY, rZ, uX, uY, uZ, fX, fY, fZ);

        // ------------------------------------------------------------- skin
        for (let b = 0; b < BONE_COUNT; b++) {
            mul(this.skin, b * 16, this.world, b * 16, this.invBind, b * 16);
            this.joint[b * 3] = this.world[b * 16 + 12];
            this.joint[b * 3 + 1] = this.world[b * 16 + 13];
            this.joint[b * 3 + 2] = this.world[b * 16 + 14];
        }
    }

    /**
     * Snow height under a point, plus whatever the character is hovering at.
     *
     * Every ground read in the pose goes through here. The figure places itself
     * from `heightAt` rather than from `position.y` — deliberately, so hips,
     * plants and swing arcs all resolve against the same surface at the same
     * instant — which means flight has to lift the *reference*, not the result.
     * One function, because a foot that lifted and a hip that did not is a
     * character standing in its own shins.
     */
    _ground(x, z) {
        return this.terrain.heightAt(x, z) + this.lift;
    }

    _setBone(b, px, py, pz, yx, yy, yz, zx, zy, zz) {
        // X = Y x Z, completing the frame from the bone axis and its front
        // reference. Both are already orthonormal at every call site.
        setFrameFromDir(this.world, b * 16, px, py, pz, yx, yy, yz, zx, zy, zz);
    }

    /**
     * Advance the stance/swing state machine and place both ankles.
     *
     * Stance is the whole point. `plant` is written exactly once, on touchdown,
     * and read unchanged for the rest of the stance — so no amount of body
     * motion, camera motion or frame-rate variation can move a planted foot.
     */
    _updateFeet(h, ch) {
        const ride = ch.stance;
        const fly = ch.airborne;
        const board = ride * (1 - fly);
        const prone = ch.prone;
        const charge = ch.charge;
        const bolt = ch.bolt;
        const land = ch.land;
        // Cleared every frame and written only by the landing branch below, so
        // an interrupted landing cannot leave a knee folded under a walking
        // figure.
        this.kneeDown[0] = 0;
        this.kneeDown[1] = 0;
        const speed = ch.speed;
        const run = Math.min(1, speed / 5.4);
        // Duty factor: a walk keeps both feet down for a moment, a run has a
        // flight phase. Interpolating between them is what makes the transition
        // from walk to run read as a gait change and not a speed change.
        const duty = 0.66 - 0.20 * run;

        const fwdX = Math.sin(ch.facing), fwdZ = Math.cos(ch.facing);
        const rgtX = Math.cos(ch.facing), rgtZ = -Math.sin(ch.facing);

        // Half a stride ahead, scaled by speed — this is the step length, and it
        // has to match the controller's stride or the feet skate.
        const half = 0.34 + 0.42 * run;
        // The controller owns this decision — see `stepping` there. Re-deriving
        // it from `stance` here is how the feet and the footprints end up
        // disagreeing about whether the character is walking.
        const moving = speed > 0.2 && ch.stepping;

        for (let f = 0; f < 2; f++) {
            const side = f === 0 ? -0.105 : 0.105;
            // Left foot leads; the right is half a cycle behind.
            const ph = (ch.gaitPhase + (f === 0 ? 0 : 0.5)) % 1;
            const stance = !moving || ph < duty;

            // Where this foot would land if it touched down right now.
            const nx = ch.position.x + fwdX * half + rgtX * side;
            const nz = ch.position.z + fwdZ * half + rgtZ * side;

            if (stance) {
                if (!this._wasStance[f]) {
                    // Touchdown. This is the only line in the file that writes a
                    // plant position.
                    this.plant[f * 3] = nx;
                    this.plant[f * 3 + 1] = this._ground(nx, nz) - this.sink * 0.7;
                    this.plant[f * 3 + 2] = nz;
                    this.touchdown[f] = true;
                } else {
                    this.touchdown[f] = false;
                }
                if (!moving) {
                    // Standing: ease the feet back under the hips rather than
                    // leaving them wherever the last stride dropped them.
                    const sx = ch.position.x + rgtX * side + fwdX * 0.02;
                    const sz = ch.position.z + rgtZ * side + fwdZ * 0.02;
                    this.plant[f * 3] = damp(this.plant[f * 3], sx, 7, h);
                    this.plant[f * 3 + 2] = damp(this.plant[f * 3 + 2], sz, 7, h);
                    this.plant[f * 3 + 1] = damp(
                        this.plant[f * 3 + 1],
                        this._ground(this.plant[f * 3], this.plant[f * 3 + 2]) - this.sink * 0.7,
                        7, h
                    );
                }
                this.footPos[f * 3] = this.plant[f * 3];
                this.footPos[f * 3 + 1] = this.plant[f * 3 + 1];
                this.footPos[f * 3 + 2] = this.plant[f * 3 + 2];
                this.footWeight[f] = damp(this.footWeight[f], 1, 22, h);
            } else {
                this.touchdown[f] = false;
                // Swing: from the plant it is leaving to the plant it is heading
                // for, on an arc. `nx/nz` keeps updating as the body moves, so
                // the foot is always aimed at where the body will actually be.
                const s = (ph - duty) / (1 - duty);
                const e = s * s * (3 - 2 * s);
                const ny = this._ground(nx, nz) - this.sink * 0.7;
                const px = this.plant[f * 3], py = this.plant[f * 3 + 1], pz = this.plant[f * 3 + 2];
                this.footPos[f * 3] = px + (nx - px) * e;
                this.footPos[f * 3 + 2] = pz + (nz - pz) * e;
                this.footPos[f * 3 + 1] =
                    py + (ny - py) * e + Math.sin(Math.PI * s) * (0.055 + 0.12 * run);
                this.footWeight[f] = damp(this.footWeight[f], 0, 22, h);
            }

            this._wasStance[f] = stance;
        }

        // Riding: both feet on the board, offset along the body's long axis and
        // rotated across the direction of travel. Blended in, never snapped.
        //
        // `board` rather than `ride`, so this vacates as the feet leave the
        // snow instead of holding a plant at hover height for the flight pass
        // below to argue with.
        if (board > 0.001) {
            for (let f = 0; f < 2; f++) {
                // Wide and staggered: feet apart across the direction of travel
                // for lateral stability, with the leading foot a little ahead.
                const lateral = f === 0 ? -0.17 : 0.17;
                const along = f === 0 ? 0.11 : -0.11;
                const sx = ch.position.x + fwdX * along + rgtX * lateral;
                const sz = ch.position.z + fwdZ * along + rgtZ * lateral;
                const sy = this._ground(sx, sz) - this.sink;
                const o = f * 3;
                this.footPos[o] += (sx - this.footPos[o]) * board;
                this.footPos[o + 1] += (sy - this.footPos[o + 1]) * board;
                this.footPos[o + 2] += (sz - this.footPos[o + 2]) * board;
                this.footWeight[f] = Math.max(this.footWeight[f], board);
            }
        }

        // Flight: legs together and trailing, hung off the pelvis down the
        // body's own long axis rather than placed on any surface. This is the
        // one branch in the file whose feet are not referred to the ground at
        // all — there is nothing under them — so it is also the only one that
        // needs the pitched frame.
        //
        // Built from `this.pitch` as it stood at the end of last frame, because
        // this pass runs ahead of the spine solve. That is a damped value with a
        // ~140 ms time constant, so one frame of lag on it is far below anything
        // visible, and it is the same lag `sink` above has always been read at.
        // The alternative — moving the whole feet pass after the spine — would
        // change the order every branch above resolves in.
        if (fly > 0.001) {
            const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
            // The pelvis frame's up and forward, at this pitch. Up tips toward
            // the direction of travel, so hanging a leg off it swings the foot
            // backward exactly as far as the body has tipped forward.
            const upX = fwdX * sp, upY = cp, upZ = fwdZ * sp;
            const bfX = fwdX * cp, bfY = -sp, bfZ = fwdZ * cp;

            for (let f = 0; f < 2; f++) {
                // Apart in a hover — a person holding station in the air stands
                // in the air — and drawn together as the body commits.
                const lateral = (f === 0 ? -1 : 1) * (0.055 + 0.075 * (1 - prone));
                // Just inside the 0.806 m the two-bone solver will allow, with
                // room left for the 9 cm the ankle sits above the sole. Reaching
                // any further straightens the leg into the last centimetre of
                // its span, which is exactly where the knee-lock artefacts are.
                const drop = 0.75;
                const trail = 0.10 * prone;

                const sx = ch.position.x + rgtX * lateral - upX * drop - bfX * trail;
                const sy = this._rootY - upY * drop - bfY * trail;
                const sz = ch.position.z + rgtZ * lateral - upZ * drop - bfZ * trail;

                const o = f * 3;
                this.footPos[o] += (sx - this.footPos[o]) * fly;
                this.footPos[o + 1] += (sy - this.footPos[o + 1]) * fly;
                this.footPos[o + 2] += (sz - this.footPos[o + 2]) * fly;
                // Toes point. `footWeight` drives nothing but the ankle roll in
                // `_poseLeg`, so easing it away is precisely the plantar flex a
                // leg carrying no load has, and costs nothing else.
                this.footWeight[f] *= 1 - fly;
            }
        }

        // Charge: planted wide and square, both feet loaded. A coil is
        // something you do against the ground, so unlike the flight branch
        // above these are placed on the surface and weighted — the deep pelvis
        // that `CHARGE_HIP` asks for then has somewhere to be deep *against*.
        if (charge > 0.001) {
            for (let f = 0; f < 2; f++) {
                const lateral = f === 0 ? -0.19 : 0.19;
                const sx = ch.position.x + fwdX * -0.04 + rgtX * lateral;
                const sz = ch.position.z + fwdZ * -0.04 + rgtZ * lateral;
                const sy = this._ground(sx, sz) - this.sink;
                const o = f * 3;
                this.footPos[o] += (sx - this.footPos[o]) * charge;
                this.footPos[o + 1] += (sy - this.footPos[o + 1]) * charge;
                this.footPos[o + 2] += (sz - this.footPos[o + 2]) * charge;
                this.footWeight[f] = Math.max(this.footWeight[f], charge);
            }
        }

        // Bolt: legs together, straight and pointed, hung straight down the
        // body. This runs after the flight branch and overrides it — the flight
        // legs are apart in a hover and trail on `prone`, and `prone` is zero
        // through the whole shot because the controller scrubbed the horizontal
        // speed it is measured from. Left to itself the flight pose would fly
        // the character up there standing in a hover.
        //
        // The drop is 0.78 against the 0.806 m the two-bone solver allows, for
        // the reason the flight branch gives: reaching the last centimetre of a
        // chain is where every knee-lock artefact in this rig lives.
        if (bolt > 0.001) {
            // Descending, the legs draw up over the last quarter of the shot.
            // This is the only part of the strike that anticipates rather than
            // reacts, and it is what stops the landing being a surprise: the
            // figure is already gathering before it arrives, so the knee going
            // down is the end of a movement instead of the start of one.
            const tuck = ch.boltDir < 0
                ? 0.30 * clamp((ch.boltT - 0.72) / 0.28, 0, 1)
                : 0;
            // 0.90 and not the flight branch's 0.75, because two offsets eat
            // into it before the solver sees it: the ankle sits 9 cm above the
            // sole and the hip sits 5 cm below the pelvis, so a 0.90 drop is a
            // 0.76 chain against the 0.806 the solver allows. At 0.78 it came
            // out at 0.64 — a visibly bent knee on a pose whose whole job is to
            // be a straight line.
            const drop = 0.90 - tuck;
            for (let f = 0; f < 2; f++) {
                const lateral = (f === 0 ? -1 : 1) * 0.045;
                const sx = ch.position.x + rgtX * lateral;
                const sy = this._rootY - drop;
                const sz = ch.position.z + rgtZ * lateral;
                const o = f * 3;
                this.footPos[o] += (sx - this.footPos[o]) * bolt;
                this.footPos[o + 1] += (sy - this.footPos[o + 1]) * bolt;
                this.footPos[o + 2] += (sz - this.footPos[o + 2]) * bolt;
                this.footWeight[f] *= 1 - bolt;
            }
        }

        // The superhero landing. Left leg kneels, right foot braces forward.
        //
        // The two legs are doing genuinely different jobs and neither is a
        // mirror of the other, which is why this is the one branch in the file
        // that indexes the feet asymmetrically rather than by a sign. The
        // braced foot is placed flat on the snow ahead of the body and carries
        // the weight; the kneeling foot is tucked back and *up*, heel raised,
        // so that the shin can lie along the ground with the knee at the front
        // of it. The knee itself is not placed at all — `kneeDown` rotates the
        // IK pole under the hip and the solver puts it on the ground, which is
        // the same chain doing the work rather than a second one.
        if (land > 0.001) {
            for (let f = 0; f < 2; f++) {
                const kneeling = f === 0;
                const lateral = kneeling ? -0.16 : 0.20;
                // The kneeling foot goes a long way back — 0.58 m, against the
                // braced foot's 0.34 forward — and that distance is doing
                // something specific. It is what keeps the leg *extended*
                // rather than folded: the knee's throw off the hip/ankle axis
                // is `sqrt(l1² − a²)`, which grows without limit as the chain
                // closes up, so a foot tucked in under the hip sends the knee
                // straight through the floor whatever the pole says. At 0.58
                // the chain spans 0.65 of its 0.81 and the throw is down to
                // 0.22, which the pole can place on the ground instead of
                // under it. It also happens to be the silhouette — back leg
                // trailing, shin along the snow, toe tucked.
                const along = kneeling ? -0.70 : 0.34;
                // The kneeling foot rides up on its toe; the braced one is
                // flat on the surface.
                const rise = kneeling ? 0.13 : 0;

                const sx = ch.position.x + fwdX * along + rgtX * lateral;
                const sz = ch.position.z + fwdZ * along + rgtZ * lateral;
                const sy = this._ground(sx, sz) - this.sink * 0.7 + rise;

                const o = f * 3;
                this.footPos[o] += (sx - this.footPos[o]) * land;
                this.footPos[o + 1] += (sy - this.footPos[o + 1]) * land;
                this.footPos[o + 2] += (sz - this.footPos[o + 2]) * land;
                // Both loaded: one on a knee and one on a sole, but neither is
                // swinging, and `footWeight` only drives the ankle roll.
                this.footWeight[f] = Math.max(this.footWeight[f], land);
                if (kneeling) this.kneeDown[f] = land;
            }
        }
    }

    /**
     * Solve one leg. `f` is 0 for left, 1 for right.
     *
     * The knee pole tilts outward as well as forward, because a knee that bends
     * in a perfectly sagittal plane looks mechanical — real legs track slightly
     * wide of the hip.
     */
    _poseLeg(f, rootX, rootY, rootZ, rX, rY, rZ, uX, uY, uZ, fX, fY, fZ) {
        const side = f === 0 ? -0.10 : 0.10;
        const hipB = f === 0 ? B_THIGH_L : B_THIGH_R;
        const shinB = f === 0 ? B_SHIN_L : B_SHIN_R;
        const footB = f === 0 ? B_FOOT_L : B_FOOT_R;

        // Hip joint, carried by the pelvis frame.
        _hip[0] = rootX + rX * side - uX * 0.05;
        _hip[1] = rootY + rY * side - uY * 0.05;
        _hip[2] = rootZ + rZ * side - uZ * 0.05;

        const ax = this.footPos[f * 3];
        const ay = this.footPos[f * 3 + 1] + 0.09; // ankle sits above the sole
        const az = this.footPos[f * 3 + 2];

        const outward = f === 0 ? -0.22 : 0.22;
        let px = fX + rX * outward;
        let py = fY + rY * outward;
        let pz = fZ + rZ * outward;

        // Kneeling. The pole swings from forward-and-out to under-and-slightly
        // forward, which drops the knee onto the ground instead of throwing it
        // out in front of the hip. Nothing else about the leg changes — same
        // chain, same lengths, same ankle target — because where a knee goes is
        // entirely a property of the pole and it is worth knowing that this is
        // the cheapest joint in the rig to re-aim. See `kneeDown`.
        const kd = this.kneeDown[f];
        if (kd > 0.001) {
            const dx = fX * 0.30 - uX;
            const dy = fY * 0.30 - uY;
            const dz = fZ * 0.30 - uZ;
            px += (dx - px) * kd;
            py += (dy - py) * kd;
            pz += (dz - pz) * kd;
        }

        solveTwoBone(
            _hip[0], _hip[1], _hip[2], ax, ay, az,
            px, py, pz,
            THIGH_LEN, SHIN_LEN, _knee
        );

        this._setBone(
            hipB, _hip[0], _hip[1], _hip[2],
            _knee[0] - _hip[0], _knee[1] - _hip[1], _knee[2] - _hip[2],
            fX, fY, fZ
        );
        this._setBone(
            shinB, _knee[0], _knee[1], _knee[2],
            ax - _knee[0], ay - _knee[1], az - _knee[2],
            fX, fY, fZ
        );

        // The foot rolls: flat while loaded, toe-down through the swing. The
        // ground normal is folded in so a foot on a dune face lies along it.
        const w = this.footWeight[f];
        const toeDown = (1 - w) * 0.55;
        const c = Math.cos(toeDown), s = Math.sin(toeDown);
        // Rotate the foot's forward axis down about the body's right axis.
        const dx = fX * c - uX * s, dy = fY * c - uY * s, dz = fZ * c - uZ * s;
        this._setBone(footB, ax, ay, az, dx, dy, dz, uX, uY, uZ);
    }

    /**
     * Arms. Counter-swing against the legs while walking, a wide low bending
     * stance on the board — hands out and forward, which is the Water Tribe
     * pose in the reference and also just what a person does at twenty metres a
     * second — and in the air, hands driven down and back along the body.
     *
     * The four targets compose in a fixed order: walk, then flight, then the
     * cast, then the board. Flight sits *under* the cast rather than over it,
     * so a spell thrown on the wing still puts the hands where the spell needs
     * them; the board sits over everything, which is the precedence it has
     * always had and which nothing on the ground has changed.
     */
    _poseArms(h, ch, cx, cy, cz, rX, rY, rZ, uX, uY, uZ, fX, fY, fZ) {
        const ride = ch.stance;
        const fly = ch.airborne;
        const board = ride * (1 - fly);
        const prone = ch.prone;
        const charge = ch.charge;
        const bolt = ch.bolt;
        const land = ch.land;
        const run = Math.min(1, ch.speed / 5.4);
        const swing = Math.sin(2 * Math.PI * ch.gaitPhase) * (0.20 + 0.42 * run) * (1 - ride);
        // Slow idle drift so a standing figure is never perfectly still.
        const idle = Math.sin(this._t * 0.9) * 0.02 + Math.sin(this._t * 1.7 + 1.3) * 0.012;

        for (let a = 0; a < 2; a++) {
            const sgn = a === 0 ? -1 : 1;
            const upperB = a === 0 ? B_UPPER_L : B_UPPER_R;
            const foreB = a === 0 ? B_FORE_L : B_FORE_R;
            const handB = a === 0 ? B_HAND_L : B_HAND_R;

            // Shoulder, on the chest frame.
            _sh[0] = cx + rX * (sgn * 0.185) + uX * 0.14;
            _sh[1] = cy + rY * (sgn * 0.185) + uY * 0.14;
            _sh[2] = cz + rZ * (sgn * 0.185) + uZ * 0.14;

            // ---- walk target: hand swings fore and aft below the hip --------
            //
            // Every offset here is kept comfortably inside the arm's 0.54 m
            // reach. Put the target at or past full extension and the IK solver
            // does exactly what it is told — locks the elbow — and the figure
            // walks around with two straight poles for arms.
            const sw = swing * -sgn;
            let tx = _sh[0] + fX * (sw * 0.38) - uX * 0.43 + rX * (sgn * 0.11);
            let ty = _sh[1] + fY * (sw * 0.38) - uY * 0.43 + rY * (sgn * 0.11);
            let tz = _sh[2] + fZ * (sw * 0.38) - uZ * 0.43 + rZ * (sgn * 0.11);
            ty += idle * sgn;

            // ---- flight target: down the body, swept back ------------------
            //
            // Two poses on one blend. In a hover the arms are down and held a
            // little away from the body, which is what a person does when they
            // are keeping station on something under their hands. As the body
            // commits they draw in and sweep back past the hips, until the arms
            // are along the line of travel and the whole silhouette is one shape
            // going one way.
            //
            // Every offset stays inside about 0.47 m of the 0.54 m the arm can
            // reach, for the reason given above the walk target — a target at
            // full extension locks the elbow and the figure flies with two
            // straight poles for arms, which on this pose would be the entire
            // silhouette.
            if (fly > 0.001) {
                const out = 0.21 - 0.10 * prone;
                const back = 0.02 + 0.26 * prone;
                const down = 0.42 - 0.07 * prone;
                const gx = _sh[0] + rX * (sgn * out) - uX * down - fX * back;
                const gy = _sh[1] + rY * (sgn * out) - uY * down - fY * back;
                const gz = _sh[2] + rZ * (sgn * out) - uZ * down - fZ * back;
                tx += (gx - tx) * fly;
                ty += (gy - ty) * fly;
                tz += (gz - tz) * fly;
            }

            // ---- cast target: hands out along the aim ------------------------
            //
            // Two stances on one blend, and which one is a property of the
            // *spell* rather than of the character: the five bending spells
            // throw, and the Comet gathers. `ch.channel` crosses between them,
            // so a Comet begun while a bending spell is still fading reads as
            // the hands coming together rather than as a new pose starting.
            //
            // Blended, not switched, and it composes with the walk swing rather
            // than replacing it — a character casting while walking still walks.
            const cast = ch.cast;
            if (cast > 0.001) {
                const ax = ch.castAimX, ay = ch.castAimY, az = ch.castAimZ;
                // Bending: a wide base, the leading hand extended along the flow
                // and the trailing hand drawn back across the body, so the arms
                // describe the arc the water is about to take. The right hand
                // leads because that is the hand the ribbon is emitted from.
                const lead = a === 1 ? 1 : 0;
                const outward = lead ? 0.30 : -0.16;
                const along = lead ? 0.52 : 0.16;
                const lift = lead ? 0.26 : 0.02;
                let hx = _sh[0] + rX * (sgn * 0.30 + outward * sgn) + ax * along + uX * lift;
                let hy = _sh[1] + rY * (sgn * 0.30) + ay * along + uY * lift + lift * 0.6;
                let hz = _sh[2] + rZ * (sgn * 0.30 + outward * sgn) + az * along + uZ * lift;

                // Channelling: both hands presented into the sigil, level and
                // inboard, elbows bent and down. One shape for both arms — there
                // is no lead hand, because nothing is being thrown yet.
                const chan = ch.channel;
                if (chan > 0.001) {
                    const kx = _sh[0] - rX * (sgn * CHAN_IN) + ax * CHAN_ALONG + uX * CHAN_LIFT;
                    const ky = _sh[1] - rY * (sgn * CHAN_IN) + ay * CHAN_ALONG + uY * CHAN_LIFT;
                    const kz = _sh[2] - rZ * (sgn * CHAN_IN) + az * CHAN_ALONG + uZ * CHAN_LIFT;
                    hx += (kx - hx) * chan;
                    hy += (ky - hy) * chan;
                    hz += (kz - hz) * chan;
                }

                tx += (hx - tx) * cast;
                ty += (hy - ty) * cast;
                tz += (hz - tz) * cast;
            }

            // ---- board target: out, forward and a little down ---------------
            if (board > 0.001) {
                const carve = ch.carve;
                // Trailing arm rises, leading arm drops into the turn — the
                // same asymmetry a snowboarder holds through a carve.
                const rise = 0.02 + carve * sgn * 0.22;
                const sx = _sh[0] + rX * (sgn * 0.33) + fX * 0.24 + uX * rise;
                const sy = _sh[1] + rY * (sgn * 0.33) + fY * 0.24 + uY * rise;
                const sz = _sh[2] + rZ * (sgn * 0.33) + fZ * 0.24 + uZ * rise;
                tx += (sx - tx) * board;
                ty += (sy - ty) * board;
                tz += (sz - tz) * board;
            }

            // ---- charge target: fists drawn down and back -------------------
            //
            // Behind the hips and low, which is where a body gathers before it
            // throws itself anywhere. Symmetric, like the channelling stance
            // and for the same reason: nothing is being aimed yet.
            if (charge > 0.001) {
                const gx = _sh[0] + rX * (sgn * 0.20) - uX * 0.42 - fX * 0.24;
                const gy = _sh[1] + rY * (sgn * 0.20) - uY * 0.42 - fY * 0.24;
                const gz = _sh[2] + rZ * (sgn * 0.20) - uZ * 0.42 - fZ * 0.24;
                tx += (gx - tx) * charge;
                ty += (gy - ty) * charge;
                tz += (gz - tz) * charge;
            }

            // ---- bolt target: overhead climbing, trailing descending --------
            //
            // Two poses on one blend, picked by which way the strike is
            // pointed. Climbing, both arms go straight up along the axis of
            // travel and the body becomes an arrowhead — this is the pose the
            // whole effect is built around, and the arms are what give the
            // column something to have been fired *from*. Descending they sweep
            // back and out instead, so the figure arrives feet-first with its
            // hands clear of the ground it is about to plant one on.
            //
            // 0.50 m from a 0.54 m shoulder, so the elbow is nearly straight
            // but not locked. This is the one pose in the file where a straight
            // arm is wanted — everything else here goes out of its way to keep
            // the joint bent, but an arm thrown overhead against 620 m/s of
            // acceleration is an arm at full extension.
            if (bolt > 0.001) {
                const up = ch.boltDir > 0;
                // Note the climbing offset is *negative* — the hands are drawn
                // inboard of the shoulders rather than pushed out from them.
                // The shoulders are 0.37 m apart, so hands placed even slightly
                // outboard finish half a metre apart and the arrowhead has a
                // gap in it; at -0.13 they close to about 0.11 and the arms
                // read as one point. The channelling stance draws hands inboard
                // for the same reason and says so at `CHAN_IN`.
                const outw = up ? -0.13 : 0.16;
                const alongU = up ? 0.50 : -0.44;
                const backF = up ? -0.06 : 0.10;
                const gx = _sh[0] + rX * (sgn * outw) + uX * alongU - fX * backF;
                const gy = _sh[1] + rY * (sgn * outw) + uY * alongU - fY * backF;
                const gz = _sh[2] + rZ * (sgn * outw) + uZ * alongU - fZ * backF;
                tx += (gx - tx) * bolt;
                ty += (gy - ty) * bolt;
                tz += (gz - tz) * bolt;
            }

            // ---- landing target: one fist planted, one arm swept back -------
            //
            // Asymmetric, and it has to be — this is the only arm pose here
            // that is not a mirror. The left hand goes to the ground and the
            // right sweeps back and out as the counterweight, which is the read
            // the whole landing is for.
            //
            // The planted hand is placed along a direction from the shoulder
            // rather than at a world point on the snow, at 0.53 m of the arm's
            // 0.54. Aiming it at the ground itself is the obvious way and it is
            // wrong: the target then sits outside reach, `solveTwoBone` pulls
            // it back to 0.537 along the same line, and the fist ends up
            // hanging wherever that lands — which moves with the pelvis and
            // therefore slides during the recovery. Placed by direction it is
            // always exactly reachable, so the arm is straight, the fist is
            // still, and `LAND_HIP` is what decides how close to the snow it
            // is. See the note there.
            //
            // **Both targets here are built on world axes, not on the chest
            // frame**, and that is the one thing this branch gets wrong if it
            // is written like every other target above it. At `LAND_PITCH` the
            // body is tipped seventy-two degrees, so the chest's own "down"
            // (`-u`) points down *and backwards* and its "forward" (`f`) points
            // down and forwards — reaching for the ground along them sent the
            // fist 24 cm into the air and behind the shoulder, and swung the
            // counterweight arm out in *front* of the planted one. The snow is
            // a world fact and the arm that reaches for it has to be aimed in
            // world terms.
            if (land > 0.001) {
                const wfx = Math.sin(ch.facing), wfz = Math.cos(ch.facing);
                const wrx = Math.cos(ch.facing), wrz = -Math.sin(ch.facing);
                let gx, gy, gz;
                if (a === 0) {
                    // Straight down, splayed a little out and forward so the
                    // arm clears the ribs and the fist lands ahead of the body.
                    let dx = wfx * 0.20 + wrx * -0.20;
                    let dy = -1;
                    let dz = wfz * 0.20 + wrz * -0.20;
                    const dl = Math.hypot(dx, dy, dz) || 1;
                    dx /= dl; dy /= dl; dz /= dl;
                    gx = _sh[0] + dx * 0.53;
                    gy = _sh[1] + dy * 0.53;
                    gz = _sh[2] + dz * 0.53;
                } else {
                    // Swept back, out and up — the counterweight. It has to
                    // finish clearly behind the planted fist or the two arms
                    // read as reaching for the same thing.
                    gx = _sh[0] + wrx * 0.34 - wfx * 0.34;
                    gy = _sh[1] + 0.20;
                    gz = _sh[2] + wrz * 0.34 - wfz * 0.34;
                }
                tx += (gx - tx) * land;
                ty += (gy - ty) * land;
                tz += (gz - tz) * land;
            }

            // Elbows point back and out.
            const px = -fX + rX * (sgn * 0.55), py = -fY + rY * (sgn * 0.55) - 0.35, pz = -fZ + rZ * (sgn * 0.55);
            solveTwoBone(
                _sh[0], _sh[1], _sh[2], tx, ty, tz, px, py, pz,
                UPPER_LEN, FORE_LEN, _p
            );

            this._setBone(
                upperB, _sh[0], _sh[1], _sh[2],
                _p[0] - _sh[0], _p[1] - _sh[1], _p[2] - _sh[2],
                fX, fY, fZ
            );
            this._setBone(
                foreB, _p[0], _p[1], _p[2],
                tx - _p[0], ty - _p[1], tz - _p[2],
                fX, fY, fZ
            );
            // The hand continues the forearm, rolled palm-inward.
            let hx = tx - _p[0], hy = ty - _p[1], hz = tz - _p[2];
            const hl = Math.hypot(hx, hy, hz) || 1;
            hx /= hl; hy /= hl; hz /= hl;
            this._setBone(handB, tx, ty, tz, hx, hy, hz, fX, fY, fZ);
        }
    }

    /** World position of a hand, for spell emitters. Writes 3 floats to `out`. */
    handPosition(which, out, od) {
        const b = which === 0 ? B_HAND_L : B_HAND_R;
        xformPoint(this.world, b * 16, 0, 0.09, 0, out, od);
    }
}

export { HIP_HEIGHT };
