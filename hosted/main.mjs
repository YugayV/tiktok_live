#!/usr/bin/env node
// Entry point of the hosted web version. Configuration: environment variables (hosted/README.md).

import Anthropic from '@anthropic-ai/sdk';
import { startHostedServer } from './server.mjs';
import { createMailer } from './mailer.mjs';

const env = process.env;
const num = (v) => (v === undefined || v === '' ? undefined : Number(v));

if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) {
  console.error('Задайте SESSION_SECRET — случайную строку не короче 32 символов (например: openssl rand -hex 32)');
  process.exit(1);
}

const app = startHostedServer({
  port: Number(env.PORT) || 8080,
  host: env.HOST || '0.0.0.0',
  dataDir: env.DATA_DIR || './web-data',
  serverSecret: env.SESSION_SECRET,
  anthropic: env.ANTHROPIC_API_KEY ? new Anthropic() : null,
  ai: { model: env.AI_MODEL, effort: env.AI_EFFORT, proMonthlyLimit: num(env.PRO_MONTHLY_LIMIT), trialLimit: num(env.TRIAL_LIMIT) },
  licenseConfig: { storeId: env.LS_STORE_ID, productId: env.LS_PRODUCT_ID, checkoutUrl: env.CHECKOUT_URL, priceLabel: env.PRICE_LABEL },
  signApiKey: env.SIGN_API_KEY || '',
  trustProxy: env.TRUST_PROXY === '1',
  secureCookies: env.SECURE_COOKIES === '1',
  allowSignup: env.ALLOW_SIGNUP !== '0',
  publicUrl: env.PUBLIC_URL || '',
  webhookSecret: env.LS_WEBHOOK_SECRET || '',
  google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
  mailer: createMailer({ apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM, devLog: env.MAIL_DEV_LOG === '1' }),
});

app.ready.then(() => app.tenants.autostart()).catch((err) => {
  console.error(`Не удалось запустить: ${err.message}`);
  process.exit(1);
});

async function stop() {
  await app.close();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
