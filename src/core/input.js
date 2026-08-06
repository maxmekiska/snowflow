/**
 * Raw input state. Everything lands in one mutable struct that systems poll —
 * no events fired into game code, no per-frame allocation.
 *
 * Mouse look uses pointer lock, which frees the right button for snow-surf.
 */

export const input = {
    // Movement axes, camera-relative, already normalised to a unit disc.
    moveX: 0,
    moveZ: 0,
    moving: false,

    // Accumulated mouse delta since last `endFrame()`, in radians.
    lookX: 0,
    lookY: 0,

    // Zoom, consumed by the camera rig.
    zoomDelta: 0,

    /** Right mouse or `Space` held. Resolved in `pollInput`, not on the event. */
    surf: false,
    sprint: false, // shift

    /**
     * Set for one frame when `Space` is double-tapped. Toggles flight.
     *
     * An edge rather than a state, because flight is a mode the controller
     * owns — the input layer's job is to say "the player asked", once.
     */
    flyToggle: false,

    /**
     * Set for one frame when `Space` is tapped four times. Toggles the sky tier.
     *
     * A four-tap *contains* a double-tap and there is no way around that: taps
     * one and two are indistinguishable from a flight toggle until tap three
     * arrives, so `flyToggle` has already fired by then. Holding the pair back
     * for `CHAIN_MS` to find out would put a third of a second of latency on the
     * gesture people use constantly to buy one they use rarely.
     *
     * So the first pair is allowed to mean what it always meant, and the
     * controller treats the second pair as superseding it — a four-tap from the
     * deck lifts off and then keeps going, which is the read anyway.
     */
    skyToggle: false,

    /** @type {number} 0 = none, else 1..6 — set on keydown, cleared each frame */
    spellPressed: 0,
    /** @type {boolean} spell 2 (Ribbon) is a held cast */
    spellHeld2: false,
    /** @type {boolean} spell 6 (Comet) charges while held */
    spellHeld6: false,

    locked: false,
};

const keys = Object.create(null);

const LOOK_SCALE = 0.0022;

/** Latch for the surf mouse button. Read once a frame by `pollInput`. */
let surfHeld = false;

/**
 * The `Space` double-tap that toggles flight, in two constants.
 *
 * `TAP_MS` is how long a press may be held and still count as a *tap*, and it
 * is the half of this that matters. Space is also the surf key, so pairing two
 * presses on their down edges alone would launch the player any time they let
 * go of a carve and grabbed it again — which is a thing people do constantly.
 * Requiring the first press to have been short means a surf hold can never be
 * the first half of the gesture, however quickly it is followed.
 *
 * `GAP_MS` is measured from the first tap's *release*. 280 ms sits above a
 * deliberate double-tap (the second press lands 120-180 ms after the first
 * comes up) and below the cadence of two separate surf grabs.
 */
const TAP_MS = 250;
const GAP_MS = 280;

/**
 * How long a completed pair stays armed as the front half of a four-tap, ms.
 *
 * Measured against the gesture rather than guessed at: performing "tap tap tap
 * tap" at a natural cadence puts taps two and four about 300 ms apart, since
 * each pair takes ~150 ms and the hand pauses very slightly between them. 620
 * leaves room for that pause to be a deliberate one and still sits under the
 * time it takes to toggle flight, look at what happened, and toggle it back —
 * which is the only other way two pairs arrive in a row.
 *
 * Note this is measured between the two *pairs*, not from the first tap, so it
 * is not comparable to `GAP_MS`.
 */
const CHAIN_MS = 620;

/** When the live `Space` press went down, and when the last short tap came up. */
let spaceDownAt = -Infinity;
let lastTapUpAt = -Infinity;
/** When the last completed double-tap fired. Arms the second half of a four-tap. */
let lastPairAt = -Infinity;

const IS_MAC = /Mac|iPhone|iPad|iPod/.test(
    navigator.userAgentData?.platform || navigator.platform || navigator.userAgent
);

/**
 * Is this the snow-surf button?
 *
 * Right mouse, or ctrl-and-left on a Mac — where ctrl-click *is* right-click at
 * the OS level, so the browser reports button 0 with `ctrlKey` and a plain
 * `button === 2` test never fires.
 *
 * @param {MouseEvent} e
 */
function isSurfButton(e) {
    return e.button === 2 || (IS_MAC && e.button === 0 && e.ctrlKey);
}

/** @type {(() => void)|null} */
let onToggleOverlay = null;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ onToggleOverlay?: () => void }} [hooks]
 */
