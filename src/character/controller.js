/**
 * Character locomotion + snow-surf physics.
 *
 * This owns motion only — the visual rig, cloth and fur read the state this
 * produces. Three modes share one integrator:
 *
 *  - WALK: camera-relative desired velocity, eased facing, distance-driven gait
 *    phase so footfalls land where the feet actually are (no sliding).
 *  - SURF: momentum-carrying. Thrust along facing, steering from mouse yaw,
 *    strong lateral grip that bleeds into a drift as you push the carve, and
 *    slope-driven acceleration so dropping down a dune face feels like a gain.
 *  - FLY: the surf model with the ground taken out from under it, holding a
 *    fixed clearance above the snow so there is no altitude to manage. Toggled
 *    by a Space double-tap.
 *
 * Blending between them is eased in every direction; there is no snap.
 *
 * Flight itself has two tiers, and they differ in one thing only: what the
 * altitude hold is *holding*. The deck tier holds a clearance above the snow
 * and follows the ground. The sky tier holds an absolute ceiling above the
 * cloud deck and does not, because at four hundred metres the ground's ±25 m of
 * relief is not something you keep clearance against — following it would swim
 * the whole cloud layer up and down for no reason the player can see. Both are
 * the same integrator and the same `_flyStep`; the tier decides the target and
 * nothing else.
 *
 * **Moving between the two tiers is not flying, and is not integrated.** It is a
 * scripted three-beat strike — a wind-up, a shot, and (coming down) a landing —
 * and `_launchStep` below owns it end to end. The altitude during the shot is
 * *placed* on a curve rather than eased toward a target, which is the whole
 * reason this is a phase machine and not another blend: 435 m in under a second
 * has to arrive exactly, at a known instant, with a rate profile that other
 * systems can key an effect off. An exponential ease arrives approximately, at
 * no particular time, and its rate is whatever the residual gap happens to be.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scalar } from "@babylonjs/core/Maths/math.scalar";
import { input } from "../core/input.js";
import { expDamp } from "../core/camera.js";

const _wish = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _tmp = new Vector3();
const _n = new Vector3();

const WALK_SPEED = 2.5;
const RUN_SPEED = 5.4;
const WALK_ACCEL = 26;
const WALK_DECEL = 30;

const SURF_MAX = 19.5;
const SURF_THRUST = 11.0;
const SURF_DRAG = 0.42;
const SURF_TURN = 2.35; // rad/s at full steer
const SURF_GRIP = 7.5;

/**
 * Clearance held above the snow while flying, metres. Not an absolute altitude:
 * the ground is followed, which is the whole point of the mode — there is
 * nothing to manage and nothing to fly into.
 *
 * Twenty metres sits above the landform rather than inside it. The macro
 * terrain runs to roughly ±25 m of relief on a 58 m dune wavelength, so at this
 * height a crest passing underneath is a slow swell; at eight or ten it is a
 * wall rising into frame, and the mode stops reading as flight and starts
 * reading as a very tall character.
 */
const FLY_HEIGHT = 20.0;
/**
 * Climb rate cap, m/s. The approach to `FLY_HEIGHT` is eased, and an ease alone
 * leaves the deck at thirty-odd metres a second — a launch, not a lift. The cap
 * turns the first two thirds of the climb into a steady rise and leaves the ease
 * to do the arrival.
 */
const FLY_CLIMB = 9.0;
const FLY_EASE = 1.6;
/** Height at which the feet count as fully clear of the snow, metres. */
const FLY_CLEAR = 2.0;

/**
 * The sky tier's ceiling, as an **absolute world height** rather than a
 * clearance. See the header for why this one is not ground-relative.
 *
 * Twenty-five metres over the cloud deck's mean top (`DECK_Y` in
 * `vfx/cloudDeck.js`, 430 m), which is deliberately close. Sitting a hundred
 * metres clear of the tops turns the deck into scenery on the floor and the
 * mode into the deck tier with a longer lift; skimming it means the taller
 * towers come through the flight path and the player spends the whole time
 * punching in and out of cloud, which is the entire point of going up there.
 *
 * It also has to be close for a reason that is nothing to do with taste. The
 * clipmap only reaches 870 m and there is no fog worth the name at this
 * altitude — the field's haze has a 22 m scale height, so 400 m up there is
 * none of it left to hide the edge of the world with. What hides it is the deck
 * itself: at 25 m of clearance the sightline to the clipmap's rim crosses the
 * cloud plane about forty metres out, where the deck is effectively solid. At a
 * hundred metres of clearance it crosses at a hundred and seventy, out among the
 * holes, and the world draws as a disc floating in the sky.
 */
const SKY_CEILING = 455.0;

/**
 * The wind-up, seconds.
 *
 * Long enough to be a decision and short enough not to be a wait. Under about
 * 0.35 s the gather has no time to build and the launch reads as the four-tap
 * simply having a delay in it; past about 0.8 s the player has finished
 * anticipating and starts wondering whether the input registered.
 *
 * Nothing scales with it — the ceiling is fixed, so there is no bigger shot to
 * buy by holding longer, which is why this is a fixed wind-up rather than a
 * held charge like the Comet's. The gesture that starts it is unchanged: the
 * input layer still reports one `skyToggle` edge and knows nothing about any of
 * this.
 */
