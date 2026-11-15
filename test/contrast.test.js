'use strict';
// WCAG 2.1 AA: the done pill was muted text on a 14% muted wash (4.4:1 on dark). The text now uses the theme's
// secondary colour on the same wash.
//   node test/contrast.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'today.css'), 'utf8');
assert.ok(
    css.includes('.td-pill.is-done { background: color-mix(in srgb, var(--text-muted, #7386a3) 14%, transparent); color: color-mix(in srgb, var(--text-secondary, #9aa7bd) 65%, var(--text-primary, #e6edf7)); }'),
    'the done pill takes the secondary text colour, leaning toward the text colour (11-15), on its muted wash'
);
assert.ok(!css.includes('.td-pill.is-done { background: color-mix(in srgb, var(--text-muted, #7386a3) 14%, transparent); color: var(--text-muted, #7386a3); }'), 'the muted done text is gone');
console.log('contrast: the done pill reads on dark');
