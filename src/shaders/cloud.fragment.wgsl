// -----------------------------------------------------------------------------
// The cloud deck.
//
// A cloud is not a fogged sprite either, and it fails in a different way from
// the spray: spray is a thin scattering of crystals and a cloud is an optically
// thick volume, so the thing that makes it read is not the surface response but
// what happens to light *inside* it.
//
//   beer-powder      Transmission through the puff falls off exponentially with
//                    optical depth (Beer), but the *scattered* return rises with
//                    it before it saturates (the "powder" term). Their product
//                    peaks a little inside the silhouette rather than at the
//                    core, which is why real cumulus has bright shoulders and a
//                    duller middle. Without it a lit puff is a flat bright disc
//                    and the deck reads as cotton wool.
//   ground bounce    This deck stands over a snowfield with an 0.85 albedo. Most
//                    of what lights the underside comes back up off the snow,
//                    and leaving it out is what makes cloud bases over snow look
//                    like cloud bases over water — far too dark, and blue.
//   its own haze     The field's aerial perspective cannot be used up here and
//                    must not be. Its haze has a 22 m scale height, so at 430 m
//                    there is about 4e-9 of it left and every puff in the pool
//                    would draw at full contrast as a hard cutout, right out to
//                    the far edge of the window. What this uses instead is a
//                    plain distance extinction converging on the same sky lookup
//                    the ground's does, so the deck dissolves into the horizon at
//                    the same colour the sky there already is.
//
// Deliberately no shadow lookup and no spell lights. The cascades reach 330 m
// and end four hundred metres below this, and a spell has never been cast up
// here — both would be per-fragment cost against geometry that is already the
// heaviest fill in the frame.
// -----------------------------------------------------------------------------

#include<snowNoise>
#include<snowShading>
#include<snowAtmosphere>

varying vWorld: vec3f;
varying vCorner: vec2f;
varying vState: vec4f;
varying vViewDist: f32;

var skyLUT: texture_2d<f32>;
var skyLUTSampler: sampler;

uniform cameraPos: vec3f;
uniform camRight: vec3f;
uniform camUp: vec3f;
uniform sunDir: vec3f;
uniform sunRadiance: vec3f;
uniform shR: array<vec4f, 9>;
uniform ambientIntensity: f32;
/// Radiance leaving the snow field, solved by `Sky`. Lights the deck's underside.
uniform groundBounce: vec3f;

/// Optical depth at the core of a puff. Sets where beer-powder peaks; below
/// about 3 the product never saturates and the puff has no dense middle to have
/// bright shoulders against.
const EXTINCT: f32 = 5.2;

