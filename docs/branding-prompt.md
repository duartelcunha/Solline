# Branding prompt for Solline

> Historical exploration only. Superseded by `../DESIGN.md` and `brand.md` on 22/10/2026:
> neutral porcelain/glass, original googly cut-paper figures, no green or brand hue.
> The wizard and amber-brand directions below must not guide current implementation.

Paste everything below the line into the design tool or model you use for identity work.

---

You are the design director for the brand identity of **Solline**, a desktop app for software developers. Build an identity that could only belong to this product. If someone could guess the look from the category alone ("AI dev tool"), it has failed.

## The product, in facts

- Solline runs several coding agents in one place: Claude Code, OpenAI Codex, and any agent that speaks the open Agent Client Protocol. The user signs in with their own subscriptions; Solline never touches their keys.
- Its mechanism, in one sentence: **every agent's turn becomes a checkpoint on a timeline you can scrub, review hunk by hunk, rewind, and get a second opinion on from a different model.**
- The audience: developers and builders who want to understand what the agents are doing at a glance, without reading walls of text. They sit at a desk for long sessions, often into the night, on Windows.
- The feel the founder asked for: satisfying and playful like a well-made game, but professional. Visual first. Very little text. Things should transform into one another smoothly instead of popping in and out.
- The name is fixed: **Solline** = _sol_ (sun) + _line_ (the session timeline). There is a working accent today: a warm amber sun dot next to the name, on warm neutral greys. You may keep, evolve or replace it, but say which and why.
- Each agent appears in the app as a hooded wizard of the **Solline crew**: Solline is a gang of agents casting spells on your code. The direction is inspired by the hooded-wizard internet meme, but every drawing must be original. Do not copy existing sprites, the meme's name or its catchphrases.
- The founder's own GitHub profile already lives in this world, and Solline should feel like its sibling. Attached references: a grey hooded **shadow familiar** with glowing white eyes, working at a laptop with a cup of coffee (pixel art on a near-black ground), and a five-colour wizard crew used in the profile banner. Keep the family resemblance (the hood, the hidden face, the eyes, the colour-per-character idea, the pixel discipline). Redraw everything from scratch: some of those crew sprites sit too close to the meme's original art to ship in a product.
- The shadow familiar is the user's companion in Solline: it hosts the first run and the empty states, and it is the one character that may appear outside the app (the GitHub social image, the README).
- The UI typeface today is Geist and Geist Mono. Keep Geist for the product UI. The brand may add one display face if it earns its place.

## How to work

1. Write one sentence of physical scene (who, where, under what light) and let it decide whether the brand leads with light or dark.
2. List seven concrete things from the audience's wider world that could carry the mechanism: graphic traditions, notations, places, rituals, objects, data graphics they know by heart. Do **not** draw from the tools they operate (terminals, code editors, oscilloscopes, control panels); those come back as costumes. Spend at most one candidate on the literal reading of the name (a sun). The seven must span at least three material families. For each: one line on why it carries "a timeline of checkpoints you can scrub and rewind", one line on its colours, type voice and signature.
3. Also answer: what would Solline be as a physical object? What did its world look like before software?
4. Turn the strongest three into complete directions. Each direction states: thesis (one idea it owns and the category default it refuses), palette with roles, type, the mark, motion character, and one honest risk.
5. Recommend one, and say what you borrowed from the other two.

## What to deliver for the chosen direction

- **Mark:** a symbol that works at 16 px (Windows taskbar and tab icon) and at 512 px. It should hint at both the sun and the line/timeline without being a clip-art sun. Show it on light and dark grounds, plus a one-colour version.
- **Wordmark:** "Solline" set or drawn, with the lockup rules (mark + wordmark, minimum sizes, clear space).
- **App icon:** Windows 11 style, at 256, 64, 32 and 16 px.
- **Palette:** colour roles for light and dark themes, written in OKLCH, with text contrast of at least 4.5:1 for body text. Include semantic colours the product already needs: success, danger, a review/risk amber, and three severity colours for review findings (bug, risk, noise) that stay distinct for colour-blind users.
- **Motion character:** three or four sentences on how the brand moves (it already uses a strong ease-out `cubic-bezier(0.23, 1, 0.32, 1)` for entrances and `cubic-bezier(0.77, 0, 0.175, 1)` for movement on screen, springs for anything dragged). Describe one signature moment, for example the timeline handle settling, or a turn becoming a checkpoint.
- **Voice:** five rules for UI copy, with three before/after examples. The product speaks European Portuguese first. Short, plain, no hype.
- **Agent crew:** five original hooded wizards, one per role: Claude, Codex, the reviewer (the second opinion), the ACP agents, and a neutral one for agents still to come. Each has its own colour from the palette and its own amulet glyph. Faces stay hidden in the hood; white gloves carry the gestures. Draw six poses, each tied to a state the app shows:
  - waiting: hands folded
  - working: pointing or presenting
  - done: thumbs up
  - needs you: arms crossed
  - permission or stop: hands raised
  - celebration (rare): a finger snap

  Add the shadow familiar in three moments: the first run, an empty project, and a merged pull request.

  Every pose must read at 24 px in the sidebar and at 96 px in the session header, in light and dark themes. Choose real pixel-level discipline or a clean vector rendition, and say why. Add a motion note: a short idle loop (breathing, a hood sway), pose changes as morphs under 300 ms, and a reduced-motion version.

- **Three applications:** the app's first-run screen, the session header with the timeline, and a social/OG image (1200×630) for the GitHub repo.

## Hard constraints

- The crew is the agent avatar system inside the app. It is never the app icon or the wordmark.
- Crew colours must stay distinct for colour-blind users and must not clash with the three severity colours.
- No gradient text, no glassmorphism for its own sake, no neon glow on near-black, no purple-to-blue "AI" gradient, no sparkles or brain icons, no robot or mascot as the main mark.
- Avoid these looks unless you can name a reason no other choice satisfies: cream paper with a high-contrast serif and a terracotta accent; broadsheet hairlines with tiny tracked mono labels; flat saturated ink with hard offset shadows.
- Avoid the default display faces models reach for (Fraunces, Playfair, Space Grotesk, Space Mono, IBM Plex, Inter as display, DM Sans/Serif, Syne, Outfit, Plus Jakarta Sans, Instrument Sans).
- Icons come from one consistent line family (the product uses Lucide), never emoji.
- The brand must stay quiet inside the working app: colour does jobs (state, selection, findings), not decoration. Delight is saved for rare moments: first run, a clean review, a pull request merged.
- Do not invent claims: no user counts, logos of customers, benchmarks or prices.

## Format of your answer

Start with the physical scene sentence and the seven candidates as a compact list. Then the three directions, one short block each. Then the full deliverables for the recommended one, with every colour value and size written out so an engineer can implement it without asking. End with the crew: one sprite sheet of the five wizards in the six poses, and one mock of the sidebar and the session header with the crew in place.
