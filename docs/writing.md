# Writing for the guide

Audience: high-school readers. These are illustrative notes, not a finished curriculum or clinical advice.

Keep the amount of text small, but use natural, complete sentences. A request for concise development updates is not a request to speak to students in slogans.

- Explain a concrete example before naming an abstraction.
- Ask questions that invite observation, not a correct emotional response.
- Respect uncertainty; do not promise that an exercise will improve someone's mental health.
- Avoid clipped imperatives, product vocabulary, fake reassurance, and motivational coaching.
- Keep an activity beside the idea that introduces it. A generic “Reflection” page adds an unnecessary detour.
- Never demand personal disclosure. Explain where saved writing goes and who can read it before submission.
- Markdown remains the source. Use `> [!activity] A specific question` for an embedded prompt; the reader supplies the response field.
- Use `> [!chart] A specific title` with a caption and an Our World in Data grapher link for a chart:

  ```md
  > [!chart] How long people live, on average
  > Period life expectancy is the number of years someone born in a given year would live if death rates stayed as they were then.
  > https://ourworldindata.org/grapher/life-expectancy
  ```

  The first line is the title, the link is the embed, and the other lines are the caption. Only `ourworldindata.org` and `archive.ourworldindata.org` grapher links are accepted; anything else stays inert text instead of a frame. Describe what the chart shows or what to look at, and never invent a number: the chart states its own data, and its title, subtitle and source are visible on Our World in Data.
- A chart is not fetched until the reader presses **Load chart**, so a note cannot contact another site on its own. Say so when a page collects several charts, as [[World data]] does.
- Linking notes supports exploration; it does not require a course sequence.

## Sources read for this pass

These inform general teaching techniques, not imitation of a creator's distinctive voice.

- [3Blue1Brown: The Essence of Calculus](https://www.3blue1brown.com/lessons/essence-of-calculus/) — an understandable concrete question leads to an explanation, with room to reason along.
- [Khan Academy: learning strategies transcript](https://www.khanacademy.org/transcript/xb259310239550296) — a specific experience explains a difficulty without talking down to the reader.
- [Khan Academy: What is stress? transcript](https://www.khanacademy.org/v/what-is-stress) — ordinary examples establish what a term means before introducing terminology. Read through a text proxy because direct extraction failed.
- [Andy Matuschak: Evergreen notes](https://notes.andymatuschak.org/Evergreen_notes) — connected, concept-oriented notes that can develop over time; not a mandate for abrupt prose.
