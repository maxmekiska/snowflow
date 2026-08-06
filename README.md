# SNOWFLOW

A real-time snow rendering tech demo. WebGPU, Babylon.js, hand-written WGSL.
Everything you see is generated on the GPU at load time — there are no textures,
no meshes, no HDRIs and no animation data in this repository.

**▶ [snowflow-lilac.vercel.app](https://snowflow-lilac.vercel.app/)**

> Requires a WebGPU-capable desktop browser (Chrome/Edge 113+, Firefox 141+,
> Safari 26+) and a discrete or recent integrated GPU. There is no WebGL
> fallback by design — if `navigator.gpu` is missing the page says so and stops.

---

## Controls

| | |
|---|---|
| Click | capture the pointer |
| `W` `A` `S` `D` | move, relative to the camera |
| Mouse | look · **Wheel** zoom |
| `Shift` | sprint |
| **Right mouse** or **`Space`** (hold) | snow-surf — carve across the field and throw a wake |
| **`Space`** (double-tap) | fly — rise to a 20 m hover and hold it; double-tap again to land |
| **`Space`** (four taps) | the sky strike: charge, then go up as a bolt of lightning; four taps again to come down and land on one knee |
| `1` – `6` | the six spells (`2` and `6` are held — `6` charges while you hold it) |
| `F1` or `` ` `` | settings and performance overlay |

The overlay exposes every art parameter as a live slider — sun angle, wind
bearing, subsurface radius, deformation depth, tonemap curve, exposure — plus a
frame-time graph with median / 95th / 1% low, draw calls, triangles and a
per-system CPU breakdown. Every system can be toggled off individually, and
there are debug views for normals, depth, cascade coverage, the deformation
buffer and the raw shadow map.

---

## What it does

### Terrain

A nested-ring geometry clipmap: 8 rings, 8.5 cm inner spacing, ~870 m radius,
333k triangles — **one static mesh, one draw call**. Vertices carry only
`(gridIndex, ringLevel)`; world placement, CDLOD morphing and displacement all
happen in the vertex shader, so there is no CPU rebuild and no per-frame upload.

The heightfield underneath it is layered gradient noise with analytic
derivatives, anisotropic about a single prevailing wind: broad transverse dune
ridges, a long low swell, medium drifts sheared along the wind for lee-face
asymmetry, and sparse rock outcrops. It bakes once into a 4096² RG32F texture
and is mirrored back to the CPU, so character grounding samples exactly the
surface that is drawn rather than a re-implementation of it.

### Snow shading

Multi-scale normals — baked macro slope, analytic sastrugi and ripples, three
tiled detail scales, triplanar on steep faces — over wrapped diffuse, a
back-scatter subsurface term with depth-dependent blue tint, GGX specular, SH
ambient with a solved snow bounce, and procedural view-dependent glints gated on
grazing angle. Compression, wetness and ice are surface state channels the
material reads rather than separate materials.

Shadows are three hand-rolled cascades with world-space PCSS — blocker search,
penumbra estimate, rotated Poisson filter — texel-snapped in world space and
stabilised against a rotation-invariant bounding sphere. Babylon's own cascade
generator can't be used here: the terrain has no CPU geometry matching what is
drawn, so every caster registers the vertex program it is actually rendered
with.

### Deformation

A persistent, additive terrain state buffer: two 2048² RGBA16F targets covering
80 m (3.9 cm texels), ping-ponged by a single full-screen pass per frame that
scrolls, relaxes and splats in one dispatch. Addressing is toroidal — a texel's
UV is `fract(worldXZ / size)` — so the window follows the player without ever
copying the buffer, and newly exposed texels are detected and zeroed by the same
pass.

Channels are depression depth, displaced mass, compression and ice. That second
channel is what separates a trail with raised berms from a flat footprint decal.
Refill is anisotropic diffusion (loose berms slump three times faster than a
packed trench floor) plus berm-into-depression slump, wind-driven infill from
upwind, and slow exponential decay: **~71% of trail depth survives a minute**,
visibly spreading and softening as it goes.

The displacement is real geometry in the beauty pass *and* in all three shadow
cascades through one shared include, so trails self-shadow and berms break the
silhouette. Feet, the surf wake and all five spells write through one `brush()`
call into the same buffer.

### The character

Fully procedural — no rig file, no animation clips, no authored mesh. An 18-bone
skeleton whose bind pose is a table of numbers, geometry lofted from that table
at load (cowl, torso, arms, trousers, boots, belt), and locomotion solved from
the motion state rather than played back.

Feet plant. A distance-driven stance/swing machine writes a foot's world
position exactly once, on touchdown, and holds it absolutely fixed while
two-bone IK reaches for it — a planted foot cannot slide because nothing in the
code is able to move it. Gait phase advances with ground travelled, so stride
length and ground speed are the same number by construction.

The garments are Verlet cloth on four panels with distance, bending and
shape-memory constraints, nine body collision capsules, and a hem that rides the
snow surface. Folds live in the rest shape rather than in a normal map. The
36×12 solve renders as a 72×32 surface through Catmull-Rom reconstruction in the
vertex shader, so tessellation and simulation cost are fully decoupled. Shell
fur at the hood rim and cuffs is a partial torus emitted 22 times and
alpha-tested against a hashed strand field.

One small texture carries everything to the GPU: rows 0–3 are bone matrices,
rows 4+ are simulated cloth nodes. One upload per frame, no allocation.

### Snow-surf

The wake is a **swept mesh, not a particle effect**. Its spine is the path the
board has taken, resampled every 30 cm into a 96×3 data texture; the mesh itself
is a static lattice of `(column, row, side)` and every vertex is placed in the
vertex shader, so a 19-metre wake and a 2-metre one cost the same buffer and the
same 4.6 KB upload.

The cross-section is a breaking wave integrated from a turning tangent — the
tangent sweeps from just below horizontal at the base to 284° at the tip, so one
`curl` parameter runs continuously from a low heaped bank to a lip that hangs
back across its own face. Amplitude and curl resolve per side from the carve, so
the outside of a turn takes nearly all the snow. Peak wall is 2.4 m at a
full-speed carve and collapses 0.88 s after it is laid, which makes wake length
`life × speed` with no second constant. Normals are differenced out of the same
`wakePoint` the geometry uses, so they cannot disagree with it.

Two spray populations come off the same spine — a dense slow curtain hugging the
crest and ballistic grains flung clear — emitted at *fractional* positions along
it, plus screen-space speed streaks and camera shake on a loaded edge.

### Flight

Double-tap `Space` and the character lifts to a hover twenty metres up, holds it,
and flies. Double-tap again to land.

What it holds is **clearance above the snow, not an altitude** — the ground is
followed, so there is nothing to manage and nothing to fly into. The climb is an
eased approach under a 9 m/s rate cap, because an ease alone leaves the deck at
thirty-odd metres a second and reads as a launch rather than a lift. Ground
tracking blends from a snap on the deck to a glide in the air, so a dune crest
passing underneath is a slow swell instead of hover bob; the height itself is
then applied exactly rather than damped along with it, which is what lets a
descent actually arrive instead of asymptoting a few centimetres up.

The physics are the surf model with the ground taken out from under it — same
mouse steering, same momentum, same terminal speed. What changes is what air
cannot give you: no slope to gain speed on, so thrust is flat and on demand; no
edge to set, so grip is a third of the board's and a hard turn opens into a wide
drifting arc rather than a carve; and nothing to load an edge *against*, so it is
the one mode that never asks the rig for camera shake.

The pose is its own, and it is **speed** that decides it rather than altitude. In
a hover the figure is upright with its arms down and held a little away from the
body — a person keeping station on something under their hands. Open the throttle
and it rolls forward into a head-first dive: arms drawn in and swept back past
the hips, legs straight and together and trailing, the whole silhouette one shape
going one way. That is the same distinction the mode itself is built on, so the
pose reports what the player is doing instead of announcing which mode they are
in.

The detail that makes it work is the one that looks like a mistake: the chest
arches *back* against the pitch, and the head takes the rest of it out, so the
two of them land within a few degrees of level and the character is looking where
they are going. A figure whose chest carries the full pitch of its pelvis is a
plank rotated forward, and no amount of arm and leg work rescues it.

Everything that only means anything on the ground fades out on the same number
the climb runs on: footprints, the wake, the figure's own settle into the
surface, and the board pose itself — which vacates as the feet leave the snow
rather than fighting the flight pose for the body. Takeoff and landing are one
transition described in one place, rather than five systems each picking a
threshold and disagreeing about which metre of the descent counts as landed.

Past about six metres a second the character starts to drag air with them: a thin
sheath of it winding around the body and finer wisps shedding off the hands,
thickening with speed. It is the ordinary snow-spray pool with three numbers
changed — low drag, born carrying most of the body's own velocity, and born
slightly upstream so it passes the figure rather than trailing it — which is the
whole difference between air moving over something and debris falling off it. No
mesh, no shader, about a hundred grains in the air at cruise.

### The sky strike

Tap `Space` four times and the character does not climb. They **coil**: planted,
crouched, momentum scrubbed, filaments gathering on the body, snow lifting off the
ground *inward* rather than being blown outward, and the first arcs going down into
the snow. Then they go, four hundred and thirty-five metres in under a second as a
column of lightning, arriving at a ceiling twenty-five metres over the cloud
tops. Four taps again brings them back down the same way, feet first, into a
landing on one knee with a fist in the snow.

The altitude through the shot is **placed on a curve, not eased toward a target**,
and that is the one structural decision the rest follows from. A velocity plateau
with a ramp on and a ramp off, integrated analytically and normalised, so it leaves
at exactly zero and arrives at exactly one: 435 m to the millimetre, at 30 fps and
at 240 alike. An exponential ease would arrive approximately, at no particular
instant, and three metres short of a ceiling the cloud deck is drawn against is
three metres inside the cloud. Everything else keys off the rate that curve
produces: the camera lead, the shake, the pose, the airflow, the density of the
column.

None of it is a new pipeline. The column, the arcs wrapping the body, the tether
back to the ground and both ground bursts are struck into the same lightning field
the Comet uses, and the snow and sparks go into the same spray pool as everything
else, so the whole effect is an emitter with no mesh, no material and nothing in
the warm-up. The one thing it does not share is the anchoring: the Comet's bolts
travel with the hand that threw them, and these are fixed in the world, so the
channel hangs where it was struck while the character leaves the top of it at six
hundred metres a second. That is the effect rather than a bug in it.

The landing is the part that turned out to be geometry rather than art. A fist has
to reach the snow, which wants the hips low; a kneeling knee is thrown off the
hip-to-ankle line by an amount that grows as the leg folds, which wants them high.
The band that satisfies both is narrow, and the first attempt at it put the knee
nineteen centimetres underground. What buys the reach in the end is the torso
pitching over rather than the pelvis dropping further, plus the trailing leg going
a long way back, which keeps the chain extended and happens to be the silhouette
anyway.

### The cloud deck

The sky tier flies on weather rather than over it. Fifteen hundred soft billboards
sit on a **toroidal cell window** that follows the player, which is the
deformation buffer's trick moved into the air: 13x13 cells of 300 m, nine puffs
each, and a cell leaving one edge of the window reappears on the other with a new
integer index. Only those cells are rebuilt. Everything a cell holds is hashed
from that index, so a cloud is a fixed feature of the world. Fly out and back and
the same tower is where you left it, with nothing stored. The whole field then
translates by an accumulated wind offset applied after the hash, so the pattern
slides intact instead of being re-diced every metre.

Billboards rather than a raymarched slab, because this mode needs cloud with an
inside. Towers have to come up through the flight path and holes have to go all
the way down to the snow, and a slab cannot be flown through cheaply. Discs give
that for one pipeline, and they land where every other effect here lands: one
static mesh whose `position` attribute is an index, one data texture, nothing
allocated per frame.

A cell holds two things and they answer to different rules. Six puffs are the
**sheet**, four in the top surface and two hanging below it, and that is the deck
proper. Three more are a **tower**, and only about one cell in five builds one.
The sheet on its own is a floor, and since the ceiling is absolute there is no
climbing above it to find something else, so a cruise would be spent looking at
one surface. The towers are what put cloud at and above the flight path. They are
gated at two scales: a coarse noise on a 5.5 cell lattice picks out the clumps,
and a per-cell hash decides which cells inside a clump actually build. With only
the noise a clump is a solid two-kilometre ridge. With only the hash they scatter
evenly at 300 m and read as a texture on the deck rather than as features in it.
Together, a tower's four-neighbourhood holds another tower 48% of the time against
a 21% marginal, which is what makes them read as groups.

**Coverage near 94% is load-bearing, not cosmetic.** The clipmap stops at 870 m
and there is no fog worth the name at this altitude, since the field's haze has a
22 m scale height and four hundred metres up there is essentially none of it left.
What stops the world drawing as a disc floating in the sky is the deck being under
you when you look toward the horizon. It is also why the ceiling sits only 25 m
above the tops: at that clearance the sightline to the clipmap's rim crosses the
cloud plane about forty metres out, where the deck is effectively solid. At a
hundred metres of clearance it crosses out among the holes. The hole mask then
takes a tenth of the cells out deliberately, roughly one gap every 900 m, because
a deck with no way through it is a ceiling rather than weather.

Sorting is not optional. Alpha-blended discs two hundred metres across read as
stacked cards in any order but back to front, so the CPU sorts an index array
every frame and writes the texture rows in depth order instead of slot order. The
shader neither knows nor cares. Nothing else in the demo needs this, because
nothing else has both large soft quads and heavy overlap.

Two small facts decide more of the layout than they look like they should. **A
billboard is a sphere, so a deck built from them cannot be thinner than one
diameter**, and that alone sets the puff radius, which sets how many are needed
for coverage, which sets the pool size. And **absence is expressed as zero radius,
never as zero alpha**, because an invisible quad with area still costs its fill,
and this is a thousand of them at screen-filling size.

The deck carries its own distance extinction instead of using the field's aerial
perspective, converging on the same sky lookup the ground uses, so a fully hazed
puff and the sky pixel beside it are the same number. It is applied through the
square of the distance and is not pretending to be Beer's law. There is no medium
up here to be an optical depth of, and the only requirement is that it has
finished by the time it reaches the window's rim. A linear falloff converging at
1800 m is already halfway through at 700, which for a tower is the difference
between a landmark you steer at and a grey smudge.

Puffs fade out as the camera enters them, because a view-facing quad whose centre
is nearer than its radius clips against the near plane and draws a hard edge
sweeping across the frame. That leaves the geometry correct and the experience
missing, so the whiteout is paid back by the composite: the deck measures how deep
the camera is inside it and drives a linear-space veil in the tonemapper, using
the fragment shader's own density profile so that what the veil reports and what
the deck draws are the same falloff.

It is absent at ground level by choice. The sky here is a clean analytic gradient
with restrained cirrus tuned against a sun thirteen degrees up, and a permanent
overcast at 430 m would rewrite every frame of the ground game for a mode you
enter deliberately. The deck fades in on the *camera's* height rather than on the
flight mode, because it is a feature of the world and has to be there whether you
climbed to it or are falling past it.

### The cloud vortex

Punching through a tower tears vapour out of it. This is the sky tier's answer to
the surf wake, and it is built the way the flight airflow is rather than the way
the wake is: an emitter into the shared spray pool and nothing else, so no mesh,
no material, nothing in the warm-up. The wake needs a mesh because a breaking wall
of snow is an opaque surface with a lip you see the underside of. Torn vapour has
no surface at all, which makes it the one thing billboards are already right for.

**The spiral is laid, not simulated, and that is the whole trick.** Grains are not
given an orbital velocity and left to circle. They are placed on a helix whose
phase advances with distance travelled, so consecutive grains trace a corkscrew
that stands still in the world while the character flies out of the end of it. The
simulation then only has to leave them alone, which is why the drag here is high
and the airflow's is low. Simulated orbits fail twice over: a grain circling fast
enough to read on screen leaves its neighbours within a few frames and the rope
becomes a swarm, and holding an orbit needs a low drag, which lets the launch
velocity carry every grain off along the flight path until the two cores merge
into one smear.

Two counter-rotating cores, one off each hand, at half a radian of phase per
grain, which is one turn every eleven metres. Two of them read as rotation where
one reads as a trail. They are born carrying six per cent of the body's velocity
against the airflow's fifty-five, and confusing those two numbers is the obvious
way to get this wrong: the airflow draws air being dragged along with the
character, and this draws cloud that was already there and is being left behind.

Two populations come off one density probe, and which derivative they key off is
the point. The cores key off the density itself, and they are what hangs in the
air behind. The tear keys off the *rate of change*, so it fires on entry rather
than throughout. Punching into a tower throws a burst of vapour off the body and
then stops; a hundred metres of solid cloud after that is the veil's job. Measured,
every tear grain lands on rising density against the cores' 46%. Keyed to the
derivative it is an event, which is the difference between an effect and a fog
setting.

At a hundred metres a second the body moves nearly two metres between emissions,
so each grain goes at a fraction along the segment travelled with its phase
interpolated to match. Without that the helix is laid as a string of clumps with a
visible beat at the frame rate.

### The six spells

One water material, one mesh, one draw, eight strands. Five of the six move a
coherent body of water and are structurally the same object: a swept surface
along a spine with a radius, a parallel-transported frame and a foam channel —
the same construction as the surf wake. A strand that is not in use is switched
off by zeroing its rows, so the draw count does not depend on how many spells
are up.

1. **Sweep** — a crescent of slush rises out of the ground and runs outward,
   ploughing a channel and throwing berms.
2. **Ribbon** — a held stream tracking the hand and camera aim, drawing
   precessing figure-eights and scoring thin curved lines into any snow it
   skims. Released, the head steers onto the aim and accelerates, so the water
   arcs onto the target with the bend it had at release still travelling out
   along the tail.
3. **Bloom** — a targeted eruption: a crater with a raised rim, a waisted column
   that rises and withdraws down its own axis, and four seconds of fallout
   curtain lit from below.
4. **Crystallise** — hexagonal prisms grown along a golden-angle spiral,
   alpha-blended *and* depth-writing, so you see the snow through the ice but
   never one prism through another. Facet normals come from screen-space
   derivatives, so every facet is exactly flat and every edge exactly hard.
5. **Vortex** — three helices of lifted snow winding around the player, with the
   airborne mass emitted along those same helices at their own tangential
   velocity. The only system here that writes a *negative* depression.
6. **Comet** — the long shot, held while it charges, and the only spell aimed
   past the middle distance.

   Hold `6` and a sigil inscribes itself in front of the caster — outer ring,
   tick fence, rune band, then a pair of counter-rotated hexagons — and only once
   it is written does a ball of lightning begin gathering in the middle of it.
   Every mark on the sigil is analytic: concentric distance fields in polar
   coordinates, gated on different slices of the build, with a bright head
   running ahead of the angular sweep. Nothing cross-fades, so the sigil looks
   like the thing that is *doing* the gathering rather than a decal behind it.

   The ball reports the charge back as discharge. It starts as a few filaments
   crawling its surface; then bolts begin radiating outward in every direction,
   reaching further as it builds; and past halfway it starts striking the snow
   underneath, each strike glazing a patch of it to ice through the terrain state
   buffer. The light it casts strobes with them, because a steady light under a
   flickering ball reads as two effects in the same place rather than one.
   Meanwhile the snow for eight metres around is driven off the ground and thrown
   outward, with a ring of scour written under it, so the snow that left is
   visibly gone from where it left.

   How long you hold decides how big the shot is — range, pillar, blast and
   shake all scale with it — so the wind-up is a decision rather than a delay. A
   tap still throws something, at a floor of about a fifth power.

   Let go and the ball draws out into a lance and leaves at 215 m/s, shedding a
   wake of discharge as it goes, watched the whole way out: typically a third of
   a kilometre, which is over a second and a half of held frame. What happens
   where it lands is one of two things, switchable in the overlay.

   The **dome** does not go off on impact — it goes *in*. Snow is torn off the
   ground and thrown at the impact point, lightning is struck from a closing
   shell toward the middle, and a ring on the surface tightens onto it. Then
   everything stops, and for an eighth of a second the frame is almost empty.
   Then the flash, and a hemisphere a hundred and eighty metres across standing
   over the crater. Every other explosion here and nearly everywhere else is a
   sphere going outward; one that collapses first is doing something the eye has
   no template for, and the held beat is what makes the flash land — a flash is a
   ratio, so any light left burning through the pause halves it.

   The dome does not then get *replaced* by the shock wave. It **becomes** it.
   Both are drawn at the same radius off one curve, so the shell's equator and
   the wall's centre line are the same circle at every instant, and the
   conversion is nothing but the dome thinning from the top down while a
   twenty-metre wall thickens underneath it and rolls on to three hundred metres.
   There is no cross-fade, because there are never two radii.

   The thinning is geometric rather than a fade. The shell's rim descends from
   the pole toward the equator over about a second, so what gives way is the top
   of it: the sweep starts lower every frame and leaves an opening you look
   straight through, to the inside of the far wall. The opacity barely moves.
   Done the other way, as one number on the whole strand, it dissolves a surface
   of revolution uniformly and the shell reads as a light going out instead of a
   structure coming apart. It also lets the hemisphere stand for a second and a
   half instead of four fifths of one, which costs nothing, because the dome and
   the wall share a radius and were never competing for the same moment.

   Under it there is fire. Everything else in this detonation is blue-white, so a
   hot core beneath a cold shell is the only real colour contrast the effect has,
   and the shell is translucent enough to be seen through. The core is bounded
   against the front as it stands rather than against where the front is going,
   or it climbs out through the shell in the first tenth of a second while the
   blast is still small. The interior light crosses from orange to blue as the
   fire burns out, because a cold interior over an orange fireball is two lights
   disagreeing about the same volume.

   All of it is also, as it turns out, what a blast physically does: the top of an overpressure shell
   spends itself into air that is not there to push against, and what is left
   running along the ground is the surge.

   The wall's radius is not a value tracking the shock wave. It **is** the shock
   wave — the same number that decides when the blast reaches you — so the thing
   you watch crossing the field is exactly the thing that hits you.

   The **disc** is the same wind-up ending in a flat planar front instead, and
   the **pillar** is the original. Where the pillar lands,
   a 90-metre pillar goes up — a stem and a cap that climbs and spreads as it
   rises — with a fireball rolling at the root of it, dozens of bolts climbing
   the column out of the crater, and a base surge of powder running 300 metres
   outward along the ground as a wall twenty metres tall. Then, most of a second
   later, the ground shock arrives at the caster.

   That wall is the one number here that had to be tuned against *apparent* size
   rather than real size. Doubling the surge's radius alone made it look
   shorter, not bigger: it now stands twice as far away, so an unchanged wall
   subtends half the angle and reads as a thinning line on the horizon. Holding
   its height in the frame meant scaling it with the distance it is seen from.

   That delay is the point of the whole spell. The shock front is never drawn —
   it is a scalar radius expanding at 330 m/s, purely a clock — and it spends
   itself all at once when it passes the player, as camera trauma, a ring of snow
   blown off the ground and a gust of powder driven downrange. A blast you feel
   as you see it went off where you are standing; a blast you see, wait for, and
   then feel went off somewhere else, and the wait is the only thing in frame
   that can say how far away somewhere else was.

   The fire is deliberately not a new system: it is the ordinary spray pool with
   a third particle kind, shaded down a separate branch of the same fragment
   shader — same billboard, same sort, same pipeline. The cold end of its ramp is
   soot rather than dim red, because what a fireball leaves behind is smoke, and
   against snow that dark tail is most of what sells the bright end.

   The lightning is the one thing here that *did* need its own system, and the
   reason is a good example of a constraint choosing the design: the water strand
   pool is exactly full, so there was nothing to draw a bolt on. A bolt turns out
   to want a flat ribbon facing the camera rather than a swept tube, and twenty
   of itself alive at once rather than one — around sixty through a full charge
   and seventy at the detonation, from a pool of 128. Each is generated once and
   then held for its tenth of a second: re-randomising the path every frame is
   the obvious way to get flicker and it dissolves the bolt into a shapeless
   shimmer, because real flicker is bolts appearing and dying rather than one
   bolt writhing. The same system covers a scale range of two orders of
   magnitude, from centimetre filaments around the ball to metre-wide bolts tens
   of metres long climbing the pillar, which is what it takes to still register
   at 250 metres.

   Both of the demo's heavy systems stop short of where this goes off — the
   deformation buffer is 80 m across and a quarter kilometre of ground-level haze
   leaves about a fifth of anything standing in it. One property answers both:
   the fog has a height falloff, so the pillar is *tall*, and 90 m up reads at
   better than twice the contrast of the crater beneath it. The only marks the
   spell writes into the snow are the three it makes within arm's reach of the
   caster. It also uses its two strands three times over — the ball becomes the
   lance becomes the pillar — because with six spells able to be up at once the
   pool of eight is exactly full, and a release-then-reacquire between those
   could come back empty.

Refraction needs no scene copy and no second opaque pass: the sky LUT already
stores the solved snow bounce below the horizon, so one lookup along the
refracted ray is a physically-derived estimate of what is behind the water in
any direction. Three lookups at three indices of refraction give the chromatic
dispersion, and absorption over the path length gives the tint.

Four pooled dynamic lights are declared per frame, and every one of them runs
the identical `snowSubsurface` the sun runs — so a spell lights the snow
*through* a berm crest rather than putting a bright patch on the near face of
it. The snow, the robe, the wake, the airborne spray, the water and the ice all
read the same pool out of one include.

### Sky and atmosphere

A Nishita single-scattering integration with a multiple-scattering
approximation and an iteratively-solved snow bounce, baked into an
equirectangular LUT plus SH irradiance and mip-based specular. Analytic rather
than a captured HDRI because the whole look hangs on a sun 10–15° up: with a
model, the elevation slider correctly drags the horizon warmth, the zenith
gradient, the ambient tint and the direct sun colour along with it.

The far range is a heightfield raymarched on the skybox — no geometry, behind
everything by construction, with analytic normals, ridges occluding ridges, and
a second short march toward the sun for its own cast shadows. It is lit by the
snow field's own material logic and hazed by the same single atmosphere, so the
two meet at one colour instead of two.

### Post-processing

A camera-space depth prepass (linear view depth carried as a varying, plus a
specular mask) feeds the whole chain:

- **TAA** — Halton(2,3) jitter written straight into the projection and frozen
  for the frame, so the prepass and the beauty pass agree to the subpixel.
  Depth-based reprojection, variance clipping, and a five-tap Catmull-Rom
  history fetch.
- **Bloom** — three levels, thresholded in *exposed* units so only the sun disc,
  the glints and lit spray reach it. Karis-averaged on the prefilter.
- **Volumetric light shafts** — integrating sky visibility out of the prepass
  along the ray to the sun. They fade themselves out entirely at a high sun.
- **Depth of field** — deliberately slight, focal plane tracking the spring
  arm's own length, weighted by each tap's own circle of confusion.
- **Screen-space reflections** — on ice only, gated on the prepass mask, so the
  pass is a fetch and a branch on any frame where nobody has cast Crystallise.
- **AgX / ACES tonemapping**, contrast-adaptive sharpen, grain, vignette.

---

## Performance

Measured with WebGPU timestamp queries at 2560×1440 on Chrome / Windows 11 /
RTX 5070 Ti, with every system running:

| | |
|---|---|
| GPU frame | **3.22 ms** |
| — base scene (clipmap, snow, 3 cascades, sky, character, deformation, prepass) | 1.64 ms |
| — post chain | ~1.1 ms |
| — far range | ~1.2 ms |
| — character (skeleton, cloth, fur, spray) | < 0.02 ms |
| Draw calls | 18–22 |
| Triangles | ~362,000 |
| Headroom against a 90 FPS budget | **7.9 ms** |

The frame times were taken on the ground before the sky tier existed and have not
been re-measured; the draw call and triangle figures have. The cloud deck, the
lightning field and the casting sigil account for the three extra draws and about
nine thousand extra triangles between them, all alpha-blended, and the deck draws
nothing at all below 80 m of camera height.

Nothing allocates in the render loop. Every buffer is sized at construction,
every per-frame write goes into a pre-allocated typed array, and every material,
procedural texture and render pipeline is explicitly `isReady()`-gated and
exercised with real geometry behind the loading screen — so the first cast of a
spell does not compile a pipeline mid-frame.

VRAM is roughly 350 MB: a 4096² height texture, two 2048² deformation targets,
three 2048² shadow cascades, and the sky and detail LUTs.

---

## Running locally

```bash
npm install
npm run dev      # vite dev server on :5173
npm run build    # production build into dist/
npm run preview  # serve the production build
```

## Layout

```
src/
  main.js            entry point and frame orchestration
  core/              settings, input, camera rig, perf, loading, GPU helpers
  terrain/           heightfield, clipmap mesh, deformation state buffer
  render/            sky + IBL, shadow cascades, depth prepass
  character/         skeleton, procedural geometry, locomotion, cloth, contact
  vfx/               pooled particles, surf wake, flight airflow, cloud deck,
                     cloud vortex, the lightning launch
  spells/            the six spells, the shared water body, the lightning field,
                     the casting sigil, the light pool
  post/              the post-processing chain
  ui/                settings and performance overlay
  shaders/           all WGSL — lib/ holds the shared includes
```

## Assets and licences

There are no third-party assets. Every texture, environment map and piece of
geometry in the running demo is generated at load time on the GPU: the sky is an
atmosphere integral, the snow grain and terrain are noise, the character is
lofted from a table of numbers, and the fabric weave, the fur strands and every
rune on the casting sigil are evaluated in the fragment shader.

Runtime dependencies are `@babylonjs/core` and `@babylonjs/materials`
(Apache-2.0). The only build dependency is Vite (MIT), which does not ship in
the output.

This project is released under the [MIT licence](LICENSE).
