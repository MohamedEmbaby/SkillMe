# SkillMe GUI atlas: image prompts

Generate each sheet separately: paste the **style block** first, then **one sheet**. Asking for every graphic in a single image doesn't work: past about 16 items, generators lose the grid and the style drifts.

**Claude's look comes from the Claude Code icon.** For sheets 1 and 2, attach the Claude Code icon as a reference image if your tool accepts one. It isn't included in this repo; save a copy of the official icon yourself, for example in `assets/reference/`, which git ignores. The prompts also describe its shape in words, so it works without the attachment. They describe it by shape rather than by name, because image tools tend to refuse or distort named brand logos.

**What to send back**
- Save each sheet as a full-size PNG, named as in its heading (`sheet1-characters.png` …).
- Put them in `assets/atlas/` in your copy of SkillMe.
- If a few items in a sheet come out wrong, regenerate just that sheet.

`npm run atlas` (`scripts/build-atlas.js`) cuts the sheets into `assets/sprites/`. The frames become stretchable 9-slice borders, and the poses become the animations. It looks for these file names (change them at the top of the script if yours differ): `Chibi Knight and Monster Sprite Sheet.png` (sheet 1), `Glossy Game Achievement Badge Grid.png` (2), `Glossy Cartoon Game Icon Grid.png` (3), `Fantasy Game Icon Grid.png` (4), `Colourful Cartoon Game Effects Sticker Sheet.png` (5), `Cartoon RPG UI Frames and Buttons.png` (6), `Cartoon RPG UI Icon Grid.png` (7), `Day and Night Fantasy Battlefields.png` (8).

---

## Style block (paste at the top of every sheet prompt)

```
STYLE, identical for every sheet in this set:
- 2D fantasy RPG game art in the style of a polished modern indie JRPG interface. Cel-shaded with soft gradients, crisp clean edges, one consistent 3px dark outline (#1A1424) around every asset, light from the top-left, small white highlights.
- Palette: UI in deep navy to royal blue (#0F1A55 to #2846A8) with silver-white trim (#E8ECF6) and gold accents (#F2C14E, #B8862C). Player colour blue #46B3FF, opponent colour orange #FF8A4C, success green #5FD35F, danger red #FF6262.
- Every asset must still read clearly when shrunk to 32x32 pixels: bold silhouettes, few small details, strong contrast.
- NO text, letters, numbers, labels, logos, watermarks or signatures anywhere in the image.
- Background: one flat, solid magenta colour #FF00FF everywhere outside the assets. No gradient, texture, vignette or cast shadow on the background. (If the tool can output a transparent PNG, use full transparency instead.)
- Layout: a 1024x1024 image divided into an invisible 4x4 grid of 256x256 cells. Do NOT draw the grid. Exactly one asset per cell, centered, completely inside its cell with at least 24px of empty background on every side; nothing touches or crosses a cell edge. Keep the exact order listed: left to right, top to bottom (cells 1-4 are the first row).
```

Optional, for pixel art instead (it suits the blocky Claude mascot naturally): replace the first bullet with
`- 16-bit pixel art like a SNES-era JRPG: a clean, consistent pixel grid, each asset drawn at 64x64 pixels and scaled up 4x with nearest-neighbour, no anti-aliasing, no blur.`

---

## sheet1-characters.png: the two fighters (8 poses each)

```
SHEET 1: CHARACTERS. Two characters, 8 poses each. Same scale in every cell of the same character, and every pose stands on the same baseline 24px above the bottom of its cell.

HERO (cells 1-8): a small chibi knight with a big head. Silver helmet with a T-shaped visor and a red plume, glowing cyan eyes behind the visor, blue tunic with gold trim, brown belt and boots, a short silver sword in the right hand. Always faces RIGHT.
1 idle stance, relaxed.
2 the same idle pose with eyes closed (blink).
3 attack: lunging forward, slashing the sword in a wide arc.
4 hurt: knocked back and flinching, eyes as X marks.
5 victory: jumping, sword raised high.
6 happy cheer: free fist up, eyes as happy arcs.
7 guard: arm raised to block, determined eyes.
8 level up: standing tall inside a soft golden glow.

OPPONENT (cells 9-16): match the attached reference image. It is a small blocky creature built only from square blocks, like an 8-bit arcade sprite, in terracotta orange #D97757, seen from the front:
- a wide rectangular body, about one and a half times as wide as it is tall, with hard square corners;
- two small, tall rectangular eyes near the top of the body, each about a quarter of the way in from its side (in the reference they are cut-out holes; draw them as near-black #1A1424);
- one short, thick rectangular arm sticking straight out from each side, level with the lower middle of the body;
- four short, thin rectangular legs under the body: two close together on the left, two on the right, with a wide gap in the middle;
- no mouth, nose, ears, hair or other features in its normal pose.
Keep exactly this blocky, square silhouette and colour in every pose, lightly cel-shaded (a lighter top edge, a darker bottom edge) with the same outline as everything else. It is about twice as wide as the hero and front-facing. Show feelings through the eyes, the arms and legs, colour, and small effects; a small square mouth appears only where a pose asks for one.
9 idle: standing still on its four legs, normal eyes.
10 blink: the same pose, each eye a short flat horizontal line.
11 angry: body tinted red (#E5483A), eyes slanted inward into a V like furrowed brows, arms pressed down, a small steam puff above it.
12 dancing pose A: leaning to its left on two legs, both arms raised high, eyes as happy upside-down U arcs, a small open square mouth.
13 dancing pose B: the mirror of pose A, leaning to its right.
14 shocked: hopping backwards with all four legs off the ground, eyes bigger (white squares with dark pupils), a small square O mouth.
15 sad: slumped lower with bent legs, arms hanging down, small low eyes, a light-blue tear drop.
16 hit: tilted back, eyes squeezed into two short lines, a white flash across the body.
```