const CHARGE_TIME = 0.55;
/**
 * The shot, seconds — the same in both directions.
 *
 * 435 m in this, so a mean of about 460 m/s and a peak near 620 (see
 * `shotCurve`). That is a strike rather than a climb, which is the point, and
 * it is what forces every other choice here: nothing about the transit can be
 * integrated at frame cadence and expected to land, the camera cannot track it
 * on the spring alone (`followBoost` in `core/camera.js`), and the cloud deck's
 * whole 40 m thickness is crossed in about five frames.
 *
 * It was seven seconds before this, on an eased rate cap, and the cap's easing
 * *was* the launch. That mechanism is gone entirely — a curve this fast has to
 * terminate exactly rather than asymptotically, because arriving 3 m short of a
 * ceiling the deck is drawn against is arriving inside the cloud.
 */
const SHOT_TIME = 0.95;
/**
 * Fractions of the shot spent building the rate and shedding it again.
 *
 * The plateau between them is what makes it read as a bolt: constant velocity
 * with hard ends, rather than the smooth accelerate-decelerate of something
 * being carried. The accel is deliberately the shorter of the two — a strike
 * starts instantly and dissipates, so the asymmetry is the read — but it is not
 * zero, because an instantaneous step to 620 m/s gives the camera and the pose
 * nothing to respond to and the launch stops being an event.
 *
 * They are also what sets the peak rate: the curve's area is `1 - A/2 - D/2`,
 * so raising either one raises the speed needed to cover the same distance in
 * the same time. Past about 0.6 between them there is no plateau left and the
 * profile collapses into a smoothstep.
 */
const SHOT_ACCEL = 0.18;
const SHOT_DECEL = 0.35;
/**
 * The landing recovery, seconds, and the fraction of it spent held at the
 * bottom of the pose before rising out of it.
 *
 * The hold is the whole superhero landing. Coming straight back up out of the
 * crouch reads as a stumble that was recovered from; stopping dead in the pose
 * for a fifth of a second reads as having meant it. It is the same trick the
 * Comet's `HOLD_TIME` plays with the implosion — an empty beat costs nothing
 * and is most of what makes the thing on either side of it land.
 */
const LAND_TIME = 0.90;
const LAND_HOLD = 0.22;
/**
 * Metres of climb the `sky` blend is measured across, from `FLY_HEIGHT` up.
 *
 * Ten per cent short of the real span, so that a ceiling being held over the
 * top of a 25 m dune still saturates instead of stalling at 0.94.
 */
const SKY_SPAN = (SKY_CEILING - FLY_HEIGHT) * 0.9;

const FLY_MAX = 26.0;
const FLY_THRUST = 13.0;
const FLY_DRAG = 0.26;
const FLY_TURN = 1.95; // rad/s — slower than the board; air has no edge to bite
const FLY_GRIP = 2.6; // a third of SURF_GRIP: a turn up here is a drift

/**
 * Speeds between which the flight pose rolls from an upright hover into a prone
 * dive, m/s.
 *
 * The top of the range is well below the 26 m/s cruise on purpose. Scaling the
 * pose all the way to terminal speed means the figure is never quite committed
 * to it — it arrives at the shape at the same moment it runs out of throttle,
 * and every metre of ordinary cruising is spent somewhere in the middle looking
 * like neither. Finishing at seventeen leaves the whole top third of the speed
 * range flying properly, and the transition still takes most of a second of
 * held throttle to cross, which is what makes it read as acceleration.
 */
const FLY_PRONE_LO = 4.0;
const FLY_PRONE_HI = 17.0;

/** Gait: metres of travel per full stride cycle, scaled by speed. */
const STRIDE_BASE = 1.55;

