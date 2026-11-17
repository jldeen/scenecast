// Secret scan: fails on any token, key, signed URL or script left in a folder (a demo folder before it's pushed, or
// the kit itself). Text files only; images and fonts are skipped, node_modules and .git too.
//   node checks/secrets.mjs <dir> [<dir> …] [--json]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const RULES = [
  ['JWT', /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}/g],
  ['signed token (payload.signature)', /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g],
  ['bearer token', /Bearer\s+[A-Za-z0-9._~+/-]{24,}/g],
  ['GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['OpenAI-style key', /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/g],
  ['Azure account key', /AccountKey=[A-Za-z0-9+/=]{40,}/g],
  ['private key', new RegExp('-----BEGIN ' + '(RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----', 'g')],
  ['signed URL parameter', /[?&;](access_token|id_token|refresh_token|token|sig|signature|skypetoken|authorization|auth|client_secret|code|session_state|client_info|skoid|sktid|ske|sks|skv)=[A-Za-z0-9%._~+/=-]{16,}/gi],
  ['password in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:[^\s:/@"']{6,}@/gi],
];
const SKIP_DIRS = new Set(['node_modules', '.git']);
const BINARY = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp4', '.mov', '.wav', '.mp3', '.zip', '.pdf', '.bin']);

export function scan(dirs) {
  const findings = [];
  const walk = (root, dir) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      let st; try { st = statSync(p); } catch (e) { continue; }
      if (st.isDirectory()) { if (!SKIP_DIRS.has(f)) walk(root, p); continue; }
      if (BINARY.has(extname(f).toLowerCase()) || st.size > 64 * 1024 * 1024) continue;
      const text = readFileSync(p).toString('latin1');
      const rel = relative(root, p);
      for (const [name, re] of RULES) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text))) {
          const line = text.slice(0, m.index).split('\n').length;
          findings.push({ file: rel, line, rule: name, preview: m[0].slice(0, 12) + '…' });
          if (findings.filter(x => x.file === rel).length > 20) break;
        }
      }
      // Captured pages and streamed frames must hold no scripts (the replica runs none of the real app's code).
      if (/(^|\/)data\/(snaps|streams)\//.test(rel) && /\.(html|json)$/.test(rel) && /<script[\s>]/i.test(text)) findings.push({ file: rel, line: 0, rule: 'script in a capture', preview: '<script' });
    }
  };
  for (const d of dirs) walk(d, d);
  return findings;
}

if (process.argv[1] && process.argv[1].endsWith('secrets.mjs')) {
  const args = process.argv.slice(2);
  const dirs = args.filter(a => !a.startsWith('--'));
  const findings = scan(dirs.length ? dirs : [process.cwd()]);
  if (args.includes('--json')) console.log(JSON.stringify(findings, null, 1));
  else if (!findings.length) console.log(`secret scan: clean (${dirs.join(', ') || process.cwd()})`);
  else { console.log(`secret scan: ${findings.length} finding(s)`); for (const f of findings.slice(0, 200)) console.log(`  ${f.file}:${f.line} ${f.rule} ${f.preview}`); }
  process.exit(findings.length ? 1 : 0);
}