export function initInput(canvas, hooks) {
    onToggleOverlay = hooks?.onToggleOverlay ?? null;

    canvas.addEventListener("click", () => {
        if (!input.locked) canvas.requestPointerLock();
    });

    document.addEventListener("pointerlockchange", () => {
        input.locked = document.pointerLockElement === canvas;
        if (!input.locked) {
            // Drop held state so the character doesn't run off while unfocused —
            // and so a Comet charge does not sit held forever behind an alt-tab.
            for (const k in keys) keys[k] = false;
            surfHeld = false;
            input.surf = false;
            input.spellHeld2 = false;
            input.spellHeld6 = false;
        }
    });

    document.addEventListener("mousemove", (e) => {
        if (!input.locked) return;
        input.lookX += e.movementX * LOOK_SCALE;
        input.lookY += e.movementY * LOOK_SCALE;
    });

    // On window, in the capture phase. On the canvas alone it fires only when
    // the canvas is the target, which it is not while the pointer is locked.
    window.addEventListener("contextmenu", (e) => e.preventDefault(), true);

    // Capture phase, on window, and *not* gated on `input.locked`.
    //
    // Gating the press on pointer lock is the bug it looks like it is not: the
    // very first right-click of a session arrives before anything has locked,
    // so it was dropped, and any right-click that lands while the lock is being
    // re-acquired went the same way. `surfHeld` is a plain latch and `pollInput`
    // reads it, so a press can never be missed because of what the lock happened
    // to be doing on that frame.
    window.addEventListener("mousedown", (e) => {
        if (isSurfButton(e)) {
            surfHeld = true;
            e.preventDefault();
        }
    }, true);

    window.addEventListener("mouseup", (e) => {
        if (isSurfButton(e)) surfHeld = false;
    }, true);

    document.addEventListener(
        "wheel",
        (e) => {
            if (!input.locked) return;
            e.preventDefault();
            input.zoomDelta += e.deltaY * 0.0016;
        },
        { passive: false }
    );

    window.addEventListener("keydown", (e) => {
        // Overlay toggle works whether or not the pointer is locked.
        if (e.code === "F1" || e.code === "Backquote") {
            e.preventDefault();
            onToggleOverlay?.();
            return;
        }
        // Space is a surf key, so the browser must not also scroll the page or
        // re-fire whatever was last focused. Ahead of the repeat guard, because
        // an auto-repeating Space needs suppressing on every one of them.
        if (e.code === "Space") e.preventDefault();
        if (e.repeat) return;
        keys[e.code] = true;

        // Flight toggle. After the repeat guard, or holding Space to surf would
        // fire it on the second auto-repeat and launch the player mid-carve.
        if (e.code === "Space") {
            if (e.timeStamp - lastTapUpAt < GAP_MS) {
                // A pair has landed. If one landed moments ago, this is the back
                // half of a four-tap and it asks for the sky instead — and it
                // asks *instead*, not as well, so the controller is never handed
                // both edges on one frame and left to guess which wins.
                if (e.timeStamp - lastPairAt < CHAIN_MS) {
                    input.skyToggle = true;
                    // Consumed, so six taps are two gestures rather than three
                    // and a fifth stray tap cannot start a sky toggle of its own.
                    lastPairAt = -Infinity;
                } else {
                    input.flyToggle = true;
                    lastPairAt = e.timeStamp;
                }
                // Consume the whole gesture, closing press included: pushing its
                // down-time infinitely far into the past makes its own release
                // too long to count as a tap, so it cannot arm the next pair.
                // Four taps are then two toggles rather than three.
                lastTapUpAt = -Infinity;
                spaceDownAt = -Infinity;
            } else {
                spaceDownAt = e.timeStamp;
            }
        }

        const n = SPELL_KEYS[e.code];
        if (n) {
            input.spellPressed = n;
            if (n === 2) input.spellHeld2 = true;
            if (n === 6) input.spellHeld6 = true;
        }
    });

    window.addEventListener("keyup", (e) => {
        keys[e.code] = false;

        // A press only arms the double-tap if it was a tap. Anything longer was
        // someone surfing, and the next press after it is a surf, not a launch.
        if (e.code === "Space") {
            lastTapUpAt = e.timeStamp - spaceDownAt < TAP_MS ? e.timeStamp : -Infinity;
        }

        const n = SPELL_KEYS[e.code];
        if (n === 2) input.spellHeld2 = false;
        if (n === 6) input.spellHeld6 = false;
    });

    window.addEventListener("blur", () => {
        for (const k in keys) keys[k] = false;
        surfHeld = false;
        input.surf = false;
        input.spellHeld2 = false;
        input.spellHeld6 = false;
    });
}

const SPELL_KEYS = {
    Digit1: 1,
    Digit2: 2,
    Digit3: 3,
    Digit4: 4,
    Digit5: 5,
    Digit6: 6,
};

/** Resolve held keys into movement axes. Called once per frame before update. */
export function pollInput() {
    let x = 0;
    let z = 0;
    if (keys.KeyW || keys.ArrowUp) z += 1;
    if (keys.KeyS || keys.ArrowDown) z -= 1;
    if (keys.KeyD || keys.ArrowRight) x += 1;
    if (keys.KeyA || keys.ArrowLeft) x -= 1;

    // Clamp to a unit disc so diagonals aren't faster.
    const len = Math.sqrt(x * x + z * z);
    if (len > 1) {
        x /= len;
        z /= len;
    }
    input.moveX = x;
    input.moveZ = z;
    input.moving = len > 0.001;
    input.sprint = !!(keys.ShiftLeft || keys.ShiftRight);
    // Polled rather than edge-driven, and either input will do it. A latch read
    // once a frame cannot end up stuck on because a `mouseup` was delivered to a
    // window that had already lost focus.
    input.surf = surfHeld || !!keys.Space;
}

/** Clear per-frame accumulators. Called at the very end of the frame. */
export function endFrame() {
    input.lookX = 0;
    input.lookY = 0;
    input.zoomDelta = 0;
    input.spellPressed = 0;
    input.flyToggle = false;
    input.skyToggle = false;
}

export function isDown(code) {
    return !!keys[code];
}