export class CharacterController {
    /**
     * @param {{ heightAt(x:number,z:number):number, normalAt(x:number,z:number,out:Vector3):Vector3 }} terrain
     */
    constructor(terrain) {
        this.terrain = terrain;

        this.position = new Vector3(0, 0, 0);
        this.velocity = new Vector3(0, 0, 0);
        this.prevVelocity = new Vector3(0, 0, 0);
        this.acceleration = new Vector3(0, 0, 0);

        this.facing = 0; // yaw, radians
        this.speed = 0;
        this.speed01 = 0; // normalised against SURF_MAX, for FOV/wind

        /** 0 = walking, 1 = fully surfing. Eased. */
        this.surf = 0;
        this.surfActive = false;

        /**
         * Flight. `flying` is the mode latch the Space double-tap toggles,
         * `altitude` is the clearance currently being held above the snow, and
         * `airborne` is 0..1 — how far off the deck the character actually is.
         *
         * `airborne` is a blend rather than a flag on purpose. Everything that
         * has to stop happening once the feet leave the snow — footprints, the
         * wake, settling into the surface — fades out on it, and everything that
         * has to start happening fades in on the same number. Takeoff and
         * landing are then one transition, described in one place, instead of
         * five systems each picking their own threshold and disagreeing about
         * which metre of the descent the character is back on the ground.
         */
        this.flying = false;
        this.altitude = 0;
        this.airborne = 0;
        /**
         * Metres between the snow and where the body is actually drawn. The
         * figure poses from `heightAt`, not from `position.y`, so it has to lift
         * its whole ground reference by this — see `Figure._ground`.
         */
        this.lift = 0;

        /**
         * The sky tier. `inSky` is the latch the Space four-tap toggles; `sky`
         * is 0..1, how far up the transit between the two flight tiers the
         * character actually is.
         *
         * A blend for the same reason `airborne` is one: everything that only
         * belongs up there fades in on it and everything that belongs on the
         * deck fades out, so the transit is described once instead of by five
         * systems each choosing an altitude they think counts as "in the sky".
         * It is *not* what the clouds fade in on — those key off the camera's
         * own height, because they are a feature of the world and have to be
         * there whether the player climbed to them or fell past them.
         */
        this.inSky = false;
        this.sky = 0;

        /**
         * The strike that carries the character between the two tiers, as four
         * published numbers. `vfx/skyBolt.js` draws all of it and `figure.js`
         * poses off all of it; nothing else needs to know the phase machine
         * exists.
         *
         * `charge`  0..1, the wind-up. Ramps over `CHARGE_TIME` and then decays
         *           fast, so the release is the coil letting go rather than a
         *           value being cleared.
         * `bolt`    0..1, in the strike. Snapped to 1 at the shot — a discharge
         *           is the one thing that never fades *in* — and decayed after
         *           it, which is the arcs dissipating.
         * `boltT`   0..1, progress through the shot itself, 0 outside it. The
         *           effect shapes its own rates off this; the pose does not.
         * `boltDir` +1 climbing, -1 descending. Which end of the strike the
         *           character is pointed at, and the only thing that
         *           distinguishes the two shots from each other.
         * `land`    0..1, the superhero landing. 1 at impact, held, then eased
         *           out over `LAND_TIME`.
         */
        this.charge = 0;
        this.bolt = 0;
        this.boltT = 0;
        this.boltDir = 1;
        this.land = 0;
        /**
         * Set for exactly one frame when the feet hit the snow out of a
         * descent. The crater, the burst and the camera trauma all fire off
         * this rather than off `land` crossing a threshold, because a threshold
         * on a value that is 1 for a fifth of a second fires on whichever frame
         * it is sampled and a one-frame edge fires once.
         */
        this.landImpact = false;
        /**
         * True while the wind-up or the shot owns the character.
         *
         * Steering, thrust and the gait are all suppressed against it. A strike
         * you can walk out of halfway through is not one, and more practically:
         * the shot places `position.y` on a curve, so anything still integrating
         * underneath it is a second author of the same number.
         */
        this.locked = false;

        /** 0 idle, 1 charging, 2 in the shot, 3 recovering from the landing. */
        this._phase = 0;
        this._phaseT = 0;
        /** Altitude the shot runs between, metres. Fixed at the moment it fires. */
        this._shotFrom = 0;
        this._shotTo = 0;
        /** What `inSky` becomes when the wind-up completes. See `_fire`. */
        this._pendingSky = false;

        /**
         * Vertical rate, m/s, signed. Mirrored into `velocity.y`.
         *
         * `velocity` was horizontal-only until the sky tier existed, because
         * every metre of vertical motion came out of the altitude hold rather
         * than out of the integrator and nothing needed to know about it. The
         * launch changed that: at 120 m/s the camera spring, the airflow and the
         * pose all have to be told, and the honest place for it is the velocity
         * vector the rest of the demo already reads.
         */
        this.climbRate = 0;

        /**
         * 0..1, not walking — on a board or in the air. Read by the figure and
         * by the gait, both of which only want to know that there is no stride
         * to run. It is deliberately *not* a pose: the board pose and the flight
         * pose are different shapes, and which one is being blended in is
         * decided by `airborne` against this. The wake and the contact system
         * want `surf` specifically and must not use this.
         */
        this.stance = 0;

        /**
         * 0..1, how far the flight pose has committed from an upright hover to
         * a prone dive — arms swept back, legs straight and trailing, the chest
         * arched so the head still looks along the direction of travel.
         *
         * It is speed that decides this and not altitude, because that is the
         * whole shape of the mode: a hover is a person standing in the air and
         * holding station, and a cruise is a person being thrown through it
         * head-first. Tying the two ends of that to the throttle means the pose
         * is reporting what the player is doing rather than announcing which
         * mode they are in. Zero on the ground, by way of `airborne`.
         */
        this.prone = 0;

        /**
         * 0 = not casting, 1 = fully in the bending stance. Written by the spell
         * system, read by the figure.
         *
         * It lives here rather than on the spell system because the figure
         * already reads the controller for everything else it poses from, and a
         * second source of "what is this character doing" is how the arms and the
         * legs end up disagreeing about which frame it is.
         */
        this.cast = 0;
        this.castAimX = 0;
        this.castAimY = 0;
        this.castAimZ = 1;

        /**
         * 0 = the one-handed bending throw, 1 = the two-handed channelling
         * stance. Written by the spell system alongside `cast`, read by the
         * figure.
         *
         * A second number rather than a second value of `cast` because the two
         * answer different questions — `cast` is *whether* the figure is
         * casting, this is *which* stance — and folding them together means a
         * spell that changes stance mid-cast has to pass through "not casting"
         * to get there, dropping the arms to the walk pose and lifting them
         * again.
         */
        this.channel = 0;

        /** Signed lean, -1..1 (right positive), from lateral acceleration. */
        this.lean = 0;
        /** Signed carve amount for wake shaping. Positive = turning right. */
        this.carve = 0;
        /**
         * 0..1, how hard the screen-space speed streaks should read. Deadbanded
         * well above walking pace: streaks at a jog make the demo feel cheap.
         */
        this.streak01 = 0;

        // ------------------------------------------------------------- gait
        this.gaitPhase = 0;
        /**
         * True when the legs should be running a gait at all.
         *
         * One flag, read by the figure and by the contact system, because three
         * copies of "is this character walking" is three chances for the feet to
         * disagree with the footprints.
         */
        this.stepping = true;
        /** Set true for exactly one frame when a foot plants. */
        this.footfall = false;
        /** 0 = left foot, 1 = right foot — which foot just planted. */
        this.footIndex = 0;
        /** World position of the foot that just planted. */
        this.footPos = new Vector3();
        /** Impact strength 0..1, scales spray and deformation depth. */
        this.footImpact = 0;

        this.groundY = terrain.heightAt(this.position.x, this.position.z);
        this.groundNormal = new Vector3(0, 1, 0);

        /**
         * Smoothed snow height the body rides on. Seeded from the spawn point,
         * because damping up from zero on the first frame is a visible drop.
         */
        this._groundRef = this.groundY;

        /**
         * Last frame's drawn height and vertical rate, for `climbRate` and the
         * launch shake.
         *
         * Seeded from `_groundRef` and not from `position.y`, which is still
         * zero here — `main.js` drops the character onto the snow after
         * construction, and differencing against an unset origin would report a
         * first frame at several thousand metres a second and fire the shake
         * behind the loading screen.
         */
        this._prevY = this._groundRef;
        this._prevClimb = 0;

        this._prevSpeed = 0;
    }

