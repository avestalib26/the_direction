# Compute Engine VM (static IP) for the API

Run **Express** (`server/index.js`) on a small VM with a **reserved external IP** so Binance sees a stable egress. Keep hosting the **Vite UI on Vercel** and point `/api/*` at this host.

## 1. Google Cloud setup

1. Create or pick a **project**, enable **Compute Engine API**.
2. **VPC network → IP addresses → Reserve external static IP**  
   - Name: e.g. `the-direction-api`  
   - Attached to: *None* (you will attach when creating the VM).
3. **Create a VM instance**
   - Machine type: `e2-small` (or larger if backtests need CPU).
   - OS: Ubuntu 22.04 LTS (or Debian 12).
   - **Networking**: use the reserved **static IP** as the primary external IP.
   - Allow **HTTP/HTTPS** (or a custom port) in the create wizard, and **SSH** for administration.
4. **Firewall** (if you did not use default tags)
   - **TCP 22** — SSH (restrict source IP to yours if possible).
   - **TCP 443** — if you terminate TLS on the VM (Caddy/nginx).
   - **TCP 8080** — optional, only for quick tests without TLS (do not expose long-term without auth).

## 2. First-time VM bootstrap

SSH into the VM as your admin user (often `ubuntu` on GCP Ubuntu images).

### Option A — helper script (Debian/Ubuntu)

From a one-off clone (any path is fine):

```bash
git clone https://github.com/YOUR_ORG/the_direction.git /tmp/the_direction
sudo bash /tmp/the_direction/deploy/gce/scripts/bootstrap-debian.sh
```

This installs Node.js 20, creates user `thedirection`, and prepares `/opt/the_direction`.

### Option B — manual

- Install **Node.js 20** (e.g. [NodeSource](https://github.com/nodesource/distributions)).
- Create user `thedirection` and directory `/opt/the_direction` owned by that user.

## 3. Deploy the app on the VM

Put the repo in `/opt/the_direction` owned by `thedirection`:

```bash
sudo rm -rf /opt/the_direction
sudo -u thedirection git clone https://github.com/YOUR_ORG/the_direction.git /opt/the_direction
```

Configure and install dependencies **as** `thedirection`:

```bash
sudo -u thedirection cp /opt/the_direction/deploy/gce/env.example /opt/the_direction/.env
# Edit secrets, then:
sudo -u thedirection -H nano /opt/the_direction/.env
sudo -u thedirection -H bash -c 'cd /opt/the_direction && npm ci --omit=dev'
```

Install the systemd unit (once, as root):

```bash
sudo cp /opt/the_direction/deploy/gce/systemd/the-direction-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now the-direction-api
sudo systemctl status the-direction-api
```

Logs:

```bash
journalctl -u the-direction-api -f
```

Health check (from the VM or your laptop, replace host):

```bash
curl -sS "http://VM_IP:8787/api/binance/..." 
```

Use the `PORT` you set in `.env` (default in `env.example` is **8787** for clarity; use **8080** if you prefer).

## 4. Custom domain + HTTPS (operate from anywhere)

**Google does not assign you a free custom domain** like `yoursite.vercel.app`. You either:

- Use **`https://YOUR_STATIC_IP`** (awkward, cert pain), or  
- Buy / use a domain you already own, set an **A record** to the VM’s **static IP**, then terminate **HTTPS** on the VM.

**All-in-one on the same VM (UI + API):** build the frontend on the VM, then use **Caddy** to serve `dist/` and proxy `/api` to Node.

```bash
sudo -u thedirection -H bash -c 'cd /opt/the_direction && npm ci --omit=dev && npm run build'
sudo apt install -y caddy
sudo cp /opt/the_direction/deploy/gce/Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile
sudo systemctl enable --now caddy
```

Edit the Caddyfile: replace `app.example.com` with your real hostname; ensure DNS **A** points to this VM’s external IP. Caddy will get **Let’s Encrypt** certs on port **443**.

**API-only hostname** (e.g. `api.example.com` → Node only): use a minimal site block with only `reverse_proxy 127.0.0.1:8787` (see `Caddyfile.example` comments).

Open **VPC firewall** for **tcp:443** (and **80** for HTTP→HTTPS redirects if you enable them in Caddy).

## 5. Connect Vercel (frontend only)

Your UI calls `/api/...`. Proxy those requests to the VM.

1. In **`vercel.json`**, replace the API rewrite with your public API base (HTTPS recommended):

```json
{
  "rewrites": [
    {
      "source": "/api/(.*)",
      "destination": "https://api.yourdomain.com/api/$1"
    }
  ]
}
```

2. **Remove** the `"functions"` block that pointed at `api/index.js` so traffic is not handled by Vercel serverless for `/api` (saves cold starts and avoids Binance-from-Vercel).

3. Redeploy Vercel.

**Long-running requests:** Vercel may still time out when proxying very long backtests. If that happens, either raise limits on your plan or add a `VITE_API_ORIGIN` and call the GCP URL from the browser with CORS enabled on Express.

## 6. Repeat deploys after code changes

On the VM:

```bash
sudo bash /opt/the_direction/deploy/gce/scripts/deploy-pull-restart.sh
```

Or manually:

```bash
sudo -u thedirection -H bash -c '
  set -e
  cd /opt/the_direction
  git pull
  npm ci --omit=dev
'
sudo systemctl restart the-direction-api
```

## 7. Optional: GitHub Actions SSH deploy

Copy `github-actions.example.yml` to `.github/workflows/deploy-gce-api.yml` and set repository secrets:

- `GCE_HOST` — VM external IP or DNS name- `GCE_USER` — e.g. `thedirection` or `ubuntu`  
- `GCE_SSH_KEY` — private key for SSH- `DEPLOY_PATH` — e.g. `/opt/the_direction`

Adjust the workflow `ssh`/`scp` steps to match how you authenticate (some teams use OS Login instead of raw keys).
