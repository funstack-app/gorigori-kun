# Prompt Builder

Build one structured prompt per cut. The prompt separates identity locks, style locks, narrative progression, and framing choices so every cut can change composition without losing character continuity.

## Structured Prompt Shape

```json
{
  "scene_context": {
    "scene_id": "shot_005",
    "scene_group_id": "cafe_conversation",
    "is_same_scene_group_as_previous": true,
    "characters_in_scene": ["A"],
    "character_layout": { "A": "center" },
    "180_rule_active": false
  },
  "identity": {
    "character_reference": "/path/to/char.png",
    "must_keep": ["顔の同一性", "髪型", "服装"]
  },
  "style": {
    "style_reference": "/path/to/style.png",
    "must_keep": ["画風", "色調", "トーン"]
  },
  "narrative": {
    "previous_cut_state": "電車のドアの前に立っている",
    "current_action": "ドアが開き、車内に乗り込む",
    "must_change": ["立ち位置", "視点"]
  },
  "framing": {
    "aspect_ratio": "9:16",
    "shot_type": "medium-wide",
    "camera_angle": "eye-level",
    "spatial_room_for_motion": "前方に歩行可能な空間を残す",
    "rule_of_thirds": true,
    "head_room": "standard",
    "lead_room": "forward"
  },
  "negative": "別人の顔、消えた小物、崩れた手、画風の不整合"
}
```

## Field Semantics

- `scene_context.scene_id`: stable cut id such as `shot_001`.
- `scene_context.scene_group_id`: group id from `references/scene-grouping.md`.
- `scene_context.is_same_scene_group_as_previous`: true when location and time continuity are preserved.
- `scene_context.characters_in_scene`: stable character labels, not generated names.
- `scene_context.character_layout`: screen position map used for 180-degree continuity.
- `scene_context.180_rule_active`: true for conversations, repeated directional movement, and any scene where left/right continuity matters.
- `identity.character_reference`: absolute path to the required character anchor image.
- `identity.must_keep`: face, hair, body type, outfit, and any defining props that must survive.
- `style.style_reference`: absolute path to style reference; use the character image when no style image is supplied.
- `style.must_keep`: art direction, line quality, color tone, lighting feel, and texture.
- `narrative.previous_cut_state`: concise state of the confirmed previous cut.
- `narrative.current_action`: current cut action; feed this into `references/verb-dictionary.md`.
- `narrative.must_change`: elements that must advance from the previous cut.
- `framing.aspect_ratio`: story-level fixed aspect ratio.
- `framing.shot_type`: selected from action semantics and narrative emphasis.
- `framing.camera_angle`: vary every cut unless continuity would break.
- `framing.spatial_room_for_motion`: explicit room for the action to happen on video.
- `negative`: compact list of failures to avoid.

## Keep vs Change Rules

- Keep across all scenes: `character_identity`, `style_lock`, and `color_tone`.
- Keep inside the same scene group: `character_layout` for the 180-degree rule, `lighting_continuity`, and `location_consistency`.
- Judge from context: time of day, weather, prop possession, damage, dirt, emotion, and distance traveled.
- Change every cut: `camera_angle`, `shot_type`, and `composition`, unless the story explicitly requires a locked-off camera.

## Variety Mandate (Hard Requirement)

A sequence of cuts MUST be visually diverse to function as a video storyboard. The single most common failure mode is "all medium shots at slightly low angle". This is forbidden.

### Shot Type Diversity Quota

Within any sequence of **5 or more cuts**, the storyboard MUST include:

- At least **1 extreme close-up or close-up** to show detail, emotion, or critical reaction.
- At least **1 medium / medium-wide** to show character action in context.
- At least **1 wide shot or extreme wide** to establish location or scale.
- At least **1 unconventional angle**: dutch angle, aerial / bird's-eye, ground-level / worm's-eye, or strong over-the-shoulder.

Within any sequence of **3 or 4 cuts**, the storyboard MUST include:

- At least **1 close-up** and **1 wide shot** (or near equivalents).

### Adjacent Cut Diversity

- Do NOT use the same `shot_type` value for **2 consecutive cuts**. If shot_001 is `medium close-up`, shot_002 MUST be a different value.
- Do NOT use the same `camera_angle` value for **3 consecutive cuts**. Rotate among: eye-level, low angle, high angle, dutch tilt, top-down, ground-up.
- `medium close-up` is the default LLM tends to pick. Use it sparingly. Justify every selection with the narrative emphasis of that specific cut.

