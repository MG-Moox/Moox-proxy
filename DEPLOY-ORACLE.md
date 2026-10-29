# Running Moox on Oracle Cloud (Always Free)

Why: Render's free plan stops after 5 GB of traffic. Oracle's Always Free servers include about 10 TB of traffic a month.

Good to know first:
- Oracle asks for a **card to verify who you are** when you sign up. The Always Free resources are not charged, but you cannot sign up without one.
- Oracle can remove accounts that sit unused for a long time, so log in now and then.
- Your accounts, codes and settings live in **Turso**, so they carry over. You only need the same `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` and `ADMIN_PASSWORD` you used on Render (Render > your service > Environment).

## 1. Make the server
1. Sign up at **oracle.com/cloud/free**. Pick a home region near you (for Tasmania: Sydney or Melbourne). **You cannot change it later.**
2. In the console: **Compute > Instances > Create instance**.
   - Image: **Ubuntu 24.04** (or 22.04).
   - Shape: **Ampere (VM.Standard.A1.Flex)** with 1 OCPU and 6 GB if it is available (best). If it says "out of capacity", try again later or use **VM.Standard.E2.1.Micro** (works, but only 1 GB of memory).
   - Under **Add SSH keys** choose *Generate a key pair* and **download the private key** (keep it safe), or paste your own public key.
3. Create it, then copy its **Public IP address**.

## 2. Open the web ports
Instance page > **Subnet** > **Default security list** > **Add ingress rules** (two rules):
- Source CIDR `0.0.0.0/0`, protocol TCP, destination port `80`
- Source CIDR `0.0.0.0/0`, protocol TCP, destination port `443`

## 3. Get a free address (domain)
Moox needs HTTPS, which needs a domain name.
1. Go to **duckdns.org**, sign in, and make a name like `mymoox` (you get `mymoox.duckdns.org`).
2. Put the server's Public IP in the "current ip" box and press **update ip**.

## 4. Install Moox
Connect to the server and run one command.
- On a computer with a terminal: `ssh -i path/to/your-key ubuntu@PUBLIC_IP`
- Or with no software: in the Oracle console click the **Cloud Shell** icon (top right), then upload your private key with the menu in the Cloud Shell window, and run `chmod 600 key.key` then `ssh -i key.key ubuntu@PUBLIC_IP`.

Then on the server:

```
curl -fsSL https://raw.githubusercontent.com/MG-Moox/Moox-proxy/main/deploy/oracle/setup.sh | bash
```

It asks for your domain, Turso URL, Turso token and admin password (type them in the terminal only). The first build takes a few minutes. When it finishes, open `https://yourname.duckdns.org`.

## Later
- Update Moox after changes on GitHub: `sudo moox-update`
- Logs: `cd /opt/moox/deploy/oracle && sudo docker compose logs -f`
- Switch off the Render service once the new one works, so the old address stops.