## sheet2-badges.png: badge medals

```
SHEET 2: BADGES. Round medals, all the same size (about 200px across): a thick polished gold rim, a small ribbon tail at the bottom, a coloured enamel centre with one bold symbol.
1 crimson centre, a single shiny red drop.
2 dark orange centre, a big flame.
3 indigo centre, a yellow lightning bolt.
4 purple centre, a red-and-white bullseye with an arrow in the middle.
5 dark green centre, a beetle under a magnifying glass.
6 blue centre, a white arrow climbing steps toward a small checkered flag.
7 violet centre, an open, glowing spellbook.
8 teal centre, a rocket with a flame trail.
9 slate centre, a red triangle, blue square, green circle and yellow diamond grouped together.
10 deep blue centre, a faceted, sparkling diamond.
11 locked medal: the same medal shape in dull grey stone, with a padlock.
12 level-up emblem: a gold star with small wings.
13 app emblem: a blue-and-gold shield crest with a silver sword on the left and the small blocky orange creature from the reference image on the right (wide square body, two tall eyes, side arms, four little legs), facing each other.
14 a gold trophy cup.
15 a small glowing purple crystal (experience points).
16 a small flame with a blue core (streak).
```

## sheet3-icons-a.png: button icons

```
SHEET 3: ICONS A. Inventory-style item icons, chunky and centered, each about 180px.
1 a golden bell.
2 a brass speaker horn with sound waves.
3 the same speaker horn crossed out by a red X (muted).
4 a crescent moon.
5 a bright sun.
6 a green circular restart arrow.
7 a silver gear.
8 a red push-pin.
9 a small treasure chest with a gold lock.
10 a purple wizard hat with a gold star.
11 a flame.
12 a red-and-white archery target.
13 a gold star.
14 the same star as an empty grey outline.
15 a green check mark.
16 a red X mark.
```

## sheet4-icons-b.png: more icons

```
SHEET 4: ICONS B. Inventory-style item icons, chunky and centered, each about 180px.
1 a winged boot.
2 an hourglass with gold sand.
3 a red banner flag on a pole.
4 two crossed swords.
5 a blue heater shield with a gold emblem.
6 a gold crown.
7 a war hammer.
8 a closed leather spellbook.
9 a glowing crystal ball on a small wooden stand.
10 a white feather quill.
11 a rolled parchment scroll.
12 a yellow warning triangle with a bold dark exclamation-mark shape.
13 a gold key.
14 a silver sword.
15 a bone-white skull.
16 a white gauntlet hand pointing to the right (menu cursor).
```

## sheet5-effects.png: animation effects

```
SHEET 5: EFFECTS for battle animations, each about 160px, bright and simple.
1 a yellow eighth note.
2 a yellow double music note.
3 a white puff of steam.
4 a yellow four-pointed sparkle.
5 a red cartoon anger mark (the cross-shaped vein from anime).
6 a white speech bubble containing a red exclamation-mark shape.
7 a light-blue sweat drop.
8 a white-and-yellow impact burst (hit spark).
9 a white sword-slash arc.
10 a grey smoke puff.
11 a jagged vertical lightning strike.
12 a red splash of droplets.
13 a small cartoon green beetle, side view, walking right.
14 a small rocket flying right with a flame trail.
15 a white chevron pointing down.
16 a white arrow pointing right.
```

## sheet6-frames.png: stretchable UI frames (9-slice)

