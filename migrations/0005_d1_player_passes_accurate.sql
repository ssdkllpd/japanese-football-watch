CREATE TABLE fixture_player_stats_v5 (
  player_appearance_id INTEGER PRIMARY KEY REFERENCES fixture_player_appearances(id) ON DELETE CASCADE,
  minutes INTEGER CHECK (minutes IS NULL OR minutes >= 0),
  provider_rating REAL CHECK (provider_rating IS NULL OR (provider_rating >= 0 AND provider_rating <= 10)),
  goals INTEGER CHECK (goals IS NULL OR goals >= 0),
  assists INTEGER CHECK (assists IS NULL OR assists >= 0),
  goals_conceded INTEGER CHECK (goals_conceded IS NULL OR goals_conceded >= 0),
  saves INTEGER CHECK (saves IS NULL OR saves >= 0),
  shots INTEGER CHECK (shots IS NULL OR shots >= 0),
  shots_on_target INTEGER CHECK (shots_on_target IS NULL OR shots_on_target >= 0),
  passes INTEGER CHECK (passes IS NULL OR passes >= 0),
  key_passes INTEGER CHECK (key_passes IS NULL OR key_passes >= 0),
  passes_accurate INTEGER CHECK (
    passes_accurate IS NULL OR (
      typeof(passes_accurate) = 'integer'
      AND passes_accurate >= 0
      AND (passes IS NULL OR passes_accurate <= passes)
    )
  ),
  tackles INTEGER CHECK (tackles IS NULL OR tackles >= 0),
  blocks INTEGER CHECK (blocks IS NULL OR blocks >= 0),
  interceptions INTEGER CHECK (interceptions IS NULL OR interceptions >= 0),
  duels INTEGER CHECK (duels IS NULL OR duels >= 0),
  duels_won INTEGER CHECK (duels_won IS NULL OR duels_won >= 0),
  dribble_attempts INTEGER CHECK (dribble_attempts IS NULL OR dribble_attempts >= 0),
  dribbles INTEGER CHECK (dribbles IS NULL OR dribbles >= 0),
  dribbled_past INTEGER CHECK (dribbled_past IS NULL OR dribbled_past >= 0),
  fouls_drawn INTEGER CHECK (fouls_drawn IS NULL OR fouls_drawn >= 0),
  fouls_committed INTEGER CHECK (fouls_committed IS NULL OR fouls_committed >= 0),
  yellow_cards INTEGER CHECK (yellow_cards IS NULL OR yellow_cards >= 0),
  red_cards INTEGER CHECK (red_cards IS NULL OR red_cards >= 0),
  penalties_won INTEGER CHECK (penalties_won IS NULL OR penalties_won >= 0),
  penalties_conceded INTEGER CHECK (penalties_conceded IS NULL OR penalties_conceded >= 0),
  penalties_scored INTEGER CHECK (penalties_scored IS NULL OR penalties_scored >= 0),
  penalties_missed INTEGER CHECK (penalties_missed IS NULL OR penalties_missed >= 0),
  penalties_saved INTEGER CHECK (penalties_saved IS NULL OR penalties_saved >= 0),
  extra_stats_json TEXT CHECK (extra_stats_json IS NULL OR json_valid(extra_stats_json))
);

INSERT INTO fixture_player_stats_v5 (
  player_appearance_id, minutes, provider_rating, goals, assists, goals_conceded,
  saves, shots, shots_on_target, passes, key_passes, passes_accurate, tackles,
  blocks, interceptions, duels, duels_won, dribble_attempts, dribbles,
  dribbled_past, fouls_drawn, fouls_committed, yellow_cards, red_cards,
  penalties_won, penalties_conceded, penalties_scored, penalties_missed,
  penalties_saved, extra_stats_json
)
SELECT
  player_appearance_id, minutes, provider_rating, goals, assists, goals_conceded,
  saves, shots, shots_on_target, passes, key_passes, pass_accuracy, tackles,
  blocks, interceptions, duels, duels_won, dribble_attempts, dribbles,
  dribbled_past, fouls_drawn, fouls_committed, yellow_cards, red_cards,
  penalties_won, penalties_conceded, penalties_scored, penalties_missed,
  penalties_saved, extra_stats_json
FROM fixture_player_stats;

DROP TABLE fixture_player_stats;
ALTER TABLE fixture_player_stats_v5 RENAME TO fixture_player_stats;
