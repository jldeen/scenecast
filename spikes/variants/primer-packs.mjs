// Theme packs from a design system's published tokens instead of a capture: GitHub's Primer themes, from the
// @primer/primitives package (functional/themes/*.css). Each pack is made in a blank page carrying only that theme's
// CSS and markers, so it holds the theme-keyed rules and their resolved colours.
//   node spikes/variants/primer-packs.mjs <@primer/primitives package dir> <outDir>
import { readdirSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launch } from './lib.mjs';
import { serve } from './lib.mjs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const [pkg, out] = process.argv.slice(2);
const themesDir = join(pkg, 'dist/css/functional/themes');
mkdirSync(out, { recursive: true });
const blank = mkdtempSync(join(tmpdir(), 'sd-primer-'));
writeFileSync(join(blank, 'index.html'), '<!DOCTYPE html><html><head></head><body><main style="position:fixed;inset:0;background:var(--bgColor-default);color:var(--fgColor-default)">x</main></body></html>');
const srv = await serve({ '/': blank, '/__sd/': join(dirname(fileURLToPath(import.meta.url)), '../../packages/player/app') });
const browser = await launch();
const page = await browser.newPage();
const made = [];
for (const f of readdirSync(themesDir).filter(f => f.endsWith('.css')).sort()) {
  const key = f.replace(/\.css$/, '').replace(/-/g, '_');
  const mode = key.startsWith('dark') ? 'dark' : 'light';
  await page.goto(srv.url + '/index.html');
  const pack = await page.evaluate(async ([css, key, mode, src]) => {
    const sd = await import(src);
    const h = document.documentElement;
    h.setAttribute('data-color-mode', mode); h.setAttribute('data-light-theme', mode === 'light' ? key : 'light'); h.setAttribute('data-dark-theme', mode === 'dark' ? key : 'dark');
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const p = sd.extractThemePack(document, 'github (primer)');
    p.theme = key; p.source = '@primer/primitives';
    return p;
  }, [readFileSync(join(themesDir, f), 'utf8'), key, mode, srv.url + '/__sd/variants.js']);
  writeFileSync(join(out, `primer-${key}.json`), JSON.stringify(pack));
  made.push({ key, mode: pack.mode, rules: pack.css.length, colors: Object.keys(pack.colors).length });
}
console.log(JSON.stringify(made));
await browser.close(); srv.close();
