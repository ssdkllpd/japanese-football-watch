# JFW Rating v1.0: current match-detail integration

The current app loads `jfw-rating.js` and `jfw-fixture-rating.js` before
`app-v2.js`. The existing v1.0 formula and weights are unchanged.

The adapter calculates ratings from the saved canonical fixture detail each
time the ratings view is rendered. It makes no provider requests, changes no
source statistics, and does not write ratings to D1/R2. This allows already
stored matches to be evaluated without refetching them. Persisting generated
ratings and adding season aggregates remain separate work.

Every player in the acquired match-statistics rows is evaluated, regardless of
nationality, Japanese-player tracking periods or attention-ranking eligibility.
Missing nationality does not block a rating. Existing final-match, position
and required-statistics checks still apply, with missing inputs explained in
the breakdown. This does not change which fixtures the acquisition jobs fetch.

The rating screen shows the v1.0 purpose, score, position, data coverage,
confidence, raw performance contributions, coverage/minute coefficients,
disciplinary deductions, missing inputs and source retrieval time. A missing
required input is explained in the same breakdown view. Scores across
positions are explicitly not comparable.

Input rules:

- Numeric zero is retained; null, absent and explicitly unavailable metrics
  remain missing. Optional unsupported metrics are not filled in.
- Missing goals, assists and own goals can be resolved from final goal events
  only when the event counts match both teams' final score. Unknown goal
  details, unresolved goal VAR events, missing identities and shootout
  ambiguity prevent this derivation. Conflicts become missing inputs.
- Explicit zero red cards establishes zero dismissals. Positive red-card
  totals require matching dismissal events to split straight reds from
  second yellows. Conflicting zero red-card totals do not override events.
- Missing PK concessions are never inferred from a lack of penalty events.
- DF/GK on-pitch conceded goals require a verified appearance interval,
  consistent minutes and complete final goal evidence. Same-minute ambiguity
  follows ops-v1.0 and is flagged. Team goals conceded do not substitute for
  an unknown interval. Shots on target faced are not invented from goals.
- The live score is not presented as a final JFW rating.

The legacy page keeps its existing backfill behavior. The current app uses the
engine without starting the legacy backfill loader.