### Justification Requirement

For each cut, the chosen `shot_type` and `camera_angle` MUST be explicitly justifiable from the `current_action`:

- Action emphasizes detail or reaction → close-up / extreme close-up.
- Action emphasizes scale, environment, or arrival/departure → wide / extreme wide.
- Action emphasizes confusion, distortion, or unease → dutch angle.
- Action emphasizes power dynamics or scale comparison → low angle (heroic) or high angle (vulnerable).
- Action emphasizes a god's-eye overview → aerial / top-down.

If you cannot justify the shot, you have not understood the cut. Re-derive from `current_action`.

## Prompt Assembly Order

1. Start from the story-level inputs and confirmed `aspect_ratio`.
2. **Apply the cut role from `references/film-grammar.md`** (establishing / action / detail / reaction / climax / resolution). The Rust orchestrator passes this role in the prompt header; honor it.
3. Add character/style references as non-negotiable anchors.
4. Add scene group continuity from the previous confirmed cut.
5. Extract motion verbs from `narrative.current_action` and map them with `references/verb-dictionary.md`.
6. **Cross-check the Step Zoom Rule** (`film-grammar.md` §"Step Zoom Rule"). If the previous 2 cuts were the same direction, force a contrasting framing.
7. Select a shot type and spatial room that make the action readable in video AND satisfy the cut role.
8. **Specify Cinematic Detail** (this is the key to "movie-like" results, see below).
9. Add negative constraints for identity drift, outfit drift, prop loss, face defects, hand defects, and background discontinuity.
10. Emit a single image-generation instruction. Do not ask for grids, contact sheets, multiple panels, captions, logos, or watermarks unless the user explicitly requested them.

## Cinematic Detail Requirement (Critical)

A cinematic frame is NOT just "close-up of the character". The structured prompt MUST encode the following detail fields. Add them to the appropriate sections of the JSON.

### Required in `framing`:
- `shot_type`: from verb-dictionary + film-grammar role.
- `camera_angle`: from verb-dictionary + film-grammar role.
- `focus_detail`: which body part or object the camera fixates on. Examples: "right hand fingers", "left eye iris with glint", "scuffed leather boot edge", "wet hair strand against jawline".
- `body_position_in_frame`: precise placement. Examples: "subject in the left third, gaze leading toward right negative space", "torso fills lower 60%, head cropped at hairline", "feet anchored on lower edge of frame".
- `light_fall`: where the light source is relative to the subject. Examples: "rim from screen-right, soft fill from below", "sole light from device glow at frame bottom".
- `motion_residue`: what was just moving and is now mid-flow. Examples: "hair caught mid-flick, fabric in S-curve", "sand grains lifting from heel-strike", "steam tendril rising from coffee".
- `atmospheric_layer`: depth and air. Examples: "foreground bokeh of out-of-focus lab glassware", "background dust motes in light shaft", "soft haze on horizon".

### Required in `narrative`:
- `previous_cut_state`: state at end of previous cut, including residual motion.
- `current_action`: not just the verb, but the moment within the verb. Examples: "the instant the cauliflower head tilts as the device wakes", "the breath drawn just before turning".
- `cut_role`: one of `establishing | action | detail | reaction | climax | resolution`.
- `must_change`: explicit list of things that differ from previous cut. Must include at least one of: camera distance, camera angle, focus target, body position.

### Required in `style`:
- `color_grade_note`: the mood color shift this cut emphasizes. Examples: "lift the shadows toward blue for the glow reaction", "warm side of neutral; preserve sun's amber kiss on jaw".
- `motion_blur_intent`: how the image should suggest video motion. Examples: "slight long-exposure blur on hair tips, body sharp", "tack-sharp eye plus subtle blur on hand mid-arc".

## Cut Role Header Format (from Rust)

The Rust orchestrator prepends the following block to the prompt request:

```
## Cut Role Assignment
- cut_role: action
- shot_type_hint: medium-wide
- camera_angle_hint: low angle
- step_zoom_direction: zoom_in (previous was wider) | zoom_out (previous was tighter) | break (force contrast)
```

These hints are **strong defaults**. Override only if the `current_action` verb dictionary mapping clearly dictates otherwise, and explain in the JSON's `narrative.must_change` field why.
