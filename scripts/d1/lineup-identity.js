'use strict';

// This normalization runs in public Workers as well as the Node importer.
function canonicalize(value) {
  if(Array.isArray(value))return value.map(canonicalize);
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalize(value[key])]));
}
const stableStringify=value=>JSON.stringify(canonicalize(value));

// Preserve the original R2 document and reconcile its canonical view. Named
// players can coalesce repeated entries in the same role.
// A conflicting shirt number becomes unknown rather than choosing either value.
function reconcileDuplicateLineupEntries(bundle) {
  const next=structuredClone(bundle),report=[];
  // An indexed manual correction must be reconciled explicitly before changing
  // array positions. Never silently retarget an existing correction.
  if(Object.keys(next.overrides||{}).some(path=>/^(lineups|events|playerStats)\./.test(path)))return {bundle:next,report};
  // "Trialist" is an unnamed registration slot, not a player identity. The
  // provider reuses its ID for different people, including both sides of a sub.
  // Keep the source evidence and the event, but never link that slot to a person.
  const placeholders=new Map();
  for(const lineup of next.lineups||[])for(const role of ['startXI','substitutes']) {
    for(const player of lineup[role]||[]) {
      if(!/^af:player:[1-9]\d*$/.test(player.id||'')||player.id!==`af:player:${player.providerId}`
        ||!/^(?:[A-Z]\.?\s*)?Trialist(?:\s+[A-Z]\.?)?$/i.test(player.name||''))continue;
      if(!placeholders.has(player.id))placeholders.set(player.id,[]);
      placeholders.get(player.id).push({teamId:lineup.teamId,listRole:role,...player});
    }
  }
  for(const [id,entries]of placeholders) {
    // Never discard a real named player sharing the provider's placeholder ID.
    const all=(next.lineups||[]).flatMap(l=>[...(l.startXI||[]),...(l.substitutes||[])]).filter(p=>p.id===id);
    if(all.length!==entries.length||(next.playerStats||[]).some(p=>p.playerId===id))continue;
    for(const lineup of next.lineups||[])for(const role of ['startXI','substitutes']) {
      if(!lineup[role]?.some(p=>p.id===id))continue;
      lineup[role]=lineup[role].filter(p=>p.id!==id);
      lineup.fieldStates={...lineup.fieldStates,[role]:{presence:'provider_missing'}};
    }
    let eventReferences=0;
    for(const event of next.events||[])for(const [key,nameKey]of [['playerId','playerName'],['relatedPlayerId','relatedPlayerName']]) {
      if(event[key]!==id)continue;
      event[key]=null;delete event[nameKey];eventReferences++;
    }
    report.push({playerId:id,sourceCount:entries.length,sourceEntries:entries,eventReferences,
      reason:'provider_unnamed_trialist_identity'});
  }
  for(const lineup of next.lineups||[])for(const role of ['startXI','substitutes']) {
    const rows=lineup[role];if(!Array.isArray(rows))continue;
    const groups=new Map();
    for(const player of rows){
      if(!/^af:player:[1-9]\d*$/.test(player.id||'')||player.id!==`af:player:${player.providerId}`)continue;
      if(!groups.has(player.id))groups.set(player.id,[]);
      groups.get(player.id).push(player);
    }
    const resolved=new Map();
    for(const [id,entries]of groups){
      if(entries.length<2)continue;
      const metadata=player=>{const {number,...rest}=player;return stableStringify(rest);};
      if(entries.some(player=>metadata(player)!==metadata(entries[0])))continue;
      const numbers=[...new Set(entries.map(player=>player.number))];
      const number=numbers.length===1?entries[0].number:null;
      resolved.set(id,{...entries[0],number});
      if(numbers.length>1){
        lineup.fieldStates={...lineup.fieldStates,[`${role}[${id}].number`]:{presence:'provider_missing'}};
      }
      report.push({teamId:lineup.teamId,role,playerId:id,sourceCount:entries.length,
        sourceNumbers:numbers,number,reason:'repeated_provider_player_identity'});
    }
    const emitted=new Set();
    lineup[role]=rows.flatMap(player=>{
      if(!resolved.has(player.id))return [player];
      if(emitted.has(player.id))return [];
      emitted.add(player.id);return [resolved.get(player.id)];
    });
  }
  return {bundle:next,report};
}

module.exports={reconcileDuplicateLineupEntries};
