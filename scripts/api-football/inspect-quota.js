'use strict';
const {createClientFromEnv}=require('./client');
async function main(){
  const result=await createClientFromEnv(process.env).get('status');
  const response=result.data?.response||{};
  console.log(JSON.stringify({observedAt:new Date().toISOString(),
    subscription:{plan:response.subscription?.plan??null,active:response.subscription?.active??null,end:response.subscription?.end??null},
    requests:response.requests??null,headers:result.quota},null,2));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
