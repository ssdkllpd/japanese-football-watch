-- Lineup and statistics endpoints can report different positions for one player.
-- Preserve each source field instead of rejecting a whole fixture or choosing one.
ALTER TABLE fixture_lineup_entries ADD COLUMN position TEXT;

-- Existing revisions were required to have equal positions. Copy that proven
-- value once by the appearance primary key to retain their current public DTOs.
UPDATE fixture_lineup_entries AS entry
SET position = appearance.position
FROM fixture_player_appearances AS appearance
WHERE appearance.id = entry.player_appearance_id;
