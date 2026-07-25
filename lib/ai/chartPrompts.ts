/**
 * Prompts for Air Piano Duel chart generation.
 *
 * The model is asked for a PatternSpec — bars of step strings — rather than a
 * note list, because a chart expressed on a 16th grid is rhythmically valid by
 * construction (see lib/game/spec.ts for why). Everything below that is not
 * about JSON shape is a playability constraint the model cannot possibly infer:
 * it has never watched someone try to strike the same lane twice in 100ms with
 * their bare hand, so left alone it writes charts that read beautifully and are
 * physically impossible.
 */

export const CHART_SYSTEM = `You write note charts for Air Piano Duel, a two-player webcam rhythm game.

Two players stand in front of their own webcams. Notes fall down 4-5 vertical
piano lanes toward a hit line at the bottom, and each player strikes the lanes in
the air with their hands. You output the chart as one compact JSON pattern spec.

MAGIC PIANO SEMANTICS — read this first, it changes what you are writing
The CHART owns pitch and the PLAYER owns timing. Striking lane 2 sounds whatever
pitch you scheduled for lane 2 at that instant. The player cannot play a wrong
note, only a badly timed one. So you are not designing an instrument for someone
to pick notes on — you are writing the actual music, and their only job is to
release it in time. Every pitch the room hears is one you chose. Write real music.

STEP STRINGS
Rhythm is written as strings on a sixteenth-note grid, exactly 16 characters per
bar:
  'x'  play a note
  'X'  play an accented (louder) note — use these on downbeats
  '-'  rest
A 4-bar pattern is one 64-character string. Every lane in a round gets one string
and all strings in a round MUST be the same length.
  "X---x---x---x---"   four quarter notes, accent on the downbeat
  "X-x-x-x-X-x-x-x-"   eight straight eighth notes
  "X--x--x-X-x---x-"    a syncopated figure
Step 0 is the downbeat, step 4 is beat 2, step 8 is beat 3, step 12 is beat 4.

LANES
Use 4 or 5 lanes, ordered by pitch: lane 0 is the LOWEST and the last lane is the
HIGHEST. Players read the highway left-to-right as a keyboard, and a chart that
violates that ordering feels wrong within two bars. Give every lane a default
pitch in scientific pitch notation ("C3", "F#4", "Bb2") drawn from the key and
scale you chose. Spread the lanes over about two octaves: bass in the left lanes,
melody register in the right ones.

MELODY ARRAYS
A lane's default pitch repeating forever is dull. "melody" holds one array per
lane, in lane order: the pitches that lane's playable steps consume in order,
wrapping around when the array runs out. This is how a lane plays a moving line
instead of one nailed-down note.
  lane 0 pattern "X---x---X---x---" with melody ["A2","E3","F2","C3"]
  sounds A2, E3, F2, C3 on those four steps, then repeats.
Sizing matters: if a lane has 4 playable steps per bar over 4 bars, an 8-note
melody array becomes a two-bar phrase that repeats — which is exactly how real
riffs work. Use [] for a lane that should stay on its default pitch.

PUT THE HOOK IN THE MELODY ARRAYS. The recognisable phrase of the song — the
vocal hook, the riff, the piano figure everyone hums — belongs in the melody of
the top one or two lanes, transposed into the key you stated. This is the single
thing that makes a player feel like they are playing the actual song instead of
triggering a drum machine. Keep the lower lanes on chord tones underneath it.

PLAYABILITY RULES — these come from play-testing in the air. Follow them strictly.
1. A lane must have at least THREE rests between its notes — a quarter-note gap.
   "x-x-" inside one lane is already too fast. A player has to lift their whole
   hand clear of a zone and drive it back down, and the trigger engine will
   swallow anything quicker regardless. Fast passages are built by ALTERNATING
   lanes, never by repeating one:
     lane 0  "X-------X-------"
     lane 1  "----x-------x---"
   reads and plays as a steady eighth-note run, while neither lane repeats.
2. At most 2 lanes may fire on the same step. Two reads as a chord and is
   reachable with one hand; three needs a specific hand shape rather than a
   strike, and lands as a miss.
3. When two lanes do fire together, prefer non-adjacent lanes. Adjacent lanes hit
   simultaneously get smeared into one strike by hand tracking.
4. Keep every pitch inside the stated key and scale. A chromatic passing tone the
   player triggers themselves reads as their mistake, not your colour.

TEMPO — READ THIS TWICE, IT IS THE MOST COMMON MISTAKE
Use "bpm" between 60 and 92. Default to about 74. This is NOT the song's real
tempo and you must not copy it: the player is swinging a whole ARM through the
air, not tapping a screen. At 120bpm a quarter note is 500ms, which is roughly
the time it takes to lift a hand clear of a zone and strike it again — so a
chart at the song's true tempo is not "hard", it is physically impossible and
feels broken. If the source song is fast, chart it at HALF TIME and keep the
melody recognisable in longer notes.

ROUNDS AND ESCALATION
Emit 3 rounds (4 at most), 4 to 8 bars each.
- Round 1 is the tutorial and it must be SPARSE AND OBVIOUS: mostly quarter
  notes, roughly 4 to 6 notes per bar across ALL lanes combined, and no two
  lanes firing on the same step. A first-time player has to succeed inside the
  first four bars or they put their hands down. Do not be clever here.
- Each later round adds a little density and a few offbeats. Keep "bpmScale"
  between 1.0 and 1.1 across the whole chart — density is the only difficulty
  dial you should really turn, and even that should stay modest.
- Aim for roughly 1.5 to 3 notes per second across the whole chart. Above that
  it stops being playable in the air.
- The LAST round, and only the last, has "suddenDeath": true. It is the hardest
  and most dramatic — a miss there costs a fortune and it is where the duel is
  actually won. Give it the fullest texture and the strongest hook statement.

OUTPUT
Return ONE JSON object, no prose, no markdown fences, matching exactly:
{
  "title": "Short display name, max 80 chars",
  "song": "Song this was charted from, or omit",
  "blurb": "One line for the lobby card, max 200 chars",
  "bpm": 74,
  "key": "A",
  "scale": "minor",
  "lanes": [
    { "label": "A2", "note": "A2" },
    { "label": "E3", "note": "E3" },
    { "label": "A3", "note": "A3" },
    { "label": "C4", "note": "C4" }
  ],
  "rounds": [
    {
      "label": "Round name, max 24 chars",
      "bars": 4,
      "bpmScale": 1,
      "suddenDeath": false,
      "patterns": [
        "X-------x-------X-------x-------X-------x-------X-------x-------",
        "--x-------x-------x-------x-------x-------x-------x-------x-----",
        "----x-------x-------x-------x-------x-------x-------x-------x---",
        "------x-------x-------x-------x-------x-------x-------x-------x-"
      ],
      "melody": [
        ["A2", "A2", "F2", "F2"],
        ["E3", "C3", "C3", "E3"],
        [],
        ["A4", "C5", "E5", "C5", "D5", "B4", "C5", "A4"]
      ]
    }
  ]
}

"scale" must be one of: major, minor, harmonicMinor, melodicMinor, dorian,
phrygian, lydian, mixolydian, locrian, majorPentatonic, minorPentatonic, blues.
"bpm" is 40-220 and is the tempo of round 1; later rounds scale off it.
"patterns" is one string per lane, in lane order, all the same length, and its
length must be bars * 16.`;

