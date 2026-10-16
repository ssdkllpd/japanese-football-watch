#!/usr/bin/env node
// Report credential shape and GitHub's authentication verdict, never the value.
const raw = process.env.WORKFLOW_DISPATCH_TOKEN || '';
const token = raw.trim();
const result = {
  scope: process.env.CREDENTIAL_SCOPE,
  configured: Boolean(raw),
  type: token.startsWith('github_pat_') ? 'fine-grained' : token.startsWith('ghp_') ? 'classic' : 'unrecognized',
  outerWhitespace: raw !== token,
  internalWhitespace: /\s/.test(token),
  placeholderCharacters: /\.{3}|…|[<>]/.test(token),
  plausibleFormat: /^(github_pat_|ghp_)[A-Za-z0-9_]+$/.test(token) && token.length >= 40,
};
if (token && result.plausibleFormat) {
  try {
    const response = await fetch('https://api.github.com/repos/ssdkllpd/japanese-football-watch/actions/workflows?per_page=100', {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json',
        'x-github-api-version': '2026-03-10', 'user-agent': 'jfw-credential-check' },
      redirect: 'error', signal: AbortSignal.timeout(20000),
    });
    result.httpStatus = response.status;
    result.authenticated = response.ok;
    // Only emit known fixed messages. Never print arbitrary response or headers.
    const body = await response.json().catch(() => null);
    if (['Bad credentials', 'Requires authentication', 'Resource not accessible by personal access token'].includes(body?.message)) {
      result.message = body.message;
    }
  } catch {
    result.networkError = true;
  }
}
console.log(JSON.stringify(result));
