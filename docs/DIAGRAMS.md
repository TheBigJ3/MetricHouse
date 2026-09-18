# Diagram briefs

Thirteen diagrams appear across the site. Every one currently has a plain
placeholder SVG in `public/diagrams/`, generated so nothing on the site is
broken while the real versions are made.

**To replace one:** save the finished file over the placeholder, keeping the same
filename. Nothing else changes.

## Specification for every diagram

| Property | Value |
| --- | --- |
| Format | SVG preferred. PNG at 1800px wide also works |
| Canvas | 900 x variable, roughly 3:1 to 3:2 |
| Background | The diagram carries its own pale panel, so it reads on a white page and on a dark one. Rounded corners, about 14px |
| Text | Minimum 12px at the 900px canvas size. System sans serif |
| Colour meaning | Green means the reader owns it. Blue means MetricHouse owns it. Amber means something in progress or at risk. White means neutral |
| Palette | Blue `#5b86f7` on `#e9effd`. Green `#57ab8a` on `#eaf6f0`. Amber `#d99b4e` on `#fdf1e3`. Neutral `#c6d0e0` on `#ffffff`. Panel `#f7f9fc`. Text `#1f2a37`, muted text `#64748b` |
| Arrows | Thin, `#94a3b8`, with a small solid triangle head |
| Accessibility | Never rely on colour alone. Every group also carries a label |

Captions live on the page, underneath the image, so the artwork does not need
to carry them. Each section below lists the captions the image sits under, so
the visual and the words agree.

The placeholders do carry a caption inside the image. The real versions should
not.

---

## 1. pipeline.svg

**Used on:** How it works, What MetricHouse is, the home page.
**Captions on the page** (do not repeat these inside the image):

- How it works: "Green is code you wrote. Blue is MetricHouse."
- What MetricHouse is: "Green is yours. Blue is MetricHouse. The boundary is the write function."
- the home page: "Your code adds to a metric. MetricHouse keeps the running totals and hands them to the function you wrote."

**Size:** 900 x 260.

Five boxes left to right, joined by arrows.

1. `Your code` with the subtitle `hits.add()` in monospace. **Green.**
2. `MetricHouse` with the subtitle `counts and keeps`. **Blue.**
3. `Driver` with the subtitle `memory or Redis`. **Blue.**
4. `Your write()` with the subtitle `you wrote this`. **Green.**
5. Below box 4, joined by a downward arrow: `Your database`. **Green.**

A small legend at the bottom: a green swatch labelled "you own this", a blue
swatch labelled "MetricHouse owns this".

The point the image has to make: the green boxes are at both ends, and the
boundary is the write function.

---

## 2. two-storage-models.svg

**Used on:** How it works, Choosing a metric type.
**Captions on the page** (do not repeat these inside the image):

- How it works: "Counters, gauges and timers fold. Events and logs stay whole."
- Choosing a metric type: "The split that explains most of the behaviour you will meet."

**Size:** 900 x 300.

Two rows, separated by a thin divider.

**Top row, headed `Folded · counter, gauge, timer`:**
Three small white boxes reading `+1`, `+1`, `+3`, an arrow labelled `add up`,
then one blue box reading `one number: 5` with the subtitle `per time window`.
To the right, two lines of muted text: "Three writes become one row." and "Memory
stays flat as traffic grows."

**Bottom row, headed `Kept whole · event, log`:**
Three small white boxes reading `row A`, `row B`, `row C`, an arrow labelled
`queue`, then one amber box reading `three rows` with the subtitle `in the order
they came`. To the right: "Nothing is merged, so every detail survives to the
database."

---

## 3. buckets-and-flush.svg

**Used on:** Buckets and time, How it works.
**Captions on the page** (do not repeat these inside the image):

- Buckets and time: "Five minutes of one second buckets arrive as 300 rows in one call."
- How it works: "Detail and shipping frequency are separate settings."

**Size:** 900 x 280.

A row of about 18 narrow vertical containers, each with a blue bar inside at a
different height, like a small bar chart. These are buckets filling.

Below them a horizontal time axis, labelled `one bucket = 1 second` at the left
and `time` at the right.

Below that, a dashed blue rounded rectangle spanning **all** the buckets, labelled
`one flush every 5 minutes carries all 300 closed buckets at once`.

The point the image has to make: the flush box spans everything, so a slower
cadence does not skip any bucket.

---

## 4. three-knobs.svg

