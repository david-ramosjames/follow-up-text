# Drop the firm's logo here

Save it as **`logo.svg`** in this folder (a `logo.png` renamed to `.svg` will not
work — browsers go by content, not extension; if you only have a PNG, change the
`src` in `src/components/BrandBar.jsx` to `/logo.png` instead).

Use the **white** version. It sits on the navy band in the app header, which is
the same navy in light and dark mode precisely so one white file covers both.

Anything in this folder is copied to the root of the built site, so `logo.svg`
here is served at `/logo.svg`.

Until the file exists the header falls back to a typeset lockup — five gold
stars over "RAMOS JAMES LAW, PLLC". That is deliberate: the stars and the
wordmark can be set faithfully in type, but hand-tracing the shield monogram
would get the firm's own mark subtly wrong. Nothing else needs changing when you
add the file — the header switches to it on the next load.
