// Frozen acceptance — repo-3c6, new behavior (all R assertions must be RED at fork).
// Canonical brief, kickoff sha256:0d088d876ffc5025affc83722cdb25c67953e8fff1dad4e539f4e14b06bd4ae1.
// Bidirectional criterion map (guard.js contains the unchanged-behavior controls):
// C1 expired durable token actively refreshed before admission -> R1 (single and roster).
// C2 atomic owner-only durable write and recovery, no disclosure -> R2/R3; guard G2.
// C3 unusable refresh refused before mutation with bounded redacted readiness diagnostic -> R4.
// C4 exact OAuth host, no broader OAuth/wildcards/egress -> R5; guard G5.
// C5 positive refresh readiness/egress and existing negative controls -> R1/R6/R7; guard G3/G4.
// C6 exclusive owner, task handoff, verifier isolation, legacy providers -> guard G1/G2/G5/G6.
// C7 new acceptance suite only -> these two files, checked in author's Git diff.
// Every R/G assertion names its criterion; no planner draft is an authority here.
//
// SPEC CONFLICT (reported, not repaired): tests/acceptance/repo-djf.3/test.js
// asserts an exact three-host Codex allowlist. C4 requires the fourth host, while
// C7 and the kickoff forbid editing that existing frozen suite. The new R5 checks
// the canonical issue; the incompatible old assertion needs a host-owned resolution.
//
// SPEC CLARIFICATION: Squid is CONNECT-only TLS passthrough. C4's "endpoint" is
// enforceable as exact auth.openai.com:443, not a URL-path ACL without TLS interception.
// The kickoff explicitly constrains the concrete host. R5 tests the exact host roster;
// R6/R7 require the positive probe to visit /oauth/token, not just its site's home page.
// The criterion gives no diagnostic size: 4096 UTF-8 bytes is this suite's generous bound.
// No new refresh function name is prescribed: the transport replaces the existing
// runner process boundary in memory; readiness and persistence remain production code.
// Permission assertions observe chmod-before-rename on all hosts and real 0600 on POSIX.
// Windows Node chmod cannot prove Windows ACL exclusivity; the Linux verifier owns that proof.
// Docker and OAuth are simulated here; live pinned-CLI/proxy proof remains a host integration
// responsibility. Fixtures positively/negatively exercise production egress shell logic.
'use strict';
const fs = require('fs');
const path = require('path');
const { ROOT, ENDPOINT, session, readiness, egress, clean, check } = require('./guard');
const brief = r => `admitted=${r.result.ok}; refreshCalls=${r.calls.length}; events=${r.events.join(',')}; unsupportedProcesses=${r.unexpected.join(',') || 'none'}`;
const refreshed = r => r.calls.length > 0 && r.calls.every(c => c.restricted && c.locked);
const fresh = r => { try { const t = JSON.parse(r.after).tokens; return t.refresh_token.endsWith('-rotated') && JSON.parse(Buffer.from(t.access_token.split('.')[1], 'base64url')).exp > Date.now() / 1000; } catch { return false; } };
async function main() {
  for (const roster of [false, true]) {
    const r = await readiness({ roster });
    check(`C1 C5 R1 ${roster ? 'explicit roster' : 'single durable lane'} refreshes expired access through restricted private Codex before Beads admission`,
      r.result.ok && refreshed(r) && fresh(r)
      && r.events.indexOf('refresh') < r.events.indexOf('beads-mutation') && !r.unexpected.length, brief(r));
  }
  const success = await readiness();
  check('C2 R2 successful readiness atomically publishes rotated durable credentials owner-only without disclosure',
    success.result.ok && refreshed(success) && fresh(success) && success.atomic.length === 1
    && success.atomic.every(a => a.sameDirectory && a.oldIntact && a.protected && a.newFresh)
    && !success.events.includes('in-place-durable-write') && !success.recoverable
    && (process.platform === 'win32' || success.mode === 0o600)
    && clean(JSON.stringify(success.result)) && clean(success.diagnostic),
    `${brief(success)}; atomicReplacements=${success.atomic.length}`);
  const fault = await readiness({ fault: true });
  check('C2 C3 R3 readiness persistence failure refuses admission and preserves old cache plus recoverable refreshed copy',
    !fault.result.ok && refreshed(fault) && fault.atomic.length > 0 && fault.after === session(false)
    && fault.recoverable && !fault.events.includes('beads-mutation') && fault.targetAbsent
    && clean(fault.diagnostic), `${brief(fault)}; retainedCopy=${fault.recoverable}`);
  for (const outcome of ['denied', 'failed', 'timeout', 'malformed', 'expired', 'missing-access', 'missing-refresh']) {
    const r = await readiness({ outcome });
    check(`C3 R4 ${outcome} refresh fails closed before Beads/workspace/task with bounded redacted managed ChatGPT refresh readiness diagnostic`,
      !r.result.ok && refreshed(r) && !r.events.includes('beads-mutation') && r.targetAbsent
      && r.after === session(false) && /managed\s+chatgpt/i.test(r.diagnostic)
      && /refresh/i.test(r.diagnostic) && /readiness/i.test(r.diagnostic)
      && Buffer.byteLength(r.diagnostic) <= 4096 && clean(r.diagnostic)
      && clean(JSON.stringify(r.result)) && !r.unexpected.length, brief(r));
  }
  const domains = fs.readFileSync(path.join(ROOT, 'docker/proxy-codex/allowlist.txt'), 'utf8')
    .split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')).sort();
  const policy = fs.readFileSync(path.join(ROOT, 'docker/proxy-codex/squid.conf'), 'utf8')
    .split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  check('C4 R5 Codex allows exactly the refresh host plus existing hosts, CONNECT 443 only, deny all else',
    domains.join(',') === ['api.openai.com', 'chatgpt.com', 'ab.chatgpt.com', 'auth.openai.com'].sort().join(',')
    && policy.filter(s => s.startsWith('http_access ')).join('|') === 'http_access deny CONNECT !SSL_ports|http_access allow CONNECT allowed|http_access deny all'
    && policy.includes('acl SSL_ports port 443') && policy.includes('acl CONNECT method CONNECT')
    && policy.includes('acl allowed dstdomain "/etc/squid/allowlist.txt"'), `actual domains=${domains.join(',')}`);
  const healthy = egress();
  check('C5 R6 executable Codex egress gate positively probes OAuth token endpoint through the proxy',
    healthy.status === 0 && healthy.trace.some(p => p.url === ENDPOINT && !p.direct),
    `status=${healthy.status}; destinations=${healthy.trace.map(p => p.url).join(',')}`);
  const blocked = egress('refresh-down');
  check('C5 R7 OAuth unreachable refuses egress even when model endpoint is reachable',
    blocked.status !== 0 && blocked.trace.some(p => p.url === ENDPOINT && !p.direct)
    && blocked.trace.some(p => p.url === 'https://api.openai.com/'),
    `status=${blocked.status}; refreshProbed=${blocked.trace.some(p => p.url === ENDPOINT)}`);
}
main().catch(e => check('C1-C5 acceptance HARNESS BROKEN', false, String(e.stack)));