    /**
     * @param {number} dt
     * @param {import("../core/camera.js").CameraRig} rig
     */
    update(dt, rig) {
        const h = Math.min(dt, 1 / 30);

        this.prevVelocity.copyFrom(this.velocity);

        // ------------------------------------------------------------- flight
        // Toggles, not held inputs: flight is a mode, so it survives the player
        // letting go of the keyboard and it survives an alt-tab.
        //
        // The four-tap supersedes the double-tap it necessarily contains — the
        // input layer has already fired `flyToggle` for the first pair by the
        // time the second lands, so whatever the first pair did to `flying` is
        // overwritten when the strike fires. Leaving the sky always goes all the
        // way home; a four-tap that dropped the player to the deck tier would
        // leave no gesture for the ground.
        //
        // Neither latch moves here any more. The four-tap starts a wind-up and
        // `_fire` flips the tier when the wind-up completes — see there for why
        // it cannot happen on this line.
        if (input.skyToggle && this._phase !== 1 && this._phase !== 2) {
            this._phase = 1;
            this._phaseT = 0;
            this._pendingSky = !this.inSky;
        } else if (input.flyToggle && !this.inSky && !this.locked) {
            // Inert while up there, and it has to be: a double-tap in the sky is
            // the front half of the gesture that brings you down, so spending it
            // on a tier change would make the four-tap impossible to complete.
            // Inert during the strike for the same reason it is inert up there —
            // the front half of a four-tap must not also mean something.
            this.flying = !this.flying;
        }

        this._launchStep(h, rig);

        // The sky tier's target is an absolute ceiling, expressed as the
        // clearance that lands on it. `position.y` is built as
        // `_groundRef + altitude` and `_groundRef` is what is subtracted here,
        // so the two cancel exactly and the character holds a true height while
        // the deck tier goes on holding a clearance — one integrator, one line
        // of difference. The floor keeps the target sane if the snow under the
        // player were ever to rise past the ceiling, which the current world
        // cannot do but which costs nothing to rule out.
        const target = this.inSky
            ? Math.max(FLY_HEIGHT, SKY_CEILING - this._groundRef)
            : this.flying ? FLY_HEIGHT : 0;

        if (this._phase === 2) {
            // The shot owns the altitude outright: placed on `shotCurve`, not
            // eased toward anything. `climbRate` below is differenced off the
            // drawn height, so the whole rate profile — and with it the camera
            // lead, the pose, the airflow and the shake — falls out of this one
            // line without anybody integrating a velocity.
            const s = Math.min(1, this._phaseT / SHOT_TIME);
            this.altitude =
                this._shotFrom + (this._shotTo - this._shotFrom) * shotCurve(s);
        } else {
            // Deck tier, unchanged: eased approach under a flat rate cap. This
            // used to carry an eased cap as well, which was how the sky transit
            // was launched; the cap never moved for anything the deck tier did,
            // so removing it leaves every metre of ordinary flight identical.
            const climb = target - this.altitude;
            const cap = FLY_CLIMB * h;
            this.altitude += Scalar.Clamp(climb * (1 - Math.exp(-FLY_EASE * h)), -cap, cap);
            // The tail of an exponential never arrives and a landing has to.
            // Below a centimetre there is nothing left to descend through.
            if (!this.flying && this.altitude < 0.01) this.altitude = 0;
        }
        this.airborne = Scalar.Clamp(this.altitude / FLY_CLEAR, 0, 1);
        // Against a fixed span, not against the live target. Normalising by
        // `target - FLY_HEIGHT` looks tidier and is wrong in exactly one place:
        // the moment the player asks to come down the target collapses to zero,
        // the denominator with it, and `sky` pins at 1 for the whole descent and
        // then falls off a cliff in the last metre. The span is short of the
        // real one so that a ceiling held over high ground still reaches 1.
        this.sky = Scalar.Clamp((this.altitude - FLY_HEIGHT) / SKY_SPAN, 0, 1);

        // Surfing is something you do on a surface. Suppressed here rather than
        // in the input layer, so the right mouse button keeps meaning one thing.
        this.surfActive = input.surf && !this.flying;

        // Ease the surf blend — entering and exiting are transitions, not switches.
        this.surf = expDamp(this.surf, this.surfActive ? 1 : 0, this.surfActive ? 2.6 : 3.4, h);
        this.stance = Math.max(this.surf, this.airborne);

        rig.getFlatForward(_fwd);
        rig.getFlatRight(_right);

        if (this.locked) {
            // No steering and no thrust through the wind-up or the shot. The
            // charge also scrubs whatever momentum was carried into it, so the
            // strike always leaves from a planted, still figure and always goes
            // straight up — a bolt that leaves at an angle because the player
            // happened to be cruising is a bolt with a lean in it, and the pose,
            // the column and the camera lead are all built on a vertical axis.
            //
            // 6/s takes 26 m/s of cruise down to under 1 across the wind-up,
            // which is inside the time the crouch takes to close anyway.
            const k = Math.exp(-6 * h);
            this.velocity.x *= k;
            this.velocity.z *= k;
        } else if (this.airborne > 0.5) this._flyStep(h, rig);
        else if (this.surf > 0.5) this._surfStep(h, rig);
        else this._walkStep(h);

        // ---------------------------------------------------- integrate + snap
        this.position.x += this.velocity.x * h;
        this.position.z += this.velocity.z * h;

        this.groundY = this.terrain.heightAt(this.position.x, this.position.z);
        this.terrain.normalAt(this.position.x, this.position.z, this.groundNormal);
        // Ground tracking is a snap on the deck and a glide in the air: the same
        // micro-ripples that must not jitter the rig at zero metres must not
        // become hover bob at twenty. Blended by height rather than switched, so
        // a landing does not pop the accumulated lag out in a single frame.
        //
        // The altitude is then added *exactly*, rather than damped along with
        // everything else. That is what lets a descent actually reach the ground
        // instead of asymptoting a few centimetres above it, and it is what
        // makes `lift` zero on flat snow — so nothing changes when not flying.
        //
        // And it stops entirely in the sky tier, which is what actually makes
        // that tier's ceiling absolute. Subtracting `_groundRef` from the target
        // cancels it only once the altitude ease has *caught up* with it, and a
        // reference still moving at ten metres a second leaves the ease a good
        // seven metres behind — so the ceiling swam by ±10 m over the dunes,
        // which is most of the wobble it was supposed to remove. Frozen, the
        // target is constant, the ease converges, and the two cancel exactly.
        // It thaws on the way down long before the altitude matters, because
        // `sky` falls with it.
        let trackRate = (26 - 23.5 * this.airborne) * (1 - this.sky);
        // The descent is the one case the rate above cannot serve. `position.y`
        // is `_groundRef + altitude` and the shot drives `altitude` to exactly
        // zero, so the character lands on `_groundRef` — which, at the airborne
        // rate of 2.5/s, is still wherever the snow was several seconds ago.
        // Over a dune that is metres, and the superhero landing plants a knee in
        // mid-air or a foot inside the ground.
        //
        // Forced to converge across the back half of the shot instead, on the
        // square so that almost all of it happens in the last third where the
        // rate has already been shed. It is a correction of a few metres applied
        // at ~30/s against a descent doing hundreds, so it is invisible under
        // the shot and exact by the time the shot ends.
        if (this._phase === 2 && this.boltDir < 0) {
            const s = this._phaseT / SHOT_TIME;
            trackRate = Math.max(trackRate, 30 * s * s);
        }
        this._groundRef = expDamp(this._groundRef, this.groundY, trackRate, h);
        this.position.y = this._groundRef + this.altitude;
        this.lift = this.position.y - this.groundY;

        // Differenced off the drawn height rather than reconstructed from the
        // altitude step, so it carries the ground-following term too — which is
        // most of it at walking pace and none of it in the sky.
        this.climbRate = (this.position.y - this._prevY) / h;
        this._prevY = this.position.y;
        this.velocity.y = this.climbRate;

        // Vertical acceleration, and the only thing in flight with an edge to
        // it. Added as a rate against the rig's own decay, the way the carve
        // does, so it reaches an equilibrium instead of accumulating. It falls
        // to nothing the moment the climb rate stops changing, so the cruise up
        // there is dead still.
        //
        // Gated on the strike rather than on the acceleration alone. An ordinary
        // takeoff steps the climb rate from nothing to 9 m/s in one frame, which
        // is a large enough second derivative to trip any threshold worth having
        // — and a lift onto a hover is not a thing the camera should shake for.
        //
        // The shot's own accel phase runs near 3600 m/s², which saturates this
        // immediately; it is the ramp and the arrival that shake rather than the
        // plateau between them, which is the correct read and comes out of the
        // curve for free. The impulses at the two ends are struck in `_fire` and
        // at the landing, because those are events rather than rates.
        const vertAccel = Math.abs(this.climbRate - this._prevClimb) / h;
        this._prevClimb = this.climbRate;
        if (this.bolt > 0.01 && vertAccel > 4) {
            rig.addTrauma(Math.min(0.6, (vertAccel - 4) * 0.0035) * h);
        }

        // The pivot spring cannot track the shot on its stock frequency: a
        // critically damped spring lags a ramp by `2v/ω`, which at 620 m/s and
        // ω = 7.5 is 165 m of arm. The rig stiffens itself against this and
        // moves its own feed-forward to match — see `followBoost` there. Held
        // through the landing recovery as well, so the arm does not slacken
        // while the character is still stopping.
        rig.followBoost = Math.max(this.bolt, this.land);

        // --------------------------------------------------------- bookkeeping
        this.speed = Math.hypot(this.velocity.x, this.velocity.z);
        // Vertical rate folded in at roughly half weight, so the launch opens
        // the FOV and lights the streaks even though nothing horizontal is
        // happening. Half rather than whole because a climb is a narrower,
        // straighter kind of fast than a run across the snow is, and matching
        // them one for one puts a hover-and-lift at the same field of view as a
        // full carve.
        //
        // Gated on `airborne` so the deck is untouched. `climbRate` carries the
        // ground-following term too, and without the gate a surf run down a dune
        // face would widen the field of view by a percent or so for reasons the
        // player cannot see — a small change, but a change to a mode that was
        // already tuned, made by a feature four hundred metres above it.
        const airSpeed = Math.hypot(this.speed, this.climbRate * 0.5 * this.airborne);
        this.speed01 = Scalar.Clamp(airSpeed / SURF_MAX, 0, 1);

        this.acceleration.x = (this.velocity.x - this.prevVelocity.x) / h;
        this.acceleration.z = (this.velocity.z - this.prevVelocity.z) / h;

        // Lateral acceleration → lean. Project accel onto the character's right.
        const rx = Math.cos(this.facing);
        const rz = -Math.sin(this.facing);
        const latAcc = this.acceleration.x * rx + this.acceleration.z * rz;
        const leanWant = Scalar.Clamp(latAcc / 26, -1, 1) * (0.35 + 0.65 * this.stance);
        this.lean = expDamp(this.lean, leanWant, 6.5, h);
        this.carve = expDamp(this.carve, leanWant, 9, h);

        // Stance, not surf: flight is the fastest thing in the demo and the one
        // place the streaks have the most to say — and the sky launch is the
        // fastest thing in flight, which is why this reads the combined rate
        // rather than the horizontal one.
        this.streak01 = this.stance * Scalar.Clamp((airSpeed - 7) / 11, 0, 1);

        // Undamped, like `streak01` above and for the same reason: `speed` is an
        // integrated quantity that already moves at the drag rate, so a second
        // filter on top of it only adds lag to a transition the player is
        // steering by hand.
        this.prone = this.airborne * Scalar.Clamp(
            (this.speed - FLY_PRONE_LO) / (FLY_PRONE_HI - FLY_PRONE_LO), 0, 1
        );

        this._gait(h);
    }

