/*
 * Gym Flow — Member App · Phase U2
 * Built-in professional Exercise Library (offline, static, architecture-ready).
 *
 * This is a self-contained catalogue. It has NO dependency on the offline
 * engine, the network, or the server — it ships with the app and works fully
 * offline by nature. Favorites are stored per-device in localStorage (same
 * pattern as the member notification prefs).
 *
 * EXTENSION POINTS (prepared, intentionally empty in U2 — do not implement yet):
 *   ex.media.image     — hero/thumbnail still
 *   ex.media.video     — demonstration clip
 *   ex.media.animation — looping 2D/3D animation
 *   ex.media.thumbnail — list thumbnail
 *   ex.target_muscles  — anatomical map targets (for a future muscle diagram)
 *   ex.instructions / ex.common_mistakes / ex.tips — coaching content
 * A future phase only has to hydrate these fields (from a CDN/pack or an
 * on-device model). The UI already reads them, so nothing here needs a redesign.
 *
 * To grow the catalogue to "hundreds", append rows to SEED — the taxonomy,
 * search, filters, favorites and detail UI scale automatically.
 */
window.GymExerciseLibrary = (function () {
  'use strict';

  var CATEGORIES = ['Chest', 'Back', 'Shoulders', 'Arms', 'Legs', 'Glutes', 'Core', 'Cardio', 'Full Body', 'Mobility'];
  var EQUIPMENT = ['Barbell', 'Dumbbell', 'Machine', 'Cable', 'Bodyweight', 'Kettlebell', 'Bands', 'Smith Machine', 'EZ Bar', 'Medicine Ball', 'Other'];
  var DIFFICULTY = ['Beginner', 'Intermediate', 'Advanced'];

  // Material Symbols icon per category (matches the shared design system).
  var CATEGORY_ICON = {
    Chest: 'fitness_center', Back: 'exercise', Shoulders: 'sports_gymnastics',
    Arms: 'sports_martial_arts', Legs: 'directions_walk', Glutes: 'directions_run',
    Core: 'grid_view', Cardio: 'cardiology', 'Full Body': 'accessibility_new', Mobility: 'self_improvement'
  };

  // ── Compact seed. Keys kept terse to hold a large catalogue inline.
  //   n=name  c=category  m=primary muscle  s=secondary[]  e=equipment
  //   d=difficulty  mech=Compound|Isolation  f=Push|Pull|Static|Carry|Cardio
  //   how/miss/tip/rest are OPTIONAL per-exercise overrides.
  var C = 'Compound', I = 'Isolation';
  var SEED = [
    // ── CHEST ────────────────────────────────────────────────────────────
    { n: 'Barbell Bench Press', c: 'Chest', m: 'Chest', s: ['Triceps', 'Front Delts'], e: 'Barbell', d: 'Intermediate', mech: C, f: 'Push', rest: 120,
      how: ['Lie flat, eyes under the bar, feet planted.', 'Grip just wider than shoulders; unrack and hold over your chest.', 'Lower the bar to mid-chest, elbows ~45°.', 'Press back up until arms are locked out.'],
      miss: ['Bouncing the bar off the chest.', 'Flaring elbows to 90°.', 'Lifting hips off the bench.'],
      tip: ['Keep shoulder blades pinned back and down.', 'Drive your feet into the floor for a stable base.'] },
    { n: 'Incline Barbell Bench Press', c: 'Chest', m: 'Upper Chest', s: ['Front Delts', 'Triceps'], e: 'Barbell', d: 'Intermediate', mech: C, f: 'Push', rest: 120 },
    { n: 'Decline Barbell Bench Press', c: 'Chest', m: 'Lower Chest', s: ['Triceps'], e: 'Barbell', d: 'Intermediate', mech: C, f: 'Push', rest: 120 },
    { n: 'Dumbbell Bench Press', c: 'Chest', m: 'Chest', s: ['Triceps', 'Front Delts'], e: 'Dumbbell', d: 'Beginner', mech: C, f: 'Push', rest: 90 },
    { n: 'Incline Dumbbell Press', c: 'Chest', m: 'Upper Chest', s: ['Front Delts', 'Triceps'], e: 'Dumbbell', d: 'Beginner', mech: C, f: 'Push', rest: 90 },
    { n: 'Dumbbell Fly', c: 'Chest', m: 'Chest', s: ['Front Delts'], e: 'Dumbbell', d: 'Intermediate', mech: I, f: 'Push', rest: 60 },
    { n: 'Incline Dumbbell Fly', c: 'Chest', m: 'Upper Chest', s: [], e: 'Dumbbell', d: 'Intermediate', mech: I, f: 'Push', rest: 60 },
    { n: 'Cable Crossover', c: 'Chest', m: 'Chest', s: ['Front Delts'], e: 'Cable', d: 'Intermediate', mech: I, f: 'Push', rest: 60 },
    { n: 'Low Cable Fly', c: 'Chest', m: 'Upper Chest', s: [], e: 'Cable', d: 'Intermediate', mech: I, f: 'Push', rest: 60 },
    { n: 'Machine Chest Press', c: 'Chest', m: 'Chest', s: ['Triceps', 'Front Delts'], e: 'Machine', d: 'Beginner', mech: C, f: 'Push', rest: 75 },
    { n: 'Pec Deck', c: 'Chest', m: 'Chest', s: [], e: 'Machine', d: 'Beginner', mech: I, f: 'Push', rest: 60 },
    { n: 'Push-Up', c: 'Chest', m: 'Chest', s: ['Triceps', 'Core'], e: 'Bodyweight', d: 'Beginner', mech: C, f: 'Push', rest: 45,
      how: ['Start in a plank, hands under shoulders.', 'Brace your core and glutes.', 'Lower until your chest is just above the floor.', 'Press back to a full lockout.'],
      miss: ['Sagging or piking hips.', 'Half range of motion.'],
      tip: ['Keep a straight line from head to heels.', 'Elevate hands to scale it down, feet to scale it up.'] },
    { n: 'Incline Push-Up', c: 'Chest', m: 'Lower Chest', s: ['Triceps'], e: 'Bodyweight', d: 'Beginner', mech: C, f: 'Push', rest: 45 },
    { n: 'Decline Push-Up', c: 'Chest', m: 'Upper Chest', s: ['Triceps', 'Front Delts'], e: 'Bodyweight', d: 'Intermediate', mech: C, f: 'Push', rest: 45 },
    { n: 'Chest Dip', c: 'Chest', m: 'Lower Chest', s: ['Triceps'], e: 'Bodyweight', d: 'Advanced', mech: C, f: 'Push', rest: 90 },
    { n: 'Smith Machine Bench Press', c: 'Chest', m: 'Chest', s: ['Triceps'], e: 'Smith Machine', d: 'Beginner', mech: C, f: 'Push', rest: 90 },

    // ── BACK ─────────────────────────────────────────────────────────────
    { n: 'Deadlift', c: 'Back', m: 'Back', s: ['Glutes', 'Hamstrings', 'Traps'], e: 'Barbell', d: 'Advanced', mech: C, f: 'Pull', rest: 180,
      how: ['Stand mid-foot under the bar, shins close.', 'Hinge and grip just outside your legs.', 'Chest up, flat back, take the slack out.', 'Drive the floor away and stand tall, locking hips and knees together.'],
      miss: ['Rounding the lower back.', 'Letting the bar drift forward.', 'Jerking the bar off the floor.'],
      tip: ['Think "push the floor away", not "pull".', 'Keep the bar dragging up your legs.'] },
    { n: 'Barbell Row', c: 'Back', m: 'Back', s: ['Biceps', 'Rear Delts'], e: 'Barbell', d: 'Intermediate', mech: C, f: 'Pull', rest: 120 },
    { n: 'Pendlay Row', c: 'Back', m: 'Back', s: ['Traps', 'Biceps'], e: 'Barbell', d: 'Advanced', mech: C, f: 'Pull', rest: 120 },
    { n: 'T-Bar Row', c: 'Back', m: 'Back', s: ['Biceps', 'Rear Delts'], e: 'Machine', d: 'Intermediate', mech: C, f: 'Pull', rest: 90 },
    { n: 'Pull-Up', c: 'Back', m: 'Lats', s: ['Biceps', 'Core'], e: 'Bodyweight', d: 'Advanced', mech: C, f: 'Pull', rest: 90,
      how: ['Hang from the bar with an overhand grip, wider than shoulders.', 'Pull your elbows down and back.', 'Bring your chin over the bar.', 'Lower under control to a full hang.'],
      miss: ['Kipping or swinging for momentum.', 'Not reaching a full hang each rep.'],
      tip: ['Start each rep by depressing the shoulder blades.', 'Use a band or assisted machine to build up.'] },
    { n: 'Chin-Up', c: 'Back', m: 'Lats', s: ['Biceps'], e: 'Bodyweight', d: 'Intermediate', mech: C, f: 'Pull', rest: 90 },
    { n: 'Lat Pulldown', c: 'Back', m: 'Lats', s: ['Biceps'], e: 'Cable', d: 'Beginner', mech: C, f: 'Pull', rest: 75 },
    { n: 'Close-Grip Pulldown', c: 'Back', m: 'Lats', s: ['Biceps'], e: 'Cable', d: 'Beginner', mech: C, f: 'Pull', rest: 75 },
    { n: 'Seated Cable Row', c: 'Back', m: 'Back', s: ['Biceps', 'Rear Delts'], e: 'Cable', d: 'Beginner', mech: C, f: 'Pull', rest: 75 },
    { n: 'Single-Arm Dumbbell Row', c: 'Back', m: 'Lats', s: ['Biceps', 'Rear Delts'], e: 'Dumbbell', d: 'Beginner', mech: C, f: 'Pull', rest: 60 },
    { n: 'Chest-Supported Row', c: 'Back', m: 'Back', s: ['Rear Delts', 'Biceps'], e: 'Dumbbell', d: 'Beginner', mech: C, f: 'Pull', rest: 75 },
    { n: 'Face Pull', c: 'Back', m: 'Rear Delts', s: ['Traps'], e: 'Cable', d: 'Beginner', mech: I, f: 'Pull', rest: 45 },
    { n: 'Straight-Arm Pulldown', c: 'Back', m: 'Lats', s: [], e: 'Cable', d: 'Beginner', mech: I, f: 'Pull', rest: 60 },
    { n: 'Machine Row', c: 'Back', m: 'Back', s: ['Biceps'], e: 'Machine', d: 'Beginner', mech: C, f: 'Pull', rest: 75 },
    { n: 'Rack Pull', c: 'Back', m: 'Back', s: ['Traps', 'Glutes'], e: 'Barbell', d: 'Intermediate', mech: C, f: 'Pull', rest: 150 },
    { n: 'Back Extension', c: 'Back', m: 'Lower Back', s: ['Glutes', 'Hamstrings'], e: 'Bodyweight', d: 'Beginner', mech: I, f: 'Pull', rest: 60 },
    { n: 'Inverted Row', c: 'Back', m: 'Back', s: ['Biceps', 'Core'], e: 'Bodyweight', d: 'Beginner', mech: C, f: 'Pull', rest: 60 },

    // ── SHOULDERS ────────────────────────────────────────────────────────
    { n: 'Overhead Press', c: 'Shoulders', m: 'Shoulders', s: ['Triceps', 'Traps'], e: 'Barbell', d: 'Intermediate', mech: C, f: 'Push', rest: 120,
      how: ['Stand tall, bar racked on your front delts, grip just outside shoulders.', 'Brace your core and glutes.', 'Press the bar overhead, moving your head back then through.', 'Lock out with the bar over your mid-foot.'],
      miss: ['Leaning back into a bench-press position.', 'Pressing the bar around your face instead of up.'],
      tip: ['Squeeze your glutes to protect your lower back.', 'Finish with biceps by your ears.'] },
    { n: 'Seated Dumbbell Press', c: 'Shoulders', m: 'Shoulders', s: ['Triceps'], e: 'Dumbbell', d: 'Beginner', mech: C, f: 'Push', rest: 90 },
    { n: 'Arnold Press', c: 'Shoulders', m: 'Shoulders', s: ['Triceps'], e: 'Dumbbell', d: 'Intermediate', mech: C, f: 'Push', rest: 90 },
    { n: 'Dumbbell Lateral Raise', c: 'Shoulders', m: 'Side Delts', s: [], e: 'Dumbbell', d: 'Beginner', mech: I, f: 'Push', rest: 45,
      how: ['Stand with a dumbbell in each hand at your sides.', 'With a slight bend in the elbows, raise the weights out to the sides.', 'Stop at shoulder height, leading with your elbows.', 'Lower slowly under control.'],
      miss: ['Swinging with momentum.', 'Shrugging the traps up.', 'Going far above shoulder height.'],
      tip: ['Imagine pouring a jug of water at the top.', 'Lighter weight, strict form beats heavy swinging.'] },
    { n: 'Cable Lateral Raise', c: 'Shoulders', m: 'Side Delts', s: [], e: 'Cable', d: 'Intermediate', mech: I, f: 'Push', rest: 45 },
    { n: 'Machine Shoulder Press', c: 'Shoulders', m: 'Shoulders', s: ['Triceps'], e: 'Machine', d: 'Beginner', mech: C, f: 'Push', rest: 75 },
    { n: 'Front Raise', c: 'Shoulders', m: 'Front Delts', s: [], e: 'Dumbbell', d: 'Beginner', mech: I, f: 'Push', rest: 45 },
    { n: 'Reverse Pec Deck', c: 'Shoulders', m: 'Rear Delts', s: ['Traps'], e: 'Machine', d: 'Beginner', mech: I, f: 'Pull', rest: 45 },
    { n: 'Bent-Over Rear Delt Raise', c: 'Shoulders', m: 'Rear Delts', s: [], e: 'Dumbbell', d: 'Beginner', mech: I, f: 'Pull', rest: 45 },
    { n: 'Upright Row', c: 'Shoulders', m: 'Side Delts', s: ['Traps'], e: 'Barbell', d: 'Intermediate', mech: C, f: 'Pull', rest: 60 },
    { n: 'Barbell Shrug', c: 'Shoulders', m: 'Traps', s: [], e: 'Barbell', d: 'Beginner', mech: I, f: 'Pull', rest: 60 },
    { n: 'Dumbbell Shrug', c: 'Shoulders', m: 'Traps', s: [], e: 'Dumbbell', d: 'Beginner', mech: I, f: 'Pull', rest: 60 },
    { n: 'Push Press', c: 'Shoulders', m: 'Shoulders', s: ['Triceps', 'Legs'], e: 'Barbell', d: 'Advanced', mech: C, f: 'Push', rest: 120 },
    { n: 'Landmine Press', c: 'Shoulders', m: 'Shoulders', s: ['Upper Chest', 'Triceps'], e: 'Barbell', d: 'Intermediate', mech: C, f: 'Push', rest: 75 },

    // ── ARMS ─────────────────────────────────────────────────────────────
    { n: 'Barbell Curl', c: 'Arms', m: 'Biceps', s: ['Forearms'], e: 'Barbell', d: 'Beginner', mech: I, f: 'Pull', rest: 60,
      how: ['Stand tall holding the bar with an underhand, shoulder-width grip.', 'Keep your elbows pinned to your sides.', 'Curl the bar up by contracting the biceps.', 'Lower slowly to a full stretch.'],
      miss: ['Swinging the torso to heave the weight.', 'Letting the elbows drift forward.'],
      tip: ['Control the negative for 2–3 seconds.', 'Squeeze hard at the top.'] },
    { n: 'EZ-Bar Curl', c: 'Arms', m: 'Biceps', s: ['Forearms'], e: 'EZ Bar', d: 'Beginner', mech: I, f: 'Pull', rest: 60 },
    { n: 'Dumbbell Curl', c: 'Arms', m: 'Biceps', s: ['Forearms'], e: 'Dumbbell', d: 'Beginner', mech: I, f: 'Pull', rest: 45 },
    { n: 'Hammer Curl', c: 'Arms', m: 'Biceps', s: ['Forearms'], e: 'Dumbbell', d: 'Beginner', mech: I, f: 'Pull', rest: 45 },
    { n: 'Incline Dumbbell Curl', c: 'Arms', m: 'Biceps', s: [], e: 'Dumbbell', d: 'Intermediate', mech: I, f: 'Pull', rest: 45 },
    { n: 'Preacher Curl', c: 'Arms', m: 'Biceps', s: [], e: 'EZ Bar', d: 'Beginner', mech: I, f: 'Pull', rest: 45 },
    { n: 'Concentration Curl', c: 'Arms', m: 'Biceps', s: [], e: 'Dumbbell', d: 'Beginner', mech: I, f: 'Pull', rest: 45 },
    { n: 'Cable Curl', c: 'Arms', m: 'Biceps', s: ['Forearms'], e: 'Cable', d: 'Beginner', mech: I, f: 'Pull', rest: 45 },
    { n: 'Close-Grip Bench Press', c: 'Arms', m: 'Triceps', s: ['Chest', 'Front Delts'], e: 'Barbell', d: 'Intermediate', mech: C, f: 'Push', rest: 90 },
    { n: 'Triceps Pushdown', c: 'Arms', m: 'Triceps', s: [], e: 'Cable', d: 'Beginner', mech: I, f: 'Push', rest: 45,
      how: ['Face the high pulley, grab the bar with an overhand grip.', 'Tuck your elbows to your sides.', 'Push the bar down until your arms lock out.', 'Return slowly to 90° without flaring the elbows.'],
      miss: ['Elbows drifting away from the body.', 'Using the shoulders to push.'],
      tip: ['Keep the elbows fixed like a hinge.', 'Pause and squeeze at full extension.'] },
    { n: 'Rope Pushdown', c: 'Arms', m: 'Triceps', s: [], e: 'Cable', d: 'Beginner', mech: I, f: 'Push', rest: 45 },
    { n: 'Overhead Triceps Extension', c: 'Arms', m: 'Triceps', s: [], e: 'Dumbbell', d: 'Beginner', mech: I, f: 'Push', rest: 45 },
    { n: 'Skull Crushers', c: 'Arms', m: 'Triceps', s: [], e: 'EZ Bar', d: 'Intermediate', mech: I, f: 'Push', rest: 60 },
    { n: 'Dumbbell Kickback', c: 'Arms', m: 'Triceps', s: [], e: 'Dumbbell', d: 'Beginner', mech: I, f: 'Push', rest: 45 },
    { n: 'Bench Dip', c: 'Arms', m: 'Triceps', s: ['Front Delts'], e: 'Bodyweight', d: 'Beginner', mech: C, f: 'Push', rest: 45 },
    { n: 'Reverse Curl', c: 'Arms', m: 'Forearms', s: ['Biceps'], e: 'EZ Bar', d: 'Beginner', mech: I, f: 'Pull', rest: 45 },
    { n: 'Wrist Curl', c: 'Arms', m: 'Forearms', s: [], e: 'Dumbbell', d: 'Beginner', mech: I, f: 'Pull', rest: 30 },

    // ── LEGS ─────────────────────────────────────────────────────────────
    { n: 'Back Squat', c: 'Legs', m: 'Quads', s: ['Glutes', 'Hamstrings', 'Core'], e: 'Barbell', d: 'Intermediate', mech: C, f: 'Push', rest: 150,
      how: ['Set the bar on your upper back, grip firmly, brace hard.', 'Unrack and step back into a shoulder-width stance.', 'Sit down and back, knees tracking over your toes.', 'Descend to at least parallel, then drive up through mid-foot.'],
      miss: ['Knees caving inward.', 'Heels lifting off the floor.', 'Rounding the lower back at the bottom.'],
      tip: ['Brace like you\'re about to be punched in the gut.', 'Push your knees out on the way down.'] },
    { n: 'Front Squat', c: 'Legs', m: 'Quads', s: ['Glutes', 'Core'], e: 'Barbell', d: 'Advanced', mech: C, f: 'Push', rest: 150 },
    { n: 'Leg Press', c: 'Legs', m: 'Quads', s: ['Glutes', 'Hamstrings'], e: 'Machine', d: 'Beginner', mech: C, f: 'Push', rest: 120 },
    { n: 'Hack Squat', c: 'Legs', m: 'Quads', s: ['Glutes'], e: 'Machine', d: 'Intermediate', mech: C, f: 'Push', rest: 120 },
    { n: 'Bulgarian Split Squat', c: 'Legs', m: 'Quads', s: ['Glutes', 'Core'], e: 'Dumbbell', d: 'Intermediate', mech: C, f: 'Push', rest: 90 },
    { n: 'Walking Lunge', c: 'Legs', m: 'Quads', s: ['Glutes', 'Hamstrings'], e: 'Dumbbell', d: 'Beginner', mech: C, f: 'Push', rest: 75 },
    { n: 'Goblet Squat', c: 'Legs', m: 'Quads', s: ['Glutes', 'Core'], e: 'Dumbbell', d: 'Beginner', mech: C, f: 'Push', rest: 75 },
    { n: 'Leg Extension', c: 'Legs', m: 'Quads', s: [], e: 'Machine', d: 'Beginner', mech: I, f: 'Push', rest: 60 },
    { n: 'Romanian Deadlift', c: 'Legs', m: 'Hamstrings', s: ['Glutes', 'Lower Back'], e: 'Barbell', d: 'Intermediate', mech: C, f: 'Pull', rest: 120,
      how: ['Hold the bar at your hips, knees softly bent.', 'Push your hips back, letting the bar slide down your thighs.', 'Feel a deep stretch in the hamstrings, back flat.', 'Drive your hips forward to stand tall.'],
      miss: ['Turning it into a squat.', 'Rounding the back to chase depth.'],
      tip: ['The movement is at the hips, not the knees.', 'Keep the bar close to your legs the whole time.'] },
    { n: 'Lying Leg Curl', c: 'Legs', m: 'Hamstrings', s: [], e: 'Machine', d: 'Beginner', mech: I, f: 'Pull', rest: 60 },
    { n: 'Seated Leg Curl', c: 'Legs', m: 'Hamstrings', s: [], e: 'Machine', d: 'Beginner', mech: I, f: 'Pull', rest: 60 },
    { n: 'Stiff-Leg Deadlift', c: 'Legs', m: 'Hamstrings', s: ['Glutes'], e: 'Barbell', d: 'Intermediate', mech: C, f: 'Pull', rest: 120 },
    { n: 'Standing Calf Raise', c: 'Legs', m: 'Calves', s: [], e: 'Machine', d: 'Beginner', mech: I, f: 'Push', rest: 45 },
    { n: 'Seated Calf Raise', c: 'Legs', m: 'Calves', s: [], e: 'Machine', d: 'Beginner', mech: I, f: 'Push', rest: 45 },
    { n: 'Step-Up', c: 'Legs', m: 'Quads', s: ['Glutes'], e: 'Dumbbell', d: 'Beginner', mech: C, f: 'Push', rest: 60 },
    { n: 'Smith Machine Squat', c: 'Legs', m: 'Quads', s: ['Glutes'], e: 'Smith Machine', d: 'Beginner', mech: C, f: 'Push', rest: 120 },

    // ── GLUTES ───────────────────────────────────────────────────────────
    { n: 'Hip Thrust', c: 'Glutes', m: 'Glutes', s: ['Hamstrings'], e: 'Barbell', d: 'Intermediate', mech: C, f: 'Push', rest: 90,
      how: ['Sit with your upper back on a bench, bar over your hips (use a pad).', 'Plant your feet, shins vertical at the top.', 'Drive through your heels and squeeze your glutes to lift.', 'Reach a flat back at the top, then lower under control.'],
      miss: ['Overextending the lower back at the top.', 'Pushing through the toes instead of heels.'],
      tip: ['Tuck the chin and keep ribs down.', 'Pause for a second at full lockout.'] },
    { n: 'Barbell Glute Bridge', c: 'Glutes', m: 'Glutes', s: ['Hamstrings'], e: 'Barbell', d: 'Beginner', mech: C, f: 'Push', rest: 75 },
    { n: 'Cable Kickback', c: 'Glutes', m: 'Glutes', s: [], e: 'Cable', d: 'Beginner', mech: I, f: 'Push', rest: 45 },
    { n: 'Sumo Deadlift', c: 'Glutes', m: 'Glutes', s: ['Hamstrings', 'Quads', 'Back'], e: 'Barbell', d: 'Advanced', mech: C, f: 'Pull', rest: 150 },
    { n: 'Cable Pull-Through', c: 'Glutes', m: 'Glutes', s: ['Hamstrings'], e: 'Cable', d: 'Beginner', mech: C, f: 'Pull', rest: 60 },
    { n: 'Hip Abduction Machine', c: 'Glutes', m: 'Glutes', s: [], e: 'Machine', d: 'Beginner', mech: I, f: 'Push', rest: 45 },
    { n: 'Curtsy Lunge', c: 'Glutes', m: 'Glutes', s: ['Quads'], e: 'Dumbbell', d: 'Intermediate', mech: C, f: 'Push', rest: 60 },

    // ── CORE ─────────────────────────────────────────────────────────────
    { n: 'Plank', c: 'Core', m: 'Core', s: ['Shoulders'], e: 'Bodyweight', d: 'Beginner', mech: I, f: 'Static', rest: 45,
      how: ['Rest on your forearms and toes, elbows under shoulders.', 'Brace your abs and squeeze your glutes.', 'Hold a straight line from head to heels.', 'Breathe steadily for the target time.'],
      miss: ['Letting the hips sag or pike.', 'Holding your breath.'],
      tip: ['Pull your belly button toward your spine.', 'Quality tension beats a long, sloppy hold.'] },
    { n: 'Side Plank', c: 'Core', m: 'Obliques', s: ['Core'], e: 'Bodyweight', d: 'Beginner', mech: I, f: 'Static', rest: 45 },
    { n: 'Crunch', c: 'Core', m: 'Abs', s: [], e: 'Bodyweight', d: 'Beginner', mech: I, f: 'Pull', rest: 30 },
    { n: 'Bicycle Crunch', c: 'Core', m: 'Abs', s: ['Obliques'], e: 'Bodyweight', d: 'Beginner', mech: I, f: 'Pull', rest: 30 },
    { n: 'Hanging Leg Raise', c: 'Core', m: 'Abs', s: ['Hip Flexors'], e: 'Bodyweight', d: 'Advanced', mech: I, f: 'Pull', rest: 60 },
    { n: 'Lying Leg Raise', c: 'Core', m: 'Abs', s: ['Hip Flexors'], e: 'Bodyweight', d: 'Beginner', mech: I, f: 'Pull', rest: 45 },
    { n: 'Cable Crunch', c: 'Core', m: 'Abs', s: [], e: 'Cable', d: 'Beginner', mech: I, f: 'Pull', rest: 45 },
    { n: 'Russian Twist', c: 'Core', m: 'Obliques', s: ['Abs'], e: 'Medicine Ball', d: 'Beginner', mech: I, f: 'Pull', rest: 30 },
    { n: 'Ab Wheel Rollout', c: 'Core', m: 'Abs', s: ['Lats'], e: 'Other', d: 'Advanced', mech: C, f: 'Static', rest: 60 },
    { n: 'Mountain Climber', c: 'Core', m: 'Core', s: ['Hip Flexors'], e: 'Bodyweight', d: 'Beginner', mech: C, f: 'Cardio', rest: 30 },
    { n: 'Dead Bug', c: 'Core', m: 'Core', s: [], e: 'Bodyweight', d: 'Beginner', mech: I, f: 'Static', rest: 30 },
    { n: 'Cable Woodchopper', c: 'Core', m: 'Obliques', s: ['Core'], e: 'Cable', d: 'Intermediate', mech: C, f: 'Pull', rest: 45 },
    { n: 'Hollow Body Hold', c: 'Core', m: 'Abs', s: [], e: 'Bodyweight', d: 'Intermediate', mech: I, f: 'Static', rest: 45 },

    // ── CARDIO ───────────────────────────────────────────────────────────
    { n: 'Treadmill Run', c: 'Cardio', m: 'Cardio', s: ['Legs'], e: 'Machine', d: 'Beginner', mech: C, f: 'Cardio', rest: 0 },
    { n: 'Incline Treadmill Walk', c: 'Cardio', m: 'Cardio', s: ['Glutes', 'Calves'], e: 'Machine', d: 'Beginner', mech: C, f: 'Cardio', rest: 0 },
    { n: 'Stationary Bike', c: 'Cardio', m: 'Cardio', s: ['Quads'], e: 'Machine', d: 'Beginner', mech: C, f: 'Cardio', rest: 0 },
    { n: 'Rowing Machine', c: 'Cardio', m: 'Cardio', s: ['Back', 'Legs'], e: 'Machine', d: 'Beginner', mech: C, f: 'Cardio', rest: 0 },
    { n: 'Elliptical', c: 'Cardio', m: 'Cardio', s: ['Legs'], e: 'Machine', d: 'Beginner', mech: C, f: 'Cardio', rest: 0 },
    { n: 'Stair Climber', c: 'Cardio', m: 'Cardio', s: ['Glutes', 'Calves'], e: 'Machine', d: 'Beginner', mech: C, f: 'Cardio', rest: 0 },
    { n: 'Jump Rope', c: 'Cardio', m: 'Cardio', s: ['Calves'], e: 'Other', d: 'Beginner', mech: C, f: 'Cardio', rest: 30 },
    { n: 'Burpee', c: 'Cardio', m: 'Full Body', s: ['Chest', 'Legs', 'Core'], e: 'Bodyweight', d: 'Intermediate', mech: C, f: 'Cardio', rest: 45 },
    { n: 'High Knees', c: 'Cardio', m: 'Cardio', s: ['Hip Flexors'], e: 'Bodyweight', d: 'Beginner', mech: C, f: 'Cardio', rest: 30 },
    { n: 'Battle Ropes', c: 'Cardio', m: 'Full Body', s: ['Shoulders', 'Core'], e: 'Other', d: 'Intermediate', mech: C, f: 'Cardio', rest: 45 },
    { n: 'Assault Bike', c: 'Cardio', m: 'Cardio', s: ['Full Body'], e: 'Machine', d: 'Intermediate', mech: C, f: 'Cardio', rest: 0 },

    // ── FULL BODY / OLYMPIC ──────────────────────────────────────────────
    { n: 'Clean and Press', c: 'Full Body', m: 'Full Body', s: ['Shoulders', 'Legs', 'Back'], e: 'Barbell', d: 'Advanced', mech: C, f: 'Push', rest: 150 },
    { n: 'Power Clean', c: 'Full Body', m: 'Full Body', s: ['Traps', 'Legs', 'Back'], e: 'Barbell', d: 'Advanced', mech: C, f: 'Pull', rest: 150 },
    { n: 'Kettlebell Swing', c: 'Full Body', m: 'Glutes', s: ['Hamstrings', 'Core', 'Shoulders'], e: 'Kettlebell', d: 'Intermediate', mech: C, f: 'Pull', rest: 60,
      how: ['Stand with the kettlebell a foot ahead, hinge and grip it.', 'Hike it back between your legs.', 'Snap your hips forward explosively to float the bell to chest height.', 'Let it fall and load the next rep at the hips.'],
      miss: ['Squatting the swing instead of hinging.', 'Lifting with the arms and shoulders.'],
      tip: ['The power comes from a hip snap, not the arms.', 'Keep the bell close on the backswing.'] },
    { n: 'Thruster', c: 'Full Body', m: 'Full Body', s: ['Quads', 'Shoulders'], e: 'Barbell', d: 'Intermediate', mech: C, f: 'Push', rest: 90 },
    { n: 'Turkish Get-Up', c: 'Full Body', m: 'Full Body', s: ['Core', 'Shoulders'], e: 'Kettlebell', d: 'Advanced', mech: C, f: 'Static', rest: 90 },
    { n: 'Dumbbell Snatch', c: 'Full Body', m: 'Full Body', s: ['Shoulders', 'Glutes'], e: 'Dumbbell', d: 'Advanced', mech: C, f: 'Pull', rest: 90 },
    { n: "Farmer's Carry", c: 'Full Body', m: 'Full Body', s: ['Forearms', 'Traps', 'Core'], e: 'Dumbbell', d: 'Beginner', mech: C, f: 'Carry', rest: 60 },
    { n: 'Wall Ball', c: 'Full Body', m: 'Full Body', s: ['Quads', 'Shoulders'], e: 'Medicine Ball', d: 'Intermediate', mech: C, f: 'Push', rest: 60 },

    // ── MOBILITY ─────────────────────────────────────────────────────────
    { n: 'Cat-Cow', c: 'Mobility', m: 'Spine', s: ['Core'], e: 'Bodyweight', d: 'Beginner', mech: I, f: 'Static', rest: 20 },
    { n: "World's Greatest Stretch", c: 'Mobility', m: 'Hips', s: ['Spine', 'Hamstrings'], e: 'Bodyweight', d: 'Beginner', mech: I, f: 'Static', rest: 20 },
    { n: 'Hip Flexor Stretch', c: 'Mobility', m: 'Hip Flexors', s: [], e: 'Bodyweight', d: 'Beginner', mech: I, f: 'Static', rest: 20 },
    { n: 'Downward Dog', c: 'Mobility', m: 'Hamstrings', s: ['Shoulders', 'Calves'], e: 'Bodyweight', d: 'Beginner', mech: I, f: 'Static', rest: 20 },
    { n: 'Thoracic Rotation', c: 'Mobility', m: 'Spine', s: ['Shoulders'], e: 'Bodyweight', d: 'Beginner', mech: I, f: 'Static', rest: 20 },
    { n: 'Couch Stretch', c: 'Mobility', m: 'Quads', s: ['Hip Flexors'], e: 'Bodyweight', d: 'Intermediate', mech: I, f: 'Static', rest: 20 },
    { n: '90/90 Hip Stretch', c: 'Mobility', m: 'Hips', s: ['Glutes'], e: 'Bodyweight', d: 'Beginner', mech: I, f: 'Static', rest: 20 }
  ];

  // ── Helpers ─────────────────────────────────────────────────────────────
  function slug(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  // Generic, sensible coaching content for rows without bespoke text so EVERY
  // exercise detail screen is populated (a later phase can override with richer
  // media-backed content — the UI already reads these fields).
  function genericHow(ex) {
    var lower = (ex.equipment === 'Bodyweight' || ex.equipment === 'Other') ? 'your bodyweight' : 'the ' + ex.equipment.toLowerCase();
    return [
      'Set up in a stable, braced position with ' + lower + '.',
      'Keep a neutral spine and control the weight through the full range.',
      (ex.force === 'Pull' ? 'Pull' : ex.force === 'Static' ? 'Hold the position, driving tension' : 'Drive') + ' with intent, focusing on the ' + ex.primary_muscle.toLowerCase() + '.',
      'Return slowly under control and keep tension on the ' + ex.primary_muscle.toLowerCase() + '.'
    ];
  }
  function genericMiss(ex) {
    return [
      'Using momentum instead of controlled muscle tension.',
      'Cutting the range of motion short.',
      ex.mechanic === 'Compound' ? 'Losing a braced, neutral spine under load.' : 'Letting other muscles take over from the ' + ex.primary_muscle.toLowerCase() + '.'
    ];
  }
  function genericTip(ex) {
    return [
      'Control the lowering phase for 2–3 seconds.',
      'Pick a weight you can move with strict form for every rep.'
    ];
  }
  // One-line summary derived from the exercise's attributes (bespoke rows can
  // override via `desc`). A later phase can replace these with richer copy.
  function genericDesc(ex) {
    var art = /^[aeiou]/i.test(ex.difficulty) ? 'An' : 'A';
    var eq = (ex.equipment === 'Bodyweight' || ex.equipment === 'Other') ? 'minimal equipment' : 'the ' + ex.equipment.toLowerCase();
    var sec = ex.secondary_muscles.length ? ', also working the ' + ex.secondary_muscles.join(' and ').toLowerCase() : '';
    return art + ' ' + ex.difficulty.toLowerCase() + ' ' + (ex.mechanic === 'Compound' ? 'compound' : 'isolation') +
      ' movement targeting the ' + ex.primary_muscle.toLowerCase() + sec + ', performed with ' + eq + '.';
  }

  // Hydrate a compact seed row into the full public shape (media fields prepared).
  function make(row) {
    var ex = {
      id: slug(row.n),
      name: row.n,
      category: row.c,
      primary_muscle: row.m,
      secondary_muscles: row.s || [],
      target_muscles: [row.m].concat(row.s || []),
      equipment: row.e,
      difficulty: row.d,
      mechanic: row.mech,
      force: row.f,
      default_rest_sec: typeof row.rest === 'number' ? row.rest : (row.mech === 'Compound' ? 90 : 60),
      category_icon: CATEGORY_ICON[row.c] || 'exercise',
      // Coaching content (bespoke when provided, otherwise a sensible generic).
      instructions: null, common_mistakes: null, tips: null,
      // ── EXTENSION POINTS — future media, intentionally empty in U2 ──
      media: { image: null, video: null, animation: null, thumbnail: null },
      has_media: false
    };
    ex.instructions = row.how || genericHow(ex);
    ex.common_mistakes = row.miss || genericMiss(ex);
    ex.tips = row.tip || genericTip(ex);
    ex.description = row.desc || genericDesc(ex);
    return ex;
  }

  var ALL = SEED.map(make);
  var BY_ID = {};
  var BY_NAME = {};
  ALL.forEach(function (e) { BY_ID[e.id] = e; BY_NAME[e.name.toLowerCase()] = e; });

  // ── Favorites (per-device, offline) ──────────────────────────────────────
  var FAV_KEY = 'gf.member.exFavorites';
  function favSet() {
    try { return JSON.parse(localStorage.getItem(FAV_KEY) || '[]'); } catch (e) { return []; }
  }
  function favSave(list) { try { localStorage.setItem(FAV_KEY, JSON.stringify(list)); } catch (e) {} }
  function isFavorite(id) { return favSet().indexOf(id) !== -1; }
  function toggleFavorite(id) {
    var list = favSet();
    var i = list.indexOf(id);
    if (i === -1) list.push(id); else list.splice(i, 1);
    favSave(list);
    return i === -1; // true = now favorited
  }
  function favoriteIds() { return favSet(); }

  // ── Search / filter ───────────────────────────────────────────────────────
  // opts: { q, category, muscle, equipment, difficulty, favoritesOnly }
  function search(opts) {
    opts = opts || {};
    var q = (opts.q || '').trim().toLowerCase();
    var favs = opts.favoritesOnly ? favSet() : null;
    return ALL.filter(function (e) {
      if (favs && favs.indexOf(e.id) === -1) return false;
      if (opts.category && opts.category !== 'All' && e.category !== opts.category) return false;
      if (opts.equipment && opts.equipment !== 'All' && e.equipment !== opts.equipment) return false;
      if (opts.difficulty && opts.difficulty !== 'All' && e.difficulty !== opts.difficulty) return false;
      if (opts.muscle && opts.muscle !== 'All' && e.target_muscles.indexOf(opts.muscle) === -1) return false;
      if (q) {
        var hay = (e.name + ' ' + e.primary_muscle + ' ' + e.secondary_muscles.join(' ') + ' ' + e.equipment + ' ' + e.category).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function musclesList() {
    var set = {};
    ALL.forEach(function (e) { e.target_muscles.forEach(function (m) { set[m] = true; }); });
    return Object.keys(set).sort();
  }

  return {
    version: 1,
    categories: CATEGORIES.slice(),
    equipment: EQUIPMENT.slice(),
    difficulty: DIFFICULTY.slice(),
    categoryIcon: function (c) { return CATEGORY_ICON[c] || 'exercise'; },
    all: function () { return ALL.slice(); },
    count: ALL.length,
    muscles: musclesList,
    getById: function (id) { return BY_ID[id] || null; },
    getByName: function (name) { return BY_NAME[String(name || '').toLowerCase()] || null; },
    search: search,
    isFavorite: isFavorite,
    toggleFavorite: toggleFavorite,
    favoriteIds: favoriteIds
  };
})();
