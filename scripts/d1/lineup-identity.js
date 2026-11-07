'use strict';

const { stableStringify } = require('./fixed-snapshot');

// The provider's canonical ID identifies one player. Preserve the original R2
// document; only its canonical view coalesces repeated entries in the same role.
// A conflicting shirt number becomes unknown rather than choosing either value.
function reconcileDuplicateLineupEntries(bundle) {
  const next=structuredClone(bundle),report=[];
  // An indexed manual correction must be reconciled explicitly before changing
  // array positions. Never silently retarget an existing correction.
  if(Object.keys(next.overrides||{}).some(path=>path.startsWith('lineups.')))return {bundle:next,report};
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
