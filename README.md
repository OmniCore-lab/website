# omnicore-lab.dev

Source of the [OmniCore Lab website](https://omnicore-lab.dev/).

Plain static files: HTML, two stylesheets, one short script. No framework and no build step. English at the root, Traditional Chinese under `/zh/`. Hosted on Cloudflare Pages.

## Run it locally

```
python -m http.server 8790 --directory site
```

Then open http://localhost:8790/.

## Layout

```
site/
├─ index.html, palmcore.html, about.html, contact.html, privacy.html, 404.html
├─ zh/              the same six pages in Traditional Chinese
├─ assets/          site.css (layout), app-theme.css (colour and glass), site.js
├─ orb/             the 3D PalmCore character, loaded into a same-origin iframe
├─ _headers         security headers for Cloudflare Pages
├─ robots.txt, sitemap.xml, llms.txt
```

## Notes

- **No cookies, analytics or forms.** The only third-party requests are Google Fonts.
- **Strict Content Security Policy.** See `site/_headers`. The character runs under its own policy because it needs WebAssembly to unpack the model.
- **The character is progressive.** The page shows a flat drawing first and swaps in the 3D version when the browser is idle. Without WebGL the drawing stays. It pauses when off screen and respects `prefers-reduced-motion`.
- **AI crawlers are welcome.** `robots.txt` allows them by name and `llms.txt` gives a plain-text summary.

## License

The code that lays out the site (HTML structure, CSS, `assets/site.js`) may be reused under the MIT license.

The text, the OmniCore Lab and PalmCore names and marks, and everything under `site/orb/` (the PalmCore character, its model, textures and animation) are © 2026 OmniCore Lab, all rights reserved. Third-party libraries under `site/orb/vendor/` keep their own licenses.
