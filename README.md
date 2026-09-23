# Portfolio

A static personal site. No build step, no dependencies — just HTML, CSS and
one JavaScript file. Open `index.html` in a browser and it works.

## Files

| File | What it is |
|---|---|
| `index.html` | All the content. Every editable spot is marked `EDIT ME`. |
| `styles.css` | All the styling. Colours are at the top in `:root`. |
| `script.js` | Theme toggle, mobile menu, scroll animations, copy-email. |
| `404.html` | Shown when someone hits a bad URL. |
| `.nojekyll` | Tells GitHub Pages to serve files as-is. |

## Editing

Search `index.html` for `EDIT ME` — that marks everything you need to change:
name, bio, projects, skills, timeline, email, and social links.

To change the colours, edit the `:root` block at the top of `styles.css`.
There are two of them — one for light mode, one for dark. `--accent` is the
one that changes the site's character most.

Drop your CV in next to `index.html` as `resume.pdf` and the Résumé button works.

## Previewing locally

Just double-click `index.html`. If you want a proper local server:

    python -m http.server 8000

Then open <http://localhost:8000>.

## Deploying to GitHub Pages

1. On GitHub, create a **public** repo named exactly `yourusername.github.io`
   (substitute your real username). The name matters: it makes the site serve
   from the root URL, so relative paths like `styles.css` resolve correctly.

2. From this folder:

       git init
       git add .
       git commit -m "Initial portfolio"
       git branch -M main
       git remote add origin https://github.com/yourusername/yourusername.github.io.git
       git push -u origin main

3. In the repo: **Settings → Pages**. Under "Build and deployment", set
   Source to **Deploy from a branch**, branch `main`, folder `/ (root)`. Save.

4. Wait a minute or two, then visit `https://yourusername.github.io`.

Every later `git push` redeploys automatically.

### Custom domain (optional, recommended)

Buy a domain, then in **Settings → Pages → Custom domain** enter it and save.
At your registrar, add these DNS records:

- Four `A` records for the apex domain pointing to `185.199.108.153`,
  `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
- One `CNAME` record for `www` pointing to `yourusername.github.io`

Then tick **Enforce HTTPS** once the certificate is issued (can take an hour).

## Before you call it done

- [ ] Replaced every `EDIT ME` block
- [ ] All links go somewhere real (no leftover `href="#"`)
- [ ] `resume.pdf` added, or the Résumé button removed
- [ ] Checked it on a phone
- [ ] Updated the `og:url` meta tag to the live URL