/// Visibility scale for the deck's own extinction, 1/m.
///
/// Matched to the pool: the window is 1800 m in radius and this puts its far
/// edge at 85% hazed, which is where a cloud sea stops being individual clouds
/// and becomes the horizon. It has to converge *before* the rim, or the rim is
/// what the eye sees instead.
///
/// Applied through the *square* of the distance rather than the distance, which
/// is not Beer and is not pretending to be. There is no medium here to be an
/// optical depth of — the field's real aerial perspective has a 22 m scale
/// height and four hundred metres up there is 4e-9 of it left, so this is a
/// convergence device and its only job is to have finished by the rim. A linear
/// exponent that finishes by 1800 m is already halfway through by 700, which
/// with the towers is the difference between a landmark you steer at and a grey
/// smudge. Squared, the same rim value leaves 700 m at a quarter hazed and 300 m
/// almost untouched, and the near field keeps the contrast that says which of
/// two overlapping towers is in front.
const HAZE_K: f32 = 0.000765;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let r2 = dot(input.vCorner, input.vCorner);
    if (r2 > 1.0) { discard; }

    let state = input.vState;
    let seed = state.x;
    let topness = state.y;

    // ---- silhouette ---------------------------------------------------------
    // Two octaves in the puff's own frame, pushing the edge in and out. A cloud
    // billboard is given away by its outline long before it is given away by its
    // shading, and the outline is the cheapest part to fix: at this amplitude the
    // effective radius wanders about a sixth either way, which is enough that
    // four overlapping puffs stop reading as four circles.
    let np = input.vCorner * 2.4 + vec2f(seed * 61.7, seed * 37.3);
    let wob = noise2(np) * 0.62 + noise2(np * 2.31) * 0.28;
    let shape = clamp(1.0 - r2 + wob * 0.52, 0.0, 1.0);
    if (shape < 0.004) { discard; }

    let alpha = state.z * shape;
    if (alpha < 0.004) { discard; }

    // ---- scattering ---------------------------------------------------------
    let world = input.vWorld;
    let V = normalize(uniforms.cameraPos - world);
    let L = uniforms.sunDir;

    // Spherical normal from the billboard's own coordinates, as the spray does —
    // a puff with a lit side and a dark side rather than a flat disc.
    let nz = sqrt(max(0.0, 1.0 - r2));
    let N = normalize(
        uniforms.camRight * input.vCorner.x + uniforms.camUp * input.vCorner.y + V * nz
    );

    let od = shape * shape * EXTINCT;
    let beer = exp(-od);
    let powder = 1.0 - exp(-od * 2.0);

    // Two lobes. The forward one is the silver lining — looking toward the sun
    // through the edge of a cloud is the brightest thing in any sky that has one
    // — and the weak backward lobe is what keeps the shaded side from going flat,
    // since a cloud scatters a good deal of light straight back the way it came.
    //
    // `mu` is 1 looking straight into the sun.
    let mu = dot(-V, L);
    let phase = phaseMie(mu, 0.70) * 0.72 + phaseMie(mu, -0.28) * 0.28;

    let albedo = vec3f(0.96, 0.97, 1.0);
    // The coefficient is small and has to be, for exactly the reason the spray's
    // is — a phase function is normalised over the sphere, so using it as a bare
    // multiplier on radiance overstates the peak by better than an order of
    // magnitude. At 2.6 the forward lobe came out at twice the radiance of
    // sunlit snow *before* any of the diffuse terms below were added, and the
    // lining clipped to a flat white hole with no edge in it.
    //
    // At 0.55, with beer-powder's own 0.385 peak in front of it, the lining
    // peaks near three times the same cloud's diffuse response, is down to two
    // thirds of it twenty-five degrees off the sun and a fifth by forty-five.
    // That falloff is the whole point: it makes this a *rim* on the sunward
    // edge rather than an overall brightening, and three times is what the tone
    // curve's shoulder was chosen to be able to hold.
    var col = uniforms.sunRadiance * albedo * phase * beer * powder * 0.55;

    // Direct term as well as the scattered one, so the sunward faces of the
    // towers pick up form. Wrapped hard: a cloud has no sharp terminator.
    const INV_PI: f32 = 0.31830988618;
    col += albedo * INV_PI * uniforms.sunRadiance * wrapDiffuse(dot(N, L), 0.85)
         * mix(0.35, 1.0, topness);

    // Sky fill.
    col += albedo * INV_PI * shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity
         * mix(0.45, 1.0, topness);

    // Snow bounce, arriving from below. `groundBounce` is the radiance leaving
    // the field, so a downward-facing element receiving it across a hemisphere
    // gets pi times it as irradiance and pi divides straight back out of the
    // Lambertian response — the two cancel and this is just albedo times
    // radiance, which is why there is no INV_PI on this line and there should
    // not be one.
    col += albedo * uniforms.groundBounce * clamp(0.5 - N.y * 0.5, 0.0, 1.0)
         * mix(1.0, 0.45, topness);

    // ---- the deck's own distance haze ---------------------------------------
    // See the header for why the scene's `applyAerial` is not what runs here.
    // The inscatter is still the scene's, so a fully hazed puff and the sky pixel
    // beside it resolve to the same number, exactly as the terrain's far edge
    // does against the same lookup.
    let hz = input.vViewDist * HAZE_K;
    let ext = clamp(1.0 - exp(-hz * hz), 0.0, 1.0);
    let inscatter = aerialInscatterSky(
        skyLUT, skyLUTSampler, -V, L, uniforms.sunRadiance, ext
    );
    col = mix(col, inscatter, ext);

    fragmentOutputs.color = vec4f(col, alpha);
}