    /**
     * The strike, end to end: wind-up, shot, landing recovery.
     *
     * Everything here is a clock. The altitude the shot produces is placed in
     * `update` from `boltT`; this owns only the phase, the four published
     * blends and the two impulses at the ends.
     *
     * @param {number} h clamped dt
     * @param {import("../core/camera.js").CameraRig} rig
     */
    _launchStep(h, rig) {
        // Cleared every frame, set for one by `_arrive`. See `landImpact`.
        this.landImpact = false;

        if (this._phase === 1) {
            this._phaseT += h;
            this.charge = Math.min(1, this._phaseT / CHARGE_TIME);
            this.boltT = 0;
            if (this._phaseT >= CHARGE_TIME) this._fire(rig);
        } else if (this._phase === 2) {
            this._phaseT += h;
            this.boltT = Math.min(1, this._phaseT / SHOT_TIME);
            this.bolt = 1;
            // The coil releasing. Faster than it wound up, because that is what
            // a release is — and it has to be clear of the pose before the arms
            // are needed overhead, which is inside the first fifth of the shot.
            this.charge = expDamp(this.charge, 0, 12, h);
            if (this._phaseT >= SHOT_TIME) this._arrive(rig);
        } else if (this._phase === 3) {
            this._phaseT += h;
            const u = Math.min(1, this._phaseT / LAND_TIME);
            // Held flat at the bottom, then eased out. See `LAND_HOLD`.
            this.land = u < LAND_HOLD
                ? 1
                : 1 - smoothstep((u - LAND_HOLD) / (1 - LAND_HOLD));
            this.boltT = 0;
            this.bolt = expDamp(this.bolt, 0, 7, h);
            this.charge = expDamp(this.charge, 0, 12, h);
            if (u >= 1) {
                this._phase = 0;
                this.land = 0;
            }
        } else {
            this.charge = expDamp(this.charge, 0, 12, h);
            this.bolt = expDamp(this.bolt, 0, 7, h);
            this.land = 0;
            this.boltT = 0;
        }

        // Recomputed after the transitions above rather than before them, so a
        // frame that fires or arrives carries the phase it ended in.
        this.locked = this._phase === 1 || this._phase === 2;
    }

