# Activity collection

The User page places accumulated work above Activity history. Saving an embedded response or a standalone activity exposes a real **View activity log** link; `section=activity-history` selects that destination without replacing the reading fragment. Returning to notes restores the actual pane offsets, not an older heading anchor.

## Editable metadata

`reader/public/activity-catalog.js` separates subjects from formats. Edit `ACTIVITY_CATALOG` using stable vault IDs (including an embedded activity's heading), for example:

```js
'Movement': { subjectId: 'physical', formatId: 'practice' }
```

- `SUBJECTS` defines the five existing subject areas, their labels, stable note IDs, and colour keys. Change the palette in `activity-collection.css`.
- `ACTIVITY_FORMATS` defines reflection, writing, practice, and project. Defining a format does not create or classify an activity.
- Each record contributes once to its primary subject and format. The UI shows these two tags. Optional secondary subject metadata is not another count or another displayed badge.
- Unknown activities remain General / Unclassified. The introductory intention is explicitly General / Reflection. Response text, titles, evidence, review decisions, and reading time are never used to infer subjects or effort.
- Stable record IDs deduplicate repeated query results. Editing, reviewing, pinning, and importing the same saved response do not create additional pebbles.

Markdown still supplies the teaching content and activity prompts; this registry supplies presentation metadata only. Adding a subject requires reviewing the palette and legend as well as updating the registry.

## What the pile means

One activity contributes one equal-area pebble. The pile represents accumulation, not ability, effort, balance, completion, or scholarship merit. It has no target mix, percentages, scores, streaks, missing-subject warnings, or inferred weights. A project is not assigned a larger pebble without an explicitly authored future model.

`activity-collection.js` contains a small deterministic gravity/collision/friction simulation and an accessible DOM wrapper. Pebble size is fixed for a vessel width: adding records cannot make existing work shrink. A centered hexagonal mound seeds the simulation; the resulting placement is deterministic, bounded, and collision-tested. The decorative SVG is hidden from assistive technology; written subject and format counts expose the actual data.

Only 160 pebbles are drawn. The exact total and **+N more** remain visible above that cap. A stable ID-sorted subset prevents a pin or query reorder from changing the rendered selection. Overflow is recalculated from current data, never copied from cached totals.

Layouts are cached by account/browser scope, identity, metadata, and width, with explicit memory limits. Cached revisits do not replay the animation. Reduced-motion users receive the settled pile immediately; changing that preference also finishes an in-progress animation. Animation ends when settled or at its time limit, and disposal cancels frames and disconnects observers. No response text is retained in the geometry cache.

## Loading and planned features

The User outline renders before runtime configuration, authentication, or account data finishes. Skeletons are busy placeholders, not fabricated counts. Settings can render independently of account initialization. Navigation and account changes retain stale-render guards.

Public portfolio remains **Private**: **Make public** is disabled and marked **Coming soon**. The lower-page **Vitruvian scholarship** section describes intended enriching trips/shared experiences; **Learn more** is disabled and marked **Coming soon**. Neither feature publishes work, accepts applications, or introduces eligibility or selection rules. There are no backend/schema changes for either placeholder.

## Design sources and limits

- [ONS: Using colours in charts](https://service-manual.ons.gov.uk/data-visualisation/colours/using-colours-in-charts): keep categorical colour use limited and consistent, with sufficient contrast. The implementation uses five stable subject colours plus neutral unclassified work, accompanied by written labels and exact counts rather than relying on colour matching alone. These are design principles, not a claim of an ONS-approved palette.
- [W3C: Animation from Interactions](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions): nonessential movement should be avoidable, including through the operating system's reduced-motion preference. The pile has a static equivalent and no idle animation.

The physical collection is an interface metaphor, not a validated psychological measure or a claim about motivation. It should be evaluated with readers rather than presented as a research-proven intervention.

## Verification

Unit tests cover metadata, deduplication, deterministic geometry, constant area/size, collision bounds, settling, reduced-motion output, stable capped fingerprints, bounded cache, and section routing. Isolated headless Chrome tests cover guest/account/legacy save links, history focus, reading restoration, subpath/direct URLs, loading races, disabled actions, guest recovery without IndexedDB, mobile dark mode, cap totals, cache overflow updates, and animation idling. Production Supabase upload/review roundtrips remain a separate deployment verification task.