```
SHEET 6: UI FRAMES. Each frame is drawn flat and head-on as a square panel filling the central 224x224 of its cell (except 14-16). Every frame has a uniform border about 20px thick on all four sides, decorated corners, straight edges that can be stretched, and a plain, evenly filled centre with nothing inside. They will be stretched with 9-slice scaling.
1 main window: navy-to-royal-blue gradient fill, silver-white double border, dark outer outline.
2 main window, day theme: parchment-cream fill, dark brown wood border.
3 dialog box: darker navy fill, ornate gold corners.
4 name plate: a small dark-blue plate with a silver bevel.
5 primary button: a gold bevelled button.
6 the same gold button, pressed in and slightly darker.
7 secondary button: a brushed-steel bevelled button.
8 danger button: a red bevelled button.
9 square icon-button frame: blue with a silver rim.
10 list row: translucent dark blue with a thin silver border.
11 list row, highlighted: brighter blue with a glowing gold border.
12 list row, correct: green tint with a green border.
13 list row, wrong: red tint with a red border.
14 progress-bar trough: a wide horizontal dark trough with a silver frame, about 224x56.
15 progress-bar fill: blue glassy liquid with a shine stripe, about 224x40.
16 progress-bar fill: orange glassy liquid with a shine stripe, about 224x40.
```

## sheet7-parts.png: UI parts

```
SHEET 7: UI PARTS.
1 a wide, blank ribbon banner with folded tails.
2 a toggle switch, off: grey track, knob on the left.
3 a toggle switch, on: green track, knob on the right.
4 a text-input frame: a dark inset field with a thin silver rim (9-slice: uniform 16px border).
5 a small rounded tag/chip frame (9-slice: uniform 12px border).
6 a tooltip frame with a small pointer at the bottom.
7 a gold progress-bar fill with a shine stripe, about 224x40.
8 a wide ornamental divider line with a small gem in the middle.
9 a versus emblem: two crossed swords over a burst of sparks.
10 a modal-window frame with an ornate crest at the top centre (9-slice: uniform 24px border).
11 a gold filigree corner ornament (top-left corner).
12 golden sunburst light rays fading outward (for celebrations).
13 a soft golden glow ring.
14 a soft dark oval shadow (to sit under a character's feet).
15 a small round amber gem (notification dot).
16 a round red gem button with a white X shape (close).
```

## sheet8-backgrounds.png: battle backgrounds

This sheet is a full scene, not a grid: ignore the layout and background lines of the style block.

```
SHEET 8: BATTLE BACKGROUNDS. A 1536x1024 image made of two separate 1536x512 scenes stacked top and bottom; nothing crosses the middle line. Side-view RPG battle backdrops with no characters. The bottom 25% of each scene is flat open ground where the fighters will stand; keep the upper area calm and uncluttered so interface panels can sit over it.
TOP: night. A deep blue starry sky, a large soft moon, distant mountains with a small castle silhouette, a dark grassy plain.
BOTTOM: day. A bright blue sky with puffy white clouds, rolling green hills, a distant castle, a sunlit grassy plain.
```

If your tool can't make a 1536x1024 image, generate the two scenes separately as `bg-night.png` and `bg-day.png` (as wide as it allows, ideally 3:1).

---

## sheet9-battle.png: the HP fight (knockouts, Claude's attack, hearts)

Save it in `assets/atlas/` as `Game Sticker Icon Grid.png` (the name the build script looks for; change it at the top of `scripts/build-atlas.js` if yours differs) and run `npm run atlas`.

**Attach as references:**
- your sheet 1, `assets/atlas/Chibi Knight and Monster Sprite Sheet.png`, so both characters keep the same look, colours and size;
- the Claude Code icon (see the note at the top).

Until this sheet exists, the Arena already runs the fight, falling back to existing poses (for example, a knockout tips the hurt pose over).

```
SHEET 9: BATTLE. New poses for the same two characters as the attached sheet (identical design, colours, outline and size: the knight about 230px tall when standing, the orange creature about 240px wide), plus fight effects. Every character pose stands on the same baseline 24px above the bottom of its cell.
1 the knight knocked out: lying flat on his back on the ground, eyes as X marks, sword dropped beside him.
2 the knight exhausted: down on one knee leaning on his sword, panting, armour dented, a sweat drop.
3 the knight's critical strike: leaping into a powerful overhead strike, the sword glowing gold, motion lines.
4 the orange creature attacking: charging to the LEFT, body tilted forward, both arms thrust forward like a punch, eyes slanted into an angry V, speed lines behind it.
5 the orange creature knocked out: flipped over on its back with its four legs in the air, eyes as X marks.
6 the orange creature exhausted: slumped low with bent legs, a crack across its body, a sweat drop.
7 the orange creature celebrating a win: jumping with both arms up, eyes as happy upside-down U arcs, a small open square mouth, a few confetti bits.
8 a glossy red heart.
9 the same red heart cracked into two halves.
10 a victory emblem: a golden laurel wreath around a silver sword and a shining star.
11 a defeat emblem: a cracked grey shield with a small skull, dark and gloomy.
12 a big explosive starburst in red, orange and yellow (a critical hit).
13 a burst of small orange square blocks flying outward (the orange creature's blocky impact).
14 a ring of small yellow stars circling, seen slightly from above (dizzy).
15 a glossy green progress-bar fill on its own, with no trough or frame: a horizontal rounded pill about 224x40 with a shine stripe.
16 the same progress-bar fill in glossy red.
```
