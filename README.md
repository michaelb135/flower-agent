# Tidy website

A web app for household tasks, quick requests, assignments, routines, meal planning and grocery preparation. The deployable site is in `web/`. Only the six reviewed runtime files are published; tests, screenshots and any saved user data are excluded.

## This change

Amazon UAE, Kibsons, Carrefour UAE and Waitrose UAE appear together at the top of Tools. Store pages make one attempt inside Tidy. If a page or security check fails, **This page is not working** stops it and shows a clear recovery message. **Open directly** and **Try inside Tidy again** require an explicit click; Tidy never automatically redirects, retries or reports a purchase completed.

This handles the failed-page experience. It cannot override Amazon's security checks or establish that Amazon login/checkout works inside another website. A phone may open a direct store link in its browser or the store's app.

## Deployment

The `Publish Tidy website` workflow tests and builds the site on pushes to `main`, then deploys to GitHub Pages. GitHub Pages must be enabled for this repository with **GitHub Actions** as its source. The workflow's normal repository token can deploy an enabled site; enabling Pages itself requires repository-owner access or a token with the relevant administration/Pages permissions. No secret values belong in this repository.

After a successful deployment, verify the returned live URL and its `build-info.json`: it must contain the expected commit and the hashes of the published files. Then open Tools, check the four store buttons and exercise the recovery controls. Do not describe a local build, a pushed commit or a saved environment draft as a published website.

The original `tidy-day-organiser.jocundridge128.chatgpt.site` hosting project is not connected to this repository. A GitHub Pages deployment would use a new address. Existing browser-saved data from the old hostname does not transfer automatically; older backup formats require a separately verified migration.

## Development checks

Run `node --test tests/core.test.cjs tests/assistant.test.cjs`. Serve `web/` with a local static server for internal browser checks, then run `python tests/qa-website.py`; its `TIDY_QA_URL` points to that internal server. Do not present an internal localhost address as the published app.

`tools/build_site.py --revision <commit> --output <empty-directory>` builds the deployable files. Use `unpublished` for a local build check.

## Current limits

Tasks and meals save only on the current browser. Family names are assignment labels, not authenticated shared accounts. Google/Microsoft sign-in, cloud sync, reliable closed-app iPhone reminders, retailer baskets/orders and automatic bookings/messages are not connected. In-page reminders need Tidy open. The full native source and service configuration are still required for the iPhone version.