    /**
     * The wind-up completes and the strike leaves.
     *
     * The tier latches flip *here* and not when the gesture arrived, which is
     * the one ordering decision in this file worth stating: `inSky` is what the
     * altitude target is built from, so flipping it at the four-tap would spend
     * the whole wind-up climbing — the character would already be on their way
     * before the charge that is supposed to throw them had finished.
     *
     * @param {import("../core/camera.js").CameraRig} rig
     */
    _fire(rig) {
        this.inSky = this._pendingSky;
        this.flying = this.inSky;

        this._phase = 2;
        this._phaseT = 0;
        this._shotFrom = this.altitude;
        // The ceiling as a clearance, exactly as the deck tier's target is
        // built. Fixed at this instant rather than tracked: `_groundRef` freezes
        // on `sky` within the first tenth of the climb and the character is not
        // moving horizontally, so the most it can drift underneath a shot is
        // well under a metre — against 25 m of clearance over the cloud tops.
        this._shotTo = this.inSky
            ? Math.max(FLY_HEIGHT, SKY_CEILING - this._groundRef)
            : 0;
        this.boltDir = this._shotTo >= this._shotFrom ? 1 : -1;
        // Struck, not faded up. A discharge is the one thing that never has a
        // rise time.
        this.bolt = 1;
        this.boltT = 0;
        rig.addTrauma(0.45);
    }

    /**
     * The shot lands. Upward that is simply the end of it; downward it is the
     * superhero landing, which is a phase of its own.
     *
     * @param {import("../core/camera.js").CameraRig} rig
     */
    _arrive(rig) {
        // Placed exactly rather than left wherever the last frame's `boltT`
        // clamp put it. The curve terminates on 1, but the frame that crosses
        // the end overshoots in time, not in distance, and this is what makes
        // "the altitude at the end of the shot" a number rather than an
        // approximation — the ceiling the cloud deck is drawn against depends
        // on it.
        this.altitude = this._shotTo;
        this._phaseT = 0;
        this.boltT = 1;

        if (this.boltDir < 0) {
            this._phase = 3;
            this.land = 1;
            this.landImpact = true;
            rig.addTrauma(0.7);
        } else {
            this._phase = 0;
        }
    }

