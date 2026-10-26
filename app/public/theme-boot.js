// Apply the stored/system theme before mount so there is no flash of the
// wrong palette. Mirrors src/lib/theme.ts (key "piquette-theme", body.board).
// A file, not an inline script, so the shell's CSP can stay script-src 'self'.
var t = null;
try {
  t = localStorage.getItem('piquette-theme');
} catch {}
try {
  var dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  if (dark) document.body.classList.add('board');
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
} catch {}
