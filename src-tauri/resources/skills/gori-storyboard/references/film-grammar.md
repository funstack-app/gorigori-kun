# Film Grammar

This reference encodes the actual grammar of video storytelling. Without this, the storyboard becomes a series of equally-weighted still images instead of a cinematic cut sequence. Reference this file whenever building a structured prompt.

## Core Principle: A-roll vs B-roll

Every cut in a sequence plays one of two roles:

- **A-roll**: the primary action. The protagonist doing the main verb. Wide-to-medium framing, eye-level or characteristic angles. The audience reads the story arc through A-roll cuts.
- **B-roll**: detail, reaction, environment, insert. Close-ups of hands, eyes, objects, reaction shots, atmospheric fills. B-roll exists to make the A-roll readable, emotional, or rhythmic.

A storyboard MUST alternate A-roll and B-roll. A sequence of all A-roll feels like a slideshow. A sequence of all B-roll has no narrative spine.

## Three-Act Cut Roles

Within any sequence of 4 or more cuts, the cuts MUST cover the following roles in roughly this order. Pick exactly one role per cut.

| Role | Purpose | Typical shot_type | Typical camera_angle |
|------|---------|-------------------|----------------------|
| **establishing** | Show where we are. Locate the protagonist in the scene. | wide / extreme wide | low or eye-level, often static |
| **action** | The main verb happens. Body in motion. | medium / medium-wide | eye-level or low angle for momentum |
| **detail** | B-roll insert. Hands, objects, textures. | close-up / extreme close-up | top-down, side, or macro |
| **reaction** | B-roll. Face, eyes, emotional response. | close-up | eye-level, sometimes slight high or low for vulnerability/power |
| **climax** | The peak moment. Visually distinct from neighbors. | varies but should break pattern | dutch angle, low ground-up, slow-mo equivalent freeze |
| **resolution** | Pull back, settle, breathe out. | wide / medium-wide | eye-level, often slightly elevated |

## Default Role Assignment by Sequence Length

If no specific role is assigned by the Rust orchestrator, use this default:

### 3-cut sequence
1. establishing
2. action
3. resolution

### 4-cut sequence
1. establishing
2. action
3. reaction
4. resolution

### 5-cut sequence
1. establishing
2. action
3. detail
4. reaction
5. resolution

### 6-cut sequence (most common for short videos)
1. establishing
2. action
3. detail
4. climax
5. reaction
6. resolution

### 7-8 cut sequence
Insert a second `action` after `detail`, and a second `detail` before `climax`.

### 9-12 cut sequence
Apply two mini-arcs (each with its own establishing → action → reaction → resolution).

## Step Zoom Rule

Within any 3-cut window, the framing should ZOOM IN at least one step, then PULL OUT, instead of staying flat. Examples:

- ✅ Good: wide → medium → close-up → reaction → wide (in and out)
- ✅ Good: medium → close-up → wide (out)
- ❌ Bad: medium-wide → medium → medium-close (only one direction, marginal)
- ❌ Bad: medium → medium → medium-wide (flat)

The storyboard should breathe in and out, not crawl in one direction.

## Eyeline Match and 180-Degree

Within a single scene group:

- A character looking screen-right in cut N must NOT suddenly look screen-left in cut N+1 unless the scene group has changed or a clear pivot is shown.
- Reaction shots should match the gaze direction implied by the preceding action shot.
- If two characters converse, lock their left/right positions (A-left / B-right) for the entire scene group.

## Cut Transitions (Implicit, but Affects Composition)

Each cut's framing should hint at how it cuts from the previous one:

- **Match cut**: similar shape or motion at frame edges between cuts. Use when the action is continuous.
- **Cutaway**: B-roll detail shot that lets time pass. Use detail or reaction cuts here.
- **Smash cut**: contrast in framing or intensity. Climax cuts often work as smash cuts (e.g., quiet medium → sudden extreme close-up).

The chosen `shot_type` and `camera_angle` should make the implied transition obvious.

## Failure Modes to Avoid

Specific patterns that produce non-cinematic results:

1. **Medium close-up + slightly low angle 6 times in a row.** This is the LLM default. Forbidden.
2. **All A-roll, no B-roll.** Even a 3-cut sequence needs one detail or reaction.
3. **Step-zoom in only one direction.** The audience needs to breathe out at some point.
4. **Eyeline jumps without re-establishing.** Disorients the viewer.
5. **Climax with the same framing as the preceding cut.** Wastes the peak moment.

## How to Use

1. The Rust orchestrator will assign a `cut_role` (one of the roles above) to each cut.
2. Reference the table to pick `shot_type` and `camera_angle` consistent with the role.
3. Override the role-default if `current_action` strongly implies a different shot (verb dictionary takes precedence).
4. Always satisfy the **Step Zoom Rule** when planning a 3-cut window.
5. Add the chosen role and its justification to `framing.cut_role_note` (optional metadata).

## Prompt Detail Requirements

A cinematic prompt is NOT just "close-up, eye-level". It must specify:

- **Focus detail**: which body part / object the camera fixates on.
- **Eye direction**: where the character's gaze points.
- **Light fall**: where the light source is relative to the subject.
- **Body position relative to frame**: left third, right third, dead center, etc.
- **Motion residue**: hair flow, dust, fabric ripple — what was just moving even in a still image.
- **Atmospheric layer**: foreground softness, background bokeh, particles in light beams.

The structured prompt's `framing.spatial_room_for_motion` and `narrative.must_change` MUST include these details for cinematic results.