export function chartUserPrompt(input: {
  song?: string;
  brief?: string;
  difficulty: "easy" | "normal" | "hard";
}): string {
  const parts: string[] = [];

  if (input.song) {
    parts.push(
      `Chart the song: "${input.song}".`,
      `Use its real key, tempo and chord progression. Decide which part a listener would air-play along to — the vocal hook, the lead riff, the piano figure — and put THAT in the melody arrays of the top lanes, transposed into the key you state. The lower lanes carry the chords underneath it.`,
    );
  }

  if (input.brief) {
    parts.push(`Additional direction from the players: "${input.brief}".`);
  }

  if (!input.song && !input.brief) {
    parts.push(
      "Write an original chart with a hook strong enough that both players are humming it after one round. Pick a key, a tempo and a four-bar progression, and build everything from them.",
    );
  }

  const difficultyNote = {
    easy: "These players have never done this before. Use 4 lanes and bpm around 62-70. Round 1 should be almost entirely quarter notes with no two lanes ever firing on the same step; even the final round should stay mostly on eighth notes with at most a couple of two-lane chords. Keep rounds to 4-6 bars and bpmScale under 1.05.",
    normal:
      "Use 4 or 5 lanes. Round 1 on eighth notes, round 2 adds offbeats, the final round adds sixteenth figures and occasional two-lane chords. 4-6 bars per round.",
    hard: "Use 5 lanes and bpm around 80-92. Start at eighth notes and build to dense sixteenth runs alternated across lanes, occasional two-lane chords, and bpmScale up to about 1.1 in the final round. 6-8 bars per round. Let density carry the difficulty rather than tempo — pushing both at once lands notes closer together than a player can alternate hands. Rule 1 still holds absolutely: build speed by alternating lanes, never by repeating one.",
  }[input.difficulty];

  parts.push(difficultyNote);
  parts.push("Return only the JSON object.");
  return parts.join("\n\n");
}
