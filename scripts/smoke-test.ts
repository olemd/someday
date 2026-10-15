// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Post-deploy smoke test: GET /api/health must answer 200 with the
 * deployed git SHA and no config_errors. Retries while the deploy propagates.
 */
export {};

const origin = process.env.PUBLIC_ORIGIN;
const sha = process.env.GIT_SHA;
if (!origin || !sha) {
  console.error('PUBLIC_ORIGIN and GIT_SHA must be set');
  process.exit(1);
}

let last = '';
for (let attempt = 1; attempt <= 12; attempt++) {
  try {
    const res = await fetch(`${origin}/api/health`, { headers: { 'cache-control': 'no-cache' } });
    const body = (await res.json()) as { git_sha?: string; config_errors?: string[] };
    last = `${res.status} ${JSON.stringify(body)}`;
    if (res.status === 200 && body.git_sha === sha) {
      if (body.config_errors?.length) {
        console.error(
          `Deployed, but configuration has errors:\n- ${body.config_errors.join('\n- ')}`,
        );
        process.exit(1);
      }
      console.log(`Smoke test OK: ${origin} runs ${sha}`);
      process.exit(0);
    }
  } catch (err) {
    last = String(err);
  }
  await Bun.sleep(5000);
}
console.error(`Smoke test failed after retries. Last response: ${last}`);
process.exit(1);
