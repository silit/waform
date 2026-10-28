# Webflow Marketplace listing (copy-paste material)

Submission form: https://developers.webflow.com/submit

## App name (max 30)
waform

## Short description (max 100 characters)
Turn every form submission into a WhatsApp chat. One script, no backend, Webflow forms keep working.

## Long description (markdown, no links)
**waform opens WhatsApp with the visitor's answers already typed in, the moment they submit a Webflow form.**

Most businesses answer leads on WhatsApp, not by email. waform closes that gap: the visitor fills in your form, Webflow records the submission as usual (email notifications, the Forms tab and your integrations keep working), and WhatsApp opens with a message built from the fields they filled in. Your sales conversation starts on the channel you already check all day.

**How it works**
1. Install the app and allow the site.
2. Enter your WhatsApp number and, optionally, a message template such as `Hi, I am {name}. {message}`.
3. Click Install. waform adds one script to the site's footer and can publish the site for you.

**What visitors see**
- On phones, WhatsApp opens right after the form succeeds.
- On desktop, a WhatsApp tab opens and a "Continue on WhatsApp" button appears in the success message.
- Choose other behaviours per site: same tab, new tab, or button only.

**Details**
- Works with any number of forms on the site. Set a different number per form with a custom attribute, or opt a form out.
- `{all}` lists every filled field with its label; `{page}` and `{url}` tell you where the lead came from.
- Checkboxes, radios, selects and textareas are supported. Hidden and password fields are never included.
- No data passes through waform's servers. The script talks to Webflow and WhatsApp only. No cookies, no tracking.
- 6 KB script, loaded in the footer, served from a CDN with an integrity hash.
- Remove it any time from the app or from Site settings.

waform is free during beta. Not affiliated with WhatsApp or Webflow.

## Feature list (up to 5)
1. Opens WhatsApp with the form answers pre-filled, on every submission
2. Keeps Webflow form submissions, notifications and integrations intact
3. Message templates with placeholders for any field, page and URL
4. Per-form numbers and opt-out through custom attributes
5. No backend, no data collection, one script in the footer

## Categories (up to 5)
Forms and Surveys, Marketing, Customer Support, Automation, Utilities

## URLs
- Website: https://waform.vercel.app (change to the custom domain later)
- Privacy policy: https://waform.vercel.app/privacy
- Terms of service: https://waform.vercel.app/terms
- Support email: SUPPORT EMAIL HERE

## Logo
assets/logo-900.png (900x900, PNG, 6 KB). File name for upload: waform-logo.png (alt text: waform logo)

## Screenshots (3 to 5, 1280x846 PNG or JPG, max 2 MB each)
1. The setup page with a site selected and the message preview filled (app at /setup).
2. The success page after installing.
3. A Webflow form on a test site right after submission, with the "Continue on WhatsApp" button in the success message.
4. WhatsApp open with the pre-filled message (phone screenshot, cropped and placed on a 1280x846 canvas).
5. The landing page generator with the live preview.

## Review notes (paste into the submission form)
Free app, no in-app purchases. Data Client app using OAuth with scopes sites:read, sites:write, custom_code:read, custom_code:write. The app registers one hosted script (waform, CDN hosted with an SRI hash) and applies it to the chosen site's footer with data attributes that hold the user's settings. Nothing is stored server side; the OAuth token lives only in an encrypted, one hour browser cookie. Uninstall removes the script from the site's custom code. To test: install on any site with a form, enter a WhatsApp number, publish, submit the form.

## Scopes to request in the app settings
sites:read, sites:write, custom_code:read, custom_code:write

## Redirect URI (Building blocks > Data Client)
https://waform.vercel.app/callback (match APP_URL exactly, including https)
