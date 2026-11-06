# Moving production to a free Oracle Cloud server

Render charges for this app because it needs a persistent disk: the database (leads, chats, prompts, bot API keys) and the uploaded seller files live on it, and Render only attaches a disk to a paid instance. Oracle Cloud's **Always Free** tier includes a small ARM server with its own disk at no cost, for as long as the account exists.

What you get: the same app, the same `/admin`, auto-deploy from `main` (within 2 minutes of a merge), free HTTPS, and a nightly backup. About 30–45 minutes, once.

| | Render now | Oracle server |
|---|---|---|
| Cost | Starter plan + disk, monthly | ₹0 inside the Always Free limits |
| Address | `https://jayshree-chatbot.onrender.com` | `https://<ip-with-dashes>.sslip.io` (your own domain later, if you like) |
| Deploys | Merge to `main` | Merge to `main` (the server checks every 2 minutes) |
| Build id | Deployment card on `/admin`, `/health` | Same |
| Backups | Render's disk snapshots | **Download backup** on `/admin`, plus a nightly copy on the server (newest 7) |

The Claude API bill is separate and does not change.

## 1. Oracle account

1. Sign up at **cloud.oracle.com** → *Start for free*.
2. **Home region: India West (Mumbai) or India South (Hyderabad).** It can't be changed later. These are the closest regions to your buyers, like Render's Singapore.
3. Oracle asks for a card to check you are a real person. Always Free resources are never charged.

Optional, later: **Upgrade to Pay As You Go** (Billing → Upgrade). Always Free resources stay free. It also stops Oracle from reclaiming a free server it thinks is idle, and makes "out of capacity" errors rarer. Set a budget alert at ₹1 if you do.

## 2. Create the server

Menu → **Compute → Instances → Create instance**:

| Setting | Choose |
|---|---|
| Name | `seller-assistants` |
| Image | **Canonical Ubuntu 24.04** |
| Shape | **Ampere → VM.Standard.A1.Flex**, **1 OCPU, 6 GB memory** (labelled "Always Free-eligible") |
| Networking | Create a new virtual cloud network and public subnet; **Assign a public IPv4 address**: yes |
| SSH keys | **Generate a key pair for me** → *Save private key* (keep the file safe) |
| Boot volume | Default (about 47 GB) |

Press **Create**. If it says *Out of capacity*, try another *availability domain* in the same form, or try again later.

When it's running, copy its **Public IP address** from the instance page.

## 3. Open the web ports

On the instance page: **Subnet** link → **Security Lists** → *Default Security List* → **Add Ingress Rules**, twice:

| Source CIDR | IP protocol | Destination port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

(SSH, port 22, is already open.)

## 4. Run the setup script

Connect from your computer, with the key file you saved:

```bash
chmod 600 ~/Downloads/ssh-key-*.key
ssh -i ~/Downloads/ssh-key-*.key ubuntu@<public-ip>
```

(On Windows, use PowerShell with the same command, or PuTTY.)

On the server:

```bash
curl -fsSL https://raw.githubusercontent.com/nitinsinghbalyan/chat-bot/main/deploy/oracle/setup.sh -o setup.sh
sudo bash setup.sh
```

It asks for:
- **Anthropic API key:** the same as on Render (Render → the service → **Environment**).
- **Admin password:** the same as Render's `ADMIN_PASSWORD`, or a new one with 8+ characters.
- **Langfuse keys:** the same as on Render, or press Enter to skip tracing.

Avoid spaces and quotes in the password.

It then installs everything, builds `main` (a few minutes) and prints the address, e.g. `https://140-238-1-2.sslip.io/admin`. Open it. The HTTPS certificate can take a minute the first time.

The script can be run again any time: it keeps your settings.

## 5. Move the data from Render

