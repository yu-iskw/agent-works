// Runs inside the `e2e` Compose service (scripts/ui/run.mjs seed-review). Signs in as a mock
// member through the same local-test form a browser uses and adds the starter team in each
// segment. Starter creation is idempotent server-side (stable client request ids), so rerunning is
// a no-op. Spends no model calls.
const base = process.env.M1_BASE_URL ?? 'http://web:8080';
const member = process.argv.find((arg) => arg.startsWith('--member='))?.slice('--member='.length);
if (!/^review[1-3]$/.test(member ?? '')) {
  process.stderr.write('usage: seed-review.mjs --member=<review1|review2|review3>\n');
  process.exit(2);
}
const email = `${member}@local.test`;
const segments = ['alpha', 'beta'];

function cookiesFrom(response) {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .filter((pair) => !pair.endsWith('='));
}

function csrfFrom(html) {
  const value = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  if (value === undefined) throw new Error('no csrf field on the page');
  return value;
}

async function post(path, form, cookie) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: base,
      cookie,
    },
    body: new URLSearchParams(form).toString(),
  });
}

const signInPage = await fetch(`${base}/sign-in`, { redirect: 'manual' });
const preCookie = cookiesFrom(signInPage).join('; ');
const signedIn = await post(
  '/auth/local-test',
  { csrf: csrfFrom(await signInPage.text()), email },
  preCookie,
);
const session = cookiesFrom(signedIn).join('; ');
if (signedIn.status !== 303 && signedIn.status !== 302) {
  throw new Error(`sign-in as ${email} returned ${signedIn.status}`);
}
if (session === '' || (signedIn.headers.get('location') ?? '').includes('error=')) {
  throw new Error(`sign-in as ${email} was refused: ${signedIn.headers.get('location')}`);
}

// Posted even when the member already has other teammates (tests leave some): the segment keys each
// starter teammate by a stable request id, so a teammate already there is not added twice.
const outcome = {};
for (const segment of segments) {
  const page = await fetch(`${base}/s/${segment}/teammates`, { headers: { cookie: session } });
  const created = await post(
    `/s/${segment}/teammates/starter`,
    { csrf: csrfFrom(await page.text()) },
    session,
  );
  if (created.status !== 303 && created.status !== 302) {
    throw new Error(`starter team for ${segment} returned ${created.status}`);
  }
  outcome[segment] = 'ensured';
}
process.stdout.write(`${JSON.stringify({ member: email, starterTeam: outcome, modelCalls: 0 })}\n`);
