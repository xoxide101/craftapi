import { createGateway } from './app.mjs';
import { Store } from './store.mjs';

const mode = process.env.CRAFT_GATEWAY_MODE || 'single';
const port = Number(process.env.CRAFT_GATEWAY_PORT || 8787);
const host = process.env.CRAFT_GATEWAY_HOST || '127.0.0.1';
const { server } = createGateway({
  masterKey: process.env.CRAFT_MASTER_KEY,
  mode,
  allowSignup: process.env.CRAFT_ALLOW_SIGNUP === '1',
  upstreamAllow: process.env.CRAFT_UPSTREAM_ALLOW || '',
  store: new Store(process.env.CRAFT_GATEWAY_DATA || 'data/gateway.json'),
});
server.listen(port, host, () => console.log(`craft-api gateway (${mode}) on http://${host}:${port}/api/v1`));
