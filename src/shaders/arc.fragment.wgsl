// -----------------------------------------------------------------------------
// Lightning arcs — shading.
//
// This and the ember branch of `spray.fragment.wgsl` are the only two things in
// the demo that emit rather than reflect: no sun term, no shadow, no ambient,
// no spell light. A bolt is a source, and everything it looks like comes out of
// its distance across the ribbon.
//
// The channel that does the work is the **core**, not the glow. An arc drawn as
// a soft gaussian is a glowstick; what makes it read as an electrical discharge
// is a hard, nearly-white centre one or two pixels across with a wide dim halo
// around it, and the ratio between those two being extreme. So the core is a
// narrow smoothstep taken to a high power and the halo is a separate, much
// broader term at a twentieth of the amplitude.
//
// Colour is deliberately not a temperature ramp. The core runs slightly *blue*
// of white rather than toward yellow, because the eye reads blue-white as
// hotter than white in this context, and the halo is a saturated electric blue
// that the bloom then smears into the air around it.
//
// Additive in effect though the material blends normally, on the same reasoning
// as the magic circle: the colour is HDR and the alpha is low, so crossing bolts
// accumulate toward light rather than compositing over one another.
// -----------------------------------------------------------------------------

#include<snowNoise>
#include<snowAtmosphere>

varying vSide: f32;
varying vAlong: f32;
varying vArc: vec4f;
varying vSeed: f32;
varying vWorld: vec3f;

var skyLUT: texture_2d<f32>;
var skyLUTSampler: sampler;

uniform cameraPos: vec3f;
uniform sunDir: vec3f;
uniform sunRadiance: vec3f;
uniform arcTime: f32;

uniform fogDensity: f32;
uniform fogHeightFalloff: f32;
uniform fogStart: f32;
uniform aerialStrength: f32;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let v = abs(input.vSide);
    if (v > 1.0) { discard; }

    let intensity = input.vArc.x;
    let alphaIn = input.vArc.y;
    let mixWarm = input.vArc.z;
    if (alphaIn < 0.002) { discard; }

    // Brightness crawling along the bolt. A discharge is not uniformly lit down
    // its length — it beads, and the beads move. Two scales, because one reads
    // as a repeating pattern the moment the bolt is longer than a few metres.
    let u = input.vAlong;
    let crawl =
        0.72
        + 0.40 * noise2(vec2f(u * 9.0 + input.vSeed * 31.0, uniforms.arcTime * 6.0))
        + 0.22 * noise2(vec2f(u * 23.0 - input.vSeed * 11.0, uniforms.arcTime * 11.0));

    // The core: narrow and hard. The exponent is what stops it being a soft
    // stripe — at 1.0 the bolt is a smear, and the fall from there to a
    // one-pixel filament is almost all in the first two powers.
    let core = pow(clamp(1.0 - smoothstep(0.0, 0.30, v), 0.0, 1.0), 2.2);
    // The halo, an order of magnitude dimmer and several times wider. This is
    // what the bloom picks up and turns into the air glowing around the bolt.
    let halo = pow(clamp(1.0 - v, 0.0, 1.0), 2.6);

    // Ends taper to nothing so a bolt does not stop on a square end.
    let ends = smoothstep(0.0, 0.06, u) * (1.0 - smoothstep(0.88, 1.0, u));

    let hot = vec3f(7.6, 8.6, 11.4);
    let edge = vec3f(0.30, 0.72, 2.60);
    // The blast's arcs sit inside a fireball, where a pure blue reads as a
    // separate effect laid over the flame rather than as part of it. Warming
    // the halo toward violet is enough to seat them without losing the
    // blue-white core that says "electrical".
    let edgeWarm = vec3f(1.35, 0.42, 2.30);
    let halogen = mix(edge, edgeWarm, mixWarm);

    var color = (hot * core * 2.4 + halogen * halo * 0.45) * intensity * crawl * ends;

    // Low alpha against an HDR colour — see the header.
    let alpha = clamp((core * 0.85 + halo * 0.22) * ends * crawl, 0.0, 1.0) * alphaIn;
    if (alpha < 0.003) { discard; }

    let V = normalize(input.vWorld - uniforms.cameraPos);
    color = applyAerial(
        color, uniforms.cameraPos, input.vWorld, V, uniforms.sunDir,
        skyLUT, skyLUTSampler, uniforms.sunRadiance,
        uniforms.fogDensity, uniforms.fogHeightFalloff, uniforms.fogStart,
        uniforms.aerialStrength
    );

    fragmentOutputs.color = vec4f(color, alpha);
}