**Used on:** Buckets and time.
**Captions on the page** (do not repeat these inside the image):

- Buckets and time: "These are independent. Changing one does not change the others."

**Size:** 900 x 230.

Three equal boxes side by side, each with a title and two subtitles.

1. `resolution` / "how wide one bucket is" / "set on the metric". **Blue.**
2. `flush` / "the fastest it may ship" / "set on the metric". **Blue.**
3. `start() or flush()` / "what actually asks it to" / "you call this". **Green.**

Deliberately no arrows between them. The point is that they are independent.

---

## 5. claim-ack-release.svg

**Used on:** Flushing, How it works, Reliability.
**Captions on the page** (do not repeat these inside the image):

- Flushing: "Four steps, in this order, every time."
- How it works: "Claim, write, then either delete or put back."
- Reliability: "Nothing is deleted until your function returns."

**Size:** 900 x 280.

A flow that branches.

- `1. Claim` / "data set aside". **Blue.**
- arrow to `2. Your write()` / "rows handed over". **Green.**
- Two arrows out of box 2:
  - Upper, labelled `it worked`, to `3a. Acknowledge` / "data deleted". **Blue.**
  - Lower, labelled `it threw`, to `3b. Release` / "data goes back". **Amber.**
- A dashed line from `3b` looping back round to the input of `1. Claim`, labelled
  `the same rows, with the same ids, come back on the next flush`.

The loop back is the most important element. It should read clearly as a cycle.

---

## 6. dimensions-to-series.svg

**Used on:** How it works, Metrics and dimensions.
**Captions on the page** (do not repeat these inside the image):

- How it works: "Three dimensions with a few values each produce a handful of rows per bucket."
- Metrics and dimensions: "Each distinct combination of values you write becomes one row per bucket."

**Size:** 900 x 290.

Three boxes left to right, joined by arrows.

1. `dims` with three monospace lines: `dogName: str()`, `park: str()`,
   `kind: oneOf([...])`. **Blue.**
2. `series key` with three monospace lines: `Willow|riverside|solid`,
   `Willow|riverside|liquid`, `Rex|central|solid`. **White.**
3. `one row each` with `per bucket`, then monospace `id, bucket_ts, dims, value`.
   **Green.**

If there is room, showing the three series keys fanning out from the single dims
box, rather than one arrow, would make the multiplication clearer.

---

## 7. open-vs-closed-bucket.svg

**Used on:** Reading live data.
**Captions on the page** (do not repeat these inside the image):

- Reading live data: "A live read returns the finished windows unless you ask for the open one."

**Size:** 900 x 260.

Five boxes in a row.

- The first four are solid blue, each showing a number: `12`, `31`, `18`, `27`,
  with `finished` underneath.
- The fifth has a **dashed amber border** and is only about 40 percent filled with
  amber from the left. It reads `40% full` with `still filling` underneath.

Below the first four, a label: `a live read returns these four`.

The fifth box being visibly part filled is the whole message.

---

## 8. delivery-modes.svg

**Used on:** Delivery modes.
**Captions on the page** (do not repeat these inside the image):

- Delivery modes: "Staged waits for a flush. Immediate does not."

**Size:** 900 x 260.

Two rows.

**Top, headed `delivery: 'staged'  (the default)`:**
`add()` (green, monospace) to `held in the driver` (blue), arrow labelled
`flush()`, to `your write()` (green). To the right, muted text: "one row per
bucket".

**Bottom, headed `delivery: 'immediate'`:**
The same three boxes, but the second arrow is labelled `at once`. To the right,
muted text over two lines: "the same row is resent" / "with a bigger running
total".

The two rows should be visually parallel, so the single difference stands out.

---

## 9. grace-period.svg

**Used on:** Buckets and time.
**Captions on the page** (do not repeat these inside the image):

- Buckets and time: "Grace covers work that started inside the window and finishes just after it."

**Size:** 900 x 240.

A horizontal timeline in three segments.

1. A solid blue segment labelled `bucket  10:00:06 to 10:00:07`.
2. A dashed amber segment labelled `grace 2s`.
3. A white segment labelled `now claimable by a flush`.

An arrow coming down from above the grace segment and pointing back into segment
1, with the text `a request that started at 10:00:06.9 still lands in the right
bucket`.

---

## 10. gauge-fold.svg

**Used on:** gauge.
**Captions on the page** (do not repeat these inside the image):

- gauge: "Four observations, five stored numbers, no average."

