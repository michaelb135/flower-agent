# Tidy website

A web app for household tasks, quick requests, assignments, routines, meal planning and grocery preparation. The deployable site is in `web/`. Only the six reviewed runtime files are published; tests, screenshots and any saved user data are excluded.

## This change

The app audit fixes meal choices disappearing after preference edits, stale meal data returning after a reset, incorrect reminder interpretation, stopped routines restarting, extreme reminder timestamps breaking imported data, and stale tabs replacing newer edits. Meals keep pending preference edits for review; reminders ask when a requested time cannot be safely interpreted. Mobile pantry controls, keyboard focus and trusted meal-frame messaging are also checked.

Amazon UAE, Kibsons, Carrefour UAE and Waitrose UAE appear together at the top of Tools. Amazon first offers **Open Amazon in browser** or **Try inside Tidy**, without loading Amazon or launching another page automatically. The browser choice opens a separate page with no opener; Tidy and its saved lists remain available. Other store pages make one attempt inside Tidy. If a page or security check fails, **This page is not working** stops it and shows a clear recovery message. Direct opening and retry always require an explicit click; Tidy never automatically redirects, retries or reports a purchase completed.

This handles the failed-page experience. It cannot override Amazon's security checks or establish that Amazon login/checkout works inside another website. A phone may open a direct store link in its browser or the store's app.

Tools also has a **Health Square** card. Save the clinic's actual HTTPS website address once, then use its named button. The address is browser-local, included in backups, and protected against conflicting edits in another tab. No default clinic address is supplied: the available project documents name the clinic but do not identify its website. Saving a link does not establish that the clinic permits embedded viewing or provides online booking.

Provider pages can open new windows from their own links, which some sign-in flows require. Other providers still try the embedded view first; Amazon offers its opening choices first. Tidy does not automatically open a separate window, and the embedded frame blocks direct top-level navigation. Read-only Amazon checks on 14 October 2026 saw both an embedded storefront and an Amazon security challenge; another check still returned that challenge. The cloud gateway blocked required Amazon asset/challenge hosts, so real sign-in and checkout remain unverified.

## Deployment

The `Publish Tidy website` workflow tests and builds the site on pushes to `main`, then deploys to GitHub Pages. GitHub Pages must be enabled for this repository with **GitHub Actions** as its source. The workflow's normal repository token can deploy an enabled site; enabling Pages itself requires repository-owner access or a token with the relevant administration/Pages permissions. No secret values belong in this repository.

After a successful deployment, verify the returned live URL and its `build-info.json`: it must contain the expected commit and the hashes of the published files. Then open Tools, check the four store buttons and exercise the recovery controls. Do not describe a local build, a pushed commit or a saved environment draft as a published website.

The original `tidy-day-organiser.jocundridge128.chatgpt.site` hosting project is not connected to this repository. A GitHub Pages deployment would use a new address. Existing browser-saved data from the old hostname does not transfer automatically; older backup formats require a separately verified migration.

## Development checks

Run `node --test tests/core.test.cjs tests/assistant.test.cjs`, `python3 tools/check_inline_scripts.py web/index.html web/meals.html`, and `python3 -m unittest discover -s tests -p 'test_inline_scripts.py'`. The publishing workflow checks both external and inline JavaScript before building.

For browser checks, serve `web/` internally on port 8780 and run `python tests/qa-website.py`. The runner uses isolated synthetic data and intercepted retailer pages. It checks the four store destinations, failure recovery, deliberate direct opening, retry/close behavior, saved tasks/meals and narrow layouts. Do not present an internal localhost address as the published app or describe retailer fixtures as verified live login/checkout.

Run `python3 tests/qa-concurrency.py --url http://127.0.0.1:8780/` against that server to check genuine same-browser storage events, independent editor changes, conflicting changes, unsaved-data recovery and meal restoration. Every scenario uses a fresh context and synthetic household data. The quota fixture simulates a failed storage write. These checks do not establish sharing between devices or authenticated family members.

Run `python3 tests/qa-provider-access.py --url http://127.0.0.1:8780/` to check clinic address setup, persistence, URL validation, two-tab conflicts, provider popups and narrow-layout recovery. It uses intercepted provider pages and allows network requests only to the selected Tidy origin. It can also run against the confirmed published URL, with normal TLS verification. Synthetic clinic addresses in tests are not real clinic destinations.

`tools/build_site.py --revision <commit> --output <empty-directory>` builds the deployable files. Use `unpublished` for a local build check.

## Current limits

Tasks and meals save only on the current browser. Family names are assignment labels, not authenticated shared accounts. Google/Microsoft sign-in, cloud sync, reliable closed-app iPhone reminders, retailer baskets/orders and automatic bookings/messages are not connected. In-page reminders need Tidy open. The full native source and service configuration are still required for the iPhone version.

Before saving, Tidy refreshes browser data and checks for changes from other tabs. Editors preserve independent field changes and show conflicts rather than silently replacing the same field. Conflicting meal drafts and failed writes remain available for backup. Browser storage has no cross-tab transaction, so these protections are not a guarantee against every precisely simultaneous write; keep backups of important data.

The assistant uses explicit rules rather than a connected AI service. Unsupported time zones, reminder lead times, approximate times and ambiguous assignments require clarification. Approval buttons save preparation records; they do not perform external transactions. Real microphone, notification delivery and Safari behavior still require testing on an iPhone.
