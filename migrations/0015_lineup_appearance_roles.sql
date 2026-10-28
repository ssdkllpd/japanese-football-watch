-- Repair the former inversion of games.substitute, which marked unused bench
-- players as starters. Match each appearance to its own revision and team.
-- Keep raw provider artifacts; lineup membership is the canonical role evidence.
WITH corrected AS (
  SELECT appearance.id,
    CASE
      WHEN entry.squad_role = 'starter' THEN 'started'
      WHEN entry.squad_role IS NULL THEN 'unknown'
      WHEN EXISTS (
        SELECT 1 FROM field_states state
        JOIN players player ON player.id = record.player_id
        WHERE state.fixture_revision_id = appearance.fixture_revision_id
          AND state.fact_kind = 'player_stat' AND state.fact_key = player.canonical_id
          AND state.field_path = 'minutes' AND state.presence <> 'present'
      ) THEN 'unknown'
      WHEN appearance.minutes > 0 THEN 'substitute_used'
      WHEN appearance.minutes = 0 THEN 'bench_unused'
      ELSE 'unknown'
    END AS appearance_state
  FROM fixture_player_appearances appearance
  JOIN fixture_player_records record ON record.id = appearance.player_record_id
  JOIN fixture_lineups lineup ON lineup.fixture_revision_id = appearance.fixture_revision_id
    AND lineup.team_id = record.team_id
  LEFT JOIN fixture_lineup_entries entry ON entry.player_appearance_id = appearance.id
    AND entry.lineup_id = lineup.id
)
UPDATE fixture_player_appearances
SET appearance_state = (SELECT corrected.appearance_state FROM corrected WHERE corrected.id = fixture_player_appearances.id)
WHERE id IN (SELECT corrected.id FROM corrected
  WHERE corrected.appearance_state <> fixture_player_appearances.appearance_state);
