import { config } from 'dotenv';
import { listOpenAIModels } from '@scaleinsyght/model-gateway';

config({path:'.env'});
try{
  const models=await listOpenAIModels();
  process.stdout.write(`${models.join('\n')}\n`);
}catch(error){
  const code=error instanceof Error?error.message:'model_catalog_request_failed';
  process.stderr.write(`${code}\n`);
  process.exitCode=1;
}
