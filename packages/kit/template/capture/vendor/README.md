# Styles that no capture has

A menu or popup can load its stylesheet only when it first opens (and some apps remove it when it closes). The
click audit (`scenecast record side clicks`) keeps every stylesheet a click brings in, and the build adds Griffel rules
from any other capture with the same classes. If a popup still comes out unstyled in the replica, put its rules in a
`.css` file here, one rule per line, and list it in `flow.overrides.mjs`:

```js
flow.clickPages.find(c => c.page === '<screen>').vendorCss = ['capture/vendor/<menu>.css'];
```

A rule is kept when every class it names is used by the clicked parts, and it's added last, so it wins. Say at the
top of the file where the rules came from: a library's published rules (with its license), or rules measured from
the real page's screenshot (the audit's `raw/hovers/click-<screen>/NNNN.png`).