    _walkStep(h) {
        const maxSpeed = input.sprint ? RUN_SPEED : WALK_SPEED;

        _wish.set(
            _fwd.x * input.moveZ + _right.x * input.moveX,
            0,
            _fwd.z * input.moveZ + _right.z * input.moveX
        );

        const wishLen = Math.hypot(_wish.x, _wish.z);
        if (wishLen > 0.001) {
            _wish.x = (_wish.x / wishLen) * maxSpeed;
            _wish.z = (_wish.z / wishLen) * maxSpeed;

            const a = WALK_ACCEL * h;
            this.velocity.x += Scalar.Clamp(_wish.x - this.velocity.x, -a, a);
            this.velocity.z += Scalar.Clamp(_wish.z - this.velocity.z, -a, a);

            // Face the direction of travel, eased.
            const want = Math.atan2(_wish.x, _wish.z);
            this.facing = angleDamp(this.facing, want, 11, h);
        } else {
            const d = WALK_DECEL * h;
            const s = Math.hypot(this.velocity.x, this.velocity.z);
            if (s > 0.0001) {
                const k = Math.max(0, s - d) / s;
                this.velocity.x *= k;
                this.velocity.z *= k;
            }
        }
    }

    _surfStep(h, rig) {
        // Steer from the mouse (camera yaw drift) plus explicit A/D.
        const steer = Scalar.Clamp(
            input.moveX * 0.85 + angleDelta(this.facing, rig.yaw) * 1.25,
            -1,
            1
        );
        this.facing += steer * SURF_TURN * h;

        // Camera shake, and only from the one thing that earns it: an edge
        // loaded up at speed. Added as a rate rather than as an impulse, so it
        // reaches an equilibrium against the rig's own decay — hard carve at top
        // speed settles around 0.4 trauma, which is a couple of centimetres of
        // rig movement. Anything you can consciously see here is too much.
        const load = Math.abs(steer) * (this.speed / SURF_MAX);
        if (load > 0.25) rig.addTrauma((load - 0.25) * 1.35 * h);

        const fx = Math.sin(this.facing);
        const fz = Math.cos(this.facing);

        // Slope: heading downhill adds speed, uphill scrubs it.
        this.terrain.normalAt(this.position.x, this.position.z, _n);
        const slopeAssist = -(_n.x * fx + _n.z * fz) * 26;

        let thrust = SURF_THRUST + slopeAssist;
        if (input.moveZ < 0) thrust -= 14; // pull back to scrub speed

        this.velocity.x += fx * thrust * h;
        this.velocity.z += fz * thrust * h;

        // Lateral grip: kill sideways velocity, but not entirely — the residual
        // is what reads as a drift when you overcook the turn.
        const rx = Math.cos(this.facing);
        const rz = -Math.sin(this.facing);
        const lat = this.velocity.x * rx + this.velocity.z * rz;
        const grip = Math.min(1, SURF_GRIP * h);
        this.velocity.x -= rx * lat * grip;
        this.velocity.z -= rz * lat * grip;

        // Quadratic drag → a natural terminal speed.
        const s = Math.hypot(this.velocity.x, this.velocity.z);
        if (s > 0.0001) {
            const drag = SURF_DRAG * s * s * 0.02 + 0.9;
            const k = Math.max(0, s - drag * h) / s;
            this.velocity.x *= k;
            this.velocity.z *= k;
        }
        if (s > SURF_MAX) {
            const k = SURF_MAX / s;
            this.velocity.x *= k;
            this.velocity.z *= k;
        }
    }

    /**
     * Flight.
     *
     * Deliberately the surf model with the ground removed: the same mouse
     * steering, the same momentum, the same terminal speed from a clamp with
     * quadratic drag shaping the run up to it. What changes is what the air
     * cannot give you. There is no slope to gain speed on, so the thrust is
     * flat; there is no edge to set, so the grip is a third of the board's and a
     * hard turn opens into a wide drifting arc instead of a carve; and there is
     * nothing to load an edge *against*, so this is the one mode that never asks
     * the rig for camera shake.
     *
     * Nothing here touches altitude. `update` holds that, and the player never
     * has to think about it.
     */
    _flyStep(h, rig) {
        const steer = Scalar.Clamp(
            input.moveX * 0.85 + angleDelta(this.facing, rig.yaw) * 1.25,
            -1,
            1
        );
        this.facing += steer * FLY_TURN * h;

        const fx = Math.sin(this.facing);
        const fz = Math.cos(this.facing);

        // Thrust is on demand rather than always-on as it is on the board. Let
        // go of everything up here and the drag has to bring the character to a
        // stationary hover — "hovering" is the resting state of this mode, and a
        // hover that keeps drifting off across the field is not one.
        let thrust = 0;
        if (input.moveZ > 0) thrust = FLY_THRUST;
        else if (input.moveZ < 0) thrust = -FLY_THRUST * 0.55;

        this.velocity.x += fx * thrust * h;
        this.velocity.z += fz * thrust * h;

        // Lateral grip. Loose, so the nose leads the velocity through a turn
        // rather than dragging it round — that lag is most of what separates
        // flying from being steered.
        const rx = Math.cos(this.facing);
        const rz = -Math.sin(this.facing);
        const lat = this.velocity.x * rx + this.velocity.z * rz;
        const grip = Math.min(1, FLY_GRIP * h);
        this.velocity.x -= rx * lat * grip;
        this.velocity.z -= rz * lat * grip;

        // Shift is a higher cruise, not a harder shove: the acceleration is what
        // the mode *feels* like, and raising that just makes the stick twitchy.
        const max = input.sprint ? FLY_MAX * 1.45 : FLY_MAX;

        const s = Math.hypot(this.velocity.x, this.velocity.z);
        if (s > 0.0001) {
            // The linear term is what actually parks a coasting hover; the
            // quadratic only shapes the top of the range.
            const drag = FLY_DRAG * s * s * 0.02 + 2.4;
            const k = Math.max(0, s - drag * h) / s;
            this.velocity.x *= k;
            this.velocity.z *= k;
        }
        if (s > max) {
            const k = max / s;
            this.velocity.x *= k;
            this.velocity.z *= k;
        }
    }