**Size:** 900 x 250.

Left: four small white boxes with monospace values `1284`, `1301`, `1297`, `1266`.

An arrow labelled `fold`.

Right: five small blue boxes, each with a label above a monospace value:
`last 1266`, `min 1266`, `max 1301`, `sum 5148`, `count 4`.

Below, one line of muted text: "average is sum divided by count, so it is one line
of SQL rather than a stored column".

---

## 11. runtime-pumping.svg

**Used on:** How it works, Deployment targets.
**Captions on the page** (do not repeat these inside the image):

- How it works: "Two shapes, depending on whether your process stays alive."
- Deployment targets: "Two shapes, depending on whether your process stays alive."

**Size:** 900 x 280.

Two rows of three boxes.

**Top, headed `A server that stays running`:**
`house.start()` / "one timer per metric" (green) to `ships on its own` (blue) to
`house.stop() on shutdown` / "drains and ships the rest" (green).

**Bottom, headed `Serverless or edge, where the process freezes`:**
`a cron or a handler` / "every 10 seconds" (green) to `house.flush()` (blue) to
`await house.drain()` / "before the response returns" (green).

---

## 12. metric-anatomy.svg

**Used on:** Getting started.
**Captions on the page** (do not repeat these inside the image):

- Getting started: "Every setting on a metric, and what each one decides."

**Size:** 900 x 300.

Left: a white code panel showing this, in monospace, syntax coloured if you like:

```
counter('dogs_walked', {
  dims: { walker: str(), park: str() },
  resolution: '1m',
  flush: '5m',
  write: async (rows) => db.insert(rows),
})
```

Right: five short arrows pointing at the corresponding line, each with a label:

| Line | Label |
| --- | --- |
| `counter('dogs_walked'` | the name your table and your queries use |
| `dims:` | the labels you want to break the number down by |
| `resolution:` | how much detail to keep: one row per minute |
| `flush:` | the fastest this metric may ship |
| `write:` | the function that puts rows in your database |

The arrows must line up with the right lines. This is the one diagram where
alignment matters more than styling.

---

## 13. raw-vs-bucketed.svg

**Used on:** Buckets and time.
**Captions on the page** (do not repeat these inside the image):

- Buckets and time: "The left column is what happened. The right column is what you need to store to answer the question."

**Size:** 900 x 344.

The single most important diagram on the site, because it is the one that
explains why the library exists. Two panels side by side, joined by an arrow.

**Left panel, headed `one row per request`. Amber.**
A tall stack of about nine thin rows, each a monospace line of the form
`14:03:07.221  /checkout  2xx`. Under the stack, in muted text:
`and 172,799,991 more`. Under the panel, in bold: `172,800,000 rows a day`, then
in muted text: `about 35 GB, read in full to answer one question`.

**The arrow**, labelled over two lines: `added up` / `as they arrive`.

**Right panel, headed `one row per minute`. Blue.**
A small table with a header row reading `bucket_ts`, `route`, `status`, `value`,
then four data rows:

```
14:03:00   /checkout   2xx   1841
14:03:00   /checkout   5xx      3
14:03:00   /search     2xx    622
14:04:00   /checkout   2xx   1903
```

`value` is right aligned and bold. Under the panel, in bold:
`up to 230,400 rows a day`, then in muted text:
`about 14 MB, and the grouping is already done`.

The point the image has to make: the left panel should feel overwhelming and the
right panel should feel readable. The contrast in visual density is the argument.
If the left stack can fade out towards the bottom rather than stopping cleanly,
that helps.

---

## Two more worth having

Not referenced by any page yet. Add the image and the figure block together if
you want them.

### cardinality.svg

The cost of a bad dimension choice. Two panels side by side.

- **Left, green, headed `route: str()`:** a small grid of about 12 dots, labelled
  `12 series, about 100 rows a minute`.
- **Right, amber, headed `userId: str()`:** a dense field of hundreds of dots
  fading off the edge of the panel, labelled `100,000 series, about 600,000 rows a
  minute`.

The difference in density is the whole message. Would go on Metrics and
dimensions.

### choosing.svg

A decision tree for picking a metric type. One question per node, ending on one of
the five names.

```
Are you tallying occurrences?              -> counter
Are you sampling a value?                  -> gauge
Are you measuring how long something took? -> timer
Do you need per item detail?               -> event
Is it an application message with severity? -> log
```

Would go at the top of Choosing a metric type.