1. **Old site:** `https://jayshree-chatbot.onrender.com/admin` → scroll to **Backup** → **Download backup**. You get a zip with every lead, chat, prompt and version, bot API key, uploaded KB and extra file, crawl and the FAQ sheet.
2. **New site:** `/admin` → **Backup** → **Restore from a backup** → choose the zip → confirm. The server restarts and the page reloads after about 20 seconds.
3. Check the new site:
   - the sellers list and lead counts;
   - `/admin/leads`;
   - one seller page (Knowledge base, Extra files, Bot API keys);
   - `/admin/prompts`;
   - a test chat on a seller site (`/s/<slug>/`).

The zip holds GST, bank and buyer details: delete it from your Downloads once the move is done.

Leads that come in on Render after the backup are not in the zip. Do the move at a quiet time, or download a second backup just before switching and restore again.

## 6. Switch over

- **AI Assistant Auditor and other bot API users:** change the Base URL to the new address. Keys, slugs and seller ids stay the same (they came over in the backup).
- **Links you shared to seller sites:** `/s/<slug>/` is the same on the new address.
- **Langfuse:** traces keep going to the same Langfuse. If they stop (the Langfuse banner on `/admin` says so), the Langfuse server may need to allow the new server's IP.
- **A seller's own website with the chat widget on it** (the `<script src="https://…/widget.js" data-seller="…">` tag): change the address in `src` to the new one. The site's `allowedOrigins` stay as they are.

## 7. Turn Render off

After a few days with everything working on the new server:
- Render → the service → **Settings** → **Suspend**.
- Later, **Delete Web Service**, which also deletes its disk.

Billing stops once the service and disk are gone. Check Render's **Billing** page to confirm.

## Everyday use

| To | Do |
|---|---|
| Deploy | Merge to `main`. Within 2 minutes the server builds it, switches over and checks `/health`. The Deployment card shows the new build id. |
| See why a deploy didn't go live | `ssh` in, then `journalctl -u seller-assistants-deploy -n 50`. A build or health-check failure keeps the previous version running, and that commit is not tried again until a newer one is merged. |
| Redeploy now | `sudo seller-assistants-deploy --force` |
| Watch the bot's log | `journalctl -u seller-assistants -f` |
| Restart | `sudo systemctl restart seller-assistants` |
| Change a setting or key | `sudo nano /etc/seller-assistants.env`, then `sudo systemctl restart seller-assistants` |
| Nightly backups | `/var/data/backups/` (newest 7, 02:30 IST). They live on the same disk, so download one from `/admin` now and then too. |
| Use your own domain | Point an `A` record (e.g. `bot.example.com`) at the server's IP. Set `SITE_HOST=bot.example.com` in `/etc/seller-assistants.env`, then run `sudo bash setup.sh` again. |
| Undo a restore | The data it replaced is in `/var/data/.before-restore-<time>/`. To go back to it: stop the bot (`sudo systemctl stop seller-assistants`), move the current files out of `/var/data` and that folder's files back in, then start it again. |

## What the setup installs (for reference)

The kit lives in `deploy/oracle/` in the repo:

| Piece | What |
|---|---|
| Node 22, git, Caddy | Runtime, code, and HTTPS (Caddy gets and renews the certificate itself) |
| User `bot` | Runs the app; owns `/var/data` and `/opt/seller-assistants` |
| `/opt/seller-assistants/repo` | A clone of the repo |
| `/opt/seller-assistants/releases/<commit>` | One built copy per deploy (newest 3 kept); `current` points to the live one |
| `/var/data` | `DATA_DIR`: the database and seller files, as on Render's disk |
| `/etc/seller-assistants.env` | Settings and secrets (readable by root only) |
| `seller-assistants.service` | The app, restarted if it stops |
| `seller-assistants-deploy.timer` | Checks `main` every 2 minutes; runs `deploy.sh` |
| `seller-assistants-backup.timer` | Nightly backup; runs `backup.sh` |
| Firewall | Ports 80 and 443 opened in the server's own firewall (Oracle's Ubuntu image blocks them by default) |

If the repo is ever made private, run the setup with `sudo REPO_URL=git@github.com:nitinsinghbalyan/chat-bot.git bash setup.sh` on a fresh server. It shows a read-only deploy key to add under the repo's **Settings → Deploy keys** before it continues.
