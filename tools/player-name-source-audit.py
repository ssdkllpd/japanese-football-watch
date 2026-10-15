"""Inspect pinned, already acquired player responses without extracting or changing them."""
import hashlib
import json
from pathlib import Path
import re
import sys
import tarfile
from collections import Counter, defaultdict

archive, evidence_file, output = map(Path, sys.argv[1:])
evidence = json.loads(evidence_file.read_text())
digest = hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest()
assert digest == evidence['archiveSha256'], 'Pinned archive hash mismatch'
counts = Counter()
leagues = defaultdict(Counter)
parts = defaultdict(set)
all_ids = set()
with_parts = set()
field_keys = Counter()
rows = []
page_count = 0

def text(value):
    return value.strip() if isinstance(value, str) else ''

def normalized(value):
    return ' '.join(value.split()).casefold()

with tarfile.open(archive, 'r:gz') as source:
    for member in source:
        match = re.search(r'(?:^|/)league-(\d+)/players/page-(\d+)\.json$', member.name)
        if not match:
            continue
        assert member.isfile() and 0 < member.size < 50_000_000, 'Unexpected player source entry'
        payload = json.load(source.extractfile(member))
        assert isinstance(payload.get('response'), list)
        league = match[1]
        page_count += 1
        for row in payload['response']:
            player = row['player']
            player_id = player['id']
            name, first, last = (text(player.get(key)) for key in ('name', 'firstname', 'lastname'))
            field_keys.update(player.keys())
            all_ids.add(player_id)
            checks = {
                'rows': True,
                'withName': bool(name),
                'withFirstname': bool(first),
                'withLastname': bool(last),
                'withBothNameParts': bool(first and last),
                'withoutBothNameParts': not (first and last),
                'providerNameEqualsJoinedParts': bool(first and last) and normalized(name) == normalized(first + ' ' + last),
                'providerNameDiffersFromJoinedParts': bool(first and last) and normalized(name) != normalized(first + ' ' + last),
                'singleWordProviderName': len(name.split()) == 1,
                'multipleWordLastname': len(last.split()) > 1,
                'initialledProviderName': bool(re.match(r'^\S\.\s', name)),
            }
            for key, present in checks.items():
                counts[key] += int(present)
                leagues[league][key] += int(present)
            if first and last:
                with_parts.add(player_id)
                parts[player_id].add((first, last))
            rows.append({'playerId': player_id, 'leagueId': int(league), 'name': name,
                         'firstname': first or None, 'lastname': last or None, 'source': member.name})

assert page_count and len(leagues) == 10, 'Expected the ten-league player snapshot'
report = {
    'snapshotId': evidence['snapshotId'], 'archiveKey': evidence['archiveKey'],
    'archiveSha256': digest, 'playerPagesRead': page_count, 'leagueCount': len(leagues),
    'counts': dict(counts), 'uniquePlayers': len(all_ids),
    'uniquePlayersWithBothNameParts': len(with_parts),
    'uniquePlayersWithoutBothNameParts': len(all_ids - with_parts),
    'conflictingNamePartsByPlayerId': {str(key): sorted(value) for key, value in parts.items() if len(value) > 1},
    'sourcePlayerFieldKeys': dict(field_keys),
    'perLeague': dict(leagues),
    'samples': [row for row in rows if any(word in row['name'].casefold() for word in
                ['declan rice', 'kai havertz', 'lewis-skelly', 'van dijk', 'ao tanaka', 'raphinha', 'magalh'])][:35],
    'players': rows,
    'apiFootballRequests': 0, 'remoteWrites': 0,
}
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({key: value for key, value in report.items() if key not in ['players', 'perLeague']}, ensure_ascii=False))