    /**
     * Distance-driven gait. Phase advances with ground travelled, not with time,
     * which is what keeps feet planted instead of sliding.
     */
    _gait(h) {
        this.footfall = false;

        // Feet stay on the board while surfing — and for the run-out afterwards,
        // and for as long as there is no ground under them.
        //
        // The surf blend eases to zero in a fifth of a second, but the momentum
        // takes two thirds of one to bleed off, and in between the character is
        // travelling at nineteen metres a second. The gait is distance-driven, so
        // it answered that with a twelve-hertz cadence and the legs blurred. A
        // sprint is the fastest thing anyone walks at; above it, glide.
        //
        // `stance` covers both cases at once, being the larger of the surf blend
        // and the height off the deck: there is no walking on a board and no
        // walking in the air, and this is the one place that has to say so.
        //
        // The strike suppresses it too, at both ends and for the same reason:
        // the wind-up is a planted coil and the landing recovery is a figure on
        // one knee, and a stride running underneath either of them puts the legs
        // somewhere the pose has already claimed. `land` is tested at its
        // half-way point rather than at zero, so the stride fades back in under
        // the last of the recovery instead of switching on beneath it.
        this.stepping =
            this.stance <= 0.5 && !this.locked && this.land <= 0.5
            && this.speed <= RUN_SPEED * 1.2;
        if (!this.stepping) {
            this.gaitPhase = 0;
            return;
        }

        const dist = this.speed * h;
        const stride = STRIDE_BASE * (0.72 + 0.28 * Math.min(1, this.speed / RUN_SPEED));
        const prev = this.gaitPhase;
        this.gaitPhase = (this.gaitPhase + dist / stride) % 1;

        if (this.speed < 0.15) return;

        // Two plants per cycle, at phase 0.0 and 0.5.
        const crossed =
            (prev < 0.5 && this.gaitPhase >= 0.5) || this.gaitPhase < prev;
        if (!crossed) return;

        this.footfall = true;
        this.footIndex = this.gaitPhase < 0.5 ? 0 : 1;
        this.footImpact = Scalar.Clamp(0.35 + this.speed / RUN_SPEED, 0, 1.3);

        // Offset the plant to the correct side of the body.
        const side = this.footIndex === 0 ? -0.17 : 0.17;
        const rx = Math.cos(this.facing);
        const rz = -Math.sin(this.facing);
        this.footPos.set(
            this.position.x + rx * side,
            this.position.y,
            this.position.z + rz * side
        );
    }
}

// ------------------------------------------------------------------ helpers

/**
 * Fraction of the shot's distance covered at normalised time `s`.
 *
 * The velocity profile underneath this is a plateau with a smoothstep ramp on
 * at `SHOT_ACCEL` and off at `SHOT_DECEL` — constant speed with hard ends,
 * which is what separates a bolt from something being carried. This is its
 * integral, normalised, so `shotCurve(0) === 0` and `shotCurve(1) === 1`
 * exactly and the character arrives on the metre it was aimed at.
 *
 * It is written out analytically rather than integrated numerically because a
 * smoothstep's integral is a quartic and there is no reason to build a table
 * for four terms. The three pieces are `C¹` at both joins: the ramps' slopes
 * are 1 where they meet the plateau, which is what stops the rate profile
 * having a corner in it that the camera and the shake would both key off.
 *
 * ∫₀ᵗ(3u² − 2u³)du = t³ − t⁴/2, so a full ramp contributes exactly half its
 * width and the total area is `1 − A/2 − D/2`. Dividing by that is what makes
 * the peak velocity fall out of the two ramp widths instead of being a third
 * constant that has to be kept in step with them.
 *
 * @param {number} s 0..1
 * @returns {number} 0..1
 */
export function shotCurve(s) {
    const A = SHOT_ACCEL;
    const D = SHOT_DECEL;
    const area = 1 - 0.5 * A - 0.5 * D;

    let g;
    if (s <= A) {
        const t = s / A;
        g = A * (t * t * t - 0.5 * t * t * t * t);
    } else if (s < 1 - D) {
        g = 0.5 * A + (s - A);
    } else {
        const u = (s - (1 - D)) / D;
        g = 0.5 * A + (1 - D - A) + D * (u - u * u * u + 0.5 * u * u * u * u);
    }
    return g / area;
}

/** Hermite ease on 0..1, clamped. */
function smoothstep(t) {
    const x = t < 0 ? 0 : t > 1 ? 1 : t;
    return x * x * (3 - 2 * x);
}

/** Shortest signed delta from a to b, wrapped to [-PI, PI]. */
export function angleDelta(a, b) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
}

/** Framerate-independent easing across the shortest arc. */
export function angleDamp(cur, target, rate, dt) {
    return cur + angleDelta(cur, target) * (1 - Math.exp(-rate * dt));
}
