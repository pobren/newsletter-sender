# Changes

Each version's notes show in the app when it's available. Newest first.

## 0.4.0

- White label for the agency edition: under Settings, White label, add your agency's name, colour, logo and a help link. Your clients see your look on the sign in page, in the browser tab and across the app. Their brand's name leads, with your logo beside it. You keep updates, the licence and our guides.
- Invites can now be emailed to your client from your agency's address. If one can't go, you get the link to send yourself, as before.
- Your own app address: clients can sign in at an address on your agency's website, such as clients.youragency.co.uk. It's set up on your own Cloudflare account with one button, and Cloudflare makes the certificate. You can choose to let clients sign in only at that address.
- Client sign off: switch it on for a brand under Settings, People. Ask for sign off picks who approves, a send time and a note. They get an email with a link to review the campaign on a computer and a phone, send themselves a test, then Approve or Ask for changes. Nothing can be sent until that exact version is approved, and any change needs a new sign off.
- A new Review and approve only login, for clients who sign off campaigns but shouldn't change anything.
- All brands shows what's waiting for sign off.
- Test emails and the test webhook no longer name Newsletter Sender.

For every edition:

- SendGrid and SparkPost: connect either one under Settings, Sending. Bounces and complaints come back by themselves, as with the others.
- Your own SMTP server: send through any mail server you already have, using its address, port, username and password.
- Automatic domain warm up: switch it on for a new sending domain and we start small and send a little more each day. Anything over the day's amount goes out the next morning by itself.
- Blog posts to newsletter drafts: give us your blog's address under Settings, Blog posts. Each new post becomes a draft campaign with its title, picture, a short summary and a Read the full post button. Nothing is sent by itself.
- Automations can now start when someone changes their details, on the subscription page or through the API.
- An optional goodbye email when someone unsubscribes, with a one click way back that puts them back on the lists they left. It works for 30 days.
- Saved segments: save the lists, tags and recent activity you've picked as a named segment, and pick it in one click next time.
- An optional writing helper, off unless you switch it on under Settings, Writing helper. It suggests subject lines, tidies up or shortens the text you pick, and turns notes into a first draft. It uses Cloudflare's AI on your own Cloudflare account.
- Cold contacts: under Settings, Lists, see who hasn't opened or clicked anything in a long while, tag them cold to send a win back email, and take off anyone who still doesn't read. It can do this every day by itself.
- How long to keep who opened and clicked: under Settings, Tracking, choose forever, 1, 2 or 3 years. Older campaigns keep their totals in the report.

## 0.3.1

- Agency licences include 12 months of updates and email support. Settings, Licence shows the date, and offers a Renew button from 30 days before it. Once you've renewed in your account on newslettersender.com, the new key is picked up by itself.
- After that date, the agency features keep working for good on every version released before it. A newer version asks for a renewal before you install it, and nothing is ever deleted.

## 0.3.0

- The agency edition is now built in. Paste an agency licence key into Settings, Licence to switch on more brands, client logins with limits you set and every brand at a glance. Without a key, nothing changes.
- With an agency licence key, the app checks once a day that the licence is still active, sending only the licence number and app version to newslettersender.com. If it can't get through, the licence keeps working for 7 days.

## 0.2.1

- Restore from file: put back a backup you downloaded, even on a new Cloudflare account. Big backups go up in parts.
- A copy away from Cloudflare: if you send with Amazon SES, each nightly backup is also copied to a private bucket in your own Amazon account and kept for 31 days. If you set up Amazon SES before this version, Settings, Backups shows one short step to turn it on.
- Backups of any size, and manual backups no longer replace one made earlier the same day.
- Postmark, Mailgun, Brevo and Resend all tested end to end. Brevo now connects first time, and Postmark and Mailgun no longer add their own link tracking.
- Clearer button names, such as Use the setup wizard and Restore from file.
- Safer clean up of email designs you paste or import.

## 0.2.0

- Update with one press: Settings, Account shows when a new version is out, installs it in about ten seconds and can go back.
- Pause and Stop now take effect within two seconds at any sending speed.

## 0.1.0

- The first version.
