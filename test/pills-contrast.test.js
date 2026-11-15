'use strict';
// axe on / (browser check, 11-15): the schedule pills. White on a theme's live red (#ef4444) is 3.8:1, so the live
// pill's red is a fifth darker; the off and done pills' grey leans toward the text colour.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'today.css'), 'utf8');
assert.match(css, /\.td-pill\.is-live \{[^}]*background: color-mix\(in srgb, var\(--live-red, #e11d48\), #000 20%\);/);
assert.match(css, /\.td-pill\.is-off \{[^}]*color: color-mix\(in srgb, var\(--text-secondary, #96a7c2\) 65%, var\(--text-primary, #e6edf7\)\);/);
assert.match(css, /\.td-pill\.is-done \{[^}]*color: color-mix\(in srgb, var\(--text-secondary, #9aa7bd\) 65%, var\(--text-primary, #e6edf7\)\);/);
console.log('today pills contrast: the live pill is a darker red, the quiet pills lean toward the text');
